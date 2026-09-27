/**
 * sandbox-escalation-wiring.ts, compose the sandbox-escalation seam + the
 * Jev advisory tier at the runtime composition root.
 *
 * Kept out of services.ts so the wiring (broker routing + the advisory tier) lives next to the seam it configures rather than
 * bloating the services monolith. Returns the boolean handler the exec tool's
 * sandbox calls; when the sandbox is inactive the handler is simply never
 * invoked.
 */
import { logger } from '../../utils/logger.js';
import type { ConfigManager } from '../../config/manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import {
  createSandboxEscalationApprovalHandler,
  type SandboxEscalationJudgment,
} from './sandbox-escalation.js';

/** The boolean escalation handler the exec sandbox invokes per command. */
export type ExecSandboxEscalationHandler = (input: {
  readonly command: string;
  readonly escalations: readonly string[];
  readonly boundary: string;
  readonly policyReasons: readonly string[];
  readonly workingDirectory?: string | undefined;
}) => Promise<boolean>;

/** The broker seam this wiring routes through. */
export interface EscalationWiringDeps {
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly routeId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'>;
}

/**
 * Build the exec-sandbox escalation handler: escalations ride the approval
 * broker, and, while the `sandbox.judgment` setting is annotate or
 * auto-approve, the judgment tier annotates the ask (annotate, the default)
 * or additionally auto-approves a looks-safe verdict (auto-approve, an
 * explicit opt-in). Every judgment leaves a receipt.
 */
export function buildSandboxEscalationHandler(deps: EscalationWiringDeps): ExecSandboxEscalationHandler {
  const judgment: SandboxEscalationJudgment | undefined = deps.featureFlags.isEnabled('sandbox-model-judgment')
    ? {
        config: { enabled: true, autoApprove: deps.configManager.get('sandbox.judgment') === 'auto-approve' },
        onReceipt: (r) => logger.info('[sandbox-judgment] receipt', {
          command: r.command, verdict: r.verdict, outcome: r.outcome, riskProbability: r.riskProbability,
        }),
      }
    : undefined;

  const seam = createSandboxEscalationApprovalHandler(deps.requestApproval, judgment);
  return async (input) => (await seam({ sandbox: 'exec-sandbox', ...input })).approved;
}
