/** Linux-only offline file guards. Same-UID/root processes must be trusted and quiescent. */
import { DatabaseSync } from 'node:sqlite';
import { fstatSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const sameFile = (a: Stats, b: Stats) => [a.dev, a.ino, b.dev, b.ino].every(Number.isSafeInteger)
  && a.dev === b.dev && a.ino === b.ino;
const fail = () => { throw new Error('Unsafe or changed maintenance target; no successful maintenance result'); };

function descriptors(): Map<number, Stats> {
  const result = new Map<number, Stats>();
  for (const name of readdirSync('/proc/self/fd')) {
    const fd = Number(name);
    if (!Number.isSafeInteger(fd)) fail();
    try { result.set(fd, fstatSync(fd)); }
    catch (error) {
      // The fd used to enumerate this directory is closed by readdirSync itself.
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  return result;
}

export class MaintenanceTarget {
  private readonly path: string;
  private readonly uid: number;
  private readonly initial: Stats;
  private readonly ancestors: { path: string; stat: Stats }[];
  constructor(path: string | undefined) {
    if (process.platform !== 'linux' || !process.geteuid) throw new Error('Maintenance requires Linux with /proc/self/fd; no portable fallback');
    this.uid = process.geteuid();
    if (!path || path.includes('\0') || path === ':memory:' || path.startsWith('file:')) fail();
    this.path = resolve(path!);
    const parent = dirname(this.path), root = parse(parent).root;
    const paths = [root];
    for (const part of parent.slice(root.length).split(sep).filter(Boolean)) paths.push(resolve(paths.at(-1)!, part));
    this.ancestors = paths.map(path => ({ path, stat: lstatSync(path) }));
    this.initial = lstatSync(this.path);
    this.checkPath();
  }
  private privateFile(stat: Stats) {
    if (!stat.isFile() || stat.uid !== this.uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) fail();
  }
  private checkPath() {
    for (const [index, entry] of this.ancestors.entries()) {
      const stat = lstatSync(entry.path);
      if (!stat.isDirectory() || !sameFile(stat, entry.stat) || (stat.uid !== this.uid && stat.uid !== 0)) fail();
      if (index === this.ancestors.length - 1) {
        if (stat.uid !== this.uid || (stat.mode & 0o7777) !== 0o700) fail();
      } else if (stat.mode & 0o022) {
        // A root-owned sticky shared ancestor such as /tmp cannot remove another
        // user's private directory. Its owner/root is already in the trust model.
        if (stat.uid !== 0 || !(stat.mode & 0o1000)) fail();
      }
    }
    const current = lstatSync(this.path);
    this.privateFile(current);
    if (current.size === 0 || !sameFile(current, this.initial)) fail();
    // SQLite opens sidecars by pathname too. Never follow a planted link or use
    // a shared/foreign-owned journal. SQLite may legitimately create/remove them.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { this.privateFile(lstatSync(this.path + suffix)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  open(readOnly: boolean) {
    this.checkPath();
    const before = descriptors(), uri = pathToFileURL(this.path);
    uri.searchParams.set('mode', readOnly ? 'ro' : 'rw'); // Never CREATE a missing file.
    const db = new DatabaseSync(uri.href, { readOnly, enableForeignKeyConstraints: true, allowExtension: false, timeout: 0 });
    try {
      // This synchronous standalone command must acquire exactly one new regular
      // fd at SQLite open. Refuse ambiguous handles rather than infer a pathname.
      const opened = [...descriptors()].filter(([fd, stat]) => stat.isFile() && (!before.has(fd) || !sameFile(stat, before.get(fd)!)));
      if (opened.length !== 1) fail();
      const [fd, stat] = opened[0]!;
      this.privateFile(stat);
      if (!sameFile(stat, this.initial)) fail();
      const check = () => {
        const actual = fstatSync(fd);
        this.privateFile(actual);
        if (!sameFile(actual, this.initial)) fail();
        this.checkPath();
      };
      check(); // Check the actual opened inode before application SQL, not a prior stat.
      db.exec('PRAGMA trusted_schema=OFF');
      return { db, check };
    } catch (error) { db.close(); throw error; }
  }
}
