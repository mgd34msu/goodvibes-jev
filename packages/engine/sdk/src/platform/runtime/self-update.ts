/**
 * Verified binary updates with owned staging and compensating cohort renames.
 * Individual same-filesystem renames are atomic; the cohort and the brief gap
 * between parking and replacing a live file are NOT filesystem-wide atomic.
 * Failed commits restore their prior state or retain an explicit recovery fence.
 * Process crashes require inspection of the retained transaction files; this is
 * not a power-loss durable journal or a guarantee against unrelated writers.
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { compareSemanticVersions, parseSemanticVersion } from './semantic-version.js';

/**
 * The cadence half of the same mechanism, re-exported here so every consumer
 * reaches "when to look" and "what to do when something is found" through one
 * module instead of two competing update stories. See update-schedule.ts.
 */
export {
  BOOT_SETTLE_CHECK_DELAY_MS,
  DEFAULT_UPDATE_BUSY_RETRY_MS,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  PeriodicUpdateLoop,
  type PeriodicCheckOutcome,
  type PeriodicUpdateLoopOptions,
} from './update-schedule.js';

// ---------------------------------------------------------------------------
// Version + release-tag logic
// ---------------------------------------------------------------------------

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/** SemVer precedence, retaining the historical short-core `1.2` == `1.2.0` form. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (raw: string) => {
    const normalized = normalizeVersion(raw);
    const padded = normalized.replace(/^(\d+(?:\.\d+)?)(?=[-+]|$)/, (core) => core + (core.includes('.') ? '.0' : '.0.0'));
    const parsed = parseSemanticVersion(padded);
    if (!parsed) throw new Error(`invalid update version: ${raw}`);
    return parsed;
  };
  return compareSemanticVersions(parse(a), parse(b));
}

/** Extract only a valid SemVer tag from a releases/tag path, never a login page. */
export function parseReleaseTagFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, 'https://release.invalid');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const match = /\/releases\/tag\/([^/]+)\/?$/.exec(url.pathname);
    const tag = match?.[1];
    return tag && parseSemanticVersion(normalizeVersion(tag)) ? tag : null;
  } catch {
    return null;
  }
}

/** Minimal fetch shape; injected implementations must not make filesystem changes. */
export interface UpdateFetchLike {
  (url: string, init?: { method?: string; redirect?: 'manual' | 'follow' | 'error'; signal?: AbortSignal }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly url: string;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface UpdateRequestOptions {
  readonly signal?: AbortSignal;
  /** Whole operation budget, including response bodies. Defaults to two minutes. */
  readonly timeoutMs?: number;
}
export const DEFAULT_UPDATE_TIMEOUT_MS = 120_000;

/** Bound even injected fetch/body implementations that ignore AbortSignal. */
async function withUpdateBudget<T>(options: UpdateRequestOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('update timeoutMs must be positive and finite');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? new Error('update cancelled'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`update timed out after ${Math.ceil(timeoutMs)}ms`)), timeoutMs);
  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    // Release a native transport/body left unread after a rejected response,
    // and stop any adapter that is still completing after losing the race.
    controller.abort(new Error('update request scope ended'));
  }
}

/** Validate a manual latest redirect against the caller's exact origin/repository. */
export async function resolveLatestReleaseTag(
  fetchImpl: UpdateFetchLike,
  releasesLatestUrl: string,
  options: UpdateRequestOptions = {},
): Promise<string> {
  const latest = new URL(releasesLatestUrl);
  if (!['https:', 'http:'].includes(latest.protocol) || latest.username || latest.password || latest.search || latest.hash
    || !latest.pathname.endsWith('/releases/latest')) throw new Error('invalid releases/latest URL');
  return await withUpdateBudget(options, async (signal) => {
    const response = await fetchImpl(releasesLatestUrl, { method: 'HEAD', redirect: 'manual', signal });
    signal.throwIfAborted();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location || response.url !== releasesLatestUrl) {
      throw new Error(`could not resolve the latest release tag from ${releasesLatestUrl} (expected manual release redirect; status ${response.status})`);
    }
    const redirected = new URL(location, latest);
    const tag = parseReleaseTagFromLocation(redirected.href);
    const prefix = latest.pathname.slice(0, -'latest'.length) + 'tag/';
    if (!tag || redirected.origin !== latest.origin || redirected.pathname !== `${prefix}${tag}`) {
      throw new Error('could not resolve the latest release tag: untrusted or malformed release redirect');
    }
    return tag;
  });
}

