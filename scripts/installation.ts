import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PACKAGE = 'goodvibes-jev';
export const SERVICE = 'goodvibes-jev.service';
export const COMMANDS = ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon', 'goodvibes-uninstall'] as const;
export interface Layout { prefix: string; binDir: string; dataDir: string; home: string }
export interface Installation extends Layout {
  schema: 1;
  package: typeof PACKAGE;
  id: string;
  release: string;
  sourceCommit: string;
  port: number;
  service: boolean;
  unit: string;
  wrappers: Record<string, string>;
}
export type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean }) => string;
export const run: Run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) {
    // Never echo argv/environment: config commands may carry credentials.
    throw new Error(`${command} failed${result.status === null ? '' : ` (${result.status})`}${options.capture && result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
};
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const present = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
export function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
/** No installation or deletion through a symlink, including a dangling one. */
export function plainPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error(`Expected a normalized absolute path: ${path}`);
  let current = path;
  for (;;) {
    if (present(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink path: ${current}`);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function validateLayout(layout: Layout): void {
  const { prefix, binDir, dataDir, home } = layout;
  plainPath(home);
  for (const path of [prefix, binDir, dataDir]) {
    plainPath(path);
    if (!contained(home, path) || path === home) throw new Error('Installation, commands and data must be separate directories below your home.');
  }
  for (const [a, b] of [[prefix, binDir], [prefix, dataDir], [binDir, dataDir]]) {
    if (contained(a!, b!) || contained(b!, a!)) throw new Error('Installation, command and data directories must not overlap.');
  }
  const unit = unitPath(layout);
  plainPath(unit);
  if ([prefix, binDir, dataDir].some(path => contained(path, unit))) throw new Error('Installation paths must not contain the systemd unit directory.');
}
export const unitPath = (layout: Layout): string => join(layout.home, '.config/systemd/user', SERVICE);
export const receiptPath = (layout: Layout): string => join(layout.prefix, 'installation.json');
export function atomicWrite(path: string, contents: string, mode = 0o600): void {
  plainPath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.pending-${process.pid}`;
  writeFileSync(pending, contents, { mode, flag: 'wx' });
  try { chmodSync(pending, mode); renameSync(pending, path); } finally { rmSync(pending, { force: true }); }
}
export function readInstallation(prefix: string): Installation | undefined {
  plainPath(prefix);
  const path = join(prefix, 'installation.json');
  if (!present(path)) return undefined;
  plainPath(path);
  const value = JSON.parse(readFileSync(path, 'utf8')) as Installation;
  if (value.schema !== 1 || value.package !== PACKAGE || value.prefix !== prefix || !/^[0-9a-f-]{36}$/.test(value.id)
    || !/^[0-9a-f]{40}-[0-9a-f-]{36}$/.test(value.release) || !/^[0-9a-f]{40}$/.test(value.sourceCommit)
    || typeof value.service !== 'boolean' || typeof value.unit !== 'string' || !value.wrappers
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('Invalid Jev installation receipt.');
  validateLayout(value);
  for (const name of COMMANDS) if (typeof value.wrappers[name] !== 'string') throw new Error('Invalid command ownership receipt.');
  return value;
}
export function dataOwner(layout: Layout): string { return join(layout.dataDir, '.goodvibes-jev-owner.json'); }
export function readDataId(layout: Layout): string | undefined {
  const marker = dataOwner(layout); plainPath(marker);
  if (!present(marker)) return undefined;
  const value = JSON.parse(readFileSync(marker, 'utf8')) as { package?: string; id?: string; dataDir?: string };
  if (value.package !== PACKAGE || value.dataDir !== layout.dataDir || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) throw new Error('Invalid Jev data ownership marker.');
  return value.id;
}
export function assertOwnedFiles(receipt: Installation): void {
  validateLayout(receipt);
  for (const name of COMMANDS) {
    const link = join(receipt.binDir, name);
    if (present(link) && (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== join(receipt.prefix, 'commands', name))) {
      throw new Error(`Refusing to replace or remove another installation: ${link}`);
    }
    const wrapper = join(receipt.prefix, 'commands', name); plainPath(wrapper);
    if (present(wrapper) && digest(readFileSync(wrapper)) !== receipt.wrappers[name]) throw new Error(`Managed command has been modified: ${wrapper}`);
  }
  const unit = unitPath(receipt); plainPath(unit);
  if (present(unit) && (!receipt.service || digest(readFileSync(unit)) !== receipt.unit)) throw new Error(`Service has been modified or is not owned: ${unit}`);
  const current = join(receipt.prefix, 'current');
  if (present(current) && (!lstatSync(current).isSymbolicLink() || readlinkSync(current) !== `releases/${receipt.release}`)) throw new Error('Installation current link has changed.');
  plainPath(join(receipt.prefix, 'releases', receipt.release));
  if (readDataId(receipt) !== receipt.id) throw new Error('User data does not belong to this installation.');
}
export function withLock<T>(prefix: string, work: () => Promise<T>): Promise<T> {
  plainPath(prefix); mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  const lock = `${prefix}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error(`Another install/uninstall may be running (${lock}). If an earlier process was killed, remove this empty lock directory after checking it has stopped.`); }
  return work().finally(() => rmSync(lock, { recursive: true }));
}
export function assertServiceLocation(receipt: Installation, execute: Run): void {
  const fragment = execute('systemctl', ['--user', 'show', SERVICE, '--property=FragmentPath', '--value'], { capture: true });
  if (fragment && fragment !== unitPath(receipt)) throw new Error(`Systemd loaded a different ${SERVICE}; refusing to manage it.`);
}
export function stopService(receipt: Installation, execute: Run): void {
  assertServiceLocation(receipt, execute);
  execute('systemctl', ['--user', 'stop', SERVICE]);
  const state = execute('systemctl', ['--user', 'show', SERVICE, '--property=ActiveState', '--value'], { capture: true });
  if (state !== 'inactive' && state !== 'failed') throw new Error('The daemon has not stopped; keeping the installation intact.');
}
export async function uninstall(prefix: string, purge: boolean, execute: Run = run): Promise<void> {
  await withLock(prefix, async () => {
    const receipt = readInstallation(prefix);
    if (!receipt) { console.log(`No Jev installation at ${prefix}. Preserved data remains untouched.`); return; }
    if (realpathSync(process.env.HOME ?? '') !== receipt.home) throw new Error('Run uninstall as the user who owns this installation.');
    assertOwnedFiles(receipt);
    if (receipt.service) {
      stopService(receipt, execute);
      execute('systemctl', ['--user', 'disable', SERVICE]);
      rmSync(unitPath(receipt), { force: true });
      execute('systemctl', ['--user', 'daemon-reload']);
    }
    for (const name of COMMANDS) rmSync(join(receipt.binDir, name), { force: true });
    // Data lives outside the program prefix. Only an explicit purge removes it.
    if (purge) { plainPath(receipt.dataDir); rmSync(receipt.dataDir, { recursive: true }); }
    rmSync(prefix, { recursive: true });
    console.log(purge ? 'GoodVibes Jev uninstalled, including its data.' : `GoodVibes Jev uninstalled. Data and credentials preserved at ${receipt.dataDir}`);
  });
}
