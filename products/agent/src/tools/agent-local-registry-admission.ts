import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import type { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemorySpineClient, type MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { assertCurrentToolEffect, assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import { noteStorePath } from '../agent/note-registry.ts';
import { personaStorePath } from '../agent/persona-registry.ts';
import { routineStorePath } from '../agent/routine-registry.ts';
import { skillStorePath } from '../agent/skill-registry.ts';
import { assertAgentMemoryInput } from './agent-memory-input-guard.ts';
import { captureAgentExportPath } from './agent-artifact-effect.ts';

const contexts = new WeakMap<object, { readonly assertBeforeWrite: () => void; readonly assertLocation: () => void; readonly acceptOwnEffect: () => void }>();
const readActions = new Set(['list', 'search', 'get']);

function fileRevision(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new ToolInputProjectionError('held');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/** Full local record input and physical source are captured before repair or admission. */
export function createAgentLocalRegistryInputProjector(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    assertAgentMemoryInput(request.args);
    const domain = request.args.domain, action = request.args.action;
    const home = shellPaths.homeDirectory, resolveUserPath = shellPaths.resolveUserPath;
    const memoryStore = memoryRegistry.getStore();
    const memoryScope = memorySpine instanceof MemorySpineClient ? memorySpine.captureOperationScope() : undefined;
    const path = domain === 'note' ? noteStorePath(shellPaths) : domain === 'persona' ? personaStorePath(shellPaths)
      : domain === 'routine' ? routineStorePath(shellPaths) : domain === 'skill' || domain === 'skill_bundle' ? skillStorePath(shellPaths)
      : domain === 'memory' ? memoryStore.dbPath : undefined;
    if (path === undefined) throw new ToolInputProjectionError('held');
    const physicalRoot = captureAgentExportPath(home, home);
    let physical = path === null ? undefined : captureAgentExportPath(home, path);
    let before = path === null ? null : fileRevision(path);
    const assertOwner = () => {
      if (shellPaths.homeDirectory !== home || shellPaths.resolveUserPath !== resolveUserPath
        || memoryRegistry.getStore() !== memoryStore) throw new ToolInputProjectionError('stale');
      memoryScope?.();
      physicalRoot.assertCurrent();
    };
    const assertLocation = () => {
      assertOwner();
      physical?.assertCurrent();
    };
    const assertTarget = () => {
      assertLocation();
      if (path !== null && fileRevision(path) !== before) throw new ToolInputProjectionError('stale');
    };
    assertTarget();
    const context = Object.freeze({}); let released = false;
    const assertCurrent = () => { if (released) throw new ToolInputProjectionError('stale'); request.assertCurrent(); assertTarget(); };
    contexts.set(context, { assertBeforeWrite: assertTarget, assertLocation, acceptOwnEffect() {
      assertOwner();
      if (path !== null) { physical = captureAgentExportPath(home, path); before = fileRevision(path); }
    } });
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      ...(typeof action === 'string' && readActions.has(action) ? { resultPublication: 'read-only' } : {}),
      assertRepairedArgs(args) {
        assertAgentMemoryInput(args);
        if (args.domain !== domain || args.action !== action) throw new ToolInputProjectionError('binding-changed');
        assertCurrent();
      },
      async release() { released = true; contexts.delete(context); },
    };
  } };
}

/** Native atomic writer callbacks recognize only this invocation's own completed effect. */
export function createAgentLocalRegistryWriteLifecycle(args: Record<string, unknown>, options?: ToolExecuteOptions): {
  readonly assertCurrent: () => void; readonly onEffect: () => void;
} {
  return {
    assertCurrent() { assertAgentLocalRegistryWrite(args, options); },
    onEffect() {
      options?.signal?.throwIfAborted();
      if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
      const context = options?.inputProjectionContext, binding = context && contexts.get(context);
      if (!context || !binding) throw new ToolInputProjectionError('held');
      assertProjectionExecution(context, args); binding.acceptOwnEffect();
    },
  };
}

/** The actual registry-issued context is required at each local durable boundary. */
export function assertAgentLocalRegistryWrite(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  options?.signal?.throwIfAborted();
  if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
  const context = options?.inputProjectionContext;
  const binding = context && contexts.get(context);
  if (!context || !binding) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertBeforeWrite();
}

/** After this operation's own commit, location and authority remain live without undoing it. */
export function assertAgentLocalRegistryEffectCurrent(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  options?.signal?.throwIfAborted();
  if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
  const context = options?.inputProjectionContext, binding = context && contexts.get(context);
  if (!context || !binding) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertLocation();
}
