/** One generated backup of an admitted member file, never general runtime access. */
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertContractInputAuthority, authorizeContractInputPath, contractInputAuthorityMutable,
  contractInputAuthorityRoot, contractInputAuthoritySourceRoot,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import type { CapturedExecAuthority } from '../exec/captured-exec.js';

const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;
const fingerprint = (stat: BigIntStats): string =>
  `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;

function statIfPresent(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Metadata only: never enumerate or open existing runtime files. */
function physical(root: string, rel: string): BigIntStats | undefined {
  let current = root;
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = statIfPresent(current);
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)))
      throw new Error('captured backup path is an alias or special file');
    if (index === parts.length - 1) return stat;
    if (!stat.isDirectory()) throw new Error('captured backup parent is not a directory');
  }
  return undefined;
}

/**
 * Call assertCurrent immediately before create when preparation is separated
 * from publication by awaits. create is synchronous and single-use; the caller
 * owns the captured publication lock and retains assertCurrent for delivery.
 * The closure cannot be reconstructed from a serialized path or receipt.
 */
export async function prepareCapturedWriteBackup(
  binding: CapturedExecAuthority,
  source: string,
  signal?: AbortSignal,
): Promise<{ path: string; create: () => void; assertCurrent: () => Promise<void> }> {
  // Pin construction-owned inputs before the first external callback.
  const authority = binding.authority;
  const root = resolve(binding.root);
  const filter = binding.readAccessFilter;
  const combined = binding.signal && signal ? AbortSignal.any([binding.signal, signal]) : binding.signal ?? signal;
  const sourcePath = resolve(root, source);
  const rel = relative(root, sourcePath);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ||
    rel.split(sep).some((part) => CONTRACT_INPUT_EXCLUSIONS.includes(part as typeof CONTRACT_INPUT_EXCLUSIONS[number])))
    throw new Error('captured backup source is outside admitted input');
  if (!filter) throw new Error('captured backup requires original-owner read authorization');
  await executePolicyCheck(() => assertContractInputAuthority(authority, root, combined), combined);
  if (!contractInputAuthorityMutable(authority)) throw new Error('immutable captured input cannot create a backup');
  const owner = contractInputAuthoritySourceRoot(authority);
  if (root === owner) throw new Error('captured backup requires a separate member view');
  const rootIdentity = identity(lstatSync(root, { bigint: true }));
  const ownerIdentity = identity(lstatSync(owner, { bigint: true }));
  // These are opaque artifact IDs, not numeric user data. Alphabetic encoding
  // avoids accidental payment-card/identity matches without weakening the
  // exact same judgment-input boundary used for both source and destination.
  const artifactId = `${Date.now()}_${randomUUID()}`.replace(/[0-9]/g, (digit) => String.fromCharCode(107 + Number(digit))).replace(/-/g, '_');
  const backupRelative = join('.goodvibes', '.backups', `${rel}.owned_${artifactId}`);
  const path = join(root, backupRelative);
  const original = join(owner, backupRelative);
  let sourceFingerprint: string | undefined;
  let backupFingerprint: string | undefined;
  let attempted = false;

  const assertPhysical = (): BigIntStats => {
    combined?.throwIfAborted();
    // These accessors also reject revoked, forged or cancelled authority and
    // changed admission, without yielding between this check and a sync write.
    if (!contractInputAuthorityMutable(authority) || contractInputAuthorityRoot(authority) !== root ||
      contractInputAuthoritySourceRoot(authority) !== owner)
      throw new Error('captured backup authority changed');
    for (const [directory, expected] of [[root, rootIdentity], [owner, ownerIdentity]] as const) {
      const stat = lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected || realpathSync(directory) !== directory)
        throw new Error('captured backup root changed');
    }
    const ownerSource = physical(owner, rel);
    const copySource = physical(root, rel);
    if ((ownerSource && !ownerSource.isFile()) || !copySource?.isFile())
      throw new Error('captured backup requires a regular source');
    // A successful write normally replaces the source inode. Only the backup
    // stays pinned after creation; both current source permissions still apply.
    if (backupFingerprint === undefined && sourceFingerprint !== undefined && fingerprint(copySource) !== sourceFingerprint)
      throw new Error('captured backup source changed before creation');
    // The original counterpart must be absent BEFORE invoking a filter that
    // might read bytes. Runtime content in the owner is never a backup input.
    if (physical(owner, backupRelative) !== undefined)
      throw new Error('captured backup original destination already exists');
    const backup = physical(root, backupRelative);
    if (backupFingerprint === undefined ? backup !== undefined : !backup?.isFile() || fingerprint(backup) !== backupFingerprint)
      throw new Error('captured backup destination exists or changed');
    return copySource;
  };
  sourceFingerprint = fingerprint(assertPhysical());

  const guardedFilter = async (candidate: string): Promise<boolean> => {
    assertPhysical();
    const allowed = await executePolicyCheck(() => filter(candidate), combined);
    assertPhysical();
    return allowed;
  };
  const assertCurrent = async (): Promise<void> => executePolicyCheck(async () => {
    await executePolicyCheck(() => assertContractInputAuthority(authority, root, combined), combined);
    assertPhysical();
    const admitted = await executePolicyCheck(
      () => authorizeContractInputPath(authority, sourcePath, guardedFilter, combined), combined);
    if (admitted !== sourcePath) throw new Error('captured backup source authorization redirected');
    // Exact generated paths only. No exclusion exception is added to generic
    // captured path authorization, and existing originals never reach a filter.
    if (!await guardedFilter(original) || !await guardedFilter(path))
      throw new Error('captured backup destination is access-restricted');
    await executePolicyCheck(() => assertContractInputAuthority(authority, root, combined), combined);
    assertPhysical();
  }, combined);

  await assertCurrent();
  const create = (): void => {
    if (attempted) throw new Error('captured backup creation is single-use');
    const sourceStat = assertPhysical();
    attempted = true;
    // Read through a no-follow descriptor and verify it is the admitted source.
    const sourceFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const stat = fstatSync(sourceFd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || fingerprint(stat) !== sourceFingerprint)
        throw new Error('captured backup source changed before reading');
      data = readFileSync(sourceFd);
      if (fingerprint(fstatSync(sourceFd, { bigint: true })) !== sourceFingerprint)
        throw new Error('captured backup source changed while reading');
    } finally { closeSync(sourceFd); }
    assertPhysical();
    // Create member parents one component at a time, rejecting aliases rather
    // than recursively following an existing runtime directory or symlink.
    let current = root;
    for (const part of dirname(backupRelative).split(sep)) {
      current = join(current, part);
      if (!statIfPresent(current)) mkdirSync(current, { mode: 0o700 });
      const stat = lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('captured backup parent changed');
    }
    assertPhysical();
    const backupFd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, Number(sourceStat.mode & 0o777n));
    try {
      writeFileSync(backupFd, data);
      fchmodSync(backupFd, Number(sourceStat.mode & 0o777n));
      const stat = fstatSync(backupFd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) throw new Error('captured backup is not an exclusive regular file');
      backupFingerprint = fingerprint(stat);
    } finally { closeSync(backupFd); }
    assertPhysical();
  };
  return Object.freeze({ path, create, assertCurrent });
}
