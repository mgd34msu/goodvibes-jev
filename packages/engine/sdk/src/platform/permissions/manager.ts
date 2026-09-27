import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.js';
import type { PermissionAction, PermissionsToolConfig, PermissionMode, BackgroundAgentsMode } from '../config/schema.js';
import type { PermissionAttribution, PermissionRequestHandler } from './prompt.js';
import { analyzePermissionRequest, withReading } from './analysis.js';
import { isOutwardByCode, runBoundary, type BoundaryCheckName, type BoundaryVerdict } from '../gate/boundary.js';
import { decideByPreset, presetForMode, type GatePreset } from '../gate/presets.js';
import { categoryForSideEffectKind, readToolCall, type GateReading } from '../gate/reading.js';
import { grantOwnerApproval, type OwnerApproval } from '../security/owner-approval.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';
import { currentTurnSurfaceId } from '../security/turn-boundary.js';
import { buildDurableRuleForDecision, buildRememberOptions, commandClassOf, matchDurableRules } from './approval-rules.js';
import type { UserPermissionRuleStore } from './user-rule-store.js';
import { extractCommandArgs } from '../runtime/permissions/rules/prefix.js';
import { extractPathArgs } from '../runtime/permissions/rules/path-scope.js';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.js';
import { LayeredPolicyEvaluator } from '../runtime/permissions/evaluator.js';
import { exportDecisions } from '../runtime/permissions/decision-otlp.js';
import type { DecisionOtlpConfig } from '../runtime/permissions/decision-otlp.js';
import type { PermissionDecision as LayeredPermissionDecision } from '../runtime/permissions/types.js';
import {
  SHIPPED_CREDENTIAL_READ_RULES,
  matchesShippedCredentialReadPath,
} from './credential-read-defaults.js';
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
 * fifty-odd domains to satisfy it. Narrowing costs the real implementation
 * nothing: `createPermissionConfigReader` still hands back the full snapshot,
 * which remains assignable.
 */
type PermissionConfigSnapshot = Readonly<Pick<ReturnType<typeof getConfigSnapshot>, 'permissions'>>;

export interface PermissionConfigReader {
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
  configManager: Pick<ConfigManager, 'get' | 'getRaw' | 'getWorkingDirectory'>,
): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => isAutoApproveEnabled(configManager),
    getSnapshot: () => getConfigSnapshot(configManager),
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
  catastrophic: 'boundary_catastrophic',
  'surface-authority': 'boundary_surface_authority',
  'card-shapes': 'boundary_card_shapes',
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
  },
  uncertain: reading.uncertain,
});

/**
 * PermissionManager, the gate: the one path every tool call takes.
 *
 *   1. The deterministic boundary (gate/boundary.ts): catastrophic commands,
 *      surface authority, card shapes and the outward-effect check. A refusal
 *      stands; a tainted outward call can only be cleared by the owner
 *      answering a prompt for that exact call (a single-use owner approval).
 *   2. The explicit owner opt-out (autoApprove) and explicit owner rules:
 *      user and managed policy rules, the custom preset's per-tool settings,
 *      remembered approvals (session and durable).
 *   3. Known read-only tools run (credential-store reads still ask).
 *   4. Jev reads the call's stakes (gate/reading.ts), and the active preset
 *      (gate/presets.ts, selected by `permissions.mode`) allows, asks or denies.
 *   5. An ask goes to the owner through the surface's approval prompt.
 */
export class PermissionManager {
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

  /** Resolves to true when the gate approves the call. */
  async check(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution): Promise<boolean> {
    const result = await this.checkDetailed(toolName, args, attribution);
    return result.approved;
  }

