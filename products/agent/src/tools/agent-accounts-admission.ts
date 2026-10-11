import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assertCurrentToolEffect, assertCurrentToolInvocation, assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { AgentAccountsToolOptions } from './agent-accounts-tool.ts';
import { assertAgentMemoryInput } from './agent-memory-input-guard.ts';
import { getSessionExpectationBook } from '../agent/signup/session-expectations.ts';
import { getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { captureCatalogData, captureCatalogMethods } from './agent-harness-catalog-ranking.ts';

function identity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.mode}`; }
function revision(stat: BigIntStats): string { return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`; }
function stale(): never { throw new ToolInputProjectionError('stale'); }

function fileRevision(path: string, expected?: string): string | null {
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!before) { if (expected !== undefined) stale(); return null; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4_000_000n) throw new ToolInputProjectionError('held');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (revision(fstatSync(fd, { bigint: true })) !== revision(before)) stale();
    const bytes = readFileSync(fd);
    if (revision(fstatSync(fd, { bigint: true })) !== revision(before)
      || revision(lstatSync(path, { bigint: true })) !== revision(before)
      || (expected !== undefined && !bytes.equals(Buffer.from(expected)))) stale();
    return `${revision(before)}:${createHash('sha256').update(bytes).digest('hex')}`;
  } finally { closeSync(fd); }
}

interface DirectoryRevision { readonly path: string; readonly identity: string | null; readonly physical: string | null; readonly linkRevision: string | null; readonly changeTime: bigint | null }
function directoryRevisions(path: string): DirectoryRevision[] {
  const parents: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) { parents.unshift(parent); if (parent === dirname(parent)) break; }
  return parents.map(parent => {
    const stat = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (!stat) return { path: parent, identity: null, physical: null, linkRevision: null, changeTime: null };
    if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new ToolInputProjectionError('held');
    const target = stat.isSymbolicLink() ? statSync(parent, { bigint: true }) : stat;
    if (!target.isDirectory()) throw new ToolInputProjectionError('held');
    return { path: parent, identity: `${identity(stat)}:${identity(target)}`, physical: realpathSync(parent),
      linkRevision: stat.isSymbolicLink() ? revision(stat) : null, changeTime: target.ctimeNs };
  });
}
function assertDirectories(before: readonly DirectoryRevision[], after: readonly DirectoryRevision[], ownedWrite = false): void {
  const closest = before.findLast(entry => entry.identity !== null);
  for (let index = 0; index < before.length; index++) {
    const original = before[index], current = after[index];
    if (!original || !current) stale();
    if (original.identity === null && ownedWrite) {
      if (current.linkRevision !== null) stale();
      continue;
    }
    if (current.identity !== original.identity || current.physical !== original.physical
      || current.linkRevision !== original.linkRevision
      || (!ownedWrite && original === closest && current.changeTime !== original.changeTime)) stale();
  }
}

interface AccountCapture {
  readonly owner: AgentAccountsToolOptions;
  readonly assertCurrent: () => void;
  readonly didWrite: (stage: 'parent' | 'temporary' | 'store', content: string) => void;
}
const contexts = new WeakMap<object, AccountCapture>();

