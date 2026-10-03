import { AsyncLocalStorage } from 'node:async_hooks';
/** Defense-in-depth around the actual captured-view tool implementations. */
import { resolve, extname } from 'node:path';
import { isImageFile, isArchiveFile } from '../read/media.js';
import type { Tool } from '../../types/tools.js';
import type { ReadAccessFilter } from './read-access.js';
import {
  assertContractInputAuthority,
  authorizeContractInputPath,
  contractInputAuthorityMutable,
  type ContractInputAuthority,
} from '../../contract/input-authority.js';

const deliveryReads = new AsyncLocalStorage<{
  readonly paths: Set<string>;
  readonly signal?: AbortSignal | undefined;
}>();

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
  return {
    definition: tool.definition,
    async execute(args, options) {
      return deliveryReads.run({ paths: new Set<string>(), signal: options?.signal }, async () => {
        try {
          // Model arguments and callers remain mutable outside this invocation.
          // Pin an owned deep copy before the first permission/validation await.
          args = freezeInput(structuredClone(args));
          await assertContractInputAuthority(authority, root, signal);
          options?.signal?.throwIfAborted();
          if (!filter) throw new Error('captured input requires original-owner read authorization');
          const name = tool.definition.name;
          if (name === 'read') {
            const files = Array.isArray(args.files) ? args.files : [];
            for (const raw of files) {
              const file = object(raw);
              const extract = file.extract ?? args.extract ?? 'content';
              if (extract !== 'content' && extract !== 'lines')
                throw new UnsupportedCapturedWorkflow('captured read extraction needs an authorized analysis backend');
              const extension = extname(String(file.path ?? '')).toLowerCase();
              if (
                isImageFile(extension) ||
                isArchiveFile(extension) ||
                extension === '.pdf' ||
                extension === '.ipynb' ||
                file.image_mode !== undefined ||
                file.pages !== undefined
              )
                throw new UnsupportedCapturedWorkflow('captured media reads need an authorized media backend');
            }
          } else if (name === 'find') {
            const queries = Array.isArray(args.queries) ? args.queries : [];
            if (queries.some((query) => object(query).mode !== 'files' || object(query).follow_symlinks === true))
              throw new UnsupportedCapturedWorkflow(
                'captured find supports guarded file listings/previews; this query needs an authorized search backend',
              );
          } else if (name === 'write') {
            if (!contractInputAuthorityMutable(authority))
              throw new UnsupportedCapturedWorkflow('immutable captured planner input cannot be written');
            if (
              object(args.transaction).mode === 'atomic' ||
              (Array.isArray(object(args.validate).after) && (object(args.validate).after as unknown[]).length > 0) ||
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
          const result = await tool.execute(args, options);
          await assertContractInputAuthority(authority, root, signal);
          options?.signal?.throwIfAborted();
          // No content, cached output, diagnostics or errors leave after revocation.
          for (const path of deliveryReads.getStore()!.paths)
            await authorizeContractInputPath(authority, path, filter, signal);
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
      });
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
