/** Record and verify a pinned local Git tree without reading HEAD or the worktree. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export interface UpstreamSourceEntry {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000' | '160000';
  readonly type: 'blob' | 'commit';
  readonly object: string;
}

export interface UpstreamSourceSnapshot {
  readonly schemaVersion: 1;
  readonly commit: string;
  readonly tree: string;
  readonly entries: readonly UpstreamSourceEntry[];
}

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function requireCommit(commit: string): void {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw new Error('Commit must be an explicit full lowercase Git object ID (40 or 64 hex characters), not a branch, tag, or abbreviated revision');
  }
}

class GitReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function readGit(sourceDirectory: string, args: string[]): string {
  if (sourceDirectory.length === 0) throw new Error('A local source directory is required');
  // Do not let an inherited GIT_DIR or object-directory override select a
  // different repository. Disable replacement refs and partial-clone fetching.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['--no-replace-objects', '-C', sourceDirectory, ...args], {
    env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8').trim() ?? `signal ${result.signal}`;
    throw new GitReadError(`Git read failed for source ${JSON.stringify(sourceDirectory)} (exit ${result.status ?? 'unavailable'}): ${detail}`, result.status && result.status > 0 ? result.status : 1);
  }
  try {
    // Never silently replace invalid path bytes and claim an exact snapshot.
    return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error('Source tree contains a path that is not valid UTF-8; it cannot be represented exactly in this JSON snapshot');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject malformed or ambiguous records before comparing them with Git. */
export function validateUpstreamSourceSnapshot(value: unknown): asserts value is UpstreamSourceSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.commit !== 'string' || typeof value.tree !== 'string' || !Array.isArray(value.entries)) {
    throw new Error('Invalid source snapshot: expected schemaVersion 1, commit, tree, and entries');
  }
  requireCommit(value.commit);
  if (!FULL_OBJECT_ID.test(value.tree) || value.tree.length !== value.commit.length) {
    throw new Error('Invalid source snapshot root tree object ID');
  }
  const paths = new Set<string>();
  for (const entry of value.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.object !== 'string') {
      throw new Error('Invalid source snapshot entry: expected path, mode, type, and object');
    }
    const path = entry.path;
    if (path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..') || Buffer.from(path, 'utf8').toString('utf8') !== path) {
      throw new Error(`Invalid source snapshot path ${JSON.stringify(path)}`);
    }
    if (paths.has(path)) throw new Error(`Duplicate source snapshot path ${JSON.stringify(path)}`);
    paths.add(path);
    const validMode = entry.type === 'blob'
      ? entry.mode === '100644' || entry.mode === '100755' || entry.mode === '120000'
      : entry.type === 'commit' && entry.mode === '160000';
    if (!validMode) throw new Error(`Invalid source snapshot mode/type at ${JSON.stringify(path)}`);
    if (!FULL_OBJECT_ID.test(entry.object) || entry.object.length !== value.commit.length) {
      throw new Error(`Invalid source snapshot object ID at ${JSON.stringify(path)}`);
    }
  }
}

/** Blob IDs identify contents (including symlink targets); gitlinks pin commits. */
export function createUpstreamSourceSnapshot(sourceDirectory: string, commit: string): UpstreamSourceSnapshot {
  requireCommit(commit);
  const type = readGit(sourceDirectory, ['cat-file', '-t', commit]).trim();
  if (type !== 'commit') throw new Error(`Pinned object ${commit} is a ${type}, not a commit`);
  const tree = readGit(sourceDirectory, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();
  const listing = readGit(sourceDirectory, ['ls-tree', '--full-tree', '-r', '-z', commit]);
  if (listing !== '' && !listing.endsWith('\0')) throw new Error('Incomplete Git tree listing');
  const entries = listing === '' ? [] : listing.slice(0, -1).split('\0').map((record) => {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`Unsupported Git tree entry ${JSON.stringify(record)}`);
    return { path: match[4]!, mode: match[1]!, type: match[2]!, object: match[3]! };
  });
  const snapshot: unknown = { schemaVersion: 1, commit, tree, entries };
  validateUpstreamSourceSnapshot(snapshot);
  return snapshot;
}

/** The expected pin is separate from the snapshot so changing its commit cannot pass. */
export function verifyUpstreamSourceSnapshot(sourceDirectory: string, commit: string, snapshot: unknown): void {
  requireCommit(commit);
  validateUpstreamSourceSnapshot(snapshot);
  if (snapshot.commit !== commit) throw new Error(`Snapshot commit mismatch: expected ${commit}, recorded ${snapshot.commit}`);
  const actual = createUpstreamSourceSnapshot(sourceDirectory, commit);
  if (snapshot.tree !== actual.tree) throw new Error(`Snapshot root tree mismatch: expected ${actual.tree}, recorded ${snapshot.tree}`);
  const remaining = new Map(actual.entries.map((entry) => [entry.path, entry]));
  for (const recorded of snapshot.entries) {
    const expected = remaining.get(recorded.path);
    if (!expected) throw new Error(`Unexpected snapshot path ${JSON.stringify(recorded.path)}`);
    for (const field of ['mode', 'type', 'object'] as const) {
      if (recorded[field] !== expected[field]) {
        throw new Error(`Snapshot ${field} mismatch at ${JSON.stringify(recorded.path)}: expected ${expected[field]}, recorded ${recorded[field]}`);
      }
    }
    remaining.delete(recorded.path);
  }
  const missing = remaining.keys().next();
  if (!missing.done) throw new Error(`Missing snapshot path ${JSON.stringify(missing.value)}`);
}

const USAGE = 'Usage: bun packages/engine/scripts/upstream-source-snapshot.ts --source-dir <local-repo> --commit <full-object-id> --snapshot <file.json> [--check]';

function main(args: string[]): void {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const options = new Map<string, string>();
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--check' && !check) { check = true; continue; }
    if (!['--source-dir', '--commit', '--snapshot'].includes(flag) || options.has(flag)) throw new Error(`Unknown or duplicate argument ${flag}\n${USAGE}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}\n${USAGE}`);
    options.set(flag, value);
  }
  const sourceDirectory = options.get('--source-dir');
  const commit = options.get('--commit');
  const file = options.get('--snapshot');
  if (!sourceDirectory || !commit || !file) throw new Error(USAGE);
  if (check) {
    const snapshot: unknown = JSON.parse(readFileSync(file, 'utf8'));
    verifyUpstreamSourceSnapshot(sourceDirectory, commit, snapshot);
    console.log(`upstream-source-snapshot: verified ${commit} against ${file}`);
  } else {
    const snapshot = createUpstreamSourceSnapshot(sourceDirectory, commit);
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`upstream-source-snapshot: recorded ${snapshot.entries.length} entries at ${commit} in ${file}`);
  }
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`upstream-source-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof GitReadError ? error.status : 1;
  }
}
