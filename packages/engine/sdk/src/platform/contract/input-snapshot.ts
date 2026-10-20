import { markCapturedInputPath } from './input-authority.js';
/** Local, content-addressed contract input. Membership grants no read or transmission permission. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir, uptime } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Runtime state and known credential-store directories are never contract input, even when tracked. */
export const CONTRACT_INPUT_EXCLUSIONS = ['.git', '.goodvibes', '.ssh', '.aws', '.gnupg'] as const;
const GIT_METADATA_BYTES = 256 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const HASH = /^[0-9a-f]{40,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ContractInputFile {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'missing';
  readonly mode: '100644' | '100755' | '120000' | '0';
  readonly oid?: string | undefined;
  readonly digest?: string | undefined;
  readonly identity?: string | undefined;
}

/** A versioned local receipt. Digests and object ids are provenance, never permission grants. */
export interface ContractInputSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly sourceRoot: string;
  readonly sourceIdentity: string;
  readonly gitIdentity: string;
  readonly ownerHead: string;
  readonly ownerRef: string;
  readonly indexFingerprint: string;
  readonly inputTree: string;
  readonly inputCommit: string;
  readonly capturedAt: number;
  /** Includes staged-only differences, exclusions from HEAD and all working-tree differences. */
  readonly dirty: boolean;
  readonly exclusions: readonly string[];
  readonly files: readonly ContractInputFile[];
}

export interface CaptureContractInputOptions {
  readonly signal?: AbortSignal | undefined;
  /** Optional caller-selected resource budgets. Repository size is not an admission policy. */
  readonly maxBytes?: number | undefined;
  readonly maxFiles?: number | undefined;
}

