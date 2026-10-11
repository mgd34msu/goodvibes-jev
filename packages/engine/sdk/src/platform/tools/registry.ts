import { AsyncLocalStorage } from 'node:async_hooks';
import { types as nodeTypes } from 'node:util';
import { createHash } from 'node:crypto';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import {
  ToolInputProjectionError, assertProjectionSignal, captureProjectionArgs,
  combineProjectionSignals, projectionContext, projectionFunction, projectionProperty, projectionSignal,
  activateProjectionExecution,
  captureAdmissionEvidence,
  captureSettingsAdmissionEvidence,
  captureSettingsMutation,
  type ProjectedToolCall, type ToolInputProjector, type ToolRegistrationOptions,
  type ToolAdmissionEvidence, type ToolOwnedAdmissionEvidence, type ToolInputProjectionResult, type ToolInputProjectionOptions,
  type ToolPreparedSettingsMutation,
} from './input-projection.js';
import { canonicalJson, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { autonomousRevision } from '../permissions/autonomous.js';
import { assertAutonomousConfigTransition, readAutonomousSettingsPresentation, readAutonomousWorkspaceConstraint, consumeAutonomousAdmission, type AutonomousPermissionAdmission, type PermissionManager } from '../permissions/manager.js';
import type { PreparedConfigMutationReceipt, PreparedConfigMutationTransition } from '../config/manager.js';
import { assertPreparedConfigWriteRoute } from '../config/settings-precondition-client.js';
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
  readonly assertCurrent: (() => void) | undefined;
  readonly signal: AbortSignal | undefined;
}

interface CapturedProjection {
  readonly call: ProjectedToolCall;
  readonly registration: ProjectionRegistration;
  readonly tool: Tool;
  readonly executor: Tool['execute'];
  readonly definition: ToolDefinition;
  readonly definitionRevision: string;
  readonly captureCurrent: (() => void) | undefined;
  readonly preparationGuards: { readonly callbacks: Set<() => void>; revision: number };
  readonly ownsProjectionSlot: boolean;
  executionStarted: boolean;
  preparationSignal?: AbortSignal | undefined;
  readonly signal: AbortSignal | undefined;
  readonly assertCurrent: (() => void) | undefined;
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

interface CurrentToolExecution {
  readonly assertWorkspace?: (() => void) | undefined;
  readonly args: Record<string, unknown>;
  readonly assertCurrent: () => void;
  readonly commitSettings?: (() => PreparedConfigMutationReceipt) | undefined;
  readonly commitSettingsPlan?: (() => Promise<PreparedConfigMutationReceipt>) | undefined;
  readonly settingsPresentation?: Readonly<{ previous: unknown; current: unknown }> | undefined;
  active: boolean;
  checking: boolean;
}

// Exact options identity is the invocation capability. No caller-visible field
// and no exported minting operation can construct an authentic body proof.
const currentToolExecutions = new WeakMap<ToolExecuteOptions, CurrentToolExecution>();
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
  options?.assertCurrent?.(args);
  const proof = options && currentToolExecutions.get(options);
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
  return proof.commitSettings();
}

