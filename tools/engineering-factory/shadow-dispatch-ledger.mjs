import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {types} from 'node:util';
import {budgetDecision} from './budget.mjs';
import {dispatchIntent} from './dispatch-intent.mjs';

const defaultMaxExecutionMs = 900000;
const maxAllowedExecutionMs = 3600000;
const schemaVersion = 1;
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

export const PROTECTED_WORK_QUEUE_REF = 'refs/heads/work-queue';
export const ZERO_GIT_OID = '0000000000000000000000000000000000000000';
export const MAX_CROSS_RUN_LEASE_TTL_MS = maxAllowedExecutionMs;
export const SUPPORTED_QUEUE_PROTOCOLS = Object.freeze(['v3', 'v4']);
export const SUPPORTED_CLOUD_HARNESSES = Object.freeze([
  'copilot-cloud-agent',
  'copilot-cloud-automation',
  'copilot-sdk'
]);

const pinnedCopilotSdkVersion = '2.0.3';
const defaultMaxQuotaAgeMs = 60000;
const maxAllowedQuotaAgeMs = 300000;
const maxCasEntries = 250;
const maxCasReceipts = 250;
const maxCasArchived = 2000;
const maxCreditCount = 1000000000;
const maxSnapshotAgeMs = 86400000;
const validVisibilities = new Set(['public', 'private', 'internal']);
const automationVisibilities = new Set(['private', 'internal']);
const validCasStatuses = new Set(['leased', 'requeued', 'completed', 'cancelled', 'exhausted']);
const terminalCasStatuses = new Set(['completed', 'cancelled', 'exhausted']);
const validObservedRunStates = new Set(['launch_failed', 'worker_terminated', 'run_terminal', 'run_missing']);
const validRunConclusions = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'skipped',
  'timed_out', 'action_required', 'stale', 'startup_failure'
]);
const repoSlugValid = value => typeof value === 'string' && !value.includes('..') &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const workerIdValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
const laneIdValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const traceparentValid = value => typeof value === 'string' &&
  /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(value);
const boundedCasTtl = value => positive(value) && value <= MAX_CROSS_RUN_LEASE_TTL_MS;
const relPathValid = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  !value.startsWith('/') && !value.includes('\\') && !value.includes(':') &&
  /^[A-Za-z0-9._/-]+$/.test(value) &&
  !value.split('/').some(part => part.length === 0 || part === '.' || part === '..');
const pathsOverlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const archivedWorkIdValid = value => typeof value === 'string' && value.length <= 160 &&
  /^[1-9]\d*:(?:issue:[1-9]\d*|pr:[1-9]\d*:[a-f0-9]{40})$/.test(value);

function ownEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function plainRecord(value, requiredKeys, optionalKeys = []) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.every(key => typeof key === 'string' && allowed.has(key) && ownEnumerableData(value, key)) &&
    requiredKeys.every(key => Object.hasOwn(value, key) && value[key] !== undefined);
}

function denseDataArray(value, maxLen) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLen ||
      Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (!ownEnumerableData(value, i)) return false;
  }
  return true;
}

function pathSetValid(paths) {
  return denseDataArray(paths, 64) && paths.length > 0 &&
    paths.every(relPathValid) && new Set(paths).size === paths.length;
}

function compareRows(a, b) {
  if (a.repositoryId !== b.repositoryId) return a.repositoryId - b.repositoryId;
  if (a.issue !== b.issue) return a.issue - b.issue;
  return a.head === b.head ? 0 : a.head < b.head ? -1 : 1;
}

function canAdvancePhase(fromPhase, toPhase, fromValid, toValid, maxExecutionMs) {
  if (fromPhase === toPhase) return toValid === fromValid;
  if (fromPhase === 'reserved') {
    if (toPhase === 'cancelled') return toValid === fromValid;
    return ['in-flight', 'settled', 'expired'].includes(toPhase) && toValid - fromValid <= maxExecutionMs;
  }
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
  const sortedRepos = [...repos].sort(([a], [b]) => a - b);
  const legacySignature = maxExecutionMs === defaultMaxExecutionMs ?
    JSON.stringify([plan.window, plan.maxActive, plan.includedUnits, plan.unitsPerRun, sortedRepos]) : null;
  const signature = JSON.stringify([plan.window, plan.maxActive, plan.includedUnits, plan.unitsPerRun,
    maxExecutionMs, sortedRepos]);
  return {repos, signature, legacySignature, window: plan.window, maxActive: plan.maxActive,
    includedUnits: plan.includedUnits, unitsPerRun: plan.unitsPerRun, maxExecutionMs};
}

