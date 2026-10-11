import { AsyncLocalStorage } from 'node:async_hooks';
import { types as nodeTypes } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import {
  ToolInputProjectionError, assertProjectionCurrent, assertProjectionSignal, captureProjectionArgs, captureProjectionStructure,
  combineProjectionSignals, projectionContext, projectionFunction, projectionProperty, projectionSignal,
  activateProjectionExecution,
  captureAdmissionEvidence,
  captureSettingsAdmissionEvidence,
  captureSettingsMutation,
  type ProjectedToolCall, type ToolInputProjector, type ToolRegistrationOptions,
  type ToolAdmissionEvidence, type ToolOwnedAdmissionEvidence, type ToolInputProjectionResult, type ToolInputProjectionOptions,
  type ToolPreparedSettingsMutation,
} from './input-projection.js';
import { captureNativeReferenceProjection } from './native-reference-projection.js';
import { canonicalJson, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureOwnedJson, retainOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { autonomousRevision } from '../permissions/autonomous.js';
import { assertAutonomousConfigTransition, completeAutonomousConfigTransition, bindAutonomousNestedAdmission, readAutonomousSettingsPresentation, readAutonomousWorkspaceConstraint, readAutonomousEffectConstraint, readAutonomousNestedOwner, consumeAutonomousAdmission, type AutonomousNestedOwner, type AutonomousPermissionAdmission, type PermissionManager } from '../permissions/manager.js';
import type { AutonomousChoiceProjection } from '../permissions/autonomous-input-projection.js';
import type { PreparedConfigMutationReceipt } from '../config/manager.js';
import type { PreparedSecretImportTransition } from '../config/secrets.js';
import type { PreparedSubscriptionImportTransition } from '../config/subscriptions.js';
import { assertPreparedConfigWriteRoute } from '../config/settings-precondition-client.js';
import { assertRemoteSettingsImportPrecondition, applyRemoteSettingsImportPrecondition,
  assertCompletedRemoteSettingsImportPrecondition } from '../config/settings-import-precondition-client.js';
import { firstJsonSchemaFailureAsync } from '@goodvibes-jev/engine/transport-http';
import type { Tool, ToolDefinition, ToolExecuteOptions, ToolResult } from '../types/tools.js';
import { UnknownPreparedToolError } from './preparation-error.js';
import { ToolError } from '../types/errors.js';
import { repairToolCall } from './auto-repair.js';
import { ToolContractVerifier } from '../runtime/tools/contract-verifier.js';
import type { ContractVerificationResult, ContractVerifierOptions } from '../runtime/tools/contract-verifier.js';
import { summarizeError } from '../utils/error-display.js';
import { JudgmentError } from '@goodvibes-jev/judgment';

/**
 * ToolRegistry - Central registry for all tools available to the LLM.
 * Manages registration, discovery, and execution of tools.
 */
export interface PreparedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly schemaRevision: string;
  readonly judgmentDecisionIds: readonly string[];
}

interface PreparedExecution {
  readonly tool: Tool;
  readonly executor: Tool['execute'];
  readonly definitionRevision: string;
  readonly warnings: readonly string[];
  readonly projection: CapturedProjection;
  claimed: boolean;
}

interface ProjectionRegistration {
  readonly tool: Tool;
  readonly revision: string;
  readonly projector: ToolInputProjector | null | undefined;
  readonly project: ToolInputProjector['project'] | undefined;
  readonly captureNativeReferences: ToolInputProjector['captureNativeReferences'] | undefined;
  readonly assertCurrent: (() => void) | undefined;
  readonly signal: AbortSignal | undefined;
}

interface CapturedProjection {
  readonly call: ProjectedToolCall;
  readonly registration: ProjectionRegistration;
  readonly tool: Tool;
  readonly executor: Tool['execute'];
  readonly definition: ToolDefinition;
  readonly rawDefinition: unknown;
  readonly assertDefinitionCurrent: () => void;
  readonly definitionRevision: string;
  readonly captureCurrent: (() => void) | undefined;
  readonly preparationGuards: { readonly callbacks: Set<() => void>; revision: number };
  readonly ownsProjectionSlot: boolean;
  executionStarted: boolean;
  executionCurrent?: (() => void) | undefined;
  preparationSignal?: AbortSignal | undefined;
  readonly signal: AbortSignal | undefined;
  readonly assertCurrent: (() => void) | undefined;
  readonly nativeCurrent?: (() => void) | undefined;
  readonly nativeSchemaArgs?: ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;
  readonly assertRepairedArgs: ((args: Record<string, unknown>) => void) | undefined;
  readonly release: (() => Promise<void>) | undefined;
  readonly executionContext: object | undefined;
  readonly admissionEvidence: ToolOwnedAdmissionEvidence | undefined;
  readonly settingsMutation: ToolPreparedSettingsMutation | undefined;
  readonly resultPublication: 'read-only' | undefined;
  released: boolean;
  claimed: boolean;
  releasePromise?: Promise<void>;
  preparation?: Promise<PreparedToolCall>;
}

const MAX_LIVE_INPUT_PROJECTIONS = 128;
const applyIntrinsic = Reflect.apply;

export type ToolExecutionEffect = 'write' | 'send';

/** Original autonomous provenance. This restriction grants no separate effect authority. */
export interface CurrentToolAutonomySource {
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly assertCurrent: () => void;
}

interface CurrentToolExecution {
  readonly registry: ToolRegistry;
  readonly nestedOwner: AutonomousNestedOwner;
  readonly admissionGuard: () => void;
  readonly assertWorkspace?: (() => void) | undefined;
  readonly args: Record<string, unknown>;
  readonly assertCurrent: () => void;
  readonly assertEffect: (effect: ToolExecutionEffect) => void;
  readonly commitSettings?: (() => PreparedConfigMutationReceipt) | undefined;
  readonly commitSettingsPlan?: (() => Promise<PreparedConfigMutationReceipt>) | undefined;
  readonly settingsPresentation?: Readonly<{ previous: unknown; current: unknown }> | undefined;
  settingsReceipt?: PreparedConfigMutationReceipt | undefined;
  settingsRetired?: boolean | undefined;
  active: boolean;
  checking: boolean;
}

// Exact options identity is the invocation capability. No caller-visible field
// and no exported minting operation can construct an authentic body proof.
const currentToolExecutions = new WeakMap<ToolExecuteOptions, CurrentToolExecution>();
const settingsResultReceipts = new WeakMap<ToolResult, PreparedConfigMutationReceipt>();

function retainSettingsReceipt(proof: CurrentToolExecution, receipt: PreparedConfigMutationReceipt): void {
  const previous = proof.settingsReceipt;
  proof.settingsReceipt = previous ? Object.freeze({ ...receipt,
    status: previous.status === 'committed' && receipt.status === 'committed' ? 'committed' : 'partial',
    completedPaths: Object.freeze([...previous.completedPaths, ...receipt.completedPaths]) }) : receipt;
}

function retiredSettingsResult(callId: string, receipt: PreparedConfigMutationReceipt, signal?: AbortSignal): ToolResult {
  const result: ToolResult = { callId, success: false, ...(signal?.aborted ? { cancelled: true } : {}),
    error: 'Settings invocation retired after its recorded effects; no remaining work was dispatched.',
    output: JSON.stringify(receipt) };
  settingsResultReceipts.set(result, receipt);
  return result;
}
// Carries the same authentic body proof across trusted wrappers. It never
// creates authority, and cannot be cleared or replaced by a tool argument.
const executingContext = new AsyncLocalStorage<{ readonly proof: CurrentToolExecution; readonly options: ToolExecuteOptions }>();

