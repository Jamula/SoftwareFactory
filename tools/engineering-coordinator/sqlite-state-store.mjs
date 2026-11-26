import {DatabaseSync} from 'node:sqlite';

const validLane = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const validOwner = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const validWorkKey = value => typeof value === 'string' && value.length <= 217 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,15}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;

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
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
  const read = db.prepare('SELECT lane_id, generation, owner, lease_until, payload FROM coordinator_lanes WHERE lane_id = ?');
  const live = db.prepare('SELECT lane_id FROM coordinator_lanes WHERE lease_until > ? UNION SELECT lane_id FROM coordinator_reservations WHERE expires > ?');
  const prune = db.prepare('DELETE FROM coordinator_reservations WHERE expires <= ?');
  const reserve = db.prepare('INSERT INTO coordinator_reservations(lane_id,expires) VALUES(?,?) ON CONFLICT(lane_id) DO UPDATE SET expires=max(coordinator_reservations.expires,excluded.expires)');
  const put = db.prepare('INSERT INTO coordinator_lanes(lane_id,generation,owner,lease_until,payload) VALUES(?,?,?,?,?) ON CONFLICT(lane_id) DO UPDATE SET generation=excluded.generation, owner=excluded.owner, lease_until=excluded.lease_until, payload=excluded.payload');
  const putAssociation = db.prepare('INSERT INTO coordinator_lane_work VALUES(?,?,?,?) ON CONFLICT(lane_id) DO UPDATE SET generation=excluded.generation, work_key=excluded.work_key, work_generation=excluded.work_generation');
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
      if (!Array.isArray(reserved) || reserved.length > 32 || !time(now) || !Number.isSafeInteger(leaseMs) ||
          leaseMs < 1000 || leaseMs > 3600000 || !time(now + leaseMs)) return false;
      try {
        const lanes = Array.from(reserved);
        if (!lanes.every(validLane)) return false;
        db.exec('BEGIN IMMEDIATE');
        prune.run(now);
        for (const laneId of lanes) reserve.run(laneId, now + leaseMs);
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
        if (workKey !== null) putWork.run(workKey, laneId, workGeneration, owner, now + leaseMs);
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
          !validOwner(owner) || payload === null || typeof payload !== 'object' ||
          Array.isArray(payload) || !time(now) ||
          ((workKey === null) !== (workGeneration === null)) ||
          (workKey !== null && (!validWorkKey(workKey) || !Number.isSafeInteger(workGeneration) || workGeneration < 1))) return false;
      let encoded;
      try { encoded = JSON.stringify(payload); } catch { return false; }
      if (typeof encoded !== 'string' || encoded.length > 65536) return false;
      if (workKey === null) {
        try { return Number(update.run(encoded, laneId, generation, owner, now, null, null).changes) === 1; }
        catch { return false; }
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        if (!checkpointWork.get(workKey, laneId, workGeneration, owner, now)) {
          db.exec('ROLLBACK');
          return false;
        }
        if (Number(update.run(encoded, laneId, generation, owner, now, workKey, workGeneration).changes) !== 1) {
          db.exec('ROLLBACK');
          return false;
        }
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
      if (workKey === null) {
        try {
          const leaseUntil = now + leaseMs;
          return Number(renewLease.run(leaseUntil, laneId, generation, owner, now, null, null).changes) === 1 ? {leaseUntil} : null;
        } catch { return null; }
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        const leaseUntil = now + leaseMs;
        if (Number(renewLease.run(leaseUntil, laneId, generation, owner, now, workKey, workGeneration).changes) !== 1 ||
            Number(renewWork.run(leaseUntil, workKey, laneId, workGeneration, owner, now).changes) !== 1) {
          db.exec('ROLLBACK');
          return null;
        }
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
      if (workKey === null) {
        try { return Number(release.run(laneId, generation, owner, null, null).changes) === 1; }
        catch { return false; }
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        if (Number(release.run(laneId, generation, owner, workKey, workGeneration).changes) !== 1 ||
            Number(releaseWork.run(workKey, laneId, workGeneration, owner).changes) !== 1) {
          db.exec('ROLLBACK');
          return false;
        }
        db.exec('COMMIT');
        return true;
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return false;
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
