/** Trusted registration-only input projection. Nothing in this module grants tool admission. */
import { types as nodeTypes } from 'node:util';
import type { ToolExecuteOptions } from '../types/tools.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';

export type ToolInputProjectionProblem = 'held' | 'capacity' | 'unconfigured' | 'invalid' | 'unavailable' | 'stale' | 'cancelled' | 'released' | 'binding-changed';

/** Value-free refusal: projector failures must never echo the original input. */
export class ToolInputProjectionError extends Error {
  constructor(readonly problem: ToolInputProjectionProblem) {
    super(`Tool input projection ${problem}.`);
    this.name = 'ToolInputProjectionError';
  }
}

export interface ToolInputProjectionRequest {
  readonly callId: string;
  readonly name: string;
  /** Complete descriptor-safe frozen input, before any semantic repair. */
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal | undefined;
  /** Check the captured registration and authority at each asynchronous retry boundary. */
  readonly assertCurrent: () => void;
}

export type ToolInputProjectionResult = {
  readonly status: 'held';
  readonly release?: (() => Promise<void>) | undefined;
} | {
  readonly status: 'projected';
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly release?: (() => Promise<void>) | undefined;
  /** An empty, frozen identity token. Its creating owner keeps all bindings privately. */
  readonly executionContext?: object | undefined;
  /** Optional validation of repaired bindings; omission refuses any changed projected input. */
  readonly assertRepairedArgs?: ((args: Record<string, unknown>) => void) | undefined;
};

export interface ToolInputProjector {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Must cooperate with request.signal and own pending work until its returned result can be released.
   * The registry awaits completion and cleanup; it never abandons a late result on cancellation.
   * A rejected project must clean up its own resources, since it supplies no release capability.
   */
  project(request: ToolInputProjectionRequest): Promise<ToolInputProjectionResult>;
}

export interface ToolRegistrationOptions {
  /** Omitted property: ordinary tool. A supplied null/undefined value requires protection and holds. */
  readonly inputProjection?: ToolInputProjector | null | undefined;
}

export interface ToolInputProjectionOptions extends ToolExecuteOptions {
  /** Trusted per-call authority guard, captured out of band and checked before retries. */
  readonly assertCurrent?: (() => void) | undefined;
}

export interface ProjectedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly schemaRevision: string;
  /** Registry-local registration incarnation; never derived from original input. */
  readonly projectionRevision: string;
}

/** Read trusted metadata without invoking accessors or proxy traps. */
export function projectionProperty(value: object, key: string): unknown {
  let owner: object | null = value;
  while (owner) {
    if (nodeTypes.isProxy(owner)) throw new ToolInputProjectionError('invalid');
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) {
      if (!('value' in descriptor)) throw new ToolInputProjectionError('invalid');
      return descriptor.value;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}

/** snapshotJudgmentInput handles JSON structure and the privacy floor after this proxy preflight. */
export function captureProjectionArgs(value: unknown, name: string): Record<string, unknown> {
  const seen = new Set<object>();
  let nodes = 0;
  function inspect(entry: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) throw new ToolInputProjectionError('invalid');
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return;
    if (nodeTypes.isProxy(entry)) throw new ToolInputProjectionError('invalid');
    seen.add(entry);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entry))) {
      if (!('value' in descriptor)) throw new ToolInputProjectionError('invalid');
      inspect(descriptor.value, depth + 1);
    }
  }
  inspect(value, 0);
  const captured = snapshotJudgmentInput(value, name);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) throw new ToolInputProjectionError('invalid');
  return captured as Record<string, unknown>;
}

export function projectionFunction<T extends (...args: never[]) => unknown>(value: unknown): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function' || nodeTypes.isProxy(value)) throw new ToolInputProjectionError('invalid');
  return value as T;
}

const applyIntrinsic = Reflect.apply;
const abortedIntrinsic = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const anyIntrinsic = AbortSignal.any;

export function projectionSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new ToolInputProjectionError('invalid');
  try { applyIntrinsic(abortedIntrinsic, value, []); }
  catch { throw new ToolInputProjectionError('invalid'); }
  return value as AbortSignal;
}

export function assertProjectionSignal(signal: AbortSignal | undefined): void {
  if (signal && applyIntrinsic(abortedIntrinsic, signal, [])) throw new ToolInputProjectionError('cancelled');
}

export function combineProjectionSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : applyIntrinsic(anyIntrinsic, AbortSignal, [present]) as AbortSignal;
}

export function projectionContext(value: unknown): object | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new ToolInputProjectionError('invalid');
  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== 0 || !Object.isFrozen(value)) {
    throw new ToolInputProjectionError('invalid');
  }
  return value;
}

// A projector token is not, by itself, proof that a body is currently running.
// Each exact final argument object gets its own execution lease so a shared
// empty token cannot overwrite or retire another call's lifetime.
const executionLeases = new WeakMap<object, WeakMap<object, { readonly signal: AbortSignal | undefined }>>();

/** Internal registry operation: fixed data writes only, never a host callback. */
export function activateProjectionExecution(context: object | undefined, args: Record<string, unknown>, signal: AbortSignal | undefined): () => void {
  if (!context) return () => {};
  let leases = executionLeases.get(context);
  if (!leases) { leases = new WeakMap(); executionLeases.set(context, leases); }
  if (leases.has(args)) throw new ToolInputProjectionError('binding-changed');
  assertProjectionSignal(signal);
  const lease = Object.freeze({ signal });
  leases.set(args, lease);
  const owned = leases;
  return () => { if (owned.get(args) === lease) owned.delete(args); };
}

/** Internal resource-owner check; a copied token/argument pair cannot mint a lease. */
export function assertProjectionExecution(context: object, args: Record<string, unknown>): void {
  const lease = executionLeases.get(context)?.get(args);
  if (!lease) throw new ToolInputProjectionError('stale');
  assertProjectionSignal(lease.signal);
}