/** Local synthetic reservation and lifecycle ledger. No provider transport. */
export function openShadowDispatchLedger(filename, fixturePlan) {
  const plan = normalizePlan(fixturePlan);
  if (!plan) throw new TypeError('INVALID_SHADOW_DISPATCH_PLAN');
  const db = new DatabaseSync(filename, {timeout: 250});
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const userVersion = db.prepare('PRAGMA user_version').get().user_version;
      if (userVersion !== 0 && userVersion !== schemaVersion)
        throw Error('SHADOW_DISPATCH_SCHEMA_UNSUPPORTED');
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
      const storedSignature = db.prepare('SELECT signature FROM shadow_dispatch_plan WHERE id = 1').get().signature;
      if (storedSignature !== plan.signature) {
        if (userVersion !== 0 || plan.legacySignature === null || storedSignature !== plan.legacySignature)
          throw Error('SHADOW_DISPATCH_PLAN_CHANGED');
        db.prepare('UPDATE shadow_dispatch_plan SET signature = ? WHERE id = 1').run(plan.signature);
      }
      if (userVersion === 0) {
        const tableDDL = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shadow_dispatch_reservations'"
        ).get().sql;
        if (!tableDDL.includes("'expired'")) {
          db.exec(`
            CREATE TABLE shadow_dispatch_reservations_v2 (
              repository INTEGER NOT NULL, issue INTEGER NOT NULL, head TEXT NOT NULL, generation INTEGER NOT NULL,
              units INTEGER NOT NULL CHECK(units > 0),
              phase TEXT NOT NULL CHECK(phase IN ('reserved', 'in-flight', 'settled', 'cancelled', 'expired')),
              valid_through INTEGER NOT NULL, reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
              CHECK(valid_through >= reserved_at),
              PRIMARY KEY (repository, issue, head)
            );
            INSERT INTO shadow_dispatch_reservations_v2
              SELECT repository, issue, head, generation, units, phase, valid_through, reserved_at
              FROM shadow_dispatch_reservations;
            DROP TABLE shadow_dispatch_reservations;
            ALTER TABLE shadow_dispatch_reservations_v2 RENAME TO shadow_dispatch_reservations;
          `);
        }
        db.exec(`PRAGMA user_version = ${schemaVersion}`);
      }
      db.prepare('INSERT OR IGNORE INTO shadow_dispatch_snapshot_fence VALUES (1, 0)').run();
      db.exec('COMMIT');
    } catch (initError) {
      try { db.exec('ROLLBACK'); } catch {}
      throw initError;
    }
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
      SELECT phase, valid_through, reserved_at FROM shadow_dispatch_reservations
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
      const intent = dispatchIntent(candidate, now);
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
            row.units !== plan.unitsPerRun || !phases.has(row.phase) ||
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
        if (clean.reservedAt > snapshot.exportedAt) return state('INVALID_SNAPSHOT');
        const maxBeginAt = snapshot.exportedAt - clean.reservedAt > 60000 ?
          clean.reservedAt + 60000 : snapshot.exportedAt;
        const deadlineExceeded = (clean.phase === 'reserved' || clean.phase === 'cancelled') ?
          clean.validThrough - clean.reservedAt > 60000 :
          clean.validThrough - maxBeginAt > plan.maxExecutionMs;
        if (deadlineExceeded) return state('INVALID_SNAPSHOT');
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
              !canAdvancePhase(local.phase, incoming.phase, local.valid_through,
                incoming.validThrough, plan.maxExecutionMs)) {
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
        const intent = dispatchIntent(current, now);
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
      reconcile(ticket, receipt, now) {
        if (!ticketValid(ticket) || !matches(receipt, ticket) || !data(receipt, ['state', 'shadow']) ||
            receipt.shadow !== true || !['completed', 'cancelled'].includes(receipt.state) || !time(now))
          return state('TERMINAL_RECEIPT_UNKNOWN');
        try {
          db.exec('BEGIN IMMEDIATE');
        } catch { return state('STORE_UNAVAILABLE'); }
        try {
          const row = readReservation.get(...values(ticket));
          let reason = 'RESERVATION_UNAVAILABLE';
          if (row) {
            if (now < row.reserved_at) {
              reason = 'TERMINAL_RECEIPT_UNKNOWN';
            } else if (row.phase === 'expired' || (row.phase === 'in-flight' && row.valid_through < now)) {
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

function parseVerifiedPlanSignature(planSignature, expectedWindow) {
  if (planSignature.length === 0 || planSignature.length > 16384) return null;
  let parsed;
  try {
    parsed = JSON.parse(planSignature);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 6) return null;
  const [win, maxActive, includedUnits, unitsPerRun, maxExecutionMs, sortedRepos] = parsed;
  if (win !== expectedWindow || !Array.isArray(sortedRepos) ||
      sortedRepos.length === 0 || sortedRepos.length > 250 ||
      !sortedRepos.every(pair => Array.isArray(pair) && pair.length === 2)) return null;
  const plan = normalizePlan({
    window: win,
    maxActive,
    includedUnits,
    unitsPerRun,
    maxExecutionMs,
    repositories: sortedRepos.map(([repositoryId, repoMaxActive]) => ({repositoryId, maxActive: repoMaxActive}))
  });
  return plan !== null && plan.signature === planSignature ? plan : null;
}

const denySnapshotVerification = reason => Object.freeze({
  shadow: true,
  liveDispatch: false,
  ok: false,
  reason
});

/** Pure HMAC-SHA256, SHA-256, and plan/invariant verifier for signed ledger snapshots. */
export function verifySignedLedgerSnapshot(ledgerSnapshot, options) {
  if (!plainRecord(options, ['signingKey', 'nowMs'], ['fixturePlan', 'minSequence', 'maxSnapshotAgeMs']) ||
      !signingKeyValid(options.signingKey) || !time(options.nowMs) ||
      (options.minSequence !== undefined && !time(options.minSequence)) ||
      (options.maxSnapshotAgeMs !== undefined &&
        (!positive(options.maxSnapshotAgeMs) || options.maxSnapshotAgeMs > maxSnapshotAgeMs))) {
    return denySnapshotVerification('SNAPSHOT_KEY_OR_TIME_INVALID');
  }
  let expectedPlan = null;
  if (options.fixturePlan !== undefined) {
    expectedPlan = normalizePlan(options.fixturePlan);
    if (!expectedPlan) return denySnapshotVerification('INVALID_SHADOW_DISPATCH_PLAN');
  }
  if (!plainRecord(ledgerSnapshot, [
    'version', 'window', 'planSignature', 'sequence', 'exportedAt', 'reservations', 'digest', 'hmac'
  ]) || ledgerSnapshot.version !== snapshotVersion ||
      typeof ledgerSnapshot.window !== 'string' ||
      typeof ledgerSnapshot.planSignature !== 'string' ||
      !positive(ledgerSnapshot.sequence) ||
      ledgerSnapshot.sequence >= Number.MAX_SAFE_INTEGER ||
      !time(ledgerSnapshot.exportedAt) ||
      !denseDataArray(ledgerSnapshot.reservations, 10000) ||
      !hex64(ledgerSnapshot.digest) || !hex64(ledgerSnapshot.hmac)) {
    return denySnapshotVerification('INVALID_SNAPSHOT');
  }

  const normalized = [];
  for (let i = 0; i < ledgerSnapshot.reservations.length; i++) {
    const row = ledgerSnapshot.reservations[i];
    if (!plainRecord(row, snapshotRowFields) ||
        !Number.isSafeInteger(row.repositoryId) || !Number.isSafeInteger(row.issue) ||
        typeof row.head !== 'string' || !Number.isSafeInteger(row.generation) ||
        !Number.isSafeInteger(row.units) || typeof row.phase !== 'string' ||
        !Number.isSafeInteger(row.validThrough) || !Number.isSafeInteger(row.reservedAt)) {
      return denySnapshotVerification('INVALID_SNAPSHOT');
    }
    normalized.push({
      repositoryId: row.repositoryId,
      issue: row.issue,
      head: row.head,
      generation: row.generation,
      units: row.units,
      phase: row.phase,
      validThrough: row.validThrough,
      reservedAt: row.reservedAt
    });
  }

  const canonical = JSON.stringify([
    snapshotVersion,
    ledgerSnapshot.planSignature,
    ledgerSnapshot.sequence,
    ledgerSnapshot.exportedAt,
    normalized
  ]);
  const expected = signCanonical(canonical, options.signingKey);
  if (!timingSafeEqual(Buffer.from(ledgerSnapshot.digest, 'hex'), Buffer.from(expected.digest, 'hex')) ||
      !timingSafeEqual(Buffer.from(ledgerSnapshot.hmac, 'hex'), Buffer.from(expected.hmac, 'hex'))) {
    return denySnapshotVerification('SNAPSHOT_SIGNATURE_INVALID');
  }

  const plan = parseVerifiedPlanSignature(ledgerSnapshot.planSignature, ledgerSnapshot.window);
  if (!plan) return denySnapshotVerification('INVALID_SNAPSHOT');
  if (expectedPlan && plan.signature !== expectedPlan.signature) {
    return denySnapshotVerification('PLAN_SIGNATURE_MISMATCH');
  }
  if (ledgerSnapshot.exportedAt > options.nowMs) return denySnapshotVerification('INVALID_SNAPSHOT');
  if (options.minSequence !== undefined && ledgerSnapshot.sequence < options.minSequence) {
    return denySnapshotVerification('STALE_SNAPSHOT_SEQUENCE');
  }
  if (options.maxSnapshotAgeMs !== undefined &&
      options.nowMs - ledgerSnapshot.exportedAt > options.maxSnapshotAgeMs) {
    return denySnapshotVerification('STALE_LEDGER_SNAPSHOT');
  }

  const activeIssues = new Set();
  const repoActive = new Map();
  let totalActive = 0;
  let totalUnits = 0;
  for (let i = 0; i < normalized.length; i++) {
    const clean = normalized[i];
    if (!plan.repos.has(clean.repositoryId) || !positive(clean.issue) || !sha(clean.head) ||
        !positive(clean.generation) || clean.units !== plan.unitsPerRun || !phases.has(clean.phase) ||
        !time(clean.reservedAt) || !time(clean.validThrough) || clean.validThrough < clean.reservedAt ||
        clean.reservedAt > ledgerSnapshot.exportedAt) {
      return denySnapshotVerification('INVALID_SNAPSHOT');
    }
    const maxBeginAt = ledgerSnapshot.exportedAt - clean.reservedAt > 60000
      ? clean.reservedAt + 60000
      : ledgerSnapshot.exportedAt;
    const deadlineExceeded = (clean.phase === 'reserved' || clean.phase === 'cancelled')
      ? clean.validThrough - clean.reservedAt > 60000
      : clean.validThrough - maxBeginAt > plan.maxExecutionMs;
    if (deadlineExceeded || (i > 0 && compareRows(normalized[i - 1], clean) >= 0)) {
      return denySnapshotVerification('INVALID_SNAPSHOT');
    }
    if (clean.phase !== 'cancelled') {
      totalUnits += clean.units;
      if (totalUnits > plan.includedUnits) return denySnapshotVerification('INVALID_SNAPSHOT');
    }
    if (clean.phase === 'reserved' || clean.phase === 'in-flight') {
      const issueKey = `${clean.repositoryId}:${clean.issue}`;
      const nextRepoActive = (repoActive.get(clean.repositoryId) ?? 0) + 1;
      totalActive++;
      if (activeIssues.has(issueKey) || nextRepoActive > plan.repos.get(clean.repositoryId) ||
          totalActive > plan.maxActive) {
        return denySnapshotVerification('INVALID_SNAPSHOT');
      }
      activeIssues.add(issueKey);
      repoActive.set(clean.repositoryId, nextRepoActive);
    }
  }

  const frozenReservations = Object.freeze(normalized.map(row => Object.freeze({...row})));
  const frozenSnapshot = Object.freeze({
    version: snapshotVersion,
    window: ledgerSnapshot.window,
    planSignature: ledgerSnapshot.planSignature,
    sequence: ledgerSnapshot.sequence,
    exportedAt: ledgerSnapshot.exportedAt,
    reservations: frozenReservations,
    digest: ledgerSnapshot.digest,
    hmac: ledgerSnapshot.hmac
  });
  return Object.freeze({
    shadow: true,
    liveDispatch: false,
    ok: true,
    reason: 'SNAPSHOT_VERIFIED',
    plan,
    snapshot: frozenSnapshot
  });
}

function freezeCasEntry(entry) {
  const copy = {
    workId: entry.workId,
    targetType: entry.targetType,
    repository: entry.repository,
    repositoryId: entry.repositoryId,
    issueNumber: entry.issueNumber,
    pullNumber: entry.pullNumber,
    headSha: entry.headSha,
    lane: entry.lane,
    ownedPaths: Object.freeze([...entry.ownedPaths]),
    status: entry.status,
    generation: entry.generation,
    attempts: entry.attempts,
    maxAttempts: entry.maxAttempts,
    workerId: entry.workerId,
    runId: entry.runId,
    runAttempt: entry.runAttempt,
    claimedAtMs: entry.claimedAtMs,
    leaseTtlMs: entry.leaseTtlMs,
    leaseExpiresAtMs: entry.leaseExpiresAtMs,
    maxExecutionMs: entry.maxExecutionMs,
    executionDeadlineMs: entry.executionDeadlineMs
  };
  if (entry.traceparent !== undefined) copy.traceparent = entry.traceparent;
  if (entry.lockSha256 !== undefined) copy.lockSha256 = entry.lockSha256;
  if (entry.priorRuns !== undefined) {
    copy.priorRuns = Object.freeze(entry.priorRuns.map(item => Object.freeze({
      runId: item.runId,
      runAttempt: item.runAttempt
    })));
  }
  return Object.freeze(copy);
}

function freezeCasReceipt(receipt) {
  return Object.freeze({
    workId: receipt.workId,
    repositoryId: receipt.repositoryId,
    targetType: receipt.targetType,
    runState: receipt.runState,
    conclusion: receipt.conclusion,
    previousRunId: receipt.previousRunId,
    previousRunAttempt: receipt.previousRunAttempt,
    previousGeneration: receipt.previousGeneration,
    reclaimedGeneration: receipt.reclaimedGeneration,
    attempts: receipt.attempts,
    maxAttempts: receipt.maxAttempts,
    outcome: receipt.outcome,
    reclaimedAtMs: receipt.reclaimedAtMs
  });
}

function freezeCasStateShape(protocol, sequence, nextGeneration, entries, recoveryReceipts, archivedTerminal) {
  const out = {
    schemaVersion: 1,
    protocol,
    sequence,
    nextGeneration,
    entries: Object.freeze(entries.map(freezeCasEntry)),
    recoveryReceipts: Object.freeze(recoveryReceipts.map(freezeCasReceipt))
  };
  if (archivedTerminal.length > 0) {
    out.archivedTerminal = Object.freeze(
      archivedTerminal.map(item => Object.freeze({workId: item.workId, status: item.status}))
    );
  }
  return Object.freeze(out);
}

function validatePriorRunsList(priorRuns, entry) {
  if (!denseDataArray(priorRuns, 4) || priorRuns.length === 0 || priorRuns.length >= entry.attempts) {
    return false;
  }
  const seen = new Set([`${entry.runId}:${entry.runAttempt}`]);
  for (let i = 0; i < priorRuns.length; i++) {
    const item = priorRuns[i];
    if (!plainRecord(item, ['runId', 'runAttempt']) || !positive(item.runId) || !positive(item.runAttempt)) {
      return false;
    }
    const key = `${item.runId}:${item.runAttempt}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validateCasEntry(entry) {
  const required = [
    'workId', 'targetType', 'repository', 'repositoryId', 'issueNumber', 'pullNumber', 'headSha',
    'lane', 'ownedPaths', 'status', 'generation', 'attempts', 'maxAttempts', 'workerId', 'runId', 'runAttempt',
    'claimedAtMs', 'leaseTtlMs', 'leaseExpiresAtMs', 'maxExecutionMs', 'executionDeadlineMs'
  ];
  if (!plainRecord(entry, required, ['traceparent', 'lockSha256', 'priorRuns'])) {
    return 'INVALID_QUEUE_STATE';
  }
  if ((Number.isSafeInteger(entry.leaseTtlMs) && entry.leaseTtlMs > MAX_CROSS_RUN_LEASE_TTL_MS) ||
      (Number.isSafeInteger(entry.maxExecutionMs) && entry.maxExecutionMs > MAX_CROSS_RUN_LEASE_TTL_MS)) {
    return 'LEASE_TTL_EXCEEDED';
  }
  if (!repoSlugValid(entry.repository) || !positive(entry.repositoryId) ||
      !laneIdValid(entry.lane) || !pathSetValid(entry.ownedPaths) ||
      !validCasStatuses.has(entry.status) || !positive(entry.generation) ||
      !positive(entry.attempts) || !Number.isSafeInteger(entry.maxAttempts) ||
      entry.maxAttempts < 1 || entry.maxAttempts > 5 || entry.attempts > entry.maxAttempts ||
      !workerIdValid(entry.workerId) || !positive(entry.runId) || !positive(entry.runAttempt) ||
      !time(entry.claimedAtMs) || !boundedCasTtl(entry.leaseTtlMs) ||
      !boundedCasTtl(entry.maxExecutionMs) || entry.maxExecutionMs < entry.leaseTtlMs ||
      !time(entry.leaseExpiresAtMs) || !time(entry.executionDeadlineMs) ||
      entry.executionDeadlineMs !== entry.claimedAtMs + entry.maxExecutionMs ||
      entry.leaseExpiresAtMs > entry.executionDeadlineMs) {
    return 'INVALID_QUEUE_STATE';
  }
  let expectedId;
  if (entry.targetType === 'issue') {
    if (!positive(entry.issueNumber) || entry.pullNumber !== null || entry.headSha !== null) {
      return 'INVALID_QUEUE_STATE';
    }
    expectedId = `${entry.repositoryId}:issue:${entry.issueNumber}`;
  } else if (entry.targetType === 'pull_request') {
    if (!positive(entry.pullNumber) || !sha(entry.headSha) || entry.issueNumber !== null) {
      return 'INVALID_QUEUE_STATE';
    }
    expectedId = `${entry.repositoryId}:pr:${entry.pullNumber}:${entry.headSha}`;
  } else {
    return 'INVALID_QUEUE_STATE';
  }
  if (entry.workId !== expectedId ||
      (entry.traceparent !== undefined && !traceparentValid(entry.traceparent)) ||
      (entry.lockSha256 !== undefined && !hex64(entry.lockSha256)) ||
      (entry.priorRuns !== undefined && !validatePriorRunsList(entry.priorRuns, entry))) {
    return 'INVALID_QUEUE_STATE';
  }
  return null;
}

function validateCasReceipt(receipt) {
  const required = [
    'workId', 'repositoryId', 'targetType', 'runState', 'conclusion', 'previousRunId', 'previousRunAttempt',
    'previousGeneration', 'reclaimedGeneration', 'attempts', 'maxAttempts', 'outcome', 'reclaimedAtMs'
  ];
  return plainRecord(receipt, required) &&
    typeof receipt.workId === 'string' && receipt.workId.length > 0 &&
    positive(receipt.repositoryId) &&
    (receipt.targetType === 'issue' || receipt.targetType === 'pull_request') &&
    (validObservedRunStates.has(receipt.runState) || receipt.runState === 'lease_expired') &&
    (receipt.conclusion === null || validRunConclusions.has(receipt.conclusion)) &&
    positive(receipt.previousRunId) && positive(receipt.previousRunAttempt) &&
    positive(receipt.previousGeneration) && positive(receipt.reclaimedGeneration) &&
    receipt.reclaimedGeneration > receipt.previousGeneration &&
    positive(receipt.attempts) && Number.isSafeInteger(receipt.maxAttempts) &&
    receipt.maxAttempts >= 1 && receipt.maxAttempts <= 5 &&
    ['requeued', 'exhausted', 'completed'].includes(receipt.outcome) &&
    time(receipt.reclaimedAtMs);
}

function validateCasStateObject(rawState, v4Verified, nowMs) {
  if (!plainRecord(rawState, [
    'schemaVersion', 'protocol', 'sequence', 'nextGeneration', 'entries', 'recoveryReceipts'
  ], ['archivedTerminal']) || rawState.schemaVersion !== 1 || typeof rawState.protocol !== 'string') {
    return {ok: false, reason: 'INVALID_QUEUE_STATE'};
  }
  if (rawState.protocol === 'v4') {
    if (!v4Verified) return {ok: false, reason: 'UNVERIFIED_QUEUE_PROTOCOL'};
  } else if (rawState.protocol !== 'v3') {
    return {ok: false, reason: 'UNVERIFIED_QUEUE_PROTOCOL'};
  }
  if (!time(rawState.sequence) || !positive(rawState.nextGeneration) ||
      rawState.sequence >= Number.MAX_SAFE_INTEGER ||
      rawState.nextGeneration > Number.MAX_SAFE_INTEGER - 512 ||
      !denseDataArray(rawState.entries, maxCasEntries) ||
      !denseDataArray(rawState.recoveryReceipts, maxCasReceipts)) {
    return {ok: false, reason: 'INVALID_QUEUE_STATE'};
  }
  const seenWorkIds = new Set();
  for (let i = 0; i < rawState.entries.length; i++) {
    const entry = rawState.entries[i];
    const entryErr = validateCasEntry(entry);
    if (entryErr !== null) return {ok: false, reason: entryErr};
    if (seenWorkIds.has(entry.workId) || entry.generation >= rawState.nextGeneration) {
      return {ok: false, reason: 'INVALID_QUEUE_STATE'};
    }
    if (nowMs !== null && entry.claimedAtMs > nowMs) {
      return {ok: false, reason: 'CLOCK_SKEW_REJECTED'};
    }
    seenWorkIds.add(entry.workId);
  }
  const archived = [];
  if (rawState.archivedTerminal !== undefined) {
    if (!denseDataArray(rawState.archivedTerminal, maxCasArchived)) {
      return {ok: false, reason: 'INVALID_QUEUE_STATE'};
    }
    for (let i = 0; i < rawState.archivedTerminal.length; i++) {
      const item = rawState.archivedTerminal[i];
      if (!plainRecord(item, ['workId', 'status']) ||
          !archivedWorkIdValid(item.workId) ||
          !terminalCasStatuses.has(item.status) || seenWorkIds.has(item.workId)) {
        return {ok: false, reason: 'INVALID_QUEUE_STATE'};
      }
      seenWorkIds.add(item.workId);
      archived.push({workId: item.workId, status: item.status});
    }
  }
  for (let i = 0; i < rawState.recoveryReceipts.length; i++) {
    const receipt = rawState.recoveryReceipts[i];
    if (!validateCasReceipt(receipt) || receipt.reclaimedGeneration >= rawState.nextGeneration) {
      return {ok: false, reason: 'INVALID_QUEUE_STATE'};
    }
    if (nowMs !== null && receipt.reclaimedAtMs > nowMs) {
      return {ok: false, reason: 'CLOCK_SKEW_REJECTED'};
    }
  }
  return {
    ok: true,
    state: freezeCasStateShape(
      rawState.protocol,
      rawState.sequence,
      rawState.nextGeneration,
      rawState.entries,
      rawState.recoveryReceipts,
      archived
    )
  };
}

function hashCasStateOid(previousRefOid, validatedState) {
  return createHash('sha256')
    .update(`${previousRefOid}:${JSON.stringify(validatedState)}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
}

/** Computes the deterministic 40-hex work-queue-cas state OID without Git/network access. */
export function computeWorkQueueStateOid(casState, previousRefOid = ZERO_GIT_OID) {
  if (!sha(previousRefOid)) return null;
  if (casState === null) return previousRefOid === ZERO_GIT_OID ? ZERO_GIT_OID : null;
  const checked = validateCasStateObject(casState, true, null);
  return checked.ok ? hashCasStateOid(previousRefOid, checked.state) : null;
}

/** Computes the deterministic 64-hex SHA-256 head-binding lock for a CAS lease reservation. */
export function computeReservationHeadLock(repositoryId, issue, head, generation) {
  if (!positive(repositoryId) || !positive(issue) || !sha(head) || !positive(generation)) {
    return null;
  }
  const digest = createHash('sha256')
    .update(`sf-cas-head-lock:v1:${repositoryId}:${issue}:${head}:${generation}`, 'utf8')
    .digest('hex');
  return `00${digest.slice(0, 62)}`;
}

function computeHeadTag14(repositoryId, issue, head, generation) {
  return computeReservationHeadLock(repositoryId, issue, head, generation).slice(2, 16);
}

function computeArchiveDigestTag14(archivedList) {
  const canonicalArchive = JSON.stringify(archivedList.map(item => [item.workId, item.status]));
  return createHash('sha256')
    .update(`sf-cas-archive:v1:${canonicalArchive}`, 'utf8')
    .digest('hex')
    .slice(0, 14);
}

function computeLedgerDigestTag14(ledgerDigest) {
  return createHash('sha256')
    .update(`sf-cas-checkpoint:v1:${ledgerDigest}`, 'utf8')
    .digest('hex')
    .slice(0, 14);
}

function computeCheckpointTail28(archivedList, ledgerDigest) {
  return `${computeArchiveDigestTag14(archivedList)}${computeLedgerDigestTag14(ledgerDigest)}`;
}

function buildCheckpointedLock(
  prefix,
  reservedAiCredits,
  archivedChargedRuns,
  overwrittenRetryAttempts,
  overwrittenRetryCharged,
  headTag14,
  checkpointTail28
) {
  const creditsHex = reservedAiCredits.toString(16).padStart(8, '0');
  const archChgHex = archivedChargedRuns.toString(16).padStart(4, '0');
  const retryAttHex = overwrittenRetryAttempts.toString(16).padStart(4, '0');
  const retryChgHex = overwrittenRetryCharged.toString(16).padStart(4, '0');
  return `${prefix}${creditsHex}${archChgHex}${retryAttHex}${retryChgHex}${headTag14}${checkpointTail28}`;
}

function isCheckpointedCasLock(lockSha256) {
  return typeof lockSha256 === 'string' &&
    (lockSha256.startsWith('c1') || lockSha256.startsWith('c2'));
}

function parseCheckpointedCredits(lockSha256) {
  if (!isCheckpointedCasLock(lockSha256)) return 0;
  const parsed = Number.parseInt(lockSha256.slice(2, 10), 16);
  return parsed <= maxCreditCount ? parsed : 0;
}

function parseCheckpointedArchiveTotals(lockSha256) {
  return {
    archivedChargedRuns: Number.parseInt(lockSha256.slice(10, 14), 16),
    overwrittenRetryAttempts: Number.parseInt(lockSha256.slice(14, 18), 16),
    overwrittenRetryCharged: Number.parseInt(lockSha256.slice(18, 22), 16)
  };
}

function validateCloudAdmissionContract(admissionEvidence, plan, nowMs) {
  const required = [
    'includedOnly', 'overageDisabled', 'incrementalSpendUsdCents',
    'personalPatConfigured', 'repositoryVisibility', 'harness'
  ];
  const optional = [
    'stop', 'repositoryId', 'approvedRepositoryId', 'authorityVerified', 'entitlementVerified',
    'hardStopEnforced', 'observedMs', 'maxQuotaAgeMs', 'remainingIncludedUnits',
    'netOfReservationsVerified', 'ghAwCaps', 'agentLogin', 'sdkVersion', 'protocolV4ReleaseVerified'
  ];
  if (!plainRecord(admissionEvidence, required, optional) ||
      typeof admissionEvidence.includedOnly !== 'boolean' ||
      typeof admissionEvidence.overageDisabled !== 'boolean' ||
      !Number.isSafeInteger(admissionEvidence.incrementalSpendUsdCents) ||
      typeof admissionEvidence.personalPatConfigured !== 'boolean' ||
      !validVisibilities.has(admissionEvidence.repositoryVisibility) ||
      (admissionEvidence.stop !== undefined && typeof admissionEvidence.stop !== 'boolean') ||
      (admissionEvidence.authorityVerified !== undefined &&
        typeof admissionEvidence.authorityVerified !== 'boolean') ||
      (admissionEvidence.entitlementVerified !== undefined &&
        typeof admissionEvidence.entitlementVerified !== 'boolean') ||
      (admissionEvidence.hardStopEnforced !== undefined &&
        typeof admissionEvidence.hardStopEnforced !== 'boolean') ||
      (admissionEvidence.netOfReservationsVerified !== undefined &&
        typeof admissionEvidence.netOfReservationsVerified !== 'boolean') ||
      (admissionEvidence.protocolV4ReleaseVerified !== undefined &&
        typeof admissionEvidence.protocolV4ReleaseVerified !== 'boolean') ||
      (admissionEvidence.maxQuotaAgeMs !== undefined &&
        (!positive(admissionEvidence.maxQuotaAgeMs) ||
          admissionEvidence.maxQuotaAgeMs > maxAllowedQuotaAgeMs))) {
    return {ok: false, reason: 'INVALID_ADMISSION_EVIDENCE'};
  }
  if (admissionEvidence.stop === true) return {ok: false, reason: 'STOPPED'};
  if (admissionEvidence.personalPatConfigured !== false) {
    return {ok: false, reason: 'PERSONAL_PAT_FORBIDDEN'};
  }
  if (admissionEvidence.includedOnly !== true) {
    return {ok: false, reason: 'INCLUDED_ONLY_REQUIRED'};
  }
  if (admissionEvidence.overageDisabled !== true || admissionEvidence.hardStopEnforced !== true) {
    return {ok: false, reason: 'OVERAGE_HARD_STOP_REQUIRED'};
  }
  if (admissionEvidence.incrementalSpendUsdCents !== 0) {
    return {ok: false, reason: 'NONZERO_INCREMENTAL_SPEND'};
  }
  if (admissionEvidence.authorityVerified !== true || admissionEvidence.entitlementVerified !== true) {
    return {ok: false, reason: 'BILLING_AUTHORITY_UNVERIFIED'};
  }
  if (!positive(admissionEvidence.repositoryId) ||
      !positive(admissionEvidence.approvedRepositoryId) ||
      admissionEvidence.repositoryId !== admissionEvidence.approvedRepositoryId) {
    return {ok: false, reason: 'REPOSITORY_SCOPE_MISMATCH'};
  }
  if (!plan.repos.has(admissionEvidence.repositoryId)) {
    return {ok: false, reason: 'UNCONFIGURED_REPOSITORY'};
  }
  const quotaAgeLimit = admissionEvidence.maxQuotaAgeMs ?? defaultMaxQuotaAgeMs;
  if (!time(admissionEvidence.observedMs) ||
      admissionEvidence.observedMs > nowMs ||
      nowMs - admissionEvidence.observedMs > quotaAgeLimit) {
    return {ok: false, reason: 'STALE_ADMISSION_EVIDENCE'};
  }
  if (!count(admissionEvidence.remainingIncludedUnits, 10000000)) {
    return {ok: false, reason: 'BUDGET_UNKNOWN'};
  }

  let harnessKind;
  let agentLogin = admissionEvidence.agentLogin;
  let sdkVersion = admissionEvidence.sdkVersion;
  if (typeof admissionEvidence.harness === 'string') {
    harnessKind = admissionEvidence.harness;
  } else if (plainRecord(admissionEvidence.harness, ['kind', 'verified'], ['agentLogin', 'sdkVersion']) &&
      typeof admissionEvidence.harness.kind === 'string' &&
      typeof admissionEvidence.harness.verified === 'boolean') {
    if ((agentLogin !== undefined && admissionEvidence.harness.agentLogin !== undefined &&
          agentLogin !== admissionEvidence.harness.agentLogin) ||
        (sdkVersion !== undefined && admissionEvidence.harness.sdkVersion !== undefined &&
          sdkVersion !== admissionEvidence.harness.sdkVersion)) {
      return {ok: false, reason: 'INVALID_ADMISSION_EVIDENCE'};
    }
    if (!admissionEvidence.harness.verified) return {ok: false, reason: 'HARNESS_UNVERIFIED'};
    harnessKind = admissionEvidence.harness.kind;
    if (agentLogin === undefined) agentLogin = admissionEvidence.harness.agentLogin;
    if (sdkVersion === undefined) sdkVersion = admissionEvidence.harness.sdkVersion;
  } else {
    return {ok: false, reason: 'INVALID_ADMISSION_EVIDENCE'};
  }

  if (!SUPPORTED_CLOUD_HARNESSES.includes(harnessKind)) {
    return {ok: false, reason: 'UNSUPPORTED_PROVIDER_HARNESS'};
  }
  if (harnessKind === 'copilot-cloud-automation' &&
      !automationVisibilities.has(admissionEvidence.repositoryVisibility)) {
    return {ok: false, reason: 'AUTOMATION_REQUIRES_PRIVATE_REPO'};
  }
  if (agentLogin !== undefined &&
      (harnessKind !== 'copilot-cloud-agent' || agentLogin !== 'copilot-swe-agent[bot]')) {
    return {ok: false, reason: 'AGENT_IDENTITY_MISMATCH'};
  }
  if (harnessKind === 'copilot-sdk') {
    const verMatch = typeof sdkVersion === 'string' ? /^v?(\d+\.\d+\.\d+)$/.exec(sdkVersion) : null;
    if (!verMatch || verMatch[1] !== pinnedCopilotSdkVersion) {
      return {ok: false, reason: 'SDK_VERSION_MISMATCH'};
    }
  } else if (sdkVersion !== undefined) {
    return {ok: false, reason: 'INVALID_ADMISSION_EVIDENCE'};
  }

  let ghAwCaps = null;
  if (admissionEvidence.ghAwCaps !== undefined) {
    const caps = admissionEvidence.ghAwCaps;
    if (!plainRecord(caps, [
      'maxAiCredits', 'maxDailyAiCredits', 'dailyAiCreditsUsed', 'runAiCreditsRequired'
    ], ['dailyUsageIncludesReservations']) ||
        !positive(caps.maxAiCredits) || caps.maxAiCredits > maxCreditCount ||
        !positive(caps.maxDailyAiCredits) || caps.maxDailyAiCredits > maxCreditCount ||
        caps.maxDailyAiCredits < caps.maxAiCredits ||
        !count(caps.dailyAiCreditsUsed, maxCreditCount) ||
        !positive(caps.runAiCreditsRequired) || caps.runAiCreditsRequired > maxCreditCount ||
        (caps.dailyUsageIncludesReservations !== undefined &&
          typeof caps.dailyUsageIncludesReservations !== 'boolean')) {
      return {ok: false, reason: 'GH_AW_SOFT_CAPS_INVALID'};
    }
    if (caps.runAiCreditsRequired > caps.maxAiCredits) {
      return {ok: false, reason: 'GH_AW_MAX_AI_CREDITS_EXCEEDED'};
    }
    if (caps.dailyAiCreditsUsed > caps.maxDailyAiCredits) {
      return {ok: false, reason: 'GH_AW_DAILY_AI_CREDITS_EXCEEDED'};
    }
    ghAwCaps = caps;
  }

  return {
    ok: true,
    harnessKind,
    ghAwCaps,
    receipt: Object.freeze({
      includedOnly: true,
      overageDisabled: true,
      incrementalSpendUsdCents: 0,
      personalPatConfigured: false,
      harness: harnessKind,
      repositoryVisibility: admissionEvidence.repositoryVisibility
    })
  };
}

function validateObservedRunsList(rawObservedRuns) {
  if (rawObservedRuns === undefined) return {ok: true, byWorkId: new Map()};
  if (!denseDataArray(rawObservedRuns, maxCasEntries)) {
    return {ok: false, reason: 'INVALID_OBSERVED_RUNS'};
  }
  const byWorkId = new Map();
  for (let i = 0; i < rawObservedRuns.length; i++) {
    const obs = rawObservedRuns[i];
    if (!plainRecord(obs, ['workId', 'runId', 'runAttempt', 'leaseGeneration', 'runState'], ['conclusion']) ||
        typeof obs.workId !== 'string' || obs.workId.length === 0 ||
        !positive(obs.runId) || !positive(obs.runAttempt) || !positive(obs.leaseGeneration) ||
        !validObservedRunStates.has(obs.runState) || byWorkId.has(obs.workId)) {
      return {ok: false, reason: 'INVALID_OBSERVED_RUNS'};
    }
    if (obs.runState === 'run_terminal') {
      if (typeof obs.conclusion !== 'string' || !validRunConclusions.has(obs.conclusion)) {
        return {ok: false, reason: 'INVALID_OBSERVED_RUNS'};
      }
    } else if (obs.conclusion !== undefined) {
      return {ok: false, reason: 'INVALID_OBSERVED_RUNS'};
    }
    byWorkId.set(obs.workId, {
      workId: obs.workId,
      runId: obs.runId,
      runAttempt: obs.runAttempt,
      leaseGeneration: obs.leaseGeneration,
      runState: obs.runState,
      conclusion: obs.conclusion ?? null
    });
  }
  return {ok: true, byWorkId};
}

function isCasEntryActive(entry, nowMs) {
  return entry.status === 'leased' && entry.leaseExpiresAtMs > nowMs && entry.executionDeadlineMs > nowMs;
}

function auditCrossRunLedgerAccounting(
  workingLedgerRows,
  workingCasEntries,
  archivedList,
  allReceipts,
  _receiptsSaturated,
  checkpointArchiveTotals,
  unitsPerRun,
  pendingBindWorkId
) {
  let ledgerSpentUnits = 0;
  const remainingRowsByKey = new Map();
  const remainingChargedByKey = new Map();
  const activeRowGenByKey = new Map();
  const prWorkKeysInCas = new Set();

  for (const e of workingCasEntries) {
    if (e.targetType === 'pull_request') {
      prWorkKeysInCas.add(`${e.repositoryId}:pr:${e.pullNumber}:${e.headSha}`);
    }
  }
  for (const item of archivedList) {
    if (item.workId.includes(':pr:')) prWorkKeysInCas.add(item.workId);
  }

  for (const r of workingLedgerRows) {
    const exactPrKey = `${r.repositoryId}:pr:${r.issue}:${r.head}`;
    const bucketKey = prWorkKeysInCas.has(exactPrKey)
      ? exactPrKey
      : `${r.repositoryId}:issue:${r.issue}`;
    remainingRowsByKey.set(bucketKey, (remainingRowsByKey.get(bucketKey) ?? 0) + 1);
    if (r.phase === 'reserved' || r.phase === 'in-flight') {
      activeRowGenByKey.set(bucketKey, r.generation);
    }
    if (r.phase !== 'cancelled') {
      ledgerSpentUnits += r.units;
      remainingChargedByKey.set(bucketKey, (remainingChargedByKey.get(bucketKey) ?? 0) + 1);
    }
  }

  const minArchivedAttemptsByWorkId = new Map();
  for (const rec of allReceipts) {
    const implied = rec.outcome === 'requeued' ? rec.attempts + 1 : rec.attempts;
    const prev = minArchivedAttemptsByWorkId.get(rec.workId) ?? 1;
    if (implied > prev) minArchivedAttemptsByWorkId.set(rec.workId, implied);
  }

  let entryMissingRowsTotal = 0;
  let archivedMissingRowsTotal = 0;
  let unaccountedEntryChargedRuns = 0;
  let unaccountedArchivedChargedRuns = 0;
  let unaccountedActivePeerRuns = 0;
  let missingActiveLeaseRow = false;
  const consumeBucket = (bucketKey, requiredRows, requiredCharged, isArchived) => {
    const availRows = remainingRowsByKey.get(bucketKey) ?? 0;
    const usedRows = Math.min(requiredRows, availRows);
    const missingRows = requiredRows - usedRows;
    if (isArchived) archivedMissingRowsTotal += missingRows;
    else entryMissingRowsTotal += missingRows;
    remainingRowsByKey.set(bucketKey, availRows - usedRows);

    const availCharged = remainingChargedByKey.get(bucketKey) ?? 0;
    const consumedCharged = Math.min(usedRows, availCharged);
    remainingChargedByKey.set(bucketKey, availCharged - consumedCharged);
    const missingCharged = Math.min(missingRows, requiredCharged);
    if (isArchived) unaccountedArchivedChargedRuns += missingCharged;
    else unaccountedEntryChargedRuns += missingCharged;
    return {availRows, availCharged};
  };

  let missingDistinctPrKey = false;
  for (const e of workingCasEntries) {
    const isPendingBind = e.workId === pendingBindWorkId;
    const isUnboundActivePeer = !isPendingBind && e.status === 'leased' &&
      activeRowGenByKey.get(e.workId) !== e.generation;
    const requiredRows = isPendingBind || isUnboundActivePeer ? e.attempts - 1 : e.attempts;
    const requiredCharged = isPendingBind || isUnboundActivePeer || e.status === 'cancelled'
      ? e.attempts - 1
      : e.attempts;
    if (isUnboundActivePeer) {
      missingActiveLeaseRow = true;
      unaccountedEntryChargedRuns += 1;
      unaccountedActivePeerRuns += 1;
    }
    if (e.targetType === 'pull_request' && !isPendingBind &&
        (remainingRowsByKey.get(e.workId) ?? 0) === 0) {
      missingDistinctPrKey = true;
    }
    consumeBucket(e.workId, requiredRows, requiredCharged, false);
  }

  let archivedPresentItems = 0;
  let archivedLedgerChargedTotal = 0;
  let inferredArchivedChargedTotal = 0;

  for (const item of archivedList) {
    if (item.workId.includes(':pr:') && (remainingRowsByKey.get(item.workId) ?? 0) === 0) {
      missingDistinctPrKey = true;
    }
    const minAttempts = minArchivedAttemptsByWorkId.get(item.workId) ?? 1;
    const minCharged = item.status === 'cancelled' ? minAttempts - 1 : minAttempts;
    inferredArchivedChargedTotal += minCharged;
    const {availRows, availCharged} = consumeBucket(item.workId, minAttempts, minCharged, true);
    if (availRows > 0) archivedPresentItems += 1;
    archivedLedgerChargedTotal += availCharged;
  }

  let incomplete;
  let authoritativeSpentUnits;
  if (checkpointArchiveTotals !== null) {
    // Each archived item retains at least its latest replacement row in workingLedgerRows, while
    // overwritten same-head retry charges stay durably counted in overwrittenRetryCharged.
    incomplete = missingDistinctPrKey ||
      missingActiveLeaseRow ||
      archivedPresentItems < archivedList.length ||
      entryMissingRowsTotal !== checkpointArchiveTotals.overwrittenRetryAttempts ||
      archivedLedgerChargedTotal < checkpointArchiveTotals.archivedChargedRuns;
    const extraArchivedCharged = Math.max(
      0,
      checkpointArchiveTotals.archivedChargedRuns - archivedLedgerChargedTotal
    );
    authoritativeSpentUnits = ledgerSpentUnits +
      (unaccountedActivePeerRuns + checkpointArchiveTotals.overwrittenRetryCharged + extraArchivedCharged) *
        unitsPerRun;
  } else {
    incomplete = missingDistinctPrKey || missingActiveLeaseRow ||
      entryMissingRowsTotal > 0 || archivedMissingRowsTotal > 0;
    authoritativeSpentUnits = ledgerSpentUnits +
      (unaccountedEntryChargedRuns + unaccountedArchivedChargedRuns) * unitsPerRun;
  }

  return {
    incomplete,
    prWorkKeysInCas,
    authoritativeSpentUnits,
    unaccountedActivePeerUnits: unaccountedActivePeerRuns * unitsPerRun,
    archivedChargedRuns: checkpointArchiveTotals !== null
      ? checkpointArchiveTotals.archivedChargedRuns
      : Math.max(archivedLedgerChargedTotal, inferredArchivedChargedTotal),
    overwrittenRetryAttempts: checkpointArchiveTotals !== null
      ? checkpointArchiveTotals.overwrittenRetryAttempts
      : 0,
    overwrittenRetryCharged: checkpointArchiveTotals !== null
      ? checkpointArchiveTotals.overwrittenRetryCharged
      : 0
  };
}

function cloneMutableCasEntry(entry, overrides = {}) {
  const next = {...entry, ownedPaths: [...entry.ownedPaths], ...overrides};
  if (entry.priorRuns !== undefined) {
    next.priorRuns = entry.priorRuns.map(item => ({runId: item.runId, runAttempt: item.runAttempt}));
  }
  return next;
}

const denyCasReconcile = (reason, extra = {}) => Object.freeze({
  shadow: true,
  liveDispatch: false,
  liveMerge: false,
  ok: false,
  reconciled: false,
  reason,
  ...extra
});

/**
 * Pure, deterministic, fail-closed cross-run reservation fencing & reconciliation
 * binding signed shadow-dispatch-ledger snapshots to refs/heads/work-queue CAS state
 * and Issue #105's $0 paid-overage hard-stop & native GitHub Cloud Agent contract.
 */
export function reconcileLedgerWithWorkQueueCas(input) {
  const required = [
    'ledgerSnapshot', 'signingKey', 'casState', 'expectedRefOid', 'admissionEvidence', 'nowMs'
  ];
  const optional = [
    'stop', 'force', 'targetRef', 'actualRefOid', 'previousRefOid',
    'protocolV4ReleaseVerified', 'requestedProtocol', 'fixturePlan',
    'minSnapshotSequence', 'maxSnapshotAgeMs', 'observedRuns', 'candidate'
  ];
  if (!plainRecord(input, required, optional) || !time(input.nowMs) ||
      (input.stop !== undefined && typeof input.stop !== 'boolean') ||
      (input.protocolV4ReleaseVerified !== undefined &&
        typeof input.protocolV4ReleaseVerified !== 'boolean') ||
      (input.requestedProtocol !== undefined && typeof input.requestedProtocol !== 'string')) {
    return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
  }
  if (input.stop === true) return denyCasReconcile('STOPPED');
  if (input.force === true) return denyCasReconcile('FORCE_UPDATE_FORBIDDEN');
  if (input.force !== undefined && input.force !== false) {
    return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
  }
  const targetRef = input.targetRef ?? PROTECTED_WORK_QUEUE_REF;
  if (typeof targetRef !== 'string') return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
  if (targetRef !== PROTECTED_WORK_QUEUE_REF) return denyCasReconcile('UNPROTECTED_WORK_QUEUE_REF');
  if (!sha(input.expectedRefOid)) return denyCasReconcile('INVALID_EXPECTED_REF_OID');
  if (input.actualRefOid !== undefined && !sha(input.actualRefOid)) {
    return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
  }
  if (input.previousRefOid !== undefined && !sha(input.previousRefOid)) {
    return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
  }

  const snapshotOpts = {signingKey: input.signingKey, nowMs: input.nowMs};
  if (input.fixturePlan !== undefined) snapshotOpts.fixturePlan = input.fixturePlan;
  if (input.minSnapshotSequence !== undefined) snapshotOpts.minSequence = input.minSnapshotSequence;
  if (input.maxSnapshotAgeMs !== undefined) snapshotOpts.maxSnapshotAgeMs = input.maxSnapshotAgeMs;
  const verifiedLedger = verifySignedLedgerSnapshot(input.ledgerSnapshot, snapshotOpts);
  if (!verifiedLedger.ok) return denyCasReconcile(verifiedLedger.reason);
  const {plan} = verifiedLedger;

  const admission = validateCloudAdmissionContract(input.admissionEvidence, plan, input.nowMs);
  if (!admission.ok) return denyCasReconcile(admission.reason);

  const topV4 = input.protocolV4ReleaseVerified;
  const admV4 = input.admissionEvidence.protocolV4ReleaseVerified;
  if (topV4 !== undefined && admV4 !== undefined && topV4 !== admV4) {
    return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
  }
  const v4Verified = topV4 === true || admV4 === true;

  let rawQueueState;
  let observedRefOid;
  if (input.casState === null) {
    if (input.previousRefOid !== undefined) return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
    if (input.actualRefOid !== undefined && input.actualRefOid !== ZERO_GIT_OID) {
      return denyCasReconcile('INVALID_QUEUE_STATE');
    }
    const emptyProto = input.requestedProtocol ?? 'v3';
    if (emptyProto === 'v4') {
      if (!v4Verified) return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
    } else if (emptyProto !== 'v3') {
      return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
    }
    rawQueueState = freezeCasStateShape(emptyProto, 0, 1, [], [], []);
    observedRefOid = ZERO_GIT_OID;
  } else if (plainRecord(input.casState, ['ref', 'oid', 'state'], ['ok'])) {
    if (input.previousRefOid !== undefined) return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
    if (input.casState.ok !== undefined && input.casState.ok !== true) {
      return denyCasReconcile('REF_STORE_UNAVAILABLE');
    }
    if (input.casState.ref !== PROTECTED_WORK_QUEUE_REF) {
      return denyCasReconcile('UNPROTECTED_WORK_QUEUE_REF');
    }
    if (!sha(input.casState.oid)) return denyCasReconcile('INVALID_QUEUE_STATE');
    if (input.actualRefOid !== undefined && input.actualRefOid !== input.casState.oid) {
      return denyCasReconcile('CAS_CONFLICT', {
        expectedRefOid: input.expectedRefOid,
        actualRefOid: input.casState.oid
      });
    }
    observedRefOid = input.casState.oid;
    if (input.casState.state === null) {
      if (observedRefOid !== ZERO_GIT_OID) return denyCasReconcile('INVALID_QUEUE_STATE');
      const emptyProto = input.requestedProtocol ?? 'v3';
      if (emptyProto === 'v4') {
        if (!v4Verified) return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
      } else if (emptyProto !== 'v3') {
        return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
      }
      rawQueueState = freezeCasStateShape(emptyProto, 0, 1, [], [], []);
    } else {
      const checked = validateCasStateObject(input.casState.state, v4Verified, input.nowMs);
      if (!checked.ok) return denyCasReconcile(checked.reason);
      if (input.requestedProtocol !== undefined && input.requestedProtocol !== checked.state.protocol) {
        return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
      }
      rawQueueState = checked.state;
    }
  } else {
    if (input.actualRefOid !== undefined && input.previousRefOid !== undefined) {
      return denyCasReconcile('INVALID_RECONCILE_OPTIONS');
    }
    const checked = validateCasStateObject(input.casState, v4Verified, input.nowMs);
    if (!checked.ok) return denyCasReconcile(checked.reason);
    if (input.requestedProtocol !== undefined && input.requestedProtocol !== checked.state.protocol) {
      return denyCasReconcile('UNVERIFIED_QUEUE_PROTOCOL');
    }
    rawQueueState = checked.state;
    observedRefOid = input.actualRefOid ?? hashCasStateOid(input.previousRefOid ?? ZERO_GIT_OID, rawQueueState);
  }

  if (input.expectedRefOid !== observedRefOid) {
    return denyCasReconcile('CAS_CONFLICT', {
      expectedRefOid: input.expectedRefOid,
      actualRefOid: observedRefOid
    });
  }

  const obsCheck = validateObservedRunsList(input.observedRuns);
  if (!obsCheck.ok) return denyCasReconcile(obsCheck.reason);

  const nowMs = input.nowMs;
  let nextGeneration = rawQueueState.nextGeneration;
  const workingCasEntries = [];
  const newCasReceipts = [];
  const skippedRunObservations = [];
  const casTransitionMeta = new Map();

  for (const entry of rawQueueState.entries) {
    const obs = obsCheck.byWorkId.get(entry.workId);
    if (obs !== undefined) {
      const matchesLease = entry.status === 'leased' &&
        entry.runId === obs.runId &&
        entry.runAttempt === obs.runAttempt &&
        entry.generation === obs.leaseGeneration;
      if (!matchesLease) {
        skippedRunObservations.push(Object.freeze({
          workId: entry.workId,
          runId: obs.runId,
          runAttempt: obs.runAttempt,
          leaseGeneration: obs.leaseGeneration,
          reason: 'STALE_OR_INACTIVE_RUN'
        }));
      } else {
        const leaseStillActive = isCasEntryActive(entry, nowMs);
        const terminalSuccess = obs.runState === 'run_terminal' && obs.conclusion === 'success';
        if (leaseStillActive || !terminalSuccess) {
          const reclaimedGeneration = nextGeneration++;
          const outcome = (leaseStillActive && terminalSuccess)
            ? 'completed'
            : (entry.attempts >= entry.maxAttempts ? 'exhausted' : 'requeued');
          workingCasEntries.push(cloneMutableCasEntry(entry, {
            status: outcome,
            generation: reclaimedGeneration,
            leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, nowMs)
          }));
          newCasReceipts.push({
            workId: entry.workId,
            repositoryId: entry.repositoryId,
            targetType: entry.targetType,
            runState: obs.runState,
            conclusion: obs.conclusion,
            previousRunId: entry.runId,
            previousRunAttempt: entry.runAttempt,
            previousGeneration: entry.generation,
            reclaimedGeneration,
            attempts: entry.attempts,
            maxAttempts: entry.maxAttempts,
            outcome,
            reclaimedAtMs: nowMs
          });
          casTransitionMeta.set(entry.workId, {
            kind: 'observed_run',
            previousGeneration: entry.generation,
            outcome,
            conclusion: obs.conclusion
          });
          continue;
        }
      }
    }

    if (entry.status === 'leased' && !isCasEntryActive(entry, nowMs)) {
      const reclaimedGeneration = nextGeneration++;
      const outcome = entry.attempts >= entry.maxAttempts ? 'exhausted' : 'requeued';
      workingCasEntries.push(cloneMutableCasEntry(entry, {
        status: outcome,
        generation: reclaimedGeneration,
        leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, nowMs)
      }));
      newCasReceipts.push({
        workId: entry.workId,
        repositoryId: entry.repositoryId,
        targetType: entry.targetType,
        runState: 'lease_expired',
        conclusion: null,
        previousRunId: entry.runId,
        previousRunAttempt: entry.runAttempt,
        previousGeneration: entry.generation,
        reclaimedGeneration,
        attempts: entry.attempts,
        maxAttempts: entry.maxAttempts,
        outcome,
        reclaimedAtMs: nowMs
      });
      casTransitionMeta.set(entry.workId, {
        kind: 'lease_expired',
        previousGeneration: entry.generation,
        outcome,
        conclusion: null
      });
      continue;
    }

    workingCasEntries.push(cloneMutableCasEntry(entry));
  }

  for (const [workId, obs] of obsCheck.byWorkId.entries()) {
    if (!rawQueueState.entries.some(item => item.workId === workId)) {
      skippedRunObservations.push(Object.freeze({
        workId,
        runId: obs.runId,
        runAttempt: obs.runAttempt,
        leaseGeneration: obs.leaseGeneration,
        reason: 'UNKNOWN_WORK_ID'
      }));
    }
  }

  // refs/heads/work-queue is strictly single-repository: reject cross-repo CAS entries, archives, or receipts,
  // and enforce queue-wide active lane, subject, and ownedPaths isolation (matching work-queue-cas.mjs).
  const admissionRepoId = input.admissionEvidence.repositoryId;
  const admissionWorkPrefix = `${admissionRepoId}:`;
  const archivedList = [...(rawQueueState.archivedTerminal ?? [])];
  if (workingCasEntries.some(e => e.repositoryId !== admissionRepoId) ||
      archivedList.some(item => !item.workId.startsWith(admissionWorkPrefix)) ||
      rawQueueState.recoveryReceipts.some(
        rec => rec.repositoryId !== admissionRepoId || !rec.workId.startsWith(admissionWorkPrefix)
      )) {
    return denyCasReconcile('CROSS_REPO_CAS_STATE_REJECTED');
  }

  const activeCasLanes = new Set();
  const activeCasSubjects = new Set();
  const activeCasPaths = [];
  const issueCasByKey = new Map();
  const prCasByKey = new Map();
  const prActiveBySubject = new Map();
  for (const entry of workingCasEntries) {
    if (entry.targetType === 'issue') {
      issueCasByKey.set(`${entry.repositoryId}:${entry.issueNumber}`, entry);
    } else {
      prCasByKey.set(`${entry.repositoryId}:${entry.pullNumber}:${entry.headSha}`, entry);
    }
    if (!isCasEntryActive(entry, nowMs)) continue;
    if (entry.targetType === 'pull_request') {
      prActiveBySubject.set(`${entry.repositoryId}:${entry.pullNumber}`, entry);
    }
    const subjectNum = entry.targetType === 'issue' ? entry.issueNumber : entry.pullNumber;
    if (activeCasLanes.has(entry.lane) || activeCasSubjects.has(subjectNum) ||
        entry.ownedPaths.some(p => activeCasPaths.some(ap => pathsOverlap(p, ap)))) {
      return denyCasReconcile('ACTIVE_CAS_LEASE_CONFLICT');
    }
    activeCasLanes.add(entry.lane);
    activeCasSubjects.add(subjectNum);
    activeCasPaths.push(...entry.ownedPaths);
  }

  const archivedByWorkId = new Map(archivedList.map(item => [item.workId, item.status]));

  // Reconcile signed ledger snapshot rows against fenced CAS entries.
  let reclaimedExpiredCount = newCasReceipts.filter(r => r.runState === 'lease_expired').length;
  let releasedOrphanCount = newCasReceipts.length - reclaimedExpiredCount;
  let ledgerMutated = false;
  const reconciledActions = [];
  const workingLedgerRows = [];

  for (const row of verifiedLedger.snapshot.reservations) {
    if (row.phase !== 'reserved' && row.phase !== 'in-flight') {
      workingLedgerRows.push({...row});
      continue;
    }
    const prKey = `${row.repositoryId}:${row.issue}:${row.head}`;
    const issueKey = `${row.repositoryId}:${row.issue}`;
    const matchingCas = prCasByKey.get(prKey) ?? issueCasByKey.get(issueKey) ?? null;
    const activePrOnSubject = prActiveBySubject.get(issueKey) ?? null;

    if (row.generation >= nextGeneration ||
        (matchingCas !== null && row.generation > matchingCas.generation)) {
      return denyCasReconcile('STALE_LEASE_GENERATION');
    }

    if (row.validThrough < nowMs) {
      const toPhase = row.phase === 'reserved' ? 'cancelled' : 'expired';
      workingLedgerRows.push({...row, phase: toPhase});
      ledgerMutated = true;
      if (matchingCas === null || casTransitionMeta.get(matchingCas.workId)?.kind !== 'lease_expired') {
        reclaimedExpiredCount++;
      }
      reconciledActions.push(Object.freeze({
        repositoryId: row.repositoryId,
        issue: row.issue,
        head: row.head,
        generation: row.generation,
        fromPhase: row.phase,
        toPhase,
        trigger: 'ledger_ttl_expired'
      }));
      continue;
    }

    if (matchingCas !== null && isCasEntryActive(matchingCas, nowMs) &&
        matchingCas.generation === row.generation) {
      workingLedgerRows.push({...row});
      continue;
    }

    const meta = matchingCas !== null ? casTransitionMeta.get(matchingCas.workId) : undefined;
    const archivedStatus = archivedByWorkId.get(`${row.repositoryId}:pr:${row.issue}:${row.head}`) ??
      archivedByWorkId.get(`${row.repositoryId}:issue:${row.issue}`) ?? null;
    let trigger;
    if (meta?.kind === 'lease_expired') {
      trigger = 'cas_lease_expired';
    } else if (meta?.kind === 'observed_run') {
      trigger = 'orphan_terminal_run';
    } else if ((matchingCas !== null && matchingCas.generation > row.generation &&
          isCasEntryActive(matchingCas, nowMs)) ||
        (activePrOnSubject !== null && activePrOnSubject.generation > row.generation)) {
      trigger = 'superseded_generation';
      releasedOrphanCount++;
    } else if (matchingCas !== null || archivedStatus !== null) {
      trigger = 'orphan_terminal_run';
      releasedOrphanCount++;
    } else {
      trigger = 'unbacked_reservation';
      releasedOrphanCount++;
    }

    const completedCleanly = (matchingCas !== null && matchingCas.status === 'completed' &&
        (meta === undefined || meta.previousGeneration === row.generation)) ||
      archivedStatus === 'completed';
    const cancelledCleanly = (matchingCas !== null && matchingCas.status === 'cancelled') ||
      archivedStatus === 'cancelled' || meta?.conclusion === 'cancelled';

    const toPhase = row.phase === 'reserved'
      ? 'cancelled'
      : ((completedCleanly || cancelledCleanly) ? 'settled' : 'expired');

    workingLedgerRows.push({...row, phase: toPhase});
    ledgerMutated = true;
    reconciledActions.push(Object.freeze({
      repositoryId: row.repositoryId,
      issue: row.issue,
      head: row.head,
      generation: row.generation,
      fromPhase: row.phase,
      toPhase,
      trigger
    }));
  }

  // Verify surviving active union (ledger + CAS) stays within per-repository and global concurrency caps.
  const survivingActiveSet = new Set();
  const survivingRepoCounts = new Map();
  const recordActiveSubject = (repoId, subj) => {
    const key = `${repoId}:${subj}`;
    if (survivingActiveSet.has(key)) return;
    survivingActiveSet.add(key);
    survivingRepoCounts.set(repoId, (survivingRepoCounts.get(repoId) ?? 0) + 1);
  };
  for (const r of workingLedgerRows) {
    if (r.phase === 'reserved' || r.phase === 'in-flight') {
      recordActiveSubject(r.repositoryId, r.issue);
    }
  }
  for (const e of workingCasEntries) {
    if (!isCasEntryActive(e, nowMs)) continue;
    recordActiveSubject(e.repositoryId, e.targetType === 'issue' ? e.issueNumber : e.pullNumber);
  }
  if (survivingActiveSet.size > plan.maxActive) {
    return denyCasReconcile('CAPACITY_EXHAUSTED');
  }
  for (const [repoId, activeCount] of survivingRepoCounts.entries()) {
    if (activeCount > plan.repos.get(repoId)) {
      return denyCasReconcile('REPO_CAPACITY_EXHAUSTED');
    }
  }

  // Verify any CAS checkpoint locks bind both canonical archivedTerminal membership ([36..50)) and
  // incoming signed ledgerSnapshot.digest ([50..64)), and agree on cumulative archive totals.
  const incomingArchiveTag14 = computeArchiveDigestTag14(archivedList);
  const incomingLedgerTag14 = computeLedgerDigestTag14(verifiedLedger.snapshot.digest);
  const checkpointedEntries = rawQueueState.entries.filter(e => isCheckpointedCasLock(e.lockSha256));
  let checkpointArchiveTotals = null;
  let archiveCheckpointMismatch = false;
  let checkpointMismatch = false;
  for (const e of checkpointedEntries) {
    if (e.lockSha256.slice(36, 50) !== incomingArchiveTag14) {
      archiveCheckpointMismatch = true;
      break;
    }
    const totals = parseCheckpointedArchiveTotals(e.lockSha256);
    if (checkpointArchiveTotals === null) {
      checkpointArchiveTotals = totals;
    } else if (checkpointArchiveTotals.archivedChargedRuns !== totals.archivedChargedRuns ||
        checkpointArchiveTotals.overwrittenRetryAttempts !== totals.overwrittenRetryAttempts ||
        checkpointArchiveTotals.overwrittenRetryCharged !== totals.overwrittenRetryCharged) {
      archiveCheckpointMismatch = true;
      break;
    }
    if (e.lockSha256.slice(50, 64) !== incomingLedgerTag14) {
      checkpointMismatch = true;
    }
  }
  const receiptsSaturated = rawQueueState.recoveryReceipts.length >= maxCasReceipts;
  if (archivedList.length > 0 && receiptsSaturated && checkpointArchiveTotals === null) {
    archiveCheckpointMismatch = true;
  }
  if (archiveCheckpointMismatch) {
    return denyCasReconcile('COMPACTED_ARCHIVE_CHECKPOINT_MISMATCH');
  }
  const combinedReceipts = [...rawQueueState.recoveryReceipts, ...newCasReceipts];

  if (input.candidate !== undefined) {
    const candReq = ['repositoryId', 'issue', 'head', 'generation'];
    const candOpt = [
      'targetType', 'phase', 'repository', 'lane', 'ownedPaths',
      'workerId', 'runId', 'runAttempt', 'leaseTtlMs', 'maxExecutionMs',
      'maxAttempts', 'traceparent', 'lockSha256'
    ];
    if (!plainRecord(input.candidate, candReq, candOpt) ||
        !positive(input.candidate.repositoryId) || !positive(input.candidate.issue) ||
        !sha(input.candidate.head) || !positive(input.candidate.generation)) {
      return denyCasReconcile('INVALID_CANDIDATE');
    }
    const cand = input.candidate;
    if (!plan.repos.has(cand.repositoryId)) return denyCasReconcile('UNCONFIGURED_REPOSITORY');
    if (cand.repositoryId !== input.admissionEvidence.repositoryId) {
      return denyCasReconcile('REPOSITORY_SCOPE_MISMATCH');
    }
    const targetType = cand.targetType ?? 'issue';
    if (targetType !== 'issue' && targetType !== 'pull_request') {
      return denyCasReconcile('INVALID_CANDIDATE');
    }
    const desiredPhase = cand.phase ?? 'reserved';
    if (desiredPhase !== 'reserved' && desiredPhase !== 'in-flight') {
      return denyCasReconcile('INVALID_CANDIDATE');
    }
    if (cand.leaseTtlMs !== undefined) {
      if (!Number.isSafeInteger(cand.leaseTtlMs) || cand.leaseTtlMs <= 0) {
        return denyCasReconcile('INVALID_CANDIDATE');
      }
      if (cand.leaseTtlMs > MAX_CROSS_RUN_LEASE_TTL_MS) return denyCasReconcile('LEASE_TTL_EXCEEDED');
    }
    if (cand.maxExecutionMs !== undefined) {
      if (!Number.isSafeInteger(cand.maxExecutionMs) || cand.maxExecutionMs <= 0) {
        return denyCasReconcile('INVALID_CANDIDATE');
      }
      if (cand.maxExecutionMs > MAX_CROSS_RUN_LEASE_TTL_MS || cand.maxExecutionMs > plan.maxExecutionMs) {
        return denyCasReconcile('LEASE_TTL_EXCEEDED');
      }
      if (cand.leaseTtlMs !== undefined && cand.maxExecutionMs < cand.leaseTtlMs) {
        return denyCasReconcile('INVALID_CANDIDATE');
      }
    }
    if ((cand.repository !== undefined && !repoSlugValid(cand.repository)) ||
        (cand.lane !== undefined && !laneIdValid(cand.lane)) ||
        (cand.ownedPaths !== undefined && !pathSetValid(cand.ownedPaths)) ||
        (cand.workerId !== undefined && !workerIdValid(cand.workerId)) ||
        (cand.runId !== undefined && !positive(cand.runId)) ||
        (cand.runAttempt !== undefined && !positive(cand.runAttempt)) ||
        (cand.maxAttempts !== undefined &&
          (!Number.isSafeInteger(cand.maxAttempts) || cand.maxAttempts < 1 || cand.maxAttempts > 5)) ||
        (cand.traceparent !== undefined && !traceparentValid(cand.traceparent)) ||
        (cand.lockSha256 !== undefined && !hex64(cand.lockSha256))) {
      return denyCasReconcile('INVALID_CANDIDATE');
    }

    const workId = targetType === 'issue'
      ? `${cand.repositoryId}:issue:${cand.issue}`
      : `${cand.repositoryId}:pr:${cand.issue}:${cand.head}`;
    const existingLedgerIdx = workingLedgerRows.findIndex(r =>
      r.repositoryId === cand.repositoryId && r.issue === cand.issue && r.head === cand.head);
    const existingLedgerRow = existingLedgerIdx >= 0 ? workingLedgerRows[existingLedgerIdx] : null;
    const isPhaseAdvance = existingLedgerRow !== null &&
      existingLedgerRow.phase === 'reserved' &&
      desiredPhase === 'in-flight' &&
      existingLedgerRow.generation === cand.generation;
    const isSameHeadRetry = existingLedgerRow !== null &&
      (existingLedgerRow.phase === 'cancelled' || existingLedgerRow.phase === 'expired') &&
      cand.generation > existingLedgerRow.generation;

    if (existingLedgerRow !== null && !isPhaseAdvance && !isSameHeadRetry) {
      if (cand.generation < existingLedgerRow.generation ||
          ((existingLedgerRow.phase === 'cancelled' || existingLedgerRow.phase === 'expired') &&
            cand.generation <= existingLedgerRow.generation)) {
        return denyCasReconcile('STALE_LEASE_GENERATION');
      }
      return denyCasReconcile('DUPLICATE_RESERVATION');
    }

    // Reject if another head on the same (repositoryId, issue) is still active, or if candidate generation regresses.
    let maxPriorIssueGen = 0;
    for (const r of workingLedgerRows) {
      if (r.repositoryId !== cand.repositoryId || r.issue !== cand.issue) continue;
      if (!isPhaseAdvance && (r.phase === 'reserved' || r.phase === 'in-flight')) {
        return denyCasReconcile('DUPLICATE_RESERVATION');
      }
      if (!isPhaseAdvance && r.generation > maxPriorIssueGen) maxPriorIssueGen = r.generation;
    }
    if (!isPhaseAdvance && cand.generation <= maxPriorIssueGen) {
      return denyCasReconcile('STALE_LEASE_GENERATION');
    }

    for (const rec of combinedReceipts) {
      if (rec.workId === workId && cand.generation <= rec.reclaimedGeneration) {
        return denyCasReconcile('STALE_LEASE_GENERATION');
      }
    }

    const archivedMatch = archivedByWorkId.get(workId);
    if (archivedMatch !== undefined) {
      return denyCasReconcile(
        archivedMatch === 'exhausted' ? 'RETRY_CEILING_EXHAUSTED' : 'DUPLICATE_RESERVATION'
      );
    }

    const casIdx = workingCasEntries.findIndex(e => e.workId === workId);
    const casEntry = casIdx >= 0 ? workingCasEntries[casIdx] : null;
    const isBindingActiveLease = casEntry !== null && isCasEntryActive(casEntry, nowMs);
    const expectedHeadLock = computeReservationHeadLock(
      cand.repositoryId,
      cand.issue,
      cand.head,
      cand.generation
    );
    const candHeadTag14 = computeHeadTag14(
      cand.repositoryId,
      cand.issue,
      cand.head,
      cand.generation
    );
    const alreadyLedgerBoundInCas = isBindingActiveLease && isCheckpointedCasLock(casEntry.lockSha256);
    const preAudit = auditCrossRunLedgerAccounting(
      workingLedgerRows,
      workingCasEntries,
      archivedList,
      combinedReceipts,
      receiptsSaturated,
      checkpointArchiveTotals,
      plan.unitsPerRun,
      isBindingActiveLease && !isPhaseAdvance && !alreadyLedgerBoundInCas ? workId : null
    );
    let activeTargetCasIdx;
    let activeTargetLockPrefix;
    let existingTargetCredits = 0;
    let nextArchivedChargedRuns = preAudit.archivedChargedRuns;
    let nextOverwrittenRetryAttempts = preAudit.overwrittenRetryAttempts;
    let nextOverwrittenRetryCharged = preAudit.overwrittenRetryCharged;
    let boundCasEntry;

    if (isBindingActiveLease) {
      if (cand.generation < casEntry.generation) return denyCasReconcile('STALE_LEASE_GENERATION');
      if (cand.generation > casEntry.generation) return denyCasReconcile('DUPLICATE_RESERVATION');
      const pathsMatch = cand.ownedPaths === undefined ||
        (cand.ownedPaths.length === casEntry.ownedPaths.length &&
          cand.ownedPaths.every(p => casEntry.ownedPaths.includes(p)));
      if (cand.workerId === undefined || cand.workerId !== casEntry.workerId ||
          cand.runId === undefined || cand.runId !== casEntry.runId ||
          cand.runAttempt === undefined || cand.runAttempt !== casEntry.runAttempt ||
          (cand.repository !== undefined && cand.repository !== casEntry.repository) ||
          (cand.lane !== undefined && cand.lane !== casEntry.lane) ||
          !pathsMatch) {
        return denyCasReconcile('LEASE_OWNER_MISMATCH');
      }
      if (cand.lockSha256 !== undefined && cand.lockSha256 !== expectedHeadLock) {
        return denyCasReconcile('HEAD_BINDING_MISMATCH');
      }
      if (alreadyLedgerBoundInCas) {
        if (casEntry.lockSha256.slice(22, 36) !== candHeadTag14) {
          return denyCasReconcile('HEAD_BINDING_MISMATCH');
        }
        if (!isPhaseAdvance || casEntry.lockSha256.startsWith('c2') || checkpointMismatch) {
          return denyCasReconcile('STALE_OR_INCOMPLETE_LEDGER');
        }
        existingTargetCredits = parseCheckpointedCredits(casEntry.lockSha256);
      } else {
        const validPreBindLock = targetType === 'pull_request'
          ? (casEntry.lockSha256 === undefined || casEntry.lockSha256 === expectedHeadLock)
          : casEntry.lockSha256 === expectedHeadLock;
        if (!validPreBindLock) {
          return denyCasReconcile('HEAD_BINDING_MISMATCH');
        }
      }
      if (checkpointMismatch || preAudit.incomplete) {
        return denyCasReconcile('STALE_OR_INCOMPLETE_LEDGER');
      }
      activeTargetCasIdx = casIdx;
      activeTargetLockPrefix = desiredPhase === 'reserved' ? 'c1' : 'c2';
      boundCasEntry = casEntry;
    } else {
      if (casEntry !== null) {
        if (casEntry.status === 'completed' || casEntry.status === 'cancelled') {
          return denyCasReconcile('DUPLICATE_RESERVATION');
        }
        if (cand.generation <= casEntry.generation) {
          return denyCasReconcile('STALE_LEASE_GENERATION');
        }
      }
      if (activeCasSubjects.has(cand.issue)) {
        return denyCasReconcile('DUPLICATE_RESERVATION');
      }
      const hasClaimSpec = cand.repository !== undefined && cand.lane !== undefined &&
        cand.ownedPaths !== undefined && cand.workerId !== undefined &&
        cand.runId !== undefined && cand.leaseTtlMs !== undefined;
      if (!hasClaimSpec) return denyCasReconcile('CAS_LEASE_REQUIRED');

      const runAttempt = cand.runAttempt ?? 1;
      const maxAttempts = cand.maxAttempts ?? (casEntry ? casEntry.maxAttempts : 3);
      const maxExecMs = cand.maxExecutionMs ?? plan.maxExecutionMs;
      if (maxExecMs < cand.leaseTtlMs || !Number.isSafeInteger(nowMs + maxExecMs)) {
        return denyCasReconcile('LEASE_TTL_EXCEEDED');
      }
      if (cand.generation !== nextGeneration) return denyCasReconcile('STALE_LEASE_GENERATION');
      const claimHeadLock = computeReservationHeadLock(
        cand.repositoryId,
        cand.issue,
        cand.head,
        nextGeneration
      );
      if (cand.lockSha256 !== undefined && cand.lockSha256 !== claimHeadLock) {
        return denyCasReconcile('HEAD_BINDING_MISMATCH');
      }

      const effectiveMaxAttempts = casEntry === null ? maxAttempts : Math.min(casEntry.maxAttempts, maxAttempts);
      if (casEntry !== null) {
        const usedRun = (casEntry.runId === cand.runId && casEntry.runAttempt === runAttempt) ||
          (casEntry.priorRuns !== undefined && casEntry.priorRuns.some(
            p => p.runId === cand.runId && p.runAttempt === runAttempt
          ));
        if (usedRun) return denyCasReconcile('DUPLICATE_RUN_ATTEMPT');
        if (casEntry.status === 'exhausted' || casEntry.attempts >= effectiveMaxAttempts) {
          return denyCasReconcile('RETRY_CEILING_EXHAUSTED');
        }
      }

      if (cand.ownedPaths.some(p => activeCasPaths.some(ap => pathsOverlap(p, ap)))) {
        return denyCasReconcile('OWNED_PATHS_OVERLAP');
      }
      if (activeCasLanes.has(cand.lane)) {
        return denyCasReconcile('LANE_RESERVED');
      }

      if (checkpointMismatch || preAudit.incomplete) {
        return denyCasReconcile('STALE_OR_INCOMPLETE_LEDGER');
      }

      if (casEntry === null && workingCasEntries.length >= maxCasEntries) {
        const evictIdx = workingCasEntries.findIndex(item => terminalCasStatuses.has(item.status));
        if (evictIdx < 0) return denyCasReconcile('QUEUE_CAPACITY_EXCEEDED');
        if (archivedList.length >= maxCasArchived) return denyCasReconcile('ARCHIVE_CAPACITY_EXHAUSTED');
        const [evicted] = workingCasEntries.splice(evictIdx, 1);
        let recordedRowsForEvicted = 0;
        let recordedChargedForEvicted = 0;
        for (const r of workingLedgerRows) {
          const matchesEvicted = evicted.targetType === 'pull_request'
            ? (r.repositoryId === evicted.repositoryId &&
                r.issue === evicted.pullNumber &&
                r.head === evicted.headSha)
            : (r.repositoryId === evicted.repositoryId &&
                r.issue === evicted.issueNumber &&
                !preAudit.prWorkKeysInCas.has(`${r.repositoryId}:pr:${r.issue}:${r.head}`));
          if (matchesEvicted) {
            recordedRowsForEvicted++;
            if (r.phase !== 'cancelled') recordedChargedForEvicted++;
          }
        }
        const evictedCollapsedAttempts = Math.max(0, evicted.attempts - recordedRowsForEvicted);
        nextOverwrittenRetryAttempts = Math.max(0, nextOverwrittenRetryAttempts - evictedCollapsedAttempts);
        nextArchivedChargedRuns += Math.min(evicted.attempts, recordedChargedForEvicted);
        archivedList.push({workId: evicted.workId, status: evicted.status});
      }

      const executionDeadlineMs = nowMs + maxExecMs;
      const leaseExpiresAtMs = Math.min(executionDeadlineMs, nowMs + cand.leaseTtlMs);
      const claimedEntry = {
        workId,
        targetType,
        repository: cand.repository,
        repositoryId: cand.repositoryId,
        issueNumber: targetType === 'issue' ? cand.issue : null,
        pullNumber: targetType === 'pull_request' ? cand.issue : null,
        headSha: targetType === 'pull_request' ? cand.head : null,
        lane: cand.lane,
        ownedPaths: [...cand.ownedPaths],
        status: 'leased',
        generation: nextGeneration,
        attempts: casEntry === null ? 1 : casEntry.attempts + 1,
        maxAttempts: effectiveMaxAttempts,
        workerId: cand.workerId,
        runId: cand.runId,
        runAttempt,
        claimedAtMs: nowMs,
        leaseTtlMs: cand.leaseTtlMs,
        leaseExpiresAtMs,
        maxExecutionMs: maxExecMs,
        executionDeadlineMs
      };
      if (cand.traceparent !== undefined) claimedEntry.traceparent = cand.traceparent;
      if (casEntry !== null) {
        claimedEntry.priorRuns = [
          ...(casEntry.priorRuns === undefined
            ? []
            : casEntry.priorRuns.map(p => ({runId: p.runId, runAttempt: p.runAttempt}))),
          {runId: casEntry.runId, runAttempt: casEntry.runAttempt}
        ];
        workingCasEntries[casIdx] = claimedEntry;
        activeTargetCasIdx = casIdx;
      } else {
        workingCasEntries.push(claimedEntry);
        activeTargetCasIdx = workingCasEntries.length - 1;
      }
      activeTargetLockPrefix = desiredPhase === 'reserved' ? 'c1' : 'c2';
      nextGeneration++;
      boundCasEntry = claimedEntry;
    }

    const peerActiveSet = new Set();
    let peerActiveLedgerUnits = 0;
    for (const r of workingLedgerRows) {
      if ((r.phase === 'reserved' || r.phase === 'in-flight') &&
          !(r.repositoryId === cand.repositoryId && r.issue === cand.issue)) {
        peerActiveSet.add(`${r.repositoryId}:${r.issue}`);
        peerActiveLedgerUnits += r.units;
      }
    }
    const activeCasBySubj = new Map();
    for (const e of workingCasEntries) {
      if (e.workId === workId || !isCasEntryActive(e, nowMs)) continue;
      const subj = e.targetType === 'issue' ? e.issueNumber : e.pullNumber;
      const key = `${e.repositoryId}:${subj}`;
      peerActiveSet.add(key);
      activeCasBySubj.set(key, e);
    }

    const observedMs = input.admissionEvidence.observedMs;
    const netDeducted = input.admissionEvidence.netOfReservationsVerified === true;
    let staleBillingObservation = (admission.ghAwCaps !== null || !netDeducted) &&
      reconciledActions.some(a => a.toPhase === 'settled' || a.toPhase === 'expired');

    if (!staleBillingObservation) {
      const chargedRowsByWorkKey = new Map();
      const rowPhaseByWorkKeyAndGen = new Map();
      let hasChargedTerminalRows = false;
      for (const r of workingLedgerRows) {
        const exactPrKey = `${r.repositoryId}:pr:${r.issue}:${r.head}`;
        const rowWorkKey = preAudit.prWorkKeysInCas.has(exactPrKey)
          ? exactPrKey
          : `${r.repositoryId}:issue:${r.issue}`;
        rowPhaseByWorkKeyAndGen.set(`${rowWorkKey}:${r.generation}`, r.phase);
        if (r.phase === 'settled' || r.phase === 'expired') {
          hasChargedTerminalRows = true;
          const list = chargedRowsByWorkKey.get(rowWorkKey) ?? [];
          list.push(r);
          chargedRowsByWorkKey.set(rowWorkKey, list);
        }
      }
      if (hasChargedTerminalRows &&
          (admission.ghAwCaps !== null || !netDeducted) &&
          verifiedLedger.snapshot.exportedAt > observedMs) {
        staleBillingObservation = true;
      }
      if (!staleBillingObservation) {
        for (const rec of combinedReceipts) {
          if (rec.reclaimedAtMs > observedMs &&
              rowPhaseByWorkKeyAndGen.get(`${rec.workId}:${rec.previousGeneration}`) !== 'cancelled') {
            staleBillingObservation = true;
            break;
          }
        }
      }
      if (!staleBillingObservation) {
        for (let i = 0; i < workingCasEntries.length; i++) {
          const e = i === activeTargetCasIdx && !isBindingActiveLease ? casEntry : workingCasEntries[i];
          if (e === null || e.status === 'leased') continue;
          const matchingCharged = chargedRowsByWorkKey.get(e.workId);
          if (matchingCharged !== undefined &&
              matchingCharged.some(r => Math.min(r.validThrough, e.leaseExpiresAtMs) > observedMs)) {
            staleBillingObservation = true;
            break;
          }
        }
      }
    }
    if (staleBillingObservation) {
      return denyCasReconcile('STALE_BILLING_OBSERVATION');
    }

    if (admission.ghAwCaps !== null) {
      const includesRes = admission.ghAwCaps.dailyUsageIncludesReservations === true;
      let projectedDailyCredits;
      if (includesRes) {
        if (isPhaseAdvance) {
          if (existingTargetCredits <= 0) {
            return denyCasReconcile('PEER_CREDIT_COMMITMENTS_UNKNOWN');
          }
          projectedDailyCredits = admission.ghAwCaps.dailyAiCreditsUsed +
            Math.max(0, admission.ghAwCaps.runAiCreditsRequired - existingTargetCredits);
        } else {
          projectedDailyCredits = admission.ghAwCaps.dailyAiCreditsUsed +
            admission.ghAwCaps.runAiCreditsRequired;
        }
      } else {
        let peerCommittedCredits = 0;
        for (const peerKey of peerActiveSet) {
          const peerEntry = activeCasBySubj.get(peerKey);
          const peerCredits = peerEntry ? parseCheckpointedCredits(peerEntry.lockSha256) : 0;
          if (peerCredits <= 0) {
            return denyCasReconcile('PEER_CREDIT_COMMITMENTS_UNKNOWN');
          }
          peerCommittedCredits += peerCredits;
        }
        const effectiveTargetCredits = isPhaseAdvance
          ? Math.max(existingTargetCredits, admission.ghAwCaps.runAiCreditsRequired)
          : admission.ghAwCaps.runAiCreditsRequired;
        projectedDailyCredits = admission.ghAwCaps.dailyAiCreditsUsed +
          peerCommittedCredits + effectiveTargetCredits;
      }
      if (projectedDailyCredits > admission.ghAwCaps.maxDailyAiCredits) {
        return denyCasReconcile('GH_AW_DAILY_AI_CREDITS_EXCEEDED');
      }
    }

    const effectiveExecMs = Math.min(
      plan.maxExecutionMs,
      boundCasEntry.maxExecutionMs,
      cand.maxExecutionMs ?? plan.maxExecutionMs
    );
    const peerActiveUnits = peerActiveLedgerUnits + preAudit.unaccountedActivePeerUnits;
    let candReason;

    if (isPhaseAdvance) {
      const requiredRemainingUnits = netDeducted ? 0 : peerActiveUnits + plan.unitsPerRun;
      if (preAudit.authoritativeSpentUnits > plan.includedUnits ||
          requiredRemainingUnits > input.admissionEvidence.remainingIncludedUnits) {
        return denyCasReconcile('CAPACITY_EXHAUSTED');
      }
      const nextValidThrough = Math.min(
        boundCasEntry.executionDeadlineMs,
        nowMs + effectiveExecMs,
        existingLedgerRow.validThrough + plan.maxExecutionMs
      );
      workingLedgerRows[existingLedgerIdx] = {
        ...existingLedgerRow,
        phase: 'in-flight',
        validThrough: nextValidThrough
      };
      candReason = 'CROSS_RUN_CAS_SIMULATION_STARTED';
      reconciledActions.push(Object.freeze({
        repositoryId: cand.repositoryId,
        issue: cand.issue,
        head: cand.head,
        generation: cand.generation,
        fromPhase: 'reserved',
        toPhase: 'in-flight',
        trigger: 'candidate_begin'
      }));
    } else {
      let activeRepo = 0;
      for (const key of peerActiveSet) {
        if (key.startsWith(`${cand.repositoryId}:`)) activeRepo++;
      }
      const requiredRemainingUnits = (netDeducted ? 0 : peerActiveUnits) + plan.unitsPerRun;
      if (preAudit.authoritativeSpentUnits + plan.unitsPerRun > plan.includedUnits ||
          requiredRemainingUnits > input.admissionEvidence.remainingIncludedUnits ||
          peerActiveSet.size >= plan.maxActive) {
        return denyCasReconcile('CAPACITY_EXHAUSTED');
      }
      if (activeRepo >= plan.repos.get(cand.repositoryId)) {
        return denyCasReconcile('REPO_CAPACITY_EXHAUSTED');
      }
      if (existingLedgerIdx < 0 && workingLedgerRows.length >= 10000) {
        return denyCasReconcile('STORE_FULL');
      }
      const validThrough = desiredPhase === 'reserved'
        ? Math.min(boundCasEntry.leaseExpiresAtMs, boundCasEntry.executionDeadlineMs, nowMs + 60000)
        : Math.min(boundCasEntry.executionDeadlineMs, nowMs + effectiveExecMs);
      const nextCandidateRow = {
        repositoryId: cand.repositoryId,
        issue: cand.issue,
        head: cand.head,
        generation: cand.generation,
        units: plan.unitsPerRun,
        phase: desiredPhase,
        validThrough,
        reservedAt: nowMs
      };
      if (existingLedgerIdx >= 0) {
        nextOverwrittenRetryAttempts += 1;
        if (existingLedgerRow.phase === 'expired') {
          nextOverwrittenRetryCharged += 1;
        }
        workingLedgerRows[existingLedgerIdx] = nextCandidateRow;
      } else {
        workingLedgerRows.push(nextCandidateRow);
        workingLedgerRows.sort(compareRows);
      }
      if (nextArchivedChargedRuns > 0xffff ||
          nextOverwrittenRetryAttempts > 0xffff ||
          nextOverwrittenRetryCharged > 0xffff) {
        return denyCasReconcile('ARCHIVE_CAPACITY_EXHAUSTED');
      }
      candReason = desiredPhase === 'reserved'
        ? 'CROSS_RUN_CAS_RESERVED'
        : 'CROSS_RUN_CAS_SIMULATION_STARTED';
      reconciledActions.push(Object.freeze({
        repositoryId: cand.repositoryId,
        issue: cand.issue,
        head: cand.head,
        generation: cand.generation,
        fromPhase: existingLedgerRow !== null ? existingLedgerRow.phase : null,
        toPhase: desiredPhase,
        trigger: 'candidate_reserved'
      }));
    }

    const boundTicket = Object.freeze({
      repositoryId: cand.repositoryId,
      issue: cand.issue,
      head: cand.head,
      generation: cand.generation
    });

    // Build signed nextLedgerSnapshot first so CAS checkpoint locks bind its exact SHA-256 digest.
    const nextLedgerSeq = verifiedLedger.snapshot.sequence + 1;
    const frozenRows = Object.freeze(workingLedgerRows.map(r => Object.freeze({...r})));
    const canonical = JSON.stringify([snapshotVersion, plan.signature, nextLedgerSeq, nowMs, frozenRows]);
    const {digest, hmac} = signCanonical(canonical, input.signingKey);
    const nextLedgerSnapshot = Object.freeze({
      version: snapshotVersion,
      window: plan.window,
      planSignature: plan.signature,
      sequence: nextLedgerSeq,
      exportedAt: nowMs,
      reservations: frozenRows,
      digest,
      hmac
    });
    const nextDigestTag = computeCheckpointTail28(archivedList, digest);
    const countersHex12 = `${nextArchivedChargedRuns.toString(16).padStart(4, '0')}${nextOverwrittenRetryAttempts.toString(16).padStart(4, '0')}${nextOverwrittenRetryCharged.toString(16).padStart(4, '0')}`;
    const targetReservedCredits = admission.ghAwCaps !== null
      ? Math.max(existingTargetCredits, admission.ghAwCaps.runAiCreditsRequired)
      : existingTargetCredits;
    for (let i = 0; i < workingCasEntries.length; i++) {
      const item = workingCasEntries[i];
      if (i === activeTargetCasIdx) {
        workingCasEntries[i] = cloneMutableCasEntry(item, {
          lockSha256: buildCheckpointedLock(
            activeTargetLockPrefix,
            targetReservedCredits,
            nextArchivedChargedRuns,
            nextOverwrittenRetryAttempts,
            nextOverwrittenRetryCharged,
            computeHeadTag14(cand.repositoryId, cand.issue, cand.head, item.generation),
            nextDigestTag
          )
        });
      } else if (isCheckpointedCasLock(item.lockSha256)) {
        workingCasEntries[i] = cloneMutableCasEntry(item, {
          lockSha256: `${item.lockSha256.slice(0, 10)}${countersHex12}${item.lockSha256.slice(22, 36)}${nextDigestTag}`
        });
      }
    }

    const mergedReceipts = newCasReceipts.length > 0
      ? [...rawQueueState.recoveryReceipts, ...newCasReceipts].slice(-maxCasReceipts)
      : [...rawQueueState.recoveryReceipts];
    const nextCasState = freezeCasStateShape(
      rawQueueState.protocol,
      rawQueueState.sequence + 1,
      nextGeneration,
      workingCasEntries,
      mergedReceipts,
      archivedList
    );
    const nextRefOid = hashCasStateOid(observedRefOid, nextCasState);

    return Object.freeze({
      shadow: true,
      liveDispatch: false,
      liveMerge: false,
      ok: true,
      reconciled: true,
      reason: candReason,
      ref: PROTECTED_WORK_QUEUE_REF,
      protocol: nextCasState.protocol,
      expectedRefOid: input.expectedRefOid,
      nextRefOid,
      casMutationRequired: true,
      ledgerMutationRequired: true,
      nextCasState,
      nextLedgerSnapshot,
      ticket: boundTicket,
      reclaimedExpiredCount,
      releasedOrphanCount,
      reconciledActions: Object.freeze(reconciledActions),
      reclaimedCasWorkIds: Object.freeze(newCasReceipts.map(r => r.workId)),
      skippedRunObservations: Object.freeze(skippedRunObservations),
      admissionReceipt: admission.receipt
    });
  }

  // Passive cleanup / reconciliation path (candidate === undefined):
  // Allow cleanup even when remainingIncludedUnits === 0, while enforcing checkpoint integrity and plan.includedUnits.
  if (checkpointMismatch) {
    return denyCasReconcile('STALE_OR_INCOMPLETE_LEDGER');
  }
  const passiveAudit = auditCrossRunLedgerAccounting(
    workingLedgerRows,
    workingCasEntries,
    archivedList,
    combinedReceipts,
    receiptsSaturated,
    checkpointArchiveTotals,
    plan.unitsPerRun,
    null
  );
  if (passiveAudit.authoritativeSpentUnits > plan.includedUnits) {
    return denyCasReconcile('CAPACITY_EXHAUSTED');
  }

  let casMutated = newCasReceipts.length > 0;
  let nextLedgerSnapshot = verifiedLedger.snapshot;
  if (ledgerMutated) {
    const nextLedgerSeq = verifiedLedger.snapshot.sequence + 1;
    const frozenRows = Object.freeze(workingLedgerRows.map(r => Object.freeze({...r})));
    const canonical = JSON.stringify([snapshotVersion, plan.signature, nextLedgerSeq, nowMs, frozenRows]);
    const {digest, hmac} = signCanonical(canonical, input.signingKey);
    nextLedgerSnapshot = Object.freeze({
      version: snapshotVersion,
      window: plan.window,
      planSignature: plan.signature,
      sequence: nextLedgerSeq,
      exportedAt: nowMs,
      reservations: frozenRows,
      digest,
      hmac
    });
    const nextDigestTag = computeCheckpointTail28(archivedList, digest);
    for (let i = 0; i < workingCasEntries.length; i++) {
      const item = workingCasEntries[i];
      if (isCheckpointedCasLock(item.lockSha256)) {
        workingCasEntries[i] = cloneMutableCasEntry(item, {
          lockSha256: `${item.lockSha256.slice(0, 36)}${nextDigestTag}`
        });
        casMutated = true;
      }
    }
  }

  const mergedReceipts = newCasReceipts.length > 0
    ? [...rawQueueState.recoveryReceipts, ...newCasReceipts].slice(-maxCasReceipts)
    : [...rawQueueState.recoveryReceipts];
  const nextCasSequence = casMutated ? rawQueueState.sequence + 1 : rawQueueState.sequence;
  const nextCasState = casMutated
    ? freezeCasStateShape(
        rawQueueState.protocol,
        nextCasSequence,
        nextGeneration,
        workingCasEntries,
        mergedReceipts,
        archivedList
      )
    : rawQueueState;
  const nextRefOid = casMutated ? hashCasStateOid(observedRefOid, nextCasState) : observedRefOid;

  return Object.freeze({
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    ok: true,
    reconciled: true,
    reason: 'CROSS_RUN_CAS_RECONCILED',
    ref: PROTECTED_WORK_QUEUE_REF,
    protocol: nextCasState.protocol,
    expectedRefOid: input.expectedRefOid,
    nextRefOid,
    casMutationRequired: casMutated,
    ledgerMutationRequired: ledgerMutated,
    nextCasState,
    nextLedgerSnapshot,
    ticket: null,
    reclaimedExpiredCount,
    releasedOrphanCount,
    reconciledActions: Object.freeze(reconciledActions),
    reclaimedCasWorkIds: Object.freeze(newCasReceipts.map(r => r.workId)),
    skippedRunObservations: Object.freeze(skippedRunObservations),
    admissionReceipt: admission.receipt
  });
}
