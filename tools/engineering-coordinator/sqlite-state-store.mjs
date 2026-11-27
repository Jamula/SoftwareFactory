import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {types} from 'node:util';

const validLane = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const validOwner = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const validWorkKey = value => typeof value === 'string' && value.length <= 217 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,15}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const validAssociation = (workKey, workGeneration) =>
  (workKey === null && workGeneration === null) ||
  (workKey === '' && workGeneration === 0) ||
  (validWorkKey(workKey) && positive(workGeneration));
const hasDataProps = (value, keys) => keys.every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && Object.hasOwn(descriptor, 'value'));
});
const plainObject = value => value !== null && typeof value === 'object' && !types.isProxy(value) &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  !Object.hasOwn(value, '__proto__') &&
  Reflect.ownKeys(value).every(key => typeof key === 'string') &&
  hasDataProps(value, Object.keys(value));
const exactRecord = (value, keys) => plainObject(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const denseDataArray = (value, limit) => !types.isProxy(value) && Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype && value.length <= limit &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  hasDataProps(value, Array.from({length: value.length}, (_, index) => String(index)));
const snapshotFailure = reason => Object.freeze({ok: false, reason});
const maxPersistedLanes = 250;
const maxPersistedWorkClaims = 10000;
const maxActiveReservations = 32;

function canonicalValue(value, depth = 0) {
  if (depth > 16) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (!denseDataArray(value, 1000)) return undefined;
    const items = [];
    for (const entry of value) {
      const normalized = canonicalValue(entry, depth + 1);
      if (normalized === undefined) return undefined;
      items.push(normalized);
    }
    return Object.freeze(items);
  }
  if (!plainObject(value)) return undefined;
  const record = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalValue(value[key], depth + 1);
    if (normalized === undefined) return undefined;
    Object.defineProperty(record, key, {
      value: normalized, enumerable: true, writable: true, configurable: true
    });
  }
  return Object.freeze(record);
}

const snapshotDigest = content => createHash('sha256').update(JSON.stringify([
  content.schemaVersion, content.snapshotGeneration, content.exportedAt,
  content.lanes, content.workClaims, content.reservations
])).digest('hex');

function normalizeSnapshot(snapshot) {
  if (!exactRecord(snapshot, ['schemaVersion', 'snapshotGeneration', 'exportedAt',
    'lanes', 'workClaims', 'reservations', 'digest']) ||
      snapshot.schemaVersion !== 1 || !positive(snapshot.snapshotGeneration) ||
      !time(snapshot.exportedAt) || typeof snapshot.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(snapshot.digest) ||
      !denseDataArray(snapshot.lanes, maxPersistedLanes) ||
      !denseDataArray(snapshot.workClaims, maxPersistedWorkClaims) ||
      !denseDataArray(snapshot.reservations, maxActiveReservations)) return null;
  const lanes = [];
  const encodedPayloads = new Map();
  let previousLane = '';
  for (const entry of snapshot.lanes) {
    if (!exactRecord(entry, ['laneId', 'generation', 'owner', 'leaseUntil', 'payload',
      'workKey', 'workGeneration', 'checkpointRevision']) ||
        !validLane(entry.laneId) || entry.laneId <= previousLane || !positive(entry.generation) ||
        !validOwner(entry.owner) || !time(entry.leaseUntil) || !plainObject(entry.payload) ||
        !validAssociation(entry.workKey, entry.workGeneration) || !time(entry.checkpointRevision)) return null;
    const payload = canonicalValue(entry.payload);
    if (!payload) return null;
    const encoded = JSON.stringify(payload);
    if (encoded.length > 65536) return null;
    previousLane = entry.laneId;
    encodedPayloads.set(entry.laneId, encoded);
    lanes.push(Object.freeze({
      laneId: entry.laneId, generation: entry.generation, owner: entry.owner,
      leaseUntil: entry.leaseUntil, payload, workKey: entry.workKey,
      workGeneration: entry.workGeneration, checkpointRevision: entry.checkpointRevision
    }));
  }
  const workClaims = [];
  let previousWork = '';
  for (const entry of snapshot.workClaims) {
    if (!exactRecord(entry, ['workKey', 'laneId', 'generation', 'owner', 'leaseUntil']) ||
        !validWorkKey(entry.workKey) || entry.workKey <= previousWork || !validLane(entry.laneId) ||
        !positive(entry.generation) || !validOwner(entry.owner) || !time(entry.leaseUntil)) return null;
    previousWork = entry.workKey;
    workClaims.push(Object.freeze({
      workKey: entry.workKey, laneId: entry.laneId, generation: entry.generation,
      owner: entry.owner, leaseUntil: entry.leaseUntil
    }));
  }
  const reservations = [];
  let previousReserved = '';
  for (const entry of snapshot.reservations) {
    if (!exactRecord(entry, ['laneId', 'expires']) || !validLane(entry.laneId) ||
        entry.laneId <= previousReserved || !time(entry.expires) || entry.expires <= snapshot.exportedAt) return null;
    previousReserved = entry.laneId;
    reservations.push(Object.freeze({laneId: entry.laneId, expires: entry.expires}));
  }
  const laneMap = new Map(lanes.map(item => [item.laneId, item]));
  const workMap = new Map(workClaims.map(item => [item.workKey, item]));
  return {
    content: {
      schemaVersion: 1, snapshotGeneration: snapshot.snapshotGeneration, exportedAt: snapshot.exportedAt,
      lanes: Object.freeze(lanes), workClaims: Object.freeze(workClaims), reservations: Object.freeze(reservations)
    },
    encodedPayloads, laneMap, workMap
  };
}

