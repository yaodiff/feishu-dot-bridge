import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
/** Secrets are local only: reject symlinks, shared permissions and non-owner files. */
export function readPrivateFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('permissions');
    return readFileSync(fd, 'utf8').trim();
  } catch { throw new Error('Secret file must be an owner-only regular file (0600), not a symlink'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readConfiguredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name], file = env[`${name}_FILE`];
  if ((value !== undefined) === (file !== undefined)) throw new Error(`Configure exactly one of ${name} or ${name}_FILE`);
  const result = file !== undefined ? readPrivateFile(file) : value!;
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
