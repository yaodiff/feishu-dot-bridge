/** Synthetic Linux file-boundary tests. No live targets, privileged chown or network. */
import { test as nodeTest } from 'node:test';
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { skip: process.platform !== 'linux' && 'Linux-only maintenance command' }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { runMaintenance } from '../scripts/maintenance.js';

function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'MOCK-maintenance-target-'));
  function database(name: string, pairs: number, parent = dir) {
    const path = join(parent, name), store = new Store(path);
    for (let i = 0; i < pairs; i++) store.db.prepare('INSERT INTO pairs VALUES (?,?,?)').run(`MOCK_pair_${i}`, 'MOCK_owner', 1);
    store.close(); return path;
  }
  const path = database('target.sqlite', 1), other = database('other.sqlite', 2);
  return { dir, path, other, database, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
function count(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM pairs').get()!.n; } finally { db.close(); }
}
function patchFs(name: 'readdirSync' | 'lstatSync' | 'fstatSync', replacement: Function) {
  const original = fs[name];
  (fs as unknown as Record<string, unknown>)[name] = replacement;
  syncBuiltinESMExports();
  return () => { (fs as unknown as Record<string, unknown>)[name] = original; syncBuiltinESMExports(); };
}

for (const mode of [0o666, 0o644, 0o640, 0o604, 0o400, 0o1600]) test(`rejects nonprivate/nonstandard target mode ${mode.toString(8)} without changing data`, () => {
  const f = fixture();
  try {
    const bytes = fs.readFileSync(f.path); fs.chmodSync(f.path, mode);
    for (const args of [['purge', '--dry-run'], ['purge'], ['revoke', 'a'.repeat(64)]]) assert.throws(() => runMaintenance(args, f.path), /Unsafe/);
    assert.deepEqual(fs.readFileSync(f.path), bytes); assert.equal(fs.statSync(f.path).mode & 0o7777, mode);
  } finally { f.cleanup(); }
});

test('rejects a hard-linked database and never follows a sidecar symlink', () => {
  const f = fixture();
  try {
    const bytes = fs.readFileSync(f.path), alias = join(f.dir, 'alias.sqlite');
    fs.linkSync(f.path, alias); assert.equal(fs.statSync(f.path).nlink, 2);
    assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /Unsafe/);
    fs.unlinkSync(alias);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      fs.symlinkSync(f.other, f.path + suffix);
      assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /Unsafe/);
      fs.unlinkSync(f.path + suffix);
    }
    assert.deepEqual(fs.readFileSync(f.path), bytes); assert.equal(count(f.other), 2);
  } finally { f.cleanup(); }
});

test('rejects unsafe sidecar mode and sidecar hard links', () => {
  const f = fixture();
  try {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const path = f.path + suffix, link = path + '.MOCK_alias';
      fs.writeFileSync(path, '', { mode: 0o644 });
      assert.throws(() => runMaintenance(['purge'], f.path), /Unsafe/);
      fs.chmodSync(path, 0o600); fs.linkSync(path, link);
      assert.throws(() => runMaintenance(['purge'], f.path), /Unsafe/);
      fs.unlinkSync(link); fs.unlinkSync(path);
    }
    assert.equal(count(f.path), 1);
  } finally { f.cleanup(); }
});

for (const scope of ['target', 'parent', 'opened-fd'] as const) test(`rejects foreign ownership of ${scope} (synthetic stat metadata; no privileged chown)`, () => {
  const f = fixture(); let restore = () => {};
  try {
    const uid = process.geteuid!() + 123, actual = fs.statSync(f.path);
    if (scope === 'opened-fd') {
      const original = fs.fstatSync;
      restore = patchFs('fstatSync', (fd: number, ...args: unknown[]) => {
        const stat = original(fd, ...args as []);
        return stat.dev === actual.dev && stat.ino === actual.ino ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid }) : stat;
      });
    } else {
      const original = fs.lstatSync;
      restore = patchFs('lstatSync', (path: fs.PathLike, ...args: unknown[]) => {
        const stat = original(path, ...args as []);
        return String(path) === (scope === 'target' ? f.path : f.dir) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid }) : stat;
      });
    }
    assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /Unsafe/);
  } finally { restore(); assert.equal(count(f.path), 1); f.cleanup(); }
});

test('requires an owner-only parent directory and refuses writable or symlink ancestors', () => {
  const f = fixture();
  try {
    fs.chmodSync(f.dir, 0o750); assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /Unsafe/); fs.chmodSync(f.dir, 0o700);
    const shared = join(f.dir, 'MOCK_shared'), privateDir = join(shared, 'MOCK_private');
    fs.mkdirSync(shared, { mode: 0o777 }); fs.chmodSync(shared, 0o777); fs.mkdirSync(privateDir, { mode: 0o700 });
    const nested = f.database('nested.sqlite', 1, privateDir);
    assert.throws(() => runMaintenance(['purge', '--dry-run'], nested), /Unsafe/);
    fs.chmodSync(shared, 0o755); assert.equal(runMaintenance(['purge', '--dry-run'], nested).counts!.pairs, 1);
    const linked = join(f.dir, 'MOCK_linked_parent'); fs.symlinkSync(privateDir, linked);
    assert.throws(() => runMaintenance(['purge', '--dry-run'], join(linked, 'nested.sqlite')), /Unsafe/);
  } finally { f.cleanup(); }
});

test('rejects inexact numeric inode identities rather than comparing rounded values', () => {
  const f = fixture(), original = fs.lstatSync; let restore = () => {};
  try {
    restore = patchFs('lstatSync', (path: fs.PathLike, ...args: unknown[]) => {
      const stat = original(path, ...args as []);
      return String(path) === f.path ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: Number.MAX_SAFE_INTEGER + 1 }) : stat;
    });
    assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /Unsafe/);
  } finally { restore(); assert.equal(count(f.path), 1); f.cleanup(); }
});

