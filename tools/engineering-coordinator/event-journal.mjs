import {DatabaseSync} from 'node:sqlite';

const eventKinds = new Set(['issue', 'pull', 'review', 'check', 'main', 'manual']);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isRepo = value => isTime(value) && value > 0;
const isToken = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const isHead = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const rejected = reason => ({queued: false, reason});

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
      CREATE INDEX IF NOT EXISTS coordinator_events_pending
        ON coordinator_events (repository_id, completed, id);
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
          AND NOT EXISTS (
            SELECT 1 FROM coordinator_events AS active
            WHERE active.repository_id = pending.repository_id
              AND active.completed = 0 AND active.expires > ?
          )
        ORDER BY pending.id LIMIT 1
      )
      RETURNING delivery_id AS deliveryId, kind, subject, head, generation
    `);
    const complete = db.prepare(`
      UPDATE coordinator_events SET completed = 1, expires = 0
      WHERE repository_id = ? AND delivery_id = ? AND owner = ?
        AND generation = ? AND completed = 0 AND expires > ?
    `);

    return Object.freeze({
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
          const event = claim.get(owner, now + leaseMs, repositoryId, now, kind, kind, now);
          return event ? {...event, repositoryId, owner, leaseUntil: now + leaseMs} : null;
        } catch { return null; }
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
  } catch (error) {
    db.close();
    throw error;
  }
}

// One bounded, injected shadow reconciliation. No real transport or write authority.
// The reader must normalize a fresh observation of the exact claim, not event text.
export async function reconcileJournalOnce({journal, repositoryId, owner, leaseMs, clock, read, stop} = {}) {
  const result=reason=>({shadow:true,liveDispatch:false,liveMerge:false,reason});
  if(stop!==false)return result('STOPPED');
  if(!journal||typeof journal.claim!=='function'||typeof journal.complete!=='function'||
     typeof clock!=='function'||typeof read!=='function')return result('RUNTIME_UNKNOWN');
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
       evidence.kind!==ticket.kind||evidence.subject!==ticket.subject||!isHead(evidence.head))return result('EVIDENCE_UNKNOWN');
    // A fresh moved head supersedes this hint; it does not authorize work on either head.
    if(journal.complete(ticket,finished)!==true)return result('CLAIM_LOST');
    return result(evidence.head===ticket.head?'SHADOW_RECONCILED':'SHADOW_HEAD_SUPERSEDED');
  } catch {return result('RECONCILIATION_UNAVAILABLE');}
}
