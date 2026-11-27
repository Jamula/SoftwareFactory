import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {types} from 'node:util';
import {budgetDecision} from './budget.mjs';
import {dispatchIntent} from './dispatch-intent.mjs';

const defaultMaxExecutionMs = 900000;
const maxAllowedExecutionMs = 3600000;
const snapshotVersion = 1;
const phases = new Set(['reserved', 'in-flight', 'settled', 'cancelled', 'expired']);
const time = value => Number.isSafeInteger(value) && value >= 0;
const count = (value, limit) => time(value) && value <= limit;
const positive = value => time(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const signingKeyValid = value => typeof value === 'string' && value.length >= 16 && value.length <= 256;
const data = (value, fields) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  fields.every(field => Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, 'value'));
const denseArray = (value, maxLen) => !types.isProxy(value) && Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype && value.length <= maxLen &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({length: value.length}, (_, i) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, i) ?? {}, 'value')).every(Boolean);
const state = (reason, ticket) => Object.freeze(ticket ?
  {shadow: true, liveDispatch: false, reason, ticket} : {shadow: true, liveDispatch: false, reason});
const identity = ['repositoryId', 'issue', 'head', 'generation'];
const ticketValid = ticket => data(ticket, identity) && positive(ticket.repositoryId) &&
  positive(ticket.issue) && sha(ticket.head) && positive(ticket.generation);
const matches = (a, b) => ticketValid(a) && identity.every(key => a[key] === b[key]);
const evidenceFields = [...identity, 'approvedRepositoryId', 'approved', 'stop', 'includedOnly',
  'overageDisabled', 'capacity', 'leaseVerified', 'alreadyDispatched', 'leaseUntil'];
const freshEvidenceFields = [...evidenceFields, 'observedMs'];
const snapshotRowFields = ['repositoryId', 'issue', 'head', 'generation', 'units', 'phase', 'validThrough', 'reservedAt'];

function compareRows(a, b) {
  if (a.repositoryId !== b.repositoryId) return a.repositoryId - b.repositoryId;
  if (a.issue !== b.issue) return a.issue - b.issue;
  return a.head === b.head ? 0 : a.head < b.head ? -1 : 1;
}

function canAdvancePhase(fromPhase, toPhase, fromValid, toValid) {
  if (fromPhase === toPhase) return toValid === fromValid;
  if (fromPhase === 'reserved') return ['in-flight', 'cancelled', 'settled', 'expired'].includes(toPhase);
  if (fromPhase === 'in-flight') return ['settled', 'expired'].includes(toPhase) && toValid === fromValid;
  return false;
}

function signCanonical(canonical, signingKey) {
  return {
    digest: createHash('sha256').update(canonical).digest('hex'),
    hmac: createHmac('sha256', signingKey).update(canonical).digest('hex')
  };
}

function normalizePlan(plan) {
  if (!data(plan, ['window', 'maxActive', 'includedUnits', 'unitsPerRun', 'repositories']) ||
      typeof plan.window !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(plan.window) ||
      !positive(plan.maxActive) || plan.maxActive > 250 ||
      !positive(plan.includedUnits) || plan.includedUnits > 10000000 ||
      !positive(plan.unitsPerRun) || plan.unitsPerRun > plan.includedUnits) return null;
  let maxExecutionMs = defaultMaxExecutionMs;
  if (Object.hasOwn(plan, 'maxExecutionMs')) {
    if (!data(plan, ['maxExecutionMs']) || !positive(plan.maxExecutionMs) ||
        plan.maxExecutionMs > maxAllowedExecutionMs) return null;
    maxExecutionMs = plan.maxExecutionMs;
  }
  const entries = plan.repositories;
  if (!denseArray(entries, 250) || !entries.length) return null;
  const repos = new Map();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!data(entry, ['repositoryId', 'maxActive']) || !positive(entry.repositoryId) ||
        !positive(entry.maxActive) || entry.maxActive > plan.maxActive || repos.has(entry.repositoryId)) return null;
    repos.set(entry.repositoryId, entry.maxActive);
  }
  const signature = JSON.stringify([plan.window, plan.maxActive, plan.includedUnits, plan.unitsPerRun,
    maxExecutionMs, [...repos].sort(([a], [b]) => a - b)]);
  return {repos, signature, window: plan.window, maxActive: plan.maxActive,
    includedUnits: plan.includedUnits, unitsPerRun: plan.unitsPerRun, maxExecutionMs};
}

