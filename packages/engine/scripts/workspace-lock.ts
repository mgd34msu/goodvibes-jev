import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

/**
 * Where the lock lives, the SHARED git directory, not this checkout.
 *
 * A linked worktree has its own `.tmp`, so keying the lock off the checkout
 * gave every worktree a private lock and two builds ran at once. They then
 * raced over one output tree: `build.ts` deletes the `dist` directory of every
 * workspace package before `tsc -b --force` regenerates it, so a second builder
 * could be reading a tree the first had just removed, and any consumer
 * dev-linked at that tree saw no SDK at all for the length of a rebuild.
 *
 * `git rev-parse --git-common-dir` resolves to the SAME directory from the main
 * checkout and from every worktree of it, which is exactly the scope the build
 * output has. A checkout that is not a git repository at all falls back to its
 * own `.tmp`, which is the old behaviour and still correct for a lone tree.
 */
function lockRoot(): string {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: SDK_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (commonDir) return resolve(commonDir, 'goodvibes-workspace');
  } catch {
    // Not a git checkout, or no git on PATH.
  }
  return resolve(SDK_ROOT, '.tmp');
}

const TMP_ROOT = lockRoot();
const LOCK_DIR = resolve(TMP_ROOT, 'workspace.lock');
const LOCK_INFO_PATH = resolve(LOCK_DIR, 'owner.json');
/**
 * How long to WAIT for the lock before giving up.
 *
 * Raised when the lock moved to the shared git directory. It now serializes
 * every worktree of this repository rather than each one separately, which is
 * the point, but it also means a legitimate queue is longer than it used to
 * be. A full suite is minutes, and several queued back to back are routinely
 * more than ten, so the old ceiling turned ordinary waiting into a failure.
 *
 * A holder that has actually died is reclaimed by the staleness check below
 * regardless of this value, so this is a deadlock ceiling, not a patience
 * budget.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const OWNER_PUBLICATION_GRACE_MS = 5_000;
const POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface LockInfo {
  readonly pid: number;
  readonly label: string;
  readonly startedAt: number;
  readonly token?: string;
}

interface LockSnapshot {
  readonly identity: Stats;
  readonly directory: string;
  readonly directoryIdentity: Stats | null;
  readonly info: LockInfo | null;
  readonly ownerIdentity: Stats | null;
  readonly token?: string;
}

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEANUP_PATTERN = /^cleanup-(.+)--([0-9]+)--([0-9a-f-]+)\.json$/;

function readLockInfo(path = LOCK_INFO_PATH): LockInfo | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('pid' in value) || !('label' in value) || !('startedAt' in value)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.label !== 'string' || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return null;
    if ('token' in value && (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token))) return null;
    return { pid: value.pid, label: value.label, startedAt: value.startedAt,
      ...('token' in value && typeof value.token === 'string' ? { token: value.token } : {}) };
  } catch { return null; }
}

function identity(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

function sameIdentity(left: Stats | null, right: Stats | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function sameOwner(left: LockInfo | null, right: LockInfo | null): boolean {
  if (!left || !right || left.pid !== right.pid) return false;
  return left.token !== undefined || right.token !== undefined
    ? left.token === right.token
    : left.label === right.label && left.startedAt === right.startedAt;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}

function observeLock(): LockSnapshot | null {
  const observed = identity(LOCK_DIR);
  if (!observed) return null;
  let directory = LOCK_DIR;
  let token: string | undefined;
  if (observed.isSymbolicLink()) {
    try {
      directory = resolve(TMP_ROOT, readlinkSync(LOCK_DIR));
      const prefix = 'workspace.owner-';
      const name = directory.slice(dirname(directory).length + 1);
      if (dirname(directory) !== TMP_ROOT || !name.startsWith(prefix)) return null;
      token = name.slice(prefix.length);
      if (!TOKEN_PATTERN.test(token)) return null;
    } catch { return null; }
  } else if (!observed.isDirectory()) return null;
  return { identity: observed, directory, directoryIdentity: identity(directory),
    info: readLockInfo(resolve(directory, 'owner.json')), ownerIdentity: identity(resolve(directory, 'owner.json')),
    ...(token ? { token } : {}) };
}

function isCurrent(snapshot: LockSnapshot): boolean {
  return sameIdentity(identity(LOCK_DIR), snapshot.identity)
    && sameIdentity(identity(snapshot.directory), snapshot.directoryIdentity);
}

function unlinkIfPresent(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}

function removeEmptyDirectory(path: string): void {
  try { rmdirSync(path); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(String(error.code)))) throw error;
  }
}

function claimLegacyCleanup(directory: string, token: string): { readonly ownPath: string } | undefined {
  const cleanupToken = randomUUID();
  const prepared = resolve(TMP_ROOT, `workspace.cleanup-${cleanupToken}.json`);
  const owner: LockInfo = { pid: process.pid, label: 'legacy lock cleanup', startedAt: Date.now(), token: cleanupToken };
  writeFileSync(prepared, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
  const paths = new Set<string>();
  let predecessor = 'initial';
  try {
    while (true) {
      const path = resolve(directory, `legacy-cleanup.${token}.${predecessor}.json`);
      if (paths.has(path)) return undefined;
      paths.add(path);
      try { linkSync(prepared, path); return { ownPath: path }; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) return undefined; }
      const previous = readLockInfo(path);
      if (!previous?.token || isProcessAlive(previous.pid)) return undefined;
      predecessor = previous.token;
    }
  } finally { unlinkIfPresent(prepared); }
}

/** A unique marker rename gives exactly one cleaner the observed generation. */
function cleanGeneration(snapshot: LockSnapshot, releasing?: LockInfo): void {
  if (!isCurrent(snapshot)) return;
  if (releasing) {
    if (!sameOwner(snapshot.info, releasing)) return;
  } else if (snapshot.info && isProcessAlive(snapshot.info.pid)) return;

  const ownerPath = resolve(snapshot.directory, 'owner.json');
  let token = snapshot.info?.token ?? snapshot.token;
  let marker: string | undefined;
  let legacyLease: ReturnType<typeof claimLegacyCleanup>;
  if (token) marker = resolve(snapshot.directory, `ownership.${token}.json`);
  if (marker && !identity(marker)) marker = undefined;

  if (!marker && snapshot.info && !snapshot.info.token && snapshot.ownerIdentity) {
    // A hard link captures the exact legacy inode without moving owner.json.
    token = `legacy-${snapshot.ownerIdentity.dev}-${snapshot.ownerIdentity.ino}`;
    legacyLease = claimLegacyCleanup(snapshot.directory, token);
    if (!legacyLease) return;
    const priorClaim = readdirSync(snapshot.directory).find(name => {
      const match = CLEANUP_PATTERN.exec(name);
      return match?.[1] === token;
    });
    if (priorClaim) {
      const match = CLEANUP_PATTERN.exec(priorClaim);
      if (!match?.[2] || isProcessAlive(Number(match[2]))) { unlinkIfPresent(legacyLease.ownPath); return; }
      marker = resolve(snapshot.directory, priorClaim);
    } else {
      const legacyMarker = resolve(snapshot.directory, `ownership.${token}.json`);
      try { linkSync(ownerPath, legacyMarker); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) { unlinkIfPresent(legacyLease.ownPath); return; }
      }
      if (!sameIdentity(identity(legacyMarker), snapshot.ownerIdentity)
        || !sameOwner(readLockInfo(legacyMarker), snapshot.info) || !isCurrent(snapshot)) {
        unlinkIfPresent(legacyMarker); unlinkIfPresent(legacyLease.ownPath); return;
      }
      marker = legacyMarker;
    }
  }

  if (!marker) {
    let names: string[];
    try { names = readdirSync(snapshot.directory); } catch { return; }
    for (const name of names) {
      const match = CLEANUP_PATTERN.exec(name);
      if (!match || !match[1] || !match[2] || (token && match[1] !== token)) continue;
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) return;
      const claimPath = resolve(snapshot.directory, name);
      const claimedOwner = readLockInfo(claimPath);
      if (snapshot.info && !sameOwner(claimedOwner, snapshot.info)) continue;
      token = match[1]; marker = claimPath; break;
    }
  }
  if (!marker || !token || !isCurrent(snapshot)) { if (legacyLease) unlinkIfPresent(legacyLease.ownPath); return; }
  const markerIdentity = identity(marker);
  const claim = resolve(snapshot.directory, `cleanup-${token}--${process.pid}--${randomUUID()}.json`);
  try { renameSync(marker, claim); } catch { if (legacyLease) unlinkIfPresent(legacyLease.ownPath); return; }
  if (!sameIdentity(identity(claim), markerIdentity) || !isCurrent(snapshot)) {
    unlinkIfPresent(claim); if (legacyLease) unlinkIfPresent(legacyLease.ownPath); return;
  }
  const currentOwner = readLockInfo(ownerPath);
  if (snapshot.info
    ? !sameOwner(currentOwner, snapshot.info) || !sameIdentity(identity(ownerPath), snapshot.ownerIdentity)
    : currentOwner !== null) {
    // Restore only this generation's unique marker; never touch another owner.
    try { renameSync(claim, marker); } catch { unlinkIfPresent(claim); }
    if (legacyLease) unlinkIfPresent(legacyLease.ownPath);
    return;
  }
  if (snapshot.identity.isSymbolicLink()) {
    if (sameIdentity(identity(LOCK_DIR), snapshot.identity)) unlinkIfPresent(LOCK_DIR);
    else { unlinkIfPresent(claim); if (legacyLease) unlinkIfPresent(legacyLease.ownPath); return; }
  }
  unlinkIfPresent(ownerPath);
  for (const name of readdirSync(snapshot.directory)) {
    if (!name.startsWith(`legacy-cleanup.${token}.`)) continue;
    const path = resolve(snapshot.directory, name);
    const lease = readLockInfo(path);
    if (lease && (lease.pid === process.pid || !isProcessAlive(lease.pid))) unlinkIfPresent(path);
  }
  unlinkIfPresent(claim);
  removeEmptyDirectory(snapshot.directory);
}