/** Retain the exact account owner, file, and session sources before semantic admission. */
export function createAgentAccountsInputProjector(options: AgentAccountsToolOptions): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted(); assertAgentMemoryInput(request.args);
    const optionsCurrent = captureCatalogMethods(options, ['registry', 'baseAddress', 'knownSecretKeys', 'shellPaths']);
    const registry = options.registry, baseAddress = options.baseAddress, knownSecretKeys = options.knownSecretKeys;
    const registryCurrent = captureCatalogMethods(registry, ['getStorePath', 'snapshot', 'record', 'forget', 'sweep', 'storePath', 'containsSecretLikeText']);
    const getStorePath = registry.getStorePath, snapshot = registry.snapshot, record = registry.record, forget = registry.forget, sweep = registry.sweep;
    const path = resolve(getStorePath.call(registry)), configuredPath = getStorePath.call(registry);
    let directories = directoryRevisions(path), file = fileRevision(path);
    const shellPaths = options.shellPaths;
    const pathsCurrent = shellPaths && captureCatalogMethods(shellPaths, ['workingDirectory', 'homeDirectory', 'resolveWorkspacePath', 'resolveUserPath']);
    const workspace = shellPaths?.workingDirectory;
    if (shellPaths && (!workspace || !isAbsolute(workspace))) throw new ToolInputProjectionError('held');
    let workspaceDirectories = workspace ? directoryRevisions(resolve(workspace, 'account-workspace-fence')) : undefined;
    const workspacePhysical = workspace && realpathSync(workspace);
    const closestStoreParent = directories.findLast(entry => entry.physical !== null);
    const physicalStore = closestStoreParent?.physical && resolve(closestStoreParent.physical, relative(closestStoreParent.path, path));
    const storeRelation = workspacePhysical && physicalStore ? relative(workspacePhysical, physicalStore) : undefined;
    const ownsWorkspaceWrite = storeRelation !== undefined && !isAbsolute(storeRelation) && storeRelation !== '..' && !storeRelation.startsWith(`..${sep}`);
    const action = request.args.action;
    const book = action === 'alias' ? getSessionExpectationBook() : undefined, open = book?.openExpectation;
    const bookCurrent = book && captureCatalogMethods(book, ['openExpectation', 'authority', 'open', 'sweepExpired', 'findByRecipient']);
    const base = action === 'alias' ? baseAddress?.() ?? null : undefined;
    const ledger = action === 'record' ? getSessionUntrustedContentLedger() : undefined;
    const ledgerCurrent = ledger && captureCatalogMethods(ledger, ['all', 'ingestedThisTurn', 'taintSourcesThisTurn', 'exposuresThisTurn']);
    const ledgerRevision = () => ledger && JSON.stringify(captureCatalogData([ledger.all(), ledger.ingestedThisTurn(), ledger.taintSourcesThisTurn(), ledger.exposuresThisTurn()]));
    const originalLedger = ledgerRevision();
    let released = false;
    const assertOwner = () => {
      optionsCurrent(); registryCurrent(); bookCurrent?.(); ledgerCurrent?.(); pathsCurrent?.();
      if (released || options.registry !== registry || options.baseAddress !== baseAddress || options.knownSecretKeys !== knownSecretKeys
        || registry.getStorePath !== getStorePath || registry.snapshot !== snapshot || registry.record !== record || registry.forget !== forget || registry.sweep !== sweep
        || getStorePath.call(registry) !== configuredPath || resolve(configuredPath) !== path
        || (book && (getSessionExpectationBook() !== book || book.openExpectation !== open || (baseAddress?.() ?? null) !== base))
        || (ledger && (getSessionUntrustedContentLedger() !== ledger || ledgerRevision() !== originalLedger))) stale();
      optionsCurrent(); registryCurrent(); bookCurrent?.(); ledgerCurrent?.(); pathsCurrent?.();
    };
    const assertTarget = () => {
      assertOwner();
      assertDirectories(directories, directoryRevisions(path));
      if (workspaceDirectories && workspace) assertDirectories(workspaceDirectories, directoryRevisions(resolve(workspace, 'account-workspace-fence')));
      if (fileRevision(path) !== file) stale();
    };
    const assertCurrent = () => { request.assertCurrent(); request.signal?.throwIfAborted(); assertTarget(); };
    assertCurrent();
    const context = Object.freeze({});
    contexts.set(context, { owner: options, assertCurrent: assertTarget,
      didWrite(stage, content) {
        // These callbacks follow this owner's synchronous fs operation. Only
        // its known bytes and newly created directories may advance the fence.
        const next = directoryRevisions(path);
        assertDirectories(directories, next, true);
        if (stage === 'store') file = fileRevision(path, content);
        else if (fileRevision(path) !== file) stale();
        directories = next;
        if (workspaceDirectories && workspace) {
          const nextWorkspace = directoryRevisions(resolve(workspace, 'account-workspace-fence'));
          assertDirectories(workspaceDirectories, nextWorkspace, ownsWorkspaceWrite); workspaceDirectories = nextWorkspace;
        }
      } });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      ...(action === 'list' ? { resultPublication: 'read-only' } : {}),
      assertRepairedArgs(args) { assertAgentMemoryInput(args); if (args.action !== action) throw new ToolInputProjectionError('binding-changed'); assertCurrent(); },
      async release() { released = true; contexts.delete(context); } };
  } };
}

/** Caller flags cannot create either the execution proof or the private owner binding. */
export function agentAccountsWriteGuard(owner: AgentAccountsToolOptions, args: Record<string, unknown>, options?: ToolExecuteOptions) {
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
    const context = options?.inputProjectionContext, capture = context && contexts.get(context);
    if (!context || !capture || capture.owner !== owner) throw new ToolInputProjectionError('held');
    assertProjectionExecution(context, args); capture.assertCurrent();
  };
  return { assertCurrent, didWrite(stage: 'parent' | 'temporary' | 'store', content: string) {
    const context = options?.inputProjectionContext, capture = context && contexts.get(context);
    if (!context || !capture || capture.owner !== owner) throw new ToolInputProjectionError('held');
    assertProjectionExecution(context, args); capture.didWrite(stage, content);
    assertCurrent();
  } };
}

/** Registered observations retain the same source through the owner's read. */
export function assertAgentAccountsRead(owner: AgentAccountsToolOptions, args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  const context = options?.inputProjectionContext;
  if (!context) return;
  options?.signal?.throwIfAborted();
  const capture = contexts.get(context);
  if (!capture || capture.owner !== owner || !assertCurrentToolInvocation(args, options)) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); capture.assertCurrent();
}
