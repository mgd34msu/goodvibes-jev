import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
/**
 * Shared permission composition for client and daemon graphs: durable owner
 * rules, PermissionManager, sandbox escalation and owned tool sub-operations.
 * Canonical localhost/PTY callbacks carry the recorded autonomous owner and
 * explicit workspace constraint. Sandbox escalations carry a final-spawn permit.
 * The broker callback remains for compatibility APIs outside autonomous calls.
 */

import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ConfigManager } from '../../config/manager.js';
import type { PermissionPromptDecision } from '../../permissions/prompt.js';
import { PermissionManager, createPermissionConfigReader } from '../../permissions/manager.js';
import { UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import type { HookDispatcher } from '../../hooks/index.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import {
  createSandboxContainmentAnnouncer,
  type FeatureAnnouncementStore,
} from '../feature-announcements.js';
import { PolicyRuntimeState } from './policy-runtime.js';
import { loadConfiguredPolicyBundle } from './policy-config-loader.js';
import { buildSandboxEscalationHandler, type ExecSandboxEscalationHandler } from './sandbox-escalation-wiring.js';
import { buildExecPromptAnswerHandler, type ExecPromptAnswerHandler } from './exec-prompt-wiring.js';
import { buildLocalhostFetchApproval, type LocalhostFetchApproval } from './localhost-fetch-approval.js';

/**
 * Raise an approval ask and wait for the decision.
 *
 * The one seam that separates an embedded composition from a client one: a
 * daemon-grade graph passes its `ApprovalBroker.requestApproval`; a pure client
 * passes a function that posts the ask to the daemon (`approvals.raise`) while
 * prompting on this surface.
 */
export type ApprovalRaiser = (input: {
  readonly request: import('../../permissions/prompt.js').PermissionPromptRequest;
  /** In-process cancellation, excluded from persisted/wire request data. */
  readonly signal?: AbortSignal | undefined;
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}) => Promise<PermissionPromptDecision>;

/**
 * The slice of the durable rule store a permission manager actually uses:
 * read the remembered rules, add a newly remembered one. Typed as this rather
 * than the concrete `UserPermissionRuleStore` so a surface can remember its own
 * approvals locally while the daemon keeps the canonical `permissions.rules.*`
 * store, the two are the same contract, and neither has to be the other.
 */
export type UserPermissionRuleAccess = Pick<UserPermissionRuleStore, 'rules' | 'add'>
  & Partial<Pick<UserPermissionRuleStore, 'init' | 'awaitReady' | 'getPublicationRevision'>>;

/**
 * Build the durable user-origin permission-rule store at the control-plane
 * config dir, initialising in the background. Init failure is deliberately
 * non-fatal: asks then prompt instead of matching a remembered rule.
 */
export function createUserPermissionRuleStore(
  configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>,
): UserPermissionRuleStore {
  const store = new UserPermissionRuleStore(join(configManager.getControlPlaneConfigDir(), 'permission-rules.json'));
  void store.init().catch((error) => logger.warn('user permission rule store init failed; asks will prompt', { error: summarizeError(error) }));
  return store;
}

/** Build the policy runtime state and load whatever bundle config names. */
export function createPolicyRuntimeState(
  configManager: ConfigManager,
  featureFlags: FeatureFlagManager,
): PolicyRuntimeState {
  const policyRuntimeState = new PolicyRuntimeState();
  loadConfiguredPolicyBundle(configManager, featureFlags, policyRuntimeState);
  return policyRuntimeState;
}

export interface BrokeredPermissionManagerOptions {
  readonly workspaceTrust?: AutonomousToolPromptHost['workspaceTrust'];
  readonly requestApproval: ApprovalRaiser;
  readonly configManager: ConfigManager;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly hookDispatcher: HookDispatcher;
  readonly featureFlags: FeatureFlagManager;
  readonly userRuleStore: UserPermissionRuleAccess | null;
}

/**
 * A permission manager whose asks ride the given seam.
 *
 * Background/subagent tool calls are brokered through the SAME session
 * permission mode as the foreground turn loop, so a background ask surfaces
 * through the same blocked-on-user machinery, here carrying the subagent's
 * attribution. The escape hatch (config `permissions.backgroundAgents:
 * 'allow-all'`) exempts background agents.
 */
export function createBrokeredPermissionManager(options: BrokeredPermissionManagerOptions): PermissionManager {
  return new PermissionManager(
    (request, execution) => options.requestApproval({
      request,
      ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
      ...(request.attribution?.kind === 'background-agent'
        ? {
            routeId: request.attribution.agentId,
            metadata: {
              source: 'background-agent',
              agentId: request.attribution.agentId,
              ...(request.attribution.template ? { agentTemplate: request.attribution.template } : {}),
            },
          }
        : {}),
    }),
    createPermissionConfigReader(options.configManager),
    options.policyRuntimeState,
    options.hookDispatcher,
    options.featureFlags,
    options.userRuleStore,
    { workspaceTrust: options.workspaceTrust },
  );
}

export interface ApprovalDerivedHandlerOptions {
  readonly autonomousHost?: AutonomousToolPromptHost | undefined;
  readonly requestApproval: ApprovalRaiser;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  /** Announce-once store backing the containment receipt. */
  readonly announcementStore: Pick<FeatureAnnouncementStore, 'record'>;
}

/** The handlers that must ride the same ask seam as a tool permission. */
export interface ApprovalDerivedHandlers {
  readonly sandboxEscalationHandler: ExecSandboxEscalationHandler;
  readonly execPromptAnswerHandler: ExecPromptAnswerHandler;
  readonly localhostFetchApproval: LocalhostFetchApproval;
  readonly onSandboxedRun: () => void;
}

export function createApprovalDerivedHandlers(options: ApprovalDerivedHandlerOptions): ApprovalDerivedHandlers {
  // The same recorded owner admits exact sandbox plans; final spawn consumes
  // the permit without widening argv, network, or filesystem containment.
  const sandboxEscalationHandler = buildSandboxEscalationHandler({
    autonomousHost: options.autonomousHost,
    requestApproval: options.requestApproval,
    configManager: options.configManager,
    featureFlags: options.featureFlags,
  });
  // An exec command blocked on a terminal prompt (host-key confirmation,
  // credential ask) rides the same seam: the pending prompt surfaces through
  // every surface's approval machinery and the typed answer feeds the same
  // continuing run.
  const execPromptAnswerHandler = buildExecPromptAnswerHandler({
    autonomousHost: options.autonomousHost,
    requestApproval: options.requestApproval,
  });
  // Localhost dev-server fetches ride the same seam: ask once, one-tap
  // "allow for this project", persisted as fetch.allowLocalhost.
  const localhostFetchApproval = buildLocalhostFetchApproval({
    autonomousHost: options.autonomousHost,
    requestApproval: options.requestApproval,
    configManager: options.configManager,
  });
  // Announce-once receipts for default-on features: the first contained exec
  // run yields the one-time containment line (persisted, once per install).
  const onSandboxedRun = createSandboxContainmentAnnouncer(options.announcementStore, (announcement) => {
    logger.info(announcement.text, { announcement: announcement.id });
  });
  return { sandboxEscalationHandler, execPromptAnswerHandler, localhostFetchApproval, onSandboxedRun };
}
