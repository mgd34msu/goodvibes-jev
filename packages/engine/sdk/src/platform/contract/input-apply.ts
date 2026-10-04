/** Apply only a captured generation's result delta, without staging owner work. */
import { spawnSync } from 'node:child_process';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import type { Contract } from './types.js';
import {
  assertContractInputAuthority,
  authorizeContractInputPath,
  createContractInputAuthority,
  revokeContractInputAuthority,
} from './input-authority.js';
import { assertContractExecutionView, assertContractInputObjects, assertContractInputOwner } from './input-snapshot.js';

const applyTails = new Map<string, Promise<void>>();
const MAX_PATCH_BYTES = 512 * 1024 * 1024;

function git(root: string, args: readonly string[], input?: Buffer): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync(
    'git',
    ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    {
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      input,
      maxBuffer: MAX_PATCH_BYTES,
      timeout: 30_000,
    },
  );
  // Git's diagnostic may include source hunk content. Keep retained-result notes fixed.
  if (result.status !== 0)
    throw new Error(`captured result ${args[0]} failed; owner changes and result branch are retained`);
  return result.stdout;
}

async function applyDelta(
  contract: Contract,
  filter: ReadAccessFilter | undefined,
  signal: AbortSignal,
): Promise<number> {
  const snapshot = contract.inputSnapshot;
  const view = contract.worktreePath;
  const branch = contract.branch;
  if (!snapshot || !view || !branch) throw new Error('captured result has no admitted input/workspace');
  if (!filter) throw new Error('captured result requires original-owner read authorization');
  const root = snapshot.sourceRoot;
  const authority = await createContractInputAuthority(contract, view, { signal, mutable: true, branch });
  try {
    assertContractInputObjects(snapshot, root);
    assertContractExecutionView(snapshot, view, branch);
    const resultHead = git(view, ['rev-parse', 'HEAD']).toString('utf8').trim();
    const raw = git(root, [
      'diff',
      '--raw',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '-z',
      snapshot.inputCommit,
      resultHead,
      '--',
    ])
      .toString('utf8')
      .split('\0');
    for (let index = 0; index < raw.length - 1; index += 2) {
      const modes = /^:(000000|100644|100755) (000000|100644|100755) [0-9a-f]+ [0-9a-f]+ [AMD]$/.exec(raw[index]!);
      if (!modes) throw new Error('captured result delta contains an unsupported file kind');
    }
    const names = git(root, [
      'diff',
      '--name-only',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '-z',
      snapshot.inputCommit,
      resultHead,
      '--',
    ]);
    const text = names.toString('utf8');
    if (!Buffer.from(text).equals(names)) throw new Error('captured result has ambiguous paths');
    const paths = [...new Set(text.split('\0').filter(Boolean))];
    if (
      paths.some(
        (path) => path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..'),
      )
    )
      throw new Error('captured result has ambiguous paths');
    for (const path of paths) await authorizeContractInputPath(authority, path, filter, signal);
    const patch = git(root, [
      'diff',
      '--binary',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      snapshot.inputCommit,
      resultHead,
      '--',
    ]);
    await assertContractInputOwner(snapshot, signal);
    if (paths.length === 0) return 0;
    // Default git apply is all-or-nothing on a failed hunk; never use --reject,
    // --3way, --index, --cached or a reset against the owner's working tree.
    git(root, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], patch);
    for (const path of paths) await authorizeContractInputPath(authority, path, filter, signal);
    await assertContractInputAuthority(authority, view, signal);
    await assertContractInputOwner(snapshot, signal);
    if (git(view, ['rev-parse', 'HEAD']).toString('utf8').trim() !== resultHead)
      throw new Error('captured result changed during apply admission');
    signal.throwIfAborted();
    // No await between the final admission and synchronous Git application.
    // External noncooperating filesystem writers remain outside this transaction.
    git(root, ['apply', '--binary', '--whitespace=nowarn', '-'], patch);
    return paths.length;
  } finally {
    revokeContractInputAuthority(authority);
  }
}

/** Cooperating applies serialize; a second run must revalidate its original receipt. */
export async function applyCapturedInputDelta(
  contract: Contract,
  filter: ReadAccessFilter | undefined,
  signal: AbortSignal,
): Promise<number> {
  const root = contract.projectRoot;
  const previous = applyTails.get(root) ?? Promise.resolve();
  const operation = previous.then(() => {
    signal.throwIfAborted();
    return applyDelta(contract, filter, signal);
  });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  applyTails.set(root, tail);
  try {
    return await operation;
  } finally {
    if (applyTails.get(root) === tail) applyTails.delete(root);
  }
}
