/** Offline-only maintenance. Stop the bridge process before invoking this script. */
import { Store } from '../src/store.js';
const path = process.env.DATABASE_PATH ?? './data/bridge.sqlite';
const operation = process.argv[2];
if (!['purge', 'revoke'].includes(operation ?? '')) throw new Error('Usage: node dist/scripts/maintenance.js purge | revoke <principal-hash>');
const store = new Store(path);
try {
  if (operation === 'revoke') { const owner = process.argv[3]; if (!owner || !/^[a-f0-9]{64}$/.test(owner)) throw new Error('Expected principal SHA256 hash from your administrator identity mapping'); store.revoke(owner); console.log('{"event":"account_revoked"}'); }
  else {
    const cutoff = Date.now() - 30 * 86400000;
    store.transaction(() => {
      store.db.prepare('DELETE FROM pairs WHERE expiresAt<?').run(Date.now());
      store.db.prepare('DELETE FROM receipts WHERE receivedAt<?').run(cutoff);
      store.db.prepare('DELETE FROM jobs WHERE inboxId IN (SELECT id FROM inbox WHERE timestamp<?)').run(new Date(cutoff).toISOString());
      store.db.prepare('DELETE FROM inbox WHERE timestamp<?').run(new Date(cutoff).toISOString());
      store.db.prepare('DELETE FROM subscriptions WHERE expiresAt<?').run(cutoff);
      store.db.prepare('DELETE FROM bindings WHERE active=0 AND id NOT IN (SELECT bindingId FROM inbox) AND id NOT IN (SELECT bindingId FROM subscriptions)').run();
    });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    console.log('{"event":"retention_purge_complete","retention_days":30}');
  }
} finally { store.close(); }
