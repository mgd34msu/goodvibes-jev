import { withCapturedAnalyzeInput } from '../analyze/captured-git.js';
import { withCapturedPublication } from './captured-publication.js';
import { isCapturedRegistryTool } from '../registry-tool/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
/** Defense-in-depth around the actual captured-view tool implementations. */
import { resolve } from 'node:path';
import { isCapturedExecTool } from '../exec/runtime.js';
import type { Tool } from '../../types/tools.js';
import type { ReadAccessFilter } from './read-access.js';
import {
  assertContractInputAuthority,
  assertCapturedInputPathContext,
  assertContractInputReadAccess,
  withContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';

const deliveryReads = new AsyncLocalStorage<{
  readonly paths: Set<string>;
  readonly signal?: AbortSignal | undefined;
  readonly authorize: (path: string) => Promise<void>;
  readonly assertCurrent: () => Promise<void>;
}>();

export async function assertCapturedToolReadAccess(path: string): Promise<void> {
  assertCapturedInputPathContext(path);
  await deliveryReads.getStore()?.authorize(path);
}
export async function assertCapturedToolAccessCurrent(): Promise<void> {
  await deliveryReads.getStore()?.assertCurrent();
}
export function hasCapturedToolInvocation(): boolean {
  return deliveryReads.getStore() !== undefined;
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
      options = options === undefined ? undefined : Object.freeze({ signal: options.signal });
      return withContractInputAuthority(authority, () =>
        deliveryReads.run(
          {
            paths: new Set<string>(),
            signal: options?.signal,
            authorize: async (path) => {
              const callSignal = options?.signal;
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              const authorized = await authorizeContractInputPath(authority, resolve(root, path), filter, combined);
              deliveryReads.getStore()!.paths.add(authorized);
            },
            assertCurrent: async () => {
              const callSignal = options?.signal;
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              await assertContractInputReadAccess(authority, filter, combined);
            },
          },
          async () => {
            try {
              // Model arguments and callers remain mutable outside this invocation.
              // Pin an owned deep copy before the first permission/validation await.
              args = freezeInput(structuredClone(args));
              await assertContractInputAuthority(authority, root, signal);
              options?.signal?.throwIfAborted();
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
              } else if (name === 'edit') {
                if (!contractInputAuthorityMutable(authority))
                  throw new UnsupportedCapturedWorkflow('immutable captured planner input cannot be edited');
                if (
                  args.notebook_operations !== undefined ||
                  (Array.isArray(object(args.validate).before) &&
                    (object(args.validate).before as unknown[]).length > 0) ||
                  (Array.isArray(object(args.validate).after) && (object(args.validate).after as unknown[]).length > 0)
                )
                  throw new UnsupportedCapturedWorkflow(
                    'captured notebook edits and validators need an authorized backend',
                  );
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
                if (
                  object(args.transaction).mode === 'atomic' ||
                  (Array.isArray(object(args.validate).after) &&
                    (object(args.validate).after as unknown[]).length > 0) ||
                  (Array.isArray(args.files) && args.files.some((file) => object(file).mode === 'backup'))
                )
                  throw new UnsupportedCapturedWorkflow(
                    'captured write validators, backup and rollback need an authorized backend',
                  );
              } else {
                throw new UnsupportedCapturedWorkflow(
                  `captured ${name} requires an original-owner-authorized backend; this workflow is not yet available`,
                );
              }
              const publicationSignal = signal && options?.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options?.signal;
              const result = name === 'write' || name === 'edit' || (name === 'inspect' && args.mode === 'scaffold' && args.dryRun === false)
                ? await withCapturedPublication(authority, () => tool.execute(args, options), publicationSignal)
                : name === 'analyze'
                  ? await withCapturedAnalyzeInput(authority, root, publicationSignal, () => tool.execute(args, options))
                  : await tool.execute(args, options);
              await assertContractInputAuthority(authority, root, signal);
              options?.signal?.throwIfAborted();
              // No content, cached output, diagnostics or errors leave after revocation.
              const callSignal = options?.signal;
              const combined = signal && callSignal ? AbortSignal.any([signal, callSignal]) : (signal ?? callSignal);
              for (const path of deliveryReads.getStore()!.paths)
                await authorizeContractInputPath(authority, path, filter, combined);
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
