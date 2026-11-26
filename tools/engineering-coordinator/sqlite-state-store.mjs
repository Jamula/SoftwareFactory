import {DatabaseSync} from 'node:sqlite';

const validLane = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const validOwner = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;

export function createSQLiteStateStore(filename) {
  if (typeof filename !== 'string' || filename.length === 0) throw new TypeError('INVALID_STATE_PATH');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS coordinator_lanes (lane_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, payload TEXT NOT NULL)');
  const read = db.prepare('SELECT lane_id, generation, owner, lease_until, payload FROM coordinator_lanes WHERE lane_id = ?');
  const live = db.prepare('SELECT lane_id FROM coordinator_lanes WHERE lease_until > ?');
  const put = db.prepare('INSERT INTO coordinator_lanes(lane_id,generation,owner,lease_until,payload) VALUES(?,?,?,?,?) ON CONFLICT(lane_id) DO UPDATE SET generation=excluded.generation, owner=excluded.owner, lease_until=excluded.lease_until, payload=excluded.payload');
  const update = db.prepare('UPDATE coordinator_lanes SET payload=? WHERE lane_id=? AND generation=? AND owner=? AND lease_until>?');
  const renewLease = db.prepare('UPDATE coordinator_lanes SET lease_until=? WHERE lane_id=? AND generation=? AND owner=? AND lease_until>?');
  const release = db.prepare('UPDATE coordinator_lanes SET lease_until=0 WHERE lane_id=? AND generation=? AND owner=?');
  return Object.freeze({
    claim(laneId, owner, now, leaseMs, maxConcurrentLanes = 32, reserved = []) {
      if (!validLane(laneId) || !validOwner(owner) || !time(now) || !Number.isSafeInteger(leaseMs) ||
          leaseMs < 1000 || leaseMs > 3600000 || !time(now + leaseMs) ||
          !Number.isSafeInteger(maxConcurrentLanes) || maxConcurrentLanes < 1 || maxConcurrentLanes > 32 ||
          !Array.isArray(reserved) || reserved.length > 32) return null;
      try {
        const reservedLanes = Array.from(reserved);
        if (!reservedLanes.every(validLane)) return null;
        db.exec('BEGIN IMMEDIATE');
        const occupied = new Set(reservedLanes);
        for (const row of live.all(now)) occupied.add(row.lane_id);
        if (occupied.has(laneId) || occupied.size >= maxConcurrentLanes) {
          db.exec('COMMIT');
          return null;
        }
        const current = read.get(laneId);
        const generation = current ? current.generation + 1 : 1;
        if (!Number.isSafeInteger(generation)) {
          db.exec('ROLLBACK');
          return null;
        }
        const payload = current?.payload ?? '{}';
        const state = JSON.parse(payload);
        put.run(laneId, generation, owner, now + leaseMs, payload);
        db.exec('COMMIT');
        return {laneId, generation, owner, leaseUntil: now + leaseMs, payload: state};
      } catch {
        try { db.exec('ROLLBACK'); } catch { /* An earlier SQLite error may end the transaction. */ }
        return null;
      }
    },
    checkpoint(laneId, generation, owner, payload, now) {
      if (!validLane(laneId) || !Number.isSafeInteger(generation) || generation < 1 ||
          !validOwner(owner) || payload === null || typeof payload !== 'object' ||
          Array.isArray(payload) || !time(now)) return false;
      let encoded;
      try { encoded = JSON.stringify(payload); } catch { return false; }
      if (typeof encoded !== 'string' || encoded.length > 65536) return false;
      try { return Number(update.run(encoded, laneId, generation, owner, now).changes) === 1; }
      catch { return false; }
    },
    renew(laneId, generation, owner, now, leaseMs) {
      if (!validLane(laneId) || !Number.isSafeInteger(generation) || generation < 1 || !validOwner(owner) ||
          !time(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000 || !time(now + leaseMs))
        return null;
      try {
        const leaseUntil = now + leaseMs;
        return Number(renewLease.run(leaseUntil, laneId, generation, owner, now).changes) === 1 ? {leaseUntil} : null;
      } catch { return null; }
    },
    release(laneId, generation, owner, now) {
      if (!validLane(laneId) || !Number.isSafeInteger(generation) || generation < 1 ||
          !validOwner(owner) || !time(now)) return false;
      try { return Number(release.run(laneId, generation, owner).changes) === 1; }
      catch { return false; }
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
