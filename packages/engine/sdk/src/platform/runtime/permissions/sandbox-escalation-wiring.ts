/** Canonical sandbox sub-operations retain the recorded autonomous owner and
 * exact final-spawn permit. Broker/advisory behavior remains only for direct
 * compatibility constructors outside an autonomous operation. */
import { logger } from '../../utils/logger.js';
import type { ConfigManager } from '../../config/manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import {
  createSandboxEscalationApprovalHandler,
  type SandboxEscalationJudgment,
} from './sandbox-escalation.js';

import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { admitSandboxEscalation } from './autonomous-sandbox-escalation.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
export type ExecSandboxEscalationHandler = import('../../tools/exec/sandbox.js').SandboxEscalationHandler;

/** The broker seam this wiring routes through. */
export interface EscalationWiringDeps {
  readonly autonomousHost?: AutonomousToolPromptHost | undefined;
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly routeId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'>;
}

/** Build the canonical exact-plan handler, preserving standalone advisory compatibility. */
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
  return async (input, execution) => {
    if (deps.autonomousHost) return admitSandboxEscalation(deps.autonomousHost, input, execution);
    if (currentExternalOperationSource()) return false;
    return (await seam({ sandbox: 'exec-sandbox', ...input })).approved;
  };
}