/** Effectful tools must not downgrade wrapped/copied options to legacy authority. */
export function assertCurrentToolInvocation(args: Record<string, unknown>, options?: ToolExecuteOptions): boolean {
  const current = executingContext.getStore();
  if (current && (current.options !== options || currentToolExecutions.get(current.options) !== current.proof
    || current.proof.args !== args || !current.proof.active)) throw new ToolInputProjectionError('stale');
  return assertCurrentToolExecution(args, options);
}

/** A code-owned effect cannot relax the captured owner's deterministic restrictions. */
export function assertCurrentToolEffect(args: Record<string, unknown>, options?: ToolExecuteOptions,
  effect: ToolExecutionEffect = 'write'): boolean {
  if (!assertCurrentToolInvocation(args, options)) return false;
  const proof = options && currentToolExecutions.get(options);
  if (!proof) return false;
  try {
    proof.assertEffect(effect);
    return true;
  } catch (error) {
    proof.active = false;
    throw error;
  }
}

/** Read only the original admitted source, while its exact write invocation remains live. */
export function currentToolAutonomySource(args: Record<string, unknown>, options?: ToolExecuteOptions): CurrentToolAutonomySource | undefined {
  if (!assertCurrentToolEffect(args, options, 'write') || !options) return undefined;
  const proof = currentToolExecutions.get(options)!;
  const source = proof.nestedOwner.source;
  const assertCurrent = () => {
    if (currentToolExecutions.get(options) !== proof || !assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('stale');
  };
  const result = Object.freeze({ goal: source.goal, criteria: Object.freeze([...source.criteria]), assertCurrent });
  assertCurrent();
  return result;
}
/** Compatibility name for the existing Exec consumer. */
export const assertCurrentExecInvocation = assertCurrentToolInvocation;
/** Additional restriction only; captured jobs still require their own authority and lease. */
export function captureCurrentExecWorkspaceConstraint(args: Record<string, unknown>, options?: ToolExecuteOptions): (() => void) | undefined {
  if (!assertCurrentExecInvocation(args, options)) return undefined;
  return currentToolExecutions.get(options!)!.assertWorkspace;
}
// Constructor-only owner identity, without a caller-writable registry property.
const registryPermissionOwners = new WeakMap<ToolRegistry, PermissionManager>();

/** False for legacy/unadmitted calls; a known expired or mismatched proof throws. */
export function assertCurrentToolExecution(args: Record<string, unknown>, options?: ToolExecuteOptions): boolean {
  // Restrictions apply even to ordinary/legacy invocations. They never mint an
  // authenticated admission: absent proof still returns false below.
  const proof = options && currentToolExecutions.get(options);
  try { assertProjectionCurrent(options === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(options, 'assertCurrent')), args); }
  catch (error) { if (proof) proof.active = false; throw error; }
  if (!proof) return false;
  if (!proof.active || proof.checking || proof.args !== args) throw new ToolInputProjectionError('stale');
  proof.checking = true;
  try {
    proof.assertCurrent();
    if (!proof.active) throw new ToolInputProjectionError('stale');
    return true;
  } catch (error) {
    proof.active = false;
    throw error;
  } finally { proof.checking = false; }
}

/** Consume the exact registered local effect. Neither options nor callbacks mint a grant. */
export function commitCurrentToolSettings(args: Record<string, unknown>, options?: ToolExecuteOptions): PreparedConfigMutationReceipt {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.commitSettings || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  // Retire before begin: a callback can never reenter this invocation to write.
  proof.active = false;
  const receipt = proof.commitSettings(); proof.settingsReceipt = receipt; return receipt;
}

