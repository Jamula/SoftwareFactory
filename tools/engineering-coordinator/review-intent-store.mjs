import {DatabaseSync} from 'node:sqlite';

// Shadow-only intent ledger. A claimed key is never automatically released;
// uncertainty, process death or retry exhaustion cannot grant another write.
export function openReviewIntentStore(filename) {
  const db = new DatabaseSync(filename, {timeout: 250});
  try {
    db.exec('CREATE TABLE IF NOT EXISTS coordinator_review_intents (intent_key TEXT PRIMARY KEY NOT NULL)');
    // An explicit conflict target fails preparation if an existing schema lacks key uniqueness.
    const insert = db.prepare('INSERT INTO coordinator_review_intents(intent_key) SELECT ? WHERE (SELECT count(*) FROM coordinator_review_intents) < 10000 ON CONFLICT(intent_key) DO NOTHING');
    return Object.freeze({
      claim(key) {
        if (typeof key !== 'string' || key.length > 300 ||
            !/^[a-z0-9_-]+\/[a-z0-9_.-]+:[1-9][0-9]*:[a-f0-9]{40}$/.test(key)) return false;
        try { return insert.run(key).changes === 1; }
        catch { return false; }
      },
      close() { db.close(); }
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
