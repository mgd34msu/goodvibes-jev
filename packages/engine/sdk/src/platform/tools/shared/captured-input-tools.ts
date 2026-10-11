import { assertCurrentToolExecution } from '../registry.js';
import { withCapturedAnalyzeInput } from '../analyze/captured-git.js';
import { assertCapturedWriteRevision, captureCapturedWriteRevision, type CapturedWriteRevision } from './captured-write-revision.js';
import { prepareCapturedWriteBackup } from './captured-write-backup.js';
import { withCapturedPublication, type CapturedPublicationLease } from './captured-publication.js';
import { isCapturedRegistryTool } from '../registry-tool/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
/** Defense-in-depth around the actual captured-view tool implementations. */
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { isCapturedExecTool } from '../exec/runtime.js';
import { isCapturedReplTool } from '../repl/captured.js';
import type { Tool } from '../../types/tools.js';
import type { ReadAccessFilter } from './read-access.js';
import {
  assertContractInputAuthority,
  assertCapturedInputPathContext,
  assertContractInputReadAccess,
  withContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthorityMutable,
  contractInputAuthorityRoot,
  contractInputAuthoritySourceRoot,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';

const deliveryReads = new AsyncLocalStorage<{
  readonly paths: Set<string>;
  readonly checks: Set<() => Promise<void>>;
  readonly assertMutable: (path?: string) => void;
  readonly assertRevision: (path: string, revision: CapturedWriteRevision) => void;
  readonly captureRevision: (path: string, bytes: Buffer) => CapturedWriteRevision;
  readonly prepareBackup: (path: string) => ReturnType<typeof prepareCapturedWriteBackup>;
  readonly publicationLease?: CapturedPublicationLease | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly authorize: (path: string) => Promise<void>;
  readonly assertCurrent: () => Promise<void>;
  readonly assertInvocationCurrent: () => void;
}>();

export async function assertCapturedToolReadAccess(path: string): Promise<void> {
  assertCapturedInputPathContext(path);
  await deliveryReads.getStore()?.authorize(path);
}
/** Synchronous invocation/token fence; never a source-read authorization. */
export function assertCapturedToolInvocationCurrent(): void {
  deliveryReads.getStore()?.assertInvocationCurrent();
}
export async function assertCapturedToolAccessCurrent(): Promise<void> {
  await deliveryReads.getStore()?.assertCurrent();
}
export function hasCapturedToolInvocation(): boolean {
  return deliveryReads.getStore() !== undefined;
}

export function assertCapturedToolMutationCurrent(path?: string): void {
  deliveryReads.getStore()?.assertMutable(path);
}
export async function prepareCapturedToolBackup(path: string, dryRun = false): ReturnType<typeof prepareCapturedWriteBackup> {
  const context = deliveryReads.getStore();
  if (!context) throw new Error('captured backup requires an owned invocation');
  const backup = await context.prepareBackup(path);
  if (dryRun) context.checks.add(backup.assertCurrent);
  return { ...backup, create: (revision?: CapturedWriteRevision) => {
    backup.create(revision);
    context.checks.add(backup.assertCurrent);
  } };
}

export function captureCapturedToolWriteRevision(path: string, bytes: Buffer): CapturedWriteRevision {
  const context = deliveryReads.getStore();
  if (!context) throw new Error('owned write revision requires a captured invocation');
  context.assertMutable(path);
  return context.captureRevision(path, bytes);
}

export function assertCapturedToolWriteRevision(path: string, revision: CapturedWriteRevision): void {
  const context = deliveryReads.getStore();
  if (!context) throw new Error('owned write revision requires a captured invocation');
  context.assertMutable(path);
  context.assertRevision(path, revision);
}

export function capturedToolPublicationContext(): { readonly lease: CapturedPublicationLease; readonly signal?: AbortSignal | undefined } {
  const context = deliveryReads.getStore();
  if (!context?.publicationLease) throw new Error('captured validator requires its active write/edit publication owner');
  return { lease: context.publicationLease, signal: context.signal };
}

class UnsupportedCapturedWorkflow extends Error {}

function freezeInput<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeInput(child);
    Object.freeze(value);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function capturedInputTool(
  tool: Tool,
  authority: ContractInputAuthority,
  root: string,
  filter: ReadAccessFilter | undefined,
  signal: AbortSignal | undefined,
): Tool {
  const name = tool.definition.name;
  return {
    definition: tool.definition,
    async execute(args, options) {
      // Preserve exact registry-authenticated effect arguments/options. Rewritten
      // read arguments retain original currentness only in this owner closure.
      const authenticated = assertCurrentToolExecution(args, options);
      // Rewritten captured-view args cannot borrow the original invocation's
      // proof. Keep that exact args/options pair in this owner closure instead.
      const invocationArgs = args;
      const invocationOptions = options;
      const callSignal = options?.signal;
      const assertInvocationCurrent = (): void => {
        signal?.throwIfAborted();
        callSignal?.throwIfAborted();
        assertCurrentToolExecution(invocationArgs, invocationOptions);
        // This accessor checks the construction-owned token and pinned receipt,
        // without granting access or replaying the source/view readset.
        contractInputAuthorityRoot(authority);
      };
      const readOptions = options === undefined ? undefined : Object.freeze({ signal: callSignal });
      return withContractInputAuthority(authority, () =>
        deliveryReads.run(
          {
            paths: new Set<string>(),
            assertInvocationCurrent,
            checks: new Set<() => Promise<void>>(),
            assertMutable: (path) => {
              signal?.throwIfAborted(); assertInvocationCurrent();
              if (!contractInputAuthorityMutable(authority)) throw new Error('immutable captured input cannot be changed');
              if (path !== undefined) {
                const target = resolve(root, path);
                if (!deliveryReads.getStore()!.paths.has(target)) throw new Error('captured mutation path has not been admitted');
                const rel = relative(root, target);
                if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('captured mutation path is outside the view');
                for (const base of [root, contractInputAuthoritySourceRoot(authority)]) {
                  if (realpathSync(base) !== base) throw new Error('captured mutation root redirected');
                  let current = base;
                  const parts = rel.split(sep);
                  for (let index = 0; index < parts.length; index++) {
                    current = join(current, parts[index]!);
                    try {
                      const stat = lstatSync(current);
                      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
                        throw new Error('captured mutation path is an alias or special file');
                      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('captured mutation parent changed');
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
                      throw error;
                    }
                  }
                }
              }
            },
            assertRevision: (path, revision) => { assertCapturedWriteRevision(revision, authority, capturedToolPublicationContext().lease, path); },
            captureRevision: (path, bytes) => captureCapturedWriteRevision(authority, capturedToolPublicationContext().lease, path, bytes),
            prepareBackup: (path) => {
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              return prepareCapturedWriteBackup({ authority, root, readAccessFilter: filter, signal: combined }, path, combined, capturedToolPublicationContext().lease);
            },
            signal: callSignal,
            authorize: async (path) => {
              assertInvocationCurrent();
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              const authorized = await authorizeContractInputPath(authority, resolve(root, path), filter, combined);
              assertInvocationCurrent();
              deliveryReads.getStore()!.paths.add(authorized);
            },
            assertCurrent: async () => {
              assertInvocationCurrent();
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              await assertContractInputReadAccess(authority, filter, combined);
              assertInvocationCurrent();
            },
          },
          async () => {
            try {
              assertInvocationCurrent();
              // Model arguments and callers remain mutable outside this invocation.
              // Pin an owned deep copy before the first permission/validation await.
              if (!authenticated) args = freezeInput(structuredClone(args));
              await assertContractInputAuthority(authority, root, signal);
              assertInvocationCurrent();
              if (!filter) throw new Error('captured input requires original-owner read authorization');
              await assertCapturedToolAccessCurrent();
              if (name === 'read') {
                // Actual ReadTool gates each path before its in-process extractors read bytes.
              } else if (name === 'find') {
                const queries = Array.isArray(args.queries) ? args.queries : [];
                if (queries.some((query) => object(query).follow_symlinks === true))
                  throw new UnsupportedCapturedWorkflow(
                    'captured find cannot follow symlinks outside its authorized view',
                  );
              } else if (name === 'exec') {
                if (!isCapturedExecTool(tool, authority))
                  throw new UnsupportedCapturedWorkflow(
                    'captured exec requires its construction-owned execution backend',
                  );
              } else if (name === 'repl') {
                if (!isCapturedReplTool(tool, authority))
                  throw new UnsupportedCapturedWorkflow(
                    'captured REPL requires its construction-owned execution backend',
                  );
              } else if (name === 'edit') {
                if (!contractInputAuthorityMutable(authority))
                  throw new UnsupportedCapturedWorkflow('immutable captured planner input cannot be edited');
              } else if (name === 'registry') {
                if (!isCapturedRegistryTool(tool, authority))
                  throw new UnsupportedCapturedWorkflow(
                    'captured registry requires its construction-owned original-owner context',
                  );
              } else if (name === 'fetch') {
                // The actual fetch backend performs HTTP only, under its existing gate/network policy.
              } else if (name === 'inspect') {
                if (args.mode === 'scaffold' && args.dryRun === false && !contractInputAuthorityMutable(authority))
                  throw new UnsupportedCapturedWorkflow('immutable captured planner input cannot be scaffolded');
                const requestedRoot =
                  typeof args.projectRoot === 'string' && args.projectRoot.trim().length > 0
                    ? resolve(root, args.projectRoot)
                    : root;
                if (requestedRoot !== root) await assertCapturedToolReadAccess(requestedRoot);
                args = freezeInput({ ...args, projectRoot: requestedRoot });
              } else if (name === 'analyze') {
                const requestedRoot =
                  typeof args.projectRoot === 'string' && args.projectRoot.trim().length > 0
                    ? resolve(root, args.projectRoot)
                    : root;
                if (requestedRoot !== root) await assertCapturedToolReadAccess(requestedRoot);
                args = freezeInput({ ...args, projectRoot: requestedRoot });
              } else if (name === 'write') {
                if (!contractInputAuthorityMutable(authority))
                  throw new UnsupportedCapturedWorkflow('immutable captured planner input cannot be written');
              } else {
                throw new UnsupportedCapturedWorkflow(
                  `captured ${name} requires an original-owner-authorized backend; this workflow is not yet available`,
                );
              }
              const childOptions = authenticated && args === invocationArgs ? invocationOptions : readOptions;
              const publicationSignal = signal && callSignal ? AbortSignal.any([signal, callSignal]) : signal ?? callSignal;
              const result = name === 'write' || name === 'edit' || (name === 'inspect' && args.mode === 'scaffold' && args.dryRun === false)
                ? await withCapturedPublication(authority, (publicationLease) => deliveryReads.run(
                  { ...deliveryReads.getStore()!, publicationLease, signal: publicationSignal },
                  () => tool.execute(args, childOptions),
                ), publicationSignal)
                : name === 'analyze'
                  ? await withCapturedAnalyzeInput(authority, root, publicationSignal, () => tool.execute(args, childOptions))
                  : await tool.execute(args, childOptions);
              await assertContractInputAuthority(authority, root, signal);
              assertInvocationCurrent();
              // No content, cached output, diagnostics or errors leave after revocation.
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              for (const path of deliveryReads.getStore()!.paths)
                await authorizeContractInputPath(authority, path, filter, combined);
              for (const check of deliveryReads.getStore()!.checks) await check();
              await assertCapturedToolAccessCurrent();
              combined?.throwIfAborted();
              return result;
            } catch (error) {
              if (error instanceof UnsupportedCapturedWorkflow) return { success: false, error: error.message };
              // Backend error strings can include source bytes. A held call returns
              // only this fixed diagnosis, not an exception or partial tool output.
              return {
                success: false,
                error:
                  'Captured input tool held: missing, changed, cancelled or restricted original-owner/view authority, or an unsupported captured workflow. Output withheld.',
              };
            }
          },
        ),
      );
    },
  };
}

export function capturedInputReadFilter(
  authority: ContractInputAuthority,
  root: string,
  filter: ReadAccessFilter | undefined,
  signal: AbortSignal | undefined,
  delivered: Set<string>,
): ReadAccessFilter {
  return async (raw) => {
    try {
      const readset = deliveryReads.getStore();
      if (!readset) throw new Error('captured read has no owned tool invocation');
      const combinedSignal =
        signal && readset.signal ? AbortSignal.any([signal, readset.signal]) : (signal ?? readset.signal);
      const path = await authorizeContractInputPath(authority, resolve(root, raw), filter, combinedSignal);
      readset.paths.add(path);
      delivered.add(path);
      return true;
    } catch {
      return false;
    }
  };
}
