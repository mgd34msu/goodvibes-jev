/** Historical comparison inputs are pinned objects, never a mount of the owner's Git directory. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertCapturedInputPathContext,
  assertContractInputGitAuthority,
  contractInputAuthoritySourceRoot,
  contractInputAuthorityRoot,
  isCapturedInputPath,
  registerContractInputReadAssertion,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../../contract/input-snapshot.js';
import { GitService } from '../../git/service.js';
import { assertCapturedToolAccessCurrent, assertCapturedToolReadAccess, hasCapturedToolInvocation } from '../shared/captured-input-tools.js';

interface CapturedAnalysis {
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly signal?: AbortSignal | undefined;
}
const active = new AsyncLocalStorage<CapturedAnalysis>();
const OID = /^[0-9a-f]{40,64}$/;
const MAX_OUTPUT = 32 * 1024 * 1024;

export function withCapturedAnalyzeInput<T>(
  authority: ContractInputAuthority,
  root: string,
  signal: AbortSignal | undefined,
  operation: () => T,
): T {
  return active.run({ authority, root, signal }, operation);
}

export function capturedAnalyzeSignal(): AbortSignal | undefined {
  return active.getStore()?.signal;
}

interface ComparisonInputs {
  readonly kind: 'captured-git-comparison';
  readonly captured_head: string;
  readonly before: { readonly ref: string; readonly commit: string };
  readonly after: { readonly ref: string; readonly commit: string };
}
export interface AnalyzeGitReader extends Pick<GitService, 'diffBetween' | 'diffStat'> {
  readonly comparisonInputs?: ComparisonInputs;
}

/** Only fixed metadata/diff commands reach this helper. Never inherit Git routing or executable diff drivers. */
function git(cwd: string, args: readonly string[], gitDir?: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', [
    '--no-replace-objects', '--no-optional-locks', '-C', cwd,
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false',
    '-c', 'diff.orderFile=/dev/null',
    ...(gitDir === undefined ? [] : [`--git-dir=${gitDir}`, '--bare']), ...args,
  ], {
    env: {
      ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    },
    timeout: 10_000, maxBuffer: MAX_OUTPUT,
  });
  // Neither subprocess diagnostics nor partially read bytes are deliverable on failure.
  if (result.status !== 0) throw new Error('captured historical Git read failed');
  const output = result.stdout.toString('utf8');
  if (!Buffer.from(output).equals(result.stdout)) throw new Error('captured historical Git output is not UTF-8');
  return output;
}

function identity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('captured historical Git directory was redirected');
  return `${stat.dev}:${stat.ino}`;
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' &&
      !CONTRACT_INPUT_EXCLUSIONS.includes(part as (typeof CONTRACT_INPUT_EXCLUSIONS)[number]));
}

