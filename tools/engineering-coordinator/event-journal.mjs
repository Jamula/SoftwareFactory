import {DatabaseSync} from 'node:sqlite';
import {types} from 'node:util';

const journalHandles = new WeakMap();
const eventKinds = new Set(['issue', 'pull', 'review', 'check', 'main', 'manual']);
const snapshotEntryKeys = [
  'repositoryId', 'deliveryId', 'kind', 'subject', 'head',
  'owner', 'generation', 'expires', 'completed', 'retryAfter'
];
const snapshotTopKeys = new Set(['schemaVersion', 'shadow', 'entries', 'exported', 'reason']);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isRepo = value => isTime(value) && value > 0;
const isToken = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const isHead = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isPlain = value => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasOwnValues = (value, keys) => isPlain(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const isDenseArray = value => !types.isProxy(value) && Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype && value.length <= 10000 &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({length: value.length}, (_, i) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, i) ?? {}, 'value')).every(Boolean);
const rejected = reason => ({queued: false, reason});

function validSnapshotEntry(entry) {
  if (!hasOwnValues(entry, snapshotEntryKeys) || Reflect.ownKeys(entry).length !== snapshotEntryKeys.length) {
    return false;
  }
  const {repositoryId, deliveryId, kind, subject, head, owner, generation, expires, completed, retryAfter} = entry;
  if (!isRepo(repositoryId) || !isToken(deliveryId) || !eventKinds.has(kind) ||
      !isTime(subject) || !isHead(head) || typeof completed !== 'boolean' ||
      !isTime(generation) || !isTime(expires)) return false;
  if (generation === 0) return owner === null && expires === 0 && !completed && retryAfter === null;
  if (!isToken(owner)) return false;
  if (completed) return expires === 0 && retryAfter === null;
  return retryAfter === null || isRepo(retryAfter);
}

/**
 * Stores sanitized shadow reconciliation hints. Delivery order never establishes PR
 * state. Consumers must read fresh authoritative state before completing a claim.
 */