/** Consume a complete config/credential plan once. Async acquisition stays under its original proof. */
export async function commitCurrentToolSettingsPlan(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<PreparedConfigMutationReceipt> {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.commitSettingsPlan || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  proof.active = false;
  const receipt = await proof.commitSettingsPlan(); proof.settingsReceipt = receipt; return receipt;
}

/** Captured display data is not execution authority and can accompany the committed receipt. */
export function currentToolSettingsPresentation(args: Record<string, unknown>, options?: ToolExecuteOptions): Readonly<{ previous: unknown; current: unknown }> {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.settingsPresentation || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  return proof.settingsPresentation;
}

/** The remote dispatch owns the effect after this synchronous one-shot boundary. */
export function claimCurrentToolSettingsDispatch(args: Record<string, unknown>, options?: ToolExecuteOptions): void {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.settingsPresentation || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  proof.active = false;
}

/** Metadata is inspected without invoking user-defined getters or proxy traps. */
function dataProperty(value: object, key: string, name: string): unknown {
  let owner: object | null = value;
  while (owner) {
    if (nodeTypes.isProxy(owner)) throw new ToolError('Proxy-backed autonomous metadata is unsupported', name);
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) {
      if (!('value' in descriptor)) throw new ToolError('Accessor-backed autonomous metadata is unsupported', name);
      return descriptor.value;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}

function plainMetadata(value: unknown, name: string, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (nodeTypes.isProxy(value)) throw new ToolError('Proxy-backed autonomous metadata is unsupported', name);
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new ToolError('Accessor-backed autonomous metadata is unsupported', name);
    plainMetadata(descriptor.value, name, seen);
  }
}

function preparationData(tool: Tool, name: string, freshness = false): { executor: Tool['execute']; definition: ToolDefinition; rawDefinition: unknown } {
  const definition = dataProperty(tool, 'definition', name);
  const execute = dataProperty(tool, 'execute', name);
  if (typeof execute !== 'function' || nodeTypes.isProxy(execute)) throw new ToolError('Autonomous executor must be a data-backed function', name);
  plainMetadata(definition, name);
  // Acquisition screens the definition. Freshness needs a new bounded
  // structural capture of its current canonical data, not another privacy decision on
  // the same bytes. The caller must compare it to that screened revision before
  // use; the complete descriptor walk above still rejects hidden accessors/proxies.
  return { executor: execute as Tool['execute'], rawDefinition: definition, definition: (freshness
    ? captureOwnedJson(definition, nodeTypes.isProxy) : snapshotJudgmentInput(definition)) as unknown as ToolDefinition };
}

export class ToolRegistry {
  private readonly prepared = new WeakMap<PreparedToolCall, PreparedExecution>();
  private tools = new Map<string, Tool>();
  private readonly registrations = new Map<string, ProjectionRegistration>();
  private readonly projections = new WeakMap<ProjectedToolCall, CapturedProjection>();
  private readonly projectedArgs = new WeakMap<object, CapturedProjection>();
  private registrationRevision = 0;
  private liveInputProjections = 0;

  /** Strict compositions bind their exact authority owner once; raw SDK registries remain unbound. */
  constructor(expectedPermissionManager?: PermissionManager) {
    if (expectedPermissionManager !== undefined) registryPermissionOwners.set(this, expectedPermissionManager);
  }

  /** Register a tool. Throws if a tool with the same name is already registered. */
  register(tool: Tool, opts?: ToolRegistrationOptions): void {
    const { definition } = preparationData(tool, 'registration');
    const name = definition.name;
    if (this.tools.has(name)) throw new Error(`Tool '${name}' is already registered`);
    const configured = opts === undefined ? undefined : projectionProperty(opts, 'inputProjection');
    // A supplied but missing projector is a protected registration, never an opt-out.
    const candidate = configured === undefined && opts !== undefined && Reflect.has(opts, 'inputProjection') ? null : configured;
    if (candidate !== undefined && candidate !== null && (typeof candidate !== 'object' || nodeTypes.isProxy(candidate))) {
      throw new ToolInputProjectionError('invalid');
    }
    const projector = candidate as ToolInputProjector | null | undefined;
    const project = projector ? projectionFunction<ToolInputProjector['project']>(projectionProperty(projector, 'project')) : undefined;
    if (projector && !project) throw new ToolInputProjectionError('invalid');
    const assertCurrent = projector ? projectionFunction<() => void>(projectionProperty(projector, 'assertCurrent')) : undefined;
    const captureNativeReferences = projector ? projectionFunction<NonNullable<ToolInputProjector['captureNativeReferences']>>(projectionProperty(projector, 'captureNativeReferences')) : undefined;
    const signal = projector ? projectionSignal(projectionProperty(projector, 'signal')) : undefined;
    this.tools.set(name, tool);
    this.registrations.set(name, Object.freeze({ tool, projector, project, captureNativeReferences, assertCurrent, signal,
      revision: `tool-input-projection:${++this.registrationRevision}` }));
  }

  /**
   * Register a tool after running contract verification.
   *
   * If verification finds error-level violations the tool is NOT registered
   * and an error is thrown listing all violations. This implements "fail closed"
   * semantics: invalid tools cannot enter the registry.
   *
   * Warn-level violations are collected and returned so callers can surface them
   * without blocking registration.
   *
   * Registration runs the code checks only (ToolContractVerifier.verifyStructure).
   * The one check that is read by Jev, whether the description explains the
   * tool, can only add a warning and never changes whether a tool registers,
   * so registration does not wait on it; verifyContract and verifyAllContracts
   * include it.
   *
   * @param tool    - The tool to register.
   * @param opts    - Optional verifier options (strictness overrides).
   * @returns The full ContractVerificationResult so callers can inspect warnings.
   * @throws If the tool has any error-level contract violations.
   */
  registerWithContract(
    tool: Tool,
    opts?: ContractVerifierOptions,
    registration?: ToolRegistrationOptions,
  ): ContractVerificationResult {
    const verifier = new ToolContractVerifier(opts);
    const result = verifier.verifyStructure(tool);

    if (!result.passed) {
      const errors = result.violations
        .filter((v) => v.severity === 'error')
        .map((v) => `  [${v.dimension}] ${v.message}`);
      throw new Error(
        `Tool '${tool.definition.name}' failed contract verification:\n${errors.join('\n')}`,
      );
    }

    this.register(tool, registration);
    return result;
  }

  /**
   * Run contract verification on a single registered tool without re-registering.
   *
   * @param name - The tool name to verify.
   * @param opts - Optional verifier options.
   * @returns The verification result, or undefined if the tool is not registered.
   */
  async verifyContract(
    name: string,
    opts?: ContractVerifierOptions,
  ): Promise<ContractVerificationResult | undefined> {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const verifier = new ToolContractVerifier(opts);
    return verifier.verify(tool);
  }

  /**
   * Run contract verification on all registered tools.
   *
   * @param opts - Optional verifier options.
   * @returns Map of tool name → ContractVerificationResult for every registered tool.
   */
  verifyAllContracts(
    opts?: ContractVerifierOptions,
  ): Promise<Map<string, ContractVerificationResult>> {
    const verifier = new ToolContractVerifier(opts);
    return verifier.verifyAll(this.list());
  }

  /** Returns the ToolDefinition array formatted for LLM function calling. */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Capture/project before conversation storage, repair, or any ordinary judgment. */
  async projectCall(callId: string, name: string, args: Record<string, unknown>, opts?: ToolInputProjectionOptions): Promise<ProjectedToolCall> {
    const signal = opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal'));
    const captureCurrent = opts === undefined ? undefined : projectionFunction<() => void>(projectionProperty(opts, 'assertCurrent'));
    assertProjectionSignal(signal);
    const reused = this.projectedArgs.get(args);
    if (reused) {
      if (reused.call.callId !== callId || reused.call.name !== name) throw new ToolInputProjectionError('binding-changed');
      try { assertProjectionCurrent(captureCurrent); }
      catch (error) { if (reused.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
      this.assertCaptured(reused, true);
      return reused.call;
    }
    const registration = this.registrations.get(name);
    if (!registration) {
      captureProjectionArgs(args, name);
      throw new UnknownPreparedToolError(name);
    }
    if (registration.projector === null) throw new ToolInputProjectionError('unconfigured');
    const captured = registration.captureNativeReferences ? captureProjectionStructure(args) : captureProjectionArgs(args, name);
    const { executor, definition, rawDefinition } = preparationData(registration.tool, name);
    const { assertCurrent: assertDefinitionCurrent } = retainOwnedJson(rawDefinition, nodeTypes.isProxy);
    const definitionRevision = autonomousRevision(definition);
    const combined = combineProjectionSignals(signal, registration.signal);
    const skeleton = { registration, tool: registration.tool, executor, definition, rawDefinition, assertDefinitionCurrent, definitionRevision, captureCurrent, preparationGuards: { callbacks: new Set<() => void>(), revision: 0 }, ownsProjectionSlot: registration.projector !== undefined, executionStarted: false,
      signal: combined, assertCurrent: undefined, assertRepairedArgs: undefined, release: undefined,
      executionContext: undefined, admissionEvidence: undefined, settingsMutation: undefined, resultPublication: undefined, released: false, claimed: false };
    const provisional: CapturedProjection = { ...skeleton, call: Object.freeze({ callId, name, args: Object.freeze({}),
      schemaRevision: definitionRevision, projectionRevision: registration.revision }) };
    let capturedRecord: CapturedProjection | undefined;
    // An owner may retain this restriction through its actual tool body. A
    // preparation guard expires at claim; the exact execution takes its place.
    const assertProjectorCurrent = () => {
      if (capturedRecord?.executionCurrent) return capturedRecord.executionCurrent();
      if (capturedRecord?.claimed || capturedRecord?.released) throw new ToolInputProjectionError('stale');
      this.assertCaptured(provisional, true);
      if (capturedRecord) this.assertCapturedIdentity(capturedRecord);
    };
    this.assertCaptured(provisional, true);
    if (skeleton.ownsProjectionSlot) {
      if (this.liveInputProjections >= MAX_LIVE_INPUT_PROJECTIONS) throw new ToolInputProjectionError('capacity');
      this.liveInputProjections++;
    }
    let release: (() => Promise<void>) | undefined;
    try {
      let projected = captured;
      let nativeCurrent: (() => void) | undefined;
      let nativeAssertArgs: ((args: Record<string, unknown>) => void) | undefined;
      let nativeSchemaArgs: ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;
      let nativeReferenceContext: object | undefined;
      if (registration.captureNativeReferences) {
        const native: unknown = applyIntrinsic(registration.captureNativeReferences, registration.projector, [Object.freeze({
          callId, name, args: captured, signal: combined, assertCurrent: assertProjectorCurrent,
        })]);
        if (native !== undefined) {
          if (!native || typeof native !== 'object' || nodeTypes.isProxy(native)) throw new ToolInputProjectionError('invalid');
          if (nodeTypes.isPromise(native)) { assertProjectionCurrent(() => native); throw new ToolInputProjectionError('invalid'); }
          release = projectionFunction<() => Promise<void>>(projectionProperty(native, 'release'));
          const binding = captureNativeReferenceProjection(native, captured, name);
          projected = binding.args; nativeCurrent = binding.assertCurrent; nativeAssertArgs = binding.assertArgs;
          nativeSchemaArgs = binding.schemaArgs; nativeReferenceContext = binding.executionContext;
        } else projected = captureProjectionArgs(captured, name);
        this.assertCaptured(provisional, true); assertProjectionCurrent(nativeCurrent);
      }
      let resultSignal: AbortSignal | undefined;
      let assertCurrent: (() => void) | undefined;
      let assertRepairedArgs: ((args: Record<string, unknown>) => void) | undefined;
      let executionContext: object | undefined = nativeReferenceContext;
      let admissionEvidence: ToolOwnedAdmissionEvidence | undefined;
      let settingsMutation: ToolPreparedSettingsMutation | undefined;
      let resultPublication: 'read-only' | undefined;
      if (registration.projector && registration.project) {
        const result: ToolInputProjectionResult = await applyIntrinsic(registration.project, registration.projector, [Object.freeze({
          callId, name, args: projected, signal: combined, assertCurrent: assertProjectorCurrent,
          ...(nativeReferenceContext ? { nativeReferenceContext } : {}),
        })]);
        if (!result || typeof result !== 'object' || nodeTypes.isProxy(result)) throw new ToolInputProjectionError('invalid');
        const projectedRelease = projectionFunction<() => Promise<void>>(projectionProperty(result, 'release'));
        const nativeRelease = release;
        release = nativeRelease && projectedRelease ? async () => {
          const results = await Promise.allSettled([Promise.resolve().then(nativeRelease), Promise.resolve().then(projectedRelease)]);
          if (results.some(result => result.status === 'rejected')) throw new ToolInputProjectionError('unavailable');
        } : projectedRelease ?? nativeRelease;
        this.assertCaptured(provisional, true);
        const status = projectionProperty(result, 'status');
        if (status === 'held') throw new ToolInputProjectionError('held');
        if (status !== 'projected') throw new ToolInputProjectionError('invalid');
        projected = captureProjectionArgs(projectionProperty(result, 'args'), name);
        nativeAssertArgs?.(projected);
        resultSignal = projectionSignal(projectionProperty(result, 'signal'));
        const projectedCurrent = projectionFunction<() => void>(projectionProperty(result, 'assertCurrent'));
        assertCurrent = nativeCurrent ? () => { assertProjectionCurrent(nativeCurrent); assertProjectionCurrent(projectedCurrent); assertProjectionCurrent(nativeCurrent); } : projectedCurrent;
        const projectedRepairedArgs = projectionFunction<(args: Record<string, unknown>) => void>(projectionProperty(result, 'assertRepairedArgs'));
        const originalProjected = projected;
        assertRepairedArgs = nativeAssertArgs ? effective => {
          nativeAssertArgs(effective);
          if (projectedRepairedArgs) assertProjectionCurrent(projectedRepairedArgs, effective);
          else if (autonomousRevision(effective) !== autonomousRevision(originalProjected)) throw new ToolInputProjectionError('binding-changed');
          nativeAssertArgs(effective);
        } : projectedRepairedArgs;
        const projectedContext = projectionContext(projectionProperty(result, 'executionContext'));
        if (nativeReferenceContext && projectedContext && nativeReferenceContext !== projectedContext) throw new ToolInputProjectionError('binding-changed');
        executionContext = projectedContext ?? nativeReferenceContext;
        admissionEvidence = captureAdmissionEvidence(projectionProperty(result, 'admissionEvidence'));
        const settingsEvidence = captureSettingsAdmissionEvidence(projectionProperty(result, 'settingsAdmissionEvidence'));
        if (admissionEvidence && settingsEvidence) throw new ToolInputProjectionError('invalid');
        admissionEvidence ??= settingsEvidence;
        settingsMutation = captureSettingsMutation(projectionProperty(result, 'settingsMutation'));
        if (settingsMutation && admissionEvidence?.kind !== 'agent-settings') throw new ToolInputProjectionError('invalid');
        const publication = projectionProperty(result, 'resultPublication');
        if (publication !== undefined && publication !== 'read-only') throw new ToolInputProjectionError('invalid');
        if (publication === 'read-only') {
          // Mixed state tools can resolve an invocation to a read in their
          // trusted projector. Explicit execution/write and owned mutations cannot opt in.
          if (settingsMutation || admissionEvidence?.kind === 'agent-settings'
            || definition.sideEffects?.some(effect => effect !== 'read_fs' && effect !== 'network' && effect !== 'state')) throw new ToolInputProjectionError('invalid');
          resultPublication = publication;
        }
      }
      const call = Object.freeze({ callId, name, args: projected, schemaRevision: definitionRevision,
        projectionRevision: registration.revision });
      const record: CapturedProjection = { ...skeleton, call, signal: combineProjectionSignals(combined, resultSignal),
        assertCurrent, nativeCurrent, nativeSchemaArgs, assertRepairedArgs, release, executionContext, admissionEvidence, settingsMutation, resultPublication };
      capturedRecord = record;
      this.assertCaptured(record, true);
      this.projections.set(call, record);
      this.projectedArgs.set(call.args, record);
      return call;
    } catch (error) {
      try { if (release) await this.cleanupProjection(release); }
      finally { if (skeleton.ownsProjectionSlot) this.liveInputProjections--; }
      if (error instanceof ToolInputProjectionError) throw error;
      if (registration.projector) throw new ToolInputProjectionError('unavailable');
      throw error;
    }
  }

  /** Live owner callbacks run only before admission, never in the post-claim tail. */
  assertProjected(call: ProjectedToolCall): void {
    const record = this.projections.get(call);
    if (!record) throw new ToolInputProjectionError('invalid');
    this.assertCaptured(record, true);
  }

  /** Callback-free final check for consumers composing several projected alternatives. */
  assertProjectedSnapshot(call: ProjectedToolCall): void {
    const record = this.projections.get(call);
    if (!record) throw new ToolInputProjectionError('invalid');
    this.assertCaptured(record, false);
  }

  /** Idempotent resource release; refusal and callers that never execute must await it too. */
  async releaseProjected(call: ProjectedToolCall): Promise<void> {
    const record = this.projections.get(call);
    if (!record) throw new ToolInputProjectionError('invalid');
    return this.releaseCapture(record);
  }

  private async cleanupProjection(release: () => Promise<void>): Promise<void> {
    try { await release(); } catch { throw new ToolInputProjectionError('unavailable'); }
  }

  private releaseCapture(record: CapturedProjection): Promise<void> {
    if (record.releasePromise) return record.releasePromise;
    record.released = true;
    // Publish the shared completion before invoking owner cleanup (which may reenter).
    record.releasePromise = Promise.resolve().then(async () => {
      try { if (record.release) await this.cleanupProjection(record.release); }
      finally { if (record.ownsProjectionSlot) this.liveInputProjections--; }
    });
    return record.releasePromise;
  }

  /** With callbacks=false this checks only owned data, descriptors and intrinsic signals. */
  private assertCaptured(record: CapturedProjection, callbacks: boolean): void {
    if (record.claimed) throw new ToolInputProjectionError('stale');
    this.assertCapturedIdentity(record);
    if (callbacks) {
      try { assertProjectionCurrent(record.captureCurrent); assertProjectionCurrent(record.registration.assertCurrent); assertProjectionCurrent(record.assertCurrent); }
      catch (error) { if (record.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
      this.assertCaptured(record, false);
    }
  }

  /** Registration and owned lifetime checks also valid after the one-use claim. */
  private assertCapturedIdentity(record: CapturedProjection, afterRelease = false): void {
    const { registration, call } = record;
    if (record.released && !afterRelease) throw new ToolInputProjectionError('released');
    if (this.registrations.get(call.name) !== registration || this.tools.get(call.name) !== record.tool) {
      throw new ToolInputProjectionError('stale');
    }
    const rawDefinition = dataProperty(record.tool, 'definition', call.name);
    const execute = dataProperty(record.tool, 'execute', call.name);
    if (typeof execute !== 'function' || nodeTypes.isProxy(execute)) throw new ToolError('Autonomous executor must be a data-backed function', call.name);
    // Hidden descendants are also metadata, even though canonical JSON omits
    // them. Keep their complete accessor/proxy check on every observation.
    plainMetadata(rawDefinition, call.name);
    let unchanged = rawDefinition === record.rawDefinition;
    if (unchanged) {
      try { record.assertDefinitionCurrent(); }
      catch { unchanged = false; }
    }
    if (!unchanged) {
      // A graph change can still preserve the prior canonical definition.
      // Compare through the original full path; never adopt a new baseline.
      const current = preparationData(record.tool, call.name, true);
      const currentRevision = createHash('sha256').update(canonicalJson(current.definition as unknown as EntryType)).digest('hex');
      if (current.executor !== record.executor || currentRevision !== record.definitionRevision) throw new ToolInputProjectionError('stale');
    } else if (execute !== record.executor) {
      throw new ToolInputProjectionError('stale');
    }
    if (registration.projector && (projectionProperty(registration.projector, 'project') !== registration.project
      || projectionProperty(registration.projector, 'captureNativeReferences') !== registration.captureNativeReferences
      || projectionProperty(registration.projector, 'assertCurrent') !== registration.assertCurrent
      || projectionProperty(registration.projector, 'signal') !== registration.signal)) throw new ToolInputProjectionError('stale');
    assertProjectionSignal(record.signal);
  }

  /** Stage guards can inspect a catalog containing this projection. Keep them out of assertProjected. */
  private assertPreparationCurrent(record: CapturedProjection): void {
    assertProjectionSignal(record.preparationSignal);
    this.assertCaptured(record, true);
    try { for (const guard of record.preparationGuards.callbacks) assertProjectionCurrent(guard); }
    catch (error) { if (record.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
    this.assertCaptured(record, false);
    assertProjectionSignal(record.preparationSignal);
  }

  private repairPort(record: CapturedProjection, ids: string[], inner?: JudgmentPort): JudgmentPort {
    const registry = this;
    // Preserve the installed recorder without requiring a port for calls needing no repair.
    let captured = inner;
    if (!captured) { try { captured = judgmentPort('tools.input-projection.repair'); } catch { /* Lazily fail if a reading is needed. */ } }
    const port = () => captured ??= judgmentPort('tools.input-projection.repair');
    return {
      get model() { return port().model; },
      ...(captured?.recorder ? { recorder: captured.recorder } : {}),
      async ask(request) {
        const prior = request.beforeAttempt;
        registry.assertPreparationCurrent(record);
        const result = await port().ask({ ...request, beforeAttempt() { prior?.(); registry.assertPreparationCurrent(record); } });
        registry.assertPreparationCurrent(record);
        if (inner && !result.decisionId) throw new JudgmentError('unrecorded', 'argument repair has no recorded provenance');
        if (result.decisionId) ids.push(result.decisionId);
        return result;
      },
    };
  }

  private repairProjection(record: CapturedProjection, effective: Record<string, unknown>): void {
    if (record.registration.projector) {
      if (record.assertRepairedArgs) {
        try { assertProjectionCurrent(record.assertRepairedArgs, effective); } catch { throw new ToolInputProjectionError('binding-changed'); }
      } else if (autonomousRevision(effective) !== autonomousRevision(record.call.args)) {
        throw new ToolInputProjectionError('binding-changed');
      }
    }
    this.assertPreparationCurrent(record);
  }

  /** Own and repair before permission; no repair is permitted after admission. */
  async prepareCall(callId: string, name: string, args: Record<string, unknown>, opts?: ToolInputProjectionOptions & { readonly port?: JudgmentPort }): Promise<PreparedToolCall> {
    const projection = await this.projectCall(callId, name, args, opts);
    const record = this.projections.get(projection)!;
    const stageGuard = opts === undefined ? undefined : projectionFunction<() => void>(projectionProperty(opts, 'assertCurrent'));
    if (stageGuard && stageGuard !== record.captureCurrent && !record.preparationGuards.callbacks.has(stageGuard)) {
      if (record.preparationGuards.callbacks.size >= 128) throw new ToolInputProjectionError('capacity');
      record.preparationGuards.callbacks.add(stageGuard);
      record.preparationGuards.revision++;
    }
    const signal = combineProjectionSignals(record.signal, record.preparationSignal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
    record.preparationSignal = signal;
    try {
      this.assertPreparationCurrent(record);
      record.preparation ??= this.prepareProjection(record, signal, opts === undefined ? undefined : projectionProperty(opts, 'port') as JudgmentPort | undefined);
      const prepared = await record.preparation;
      assertProjectionSignal(signal);
      this.assertPreparationCurrent(record);
      return prepared;
    } catch (error) {
      await this.releaseCapture(record);
      throw error;
    }
  }

  private async prepareProjection(record: CapturedProjection, signal: AbortSignal | undefined, port: JudgmentPort | undefined): Promise<PreparedToolCall> {
    const projection = record.call;
    const { callId, name } = projection;
    const ids: string[] = [];
    try {
      this.assertPreparationCurrent(record);
      const repair = await repairToolCall(name, projection.args, record.definition, signal, this.repairPort(record, ids, port));
      assertProjectionSignal(signal);
      const effective = captureProjectionArgs(repair.repaired ? repair.fixed : projection.args, name);
      this.repairProjection(record, effective);
      const schemaArgs = record.nativeSchemaArgs ? record.nativeSchemaArgs(effective) : effective;
      if (await firstJsonSchemaFailureAsync(record.definition.parameters, schemaArgs, { signal, assertCurrent: () => this.assertPreparationCurrent(record) })) throw new ToolError('Prepared tool arguments do not match the registered schema', name);
      const call = Object.freeze({ callId, name, args: effective, schemaRevision: record.definitionRevision, judgmentDecisionIds: Object.freeze(ids) });
      this.prepared.set(call, { tool: record.tool, executor: record.executor, definitionRevision: record.definitionRevision,
        warnings: [...(repair.warnings ?? [])], projection: record, claimed: false });
      this.assertPrepared(call);
      return call;
    } catch (error) {
      await this.releaseCapture(record);
      throw error;
    }
  }

  /** Synchronous registration/snapshot check, suitable for the last admission boundary. */
  assertPrepared(call: PreparedToolCall): void {
    const record = this.prepared.get(call);
    if (!record || record.claimed || this.tools.get(call.name) !== record.tool) {
      throw new ToolError('Prepared tool registration is stale or already claimed', call.name);
    }
    this.assertCaptured(record.projection, false);
    assertProjectionSignal(record.projection.preparationSignal);
  }

  /** Authenticate the exact prepared handle before exposing registration-owned facts. */
  readPreparedAdmissionEvidence(call: PreparedToolCall): ToolAdmissionEvidence | undefined {
    this.assertPrepared(call);
    const evidence = this.prepared.get(call)!.projection.admissionEvidence;
    return evidence?.kind === 'agent-read' ? evidence : undefined;
  }

  /** The common owner reads both closed backend fact variants without changing the legacy READ accessor. */
  readPreparedOwnedAdmissionEvidence(call: PreparedToolCall): ToolOwnedAdmissionEvidence | undefined {
    this.assertPrepared(call);
    return this.prepared.get(call)!.projection.admissionEvidence;
  }

  /** Opaque backend binding, never part of the serializable permission evidence. */
  readPreparedSettingsMutation(call: PreparedToolCall): ToolPreparedSettingsMutation | undefined {
    this.assertPrepared(call);
    return this.prepared.get(call)!.projection.settingsMutation;
  }

  private assertExecuting(call: PreparedToolCall, record: PreparedExecution): void {
    if (this.prepared.get(call) !== record || !record.claimed || !record.projection.claimed
      || !record.projection.executionStarted) throw new ToolInputProjectionError('stale');
    this.assertCapturedIdentity(record.projection);
    assertProjectionSignal(record.projection.preparationSignal);
  }

  /** Invoke the exact prepared executor/arguments immediately after its one-use admission claim. */
  async executePrepared(call: PreparedToolCall, admission: AutonomousPermissionAdmission | (() => void), opts?: ToolExecuteOptions): Promise<ToolResult> {
    const callerCurrent = opts === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(opts, 'assertCurrent'));
    const record = this.prepared.get(call);
    if (!record || record.claimed || record.projection.executionStarted) throw new ToolError('Prepared tool registration is stale or already claimed', call.name);
    record.projection.executionStarted = true;
    let retireExecution: (() => void) | undefined;
    let proof: CurrentToolExecution | undefined;
    let executionSignal: AbortSignal | undefined;
    let assertReadPublication: (() => void) | undefined;
    try {
      assertProjectionCurrent(callerCurrent);
      const signal = combineProjectionSignals(record.projection.signal, record.projection.preparationSignal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
      executionSignal = signal;
      this.assertPreparationCurrent(record.projection);
      this.assertPrepared(call);
      const executionOptions = Object.freeze({ signal, ...(callerCurrent ? { assertCurrent: callerCurrent } : {}), ...(record.projection.executionContext ? { inputProjectionContext: record.projection.executionContext } : {}) });
      // All callbacks and option capture precede claim. The tail below is synchronous
      // and invokes only metadata/intrinsic checks before the exact executor.
      const guardRevision = record.projection.preparationGuards.revision;
      // Compatibility callbacks never mint autonomous body authority. Only the
      // manager's consume-only identity map can authenticate this exact handle.
      const assertAdmissionCurrent = typeof admission === 'function'
        ? (admission(), undefined) : consumeAutonomousAdmission(admission, this, call, registryPermissionOwners.get(this));
      if (record.projection.resultPublication === 'read-only') {
        // Registration-owned read dispatch only. This check cannot revive body
        // authority and is retained solely until this invocation's cleanup ends.
        assertReadPublication = () => {
          this.assertCapturedIdentity(record.projection, true);
          assertProjectionSignal(signal);
          assertAdmissionCurrent?.();
          assertProjectionCurrent(callerCurrent);
          this.assertCapturedIdentity(record.projection, true);
          assertProjectionSignal(signal);
        };
      }
      this.assertPrepared(call);
      if (record.projection.preparationGuards.revision !== guardRevision) throw new ToolInputProjectionError('stale');
      assertProjectionSignal(signal);
      record.claimed = true;
      record.projection.claimed = true;
      retireExecution = activateProjectionExecution(record.projection.executionContext, call.args, signal);
      if (assertAdmissionCurrent) {
        const assertEffect = readAutonomousEffectConstraint(assertAdmissionCurrent);
        if (!assertEffect) throw new ToolInputProjectionError('held');
        const mutation = record.projection.settingsMutation;
        let secretTransition: PreparedSecretImportTransition | undefined;
        let subscriptionTransition: PreparedSubscriptionImportTransition | undefined;
        let secretCompleted = false, subscriptionCompleted = false, remoteStarted = false, remoteCompleted = false;
        const assertImports = () => {
          if (mutation?.remoteImport) {
            if (remoteCompleted) assertCompletedRemoteSettingsImportPrecondition(mutation.remoteImport);
            else if (!remoteStarted) assertRemoteSettingsImportPrecondition(mutation.remoteImport);
            // The native pending operation retains its private source at every
            // wire boundary; the unspent precondition cannot be reused here.
          }
          const secret = mutation?.secretImport, subscription = mutation?.subscriptionImport;
          if (secret) {
            if (secretCompleted) secret.owner.assertCompletedImport(secret.mutation);
            else if (secretTransition) secret.owner.assertPreparedImportTransition(secret.mutation, secretTransition);
            else secret.owner.assertPreparedImport(secret.mutation);
          }
          if (subscription) {
            if (subscriptionCompleted) subscription.owner.assertCompletedImport(subscription.mutation);
            else if (subscriptionTransition) subscription.owner.assertPreparedImportTransition(subscription.mutation, subscriptionTransition);
            else subscription.owner.assertPreparedImport(subscription.mutation);
          }
        };
        const assertPlanSource = () => {
          mutation?.owner.assertSettingsWritable();
          assertProjectionCurrent(mutation?.assertSourceCurrent);
          if (mutation?.route) assertPreparedConfigWriteRoute(mutation.route);
          assertImports();
        };
        const assertPlanAuthority = () => {
          assertProjectionCurrent(callerCurrent); assertPlanSource();
          if (mutation?.mutation) mutation.owner.assertPreparedMutation(mutation.mutation);
          this.assertExecuting(call, record); assertProjectionSignal(signal); assertAdmissionCurrent(); assertEffect('write');
          assertPlanSource();
          if (mutation?.mutation) mutation.owner.assertPreparedMutation(mutation.mutation);
          this.assertExecuting(call, record); assertProjectionSignal(signal);
        };
        const configMutation = mutation?.mutation;
        let configReceipt: PreparedConfigMutationReceipt | undefined;
        let remoteReceipt: PreparedConfigMutationReceipt | undefined;
        let priorPlanPaths: readonly string[] = [];
        const commitConfig = mutation && configMutation ? () => {
          assertPlanAuthority();
          const transition = mutation.owner.beginPreparedMutation(configMutation);
          const final = () => {
            // Establish only this native transaction on the private owner chain
            // before a child's retained parent samples the authorized onset.
            assertAutonomousConfigTransition(assertAdmissionCurrent, mutation, transition);
            assertProjectionCurrent(callerCurrent); assertPlanSource();
            this.assertExecuting(call, record); assertProjectionSignal(signal); assertEffect('write');
            if (mutation.secretDeletion) mutation.secretDeletion.owner.assertCompletedScopedDeletion(mutation.secretDeletion.mutation);
            this.assertExecuting(call, record); assertProjectionSignal(signal);
          };
          final();
          const receipt = mutation.owner.finishPreparedMutation(configMutation, transition, final);
          configReceipt = receipt;
          if (proof && receipt.completedPaths.length) proof.settingsReceipt = Object.freeze({ ...receipt,
            completedPaths: Object.freeze([...priorPlanPaths, ...receipt.completedPaths]) });
          if (receipt.status === 'committed') completeAutonomousConfigTransition(assertAdmissionCurrent, mutation, transition);
          return receipt;
        } : undefined;
        const commitPlan = mutation ? async (): Promise<PreparedConfigMutationReceipt> => {
          const completedPaths: string[] = [];
          priorPlanPaths = completedPaths;
          const joined = (receipt: PreparedConfigMutationReceipt): PreparedConfigMutationReceipt => Object.freeze({ ...receipt,
            status: receipt.status !== 'committed' && completedPaths.length ? 'partial' : receipt.status,
            completedPaths: Object.freeze([...completedPaths, ...receipt.completedPaths]) });
          try {
            assertPlanAuthority();
            if (mutation.remoteImport) {
              remoteStarted = true;
              const receipt = await applyRemoteSettingsImportPrecondition(mutation.remoteImport, {
                ...(signal ? { signal } : {}), assertCurrent: assertPlanAuthority,
              });
              remoteReceipt = receipt;
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths); remoteCompleted = true;
              assertCompletedRemoteSettingsImportPrecondition(mutation.remoteImport); assertPlanAuthority();
            }
            if (mutation.secretDeletion) {
              const deletion = mutation.secretDeletion;
              const receipt = await deletion.owner.applyPreparedScopedDeletion(deletion.mutation, assertPlanAuthority);
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths);
              deletion.owner.assertCompletedScopedDeletion(deletion.mutation);
              assertPlanAuthority();
            }
            if (mutation.secretImport) {
              const imported = mutation.secretImport;
              secretTransition = imported.owner.beginPreparedImport(imported.mutation);
              const receipt = await imported.owner.finishPreparedImport(imported.mutation, secretTransition, assertPlanAuthority);
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths); secretCompleted = true;
              imported.owner.assertCompletedImport(imported.mutation); assertPlanAuthority();
            }
            if (mutation.subscriptionImport) {
              const imported = mutation.subscriptionImport;
              subscriptionTransition = imported.owner.beginPreparedImport(imported.mutation);
              const receipt = imported.owner.finishPreparedImport(imported.mutation, subscriptionTransition, assertPlanAuthority);
              if (receipt.status !== 'committed') return joined(receipt);
              completedPaths.push(...receipt.completedPaths); subscriptionCompleted = true;
              imported.owner.assertCompletedImport(imported.mutation); assertPlanAuthority();
            }
            return commitConfig ? joined(commitConfig()) : Object.freeze({ status: 'committed', completedPaths: Object.freeze(completedPaths) });
          } catch {
            // Completion/source retirement cannot erase a native receipt for
            // physical effects that already happened. It still retires authority.
            if (proof && (configReceipt || remoteReceipt?.status === 'committed' || completedPaths.length)) proof.settingsRetired = true;
            if (configReceipt) return joined(configReceipt);
            if (remoteReceipt && !mutation.mutation && !mutation.secretDeletion && !mutation.secretImport && !mutation.subscriptionImport) return remoteReceipt;
            return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths) });
          }
        } : undefined;
        const nestedOwner = readAutonomousNestedOwner(assertAdmissionCurrent);
        if (!nestedOwner) throw new ToolInputProjectionError('held');
        proof = { registry: this, nestedOwner, admissionGuard: assertAdmissionCurrent, args: call.args, active: true, checking: false, assertEffect,
          assertWorkspace: readAutonomousWorkspaceConstraint(assertAdmissionCurrent),
          settingsPresentation: readAutonomousSettingsPresentation(assertAdmissionCurrent),
          ...(mutation && commitPlan ? { ...(commitConfig && !mutation.remoteImport && !mutation.secretDeletion && !mutation.secretImport && !mutation.subscriptionImport ? { commitSettings: commitConfig } : {}), commitSettingsPlan: commitPlan } : {}), assertCurrent: () => {
          this.assertExecuting(call, record);
          assertProjectionSignal(signal);
          assertAdmissionCurrent();
          assertProjectionCurrent(callerCurrent);
          assertProjectionCurrent(record.projection.nativeCurrent);
          // Owner authority sampling can reenter. End at an owned-data check.
          this.assertExecuting(call, record);
          assertProjectionSignal(signal);
        } };
        currentToolExecutions.set(executionOptions, proof);
      }
      record.projection.executionCurrent = () => {
        this.assertExecuting(call, record); assertProjectionSignal(signal);
        assertProjectionCurrent(record.projection.registration.assertCurrent);
        assertProjectionCurrent(callerCurrent); assertAdmissionCurrent?.();
        this.assertExecuting(call, record); assertProjectionSignal(signal);
      };
      const execute = () => { assertProjectionCurrent(callerCurrent); return applyIntrinsic(record.executor, record.tool, [call.args, executionOptions]); };
      const result = await (proof ? executingContext.run({ proof, options: executionOptions }, execute) : execute());
      assertProjectionCurrent(callerCurrent);
      if (proof?.settingsReceipt) { assertProjectionSignal(signal); assertAdmissionCurrent?.(); }
      if (proof?.settingsRetired) throw new ToolInputProjectionError('stale');
      if (proof) proof.active = false;
      retireExecution(); retireExecution = undefined;
      const published = { ...result, callId: call.callId,
        ...(record.warnings.length ? { warnings: [...(result.warnings ?? []), ...record.warnings] } : {}) };
      if (proof?.settingsReceipt) settingsResultReceipts.set(published, proof.settingsReceipt);
      return published;
    } catch (error) {
      if (proof?.settingsReceipt && (proof.settingsReceipt.status === 'committed' || proof.settingsReceipt.completedPaths.length)) {
        proof.active = false;
        return retiredSettingsResult(call.callId, proof.settingsReceipt, executionSignal);
      }
      throw error;
    } finally {
      record.projection.executionCurrent = undefined;
      if (proof) proof.active = false;
      retireExecution?.();
      try { await this.releaseCapture(record.projection); assertReadPublication?.(); }
      catch (error) {
        if (proof?.settingsReceipt && (proof.settingsReceipt.status === 'committed' || proof.settingsReceipt.completedPaths.length)) {
          return retiredSettingsResult(call.callId, proof.settingsReceipt, executionSignal);
        }
        throw error;
      }
      finally { assertReadPublication = undefined; }
    }
  }

  /** A child receives its own recorded admission under the original live parent source. */
  async executeNested(callId: string, name: string, args: Record<string, unknown>, opts?: ToolExecuteOptions,
    restrictions?: Pick<ToolExecuteOptions, 'signal' | 'assertCurrent'>): Promise<ToolResult> {
    const context = executingContext.getStore();
    const parent = opts && currentToolExecutions.get(opts);
    if (!opts || !parent || context?.options !== opts || context.proof !== parent
      || parent.registry !== this || !parent.active) throw new ToolInputProjectionError('held');
    const restrictionSignal = restrictions === undefined ? undefined : projectionSignal(projectionProperty(restrictions, 'signal'));
    const restrictionCurrent = restrictions === undefined ? undefined : projectionFunction<() => void>(projectionProperty(restrictions, 'assertCurrent'));
    const assertParentProof = () => {
      if (currentToolExecutions.get(opts) !== parent || !parent.active || parent.registry !== this
        || !assertCurrentToolExecution(parent.args, opts)) throw new ToolInputProjectionError('stale');
    };
    const assertParent = () => {
      assertParentProof(); assertProjectionSignal(restrictionSignal);
      if (restrictions && (projectionProperty(restrictions, 'signal') !== restrictionSignal
        || projectionProperty(restrictions, 'assertCurrent') !== restrictionCurrent)) throw new ToolInputProjectionError('stale');
      if (restrictionCurrent) {
        assertProjectionCurrent(restrictionCurrent); assertParentProof(); assertProjectionSignal(restrictionSignal);
      }
    };
    assertParent();
    const { manager, source, decoratePort } = parent.nestedOwner;
    const sourceOf = () => { assertParent(); return source; };
    const sourceId = randomUUID();
    const signal = combineProjectionSignals(opts.signal, restrictionSignal);
    const projections = new Set<ProjectedToolCall>();
    let choiceProjection: AutonomousChoiceProjection | undefined;
    try {
      await manager.prepareAutonomousOwner(signal); assertParent();
      const original = manager.autonomousPreparation(sourceId, sourceOf, signal, decoratePort);
      const initial = await this.projectCall(callId, name, args, { signal, assertCurrent: () => { assertParent(); original.assertCurrent(); } });
      projections.add(initial); assertParent();
      choiceProjection = await manager.projectAutonomousChoices(sourceId, callId, sourceOf, this, signal);
      assertParent(); original.assertCurrent();
      const prepare = async (toolName: string, input: Record<string, unknown>) => {
        const preparation = manager.autonomousPreparation(sourceId, sourceOf, signal, decoratePort, choiceProjection);
        const assertCurrent = () => { assertParent(); preparation.assertCurrent(); };
        const projected = await this.projectCall(callId, toolName, input, { signal, assertCurrent });
        projections.add(projected); assertCurrent();
        const call = await this.prepareCall(callId, toolName, projected.args, { signal, port: preparation.port, assertCurrent });
        assertCurrent(); return call;
      };
      let call = await prepare(name, initial.args);
      const consumedRevisions: string[] = [];
      let permittedRevisionIds: readonly string[] | undefined;
      while (true) {
        const current = call;
        const admission = await manager.admitAutonomous(sourceId, current.name, current.args, {
          sourceOf, decoratePort, signal, choiceProjection,
          consumedRevisions, ...(permittedRevisionIds ? { permittedRevisionIds } : {}),
          schemaRevision: current.schemaRevision, preparationDecisionIds: current.judgmentDecisionIds,
          preparedCall: { registry: this, call: current }, assertPrepared: () => { assertParent(); this.assertPrepared(current); },
        });
        assertParent(); permittedRevisionIds ??= admission.revisionIds;
        if (admission.revision) {
          const revision = admission.revision;
          if (consumedRevisions.includes(revision.ref.id)) throw new ToolInputProjectionError('stale');
          consumedRevisions.push(revision.ref.id);
          call = await prepare(revision.toolName, revision.args);
          continue;
        }
        if (!admission.result.approved) return { callId, success: false,
          error: `Nested tool admission ${admission.result.autonomousDecision?.outcome ?? 'held'}: ${admission.result.reasonCode}` };
        bindAutonomousNestedAdmission(parent.admissionGuard, admission);
        const result = await this.executePrepared(current, admission, { signal, assertCurrent: assertParent });
        const receipt = settingsResultReceipts.get(result);
        if (receipt) retainSettingsReceipt(parent, receipt);
        try { assertParent(); }
        catch (error) {
          if (!receipt) throw error;
          parent.active = false;
          return retiredSettingsResult(current.callId, parent.settingsReceipt!, signal);
        }
        return result;
      }
    } finally {
      const released = await Promise.allSettled([
        ...[...projections].map(projected => this.releaseProjected(projected)),
        ...(choiceProjection ? [manager.releaseAutonomousChoices(choiceProjection)] : []),
      ]);
      const failure = released.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }

  /**
   * Execute a named tool with the given arguments. Wraps errors in ToolResult.
   *
   * `opts.signal` cancels pending argument repair and passes through to
   * `tool.execute`, where tools that opt in (exec, fetch) read it. Callers
   * that don't have a cancellation signal (the common case) omit `opts`.
   */
  async execute(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const callerCurrent = opts === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(opts, 'assertCurrent'));
    assertProjectionCurrent(callerCurrent);
    const tool = this.tools.get(name);
    if (!tool) {
      const known = [...this.tools.keys()].sort();
      return {
        callId,
        success: false,
        error: known.length > 0
          ? `Unknown tool: '${name}'. Known tools: ${known.join(', ')}.`
          : `Unknown tool: '${name}'. No tools are registered.`,
      };
    }

    // Omitted protection retains the legacy direct-execution contract: its
    // existing wrappers own their refusal/result shape and original arguments.
    // prepareCall and owned ingress still use immutable captures for admission.
    if (this.registrations.get(name)?.projector === undefined) {
      return this.executeOrdinary(callId, name, tool, args, opts);
    }

    let record: CapturedProjection | undefined;
    let retireExecution: (() => void) | undefined;
    let assertReadPublication: (() => void) | undefined;
    try {
      const projected = await this.projectCall(callId, name, args, opts);
      const selected = this.projections.get(projected)!;
      if (selected.executionStarted) throw new ToolInputProjectionError('stale');
      record = selected;
      record.executionStarted = true;
      const signal = combineProjectionSignals(record.signal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
      this.assertCaptured(record, true);
      const repairResult = await repairToolCall(name, projected.args, record.definition, signal, this.repairPort(record, []));
      assertProjectionSignal(signal);
      const effectiveArgs = captureProjectionArgs(repairResult.repaired ? repairResult.fixed : projected.args, name);
      this.repairProjection(record, effectiveArgs);
      const executionOptions = record.registration.projector
        ? Object.freeze({ signal, ...(callerCurrent ? { assertCurrent: callerCurrent } : {}), ...(record.executionContext ? { inputProjectionContext: record.executionContext } : {}) })
        : opts === undefined || projectionProperty(opts, 'inputProjectionContext') === undefined ? opts : Object.freeze({ signal });
      this.assertCaptured(record, false);
      record.claimed = true;
      const capturedRecord = record;
      record.executionCurrent = () => {
        if (!capturedRecord.claimed || !capturedRecord.executionStarted) throw new ToolInputProjectionError('stale');
        this.assertCapturedIdentity(capturedRecord); assertProjectionSignal(signal);
        assertProjectionCurrent(capturedRecord.captureCurrent);
        assertProjectionCurrent(capturedRecord.registration.assertCurrent);
        assertProjectionCurrent(callerCurrent, effectiveArgs);
        this.assertCapturedIdentity(capturedRecord); assertProjectionSignal(signal);
      };
      if (record.resultPublication === 'read-only') {
        assertReadPublication = () => {
          assertProjectionCurrent(callerCurrent, effectiveArgs);
          this.assertCapturedIdentity(capturedRecord, true);
          assertProjectionSignal(signal);
        };
      }
      retireExecution = activateProjectionExecution(record.executionContext, effectiveArgs, signal);
      assertProjectionCurrent(callerCurrent, effectiveArgs);
      const result = await applyIntrinsic(record.executor, record.tool, [effectiveArgs, executionOptions]);
      assertProjectionCurrent(callerCurrent, effectiveArgs);
      retireExecution(); retireExecution = undefined;
      const toolResult = { ...result, callId };
      if (repairResult.warnings && repairResult.warnings.length > 0) {
        toolResult.warnings = [...(toolResult.warnings ?? []), ...repairResult.warnings];
      }
      if (repairResult.repaired && !toolResult.cancelled && !signal?.aborted) {
        const repairNote = `[Auto-repaired: ${repairResult.repairs.join(', ')}]`;
        toolResult.output = typeof toolResult.output === 'string' ? `${repairNote}\n${toolResult.output}` : repairNote;
      }
      return toolResult;
    } catch (err) {
      if (err instanceof ToolInputProjectionError) {
        if (err.problem === 'cancelled' && this.registrations.get(name)?.projector === undefined) {
          throw new ToolError('the judgment call was cancelled', name, { cause: new JudgmentError('aborted', 'the judgment call was cancelled') });
        }
        throw err;
      }
      const message = summarizeError(err);
      throw new ToolError(message, name, err instanceof Error ? { cause: err } : undefined);
    } finally {
      if (record) record.executionCurrent = undefined;
      retireExecution?.();
      try { if (record) await this.releaseCapture(record); assertReadPublication?.(); }
      finally { assertReadPublication = undefined; }
    }
  }

  /** Original non-projected execute path; never used by a required projector. */
  private async executeOrdinary(callId: string, name: string, tool: Tool,
    args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<ToolResult> {
    const signal = opts?.signal;
    const assertCurrent = opts === undefined ? undefined : projectionFunction<(args?: Record<string, unknown>) => void>(projectionProperty(opts, 'assertCurrent'));
    assertProjectionCurrent(assertCurrent);
    try {
      const repair = await repairToolCall(name, args, tool.definition, signal);
      if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
      assertProjectionCurrent(assertCurrent);
      const effectiveArgs = repair.repaired ? repair.fixed : args;
      // The new projection-context field is owner-only, even on a legacy call.
      const executionOptions = assertCurrent ? Object.freeze({ signal, assertCurrent })
        : opts === undefined || projectionProperty(opts, 'inputProjectionContext') === undefined ? opts : Object.freeze({ signal });
      assertProjectionCurrent(assertCurrent, effectiveArgs);
      const result = await tool.execute(effectiveArgs, executionOptions);
      assertProjectionCurrent(assertCurrent, effectiveArgs);
      const toolResult = { ...result, callId };
      if (repair.warnings?.length) toolResult.warnings = [...(toolResult.warnings ?? []), ...repair.warnings];
      if (repair.repaired && !toolResult.cancelled && !signal?.aborted) {
        const note = `[Auto-repaired: ${repair.repairs.join(', ')}]`;
        toolResult.output = typeof toolResult.output === 'string' ? `${note}\n${toolResult.output}` : note;
      }
      return toolResult;
    } catch (error) {
      throw new ToolError(summarizeError(error), name, error instanceof Error ? { cause: error } : undefined);
    }
  }

  /**
   * Remove a registered tool. When `expected` is given, the tool is removed
   * only if it is still that exact registration (a later owner of the same
   * name is left alone). Returns whether a tool was removed.
   */
  unregister(name: string, expected?: Tool): boolean {
    const current = this.tools.get(name);
    if (!current || (expected !== undefined && current !== expected)) return false;
    this.tools.delete(name);
    this.registrations.delete(name);
    return true;
  }

  /** Returns true if a tool with the given name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Returns all registered tools. */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}
