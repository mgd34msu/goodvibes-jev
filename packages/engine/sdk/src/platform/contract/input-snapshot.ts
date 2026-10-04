import { markCapturedInputPath } from './input-authority.js';
/** Local, content-addressed contract input. Membership grants no read or transmission permission. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Runtime state and known credential-store directories are never contract input, even when tracked. */
export const CONTRACT_INPUT_EXCLUSIONS = ['.git', '.goodvibes', '.ssh', '.aws', '.gnupg'] as const;
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_MS = 120_000;
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
  /** Lower bounds may be selected by embedders/tests; these cannot raise the hard limits. */
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
function git(root: string, args: readonly string[], input?: Buffer, index?: string, allowNoMatch = false): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgsign=false', ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'GoodVibes Input', GIT_AUTHOR_EMAIL: 'input@goodvibes.local', GIT_COMMITTER_NAME: 'GoodVibes Input', GIT_COMMITTER_EMAIL: 'input@goodvibes.local', ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) },
    input, maxBuffer: MAX_BYTES + 1024 * 1024, timeout: 10_000,
  });
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) throw new Error(`contract input git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString().trim() ?? 'unknown error'}`);
  return result.stdout;
}
function gitText(root: string, args: readonly string[], input?: Buffer, index?: string): string { return git(root, args, input, index).toString('utf8').trim(); }
function paths(root: string, exclusions: readonly string[]): string[] {
  const bytes = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('contract input contains a non-UTF-8 path');
  return [...new Set(text.split('\0').filter(Boolean))].filter((path) => {
    if (!safePath(path)) throw new Error('contract input contains an ambiguous path');
    return !excluded(path, exclusions);
  }).sort();
}
/** Git omits untracked FIFOs/sockets; inspect eligible directory entries without following links. */
async function assertNoSpecialFiles(root: string, exclusions: readonly string[], signal?: AbortSignal): Promise<void> {
  const queue = [''];
  let visited = 0;
  while (queue.length > 0) {
    signal?.throwIfAborted();
    const directory = queue.pop()!;
    const absolute = join(root, directory);
    const before = await lstat(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('contract input directory replaced during scan');
    const entries: Dirent[] = [];
    for await (const entry of await opendir(absolute)) {
      signal?.throwIfAborted();
      if (++visited > MAX_FILES * 2) throw new Error('contract input directory scan exceeds bound');
      if (!excluded(directory === '' ? entry.name : `${directory}/${entry.name}`, exclusions)) entries.push(entry);
    }
    if (directoryIdentity(await lstat(absolute, { bigint: true })) !== directoryIdentity(before)) throw new Error('contract input directory replaced during scan');
    const names = entries.map((entry) => `${directory === '' ? '' : `${directory}/`}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    const ignored = names.length === 0 ? new Set<string>() : new Set(git(root, ['check-ignore', '--no-index', '--stdin', '-z'], Buffer.from(`${names.join('\0')}\0`), undefined, true).toString().split('\0'));
    for (let i = 0; i < entries.length; i++) {
      if (ignored.has(names[i]!)) continue;
      const entry = entries[i]!;
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
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
async function readEntry(root: string, path: string): Promise<{ readonly file: ContractInputFile; readonly data?: Buffer }> {
  let parents: string[];
  try { parents = await directories(root, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: { path, kind: 'missing', mode: '0' } };
    throw error;
  }
  const absolute = join(root, path);
  let before: BigIntStats;
  try { before = await lstat(absolute, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { file: { path, kind: 'missing', mode: '0' } };
  }
  let data: Buffer;
  let mode: ContractInputFile['mode'];
  let kind: ContractInputFile['kind'];
  if (before.isSymbolicLink()) {
    data = await readlink(absolute, { encoding: 'buffer' });
    if (!Buffer.from(data.toString('utf8')).equals(data)) throw new Error(`contract input contains a non-UTF-8 symlink: ${path}`);
    kind = 'symlink'; mode = '120000';
  } else {
    if (!before.isFile()) throw new Error(`contract input contains unsupported special file or submodule: ${path}`);
    if (before.size > BigInt(MAX_FILE_BYTES)) throw new Error(`contract input file exceeds capture bound: ${path}`);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error(`contract input file replaced: ${path}`);
      // Bounded reads do not hang on a replacement FIFO, nor grow without limit on an active writer.
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await handle.read(buffer, count, buffer.length - count, count);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      if (count !== Number(before.size) || identity(await handle.stat({ bigint: true })) !== identity(before)) throw new Error(`contract input changed while reading: ${path}`);
      data = buffer.subarray(0, count);
    } finally { await handle.close(); }
    kind = 'file'; mode = (before.mode & 0o111n) !== 0n ? '100755' : '100644';
  }
  if (identity(await lstat(absolute, { bigint: true })) !== identity(before) || JSON.stringify(await directories(root, path)) !== JSON.stringify(parents)) throw new Error(`contract input replaced while reading: ${path}`);
  return { file: { path, kind, mode, digest: digest(data), identity: identity(before) }, data };
}

function checkLinks(files: readonly ContractInputFile[], links: ReadonlyMap<string, string>): void {
  const available = new Map(files.filter((file) => file.kind !== 'missing').map((file) => [file.path, file]));
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
  const started = Date.now();
  const deadline = AbortSignal.timeout(MAX_CAPTURE_MS);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  function check(): void { signal.throwIfAborted(); if (Date.now() - started > MAX_CAPTURE_MS) throw new Error('contract input capture exceeded time bound'); }
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
  if (selected.length > Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES)) throw new Error('contract input exceeds file-count bound');
  const temporary = await mkdtemp(join(tmpdir(), 'goodvibes-contract-input-'));
  const alternateIndex = join(temporary, 'index');
  try {
    const files: ContractInputFile[] = [];
    const links = new Map<string, string>();
    let bytes = 0;
    for (const path of selected) {
      check();
      const entry = await readEntry(root, path);
      if (entry.data === undefined) { files.push(entry.file); continue; }
      bytes += entry.data.length;
      if (bytes > Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES)) throw new Error('contract input exceeds byte bound');
      if (entry.file.kind === 'symlink') links.set(path, entry.data.toString());
      const oid = gitText(root, ['hash-object', '-w', '--stdin', '--no-filters'], entry.data);
      files.push({ ...entry.file, oid });
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
    const current = (await readEntry(root, file.path)).file;
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

/** Verify persisted object provenance, without recapturing today's owner tree. */
export function assertContractInputObjects(snapshot: ContractInputSnapshot, projectRoot: string): void {
  if (!snapshot.dirty && snapshot.inputCommit !== snapshot.ownerHead) throw new Error('clean contract input must name the recorded owner commit');
  if (resolve(projectRoot) !== snapshot.sourceRoot) throw new Error('contract input receipt belongs to a different source root');
  if (gitText(projectRoot, ['rev-parse', `${snapshot.inputCommit}^{tree}`]) !== snapshot.inputTree) throw new Error('contract input commit/tree receipt mismatch');
  const links = new Map(snapshot.files.filter((file) => file.kind === 'symlink').map((file) => [file.path, git(projectRoot, ['cat-file', 'blob', file.oid!]).toString()]));
  checkLinks(snapshot.files, links);
  const actual = git(projectRoot, ['ls-tree', '-r', '-z', snapshot.inputTree]).toString();
  const expected = snapshot.files.filter((file) => file.kind !== 'missing').map((file) => `${file.mode} blob ${file.oid}\t${file.path}\0`).sort().join('');
  if (actual.split('\0').filter(Boolean).map((entry) => `${entry}\0`).sort().join('') !== expected) throw new Error('contract input file/object receipt mismatch');
}

/** Materialize a no-checkout worktree with exact blobs: no smudge filters, checkout hooks or setup. */
export async function materializeContractInput(snapshot: ContractInputSnapshot, worktreePath: string, signal?: AbortSignal): Promise<void> {
  markCapturedInputPath(worktreePath);
  assertContractInputObjects(snapshot, snapshot.sourceRoot);
  await materializeFiles(snapshot.sourceRoot, snapshot.files, snapshot.inputCommit, worktreePath, signal);
}

async function materializeFiles(sourceRoot: string, files: readonly ContractInputFile[], commit: string, worktreePath: string, signal?: AbortSignal): Promise<void> {
  for (const file of files) {
    signal?.throwIfAborted();
    if (file.kind === 'missing') continue;
    const path = join(worktreePath, file.path);
    await mkdir(dirname(path), { recursive: true });
    const data = git(sourceRoot, ['cat-file', 'blob', file.oid!]);
    if (digest(data) !== file.digest) throw new Error(`contract input blob digest mismatch: ${file.path}`);
    if (file.kind === 'symlink') await symlink(data.toString(), path);
    else { await writeFile(path, data, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 }); await chmod(path, file.mode === '100755' ? 0o755 : 0o644); }
  }
  signal?.throwIfAborted();
  git(worktreePath, ['read-tree', commit]);
}

/** Strict receipt validation at the persistence boundary; absent receipts remain explicitly legacy. */
export function isContractInputSnapshot(value: unknown): value is ContractInputSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1 || typeof v['id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(v['id']) || typeof v['sourceRoot'] !== 'string' || !isAbsolute(v['sourceRoot']) || typeof v['sourceIdentity'] !== 'string' || typeof v['gitIdentity'] !== 'string' || typeof v['ownerRef'] !== 'string' || typeof v['capturedAt'] !== 'number' || !Number.isFinite(v['capturedAt']) || typeof v['dirty'] !== 'boolean') return false;
  if (!['ownerHead', 'inputTree', 'inputCommit'].every((key) => typeof v[key] === 'string' && HASH.test(v[key] as string)) || typeof v['indexFingerprint'] !== 'string' || !SHA256.test(v['indexFingerprint'])) return false;
  if (!Array.isArray(v['exclusions']) || JSON.stringify(v['exclusions']) !== JSON.stringify(CONTRACT_INPUT_EXCLUSIONS) || !Array.isArray(v['files']) || v['files'].length > MAX_FILES) return false;
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
  assertContractInputObjects(snapshot, snapshot.sourceRoot);
  const root = viewPath;
  if (gitText(root, ['rev-parse', 'HEAD']) !== snapshot.inputCommit) throw new Error('contract input view no longer names the recorded commit');
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    const current = (await readEntry(root, file.path)).file;
    if (current.kind !== file.kind || current.mode !== file.mode || current.digest !== file.digest) throw new Error(`contract input view changed: ${file.path}`);
  }
  await assertNoSpecialFiles(root, snapshot.exclusions, signal);
  if (JSON.stringify(paths(root, snapshot.exclusions)) !== JSON.stringify(snapshot.files.filter((file) => file.kind !== 'missing').map((file) => file.path))) throw new Error('contract input view path set changed');
}

/** Member worktrees inherit the contract's current exact Git tree, without owner checkout filters/hooks. */
export async function initializeContractMemberWorktree(sourceRoot: string, worktree: { readonly path: string; create(startPoint?: string, checkout?: boolean): Promise<void> }): Promise<void> {
  markCapturedInputPath(worktree.path);
  const commit = gitText(sourceRoot, ['rev-parse', 'HEAD']);
  const entries = git(sourceRoot, ['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean);
  if (entries.length > MAX_FILES) throw new Error('contract member input exceeds file-count bound');
  const files: ContractInputFile[] = [];
  const links = new Map<string, string>();
  let bytes = 0;
  for (const entry of entries) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (match === null || !safePath(match[3]!) || excluded(match[3]!, CONTRACT_INPUT_EXCLUSIONS)) throw new Error('contract member tree contains an unsupported path or object');
    const path = match[3]!;
    const oid = match[2]!;
    const mode = match[1] as ContractInputFile['mode'];
    const data = git(sourceRoot, ['cat-file', 'blob', oid]);
    bytes += data.length;
    if (bytes > MAX_BYTES || data.length > MAX_FILE_BYTES) throw new Error('contract member input exceeds byte bound');
    const kind = mode === '120000' ? 'symlink' : 'file';
    if (kind === 'symlink') links.set(path, data.toString());
    files.push({ path, mode, kind, oid, digest: digest(data) });
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