function digest(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function identity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
function directoryIdentity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}`; }
function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
function excluded(path: string, exclusions: readonly string[]): boolean { return path.split('/').some((part) => exclusions.includes(part)); }

/** Do not inherit caller Git routing, filters, signers, editors or optional-lock behavior. */
function git(root: string, args: readonly string[], input?: Buffer, index?: string, allowNoMatch = false, descriptors?: { readonly input?: number; readonly output?: number }): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgsign=false', ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'GoodVibes Input', GIT_AUTHOR_EMAIL: 'input@goodvibes.local', GIT_COMMITTER_NAME: 'GoodVibes Input', GIT_COMMITTER_EMAIL: 'input@goodvibes.local', ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) },
    input, maxBuffer: GIT_METADATA_BYTES,
    stdio: [descriptors?.input ?? 'pipe', descriptors?.output ?? 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) throw new Error(`contract input git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString().trim() ?? 'unknown error'}`);
  return result.stdout ?? Buffer.alloc(0);
}
function gitText(root: string, args: readonly string[], input?: Buffer, index?: string): string { return git(root, args, input, index).toString('utf8').trim(); }
function paths(root: string, exclusions: readonly string[]): string[] {
  const bytes = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('contract input contains a non-UTF-8 path');
  return [...new Set(text.split('\0').filter(Boolean))].filter((path) => {
    // Git reports an unignored nested runtime worktree as a directory ending
    // in '/'. Exclude only the canonical owned root before the stricter file
    // path check; do not normalize traversal, repeated separators or lookalikes.
    const generated = path.endsWith('/') ? path.slice(0, -1) : path;
    if (exclusions.includes('.goodvibes') && (generated === '.goodvibes' || generated.startsWith('.goodvibes/')) && safePath(generated)) return false;
    if (!safePath(path)) throw new Error('contract input contains an ambiguous path');
    return !excluded(path, exclusions);
  }).sort();
}
/** Git omits untracked FIFOs/sockets; inspect eligible directory entries without following links. */
async function assertNoSpecialFiles(root: string, exclusions: readonly string[], signal?: AbortSignal): Promise<void> {
  let queue = [''];
  while (queue.length > 0) {
    const entries: { entry: Dirent; path: string }[] = [];
    for (const directory of queue) {
      signal?.throwIfAborted();
      const absolute = join(root, directory);
      const before = await lstat(absolute, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('contract input directory replaced during scan');
      for await (const entry of await opendir(absolute)) {
        signal?.throwIfAborted();
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
        if (!excluded(path, exclusions)) entries.push({ entry, path });
      }
      if (directoryIdentity(await lstat(absolute, { bigint: true })) !== directoryIdentity(before)) throw new Error('contract input directory replaced during scan');
    }
    // One ignore query per level, rather than a Git process per directory.
    const names = entries.map(({ entry, path }) => `${path}${entry.isDirectory() ? '/' : ''}`);
    const ignored = names.length === 0 ? new Set<string>() : new Set(git(root, ['check-ignore', '--no-index', '--stdin', '-z'], Buffer.from(`${names.join('\0')}\0`), undefined, true).toString().split('\0'));
    queue = [];
    for (let i = 0; i < entries.length; i++) {
      if (ignored.has(names[i]!)) continue;
      const { entry, path } = entries[i]!;
      if (entry.isDirectory()) queue.push(path);
      else if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`contract input contains unsupported special file: ${path}`);
    }
  }
}

function indexFingerprint(root: string): string {
  return digest(Buffer.concat([git(root, ['ls-files', '--stage', '-z']), git(root, ['ls-files', '-v', '-z'])]));
}
/** Owner Git operations belong to the owner, including abandoned locks that need manual recovery. */
async function assertOwnerGitIdle(root: string, signal?: AbortSignal): Promise<void> {
  const gitDir = gitText(root, ['rev-parse', '--absolute-git-dir']);
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    signal?.throwIfAborted();
    try { await lstat(join(gitDir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error(`active owner Git operation ${name}; inspect owner Git state before retrying`);
  }
}

async function repositoryIdentity(root: string): Promise<string> {
  const gitDir = gitText(root, ['rev-parse', '--absolute-git-dir']);
  const commonDir = gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const marker = await lstat(join(root, '.git'), { bigint: true });
  return [marker.isDirectory() ? directoryIdentity(marker) : identity(marker), gitDir, directoryIdentity(await lstat(gitDir, { bigint: true })), commonDir, directoryIdentity(await lstat(commonDir, { bigint: true }))].join('|');
}
async function indexIdentity(root: string): Promise<string> {
  const path = gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  try { return identity(await lstat(path, { bigint: true })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
}
async function directories(root: string, path: string): Promise<string[]> {
  const result: string[] = [];
  let current = root;
  for (const part of ['.', ...path.split('/').slice(0, -1)]) {
    current = resolve(current, part);
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`contract input parent is not a regular directory: ${path}`);
    result.push(directoryIdentity(stat));
  }
  return result;
}
async function readEntry(root: string, path: string, options: {
  readonly signal?: AbortSignal | undefined;
  readonly objectFormat?: string | undefined;
  readonly knownObjects?: ReadonlySet<string> | undefined;
  readonly verified?: Map<string, ContractInputFile> | undefined;
} = {}): Promise<{ readonly file: ContractInputFile; readonly data?: Buffer; readonly size: number }> {
  let parents: string[];
  try { parents = await directories(root, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: { path, kind: 'missing', mode: '0' }, size: 0 };
    throw error;
  }
  const absolute = join(root, path);
  let before: BigIntStats;
  try { before = await lstat(absolute, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { file: { path, kind: 'missing', mode: '0' }, size: 0 };
  }
  const verified = options.verified?.get(path);
  if (verified) {
    if (verified.identity !== identity(before)) throw new Error(`contract input view changed: ${path}`);
    return { file: verified, size: Number(before.size) };
  }
  let data: Buffer | undefined;
  let contentDigest: string;
  let oid: string | undefined;
  let mode: ContractInputFile['mode'];
  let kind: ContractInputFile['kind'];
  if (before.isSymbolicLink()) {
    data = await readlink(absolute, { encoding: 'buffer' });
    if (!Buffer.from(data.toString('utf8')).equals(data)) throw new Error(`contract input contains a non-UTF-8 symlink: ${path}`);
    kind = 'symlink'; mode = '120000';
    contentDigest = digest(data);
    if (options.objectFormat) oid = gitText(root, ['hash-object', '-w', '--stdin', '--no-filters'], data);
  } else {
    if (!before.isFile()) throw new Error(`contract input contains unsupported special file or submodule: ${path}`);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error(`contract input file replaced: ${path}`);
      const hash = createHash('sha256');
      const objectHash = options.objectFormat ? createHash(options.objectFormat).update(`blob ${before.size}\0`) : undefined;
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Number(before.size)));
      let count = 0;
      // Read only the initial size, in fixed memory. A growing file cannot keep capture alive.
      while (count < Number(before.size)) {
        options.signal?.throwIfAborted();
        const read = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - count), count);
        if (read.bytesRead === 0) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        objectHash?.update(buffer.subarray(0, read.bytesRead));
        count += read.bytesRead;
      }
      if (count !== Number(before.size) || identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error(`contract input changed while reading: ${path}`);
      contentDigest = hash.digest('hex');
      oid = objectHash?.digest('hex');
      // Reuse existing objects; new bytes go directly from the held descriptor to Git.
      if (oid && !options.knownObjects?.has(oid)) {
        const stored = git(root, ['hash-object', '-w', '--stdin', '--no-filters'], undefined, undefined, false, { input: handle.fd }).toString().trim();
        if (stored !== oid || identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error(`contract input changed while storing: ${path}`);
      }
    } finally { await handle.close(); }
    kind = 'file'; mode = (before.mode & 0o111n) !== 0n ? '100755' : '100644';
  }
  if (identity(await lstat(absolute, { bigint: true })) !== identity(before) || JSON.stringify(await directories(root, path)) !== JSON.stringify(parents)) throw new Error(`contract input replaced while reading: ${path}`);
  const file = { path, kind, mode, digest: contentDigest, identity: identity(before), ...(oid ? { oid } : {}) };
  options.verified?.set(path, file);
  return { file, ...(data ? { data } : {}), size: Number(before.size) };
}

function checkLinks(files: readonly ContractInputFile[], links: ReadonlyMap<string, string>, available: ReadonlyMap<string, ContractInputFile> = new Map(files.filter((file) => file.kind !== 'missing').map((file) => [file.path, file]))): void {
  for (const [path, target] of links) {
    let next = path;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(next)) throw new Error(`contract input contains a symlink cycle: ${path}`);
      seen.add(next);
      const link = links.get(next);
      if (link === undefined) break;
      if (isAbsolute(link) || link.includes('\\') || link.includes('\0')) throw new Error(`contract input contains an absolute or ambiguous symlink: ${path}`);
      const destination = relative('/snapshot', resolve('/snapshot', dirname(next), link)).split(sep).join('/');
      if (!safePath(destination) || !available.has(destination)) throw new Error(`contract input symlink escapes or has an uncaptured target: ${path}`);
      next = destination;
    }
    if (target.length === 0) throw new Error(`contract input contains an empty symlink: ${path}`);
  }
}

const captures = new Map<string, Promise<void>>();

/** One capture per canonical root in this process. Independent processes still get distinct indexes/ids. */
export async function captureContractInput(sourceRoot: string, options: CaptureContractInputOptions = {}): Promise<ContractInputSnapshot> {
  options.signal?.throwIfAborted();
  const root = await realpath(sourceRoot);
  const previous = captures.get(root) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolveTail) => { release = resolveTail; });
  captures.set(root, tail);
  await previous;
  try { return await capture(root, options); }
  finally { release(); if (captures.get(root) === tail) captures.delete(root); }
}

async function capture(root: string, options: CaptureContractInputOptions): Promise<ContractInputSnapshot> {
  const signal = options.signal;
  function check(): void { signal?.throwIfAborted(); }
  check();
  if (gitText(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('contract input requires the repository root');
  await assertOwnerGitIdle(root, signal);
  const sourceIdentity = directoryIdentity(await lstat(root, { bigint: true }));
  const gitIdentity = await repositoryIdentity(root);
  const ownerHead = gitText(root, ['rev-parse', 'HEAD']);
  const ownerRef = gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const originalIndex = await indexIdentity(root);
  const index = indexFingerprint(root);
  await assertNoSpecialFiles(root, CONTRACT_INPUT_EXCLUSIONS, signal);
  const selected = paths(root, CONTRACT_INPUT_EXCLUSIONS);
  if (options.maxFiles !== undefined && selected.length > options.maxFiles) throw new Error('contract input exceeds caller file-count budget');
  const objectFormat = gitText(root, ['rev-parse', '--show-object-format']);
  const knownObjects = new Set(git(root, ['ls-files', '--stage', '-z']).toString().split('\0').map(entry => entry.split(' ')[1]!));
  const temporary = await mkdtemp(join(tmpdir(), 'goodvibes-contract-input-'));
  const alternateIndex = join(temporary, 'index');
  try {
    const files: ContractInputFile[] = [];
    const links = new Map<string, string>();
    let bytes = 0;
    for (const path of selected) {
      check();
      const entry = await readEntry(root, path, { signal, objectFormat, knownObjects });
      bytes += entry.size;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) throw new Error('contract input exceeds byte bound selected by caller');
      if (entry.file.kind === 'symlink') links.set(path, entry.data!.toString());
      files.push(entry.file);
    }
    checkLinks(files, links);
    git(root, ['read-tree', '--empty'], undefined, alternateIndex);
    const entries = files.filter((file) => file.kind !== 'missing').map((file) => `${file.mode} ${file.oid}\t${file.path}\0`).join('');
    if (entries.length > 0) git(root, ['update-index', '-z', '--index-info'], Buffer.from(entries), alternateIndex);
    const inputTree = gitText(root, ['write-tree'], undefined, alternateIndex);
    const headTree = gitText(root, ['rev-parse', `${ownerHead}^{tree}`]);
    const dirty = inputTree !== headTree || git(root, ['diff-index', '--cached', '--raw', '-z', ownerHead, '--']).length > 0;
    // A clean generation uses the real owner commit; synthetic input never enters clean owner history.
    const inputCommit = inputTree === headTree ? ownerHead : gitText(root, ['commit-tree', inputTree, '-p', ownerHead, '-m', 'Local contract input; not a deliverable']);
    // Encode generated opaque IDs without numeric runs; the privacy floor still
    // evaluates every original/captured path and must not be relaxed for UUIDs.
    const receipt: ContractInputSnapshot = { version: 1, id: randomUUID().replace(/[0-9]/g, (digit) => String.fromCharCode(107 + Number(digit))), sourceRoot: root, sourceIdentity, gitIdentity, ownerHead, ownerRef, indexFingerprint: index, inputTree, inputCommit, capturedAt: Date.now(), dirty, exclusions: [...CONTRACT_INPUT_EXCLUSIONS], files };
    check();
    await assertContractInputOwner(receipt, signal);
    if (await indexIdentity(root) !== originalIndex) throw new Error('contract input index replaced during capture');
    check();
    return receipt;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Full recorded readset recheck. No writes and no best-effort empty fallback. */
export async function assertContractInputOwner(snapshot: ContractInputSnapshot, signal?: AbortSignal): Promise<void> {
  const root = snapshot.sourceRoot;
  signal?.throwIfAborted();
  await assertOwnerGitIdle(root, signal);
  if (await realpath(root) !== root || directoryIdentity(await lstat(root, { bigint: true })) !== snapshot.sourceIdentity) throw new Error('contract input source root was replaced');
  if (await repositoryIdentity(root) !== snapshot.gitIdentity) throw new Error('contract input Git directory was replaced');
  if (gitText(root, ['rev-parse', 'HEAD']) !== snapshot.ownerHead || gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']) !== snapshot.ownerRef) throw new Error('contract input owner HEAD or branch changed');
  if (indexFingerprint(root) !== snapshot.indexFingerprint) throw new Error('contract input owner index changed');
  await assertNoSpecialFiles(root, snapshot.exclusions, signal);
  if (JSON.stringify(paths(root, snapshot.exclusions)) !== JSON.stringify(snapshot.files.map((file) => file.path))) throw new Error('contract input owner path set changed');
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    const current = (await readEntry(root, file.path, { signal })).file;
    if (current.kind !== file.kind || current.mode !== file.mode || current.digest !== file.digest || current.identity !== file.identity) throw new Error(`contract input owner changed: ${file.path}`);
  }
  signal?.throwIfAborted();
  await assertOwnerGitIdle(root, signal);
  if (await repositoryIdentity(root) !== snapshot.gitIdentity || directoryIdentity(await lstat(root, { bigint: true })) !== snapshot.sourceIdentity || indexFingerprint(root) !== snapshot.indexFingerprint || gitText(root, ['rev-parse', 'HEAD']) !== snapshot.ownerHead || gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']) !== snapshot.ownerRef || JSON.stringify(paths(root, snapshot.exclusions)) !== JSON.stringify(snapshot.files.map((file) => file.path))) throw new Error('contract input owner changed during recheck');
}

/** Historical readers retain the recorded repository identity without requiring live owner files/HEAD. */
export async function assertContractInputGitIdentity(snapshot: ContractInputSnapshot): Promise<void> {
  if (await repositoryIdentity(snapshot.sourceRoot) !== snapshot.gitIdentity)
    throw new Error('contract input Git directory was replaced');
}

/** Device numbers can change across boots (for example on Btrfs). Rebind only
 * that component after checking the entire original readset and captured view.
 * This does not recapture input, reuse judgments, or accept a replacement inode.
 */
export async function restoreContractInputDevice(snapshot: ContractInputSnapshot, signal?: AbortSignal): Promise<ContractInputSnapshot> {
  const current = directoryIdentity(await lstat(snapshot.sourceRoot, { bigint: true }));
  if (current === snapshot.sourceIdentity) return snapshot;
  const previous = /^(\d+):(\d+)$/.exec(snapshot.sourceIdentity);
  const present = /^(\d+):(\d+)$/.exec(current);
  if (!previous || !present || previous[2] !== present[2] || previous[1] === present[1]
    || snapshot.capturedAt >= Date.now() - uptime() * 1000 - 5000)
    throw new Error('contract input source root was replaced');
  const replaceDevice = (value: string): string => value.startsWith(`${previous[1]}:`)
    ? `${present[1]}${value.slice(previous[1]!.length)}` : value;
  const restored: ContractInputSnapshot = {
    ...snapshot,
    sourceIdentity: current,
    gitIdentity: snapshot.gitIdentity.split('|').map(replaceDevice).join('|'),
    files: snapshot.files.map(file => file.identity === undefined ? file : { ...file, identity: replaceDevice(file.identity) }),
  };
  await assertContractInputOwner(restored, signal);
  await assertContractInputView(restored, signal);
  return restored;
}

/** Verify persisted object provenance, without recapturing today's owner tree. */
export function assertContractInputObjects(snapshot: ContractInputSnapshot, projectRoot: string): void {
  assertInputObjects(snapshot, projectRoot);
}

interface PreparedInputViewManifest {
  readonly expectedTree: string;
  readonly expectedPaths: string;
  readonly symlinks: readonly ContractInputFile[];
  readonly available: ReadonlyMap<string, ContractInputFile>;
}

/** Receipt-derived constants only: no live filesystem state or permission verdict. */
function prepareInputViewManifest(snapshot: ContractInputSnapshot): PreparedInputViewManifest {
  const present = snapshot.files.filter(file => file.kind !== 'missing');
  return {
    expectedTree: present.map(file => `${file.mode} blob ${file.oid}\t${file.path}\0`).sort().join(''),
    expectedPaths: JSON.stringify(present.map(file => file.path)),
    symlinks: present.filter(file => file.kind === 'symlink'),
    available: new Map(present.map(file => [file.path, file])),
  };
}

function assertInputObjects(snapshot: ContractInputSnapshot, projectRoot: string, prepared?: PreparedInputViewManifest): void {
  if (!snapshot.dirty && snapshot.inputCommit !== snapshot.ownerHead) throw new Error('clean contract input must name the recorded owner commit');
  if (resolve(projectRoot) !== snapshot.sourceRoot) throw new Error('contract input receipt belongs to a different source root');
  if (gitText(projectRoot, ['rev-parse', `${snapshot.inputCommit}^{tree}`]) !== snapshot.inputTree) throw new Error('contract input commit/tree receipt mismatch');
  const links = new Map((prepared?.symlinks ?? snapshot.files.filter((file) => file.kind === 'symlink')).map((file) => [file.path, git(projectRoot, ['cat-file', 'blob', file.oid!]).toString()]));
  checkLinks(snapshot.files, links, prepared?.available);
  const actual = git(projectRoot, ['ls-tree', '-r', '-z', snapshot.inputTree]).toString();
  const expected = prepared?.expectedTree ?? snapshot.files.filter((file) => file.kind !== 'missing').map((file) => `${file.mode} blob ${file.oid}\t${file.path}\0`).sort().join('');
  if (actual.split('\0').filter(Boolean).map((entry) => `${entry}\0`).sort().join('') !== expected) throw new Error('contract input file/object receipt mismatch');
}

/** Materialize a no-checkout worktree with exact blobs: no smudge filters, checkout hooks or setup. */
export async function materializeContractInput(snapshot: ContractInputSnapshot, worktreePath: string, signal?: AbortSignal): Promise<void> {
  markCapturedInputPath(worktreePath);
  assertContractInputObjects(snapshot, snapshot.sourceRoot);
  await materializeFiles(snapshot.sourceRoot, snapshot.files, snapshot.inputCommit, worktreePath, signal);
}

async function materializeFiles(sourceRoot: string, files: readonly ContractInputFile[], commit: string, worktreePath: string, signal?: AbortSignal): Promise<void> {
  // Git's batch protocol streams raw blobs without checkout filters or a process per file.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const child = spawn('git', ['-C', sourceRoot, '-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
  const ended = new Promise<void>((resolveEnd, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveEnd() : reject(new Error(`contract input blob stream failed: ${diagnostic}`)));
  });
  void ended.catch(() => {});
  child.stdin.on('error', () => {}); // A broken pipe is reported by the owned child's completion.
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  const chunks = child.stdout[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  const fill = async (): Promise<void> => {
    signal?.throwIfAborted();
    if (pending.length) return;
    const next = await chunks.next();
    if (next.done) { await ended; throw new Error('contract input blob stream ended early'); }
    pending = next.value as Buffer;
  };
  const line = async (): Promise<string> => {
    let header = '';
    for (;;) {
      await fill();
      const end = pending.indexOf(10);
      if (end >= 0) { header += pending.subarray(0, end).toString(); pending = pending.subarray(end + 1); return header; }
      header += pending.toString(); pending = Buffer.alloc(0);
      if (header.length > 200) throw new Error('invalid contract input blob header');
    }
  };
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      if (file.kind === 'missing') continue;
      child.stdin.write(`${file.oid}\n`);
      const header = /^(\S+) blob (\d+)$/.exec(await line());
      if (!header || header[1] !== file.oid || !Number.isSafeInteger(Number(header[2]))) throw new Error('contract input blob stream object mismatch');
      const path = join(worktreePath, file.path);
      await mkdir(dirname(path), { recursive: true });
      const handle = file.kind === 'file' ? await open(path, 'wx', file.mode === '100755' ? 0o755 : 0o644) : undefined;
      const hash = createHash('sha256');
      const link: Buffer[] = [];
      let remaining = Number(header[2]);
      try {
        while (remaining > 0) {
          await fill();
          const data = pending.subarray(0, Math.min(remaining, pending.length));
          hash.update(data);
          if (handle) {
            let written = 0;
            while (written < data.length) written += (await handle.write(data.subarray(written))).bytesWritten;
          } else link.push(Buffer.from(data));
          remaining -= data.length; pending = pending.subarray(data.length);
        }
        const actualDigest = hash.digest('hex');
        if (file.digest && actualDigest !== file.digest) throw new Error(`contract input blob digest mismatch: ${file.path}`);
      } finally { await handle?.close(); }
      if (await line() !== '') throw new Error('invalid contract input blob terminator');
      if (file.kind === 'symlink') await symlink(Buffer.concat(link).toString(), path);
      else await chmod(path, file.mode === '100755' ? 0o755 : 0o644);
    }
    child.stdin.end();
    await ended;
    signal?.throwIfAborted();
    git(worktreePath, ['read-tree', commit]);
  } finally {
    signal?.removeEventListener('abort', abort);
    if (child.exitCode === null) child.kill('SIGTERM');
    // A failed write can leave the async iterator paused with unread output.
    // Close our pipe ends before joining: child 'close' waits for them too.
    child.stdin.destroy();
    child.stdout.destroy();
    await ended.catch(() => {});
  }
}

/** Strict receipt validation at the persistence boundary; absent receipts remain explicitly legacy. */
export function isContractInputSnapshot(value: unknown): value is ContractInputSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1 || typeof v['id'] !== 'string' || (!/^[0-9a-f-]{36}$/.test(v['id']) && !/^[a-fk-t]{8}-[a-fk-t]{4}-[a-fk-t]{4}-[a-fk-t]{4}-[a-fk-t]{12}$/.test(v['id'])) || typeof v['sourceRoot'] !== 'string' || !isAbsolute(v['sourceRoot']) || typeof v['sourceIdentity'] !== 'string' || typeof v['gitIdentity'] !== 'string' || typeof v['ownerRef'] !== 'string' || typeof v['capturedAt'] !== 'number' || !Number.isFinite(v['capturedAt']) || typeof v['dirty'] !== 'boolean') return false;
  if (!['ownerHead', 'inputTree', 'inputCommit'].every((key) => typeof v[key] === 'string' && HASH.test(v[key] as string)) || typeof v['indexFingerprint'] !== 'string' || !SHA256.test(v['indexFingerprint'])) return false;
  if (!Array.isArray(v['exclusions']) || JSON.stringify(v['exclusions']) !== JSON.stringify(CONTRACT_INPUT_EXCLUSIONS) || !Array.isArray(v['files'])) return false;
  const pathsSeen = new Set<string>();
  for (const file of v['files']) {
    if (file === null || typeof file !== 'object') return false;
    const f = file as Record<string, unknown>;
    if (typeof f['path'] !== 'string' || !safePath(f['path']) || excluded(f['path'], CONTRACT_INPUT_EXCLUSIONS) || pathsSeen.has(f['path'])) return false;
    pathsSeen.add(f['path']);
    if (f['kind'] === 'missing') { if (f['mode'] !== '0' || f['oid'] !== undefined || f['digest'] !== undefined || f['identity'] !== undefined) return false; }
    else if ((f['kind'] !== 'file' && f['kind'] !== 'symlink') || (f['kind'] === 'file' ? f['mode'] !== '100644' && f['mode'] !== '100755' : f['mode'] !== '120000') || typeof f['oid'] !== 'string' || !HASH.test(f['oid']) || typeof f['digest'] !== 'string' || !SHA256.test(f['digest']) || typeof f['identity'] !== 'string') return false;
  }
  return true;
}

/** Each generation has a distinct planner path, so read decisions are never reused across generations. */
export function contractInputPath(snapshot: ContractInputSnapshot): string {
  return join(snapshot.sourceRoot, '.goodvibes', '.worktrees', 'contract-input', snapshot.id);
}

/** A planner can resume only from its recorded input generation, never today's source or a result tree. */
export async function assertContractInputView(snapshot: ContractInputSnapshot, signal?: AbortSignal, viewPath = contractInputPath(snapshot)): Promise<void> {
  await assertInputView(snapshot, signal, viewPath);
}

/** The default immutable authority owns this clone and its constant manifest. */
export function createContractInputViewAssertion(snapshot: ContractInputSnapshot, signal?: AbortSignal, viewPath = contractInputPath(snapshot)): () => Promise<void> {
  const owned = structuredClone(snapshot);
  const prepared = prepareInputViewManifest(owned);
  const verified = new Map<string, ContractInputFile>();
  return () => assertInputView(owned, signal, viewPath, prepared, verified);
}

async function assertInputView(snapshot: ContractInputSnapshot, signal: AbortSignal | undefined, viewPath: string, prepared?: PreparedInputViewManifest, verified?: Map<string, ContractInputFile>): Promise<void> {
  assertInputObjects(snapshot, snapshot.sourceRoot, prepared);
  const root = viewPath;
  if (gitText(root, ['rev-parse', 'HEAD']) !== snapshot.inputCommit) throw new Error('contract input view no longer names the recorded commit');
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    const current = (await readEntry(root, file.path, { signal, verified })).file;
    if (current.kind !== file.kind || current.mode !== file.mode || current.digest !== file.digest) throw new Error(`contract input view changed: ${file.path}`);
  }
  await assertNoSpecialFiles(root, snapshot.exclusions, signal);
  if (JSON.stringify(paths(root, snapshot.exclusions)) !== (prepared?.expectedPaths ?? JSON.stringify(snapshot.files.filter((file) => file.kind !== 'missing').map((file) => file.path)))) throw new Error('contract input view path set changed');
}

/** Member worktrees inherit the contract's current exact Git tree, without owner checkout filters/hooks. */
export async function initializeContractMemberWorktree(sourceRoot: string, worktree: { readonly path: string; create(startPoint?: string, checkout?: boolean): Promise<void> }): Promise<void> {
  markCapturedInputPath(worktree.path);
  const commit = gitText(sourceRoot, ['rev-parse', 'HEAD']);
  const entries = git(sourceRoot, ['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean);
  const files: ContractInputFile[] = [];
  const links = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (match === null || !safePath(match[3]!) || excluded(match[3]!, CONTRACT_INPUT_EXCLUSIONS)) throw new Error('contract member tree contains an unsupported path or object');
    const path = match[3]!;
    const oid = match[2]!;
    const mode = match[1] as ContractInputFile['mode'];
    const kind = mode === '120000' ? 'symlink' : 'file';
    const data = kind === 'symlink' ? git(sourceRoot, ['cat-file', 'blob', oid]) : undefined;
    if (data) links.set(path, data.toString());
    files.push({ path, mode, kind, oid, ...(data ? { digest: digest(data) } : {}) });
  }
  checkLinks(files, links);
  await worktree.create(commit, false);
  await materializeFiles(sourceRoot, files, commit, worktree.path);
}

/** A result tree must still descend from its recorded input; never adopt an unrelated workspace. */
export function assertContractExecutionView(snapshot: ContractInputSnapshot, worktreePath: string, branch: string): void {
  if (gitText(worktreePath, ['rev-parse', '--show-toplevel']) !== resolve(worktreePath) || gitText(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) throw new Error('contract execution workspace no longer names its recorded branch');
  git(worktreePath, ['merge-base', '--is-ancestor', snapshot.inputCommit, 'HEAD']);
}

/** Refuse symlinked runtime storage before creating a captured view. Never follow a redirected parent. */
export async function prepareContractInputParent(snapshot: ContractInputSnapshot, target: string): Promise<void> {
  const rel = relative(snapshot.sourceRoot, dirname(target));
  if (!safePath(rel) || !rel.startsWith('.goodvibes/')) throw new Error('contract input workspace is outside runtime storage');
  let current = snapshot.sourceRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('contract input workspace parent is redirected');
  }
}