function clearStaleLock(): void {
  const snapshot = observeLock();
  if (!snapshot) return;
  if (snapshot.info) { cleanGeneration(snapshot); return; }
  // A live cleanup claim remains authoritative after owner.json is removed.
  let names: string[];
  try { names = readdirSync(snapshot.directory); } catch { return; }
  if (names.some(name => CLEANUP_PATTERN.test(name))) { cleanGeneration(snapshot); return; }
  const created = snapshot.directoryIdentity;
  if (!created || Date.now() - created.mtimeMs < OWNER_PUBLICATION_GRACE_MS || names.length > 0) return;
  if (isCurrent(snapshot)) removeEmptyDirectory(snapshot.directory);
}

function ownerDescription(): string {
  const info = readLockInfo();
  return info ? `${info.label} (pid ${info.pid}, started ${new Date(info.startedAt).toISOString()})` : 'unknown owner';
}

export async function waitForWorkspaceLockRelease(label: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (identity(LOCK_DIR)) {
    clearStaleLock();
    if (!identity(LOCK_DIR)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for workspace lock before ${label}; current owner: ${ownerDescription()}`);
    await sleep(POLL_MS);
  }
}

export async function withWorkspaceLock<T>(label: string, fn: () => T | Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const owner: LockInfo = { pid: process.pid, label, startedAt: Date.now(), token };
  const directory = resolve(TMP_ROOT, `workspace.owner-${token}`);
  mkdirSync(directory);
  let acquired: LockSnapshot | undefined;
  try {
    const ownerPath = resolve(directory, 'owner.json');
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    linkSync(ownerPath, resolve(directory, `ownership.${token}.json`));
    while (true) {
      clearStaleLock();
      try {
        // The complete generation is visible in a single exclusive operation.
        symlinkSync(directory, LOCK_DIR, process.platform === 'win32' ? 'junction' : 'dir');
        const snapshot = observeLock();
        if (!snapshot || !sameOwner(snapshot.info, owner)) throw new Error(`Lost workspace lock during acquisition for ${label}`);
        acquired = snapshot; break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        if (Date.now() > deadline) throw new Error(`Timed out acquiring workspace lock for ${label}; current owner: ${ownerDescription()}`);
        await sleep(POLL_MS);
      }
    }
    return await fn();
  } finally {
    if (acquired) cleanGeneration(acquired, owner);
    // Unpublished or superseded candidates are owned by this unique token.
    if (sameOwner(readLockInfo(resolve(directory, 'owner.json')), owner)
      && (!acquired || !sameIdentity(identity(LOCK_DIR), acquired.identity))) {
      unlinkIfPresent(resolve(directory, 'owner.json'));
      unlinkIfPresent(resolve(directory, `ownership.${token}.json`));
      removeEmptyDirectory(directory);
    }
  }
}