// ---------------------------------------------------------------------------
// Release-artifact naming + checksum verification
// ---------------------------------------------------------------------------

export const CHECKSUM_MANIFEST_NAME = 'SHA256SUMS.txt';

export interface ReleaseArtifactNames {
  readonly app: string;
  readonly daemon: string;
}

/** Release-asset platform tag as used in artifact filenames ("linux" | "macos"). */
const PLATFORM_TAGS: Record<string, string> = {
  linux: 'linux',
  darwin: 'macos',
};

export function resolveArtifactNames(platform: string, arch: string): ReleaseArtifactNames | null {
  const platformTag = PLATFORM_TAGS[platform];
  if (!platformTag || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = `${platformTag}-${arch}`;
  return {
    app: `goodvibes-${suffix}`,
    daemon: `goodvibes-daemon-${suffix}`,
  };
}

export interface SqliteVecAsset {
  /** Release asset filename, e.g. `sqlite-vec-linux-x64.so`. */
  readonly assetName: string;
  /** Directory name the loader resolves, e.g. `sqlite-vec-linux-x64`. */
  readonly dirName: string;
  /** File the loader opens inside that directory, e.g. `vec0.so`. */
  readonly fileName: string;
}

/**
 * Names the sqlite-vec native addon for a platform/arch. Unlike the binaries
 * (whose release tag maps darwin to "macos"), the addon keeps the Node-style
 * platform tag because that is exactly what the extension loader resolves at
 * `<execDir>/lib/sqlite-vec-<platform>-<arch>/vec0.<suffix>`.
 */
export function resolveSqliteVecAsset(platform: string, arch: string): SqliteVecAsset | null {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = platform === 'darwin' ? 'dylib' : 'so';
  const dirName = `sqlite-vec-${platform}-${arch}`;
  return {
    assetName: `${dirName}.${suffix}`,
    dirName,
    fileName: `vec0.${suffix}`,
  };
}

export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function parseChecksumFile(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const name = match[2]!;
    const digest = match[1]!.toLowerCase();
    if (checksums.has(name) && checksums.get(name) !== digest) throw new Error(`conflicting checksum entries for ${name}`);
    checksums.set(name, digest);
  }
  return checksums;
}

/**
 * Verify a downloaded artifact's checksum against the parsed manifest.
 * An artifact with no entry in the manifest is a hard failure, identical
 * in severity to a mismatching entry, never treated as "unverifiable, so
 * skip the check". Throws naming the artifact and the manifest.
 */
