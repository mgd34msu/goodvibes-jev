import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertCurrentToolEffect, assertCurrentToolExecution, assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/types';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import { containsSecretLikeText } from '../agent/memory-safety.ts';

export interface AgentLocalStateTarget {
  readonly root: string;
  readonly path: string;
  readonly access: 'read' | 'write';
}
export interface AgentLocalStateCapture {
  readonly targets: readonly AgentLocalStateTarget[];
  readonly assertDescriptors: () => void;
  readonly onWriteIntent?: ((stage: 'profile' | 'state') => void) | undefined;
  readonly mutationPath?: ((stage: 'profile' | 'state') => string | undefined) | undefined;
}
export interface AgentLocalStateWrite {
  readonly assertCurrent: () => void;
  readonly onWriteIntent?: ((stage: 'profile' | 'state') => void) | undefined;
  readonly onEffect: (published?: boolean, stage?: 'profile' | 'state') => void;
}
const bindings = new WeakMap<object, AgentLocalStateWrite>();

function protectedText(value: unknown): boolean {
  if (typeof value === 'string') return containsSecretLikeText(value);
  return value !== null && typeof value === 'object'
    && Object.entries(value).some(([key, entry]) => containsSecretLikeText(key) || protectedText(entry));
}
function revision(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new ToolInputProjectionError('held');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}
function directories(target: AgentLocalStateTarget): readonly (readonly [string, string | null])[] {
  const root = resolve(target.root), path = resolve(target.path);
  resolveAndValidatePath(path, root);
  const result: Array<readonly [string, string | null]> = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    const stat = lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new ToolInputProjectionError('held');
    result.push([current, stat ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : null]);
    if (current === root) break;
    if (current === dirname(current)) throw new ToolInputProjectionError('held');
  }
  return result;
}

/** Retain physical files and source bytes before semantic admission. No capability comes from arguments. */
export function createAgentLocalStateInputProjector(capture: (args: Record<string, unknown>) => AgentLocalStateCapture,
  isRead: (args: Record<string, unknown>) => boolean): ToolInputProjector {
  return { async project(request) {
    request.assertCurrent(); request.signal?.throwIfAborted();
    if (protectedText(request.args)) throw new ToolInputProjectionError('held');
    const captured = capture(request.args);
    const targets = captured.targets.map(target => ({ ...target, root: resolve(target.root), path: resolve(target.path) }));
    const roots = targets.map(target => realpathSync(target.root));
    let files = targets.map(target => revision(target.path));
    let parents = targets.map(target => directories(target));
    let released = false;
    const assertSources = () => {
      if (released) throw new ToolInputProjectionError('released');
      captured.assertDescriptors();
      targets.forEach((target, index) => {
        if (realpathSync(target.root) !== roots[index]) throw new ToolInputProjectionError('stale');
        resolveAndValidatePath(target.path, target.root);
        if (target.access === 'read' && revision(target.path) !== files[index]) throw new ToolInputProjectionError('stale');
      });
    };
    const assertCurrent = () => {
      request.assertCurrent(); request.signal?.throwIfAborted(); assertSources();
      targets.forEach((target, index) => {
        if (revision(target.path) !== files[index] || JSON.stringify(directories(target)) !== JSON.stringify(parents[index])) {
          throw new ToolInputProjectionError('stale');
        }
      });
    };
    const onEffect = (published = false, stage?: 'profile' | 'state') => {
      // Only the backing writer calls this after its own synchronous mkdir/write/rename.
      request.signal?.throwIfAborted(); assertSources();
      const selected = stage && captured.mutationPath?.(stage);
      if (stage && captured.mutationPath && !selected) throw new ToolInputProjectionError('stale');
      if (targets.some((target, index) => (!published || target.access !== 'write' || (selected && target.path !== selected))
        && revision(target.path) !== files[index])) throw new ToolInputProjectionError('stale');
      const nextParents = targets.map(target => directories(target));
      if (parents.some((chain, index) => chain.some(([path, identity], depth) => {
        const next = nextParents[index]?.[depth];
        return !next || next[0] !== path || (identity !== null && identity.split(':').slice(0, 2).join(':') !== next[1]?.split(':').slice(0, 2).join(':'));
      }))) throw new ToolInputProjectionError('stale');
      files = targets.map((target, index) => target.access === 'write' && (!selected || target.path === selected) ? revision(target.path) : files[index] ?? null);
      parents = nextParents;
    };
    assertCurrent();
    const context = Object.freeze({}); bindings.set(context, { assertCurrent, onEffect,
      onWriteIntent(stage) { assertCurrent(); captured.onWriteIntent?.(stage); assertCurrent(); } });
    const original = JSON.stringify(request.args);
    return { status: 'projected', args: request.args, executionContext: context, assertCurrent,
      ...(isRead(request.args) ? { resultPublication: 'read-only' } : {}),
      assertRepairedArgs(args) { if (JSON.stringify(args) !== original) throw new ToolInputProjectionError('binding-changed'); assertCurrent(); },
      async release() { released = true; bindings.delete(context); },
    };
  } };
}

/** Exact registry-issued invocation and projection identity restrict every backing write. */
export function agentLocalStateWrite(args: Record<string, unknown>, options?: ToolExecuteOptions): AgentLocalStateWrite {
  const context = options?.inputProjectionContext, binding = context && bindings.get(context);
  const authority = () => {
    options?.signal?.throwIfAborted();
    if (!assertCurrentToolEffect(args, options, 'write') || !context || !binding) throw new ToolInputProjectionError('held');
    assertProjectionExecution(context, args);
  };
  const assertCurrent = () => { authority(); binding?.assertCurrent(); };
  assertCurrent();
  return { assertCurrent, onWriteIntent(stage) { authority(); binding?.onWriteIntent?.(stage); },
    onEffect(published?: boolean, stage?: 'profile' | 'state') { authority(); binding?.onEffect(published, stage); } };
}

/** Native raw reads remain available; registered reads retain the captured source through publication. */
export function assertAgentLocalStateCurrent(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  options?.signal?.throwIfAborted(); assertCurrentToolExecution(args, options);
  const context = options?.inputProjectionContext;
  if (!context) return;
  const binding = bindings.get(context);
  if (!binding) throw new ToolInputProjectionError('held');
  assertProjectionExecution(context, args); binding.assertCurrent();
}
