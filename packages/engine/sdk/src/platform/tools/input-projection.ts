/** Trusted registration-only input projection. Nothing in this module grants tool admission. */
import { types as nodeTypes } from 'node:util';
import type { ToolExecuteOptions } from '../types/tools.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { ConfigManager, PreparedConfigMutation } from '../config/manager.js';
import type { ConfigWriteRoute } from '../config/daemon-config-route.js';
import { assertPreparedConfigWriteRoute } from '../config/settings-precondition-client.js';

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

/** Registration-owned facts for admission, never a grant or caller-supplied option. */
export interface ToolAdmissionEvidence {
  readonly kind: 'agent-read';
  readonly root: string;
  readonly paths: readonly string[];
  /** Owner-resolved requested alias to actual target; both endpoints remain semantic subjects. */
  readonly aliases?: readonly { readonly path: string; readonly target: string }[] | undefined;
  /** Owner-generated SHA-256 identity of the captured resources, never raw action text. */
  readonly revision: string;
}

/** Closed backend facts. The effect was resolved by the registered settings owner. */
export interface AgentSettingsAdmissionEvidence {
  readonly kind: 'agent-settings';
  readonly operation: 'set' | 'reset';
  readonly key: string;
  readonly effect: Readonly<Record<string, unknown>>;
  readonly revision: string;
}
/** Internal descriptive alias; keep the existing public READ declaration explicit. */
export type AgentReadAdmissionEvidence = ToolAdmissionEvidence;
export type ToolOwnedAdmissionEvidence = ToolAdmissionEvidence | AgentSettingsAdmissionEvidence;

/** Opaque local mutation binding; never serialized as judgment evidence. */
export interface ToolPreparedSettingsMutation {
  readonly owner: ConfigManager;
  readonly mutation: PreparedConfigMutation;
  readonly route?: ConfigWriteRoute | undefined;
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
  readonly admissionEvidence?: ToolAdmissionEvidence | undefined;
  readonly settingsAdmissionEvidence?: AgentSettingsAdmissionEvidence | undefined;
  readonly settingsMutation?: ToolPreparedSettingsMutation | undefined;
  /** Trusted projector resolved this invocation as read-only; recheck admission after cleanup before publishing. Never a grant. */
  readonly resultPublication?: 'read-only' | undefined;
  /** Optional validation of repaired bindings; omission refuses any changed projected input. */
  readonly assertRepairedArgs?: ((args: Record<string, unknown>) => void) | undefined;
};

/** Own the closed factual payload before its projector can retain or mutate it. */
function captureOwnedAdmissionEvidence(value: unknown): ToolOwnedAdmissionEvidence | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new ToolInputProjectionError('invalid');
  const prototype: unknown = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors['kind'] && 'value' in descriptors['kind'] && descriptors['kind'].value === 'agent-settings') {
    const keys = ['kind', 'operation', 'key', 'effect', 'revision'];
    if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(descriptors).length !== keys.length
      || !keys.every(key => descriptors[key] && 'value' in descriptors[key]!)) throw new ToolInputProjectionError('invalid');
    const revision: unknown = descriptors['revision']!.value;
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new ToolInputProjectionError('invalid');
    const captured = captureProjectionArgs({ kind: descriptors['kind']!.value, operation: descriptors['operation']!.value,
      key: descriptors['key']!.value, effect: descriptors['effect']!.value }, 'goodvibes_settings');
    if ((captured['operation'] !== 'set' && captured['operation'] !== 'reset') || typeof captured['key'] !== 'string'
      || !captured['key'] || !captured['effect'] || typeof captured['effect'] !== 'object' || Array.isArray(captured['effect'])) {
      throw new ToolInputProjectionError('invalid');
    }
    return Object.freeze({ kind: 'agent-settings', operation: captured['operation'], key: captured['key'],
      effect: captured['effect'] as Readonly<Record<string, unknown>>, revision });
  }
  const suppliedAliases = Object.hasOwn(descriptors, 'aliases');
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(descriptors).length !== (suppliedAliases ? 5 : 4)
    || (suppliedAliases && !('value' in descriptors['aliases']!))
    || !['kind', 'root', 'paths', 'revision'].every(key => descriptors[key] && 'value' in descriptors[key]!)) {
    throw new ToolInputProjectionError('invalid');
  }
  const hasAliases = suppliedAliases && descriptors['aliases']!.value !== undefined;
  const revision: unknown = descriptors['revision']!.value;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new ToolInputProjectionError('invalid');
  // The revision is typed protocol identity. Scanning its incidental digit runs
  // as action text would mistake a valid digest for credential/card material.
  const captured = captureProjectionArgs({ kind: descriptors['kind']!.value,
    root: descriptors['root']!.value, paths: descriptors['paths']!.value,
    ...(hasAliases ? { aliases: descriptors['aliases']!.value } : {}) }, 'admission-evidence');
  const paths = captured['paths'];
  if (Object.keys(captured).length !== (hasAliases ? 4 : 3) || captured['kind'] !== 'agent-read'
    || typeof captured['root'] !== 'string' || !Array.isArray(paths)
    || Object.keys(paths).length !== paths.length
    || !paths.every(path => typeof path === 'string')) throw new ToolInputProjectionError('invalid');
  const aliasInput = captured['aliases'];
  if (hasAliases && (!Array.isArray(aliasInput) || !aliasInput.every(alias => alias && typeof alias === 'object'
    && Object.keys(alias).length === 2 && typeof alias.path === 'string' && typeof alias.target === 'string'
    && paths.includes(alias.path) && paths.includes(alias.target)))) throw new ToolInputProjectionError('invalid');
  const aliases = hasAliases ? Object.freeze((aliasInput as { path: string; target: string }[])
    .map(alias => Object.freeze({ path: alias.path, target: alias.target }))) : undefined;
  return Object.freeze({ kind: 'agent-read', root: captured['root'], paths: Object.freeze([...paths]), revision,
    ...(aliases ? { aliases } : {}) });
}