export function verifyChecksum(
  artifactName: string,
  actual: string,
  expected: string | undefined,
  manifestName: string = CHECKSUM_MANIFEST_NAME,
): void {
  if (expected === undefined) {
    throw new Error(`no checksum entry for ${artifactName} in ${manifestName}, refusing to install an unverified binary`);
  }
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Owned staging, reversible cohort commit, and kept-previous rollback
// ---------------------------------------------------------------------------

export const PREVIOUS_FILE_SUFFIX = '.previous';

/**
 * Injectable filesystem surface. Existing adapters remain source compatible,
 * but mutations fail closed until they implement exclusive claims and cleanup.
 * rename must either succeed or throw without changing either path. Install
 * directories must be trusted: unrelated writers and parent symlink changes
 * cannot be fenced by this interface.
 */
export interface UpdateFileIo {
  writeFile(path: string, data: Buffer): void;
  rename(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
  /** Atomically create a file, failing without modifying it if it already exists. */
  writeExclusive?(path: string, data: Buffer): void;
  /** Remove an owned file; a missing file is a successful no-op. */
  remove?(path: string): void;
}

export const realUpdateFileIo: UpdateFileIo = {
  writeFile: (path, data) => writeFileSync(path, data),
  writeExclusive: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  chmod: (path, mode) => chmodSync(path, mode),
  // lstat sees dangling symlinks too; they must never be mistaken for empty slots.
  exists: (path) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  remove: (path) => {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  },
};

export interface UpdateTarget {
  readonly label: string;
  /** Absolute, normalized install path. */
  readonly path: string;
  readonly assetName: string;
  readonly executable: boolean;
}

export interface UpdateTransactionReceipt {
  readonly operation: 'update' | 'rollback';
  readonly phase: 'claim' | 'stage' | 'admission' | 'commit' | 'cleanup';
  /** True only if the complete requested cohort reached its new state. */
  readonly committed: boolean;
  readonly recoveryRequired: boolean;
  readonly targets: readonly string[];
  /** Owned paths retained for inspection; never automatically overwrite these. */
  readonly recoveryPaths: readonly string[];
  readonly recoveryErrors: readonly string[];
}

export class UpdateTransactionError extends Error {
  constructor(readonly receipt: UpdateTransactionReceipt, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${receipt.operation} ${receipt.phase} failed: ${detail}; `
      + (receipt.committed ? 'cohort committed' : 'cohort not committed')
      + (receipt.recoveryRequired ? '; recovery required, blind retry is fenced' : '; prior state restored'), { cause });
    this.name = 'UpdateTransactionError';
  }
}

interface TransactionPaths {
  readonly target: string;
  readonly previous: string;
  readonly stage: string;
  readonly saved: string;
  readonly exchange: string;
  readonly claim: string;
}

/** Capture adapter methods before asynchronous caller preparation can replace them. */
export function captureUpdateFileIo(io: UpdateFileIo): UpdateFileIo {
  return {
    writeFile: io.writeFile.bind(io), rename: io.rename.bind(io), chmod: io.chmod.bind(io),
    exists: io.exists.bind(io), mkdir: io.mkdir.bind(io),
    ...(io.writeExclusive ? { writeExclusive: io.writeExclusive.bind(io) } : {}),
    ...(io.remove ? { remove: io.remove.bind(io) } : {}),
  };
}

function transactionPaths(target: string): TransactionPaths {
  return { target, previous: `${target}.previous`, stage: `${target}.update-download`,
    saved: `${target}.update-previous`, exchange: `${target}.rollback-exchange`, claim: `${target}.update-transaction` };
}

/** Reject duplicate, aliased lexical, ancestor, and reserved-slot target overlap. */
function validateTargets(targets: readonly { readonly path: string }[]): TransactionPaths[] {
  const paths = targets.map(({ path }) => {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`update target must be an absolute normalized path: ${path}`);
    return transactionPaths(path);
  });
  const claimed: string[] = [];
  for (const path of paths) {
    for (const value of Object.values(path)) {
      if (claimed.some((other) => other === value || other.startsWith(value + sep) || value.startsWith(other + sep))) {
        throw new Error(`overlapping update target namespace: ${value}`);
      }
      claimed.push(value);
    }
  }
  return paths;
}

/**
 * Synchronous after staging: no await can admit a second operation between
 * renames. Exclusive per-target claim files also fence cooperating processes.
 * Claims left by a crash or incomplete undo require inspection, never replay.
 */
function transact(
  operation: 'update' | 'rollback',
  paths: readonly TransactionPaths[],
  io: UpdateFileIo,
  stage: (track: (path: string) => void) => void,
  beforeCommit: (() => void) | undefined,
  commit: (rename: (from: string, to: string) => void) => void,
): void {
  if (paths.length === 0) return;
  if (!io.writeExclusive || !io.remove) throw new Error('update I/O adapter must support writeExclusive and remove; refusing mutation');
  const claims: string[] = [];
  const staged: string[] = [];
  const journal: Array<{ from: string; to: string }> = [];
  let phase: UpdateTransactionReceipt['phase'] = 'claim';
  let committed = false;
  let blockedClaim = false;
  const claimData = Buffer.from(JSON.stringify({ operation, targets: paths, instruction: 'Interrupted transaction: inspect retained files before removing any fence. Do not blindly retry.' }));
  const rename = (from: string, to: string) => {
    if (io.exists(to)) throw new Error(`transaction destination is occupied: ${to}`);
    io.rename(from, to);
    journal.push({ from, to });
  };
  try {
    for (const path of [...paths].sort((a, b) => a.target.localeCompare(b.target))) {
      io.mkdir(dirname(path.target));
      try { io.writeExclusive(path.claim, claimData); }
      catch (error) {
        // An exclusive write can fail after creating partial evidence. If even
        // presence cannot be read, report uncertainty rather than clear retry.
        blockedClaim = true;
        try { blockedClaim = io.exists(path.claim); } catch { /* retain uncertainty */ }
        throw error;
      }
      claims.push(path.claim);
    }
    // Inspect slots only after all claims, so no cooperating writer can race us.
    for (const path of paths) {
      for (const slot of [path.stage, path.saved, path.exchange]) {
        if (io.exists(slot)) throw new Error(`unresolved update recovery file: ${slot}`);
      }
    }
    phase = 'stage';
    stage((path) => staged.push(path));
    phase = 'admission';
    const admission = beforeCommit?.();
    if (admission !== undefined) {
      void Promise.resolve(admission).catch(() => {});
      throw new Error('beforeCommit must complete synchronously without returning a value');
    }
    phase = 'commit';
    commit(rename);
    committed = true;
    phase = 'cleanup';
    // Superseded backups are disposable ONLY after every target committed.
    for (const path of paths) if (io.exists(path.saved)) io.remove(path.saved);
    for (const path of staged) io.remove(path);
    for (const claim of claims) io.remove(claim);
  } catch (cause) {
    const recoveryErrors: string[] = [];
    const attempt = (action: () => void) => {
      try { action(); } catch (error) { recoveryErrors.push(error instanceof Error ? error.message : String(error)); }
    };
    if (!committed) {
      // Do not overwrite a destination when an earlier undo failed. Continue
      // independent targets while retaining all bytes of the blocked chain.
      for (const { from, to } of [...journal].reverse()) {
        attempt(() => {
          if (io.exists(from)) throw new Error(`undo destination occupied: ${from}`);
          io.rename(to, from);
        });
      }
    }
    if (recoveryErrors.length === 0 && !committed) {
      for (const path of staged) attempt(() => io.remove!(path));
    }
    // A pre-existing slot belongs to another/interrupted operation. Keep a
    // fence rather than silently making it eligible for an overwrite/retry.
    const staleSlot = phase === 'claim' && claims.length === paths.length;
    const needsFence = committed || recoveryErrors.length > 0 || staleSlot;
    if (!needsFence) for (const claim of claims) attempt(() => io.remove!(claim));
    if (committed || recoveryErrors.length > 0 || staleSlot) {
      // Cleanup may have released some claims before failing. Reacquire those
      // we released without ever overwriting an existing claimant/journal.
      for (const claim of claims) attempt(() => {
        if (!io.exists(claim)) io.writeExclusive!(claim, claimData);
      });
    }
    const recoveryRequired = committed || recoveryErrors.length > 0 || staleSlot || blockedClaim;
    const recoveryPaths: string[] = [];
    for (const path of paths) for (const slot of Object.values(path)) {
      try { if (io.exists(slot)) recoveryPaths.push(slot); }
      catch { recoveryPaths.push(slot); }
    }
    throw new UpdateTransactionError({ operation, phase, committed, recoveryRequired,
      targets: paths.map((path) => path.target), recoveryPaths: recoveryRequired ? recoveryPaths : [], recoveryErrors }, cause);
  }
}

interface StagedUpdate {
  readonly target: UpdateTarget;
  readonly buffer: Buffer;
}

function installVerifiedBuffers(
  verified: readonly StagedUpdate[], io: UpdateFileIo, platform: NodeJS.Platform, beforeCommit?: () => void,
): void {
  const paths = validateTargets(verified.map(({ target }) => target));
  transact('update', paths, io, (track) => {
    for (let index = 0; index < verified.length; index += 1) {
      const { target, buffer } = verified[index]!;
      const path = paths[index]!;
      track(path.stage); // A failing write may leave partial bytes; cleanup owns it.
      io.writeFile(path.stage, buffer);
      if (platform !== 'win32') io.chmod(path.stage, target.executable ? 0o755 : 0o644);
    }
  }, beforeCommit, (rename) => {
    for (const path of paths) {
      if (io.exists(path.target)) {
        if (io.exists(path.previous)) rename(path.previous, path.saved);
        rename(path.target, path.previous);
      }
      rename(path.stage, path.target);
    }
  });
}

/**
 * Legacy public name. Stages beside the target and compensates failed renames;
 * parking then installing is NOT a gapless atomic replacement.
 */
export function swapFileAtomically(
  targetPath: string,
  buffer: Buffer,
  options: { executable: boolean; io?: UpdateFileIo; platform?: NodeJS.Platform },
): void {
  installVerifiedBuffers([{ target: { label: targetPath, path: targetPath, assetName: '', executable: options.executable }, buffer: Buffer.from(buffer) }],
    options.io ?? realUpdateFileIo, options.platform ?? process.platform);
}

export interface ApplyVerifiedUpdateOptions extends UpdateRequestOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly downloadBaseUrl: string;
  readonly targets: readonly UpdateTarget[];
  readonly io?: UpdateFileIo;
  readonly platform?: NodeJS.Platform;
  /** Final synchronous admission/cancellation check AFTER all staging, BEFORE live renames. This is not a work-admission lease. */
  readonly beforeCommit?: () => void;
}

/** Download and verify the entire cohort before staging; stage it all before commit. */
export async function applyVerifiedUpdate(options: ApplyVerifiedUpdateOptions): Promise<void> {
  // TypeScript readonly is not runtime ownership. Capture every effect-bearing
  // value before the first await, including adapter methods and each member.
  options = { ...options, io: captureUpdateFileIo(options.io ?? realUpdateFileIo),
    targets: options.targets.map((target) => ({ ...target })) };
  validateTargets(options.targets);
  for (const target of options.targets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.assetName)) throw new Error(`invalid update asset filename: ${target.assetName}`);
  }
  const deadline = performance.now() + (options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS);
  const verified = await withUpdateBudget(options, async (signal) => {
    const manifestUrl = `${options.downloadBaseUrl}/${CHECKSUM_MANIFEST_NAME}`;
    const manifestResponse = await options.fetchImpl(manifestUrl, { signal });
    signal.throwIfAborted();
    if (!manifestResponse.ok) throw new Error(`download failed (${manifestResponse.status}) for ${manifestUrl}`);
    const checksums = parseChecksumFile(await manifestResponse.text());
    signal.throwIfAborted();
    const verified: StagedUpdate[] = [];
    for (const target of options.targets) {
      const url = `${options.downloadBaseUrl}/${target.assetName}`;
      const response = await options.fetchImpl(url, { signal });
      signal.throwIfAborted();
      if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
      const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
      signal.throwIfAborted();
      verifyChecksum(target.assetName, sha256(buffer), checksums.get(target.assetName));
      verified.push({ target, buffer });
    }
    signal.throwIfAborted();
    return verified;
  });
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('update timed out before commit');
  };
  assertCurrent();
  // The race above owns only read-only asynchronous preparation. A cancellation
  // during synchronous staging must never mask a transaction recovery receipt.
  installVerifiedBuffers(verified, options.io ?? realUpdateFileIo, options.platform ?? process.platform, () => {
    assertCurrent();
    const result = options.beforeCommit?.();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw new Error('beforeCommit must complete synchronously without returning a value');
    }
    assertCurrent();
  });
}

export interface RollbackTarget {
  readonly label: string;
  readonly path: string;
}

export interface RollbackResult {
  readonly restored: readonly RollbackTarget[];
  readonly skipped: readonly RollbackTarget[];
}

/** Exchange a kept cohort with reverse compensation, including first-install recovery. */
export function rollbackKeptPrevious(
  targets: readonly RollbackTarget[], io: UpdateFileIo = realUpdateFileIo,
): RollbackResult {
  const paths = validateTargets(targets);
  const restored: RollbackTarget[] = [];
  const skipped: RollbackTarget[] = [];
  transact('rollback', paths, io, () => {}, undefined, (rename) => {
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]!;
      const target = targets[index]!;
      if (!io.exists(path.previous)) { skipped.push(target); continue; }
      if (io.exists(path.target)) {
        rename(path.target, path.exchange);
        rename(path.previous, path.target);
        rename(path.exchange, path.previous);
      } else {
        rename(path.previous, path.target);
      }
      restored.push(target);
    }
  });
  return { restored, skipped };
}
