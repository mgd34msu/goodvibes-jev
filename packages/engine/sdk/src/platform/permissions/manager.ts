import { readSettingsWriteEvidence } from '../gate/policy/settings-write-evidence.js';
import { hashState, JudgmentError, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { getProcessUntrustedContentLedger } from '../security/untrusted-content.js';
import { autonomousSourceEvidence, autonomousRevision, assertAutonomousData, captureAutonomousChoices, captureAutonomousSource, decideAutonomousTool, type AutonomousToolChoices, type AutonomousToolRevision, type AutonomousToolSource } from './autonomous.js';
import { AutonomousChoiceProjectionOwner, type AutonomousChoiceProjection } from './autonomous-input-projection.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { JevDecisionBinding, JevVersionRef } from '@goodvibes-jev/judgment/decisions';
import { bindTurnHookDispatcher, type TurnHookOwner } from '../hooks/turn-ownership.js';
import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.js';
import type { PermissionAction, PermissionsToolConfig, PermissionMode, BackgroundAgentsMode } from '../config/schema.js';
import type { PermissionAttribution, PermissionExecutionOptions, PermissionRequestHandler } from './prompt.js';
import { assertPermissionActive, awaitPermission } from './cancellation.js';
import { analyzePermissionRequest, withReading } from './analysis.js';
import { judgmentInputBoundary, runBoundary, type BoundaryCheckName, type BoundaryVerdict } from '../gate/boundary.js';
import { decideByPreset, presetForMode, type GatePreset } from '../gate/presets.js';
import { categoryForSideEffectKind, classificationFromReading, readingArguments, readTouchesSecrets, readToolCall, shellCommandsIn, type GateReading } from '../gate/reading.js';
import { grantOwnerApproval, type OwnerApproval } from '../security/owner-approval.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import { currentTurnSurfaceId } from '../security/turn-boundary.js';
import { isStateMutation } from '../gate/policy/state-policy.js';
import { buildDurableRuleForDecision, buildRememberOptions, commandClassOf, matchDurableRules } from './approval-rules.js';
import type { UserPermissionRuleStore } from './user-rule-store.js';
import { extractCommandArgs } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.js';
import { LayeredPolicyEvaluator } from '../runtime/permissions/evaluator.js';
import { exportDecisions } from '../runtime/permissions/decision-otlp.js';
import type { DecisionOtlpConfig } from '../runtime/permissions/decision-otlp.js';
import type { CommandClassification, PermissionDecision as LayeredPermissionDecision } from '../runtime/permissions/types.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import type { ConfigManager } from '../config/manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  GateBoundaryRecord,
  GateReadingRecord,
  PermissionCategory,
  PermissionCheckResult,
  PermissionDecisionReasonCode,
  PermissionDecisionSource,
  PermissionRequestAnalysis,
} from './types.js';
export type { PermissionMode } from '../config/schema.js';
export type {
  PermissionCategory,
  PermissionRiskLevel,
  PermissionDecisionSource,
  PermissionDecisionReasonCode,
  PermissionRequestAnalysis,
  PermissionCheckResult,
} from './types.js';

/**
 * The slice of config the permission layer reads, `.permissions` and nothing
 * else.
 *
 * `getConfigSnapshot` returns the whole `GoodVibesConfig`, and this alias used
 * to be exactly that, so `PermissionConfigReader` declared a dependency on
 * every config domain in the product while its two consumers (both in this
 * file) read `getSnapshot().permissions`. A stand-in reader had to produce all
 * fifty-odd domains to satisfy it. The real implementation avoids those
 * unrelated reads: `createPermissionConfigReader` uses the manager-owned
 * permission frame when available, with a full-snapshot fallback for readers
 * that only implement the legacy configuration interface.
 */
type PermissionConfigSnapshot = Readonly<Pick<ReturnType<typeof getConfigSnapshot>, 'permissions'>>;

export interface PermissionConfigReader {
  /** Coherent owner-held frame. Must read owned state without invoking observers or host callbacks. */
  getAutonomousSnapshot?(): Readonly<{ permissions: PermissionConfigSnapshot['permissions']; autoApprove: boolean; directory: string | null }>;
  isAutoApproveEnabled(): boolean;
  getSnapshot(): PermissionConfigSnapshot;
  getWorkingDirectory(): string | null;
  /**
   * The `telemetry.decisionOtlp*` keys, as the exporter's own config shape.
   *
   * A method of its own rather than three more domains on
   * {@link PermissionConfigSnapshot}, so the narrowing above survives: a
   * stand-in reader that does not care about decision export omits this and
   * exports nothing, which is also the shipped default.
   */
  getDecisionOtlpConfig?(): DecisionOtlpConfig;
}

/** Read the three `telemetry.decisionOtlp*` keys into the exporter's config. */
function readDecisionOtlpConfig(configManager: Pick<ConfigManager, 'get'>): DecisionOtlpConfig {
  const signal = configManager.get('telemetry.decisionOtlpSignal');
  return {
    enabled: configManager.get('telemetry.decisionOtlpEnabled') === true,
    endpoint: String(configManager.get('telemetry.decisionOtlpEndpoint') ?? ''),
    // A hand-edited settings file is the only way to get something outside the
    // enum here, and spans are the shape the key ships with.
    signal: signal === 'log' || signal === 'both' ? signal : 'span',
  };
}

export function createPermissionConfigReader(
  configManager: Pick<ConfigManager, 'get' | 'getRaw' | 'getWorkingDirectory'> & Partial<Pick<ConfigManager, 'getAutonomousPermissionSnapshot'>>,
): PermissionConfigReader {
  // Bind the construction-owned accessor, not its result. Every check still
  // copies current permission state; unrelated configuration domains need not
  // be cloned for each original-owner/runtime path in a captured read sweep.
  const permissionSnapshot = configManager.getAutonomousPermissionSnapshot?.bind(configManager);
  return {
    ...(permissionSnapshot ? { getAutonomousSnapshot: permissionSnapshot } : {}),
    isAutoApproveEnabled: () => isAutoApproveEnabled(configManager),
    getSnapshot: permissionSnapshot
      ? () => ({ permissions: permissionSnapshot().permissions })
      : () => getConfigSnapshot(configManager),
    getWorkingDirectory: () => configManager.getWorkingDirectory(),
    // Read per decision, not captured: switching export on is a live change.
    getDecisionOtlpConfig: () => readDecisionOtlpConfig(configManager),
  };
}