/** Retain the original READ-only projection/accessor contract for SDK embedders. */
export function captureAdmissionEvidence(value: unknown): ToolAdmissionEvidence | undefined {
  const evidence = captureOwnedAdmissionEvidence(value);
  if (evidence && evidence.kind !== 'agent-read') throw new ToolInputProjectionError('invalid');
  return evidence;
}

export function captureSettingsAdmissionEvidence(value: unknown): AgentSettingsAdmissionEvidence | undefined {
  const evidence = captureOwnedAdmissionEvidence(value);
  if (evidence && evidence.kind !== 'agent-settings') throw new ToolInputProjectionError('invalid');
  return evidence;
}

/** Authenticate the handle with its existing owner before retaining it privately. */
export function captureSettingsMutation(value: unknown): ToolPreparedSettingsMutation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new ToolInputProjectionError('invalid');
  const owner = projectionProperty(value, 'owner') as ConfigManager | undefined;
  const mutation = projectionProperty(value, 'mutation') as PreparedConfigMutation | undefined;
  const route = projectionProperty(value, 'route') as ConfigWriteRoute | undefined;
  if (!owner || !mutation) throw new ToolInputProjectionError('invalid');
  owner.assertPreparedMutation(mutation);
  if (route) assertPreparedConfigWriteRoute(route);
  return Object.freeze({ owner, mutation, ...(route ? { route } : {}) });
}

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
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const array = Array.isArray(entry);
    if (array && (Object.keys(descriptors).length !== entry.length + 1 || entry.length > 20_000)) throw new ToolInputProjectionError('invalid');
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new ToolInputProjectionError('invalid');
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor)) throw new ToolInputProjectionError('invalid');
      if (array && key === 'length') continue;
      // JSON cannot carry hidden object fields or custom array properties. Do
      // not silently omit an unscreened part of the complete original input.
      if (!descriptor.enumerable || (array && (!Number.isSafeInteger(Number(key))
        || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= entry.length))) throw new ToolInputProjectionError('invalid');
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
// Browser-test realms can install a non-native AbortSignal. Importing the
// registry must remain harmless there; native signal use still fails closed.
const signalConstructor = typeof AbortSignal === 'function' ? AbortSignal : undefined;
const abortedIntrinsic = signalConstructor && Object.getOwnPropertyDescriptor(signalConstructor.prototype, 'aborted')?.get;
const anyIntrinsic = signalConstructor?.any;

export function projectionSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || !abortedIntrinsic) throw new ToolInputProjectionError('invalid');
  try { applyIntrinsic(abortedIntrinsic, value, []); }
  catch { throw new ToolInputProjectionError('invalid'); }
  return value as AbortSignal;
}

export function assertProjectionSignal(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (!abortedIntrinsic) throw new ToolInputProjectionError('invalid');
  if (applyIntrinsic(abortedIntrinsic, signal, [])) throw new ToolInputProjectionError('cancelled');
}

export function combineProjectionSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (present.length < 2) return present[0];
  if (!anyIntrinsic || !signalConstructor) throw new ToolInputProjectionError('invalid');
  return applyIntrinsic(anyIntrinsic, signalConstructor, [present]) as AbortSignal;
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