/** Consume a complete config/credential plan once. Async acquisition stays under its original proof. */
export async function commitCurrentToolSettingsPlan(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<PreparedConfigMutationReceipt> {
  const proof = options && currentToolExecutions.get(options);
  if (!proof?.commitSettingsPlan || !assertCurrentToolExecution(args, options)) throw new ToolInputProjectionError('held');
  proof.active = false;
  return proof.commitSettingsPlan();
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

function preparationData(tool: Tool, name: string, freshness = false): { executor: Tool['execute']; definition: ToolDefinition } {
  const definition = dataProperty(tool, 'definition', name);
  const execute = dataProperty(tool, 'execute', name);
  if (typeof execute !== 'function' || nodeTypes.isProxy(execute)) throw new ToolError('Autonomous executor must be a data-backed function', name);
  plainMetadata(definition, name);
  // Acquisition screens the definition. Freshness needs a new bounded
  // structural capture of its current canonical data, not another privacy decision on
  // the same bytes. The caller must compare it to that screened revision before
  // use; the complete descriptor walk above still rejects hidden accessors/proxies.
  return { executor: execute as Tool['execute'], definition: (freshness
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
    const signal = projector ? projectionSignal(projectionProperty(projector, 'signal')) : undefined;
    this.tools.set(name, tool);
    this.registrations.set(name, Object.freeze({ tool, projector, project, assertCurrent, signal,
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
      try { captureCurrent?.(); }
      catch (error) { if (reused.registration.projector) throw new ToolInputProjectionError('stale'); throw error; }
      this.assertCaptured(reused, true);
      return reused.call;
    }
    const captured = captureProjectionArgs(args, name);
    const registration = this.registrations.get(name);
    if (!registration) throw new UnknownPreparedToolError(name);
    if (registration.projector === null) throw new ToolInputProjectionError('unconfigured');
    const { executor, definition } = preparationData(registration.tool, name);
    const definitionRevision = autonomousRevision(definition);
    const combined = combineProjectionSignals(signal, registration.signal);
    const skeleton = { registration, tool: registration.tool, executor, definition, definitionRevision, captureCurrent, preparationGuards: { callbacks: new Set<() => void>(), revision: 0 }, ownsProjectionSlot: registration.projector !== undefined, executionStarted: false,
      signal: combined, assertCurrent: undefined, assertRepairedArgs: undefined, release: undefined,
      executionContext: undefined, admissionEvidence: undefined, settingsMutation: undefined, resultPublication: undefined, released: false, claimed: false };
    const provisional: CapturedProjection = { ...skeleton, call: Object.freeze({ callId, name, args: Object.freeze({}),
      schemaRevision: definitionRevision, projectionRevision: registration.revision }) };
    this.assertCaptured(provisional, true);
    if (skeleton.ownsProjectionSlot) {
      if (this.liveInputProjections >= MAX_LIVE_INPUT_PROJECTIONS) throw new ToolInputProjectionError('capacity');
      this.liveInputProjections++;
    }
    let release: (() => Promise<void>) | undefined;
    try {
      let projected = captured;
      let resultSignal: AbortSignal | undefined;
      let assertCurrent: (() => void) | undefined;
      let assertRepairedArgs: ((args: Record<string, unknown>) => void) | undefined;
      let executionContext: object | undefined;
      let admissionEvidence: ToolOwnedAdmissionEvidence | undefined;
      let settingsMutation: ToolPreparedSettingsMutation | undefined;
      let resultPublication: 'read-only' | undefined;
      if (registration.projector && registration.project) {
        const result: ToolInputProjectionResult = await applyIntrinsic(registration.project, registration.projector, [Object.freeze({
          callId, name, args: captured, signal: combined, assertCurrent: () => this.assertCaptured(provisional, true),
        })]);
        if (!result || typeof result !== 'object' || nodeTypes.isProxy(result)) throw new ToolInputProjectionError('invalid');
        release = projectionFunction<() => Promise<void>>(projectionProperty(result, 'release'));
        this.assertCaptured(provisional, true);
        const status = projectionProperty(result, 'status');
        if (status === 'held') throw new ToolInputProjectionError('held');
        if (status !== 'projected') throw new ToolInputProjectionError('invalid');
        projected = captureProjectionArgs(projectionProperty(result, 'args'), name);
        resultSignal = projectionSignal(projectionProperty(result, 'signal'));
        assertCurrent = projectionFunction<() => void>(projectionProperty(result, 'assertCurrent'));
        assertRepairedArgs = projectionFunction<(args: Record<string, unknown>) => void>(projectionProperty(result, 'assertRepairedArgs'));
        executionContext = projectionContext(projectionProperty(result, 'executionContext'));
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
        assertCurrent, assertRepairedArgs, release, executionContext, admissionEvidence, settingsMutation, resultPublication };
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
      try { record.captureCurrent?.(); record.registration.assertCurrent?.(); record.assertCurrent?.(); }
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
    const current = preparationData(record.tool, call.name, true);
    // Exact autonomousRevision bytes over this freshly captured owned snapshot.
    // Never cache a successful check or refresh the already-screened baseline.
    const currentRevision = createHash('sha256').update(canonicalJson(current.definition as unknown as EntryType)).digest('hex');
    if (current.executor !== record.executor || currentRevision !== record.definitionRevision) {
      throw new ToolInputProjectionError('stale');
    }
    if (registration.projector && (projectionProperty(registration.projector, 'project') !== registration.project
      || projectionProperty(registration.projector, 'assertCurrent') !== registration.assertCurrent
      || projectionProperty(registration.projector, 'signal') !== registration.signal)) throw new ToolInputProjectionError('stale');
    assertProjectionSignal(record.signal);
  }

  /** Stage guards can inspect a catalog containing this projection. Keep them out of assertProjected. */
  private assertPreparationCurrent(record: CapturedProjection): void {
    assertProjectionSignal(record.preparationSignal);
    this.assertCaptured(record, true);
    try { for (const guard of record.preparationGuards.callbacks) guard(); }
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
        try { record.assertRepairedArgs(effective); } catch { throw new ToolInputProjectionError('binding-changed'); }
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
      if (await firstJsonSchemaFailureAsync(record.definition.parameters, effective, { signal, assertCurrent: () => this.assertPreparationCurrent(record) })) throw new ToolError('Prepared tool arguments do not match the registered schema', name);
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
    const callerCurrent = opts?.assertCurrent;
    const record = this.prepared.get(call);
    if (!record || record.claimed || record.projection.executionStarted) throw new ToolError('Prepared tool registration is stale or already claimed', call.name);
    record.projection.executionStarted = true;
    let retireExecution: (() => void) | undefined;
    let proof: CurrentToolExecution | undefined;
    let assertReadPublication: (() => void) | undefined;
    try {
      callerCurrent?.();
      const signal = combineProjectionSignals(record.projection.signal, record.projection.preparationSignal, opts === undefined ? undefined : projectionSignal(projectionProperty(opts, 'signal')));
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
          callerCurrent?.();
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
        const mutation = record.projection.settingsMutation;
        const assertPlanAuthority = () => {
          callerCurrent?.();
          if (mutation?.route) assertPreparedConfigWriteRoute(mutation.route);
          if (mutation) mutation.owner.assertPreparedMutation(mutation.mutation);
          this.assertExecuting(call, record); assertProjectionSignal(signal); assertAdmissionCurrent();
          if (mutation) mutation.owner.assertPreparedMutation(mutation.mutation);
          this.assertExecuting(call, record); assertProjectionSignal(signal);
        };
        const commitConfig = mutation ? () => {
          const transition = mutation.owner.beginPreparedMutation(mutation.mutation);
          const final = () => {
            callerCurrent?.();
            if (mutation.route) assertPreparedConfigWriteRoute(mutation.route);
            this.assertExecuting(call, record); assertProjectionSignal(signal);
            assertAutonomousConfigTransition(assertAdmissionCurrent, mutation, transition);
            if (mutation.secretDeletion) mutation.secretDeletion.owner.assertCompletedScopedDeletion(mutation.secretDeletion.mutation);
            this.assertExecuting(call, record); assertProjectionSignal(signal);
          };
          final();
          return mutation.owner.finishPreparedMutation(mutation.mutation, transition, final);
        } : undefined;
        const commitPlan = mutation && commitConfig ? async (): Promise<PreparedConfigMutationReceipt> => {
          const completedPaths: string[] = [];
          try {
            if (mutation.secretDeletion) {
              const deletion = mutation.secretDeletion;
              const receipt = await deletion.owner.applyPreparedScopedDeletion(deletion.mutation, assertPlanAuthority);
              completedPaths.push(...receipt.completedPaths);
              if (receipt.status !== 'committed') return receipt;
              deletion.owner.assertCompletedScopedDeletion(deletion.mutation);
              assertPlanAuthority();
            }
            const receipt = commitConfig();
            return Object.freeze({ ...receipt, status: receipt.status !== 'committed' && completedPaths.length ? 'partial' : receipt.status,
              completedPaths: Object.freeze([...completedPaths, ...receipt.completedPaths]) });
          } catch {
            return Object.freeze({ status: completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths) });
          }
        } : undefined;
        proof = { args: call.args, active: true, checking: false,
          assertWorkspace: readAutonomousWorkspaceConstraint(assertAdmissionCurrent),
          settingsPresentation: readAutonomousSettingsPresentation(assertAdmissionCurrent),
          ...(mutation && commitConfig && commitPlan ? { ...(mutation.secretDeletion ? {} : { commitSettings: commitConfig }), commitSettingsPlan: commitPlan } : {}), assertCurrent: () => {
          callerCurrent?.();
          this.assertExecuting(call, record);
          assertProjectionSignal(signal);
          assertAdmissionCurrent();
          // Owner authority sampling can reenter. End at an owned-data check.
          this.assertExecuting(call, record);
          assertProjectionSignal(signal);
        } };
        currentToolExecutions.set(executionOptions, proof);
      }
      const execute = () => { callerCurrent?.(); return applyIntrinsic(record.executor, record.tool, [call.args, executionOptions]); };
      const result = await (proof ? executingContext.run({ proof, options: executionOptions }, execute) : execute());
      callerCurrent?.();
      if (proof) proof.active = false;
      retireExecution(); retireExecution = undefined;
      return { ...result, callId: call.callId,
        ...(record.warnings.length ? { warnings: [...(result.warnings ?? []), ...record.warnings] } : {}) };
    } finally {
      if (proof) proof.active = false;
      retireExecution?.();
      try { await this.releaseCapture(record.projection); assertReadPublication?.(); }
      finally { assertReadPublication = undefined; }
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
    const callerCurrent = opts?.assertCurrent;
    callerCurrent?.();
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
      if (record.resultPublication === 'read-only') {
        const capturedRecord = record;
        assertReadPublication = () => {
          callerCurrent?.(effectiveArgs);
          this.assertCapturedIdentity(capturedRecord, true);
          assertProjectionSignal(signal);
        };
      }
      retireExecution = activateProjectionExecution(record.executionContext, effectiveArgs, signal);
      callerCurrent?.(effectiveArgs);
      const result = await applyIntrinsic(record.executor, record.tool, [effectiveArgs, executionOptions]);
      callerCurrent?.(effectiveArgs);
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
      retireExecution?.();
      try { if (record) await this.releaseCapture(record); assertReadPublication?.(); }
      finally { assertReadPublication = undefined; }
    }
  }

  /** Original non-projected execute path; never used by a required projector. */
  private async executeOrdinary(callId: string, name: string, tool: Tool,
    args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<ToolResult> {
    const signal = opts?.signal;
    const assertCurrent = opts?.assertCurrent;
    assertCurrent?.();
    try {
      const repair = await repairToolCall(name, args, tool.definition, signal);
      if (signal?.aborted) throw new JudgmentError('aborted', 'the judgment call was cancelled');
      assertCurrent?.();
      const effectiveArgs = repair.repaired ? repair.fixed : args;
      // The new projection-context field is owner-only, even on a legacy call.
      const executionOptions = assertCurrent ? Object.freeze({ signal, assertCurrent })
        : opts === undefined || projectionProperty(opts, 'inputProjectionContext') === undefined ? opts : Object.freeze({ signal });
      assertCurrent?.(effectiveArgs);
      const result = await tool.execute(effectiveArgs, executionOptions);
      assertCurrent?.(effectiveArgs);
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