/** Maps tool names to permission categories and config tool keys. */
const TOOL_CATEGORIES: Record<string, PermissionCategory> = {
  read: 'read',
  find: 'read',
  fetch: 'read',
  analyze: 'read',
  inspect: 'read',
  state: 'read',
  registry: 'read',
  goodvibes_context: 'read',
  repo_map: 'read',
  context_accounting: 'read',
  // write, new tool names
  write: 'write',
  edit: 'write',
  goodvibes_settings: 'write',
  // execute, new tool name
  exec: 'execute',
  // delegate, new tool names
  agent: 'delegate',
  delegate: 'delegate',
  workflow: 'delegate',
  mcp: 'delegate',
};

/** Maps tool names to their key in PermissionsToolConfig. */
const TOOL_CONFIG_KEYS: Record<string, keyof PermissionsToolConfig> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  exec: 'exec',
  find: 'find',
  fetch: 'fetch',
  analyze: 'analyze',
  inspect: 'inspect',
  agent: 'agent',
  state: 'state',
  workflow: 'workflow',
  registry: 'registry',
  goodvibes_context: 'state',
  goodvibes_settings: 'write',
  delegate: 'delegate',
  mcp: 'mcp',
};

/** How the gate learns who is asking and what the turn has read. */
export interface GateOptions {
  /** Trusted host alternatives; never populated from model-authored executable prose. */
  readonly autonomousChoices?: ((sourceId: string) => AutonomousToolChoices) | undefined;
  /**
   * The surface the current turn's instruction came from (gate/surface-authority.ts);
   * defaults to the turn boundary's record (security/turn-boundary.ts).
   * Returning undefined means the owner gave the instruction directly.
   */
  readonly surfaceOf?: (() => string | undefined) | undefined;
  /** The untrusted-content ledger; the process ledger when absent. */
  readonly ledger?: UntrustedContentLedger | undefined;
}

/** Built-in tools that only read local state: the gate reads them with no Jev reading. */
const isKnownReadOnly = (toolName: string, category: PermissionCategory): boolean =>
  category === 'read' && toolName !== 'fetch' && TOOL_CATEGORIES[toolName] !== undefined;

const BOUNDARY_REASON: Readonly<Record<BoundaryCheckName, PermissionDecisionReasonCode>> = {
  'judgment-input': 'boundary_judgment_input',
  catastrophic: 'boundary_catastrophic',
  'surface-authority': 'boundary_surface_authority',
  'card-details': 'boundary_card_details',
  'outward-effect': 'boundary_outward_effect',
};


const boundaryRecord = (verdict: BoundaryVerdict): GateBoundaryRecord => ({
  passed: verdict.passed,
  ...(verdict.passed ? {} : { refusedBy: verdict.refusedBy }),
  checks: verdict.checks,
});

const readingRecord = (reading: GateReading): GateReadingRecord => ({
  family: reading.family,
  stakes: reading.stakes,
  facts: {
    mutates: reading.mutates,
    outward: reading.outward,
    secrets: reading.secrets,
    irreversible: reading.irreversible,
    beyondProject: reading.beyondProject,
    weakensSecurity: reading.weakensSecurity,
    obfuscated: reading.obfuscated,
  },
  uncertain: reading.uncertain,
});

/**
 * PermissionManager, the gate: the one path every tool call takes.
 *
 *   0. The local judgment-input boundary refuses inline protected material
 *      before hooks, request recording or any hosted reading.
 *   1. Jev reads the call (gate/reading.ts): a known read-only tool is asked
 *      only whether it touches secrets; any other call gets the side-effect,
 *      risk-family and boundary questions in parallel.
 *   2. The boundary (gate/boundary.ts) on that reading: catastrophic commands
 *      and card details (Jev), surface authority (the owner's declared
 *      surfaces) and the outward-effect check (Jev over the untrusted-content
 *      record). A refusal stands; an approvable one (card details uncertain,
 *      an outward call derived from untrusted text) is cleared only by the
 *      owner answering a prompt for that exact call (a single-use approval).
 *   3. The explicit owner opt-out (autoApprove) and explicit owner rules:
 *      user and managed policy rules, the custom preset's per-tool settings,
 *      remembered approvals (session and durable).
 *   4. Known read-only tools that do not touch secrets run.
 *   5. The active preset (gate/presets.ts, selected by `permissions.mode`)
 *      allows, asks or denies on the reading's stakes.
 *   6. An ask goes to the owner through the surface's approval prompt.
 */
export interface AutonomousPermissionAdmission {
  readonly result: PermissionCheckResult;
  readonly revision?: AutonomousToolRevision | undefined;
  readonly revisionIds: readonly string[];
  /** Call once, synchronously after the final reentrant hook and before the body. */
  claim(): void;
}

export interface AutonomousPermissionOptions extends PermissionExecutionOptions {
  readonly decoratePort?: ((port: JudgmentPort) => JudgmentPort) | undefined;
  /** Handle minted by this manager before any logical-call preparation. */
  readonly choiceProjection?: AutonomousChoiceProjection | undefined;
  readonly sourceOf: () => AutonomousToolSource;
  readonly consumedRevisions?: readonly string[];
  readonly permittedRevisionIds?: readonly string[];
  readonly schemaRevision?: string;
  readonly preparationDecisionIds?: readonly string[];
  readonly assertPrepared?: () => void;
}

export class PermissionManager {
  private readonly autonomousChoiceProjections = new AutonomousChoiceProjectionOwner();
  private readonly autonomousPending = new Set<string>();
  private readonly autonomousEpochs = new Map<string, number>();
  private readonly autonomousClaims = new Set<string>();
  private readonly autonomousDeferred = new Map<string, { readonly inputRevision: string; readonly until: JevVersionRef }>();
  /** Explicit session-tier decisions only; durable rules are always matched live. */
  private sessionApprovals = new Map<string, boolean>();
  private readonly requestPermission: PermissionRequestHandler;
  private readonly configReader: PermissionConfigReader;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>;
  private readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null;
  private readonly userRuleStore: Pick<UserPermissionRuleStore, 'rules' | 'add'> | null;
  private readonly gate: GateOptions;

