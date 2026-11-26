import {DatabaseSync} from 'node:sqlite';
import {types} from 'node:util';
import {budgetDecision} from './budget.mjs';
import {dispatchIntent} from './dispatch-intent.mjs';

const time = value => Number.isSafeInteger(value) && value >= 0;
const count = (value, limit) => time(value) && value <= limit;
const positive = value => time(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const data = (value, fields) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  fields.every(field => Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, 'value'));
const state = (reason, ticket) => Object.freeze(ticket ?
  {shadow: true, liveDispatch: false, reason, ticket} : {shadow: true, liveDispatch: false, reason});
const identity = ['repositoryId', 'issue', 'head', 'generation'];
const ticketValid = ticket => data(ticket, identity) && positive(ticket.repositoryId) &&
  positive(ticket.issue) && sha(ticket.head) && positive(ticket.generation);
const matches = (a, b) => ticketValid(a) && identity.every(key => a[key] === b[key]);
const evidenceFields = [...identity, 'approvedRepositoryId', 'approved', 'stop', 'includedOnly',
  'overageDisabled', 'capacity', 'leaseVerified', 'alreadyDispatched', 'leaseUntil'];
const freshEvidenceFields = [...evidenceFields, 'observedMs'];

function normalizePlan(plan) {
  if (!data(plan, ['window', 'maxActive', 'includedUnits', 'unitsPerRun', 'repositories']) ||
      typeof plan.window !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(plan.window) ||
      !positive(plan.maxActive) || plan.maxActive > 250 ||
      !positive(plan.includedUnits) || plan.includedUnits > 10000000 ||
      !positive(plan.unitsPerRun) || plan.unitsPerRun > plan.includedUnits) return null;
  const entries = plan.repositories;
  if (types.isProxy(entries) || !Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype ||
      !entries.length || entries.length > 250 || Reflect.ownKeys(entries).length !== entries.length + 1)
    return null;
  const repos = new Map();
  for (let i = 0; i < entries.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, i);
    const entry = descriptor?.value;
    if (!data(entry, ['repositoryId', 'maxActive']) || !positive(entry.repositoryId) ||
        !positive(entry.maxActive) || entry.maxActive > plan.maxActive || repos.has(entry.repositoryId)) return null;
    repos.set(entry.repositoryId, entry.maxActive);
  }
  const signature = JSON.stringify([plan.window, plan.maxActive, plan.includedUnits, plan.unitsPerRun,
    [...repos].sort(([a], [b]) => a - b)]);
  return {repos, signature, window: plan.window, maxActive: plan.maxActive,
    includedUnits: plan.includedUnits, unitsPerRun: plan.unitsPerRun};
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
      CREATE TABLE IF NOT EXISTS shadow_dispatch_reservations (
        repository INTEGER NOT NULL, issue INTEGER NOT NULL, head TEXT NOT NULL, generation INTEGER NOT NULL,
        units INTEGER NOT NULL CHECK(units > 0),
        phase TEXT NOT NULL CHECK(phase IN ('reserved', 'in-flight', 'settled', 'cancelled')),
        valid_through INTEGER NOT NULL, reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
        CHECK(valid_through >= reserved_at),
        PRIMARY KEY (repository, issue, head)
      );
    `);
    db.prepare('INSERT OR IGNORE INTO shadow_dispatch_plan VALUES (1, ?)').run(plan.signature);
    if (db.prepare('SELECT signature FROM shadow_dispatch_plan WHERE id = 1').get().signature !== plan.signature)
      throw Error('SHADOW_DISPATCH_PLAN_CHANGED');
    const usage = db.prepare(`
      SELECT coalesce(sum(CASE WHEN phase != 'cancelled' THEN units ELSE 0 END), 0) AS units,
        count(CASE WHEN phase IN ('reserved', 'in-flight') THEN 1 END) AS active,
        count(CASE WHEN repository = ? AND phase IN ('reserved', 'in-flight') THEN 1 END) AS repoActive,
        count(*) AS size
      FROM shadow_dispatch_reservations
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
      UPDATE shadow_dispatch_reservations SET phase = 'in-flight'
      WHERE repository = ? AND issue = ? AND head = ? AND generation = ?
        AND phase = 'reserved' AND reserved_at <= ? AND valid_through >= ?
    `);
    const transition = db.prepare(`
      UPDATE shadow_dispatch_reservations SET phase = ?
      WHERE repository = ? AND issue = ? AND head = ? AND generation = ? AND phase = ?
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
        quota.window !== plan.window || quota.repositoryId !== candidate.repositoryId ||
        !count(quota.remaining, plan.includedUnits) || !count(quota.active, 250) ||
        !count(quota.repoActive, quota.active)) return state('BUDGET_UNKNOWN');
      const ticket = Object.freeze(Object.fromEntries(identity.map(key => [key, candidate[key]])));
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch { return state('STORE_UNAVAILABLE'); }
      try {
        const occupied = usage.get(candidate.repositoryId);
        const available = budgetDecision({stop: candidate.stop, includedOnly: quota.includedOnly,
          overageDisabled: quota.overageDisabled, authorityVerified: quota.authorityVerified,
          nowMs: now, observedMs: quota.observedMs, remaining: quota.remaining, reserved: occupied.units,
          active: quota.active + occupied.active, maxActive: plan.maxActive, unitsPerRun: plan.unitsPerRun});
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

    return Object.freeze({
      reserve,
      begin(ticket, current, now) {
        if (!ticketValid(ticket) || !data(current, freshEvidenceFields) || !matches(current, ticket) ||
            !time(now) || !time(current.leaseUntil) || current.leaseUntil <= now)
          return state('SCOPE_OR_LEASE_UNKNOWN');
        if (!time(current.observedMs) || current.observedMs > now || now - current.observedMs > 5000)
          return state('STALE_LEASE_EVIDENCE');
        const intent = dispatchIntent(current);
        if (intent.reason !== 'DRY_RUN_ONLY') return state(intent.reason);
        try {
          return state(begin.run(...values(ticket), now, now).changes === 1 ?
            'SHADOW_SIMULATION_RECORDED' : 'RESERVATION_UNAVAILABLE');
        } catch { return state('STORE_UNAVAILABLE'); }
      },
      cancel(ticket) {
        if (!ticketValid(ticket)) return state('SCOPE_OR_LEASE_UNKNOWN');
        try {
          return state(transition.run('cancelled', ...values(ticket), 'reserved').changes === 1 ?
            'SHADOW_CANCELLED_BEFORE_SIMULATION' : 'RESERVATION_UNAVAILABLE');
        } catch { return state('STORE_UNAVAILABLE'); }
      },
      reconcile(ticket, receipt) {
        if (!ticketValid(ticket) || !matches(receipt, ticket) || !data(receipt, ['state', 'shadow']) ||
            receipt.shadow !== true || !['completed', 'cancelled'].includes(receipt.state))
          return state('TERMINAL_RECEIPT_UNKNOWN');
        try {
          return state(transition.run('settled', ...values(ticket), 'in-flight').changes === 1 ?
            'SHADOW_SETTLED' : 'RESERVATION_UNAVAILABLE');
        } catch { return state('STORE_UNAVAILABLE'); }
      },
      close() { db.close(); }
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