  /**
   * Runs one call through the gate.
   *
   * @param attribution When present, rides on the brokered ask so a surface can
   * render which background agent (or server, or sandbox) is asking.
   */
  async checkDetailed(toolName: string, args: Record<string, unknown>, attribution?: PermissionAttribution): Promise<PermissionCheckResult> {
    let category = this.getCategory(toolName, args);
    let analysis = analyzePermissionRequest(toolName, args, category);
    const callId = crypto.randomUUID();
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', { callId, toolName, category, analysis });
    this.policyRuntimeState.recordPermissionRequest({ callId, tool: toolName, category, analysis });
    const done = (result: PermissionCheckResult): PermissionCheckResult => this.emitAndReturn(callId, toolName, category, result);

    // 1. The deterministic boundary.
    const outwardByCode = isOutwardByCode(toolName, args);
    let boundary = this.runGateBoundary(toolName, args, category, outwardByCode);
    if (!boundary.passed) {
      return done(await this.boundaryOutcome(callId, toolName, args, category, analysis, boundary, attribution));
    }
    const base = { boundary: boundaryRecord(boundary) };

    // 2. The owner's explicit opt-out and explicit rules.
    if (this.configReader.isAutoApproveEnabled()) {
      return done(this.result(true, false, 'config_policy', 'config_allow', analysis, base));
    }
    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';
    const preset = presetForMode(mode);

    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const mapped = this.mapEvaluatorDecision(this.evaluateRuntimePolicy(toolName, args, mode), analysis);
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

    // 3. Known read-only tools run; a credential-store read (the shipped
    //    default list) is read by Jev like any side-effecting call.
    if (!forceAsk && isKnownReadOnly(toolName, category) && !this.isGatedCredentialRead(category, args)) {
      return done(this.result(true, false, 'config_policy', 'config_allow', analysis, base));
    }

    // 4. Jev reads the call; the preset decides.
    const reading = await readToolCall({
      toolName,
      args,
      workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
      askKind: TOOL_CATEGORIES[toolName] === undefined,
    });
    if (reading.kind !== undefined && TOOL_CATEGORIES[toolName] === undefined) category = categoryForSideEffectKind(reading.kind);
    analysis = withReading(analyzePermissionRequest(toolName, args, category), reading, category);
    const read = { ...base, reading: readingRecord(reading) };

    if (reading.outward && !outwardByCode) {
      boundary = this.runGateBoundary(toolName, args, category, true);
      if (!boundary.passed) {
        reading.recordAction('boundary-refused');
        return done({ ...(await this.boundaryOutcome(callId, toolName, args, category, analysis, boundary, attribution)), reading: read.reading });
      }
      read.boundary = boundaryRecord(boundary);
    }

    const decision = decideByPreset(preset, {
      stakes: reading.stakes,
      family: reading.familyConfident ? reading.family : 'generic',
      changesState: reading.mutates || reading.outward,
    });
    const withPreset = { ...read, preset: { preset: preset.name, action: forceAsk ? 'ask' as const : decision.action } };
    reading.recordAction(`preset:${preset.name}:${withPreset.preset.action}`);
    if (!forceAsk && decision.action === 'allow') {
      return done(this.result(true, false, 'stakes_preset', 'preset_allow', analysis, withPreset));
    }
    if (!forceAsk && decision.action === 'deny') {
      const planned = decision.reason === 'plan-read-only';
      return done(this.result(false, false, planned ? 'runtime_mode' : 'stakes_preset', planned ? 'plan_mode' : 'preset_deny', analysis, withPreset));
    }

    // 5. Ask the owner.
    return done(await this.ask(callId, toolName, args, category, analysis, key, attribution, withPreset));
  }

  /**
   * Whether the call passes the deterministic boundary, judged by code alone.
   * The background-agent escape hatch uses it: exempt from presets and
   * prompts, never from the boundary.
   */
  passesBoundary(toolName: string, args: Record<string, unknown>): boolean {
    return this.runGateBoundary(toolName, args, this.getCategory(toolName, args), isOutwardByCode(toolName, args)).passed;
  }

  /** The boundary over one call, with this gate's surface and ledger. */
  private runGateBoundary(toolName: string, args: Record<string, unknown>, category: PermissionCategory, outward: boolean, approval?: OwnerApproval | null): BoundaryVerdict {
    return runBoundary({
      toolName,
      args,
      category,
      outward,
      surfaceId: this.gate.surfaceOf?.(),
      ledger: this.gate.ledger,
      ...(approval ? { approval } : {}),
    });
  }

  /**
   * A boundary refusal. Every check's refusal stands, except a tainted outward
   * call, which the owner may clear by answering a prompt for this exact call:
   * the answer mints a single-use owner approval bound to the call's content,
   * and the outward check is run again with it.
   */
  private async boundaryOutcome(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    category: PermissionCategory,
    analysis: PermissionRequestAnalysis,
    verdict: Extract<BoundaryVerdict, { passed: false }>,
    attribution: PermissionAttribution | undefined,
  ): Promise<PermissionCheckResult> {
    const detail = [verdict.reason, verdict.fix ?? ''].filter((part) => part.length > 0).join(' ');
    const refused = this.result(false, false, 'boundary', BOUNDARY_REASON[verdict.refusedBy], analysis, { boundary: boundaryRecord(verdict), detail });
    if (verdict.approvable === undefined) return refused;
    const decision = await this.requestPermission({
      callId,
      tool: toolName,
      args,
      category,
      analysis: { ...analysis, summary: `Outward call after untrusted content: ${analysis.summary}`, reasons: [verdict.reason] },
      workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
      ...(attribution ? { attribution } : {}),
    });
    if (!decision.approved) return { ...refused, sourceLayer: 'user_prompt', reasonCode: 'user_denied', userReason: decision.reason };
    const approval = grantOwnerApproval({ action: verdict.approvable.action, surface: 'owner-direct', content: verdict.approvable.content });
    const cleared = this.runGateBoundary(toolName, args, category, true, approval);
    if (!cleared.passed) return refused;
    return this.result(true, false, 'user_prompt', 'owner_approved_outward', analysis, { boundary: boundaryRecord(cleared) });
  }