function pairedLeasesConsistent({content, laneMap, workMap}) {
  for (const lane of content.lanes) {
    if (validWorkKey(lane.workKey)) {
      const claim = workMap.get(lane.workKey);
      if (!claim || claim.generation < lane.workGeneration ||
          (claim.generation === lane.workGeneration &&
            (claim.laneId !== lane.laneId || claim.owner !== lane.owner)) ||
          (lane.leaseUntil > content.exportedAt &&
            (claim.generation !== lane.workGeneration || claim.leaseUntil !== lane.leaseUntil))) return false;
    }
  }
  for (const claim of content.workClaims) {
    const lane = laneMap.get(claim.laneId);
    if (!lane) return false;
    if (claim.leaseUntil > content.exportedAt &&
        !(lane.workKey === '' && lane.workGeneration === 0 && lane.leaseUntil > content.exportedAt) &&
        (lane.workKey !== claim.workKey || lane.workGeneration !== claim.generation ||
          lane.owner !== claim.owner || lane.leaseUntil !== claim.leaseUntil)) return false;
  }
  return true;
}

export function createSQLiteStateStore(filename) {
  if (typeof filename !== 'string' || filename.length === 0) throw new TypeError('INVALID_STATE_PATH');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS coordinator_lanes (lane_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, payload TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS coordinator_reservations (lane_id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS coordinator_work_claims (work_key TEXT PRIMARY KEY, lane_id TEXT NOT NULL, generation INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL)');
  try {
    db.exec('BEGIN IMMEDIATE');
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coordinator_lane_work'").get();
    if (!exists) {
      db.exec("CREATE TABLE coordinator_lane_work (lane_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, work_key TEXT, work_generation INTEGER); INSERT INTO coordinator_lane_work SELECT lane_id, generation, '', 0 FROM coordinator_lanes");
    }
    db.exec('CREATE TABLE IF NOT EXISTS coordinator_lane_checkpoints (lane_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, checkpoint_revision INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS coordinator_snapshot_fence (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_generation INTEGER NOT NULL, last_snapshot_at INTEGER NOT NULL, observed_at INTEGER NOT NULL); INSERT OR IGNORE INTO coordinator_snapshot_fence VALUES (1, 0, 0, 0)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
  const read = db.prepare('SELECT lane_id, generation, owner, lease_until, payload FROM coordinator_lanes WHERE lane_id = ?');
  const countLanes = db.prepare('SELECT count(*) AS total FROM coordinator_lanes');
  const countWork = db.prepare('SELECT count(*) AS total FROM coordinator_work_claims');
  const exportLanes = db.prepare('SELECT l.lane_id, l.generation, l.owner, l.lease_until, l.payload, w.work_key, w.work_generation, coalesce(c.checkpoint_revision, 0) AS checkpoint_revision FROM coordinator_lanes AS l LEFT JOIN coordinator_lane_work AS w ON w.lane_id = l.lane_id AND w.generation = l.generation LEFT JOIN coordinator_lane_checkpoints AS c ON c.lane_id = l.lane_id AND c.generation = l.generation ORDER BY l.lane_id ASC');
  const exportWork = db.prepare('SELECT work_key, lane_id, generation, owner, lease_until FROM coordinator_work_claims ORDER BY work_key ASC');
  const exportReservations = db.prepare('SELECT lane_id, expires FROM coordinator_reservations WHERE expires > ? ORDER BY lane_id ASC');
  const readFence = db.prepare('SELECT snapshot_generation, last_snapshot_at, observed_at FROM coordinator_snapshot_fence WHERE id = 1');
  const writeFence = db.prepare('UPDATE coordinator_snapshot_fence SET snapshot_generation = ?, last_snapshot_at = ?, observed_at = max(observed_at, ?) WHERE id = 1');
  const bumpObserved = db.prepare('UPDATE coordinator_snapshot_fence SET observed_at = max(observed_at, ?) WHERE id = 1');
  const hasActiveLocalLease = db.prepare('SELECT 1 AS active WHERE EXISTS (SELECT 1 FROM coordinator_lanes WHERE lease_until > ?) OR EXISTS (SELECT 1 FROM coordinator_work_claims WHERE lease_until > ?)');
  const live = db.prepare('SELECT lane_id FROM coordinator_lanes WHERE lease_until > ? UNION SELECT lane_id FROM coordinator_reservations WHERE expires > ?');
  const prune = db.prepare('DELETE FROM coordinator_reservations WHERE expires <= ?');
  const reserve = db.prepare('INSERT INTO coordinator_reservations(lane_id,expires) VALUES(?,?) ON CONFLICT(lane_id) DO UPDATE SET expires=max(coordinator_reservations.expires,excluded.expires)');
  const put = db.prepare('INSERT INTO coordinator_lanes(lane_id,generation,owner,lease_until,payload) VALUES(?,?,?,?,?) ON CONFLICT(lane_id) DO UPDATE SET generation=excluded.generation, owner=excluded.owner, lease_until=excluded.lease_until, payload=excluded.payload');
  const putAssociation = db.prepare('INSERT INTO coordinator_lane_work VALUES(?,?,?,?) ON CONFLICT(lane_id) DO UPDATE SET generation=excluded.generation, work_key=excluded.work_key, work_generation=excluded.work_generation');
  const putCheckpointRevision = db.prepare('INSERT INTO coordinator_lane_checkpoints(lane_id,generation,checkpoint_revision) VALUES(?,?,?) ON CONFLICT(lane_id) DO UPDATE SET generation=excluded.generation, checkpoint_revision=excluded.checkpoint_revision');
  const bumpCheckpointRevision = db.prepare('INSERT INTO coordinator_lane_checkpoints(lane_id,generation,checkpoint_revision) VALUES(?,?,1) ON CONFLICT(lane_id) DO UPDATE SET checkpoint_revision = CASE WHEN coordinator_lane_checkpoints.generation = excluded.generation THEN coordinator_lane_checkpoints.checkpoint_revision + 1 ELSE 1 END, generation = excluded.generation WHERE coordinator_lane_checkpoints.generation != excluded.generation OR coordinator_lane_checkpoints.checkpoint_revision < 9007199254740991');
  const association = ' AND EXISTS (SELECT 1 FROM coordinator_lane_work WHERE coordinator_lane_work.lane_id=coordinator_lanes.lane_id AND coordinator_lane_work.generation=coordinator_lanes.generation AND work_key IS ? AND work_generation IS ?)';
  const update = db.prepare('UPDATE coordinator_lanes SET payload=? WHERE lane_id=? AND generation=? AND owner=? AND lease_until>?' + association);
  const renewLease = db.prepare('UPDATE coordinator_lanes SET lease_until=? WHERE lane_id=? AND generation=? AND owner=? AND lease_until>?' + association);
  const release = db.prepare('UPDATE coordinator_lanes SET lease_until=0 WHERE lane_id=? AND generation=? AND owner=?' + association);
  const readWork = db.prepare('SELECT lane_id, generation, owner, lease_until FROM coordinator_work_claims WHERE work_key=?');
  const putWork = db.prepare('INSERT INTO coordinator_work_claims(work_key,lane_id,generation,owner,lease_until) VALUES(?,?,?,?,?) ON CONFLICT(work_key) DO UPDATE SET lane_id=excluded.lane_id,generation=excluded.generation,owner=excluded.owner,lease_until=excluded.lease_until');
  const renewWork = db.prepare('UPDATE coordinator_work_claims SET lease_until=? WHERE work_key=? AND lane_id=? AND generation=? AND owner=? AND lease_until>?');
  const releaseWork = db.prepare('UPDATE coordinator_work_claims SET lease_until=0 WHERE work_key=? AND lane_id=? AND generation=? AND owner=?');
  const checkpointWork = db.prepare('SELECT 1 AS active FROM coordinator_work_claims WHERE work_key=? AND lane_id=? AND generation=? AND owner=? AND lease_until>?');
  return Object.freeze({
    observeReserved(reserved, now, leaseMs) {
      if (!Array.isArray(reserved) || reserved.length > maxActiveReservations || !time(now) ||
          !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000 || !time(now + leaseMs)) return false;
      try {
        const lanes = Array.from(reserved);
        if (!lanes.every(validLane)) return false;
        db.exec('BEGIN IMMEDIATE');
        prune.run(now);
        const activeReserved = new Set([...exportReservations.all(now).map(row => row.lane_id), ...lanes]);
        if (activeReserved.size > maxActiveReservations) {
          db.exec('ROLLBACK');
          return false;
        }
        for (const laneId of lanes) reserve.run(laneId, now + leaseMs);
        bumpObserved.run(now);
        db.exec('COMMIT');
        return true;
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return false;
      }
    },
    claim(laneId, owner, now, leaseMs, maxConcurrentLanes = 32, workKey = null) {
      if (!validLane(laneId) || !validOwner(owner) || !time(now) || !Number.isSafeInteger(leaseMs) ||
          leaseMs < 1000 || leaseMs > 3600000 || !time(now + leaseMs) ||
          !Number.isSafeInteger(maxConcurrentLanes) || maxConcurrentLanes < 1 || maxConcurrentLanes > 32 ||
          (workKey !== null && !validWorkKey(workKey))) return null;
      try {
        db.exec('BEGIN IMMEDIATE');
        const occupied = live.all(now, now);
        if (occupied.length >= maxConcurrentLanes || occupied.some(row => row.lane_id === laneId)) {
          db.exec('COMMIT');
          return null;
        }
        const currentWork = workKey === null ? null : readWork.get(workKey);
        if (currentWork?.lease_until > now) {
          db.exec('COMMIT');
          return null;
        }
        const current = read.get(laneId);
        if ((!current && countLanes.get().total >= maxPersistedLanes) ||
            (workKey !== null && !currentWork && countWork.get().total >= maxPersistedWorkClaims)) {
          db.exec('ROLLBACK');
          return null;
        }
        const generation = current ? current.generation + 1 : 1;
        const workGeneration = workKey === null ? null : currentWork ? currentWork.generation + 1 : 1;
        if (!Number.isSafeInteger(generation) || (workKey !== null && !Number.isSafeInteger(workGeneration))) {
          db.exec('ROLLBACK');
          return null;
        }
        const payload = current?.payload ?? '{}';
        const state = JSON.parse(payload);
        put.run(laneId, generation, owner, now + leaseMs, payload);
        putAssociation.run(laneId, generation, workKey, workGeneration);
        putCheckpointRevision.run(laneId, generation, 0);
        if (workKey !== null) putWork.run(workKey, laneId, workGeneration, owner, now + leaseMs);
        bumpObserved.run(now);
        db.exec('COMMIT');
        return {laneId, generation, owner, leaseUntil: now + leaseMs, payload: state,
          ...(workKey === null ? {} : {workKey, workGeneration})};
      } catch {
        try { db.exec('ROLLBACK'); } catch { /* An earlier SQLite error may end the transaction. */ }
        return null;
      }
    },
    checkpoint(laneId, generation, owner, payload, now, workKey = null, workGeneration = null) {
      if (!validLane(laneId) || !Number.isSafeInteger(generation) || generation < 1 ||
          !validOwner(owner) || !time(now) ||
          ((workKey === null) !== (workGeneration === null)) ||
          (workKey !== null && (!validWorkKey(workKey) || !Number.isSafeInteger(workGeneration) || workGeneration < 1))) return false;
      const normalized = canonicalValue(payload);
      if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') return false;
      const encoded = JSON.stringify(normalized);
      if (encoded.length > 65536) return false;
      try {
        db.exec('BEGIN IMMEDIATE');
        if (workKey !== null && !checkpointWork.get(workKey, laneId, workGeneration, owner, now)) {
          db.exec('ROLLBACK');
          return false;
        }
        if (Number(update.run(encoded, laneId, generation, owner, now, workKey, workGeneration).changes) !== 1 ||
            Number(bumpCheckpointRevision.run(laneId, generation).changes) !== 1) {
          db.exec('ROLLBACK');
          return false;
        }
        bumpObserved.run(now);
        db.exec('COMMIT');
        return true;
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return false;
      }
    },
    renew(laneId, generation, owner, now, leaseMs, workKey = null, workGeneration = null) {
      if (!validLane(laneId) || !Number.isSafeInteger(generation) || generation < 1 || !validOwner(owner) ||
          !time(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000 || !time(now + leaseMs) ||
          ((workKey === null) !== (workGeneration === null)) ||
          (workKey !== null && (!validWorkKey(workKey) || !Number.isSafeInteger(workGeneration) || workGeneration < 1)))
        return null;
      try {
        db.exec('BEGIN IMMEDIATE');
        const leaseUntil = now + leaseMs;
        if (Number(renewLease.run(leaseUntil, laneId, generation, owner, now, workKey, workGeneration).changes) !== 1 ||
            (workKey !== null && Number(renewWork.run(leaseUntil, workKey, laneId, workGeneration, owner, now).changes) !== 1)) {
          db.exec('ROLLBACK');
          return null;
        }
        bumpObserved.run(now);
        db.exec('COMMIT');
        return {leaseUntil};
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return null;
      }
    },
    release(laneId, generation, owner, now, workKey = null, workGeneration = null) {
      if (!validLane(laneId) || !Number.isSafeInteger(generation) || generation < 1 ||
          !validOwner(owner) || !time(now) ||
          ((workKey === null) !== (workGeneration === null)) ||
          (workKey !== null && (!validWorkKey(workKey) || !Number.isSafeInteger(workGeneration) || workGeneration < 1))) return false;
      try {
        db.exec('BEGIN IMMEDIATE');
        if (Number(release.run(laneId, generation, owner, workKey, workGeneration).changes) !== 1 ||
            (workKey !== null && Number(releaseWork.run(workKey, laneId, workGeneration, owner).changes) !== 1)) {
          db.exec('ROLLBACK');
          return false;
        }
        bumpObserved.run(now);
        db.exec('COMMIT');
        return true;
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return false;
      }
    },
    exportSnapshot(now) {
      if (!time(now)) return snapshotFailure('CLOCK_UNAVAILABLE');
      try {
        db.exec('BEGIN IMMEDIATE');
        const fence = readFence.get();
        if (now < fence.observed_at) {
          db.exec('ROLLBACK');
          return snapshotFailure('CLOCK_ROLLBACK');
        }
        const snapshotGeneration = fence.snapshot_generation + 1;
        if (!Number.isSafeInteger(snapshotGeneration)) {
          db.exec('ROLLBACK');
          return snapshotFailure('GENERATION_OVERFLOW');
        }
        const lanes = [];
        for (const row of exportLanes.all()) {
          let parsed;
          try { parsed = JSON.parse(row.payload); } catch { parsed = null; }
          const payload = plainObject(parsed) ? canonicalValue(parsed) : undefined;
          if (!payload || row.payload.length > 65536 || !validLane(row.lane_id) ||
              !positive(row.generation) || !validOwner(row.owner) || !time(row.lease_until) ||
              !validAssociation(row.work_key, row.work_generation) || !time(row.checkpoint_revision)) {
            db.exec('ROLLBACK');
            return snapshotFailure('CORRUPT_STATE');
          }
          lanes.push(Object.freeze({
            laneId: row.lane_id, generation: row.generation, owner: row.owner,
            leaseUntil: row.lease_until, payload, workKey: row.work_key,
            workGeneration: row.work_generation, checkpointRevision: row.checkpoint_revision
          }));
        }
        const workClaims = exportWork.all().map(row => Object.freeze({
          workKey: row.work_key, laneId: row.lane_id, generation: row.generation,
          owner: row.owner, leaseUntil: row.lease_until
        }));
        const reservations = exportReservations.all(now).map(row => Object.freeze({
          laneId: row.lane_id, expires: row.expires
        }));
        const content = {
          schemaVersion: 1, snapshotGeneration, exportedAt: now,
          lanes: Object.freeze(lanes), workClaims: Object.freeze(workClaims),
          reservations: Object.freeze(reservations)
        };
        const laneMap = new Map(lanes.map(item => [item.laneId, item]));
        const workMap = new Map(workClaims.map(item => [item.workKey, item]));
        if (lanes.length > maxPersistedLanes || workClaims.length > maxPersistedWorkClaims ||
            reservations.length > maxActiveReservations ||
            !pairedLeasesConsistent({content, laneMap, workMap})) {
          db.exec('ROLLBACK');
          return snapshotFailure('CORRUPT_STATE');
        }
        writeFence.run(snapshotGeneration, now, now);
        db.exec('COMMIT');
        return Object.freeze({
          ok: true, reason: 'SNAPSHOT_EXPORTED',
          snapshot: Object.freeze({...content, digest: snapshotDigest(content)})
        });
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return snapshotFailure('STORE_UNAVAILABLE');
      }
    },
    importSnapshot(snapshot, now) {
      if (!time(now)) return snapshotFailure('CLOCK_UNAVAILABLE');
      const normalized = normalizeSnapshot(snapshot);
      if (!normalized) return snapshotFailure('INVALID_SNAPSHOT');
      const {content, encodedPayloads, laneMap, workMap} = normalized;
      if (snapshotDigest(content) !== snapshot.digest) return snapshotFailure('SNAPSHOT_TAMPERED');
      if (!pairedLeasesConsistent(normalized)) return snapshotFailure('INVALID_SNAPSHOT');
      if (now < content.exportedAt) return snapshotFailure('CLOCK_ROLLBACK');
      try {
        db.exec('BEGIN IMMEDIATE');
        const fence = readFence.get();
        if (now < fence.observed_at) {
          db.exec('ROLLBACK');
          return snapshotFailure('CLOCK_ROLLBACK');
        }
        if (content.snapshotGeneration <= fence.snapshot_generation) {
          db.exec('ROLLBACK');
          return snapshotFailure('STALE_GENERATION');
        }
        if (content.exportedAt < fence.last_snapshot_at) {
          db.exec('ROLLBACK');
          return snapshotFailure('CLOCK_ROLLBACK');
        }
        const localActiveReservations = exportReservations.all(now);
        const retainedIncomingReservations = content.reservations.filter(item => item.expires > now);
        const combinedReservations = new Set([
          ...localActiveReservations.map(row => row.lane_id),
          ...retainedIncomingReservations.map(item => item.laneId)
        ]);
        if (hasActiveLocalLease.get(now, now) ||
            combinedReservations.size > maxActiveReservations ||
            localActiveReservations.some(row => (laneMap.get(row.lane_id)?.leaseUntil ?? 0) > now)) {
          db.exec('ROLLBACK');
          return snapshotFailure('ACTIVE_OWNERSHIP_CONFLICT');
        }
        for (const row of exportLanes.all()) {
          const incoming = laneMap.get(row.lane_id);
          if (!incoming || incoming.generation < row.generation) {
            db.exec('ROLLBACK');
            return snapshotFailure('STALE_GENERATION');
          }
          if (incoming.generation === row.generation) {
            let localParsed;
            try { localParsed = JSON.parse(row.payload); } catch { localParsed = null; }
            const localCanonical = plainObject(localParsed) ? canonicalValue(localParsed) : undefined;
            if (!localCanonical || !time(row.checkpoint_revision)) {
              db.exec('ROLLBACK');
              return snapshotFailure('CORRUPT_STATE');
            }
            const localEncoded = JSON.stringify(localCanonical);
            const incomingEncoded = encodedPayloads.get(row.lane_id);
            if (incoming.owner !== row.owner || incoming.workKey !== row.work_key ||
                incoming.workGeneration !== row.work_generation) {
              db.exec('ROLLBACK');
              return snapshotFailure('ACTIVE_OWNERSHIP_CONFLICT');
            }
            if (incoming.checkpointRevision < row.checkpoint_revision ||
                (row.lease_until === 0 && incoming.leaseUntil > 0) ||
                (incoming.leaseUntil > 0 && incoming.leaseUntil < row.lease_until)) {
              db.exec('ROLLBACK');
              return snapshotFailure('STALE_GENERATION');
            }
            if ((incoming.checkpointRevision === row.checkpoint_revision && incomingEncoded !== localEncoded) ||
                (row.lease_until === 0 && incoming.checkpointRevision > row.checkpoint_revision)) {
              db.exec('ROLLBACK');
              return snapshotFailure('ACTIVE_OWNERSHIP_CONFLICT');
            }
          }
        }
        for (const row of exportWork.all()) {
          const incoming = workMap.get(row.work_key);
          if (!incoming || incoming.generation < row.generation) {
            db.exec('ROLLBACK');
            return snapshotFailure('STALE_GENERATION');
          }
          if (incoming.generation === row.generation) {
            if (incoming.owner !== row.owner || incoming.laneId !== row.lane_id) {
              db.exec('ROLLBACK');
              return snapshotFailure('ACTIVE_OWNERSHIP_CONFLICT');
            }
            if ((row.lease_until === 0 && incoming.leaseUntil > 0) ||
                (incoming.leaseUntil > 0 && incoming.leaseUntil < row.lease_until)) {
              db.exec('ROLLBACK');
              return snapshotFailure('STALE_GENERATION');
            }
          }
        }
        prune.run(now);
        for (const lane of content.lanes) {
          put.run(lane.laneId, lane.generation, lane.owner, lane.leaseUntil, encodedPayloads.get(lane.laneId));
          putAssociation.run(lane.laneId, lane.generation, lane.workKey, lane.workGeneration);
          putCheckpointRevision.run(lane.laneId, lane.generation, lane.checkpointRevision);
        }
        for (const claim of content.workClaims)
          putWork.run(claim.workKey, claim.laneId, claim.generation, claim.owner, claim.leaseUntil);
        for (const reservation of retainedIncomingReservations)
          reserve.run(reservation.laneId, reservation.expires);
        writeFence.run(content.snapshotGeneration, content.exportedAt, now);
        db.exec('COMMIT');
        return Object.freeze({
          ok: true, reason: 'SNAPSHOT_IMPORTED', snapshotGeneration: content.snapshotGeneration
        });
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return snapshotFailure('STORE_UNAVAILABLE');
      }
    },
    get(laneId) {
      if (!validLane(laneId)) return null;
      try {
        const row = read.get(laneId);
        return row ? {laneId: row.lane_id, generation: row.generation, owner: row.owner,
          leaseUntil: row.lease_until, payload: JSON.parse(row.payload)} : null;
      } catch { return null; }
    },
    close() { db.close(); }
  });
}