nodeTest('unsupported hosts and unavailable descriptor inspection fail closed without fallback', () => {
  const f = fixture(), platform = Object.getOwnPropertyDescriptor(process, 'platform')!; let restore = () => {};
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /requires Linux/);
    Object.defineProperty(process, 'platform', platform);
    if (platform.value !== 'linux') return;
    const original = fs.readdirSync;
    restore = patchFs('readdirSync', (path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === '/proc/self/fd') throw Object.assign(new Error('MOCK proc unavailable'), { code: 'ENOENT' });
      return original(path, ...args as []);
    });
    assert.throws(() => runMaintenance(['purge'], f.path), /MOCK proc unavailable/);
  } finally { Object.defineProperty(process, 'platform', platform); restore(); assert.equal(count(f.path), 1); f.cleanup(); }
});

for (const phase of ['read-open', 'write-open', 'swapped-back'] as const) test(`rejects actual opened replacement inode at ${phase}, including with a pre-existing expected fd`, () => {
  const f = fixture(), moved = join(f.dir, 'moved.sqlite'), held = fs.openSync(f.path, 'r');
  const original = fs.readdirSync; let calls = 0, swapped = false, restore = () => {};
  try {
    restore = patchFs('readdirSync', (path: fs.PathLike, ...args: unknown[]) => {
      const entries = original(path, ...args as []);
      if (String(path) === '/proc/self/fd') {
        calls++;
        if (calls === (phase === 'write-open' ? 3 : 1)) {
          // After final path guard and descriptor enumeration, before SQLite open.
          fs.renameSync(f.path, moved); fs.symlinkSync(f.other, f.path); swapped = true;
        } else if (phase === 'swapped-back' && calls === 2) {
          // Restore the pathname before post-open checks: inode binding must still fail.
          fs.unlinkSync(f.path); fs.renameSync(moved, f.path); swapped = false;
        }
      }
      return entries;
    });
    assert.throws(() => runMaintenance(phase === 'write-open' ? ['purge'] : ['purge', '--dry-run'], f.path), /Unsafe/);
    assert.ok(calls >= 2);
  } finally {
    restore(); fs.closeSync(held);
    if (swapped) { fs.unlinkSync(f.path); fs.renameSync(moved, f.path); }
    assert.equal(count(f.path), 1); assert.equal(count(f.other), 2); f.cleanup();
  }
});

test('descriptor-number reuse is identified by inode, not mistaken for a pre-existing handle', () => {
  const f = fixture(), held = fs.openSync(f.other, 'r'), original = fs.fstatSync; let released = false, restore = () => {};
  try {
    restore = patchFs('fstatSync', (fd: number, ...args: unknown[]) => {
      const stat = original(fd, ...args as []);
      if (fd === held && !released) { fs.closeSync(held); released = true; }
      return stat;
    });
    assert.equal(runMaintenance(['purge', '--dry-run'], f.path).counts!.pairs, 1); assert.equal(released, true);
  } finally { restore(); if (!released) fs.closeSync(held); f.cleanup(); }
});

test('ambiguous new unrelated regular descriptors cause refusal rather than guessing a handle', () => {
  const f = fixture(), original = fs.fstatSync; let extra: number | undefined, restore = () => {};
  try {
    restore = patchFs('fstatSync', (fd: number, ...args: unknown[]) => {
      try { return original(fd, ...args as []); }
      catch (error) {
        // Reuse the already-closed enumeration fd after the snapshot has found
        // it absent, leaving an additional regular fd alongside SQLite's fd.
        if ((error as NodeJS.ErrnoException).code === 'EBADF' && extra === undefined) extra = fs.openSync(f.other, 'r');
        throw error;
      }
    });
    assert.throws(() => runMaintenance(['purge', '--dry-run'], f.path), /Unsafe/);
  } finally { restore(); if (extra !== undefined) fs.closeSync(extra); assert.equal(count(f.path), 1); f.cleanup(); }
});

test('a vanished write target is never recreated between preflight and mode=rw open', () => {
  const f = fixture(), moved = join(f.dir, 'moved.sqlite'), original = fs.readdirSync; let calls = 0, restore = () => {};
  try {
    restore = patchFs('readdirSync', (path: fs.PathLike, ...args: unknown[]) => {
      const entries = original(path, ...args as []);
      if (String(path) === '/proc/self/fd' && ++calls === 3) fs.renameSync(f.path, moved);
      return entries;
    });
    assert.throws(() => runMaintenance(['purge'], f.path), /unable to open/);
    assert.equal(fs.existsSync(f.path), false);
  } finally { restore(); if (fs.existsSync(moved)) fs.renameSync(moved, f.path); assert.equal(count(f.path), 1); f.cleanup(); }
});

test('a detected target replacement during mutation rolls back prior deletes atomically', () => {
  const f = fixture(), moved = join(f.dir, 'moved.sqlite'), original = DatabaseSync.prototype.prepare; let swapped = false;
  try {
    DatabaseSync.prototype.prepare = function(sql: string) {
      if (sql.startsWith('DELETE FROM inbox') && !swapped) {
        fs.renameSync(f.path, moved); fs.symlinkSync(f.other, f.path); swapped = true;
      }
      return original.call(this, sql);
    };
    assert.throws(() => runMaintenance(['purge'], f.path)); assert.equal(swapped, true);
  } finally {
    DatabaseSync.prototype.prepare = original;
    if (swapped) { fs.unlinkSync(f.path); fs.renameSync(moved, f.path); }
    assert.equal(count(f.path), 1); assert.equal(count(f.other), 2); f.cleanup();
  }
});