/** Local synthetic reservation and lifecycle ledger. No provider transport. */
export function openShadowDispatchLedger(filename, fixturePlan) {
  const plan = normalizePlan(fixturePlan);
  if (!plan) throw new TypeError('INVALID_SHADOW_DISPATCH_PLAN');
  const db = new DatabaseSync(filename, {timeout: 250});
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_dispatch_plan (
        id INTEGER PRIMARY KEY CHECK(id = 1), signature TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_dispatch_snapshot_fence (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        sequence INTEGER NOT NULL CHECK(sequence >= 0 AND sequence <= 9007199254740991)
      );
      CREATE TABLE IF NOT EXISTS shadow_dispatch_reservations (
        repository INTEGER NOT NULL, issue INTEGER NOT NULL, head TEXT NOT NULL, generation INTEGER NOT NULL,
        units INTEGER NOT NULL CHECK(units > 0),
        phase TEXT NOT NULL CHECK(phase IN ('reserved', 'in-flight', 'settled', 'cancelled', 'expired')),
        valid_through INTEGER NOT NULL, reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
        CHECK(valid_through >= reserved_at),
        PRIMARY KEY (repository, issue, head)
      );
    `);
    db.prepare('INSERT OR IGNORE INTO shadow_dispatch_plan VALUES (1, ?)').run(plan.signature);
    if (db.prepare('SELECT signature FROM shadow_dispatch_plan WHERE id = 1').get().signature !== plan.signature)
      throw Error('SHADOW_DISPATCH_PLAN_CHANGED');
    db.prepare('INSERT OR IGNORE INTO shadow_dispatch_snapshot_fence VALUES (1, 0)').run();
    const usage = db.prepare(`
      SELECT coalesce(sum(CASE WHEN phase != 'cancelled' THEN units ELSE 0 END), 0) AS units,
        count(CASE WHEN phase IN ('reserved', 'in-flight') THEN 1 END) AS active,
        count(CASE WHEN repository = ? AND phase IN ('reserved', 'in-flight') THEN 1 END) AS repoActive,
        count(*) AS size
      FROM shadow_dispatch_reservations
    `);
    const reclaimReserved = db.prepare(`
      UPDATE shadow_dispatch_reservations SET phase = 'cancelled'
      WHERE phase = 'reserved' AND valid_through < ?
    `);
    const reclaimInFlight = db.prepare(`
      UPDATE shadow_dispatch_reservations SET phase = 'expired'
      WHERE phase = 'in-flight' AND valid_through < ?
    `);
    const insert = db.prepare(`
      INSERT INTO shadow_dispatch_reservations
      SELECT ?, ?, ?, ?, ?, 'reserved', ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM shadow_dispatch_reservations
        WHERE repository = ? AND issue = ? AND phase IN ('reserved', 'in-flight')
      )
      ON CONFLICT (repository, issue, head) DO NOTHING
    `);
    const begin = db.prepare(`
      UPDATE shadow_dispatch_reservations SET phase = 'in-flight', valid_through = ?
      WHERE repository = ? AND issue = ? AND head = ? AND generation = ?
        AND phase = 'reserved' AND reserved_at <= ? AND valid_through >= ?
    `);
    const readReservation = db.prepare(`
      SELECT phase, valid_through FROM shadow_dispatch_reservations
      WHERE repository = ? AND issue = ? AND head = ? AND generation = ?
    `);
    const transition = db.prepare(`
      UPDATE shadow_dispatch_reservations SET phase = ?
      WHERE repository = ? AND issue = ? AND head = ? AND generation = ? AND phase = ?
    `);
    const readSequence = db.prepare('SELECT sequence FROM shadow_dispatch_snapshot_fence WHERE id = 1');
    const writeSequence = db.prepare('UPDATE shadow_dispatch_snapshot_fence SET sequence = ? WHERE id = 1');
    const readAllRows = db.prepare(`
      SELECT repository, issue, head, generation, units, phase, valid_through, reserved_at
      FROM shadow_dispatch_reservations
      ORDER BY repository ASC, issue ASC, head ASC
    `);
    const upsertRow = db.prepare(`
      INSERT INTO shadow_dispatch_reservations (repository, issue, head, generation, units, phase, valid_through, reserved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (repository, issue, head) DO UPDATE SET
        phase = excluded.phase, valid_through = excluded.valid_through
    `);
    const values = ticket => identity.map(key => ticket[key]);

    function reserve(candidate, quota, now) {
      if (!data(candidate, evidenceFields) || !time(now) || !time(candidate.leaseUntil) ||
          candidate.leaseUntil <= now) return state('SCOPE_OR_LEASE_UNKNOWN');
      const intent = dispatchIntent(candidate);
      if (intent.reason !== 'DRY_RUN_ONLY') return state(intent.reason);
      const cap = plan.repos.get(candidate.repositoryId);
      if (!cap || !data(quota, ['window', 'repositoryId', 'remaining', 'active', 'repoActive',
        'observedMs', 'includedOnly', 'overageDisabled', 'authorityVerified']) ||
        (Object.hasOwn(quota, 'hardStopReceipt') && !data(quota, ['hardStopReceipt'])) ||
        (Object.hasOwn(quota, 'environmentVerified') && !data(quota, ['environmentVerified'])) ||
        quota.window !== plan.window || quota.repositoryId !== candidate.repositoryId ||
        !count(quota.remaining, plan.includedUnits) || !count(quota.active, 250) ||
        !count(quota.repoActive, quota.active)) return state('BUDGET_UNKNOWN');
      const ticket = Object.freeze(Object.fromEntries(identity.map(key => [key, candidate[key]])));
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch { return state('STORE_UNAVAILABLE'); }
      try {
        reclaimReserved.run(now);
        reclaimInFlight.run(now);
        const occupied = usage.get(candidate.repositoryId);
        const budgetInput = {stop: candidate.stop, includedOnly: quota.includedOnly,
          overageDisabled: quota.overageDisabled, authorityVerified: quota.authorityVerified,
          nowMs: now, observedMs: quota.observedMs, remaining: quota.remaining, reserved: occupied.units,
          active: quota.active + occupied.active, maxActive: plan.maxActive, unitsPerRun: plan.unitsPerRun};
        if (Object.hasOwn(quota, 'hardStopReceipt')) budgetInput.hardStopReceipt = quota.hardStopReceipt;
        if (Object.hasOwn(quota, 'environmentVerified')) budgetInput.environmentVerified = quota.environmentVerified;
        const available = budgetDecision(budgetInput);
        let reason = available.reason;
        if (reason === 'SHADOW_CAPACITY') {
          if (quota.repoActive + occupied.repoActive >= cap) reason = 'REPO_CAPACITY_EXHAUSTED';
          else if (occupied.size >= 10000) reason = 'STORE_FULL';
          else {
            const validThrough = Math.min(candidate.leaseUntil - 1, quota.observedMs + 60000);
            reason = insert.run(...values(ticket), plan.unitsPerRun, validThrough, now,
              ticket.repositoryId, ticket.issue).changes === 1 ? 'SHADOW_RESERVED' : 'DUPLICATE_OR_ACTIVE';
          }
        }
        db.exec('COMMIT');
        return state(reason, reason === 'SHADOW_RESERVED' ? ticket : undefined);
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return state('STORE_UNAVAILABLE');
      }
    }

    function expire(now) {
      const expireResult = (reason, expiredReserved, expiredInFlight) => Object.freeze({
        shadow: true,
        liveDispatch: false,
        reason,
        expiredReserved,
        expiredInFlight,
        reclaimed: expiredReserved + expiredInFlight
      });
      if (!time(now)) return expireResult('INVALID_TIME', 0, 0);
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch { return expireResult('STORE_UNAVAILABLE', 0, 0); }
      try {
        const expiredReserved = Number(reclaimReserved.run(now).changes);
        const expiredInFlight = Number(reclaimInFlight.run(now).changes);
        db.exec('COMMIT');
        const reclaimed = expiredReserved + expiredInFlight;
        return expireResult(reclaimed ? 'SHADOW_EXPIRED_RECLAIMED' : 'NO_EXPIRED_RESERVATIONS',
          expiredReserved, expiredInFlight);
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return expireResult('STORE_UNAVAILABLE', 0, 0);
      }
    }

    function exportSnapshot(options) {
      if (!data(options, ['signingKey', 'now']) || !signingKeyValid(options.signingKey) || !time(options.now))
        return state('SNAPSHOT_KEY_OR_TIME_INVALID');
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch { return state('STORE_UNAVAILABLE'); }
      try {
        const sequence = readSequence.get().sequence + 1;
        writeSequence.run(sequence);
        const reservations = Object.freeze(readAllRows.all().map(row => Object.freeze({
          repositoryId: row.repository,
          issue: row.issue,
          head: row.head,
          generation: row.generation,
          units: row.units,
          phase: row.phase,
          validThrough: row.valid_through,
          reservedAt: row.reserved_at
        })));
        const canonical = JSON.stringify([snapshotVersion, plan.signature, sequence, options.now, reservations]);
        const {digest, hmac} = signCanonical(canonical, options.signingKey);
        db.exec('COMMIT');
        const snapshot = Object.freeze({
          version: snapshotVersion,
          window: plan.window,
          planSignature: plan.signature,
          sequence,
          exportedAt: options.now,
          reservations,
          digest,
          hmac
        });
        return Object.freeze({shadow: true, liveDispatch: false, reason: 'SHADOW_SNAPSHOT_EXPORTED', snapshot});
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return state('STORE_UNAVAILABLE');
      }
    }

    function importSnapshot(snapshot, options) {
      if (!data(options, ['signingKey', 'now']) || !signingKeyValid(options.signingKey) || !time(options.now))
        return state('SNAPSHOT_KEY_OR_TIME_INVALID');
      if (!data(snapshot, ['version', 'window', 'planSignature', 'sequence', 'exportedAt',
        'reservations', 'digest', 'hmac']) || Reflect.ownKeys(snapshot).length !== 8 ||
        snapshot.version !== snapshotVersion || typeof snapshot.window !== 'string' ||
        typeof snapshot.planSignature !== 'string' || !positive(snapshot.sequence) ||
        !time(snapshot.exportedAt) || snapshot.exportedAt > options.now ||
        !denseArray(snapshot.reservations, 10000) || !hex64(snapshot.digest) || !hex64(snapshot.hmac))
        return state('INVALID_SNAPSHOT');
      if (snapshot.planSignature !== plan.signature || snapshot.window !== plan.window)
        return state('PLAN_SIGNATURE_MISMATCH');
      const normalized = [];
      const activeIssues = new Set();
      const repoActive = new Map();
      let totalActive = 0;
      let totalUnits = 0;
      for (let i = 0; i < snapshot.reservations.length; i++) {
        const row = snapshot.reservations[i];
        if (!data(row, snapshotRowFields) || Reflect.ownKeys(row).length !== snapshotRowFields.length ||
            !plan.repos.has(row.repositoryId) ||
            !positive(row.issue) || !sha(row.head) || !positive(row.generation) ||
            !positive(row.units) || row.units > plan.includedUnits || !phases.has(row.phase) ||
            !time(row.reservedAt) || !time(row.validThrough) || row.validThrough < row.reservedAt)
          return state('INVALID_SNAPSHOT');
        const clean = {
          repositoryId: row.repositoryId,
          issue: row.issue,
          head: row.head,
          generation: row.generation,
          units: row.units,
          phase: row.phase,
          validThrough: row.validThrough,
          reservedAt: row.reservedAt
        };
        if (normalized.length && compareRows(normalized[normalized.length - 1], clean) >= 0)
          return state('INVALID_SNAPSHOT');
        if (clean.phase !== 'cancelled') {
          totalUnits += clean.units;
          if (totalUnits > plan.includedUnits) return state('INVALID_SNAPSHOT');
        }
        if (clean.phase === 'reserved' || clean.phase === 'in-flight') {
          const issueKey = `${clean.repositoryId}:${clean.issue}`;
          const nextRepoActive = (repoActive.get(clean.repositoryId) ?? 0) + 1;
          totalActive++;
          if (activeIssues.has(issueKey) || nextRepoActive > plan.repos.get(clean.repositoryId) ||
              totalActive > plan.maxActive) return state('INVALID_SNAPSHOT');
          activeIssues.add(issueKey);
          repoActive.set(clean.repositoryId, nextRepoActive);
        }
        normalized.push(clean);
      }
      const canonical = JSON.stringify([snapshotVersion, snapshot.planSignature, snapshot.sequence,
        snapshot.exportedAt, normalized]);
      const expected = signCanonical(canonical, options.signingKey);
      if (!timingSafeEqual(Buffer.from(snapshot.digest, 'hex'), Buffer.from(expected.digest, 'hex')) ||
          !timingSafeEqual(Buffer.from(snapshot.hmac, 'hex'), Buffer.from(expected.hmac, 'hex')))
        return state('SNAPSHOT_SIGNATURE_INVALID');
      const byKey = new Map(normalized.map(row => [`${row.repositoryId}:${row.issue}:${row.head}`, row]));
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch { return state('STORE_UNAVAILABLE'); }
      try {
        const currentSequence = readSequence.get().sequence;
        if (snapshot.sequence <= currentSequence) {
          db.exec('ROLLBACK');
          return state('STALE_SNAPSHOT_SEQUENCE');
        }
        for (const local of readAllRows.all()) {
          const incoming = byKey.get(`${local.repository}:${local.issue}:${local.head}`);
          if (!incoming || incoming.generation !== local.generation ||
              incoming.units !== local.units || incoming.reservedAt !== local.reserved_at ||
              !canAdvancePhase(local.phase, incoming.phase, local.valid_through, incoming.validThrough)) {
            db.exec('ROLLBACK');
            return state('SNAPSHOT_STATE_REGRESSION');
          }
        }
        for (const row of normalized) {
          upsertRow.run(row.repositoryId, row.issue, row.head, row.generation,
            row.units, row.phase, row.validThrough, row.reservedAt);
        }
        writeSequence.run(snapshot.sequence);
        db.exec('COMMIT');
        return Object.freeze({
          shadow: true,
          liveDispatch: false,
          reason: 'SHADOW_SNAPSHOT_IMPORTED',
          sequence: snapshot.sequence,
          restored: normalized.length
        });
      } catch {
        try { db.exec('ROLLBACK'); } catch {}
        return state('STORE_UNAVAILABLE');
      }
    }

    return Object.freeze({
      reserve,
      begin(ticket, current, now) {
        if (!ticketValid(ticket) || !data(current, freshEvidenceFields) || !matches(current, ticket) ||
            !time(now) || !time(current.leaseUntil) || current.leaseUntil <= now)
          return state('SCOPE_OR_LEASE_UNKNOWN');
        let executionTtlMs = plan.maxExecutionMs;
        if (Object.hasOwn(current, 'executionTtlMs')) {
          if (!data(current, ['executionTtlMs']) || !positive(current.executionTtlMs) ||
              current.executionTtlMs > plan.maxExecutionMs)
            return state('EXECUTION_DEADLINE_INVALID');
          executionTtlMs = current.executionTtlMs;
        }
        if (!time(current.observedMs) || current.observedMs > now || now - current.observedMs > 5000)
          return state('STALE_LEASE_EVIDENCE');
        const intent = dispatchIntent(current);
        if (intent.reason !== 'DRY_RUN_ONLY') return state(intent.reason);
        const executionDeadline = Math.min(current.leaseUntil - 1, now + executionTtlMs);
        try {
          return begin.run(executionDeadline, ...values(ticket), now, now).changes === 1 ?
            Object.freeze({shadow: true, liveDispatch: false, reason: 'SHADOW_SIMULATION_RECORDED', executionDeadline}) :
            state('RESERVATION_UNAVAILABLE');
        } catch { return state('STORE_UNAVAILABLE'); }
      },
      expire,
      cancel(ticket) {
        if (!ticketValid(ticket)) return state('SCOPE_OR_LEASE_UNKNOWN');
        try {
          return state(transition.run('cancelled', ...values(ticket), 'reserved').changes === 1 ?
            'SHADOW_CANCELLED_BEFORE_SIMULATION' : 'RESERVATION_UNAVAILABLE');
        } catch { return state('STORE_UNAVAILABLE'); }
      },
      reconcile(ticket, receipt, ...rest) {
        const hasNow = rest.length > 0;
        const now = rest[0];
        if (!ticketValid(ticket) || !matches(receipt, ticket) || !data(receipt, ['state', 'shadow']) ||
            receipt.shadow !== true || !['completed', 'cancelled'].includes(receipt.state) ||
            (hasNow && !time(now)))
          return state('TERMINAL_RECEIPT_UNKNOWN');
        try {
          db.exec('BEGIN IMMEDIATE');
        } catch { return state('STORE_UNAVAILABLE'); }
        try {
          const row = readReservation.get(...values(ticket));
          let reason = 'RESERVATION_UNAVAILABLE';
          if (row) {
            if (row.phase === 'expired' || (row.phase === 'in-flight' && hasNow && row.valid_through < now)) {
              if (row.phase === 'in-flight') transition.run('expired', ...values(ticket), 'in-flight');
              reason = 'EXECUTION_DEADLINE_EXCEEDED';
            } else if (row.phase === 'in-flight') {
              transition.run('settled', ...values(ticket), 'in-flight');
              reason = 'SHADOW_SETTLED';
            }
          }
          db.exec('COMMIT');
          return state(reason);
        } catch {
          try { db.exec('ROLLBACK'); } catch {}
          return state('STORE_UNAVAILABLE');
        }
      },
      exportSnapshot,
      importSnapshot,
      close() { db.close(); }
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