  /** A remembered decision for this call: the session cache, then the durable rules. */
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
    this.sessionApprovals.set(key, durable.effect === 'allow');
    return { approved: durable.effect === 'allow', source: 'user_rule', reason: durable.effect === 'allow' ? 'user_rule_allow' : 'user_rule_deny' };
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
      });
    } catch (error) {
      void this.fireHook('Fail:permission:request', 'Fail', 'permission', 'request', { callId, toolName, category, analysis, error: summarizeError(error) });
      throw error;
    }
    const tier = decision.rememberTier ?? (decision.remember ? 'session' : undefined);
    if (tier) {
      this.sessionApprovals.set(key, decision.approved);
      if (tier !== 'session' && this.userRuleStore) {
        const rule = buildDurableRuleForDecision({ toolName, args, tier, effect: decision.approved ? 'allow' : 'deny' });
        if (rule) {
          // Await: the grant must be durable before the call proceeds.
          await this.userRuleStore.add({ rule, createdAt: Date.now(), tier, tool: toolName });
        }
      }
    }
    return {
      ...this.result(decision.approved, Boolean(tier), 'user_prompt', decision.approved ? 'user_approved' : 'user_denied', analysis, extra),
      modifiedArgs: decision.modifiedArgs,
      userReason: decision.reason,
    };
  }

  /**
   * previewReadAccess, non-interactive answer to "would a `read` of `path` be
   * auto-allowed right now, WITHOUT prompting?" Returns 'allow' when it would be
   * auto-allowed and 'restricted' otherwise (a would-prompt/ask path or an
   * outright deny). Search / list / map tools call this per candidate file so
   * their results never surface CONTENT the read tool itself would gate behind
   * an ask/deny (e.g. the shipped credential-read defaults).
   *
   * It runs the SAME layered decision as {@link checkDetailed} up to the ask
   * boundary, the same mode logic, the same isGatedCredentialRead check (→
   * matchesShippedCredentialReadPath), and the same policy evaluator + mapping,
   * so it can never drift from a parallel path matcher. It never prompts, caches,
   * records, or fires hooks; it is a pure read of current config + rules.
   */
  previewReadAccess(rawPath: string): 'allow' | 'restricted' {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return 'allow';
    const category: PermissionCategory = 'read';
    const args: Record<string, unknown> = { path: rawPath };
    if (this.configReader.isAutoApproveEnabled()) return 'allow';

    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';
    if (this.featureFlags?.isEnabled('permissions-policy-engine') === true) {
      const mapped = this.mapEvaluatorDecision(this.evaluateRuntimePolicy('read', args, mode), analyzePermissionRequest('read', args, category));
      if (mapped) return mapped.approved ? 'allow' : 'restricted';
    }
    if (presetForMode(mode).perTool) {
      // A read the custom preset would ask about cannot be asked mid-search.
      return (permsConfig?.tools?.[TOOL_CONFIG_KEYS['read']!] ?? 'prompt') === 'allow' ? 'allow' : 'restricted';
    }
    // Every other preset runs reads. A credential-store read touches secrets,
    // which the stakes rule puts at high stakes at least; it is surfaced only
    // where the preset runs high-stakes calls without asking.
    if (!this.isGatedCredentialRead(category, args)) return 'allow';
    return presetForMode(mode).stakes.high === 'allow' ? 'allow' : 'restricted';
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

  /**
   * A read whose path names a well-known credential store, which the shipped
   * default protects: it must not be SILENTLY auto-allowed. Returns false for
   * non-read categories and for paths that do not match a credential store. A
   * user can still override by approving (session cache), switching to allow-all,
   * or adding a user allow-rule.
   */
  private isGatedCredentialRead(
    category: PermissionCategory,
    args: Record<string, unknown>,
  ): boolean {
    if (category !== 'read') return false;
    const rawPath =
      typeof args['path'] === 'string' ? args['path']
      : typeof args['file_path'] === 'string' ? args['file_path']
      : typeof args['file'] === 'string' ? args['file']
      : typeof args['target'] === 'string' ? args['target']
      : null;
    if (rawPath === null) return false;
    return matchesShippedCredentialReadPath(rawPath, {
      projectRoot: this.configReader.getWorkingDirectory() ?? undefined,
    }).matched;
  }

  private evaluateRuntimePolicy(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionConfigSnapshot['permissions']['mode'],
  ): LayeredPermissionDecision {
    // Shipped managed credential-read deny rules are appended AFTER the
    // registry's rules. User-origin rules are evaluated before managed rules by
    // the evaluator, so a user allow-rule still wins over these defaults.
    const rules = [
      ...(this.userRuleStore?.rules() ?? []),
      ...(this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? []),
      ...SHIPPED_CREDENTIAL_READ_RULES,
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
    const decision = evaluator.evaluate(toolName, args);
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
   * user or managed policy rule, or the safety layer's refusal. Its mode layer
   * is not consulted; the presets decide on Jev's reading instead.
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
    if (decision.sourceLayer === 'safety' && !decision.allowed) {
      return this.result(false, false, 'safety_check', 'safety_guardrail', analysis);
    }
    return null;
  }

  private emitAndReturn(
    callId: string,
    toolName: string,
    category: PermissionCategory,
    result: PermissionCheckResult,
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
    });
    return result;
  }

  private async fireHook(
    path: HookEventPath,
    phase: HookPhase,
    category: HookCategory,
    specific: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await this.hookDispatcher.fire({
        path,
        phase,
        category,
        specific,
        sessionId: 'permissions',
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