export function openEventJournal(filename) {
  const db = new DatabaseSync(filename, {timeout: 250});
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_events (
        id INTEGER PRIMARY KEY,
        repository_id INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject INTEGER NOT NULL,
        head TEXT NOT NULL,
        owner TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (repository_id, delivery_id)
      );
      CREATE TABLE IF NOT EXISTS coordinator_event_deferrals (
        event_id INTEGER PRIMARY KEY,
        retry_after INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordinator_events_pending
        ON coordinator_events (repository_id, completed, id);
      -- Keep the correlated active-lease guard bounded as the pending queue grows.
      CREATE INDEX IF NOT EXISTS coordinator_events_active
        ON coordinator_events (repository_id, expires) WHERE completed = 0;
    `);
    const enqueue = db.prepare(`
      INSERT INTO coordinator_events (repository_id, delivery_id, kind, subject, head)
      SELECT ?, ?, ?, ?, ?
      WHERE (SELECT count(*) FROM coordinator_events WHERE repository_id = ?) < 10000
      ON CONFLICT (repository_id, delivery_id) DO NOTHING
    `);
    const existing = db.prepare(`
      SELECT kind, subject, head FROM coordinator_events
      WHERE repository_id = ? AND delivery_id = ?
    `);
    const claim = db.prepare(`
      UPDATE coordinator_events SET owner = ?, generation = generation + 1, expires = ?
      WHERE id = (
        SELECT pending.id FROM coordinator_events AS pending
        WHERE pending.repository_id = ? AND pending.completed = 0 AND pending.expires <= ?
          AND pending.generation < 9007199254740991
          AND (? IS NULL OR pending.kind = ?)
          AND NOT EXISTS (SELECT 1 FROM coordinator_event_deferrals AS deferred
            WHERE deferred.event_id = pending.id AND deferred.retry_after > ?)
          AND NOT EXISTS (
            SELECT 1 FROM coordinator_events AS active
            WHERE active.repository_id = pending.repository_id
              AND active.completed = 0 AND active.expires > ?
          )
        ORDER BY COALESCE((SELECT retry_after FROM coordinator_event_deferrals WHERE event_id = pending.id), 0), pending.id LIMIT 1
      )
      RETURNING delivery_id AS deliveryId, kind, subject, head, generation
    `);
    const defer = db.prepare(`
      INSERT INTO coordinator_event_deferrals (event_id, retry_after)
      SELECT id, ? FROM coordinator_events
      WHERE repository_id = ? AND delivery_id = ? AND owner = ?
        AND generation = ? AND completed = 0 AND expires > ?
      ON CONFLICT(event_id) DO UPDATE SET retry_after = excluded.retry_after
      WHERE excluded.retry_after > coordinator_event_deferrals.retry_after
    `);
    const complete = db.prepare(`
      UPDATE coordinator_events SET completed = 1, expires = 0
      WHERE repository_id = ? AND delivery_id = ? AND owner = ?
        AND generation = ? AND completed = 0 AND expires > ?
    `);
    const selectSnapshot = db.prepare(`
      SELECT e.repository_id AS repositoryId, e.delivery_id AS deliveryId, e.kind, e.subject, e.head,
             e.owner, e.generation, e.expires, e.completed, d.retry_after AS retryAfter
      FROM coordinator_events AS e
      LEFT JOIN coordinator_event_deferrals AS d ON d.event_id = e.id
      WHERE (? IS NULL OR e.repository_id = ?)
      ORDER BY e.id ASC
    `);
    const existingFull = db.prepare(`
      SELECT id, kind, subject, head, generation, completed
      FROM coordinator_events WHERE repository_id = ? AND delivery_id = ?
    `);
    const repoCount = db.prepare(`
      SELECT count(*) AS total FROM coordinator_events WHERE repository_id = ?
    `);
    const insertImported = db.prepare(`
      INSERT INTO coordinator_events
        (repository_id, delivery_id, kind, subject, head, owner, generation, expires, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const completeImported = db.prepare(`
      UPDATE coordinator_events SET owner = ?, generation = ?, expires = 0, completed = 1 WHERE id = ?
    `);
    const advanceImported = db.prepare(`
      UPDATE coordinator_events SET owner = ?, generation = ?, expires = ? WHERE id = ?
    `);
    const upsertDeferral = db.prepare(`
      INSERT INTO coordinator_event_deferrals (event_id, retry_after) VALUES (?, ?)
      ON CONFLICT(event_id) DO UPDATE SET retry_after = excluded.retry_after
      WHERE excluded.retry_after > coordinator_event_deferrals.retry_after
    `);
    const clearDeferral = db.prepare(`
      DELETE FROM coordinator_event_deferrals WHERE event_id = ?
    `);

    const journal = Object.freeze({
      enqueue(event) {
        try {
          const {repositoryId, deliveryId, kind, subject, head} = event;
          if (!isRepo(repositoryId) || !isToken(deliveryId) || !eventKinds.has(kind) ||
              !isTime(subject) || !isHead(head)) return rejected('INVALID_EVENT');
          if (enqueue.run(repositoryId, deliveryId, kind, subject, head, repositoryId).changes === 1) {
            return {queued: true, reason: 'QUEUED'};
          }
          const prior = existing.get(repositoryId, deliveryId);
          if (!prior) return rejected('JOURNAL_FULL');
          return rejected(prior.kind === kind && prior.subject === subject && prior.head === head ?
            'DUPLICATE_DELIVERY' : 'DELIVERY_CONFLICT');
        } catch { return rejected('JOURNAL_UNAVAILABLE'); }
      },
      claim(repositoryId, owner, now, leaseMs, kind = null) {
        if (!isRepo(repositoryId) || !isToken(owner) || !isTime(now) ||
            !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000 ||
            !isTime(now + leaseMs) || (kind !== null && !eventKinds.has(kind))) return null;
        try {
          const event = claim.get(owner, now + leaseMs, repositoryId, now, kind, kind, now, now);
          return event ? {...event, repositoryId, owner, leaseUntil: now + leaseMs} : null;
        } catch { return null; }
      },
      // A retry delay never acknowledges evidence or extends the active lease.
      defer(ticket, now, delayMs) {
        try {
          const {repositoryId, deliveryId, owner, generation} = ticket;
          if (!isRepo(repositoryId) || !isToken(deliveryId) || !isToken(owner) ||
              !isRepo(generation) || !isTime(now) || !Number.isSafeInteger(delayMs) ||
              delayMs < 60000 || delayMs > 3600000 || !isTime(now + delayMs)) return false;
          return defer.run(now + delayMs, repositoryId, deliveryId, owner, generation, now).changes === 1;
        } catch { return false; }
      },
      complete(ticket, now) {
        try {
          const {repositoryId, deliveryId, owner, generation} = ticket;
          if (!isRepo(repositoryId) || !isToken(deliveryId) || !isToken(owner) ||
              !isRepo(generation) || !isTime(now)) return false;
          return complete.run(repositoryId, deliveryId, owner, generation, now).changes === 1;
        } catch { return false; }
      },
      close() { db.close(); }
    });

    journalHandles.set(journal, {
      exportSnapshot(repositoryId) {
        try {
          const entries = selectSnapshot.all(repositoryId, repositoryId).map(row => Object.freeze({
            repositoryId: row.repositoryId,
            deliveryId: row.deliveryId,
            kind: row.kind,
            subject: row.subject,
            head: row.head,
            owner: row.owner,
            generation: row.generation,
            expires: row.expires,
            completed: row.completed === 1,
            retryAfter: row.retryAfter
          }));
          return Object.freeze({
            shadow: true,
            exported: true,
            reason: 'SNAPSHOT_EXPORTED',
            schemaVersion: 1,
            entries: Object.freeze(entries)
          });
        } catch {
          return {shadow: true, exported: false, reason: 'JOURNAL_UNAVAILABLE'};
        }
      },
      importSnapshot(entries) {
        try {
          db.exec('BEGIN IMMEDIATE');
          let importedCount = 0;
          let duplicateCount = 0;
          for (const entry of entries) {
            const prior = existingFull.get(entry.repositoryId, entry.deliveryId);
            if (prior) {
              if (prior.kind !== entry.kind || prior.subject !== entry.subject || prior.head !== entry.head) {
                db.exec('ROLLBACK');
                return {shadow: true, imported: false, reason: 'DELIVERY_CONFLICT'};
              }
              duplicateCount++;
              if (prior.completed === 0) {
                if (entry.completed) {
                  completeImported.run(entry.owner, Math.max(prior.generation, entry.generation), prior.id);
                  clearDeferral.run(prior.id);
                } else {
                  if (entry.generation > prior.generation) {
                    advanceImported.run(entry.owner, entry.generation, entry.expires, prior.id);
                  }
                  if (entry.retryAfter !== null) {
                    upsertDeferral.run(prior.id, entry.retryAfter);
                  }
                }
              }
              continue;
            }
            if (repoCount.get(entry.repositoryId).total >= 10000) {
              db.exec('ROLLBACK');
              return {shadow: true, imported: false, reason: 'JOURNAL_FULL'};
            }
            const inserted = insertImported.run(
              entry.repositoryId, entry.deliveryId, entry.kind, entry.subject, entry.head,
              entry.owner, entry.generation, entry.expires, entry.completed ? 1 : 0
            );
            if (entry.retryAfter !== null) {
              upsertDeferral.run(Number(inserted.lastInsertRowid), entry.retryAfter);
            }
            importedCount++;
          }
          db.exec('COMMIT');
          return {shadow: true, imported: true, reason: 'SNAPSHOT_IMPORTED', importedCount, duplicateCount};
        } catch {
          try { db.exec('ROLLBACK'); } catch {}
          return {shadow: true, imported: false, reason: 'JOURNAL_UNAVAILABLE'};
        }
      }
    });

    return journal;
  } catch (error) {
    db.close();
    throw error;
  }
}

// One bounded, injected shadow reconciliation. No real transport or write authority.
// The reader must normalize a fresh observation of the exact claim, not event text.
export async function reconcileJournalOnce({journal, repositoryId, owner, leaseMs, clock, read, stop, deferUnknown} = {}) {
  const result=reason=>({shadow:true,liveDispatch:false,liveMerge:false,reason});
  if(stop!==false)return result('STOPPED');
  if(!journal||typeof journal.claim!=='function'||typeof journal.complete!=='function'||
     typeof clock!=='function'||typeof read!=='function'||
     (deferUnknown!==undefined&&typeof deferUnknown!=='function'))return result('RUNTIME_UNKNOWN');
  try {
    const now=clock();
    if(!isTime(now))return result('CLOCK_UNKNOWN');
    const ticket=journal.claim(repositoryId,owner,now,leaseMs);
    if(!ticket)return result('NO_CLAIM');
    const evidence=await read(Object.freeze({repositoryId:ticket.repositoryId,kind:ticket.kind,
      subject:ticket.subject,head:ticket.head}));
    const finished=clock();
    if(!isTime(finished)||finished<now||finished>=ticket.leaseUntil)return result('LEASE_OR_CLOCK_UNKNOWN');
    if(!evidence||evidence.shadow!==true||evidence.fresh!==true||evidence.repositoryId!==ticket.repositoryId||
       evidence.kind!==ticket.kind||evidence.subject!==ticket.subject||!isHead(evidence.head)){
      // Mutate retry scheduling only after the same acquisition/expiry clock
      // validation used for completion. No second time sample or acknowledgement.
      if(deferUnknown!==undefined&&deferUnknown(ticket,finished)!==true)return result('RECONCILIATION_UNAVAILABLE');
      return result('EVIDENCE_UNKNOWN');
    }
    // A fresh moved head supersedes this hint; it does not authorize work on either head.
    if(journal.complete(ticket,finished)!==true)return result('CLAIM_LOST');
    return result(evidence.head===ticket.head?'SHADOW_RECONCILED':'SHADOW_HEAD_SUPERSEDED');
  } catch {return result('RECONCILIATION_UNAVAILABLE');}
}

export function exportJournalSnapshot(journal, options = {}) {
  const denied = reason => ({shadow: true, exported: false, reason});
  if (!isPlain(options)) return denied('INVALID_SCOPE');
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => key !== 'repositoryId' ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key) ?? {}, 'value'))) {
    return denied('INVALID_SCOPE');
  }
  const repositoryId = options.repositoryId ?? null;
  if (repositoryId !== null && !isRepo(repositoryId)) return denied('INVALID_SCOPE');
  const handle = journalHandles.get(journal);
  if (!handle) return denied('JOURNAL_UNAVAILABLE');
  return handle.exportSnapshot(repositoryId);
}

export function importJournalSnapshot(journal, snapshot) {
  const denied = reason => ({shadow: true, imported: false, reason});
  const handle = journalHandles.get(journal);
  if (!handle) return denied('JOURNAL_UNAVAILABLE');
  if (!hasOwnValues(snapshot, ['schemaVersion', 'shadow', 'entries'])) return denied('INVALID_SNAPSHOT');
  const keys = Reflect.ownKeys(snapshot);
  if (keys.some(key => !snapshotTopKeys.has(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(snapshot, key) ?? {}, 'value'))) {
    return denied('INVALID_SNAPSHOT');
  }
  if (snapshot.schemaVersion !== 1 || snapshot.shadow !== true || !isDenseArray(snapshot.entries)) {
    return denied('INVALID_SNAPSHOT');
  }
  const seen = new Set();
  for (const entry of snapshot.entries) {
    if (!validSnapshotEntry(entry)) return denied('INVALID_SNAPSHOT');
    const key = `${entry.repositoryId}:${entry.deliveryId}`;
    if (seen.has(key)) return denied('INVALID_SNAPSHOT');
    seen.add(key);
  }
  return handle.importSnapshot(snapshot.entries);
}