/** Preserve Git's metadata-only selectors while refusing predicates that consult live attributes. */
function capturedSelector(file: string, projectRoot: string, root: string): string {
  if (file.length > 4096 || file.includes('\0') || file.includes('\\'))
    throw new Error('unsupported captured comparison path');
  if (file === ':') return file; // Git's existing "no pathspec" form; Git rejects mixing it with other selectors.
  let pattern = file;
  let magic: string[] = [];
  if (file.startsWith(':(')) {
    const closing = file.indexOf(')');
    if (closing === -1) throw new Error('unsupported captured comparison selector');
    magic = file.slice(2, closing).split(',').filter(Boolean);
    pattern = file.slice(closing + 1);
  } else if (file.startsWith(':')) {
    let index = 1;
    while (index < file.length && '/!^'.includes(file[index]!)) {
      magic.push(file[index] === '/' ? 'top' : 'exclude');
      index++;
    }
    if (file[index] === ':') index++;
    pattern = file.slice(index);
  }
  if (magic.some((name) => !['top', 'literal', 'glob', 'icase', 'exclude'].includes(name)))
    throw new Error('unsupported captured comparison selector: live attribute predicates are unavailable');
  const path = relative(root, resolve(magic.includes('top') ? root : projectRoot, pattern)).split(sep).join('/');
  // Exclusions can remove runtime paths from a comparison; only the resulting changed names grant candidates.
  const permitted = path === '' || (magic.includes('exclude')
    ? path.length > 0 && !isAbsolute(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    : safeRelativePath(path));
  if (!permitted) throw new Error('unsupported captured comparison path');
  return `${magic.length > 0 ? `:(${magic.join(',')})` : ''}${path || '.'}`;
}

/** HEAD belongs to this authorized view; explicit refs become separately identified immutable inputs. */
export async function createAnalyzeGitReader(projectRoot: string, before: string, after: string): Promise<AnalyzeGitReader> {
  assertCapturedInputPathContext(projectRoot);
  const context = active.getStore();
  if (!context) {
    if (isCapturedInputPath(projectRoot)) throw new Error('captured Git analysis requires its owned invocation');
    return new GitService(projectRoot);
  }
  if (!hasCapturedToolInvocation() || contractInputAuthorityRoot(context.authority) !== resolve(context.root))
    throw new Error('captured Git analysis requires the matching owned tool invocation');
  await assertContractInputGitAuthority(context.authority, context.signal);
  const prefix = relative(context.root, resolve(projectRoot));
  if (isAbsolute(prefix) || prefix === '..' || prefix.startsWith(`..${sep}`))
    throw new Error('captured Git analysis belongs to another view');
  const source = contractInputAuthoritySourceRoot(context.authority);
  const gitDir = realpathSync(git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  if (realpathSync(git(context.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) !== gitDir)
    throw new Error('captured Git view belongs to another repository');
  const directoryIdentity = identity(gitDir);
  const head = git(context.root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']).trim();
  const pin = (ref: string): string => {
    if (ref.length > 512 || ref.startsWith('-')) throw new Error('invalid captured comparison ref');
    const anchored = ref.replace(/^(?:HEAD|@)(?=$|[~^])/, head);
    // Worktree-local explicit refs/reflogs retain their ordinary meaning, then become immutable OIDs.
    const oid = git(context.root, ['rev-parse', '--verify', '--end-of-options', `${anchored}^{commit}`]).trim();
    if (!OID.test(oid)) throw new Error('captured comparison ref is not a commit');
    return oid;
  };
  // Pin both refs synchronously before any path-permission callback can move them.
  if (!OID.test(head)) throw new Error('captured view HEAD is not a commit');
  const beforeCommit = pin(before);
  const afterCommit = pin(after);
  const comparisonInputs: ComparisonInputs = Object.freeze({
    kind: 'captured-git-comparison', captured_head: head,
    before: Object.freeze({ ref: before, commit: beforeCommit }),
    after: Object.freeze({ ref: after, commit: afterCommit }),
  });
  const assertObjectsCurrent = async (): Promise<void> => {
    await assertContractInputGitAuthority(context.authority, context.signal);
    if (identity(gitDir) !== directoryIdentity) throw new Error('captured Git directory changed');
    context.signal?.throwIfAborted();
  };
  registerContractInputReadAssertion(context.authority, assertObjectsCurrent);
  const assertCurrent = async (): Promise<void> => {
    await assertObjectsCurrent();
    await assertCapturedToolAccessCurrent();
  };
  const diff = async (stat: boolean, files?: string[]): Promise<string> => {
    await assertCurrent();
    const selection = files?.map((file) => capturedSelector(file, projectRoot, context.root));
    const base = ['diff-tree', '--no-commit-id', '-r', '--no-ext-diff', '--no-textconv', '--no-renames'];
    // --name-only does not open blobs. Authorize both sides of every selected change before diff/stat reads them.
    const names = git(source, [...base, '--name-only', '-z', beforeCommit, afterCommit,
      ...(selection?.length ? ['--', ...selection] : [])], gitDir).split('\0').filter(Boolean);
    if (names.length > 20_000) throw new Error('captured comparison exceeds file-count bound');
    for (const path of names) {
      if (!safeRelativePath(path)) throw new Error('captured comparison contains an excluded or ambiguous path');
      await assertCapturedToolReadAccess(join(context.root, path));
    }
    await assertCurrent();
    if (names.length === 0) return '';
    const output = git(source, ['--literal-pathspecs', 'diff-tree', '--no-commit-id', '-r',
      '--no-ext-diff', '--no-textconv', '--submodule=short', stat ? '--stat' : '-p', beforeCommit, afterCommit, '--', ...names], gitDir);
    await assertCurrent();
    return output;
  };
  return {
    comparisonInputs,
    diffBetween: async (_before: string, _after: string, files?: string[]) => diff(false, files),
    diffStat: async () => diff(true),
  };
}