  constructor(
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    configReader: PermissionConfigReader,
    policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
    featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null = null,
    userRuleStore: Pick<UserPermissionRuleStore, 'rules' | 'add'> | null = null,
    gate: GateOptions = {},
  ) {
    this.requestPermission = requestPermission;
    this.configReader = configReader;
    this.policyRuntimeState = policyRuntimeState;
    this.hookDispatcher = hookDispatcher;
    this.featureFlags = featureFlags;
    this.userRuleStore = userRuleStore;
    this.gate = { surfaceOf: currentTurnSurfaceId, ...gate };
  }

  private autonomousAuthority(sourceId: string, sourceOf: () => AutonomousToolSource, choiceProjection?: AutonomousChoiceProjection) {
    // Stage host callbacks first. The subsequent source/config/store copies are
    // owned data reads, not a sequence interleaving observers with sampled fields.
    const choices = this.gate.autonomousChoices?.(sourceId) ?? {};
    const surface = this.gate.surfaceOf?.();
    const source = sourceOf();
    const rules = this.userRuleStore?.rules() ?? [];
    const policyRules = this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? [];
    const policyEnabled = this.featureFlags?.isEnabled('permissions-policy-engine') === true;
    const exposure = (this.gate.ledger ?? getProcessUntrustedContentLedger()).ingestedThisTurn();
    const scope = this.configReader.getAutonomousSnapshot?.();
    if (!scope) throw new Error('Autonomous execution requires a coherent permission owner snapshot');
    assertAutonomousData(scope);
    const frame = { ...scope, source, surface, rules, policyRules, policyEnabled,
      sessionGrants: [...this.sessionApprovals], exposure };
    assertAutonomousData(choices);
    assertAutonomousData(frame);
    const capturedSource = captureAutonomousSource(source);
    const ownedFrame = snapshotJudgmentInput({ ...frame, source: autonomousSourceEvidence(capturedSource) }) as Record<string, unknown>;
    const captured = Object.freeze({ ...ownedFrame, source: capturedSource, autonomousChoices: captureAutonomousChoices(choices) });
    return choiceProjection === undefined ? captured : Object.freeze({ ...captured,
      autonomousChoices: this.autonomousChoiceProjections.choices(choiceProjection, sourceId, captured) });
  }

  /** Project the complete host catalog before initial preparation or admission. */
  async projectAutonomousChoices(sourceId: string, callId: string, sourceOf: () => AutonomousToolSource,
    registry: ToolRegistry, signal?: AbortSignal): Promise<AutonomousChoiceProjection> {
    assertPermissionActive(signal);
    if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
    return this.autonomousChoiceProjections.project(sourceId, callId, registry,
      () => this.autonomousAuthority(sourceId, sourceOf), signal);
  }

  /** Release every alternative after the entire logical call, including unused alternatives. */
  releaseAutonomousChoices(projection: AutonomousChoiceProjection): Promise<void> {
    return this.autonomousChoiceProjections.release(projection);
  }

  /** The same live authority owns pre-admission argument-repair judgment. */
  autonomousPreparation(sourceId: string, sourceOf: () => AutonomousToolSource, signal?: AbortSignal, decoratePort?: (port: JudgmentPort) => JudgmentPort, choiceProjection?: AutonomousChoiceProjection): { readonly port: JudgmentPort; assertCurrent(): void } {
    assertPermissionActive(signal);
    const revision = hashState(this.autonomousAuthority(sourceId, sourceOf, choiceProjection) as unknown as EntryType);
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.autonomousClaims.has(sourceId) || hashState(this.autonomousAuthority(sourceId, sourceOf, choiceProjection) as unknown as EntryType) !== revision)
        throw new Error('Autonomous preparation authority changed or source was claimed');
    };
    const base = judgmentPort('engine.gate.autonomous-preparation');
    const installed = decoratePort?.(base) ?? base;
    if (!installed.recorder) throw new JudgmentError('unrecorded', 'autonomous admission requires the recorded judgment port');
    const port: JudgmentPort = {
      get model() { return installed.model; },
      ...(installed.recorder ? { recorder: installed.recorder } : {}),
      ask(request) {
        assertCurrent();
        const prior = request.beforeAttempt;
        // A transport may ignore abort. Release the permission caller while
        // draining its late recorded answer; aborted authority cannot claim it.
        return awaitPermission(() => installed.ask({ ...request, beforeAttempt() { assertCurrent(); prior?.(); } }), signal);
      },
    };
    return { port, assertCurrent };
  }

  /**
   * The migrated orchestrator's admission path. A preset or stored grant is
   * context/authority, never a semantic substitute for the recorded Jev choice.
   * Legacy checkDetailed callers remain separately tracked for migration.
   */
  async admitAutonomous(
    sourceId: string,
    toolName: string,
    preparedArgs: Record<string, unknown>,
    options: AutonomousPermissionOptions,
  ): Promise<AutonomousPermissionAdmission> {
    assertPermissionActive(options.signal);
    if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
    if (this.autonomousPending.has(sourceId)) throw new Error('Autonomous admission is already pending for this source');
    if (!this.autonomousEpochs.has(sourceId) && this.autonomousEpochs.size >= 10_000) throw new Error('Autonomous source capacity reached');
    const epoch = (this.autonomousEpochs.get(sourceId) ?? 0) + 1;
    this.autonomousEpochs.set(sourceId, epoch);
    this.autonomousPending.add(sourceId);
    try { return await this.decideAutonomous(sourceId, toolName, preparedArgs, options, epoch); }
    finally { this.autonomousPending.delete(sourceId); }
  }

  private async decideAutonomous(sourceId: string, toolName: string, preparedArgs: Record<string, unknown>, options: AutonomousPermissionOptions, epoch: number): Promise<AutonomousPermissionAdmission> {
    const signal = options.signal;
    assertPermissionActive(signal);
    const args = snapshotJudgmentInput(preparedArgs, toolName) as Record<string, unknown>;
    const sourceOf = options.sourceOf;
    const choiceProjection = options.choiceProjection;
    const ledger = this.gate.ledger ?? getProcessUntrustedContentLedger();
    const authority = () => this.autonomousAuthority(sourceId, sourceOf, choiceProjection);
    const capturedAuthority = authority() as { source: AutonomousToolSource; autonomousChoices: AutonomousToolChoices; directory: string | null; permissions: PermissionConfigSnapshot['permissions'] };
    const source = capturedAuthority.source;
    const sourceRevision = hashState(source as unknown as EntryType);
    const authorityRevision = hashState(capturedAuthority as unknown as EntryType);
    const offered = (capturedAuthority as { autonomousChoices: AutonomousToolChoices }).autonomousChoices;
    const directory = capturedAuthority.directory ?? undefined;
    // Raw action/source/scope data was inspected above. Schema revisions and
    // source handles are typed protocol identities and retain that validation.
    const schemaRevision = options.schemaRevision;
    captureAutonomousChoices({ resumeConditions: [{ id: sourceId, revision: schemaRevision ?? 'unversioned-schema' }] });
    const inputRevision = hashState({ toolName, args, directory, schemaRevision, source } as unknown as EntryType);
    // A source condition is a typed protocol reference, not raw action text.
    // Keep its canonical identity intact: prefixing a generated SHA can make
    // an incidental digit run look like card material to the raw-input guard.
    const sourceCondition = captureAutonomousChoices({ resumeConditions: [{ id: sourceId, revision: inputRevision }] }).resumeConditions![0]!;
    const legacySourceConditionId = `source-${sourceId}`;
    let deferred = this.autonomousDeferred.get(sourceId);
    if (deferred?.inputRevision === inputRevision) {
      if (deferred.until.id === sourceCondition.id || deferred.until.id === legacySourceConditionId) throw new Error('Autonomous source is waiting for a new input revision');
      const waitingFor = deferred.until;
      const condition = offered.resumeConditions?.find(item => item.id === waitingFor.id);
      if (!condition || condition.revision === deferred.until.revision) throw new Error('Autonomous source is waiting for its registered condition');
    }
    // sourceId was inspected as protocol metadata above; toolName and args
    // passed raw-input inspection. Do not rescan the generated hash as text.
    const actionId = hashState({ sourceId, toolName });
    const binding: JevDecisionBinding = Object.freeze({
      sourceId, inputRevision, actionId, actionRevision: inputRevision,
      authorityId: 'engine.permission-runtime', authorityRevision,
      scopeId: autonomousRevision({ directory }), scopeRevision: authorityRevision,
    });
    const assertPrepared = options.assertPrepared;
    const assertCurrent = () => {
      assertPermissionActive(signal);
      if (this.autonomousEpochs.get(sourceId) !== epoch) throw new Error('Autonomous admission was superseded');
      const current = authority();
      assertPermissionActive(signal);
      if (hashState(current as unknown as EntryType) !== authorityRevision) throw new Error('Autonomous admission authority, source or scope changed');
      assertPrepared?.();
      if (this.autonomousClaims.has(sourceId)) throw new Error('Autonomous tool source was already claimed');
      const latestDeferral = this.autonomousDeferred.get(sourceId);
      if (latestDeferral && latestDeferral !== deferred) throw new Error('A concurrent admission deferred this source');
    };
    assertCurrent();
    const category = this.getCategory(toolName, args);
    let analysis = analyzePermissionRequest(toolName, args, category);
    this.policyRuntimeState.recordPermissionRequest({ callId: sourceId, tool: toolName, category, analysis });
    assertCurrent();
    const base = judgmentPort('engine.gate.autonomous-tool');
    const installed = options.decoratePort?.(base) ?? base;
    const supportingIds = [...(options.preparationDecisionIds ?? [])];
    const scopedPort: JudgmentPort = {
      get model() { return installed.model; },
      ...(installed.recorder ? { recorder: installed.recorder } : {}),
      async ask(request) {
        const prior = request.beforeAttempt;
        const result = await awaitPermission(() => installed.ask({ ...request, beforeAttempt() { prior?.(); assertCurrent(); } }), signal);
        assertCurrent();
        if (!result.decisionId) throw new JudgmentError('unrecorded', 'autonomous supporting read has no recorded provenance');
        supportingIds.push(result.decisionId);
        return result;
      },
    };
    const reading = await readToolCall({ toolName, args, workingDirectory: directory,
      askKind: TOOL_CATEGORIES[toolName] === undefined, askObfuscated: shellCommandsIn(args).length > 0,
      signal, port: scopedPort });
    assertCurrent();
    if (reading) analysis = withReading(analysis, reading, category);
    const boundary = await runBoundary({ toolName, args, reading, surfaceId: this.gate.surfaceOf?.(), ledger, signal, port: scopedPort });
    assertCurrent();
    const settings = toolName === 'goodvibes_settings' ? await readSettingsWriteEvidence(args, scopedPort, signal) : null;
    assertCurrent();
    if (settings && !settings.judgmentDecisionId) throw new Error('Settings evidence has no recorded judgment provenance');
    const permissions = capturedAuthority.permissions;
    const mode = permissions?.mode ?? 'prompt';
    const preset = presetForMode(mode);
    const explicitToolDeny = preset.perTool && TOOL_CONFIG_KEYS[toolName] !== undefined
      && permissions?.tools?.[TOOL_CONFIG_KEYS[toolName]!] === 'deny';
    const durable = this.rememberedDecision(this.getApprovalKey(toolName, args), toolName, args);
    const policy = this.featureFlags?.isEnabled('permissions-policy-engine') === true
      ? this.mapEvaluatorDecision(this.evaluateRuntimePolicy(toolName, args, mode, reading ? classificationFromReading(reading) : 'read'), analysis)
      : null;
    const allowAct = boundary.passed && !explicitToolDeny && durable?.approved !== false && policy?.approved !== false
      && !(preset.readOnly && reading !== null && (reading.mutates || reading.outward));
    if (offered.resumeConditions?.some(condition => condition.id === sourceCondition.id || condition.id === legacySourceConditionId)) throw new Error('Host condition conflicts with the source condition');
    const choices = {
      revisions: (offered.revisions ?? []).filter(item => !options.consumedRevisions?.includes(item.ref.id) && (!options.permittedRevisionIds || options.permittedRevisionIds.includes(item.ref.id))),
      // The manager owns this source revision condition. A changed source must
      // enter through fresh admission; this receipt never becomes a later grant.
      resumeConditions: [sourceCondition, ...(offered.resumeConditions ?? [])],
    };
    const decision = await decideAutonomousTool({
      port: scopedPort, binding,
      state: readingArguments({ tool: toolName, arguments: args, source: autonomousSourceEvidence(source), ...(directory ? { workingDirectory: directory } : {}),
        evidence: { boundary: boundaryRecord(boundary), ...(reading ? { reading: readingRecord(reading) } : {}),
          ...(settings ? { settings: { key: settings.key, hazard: settings.hazard.choice, hazardOutcome: settings.hazard.outcome,
            requested: settings.requested?.verdict ?? null, requestedOutcome: settings.requested?.outcome ?? null } } : {}),
          constraints: { allowAct, mode, explicitToolDeny: explicitToolDeny === true, durableEffect: durable?.approved ?? null } } }) as import('@goodvibes-jev/judgment').EntryType,
      evidence: [{ id: 'prepared-tool-input', revision: inputRevision }, { id: 'source-goal-and-criteria', revision: sourceRevision }, { id: 'live-authority', revision: authorityRevision }],
      supportingDecisionIds: [...supportingIds],
      choices, allowAct, assertCurrent, signal,
    });
    assertCurrent();
    const receipt = decision.decision;
    if (receipt.outcome === 'defer') {
      if (this.autonomousDeferred.size >= 10_000 && !this.autonomousDeferred.has(sourceId)) throw new Error('Autonomous deferral capacity reached');
      deferred = Object.freeze({ inputRevision, until: receipt.until });
      this.autonomousDeferred.set(sourceId, deferred);
    }
    const result = this.result(receipt.outcome === 'act', false, 'jev_decision', `jev_${receipt.outcome}`, analysis, {
      autonomousDecision: receipt, boundary: boundaryRecord(boundary),
      ...(reading ? { reading: readingRecord(reading) } : {}),
      detail: receipt.summary,
    });
    this.policyRuntimeState.recordPermissionDecision({ callId: sourceId, tool: toolName, category, result });
    assertCurrent();
    // The selector returns an inspected copy. Restore only the exact offered
    // registry-owned input so fresh preparation reuses its captured protection.
    const selectedRevision = decision.revision;
    const revision = selectedRevision ? offered.revisions?.find(item =>
      item.ref.id === selectedRevision.ref.id && item.ref.revision === selectedRevision.ref.revision
      && item.toolName === selectedRevision.toolName
      && hashState(item.args as EntryType) === hashState(selectedRevision.args as EntryType)) : undefined;
    if (selectedRevision && !revision) throw new Error('Autonomous selected revision is no longer offered');
    return {
      result, revisionIds: Object.freeze(decision.context.continuations.map(item => item.id)), ...(revision ? { revision } : {}),
      claim: () => {
        decision.assertCurrent();
        if (receipt.outcome !== 'act') throw new Error('Only a current Jev act decision can be claimed');
        if (this.autonomousClaims.size >= 10_000) throw new Error('Autonomous admission claim capacity reached');
        decision.recordClaim();
        assertCurrent();
        // No await or callback between the final check and the single-use claim.
        this.autonomousClaims.add(sourceId);
        this.autonomousDeferred.delete(sourceId);
      },
    };
  }

  /** Resolves to true when the gate approves the call. */
  async check(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution, options?: PermissionExecutionOptions): Promise<boolean> {
    const signal = options?.signal;
    const result = await this.checkDetailed(toolName, args, attribution, options);
    assertPermissionActive(signal);
    return result.approved;
  }

  /**
   * Runs one call through the gate.
   *
   * @param attribution When present, rides on the brokered ask so a surface can
   * render which background agent (or server, or sandbox) is asking.
   */
  async checkDetailed(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution, options?: PermissionExecutionOptions): Promise<PermissionCheckResult> {
    const signal = options?.signal;
    const owner = options?.hookOwner;
    const check = () => this.checkActive(toolName, args, attribution, signal, owner);
    // The cancellation race may release the permission caller, but the owning
    // turn still joins the actual check and any admitted hook/approval cleanup.
    return awaitPermission(() => owner ? owner.admit(check) : check(), signal);
  }

  private async checkActive(toolName: string, args: Record<string, unknown>, attribution: PermissionAttribution | undefined, signal?: AbortSignal, hookOwner?: TurnHookOwner): Promise<PermissionCheckResult> {
    assertPermissionActive(signal);
    const privacy = judgmentInputBoundary(toolName, args, this.configReader.getWorkingDirectory() ?? undefined);
    if (!privacy.passed) {
      // Do not build an argument preview, fire hooks or export request/decision
      // records from a refused input. Even the tool name is untrusted here.
      return this.result(false, false, 'boundary', 'boundary_judgment_input', {
        classification: 'protected-input', riskLevel: 'critical',
        summary: 'Protected input refused before judgment', reasons: [privacy.reason],
      }, { boundary: boundaryRecord(privacy), detail: privacy.reason });
    }
    let category = this.getCategory(toolName, args);
    let analysis = analyzePermissionRequest(toolName, args, category);
    const callId = crypto.randomUUID();
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', { callId, toolName, category, analysis }, hookOwner);
    assertPermissionActive(signal);
    this.policyRuntimeState.recordPermissionRequest({ callId, tool: toolName, category, analysis });
    const done = (result: PermissionCheckResult): PermissionCheckResult => { assertPermissionActive(signal); return this.emitAndReturn(callId, toolName, category, result, hookOwner); };
    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';
    const preset = presetForMode(mode);

    // 1. Jev reads the call (known read-only tools read only whether they touch secrets).
    const reading = await this.readCall(toolName, args, category, signal);
    assertPermissionActive(signal);
    if (reading !== null) {
      if (reading.kind !== undefined && TOOL_CATEGORIES[toolName] === undefined) category = categoryForSideEffectKind(reading.kind);
      analysis = withReading(analyzePermissionRequest(toolName, args, category), reading, category);
    }
    const read = reading === null ? {} : { reading: readingRecord(reading) };

    // 2. The boundary, on the reading.
    const boundary = await this.runGateBoundary(toolName, args, reading);
    assertPermissionActive(signal);
    if (!boundary.passed) {
      reading?.recordAction(`boundary:${boundary.refusedBy}`);
      return done({ ...(await this.boundaryOutcome(callId, toolName, args, category, analysis, boundary, reading, attribution, signal)), ...read });
    }
    const base = { boundary: boundaryRecord(boundary), ...read };

    // 3. The owner's explicit opt-out and explicit rules.
    if (this.configReader.isAutoApproveEnabled()) {
      return done(this.result(true, false, 'config_policy', 'config_allow', analysis, base));
    }
    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const mapped = this.mapEvaluatorDecision(this.evaluateRuntimePolicy(toolName, args, mode, reading === null ? 'read' : classificationFromReading(reading)), analysis);
      if (mapped) return done({ ...mapped, ...base });
    }
    let forceAsk = false;
    if (preset.perTool && TOOL_CONFIG_KEYS[toolName] !== undefined) {
      const action: PermissionAction = permsConfig?.tools?.[TOOL_CONFIG_KEYS[toolName]!] ?? 'prompt';
      if (action === 'allow') return done(this.result(true, false, 'config_policy', 'config_allow', analysis, base));
      if (action === 'deny') return done(this.result(false, false, 'config_policy', 'config_deny', analysis, base));
      forceAsk = true;
    }
    const key = this.getApprovalKey(toolName, args);
    const remembered = this.rememberedDecision(key, toolName, args);
    // Plan is read-only: a remembered allow does not carry a change into it.
    if (remembered && !(preset.readOnly && remembered.approved)) {
      return done(this.result(remembered.approved, true, remembered.source, remembered.reason, analysis, base));
    }

    // 4. A known read-only tool that touches no secrets runs.
    if (reading === null) {
      if (!forceAsk) return done(this.result(true, false, 'config_policy', 'config_allow', analysis, base));
      return done(await this.ask(callId, toolName, args, category, analysis, key, attribution, base, signal, hookOwner));
    }

    // 5. The preset decides on the stakes.
    const decision = decideByPreset(preset, {
      stakes: reading.stakes,
      family: reading.familyConfident ? reading.family : 'generic',
      changesState: reading.mutates || reading.outward,
    });
    const withPreset = { ...base, preset: { preset: preset.name, action: forceAsk ? 'ask' as const : decision.action } };
    reading.recordAction(`preset:${preset.name}:${withPreset.preset.action}`);
    if (!forceAsk && decision.action === 'allow') {
      return done(this.result(true, false, 'stakes_preset', 'preset_allow', analysis, withPreset));
    }
    if (!forceAsk && decision.action === 'deny') {
      const planned = decision.reason === 'plan-read-only';
      return done(this.result(false, false, planned ? 'runtime_mode' : 'stakes_preset', planned ? 'plan_mode' : 'preset_deny', analysis, withPreset));
    }

    // 6. Ask the owner.
    return done(await this.ask(callId, toolName, args, category, analysis, key, attribution, withPreset, signal, hookOwner));
  }

  /**
   * Jev's reading of a call. A built-in tool that only reads local state is
   * asked one question, whether it touches secret or credential material
   * (`secrets`); a no means it runs with no further reading (null). Every other
   * call gets the full reading: side effects, risk family and the boundary
   * questions.
   */
  private async readCall(toolName: string, args: Record<string, unknown>, category: PermissionCategory, signal?: AbortSignal): Promise<GateReading | null> {
    const workingDirectory = this.configReader.getWorkingDirectory() ?? undefined;
    if (isKnownReadOnly(toolName, category) && !(await readTouchesSecrets(toolName, args, workingDirectory, signal))) return null;
    return readToolCall({
      toolName,
      args,
      workingDirectory,
      ...(signal === undefined ? {} : { signal }),
      askKind: TOOL_CATEGORIES[toolName] === undefined,
      askObfuscated: shellCommandsIn(args).length > 0,
    });
  }

  /**
   * Whether the call passes the boundary. The background-agent escape hatch
   * uses it: exempt from presets and prompts, never from the boundary.
   */
  async passesBoundary(toolName: string, args: Record<string, unknown>, options?: PermissionExecutionOptions): Promise<boolean> {
    const signal = options?.signal;
    return awaitPermission(async () => {
      assertPermissionActive(signal);
      if (!judgmentInputBoundary(toolName, args, this.configReader.getWorkingDirectory() ?? undefined).passed) return false;
      const reading = await this.readCall(toolName, args, this.getCategory(toolName, args), signal);
      assertPermissionActive(signal);
      return (await this.runGateBoundary(toolName, args, reading)).passed;
    }, signal);
  }

  /** The boundary over one call, with this gate's surface and ledger. */
  private runGateBoundary(toolName: string, args: Record<string, unknown>, reading: GateReading | null, approval?: OwnerApproval | null): Promise<BoundaryVerdict> {
    return runBoundary({
      toolName,
      args,
      reading,
      surfaceId: this.gate.surfaceOf?.(),
      ledger: this.gate.ledger,
      ...(approval ? { approval } : {}),
    });
  }

  /**
   * A boundary refusal. It stands, except one marked approvable (an outward
   * call that may carry card details or may derive from untrusted text), which
   * the owner may clear by answering a prompt for this exact call: the answer
   * mints a single-use owner approval bound to the call's content, and the
   * boundary runs again with it.
   */
  private async boundaryOutcome(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    category: PermissionCategory,
    analysis: PermissionRequestAnalysis,
    verdict: Extract<BoundaryVerdict, { passed: false }>,
    reading: GateReading | null,
    attribution: PermissionAttribution | undefined,
    signal?: AbortSignal,
  ): Promise<PermissionCheckResult> {
    const detail = [verdict.reason, verdict.fix ?? ''].filter((part) => part.length > 0).join(' ');
    const refused = this.result(false, false, 'boundary', BOUNDARY_REASON[verdict.refusedBy], analysis, { boundary: boundaryRecord(verdict), detail });
    if (verdict.approvable === undefined) return refused;
    const decision = await this.requestPermission({
      callId,
      tool: toolName,
      args,
      category,
      analysis: { ...analysis, summary: `Outward call the owner must see: ${analysis.summary}`, reasons: [verdict.reason] },
      workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
      ...(attribution ? { attribution } : {}),
    }, { signal });
    assertPermissionActive(signal);
    const approved = decision.approved;
    assertPermissionActive(signal);
    if (!approved) return { ...refused, sourceLayer: 'user_prompt', reasonCode: 'user_denied', userReason: decision.reason };
    const approval = grantOwnerApproval({ action: verdict.approvable.action, surface: 'owner-direct', content: verdict.approvable.content });
    const cleared = await this.runGateBoundary(toolName, args, reading, approval);
    assertPermissionActive(signal);
    if (!cleared.passed) return refused;
    return this.result(true, false, 'user_prompt', 'owner_approved_outward', analysis, { boundary: boundaryRecord(cleared) });
  }

  /** Explicit session decisions, then current durable rules with their own scope. */
  private rememberedDecision(
    key: string,
    toolName: string,
    args: Record<string, unknown>,
  ): { approved: boolean; source: PermissionDecisionSource; reason: PermissionDecisionReasonCode } | null {
    if (this.sessionApprovals.has(key)) {
      const approved = this.sessionApprovals.get(key)!;
      return { approved, source: 'session_override', reason: approved ? 'session_cached_allow' : 'session_cached_deny' };
    }
    const durable = this.userRuleStore
      ? matchDurableRules(this.userRuleStore.rules(), toolName, args, { projectRoot: this.configReader.getWorkingDirectory() ?? undefined })
      : null;
    if (!durable) return null;
    const approved = durable.effect === 'allow';
    return { approved, source: 'user_rule', reason: approved ? 'user_rule_allow' : 'user_rule_deny' };
  }

  /** Asks the owner through the surface's prompt, and remembers the answer at the tier they chose. */
  private async ask(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    category: PermissionCategory,
    analysis: PermissionRequestAnalysis,
    key: string,
    attribution: PermissionAttribution | undefined,
    extra: Partial<PermissionCheckResult>,
    signal?: AbortSignal,
    hookOwner?: TurnHookOwner,
  ): Promise<PermissionCheckResult> {
    let decision: Awaited<ReturnType<PermissionRequestHandler>>;
    try {
      decision = await this.requestPermission({
        callId,
        tool: toolName,
        args,
        category,
        analysis,
        workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
        ...(attribution ? { attribution } : {}),
        rememberOptions: buildRememberOptions(toolName, args),
      }, { signal });
      assertPermissionActive(signal);
    } catch (error) {
      assertPermissionActive(signal);
      void this.fireHook('Fail:permission:request', 'Fail', 'permission', 'request', { callId, toolName, category, analysis, error: summarizeError(error) }, hookOwner);
      throw error;
    }
    // Project a borrowed decision before admitting any grant: evaluating a
    // getter may itself cancel the caller, even without an intervening await.
    const approved = decision.approved;
    const tier = decision.rememberTier ?? (decision.remember ? 'session' : undefined);
    const modifiedArgs = decision.modifiedArgs;
    const userReason = decision.reason;
    const rule = tier && tier !== 'session' && this.userRuleStore
      ? buildDurableRuleForDecision({ toolName, args, tier, effect: approved ? 'allow' : 'deny' })
      : null;
    assertPermissionActive(signal);
    let persisted = false;
    if (tier === 'session') {
      this.sessionApprovals.set(key, approved);
      persisted = true;
    } else if (rule && tier && this.userRuleStore) {
      // Never copy a durable decision into the session map: its key may be
      // broader than the chosen rule, and the rule can be revoked live.
      // Once admitted while active, this owned write is awaited rather than
      // rolled back if its caller later cancels during persistence.
      await this.userRuleStore.add({ rule, createdAt: Date.now(), tier, tool: toolName });
      persisted = true;
    }
    return {
      ...this.result(approved, persisted, 'user_prompt', approved ? 'user_approved' : 'user_denied', analysis, extra),
      modifiedArgs,
      userReason,
    };
  }

  /**
   * readAccess, the non-interactive answer to "would a `read` of `path` run
   * right now without asking?" Search, list and map tools call it for each file
   * they are about to surface, so their results never show content the read
   * tool itself would hold behind an ask. It follows the same gate: explicit
   * owner rules (the policy engine, the custom preset's read setting), then Jev's
   * reading of whether the read touches secrets; a read that does is high
   * stakes, surfaced only where the preset runs high-stakes calls. It never
   * prompts, caches decisions, records, or fires hooks.
   */
  async readAccess(rawPath: string): Promise<'allow' | 'restricted'> {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return 'allow';
    const args: Record<string, unknown> = { path: rawPath };
    if (!judgmentInputBoundary('read', args, this.configReader.getWorkingDirectory() ?? undefined).passed) return 'restricted';
    if (this.configReader.isAutoApproveEnabled()) return 'allow';
    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';
    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const mapped = this.mapEvaluatorDecision(this.evaluateRuntimePolicy('read', args, mode, 'read'), analyzePermissionRequest('read', args, 'read'));
      if (mapped) return mapped.approved ? 'allow' : 'restricted';
    }
    const preset = presetForMode(mode);
    if (preset.perTool) {
      // A read the custom preset would ask about cannot be asked mid-search.
      return (permsConfig?.tools?.[TOOL_CONFIG_KEYS['read']!] ?? 'prompt') === 'allow' ? 'allow' : 'restricted';
    }
    if (!(await readTouchesSecrets('read', args, this.configReader.getWorkingDirectory() ?? undefined))) return 'allow';
    return preset.stakes.high === 'allow' ? 'allow' : 'restricted';
  }

  /**
   * getMode, Returns the active session permission mode from config.
   * Surfaces (mode pill) and the orchestrator's standing plan-mode instruction
   * read this to reflect the current mode. Defaults to 'prompt' ("normal").
   */
  getMode(): PermissionMode {
    return this.configReader.getSnapshot().permissions?.mode ?? 'prompt';
  }

  /** The gate preset the current `permissions.mode` selects. */
  getPreset(): GatePreset {
    return presetForMode(this.getMode());
  }

  /**
   * getBackgroundAgentsMode, how background/subagent tool calls consult this
   * manager. 'inherit' (default): apply the session mode exactly like foreground.
   * 'allow-all': background agents are exempt (auto-approve). Read by the agent
   * runner before it gates a background tool call.
   */
  getBackgroundAgentsMode(): BackgroundAgentsMode {
    return this.configReader.getSnapshot().permissions?.backgroundAgents ?? 'inherit';
  }

  /** Returns the permission category for a tool name. Unknown tools default to 'delegate'. */
  getCategory(toolName: string, args: Record<string, unknown> = {}): PermissionCategory {
    if (toolName === 'inspect' && args.mode === 'scaffold' && args.dryRun === false) {
      return 'write';
    }
    // A state call that writes (a value, a memory, a hook registration, a mode
    // change) is not the read the state tool's category names: it gets the
    // gate's full reading. The state tool's own read-only surface decides.
    if (toolName === 'state' && isStateMutation(args)) return 'write';
    return TOOL_CATEGORIES[toolName] ?? 'delegate';
  }

  /**
   * getApprovalKey - Stable key for session-level "always approve" decisions.
   * Includes the most meaningful argument to distinguish different invocations.
   */
  private getApprovalKey(toolName: string, args: Record<string, unknown>): string {
    // exec: key by command CLASS (git, npm, ...) so a remembered decision
    // covers the class, not one unique command string. edit/write: key by the
    // set of touched paths so one path's approval never blankets the tool.
    const commands = extractCommandArgs(args);
    if (toolName === 'exec' && commands.length > 0) {
      const classes = [...new Set(commands.map(commandClassOf).filter((cls) => cls.length > 0))].sort();
      if (classes.length > 0) return `${toolName}:class:${classes.join('+')}`;
    }
    const paths = extractPathArgs(args);
    if (paths.length > 0) {
      return `${toolName}:path:${[...new Set(paths)].sort().join('|')}`;
    }
    if (typeof args['command'] === 'string') {
      return `${toolName}:${args['command']}`;
    }
    // Generic key: tool name only ("always allow this tool").
    return toolName;
  }

  private result(
    approved: boolean,
    persisted: boolean,
    sourceLayer: PermissionDecisionSource,
    reasonCode: PermissionDecisionReasonCode,
    analysis: PermissionRequestAnalysis,
    extra: Partial<PermissionCheckResult> = {},
  ): PermissionCheckResult {
    return { ...extra, approved, persisted, sourceLayer, reasonCode, analysis };
  }

  private evaluateRuntimePolicy(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionConfigSnapshot['permissions']['mode'],
    classification: CommandClassification,
  ): LayeredPermissionDecision {
    // User-origin rules are evaluated before managed (registry) rules by the
    // evaluator, so a user allow-rule wins over a managed one.
    const rules = [
      ...(this.userRuleStore?.rules() ?? []),
      ...(this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? []),
    ];
    const evaluator = new LayeredPolicyEvaluator({
      mode:
        mode === 'allow-all' ? 'allow-all'
        : mode === 'custom' ? 'custom'
        : mode === 'plan' ? 'plan'
        : mode === 'accept-edits' ? 'accept-edits'
        : 'default',
      projectRoot: this.configReader.getWorkingDirectory() ?? undefined,
      rules,
      defaultEffect: 'deny',
    });
    const decision = evaluator.evaluate(toolName, args, classification);
    this.exportDecisionRecords(evaluator, mode);
    return decision;
  }

  /**
   * Hand this evaluation's decision-log records to the OTLP exporter.
   *
   * `runtime/permissions/decision-otlp.ts` was fully built, attribute mapping,
   * both record shapes, the POST, the off-by-default guards, and called from
   * nowhere, so `telemetry.decisionOtlpEnabled` promised an export that could
   * not happen. This is the seam where a decision comes into existence: the
   * evaluator is constructed per evaluation, so its log holds exactly the
   * records this call produced.
   *
   * Fire-and-forget, and deliberately so. `exportDecisions` never throws and
   * reports its own failures, and a permission decision must not wait on a
   * collector: an unreachable endpoint would otherwise stall every tool call.
   * One record per request rather than a batch, because a batch would mean
   * holding decisions back from a collector to save round trips on a path that
   * is off unless an operator asked for it.
   */
  private exportDecisionRecords(
    evaluator: LayeredPolicyEvaluator,
    mode: PermissionConfigSnapshot['permissions']['mode'],
  ): void {
    const config = this.configReader.getDecisionOtlpConfig?.();
    if (!config?.enabled || !config.endpoint.trim()) return;
    void exportDecisions(evaluator.log.query(), config, { mode: mode ?? 'prompt' })
      .catch((error: unknown) => {
        logger.warn('decision OTLP export failed', { error: summarizeError(error) });
      });
  }

  /**
   * The policy-as-code evaluator's decision, where it is an explicit rule: a
   * user or managed policy rule. Its mode layer is not consulted; the presets
   * decide on Jev's reading instead.
   */
  private mapEvaluatorDecision(
    decision: LayeredPermissionDecision,
    analysis: PermissionRequestAnalysis,
  ): PermissionCheckResult | null {
    if (decision.sourceLayer === 'policy') {
      return decision.allowed
        ? this.result(true, false, 'managed_policy', 'managed_policy_allow', analysis)
        : this.result(false, false, 'managed_policy', 'managed_policy_deny', analysis);
    }
    return null;
  }

  private emitAndReturn(
    callId: string,
    toolName: string,
    category: PermissionCategory,
    result: PermissionCheckResult,
    hookOwner?: TurnHookOwner,
  ): PermissionCheckResult {
    this.policyRuntimeState.recordPermissionDecision({
      callId,
      tool: toolName,
      category,
      result,
    });
    void this.fireHook('Post:permission:decision', 'Post', 'permission', 'decision', {
      callId,
      toolName,
      category,
      approved: result.approved,
      persisted: result.persisted,
      sourceLayer: result.sourceLayer,
      reasonCode: result.reasonCode,
      riskLevel: result.analysis.riskLevel,
      classification: result.analysis.classification,
      riskFamily: result.reading?.family,
      stakes: result.reading?.stakes,
      preset: result.preset?.preset,
      boundaryRefusedBy: result.boundary?.refusedBy,
    }, hookOwner);
    return { ...result, category };
  }

  private async fireHook(
    path: HookEventPath,
    phase: HookPhase,
    category: HookCategory,
    specific: string,
    payload: Record<string, unknown>,
    hookOwner?: TurnHookOwner,
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await bindTurnHookDispatcher(this.hookDispatcher, hookOwner ?? null)!.fire({
        path,
        phase,
        category,
        specific,
        sessionId: hookOwner?.sessionId ?? 'permissions',
        timestamp: Date.now(),
        payload,
      });
    } catch (error) {
      // Permission hooks are observability-only. Dispatch failures are logged
      // but do not alter permission decisions or prompt flow.
      logger.warn('PermissionManager: permission hook dispatch failed', {
        path,
        callId: typeof payload['callId'] === 'string' ? payload['callId'] : undefined,
        error: summarizeError(error),
      });
    }
  }
}
