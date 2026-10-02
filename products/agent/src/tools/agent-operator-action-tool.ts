import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import {
  buildOperatorActionRequest,
  formatOperatorActionFailure,
  formatOperatorActionSuccess,
  formatOperatorActionToolPreview,
  isRecord,
  getOperatorActions,
  postOperatorAction,
  readOperatorActionBoolean,
  readOperatorActionString,
} from '../agent/operator-actions.ts';

interface OperatorActionToolArgs {
  readonly action?: unknown;
  readonly targetId?: unknown;
  readonly approvalId?: unknown;
  readonly jobId?: unknown;
  readonly runId?: unknown;
  readonly scheduleId?: unknown;
  readonly note?: unknown;
  readonly remember?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export function createAgentOperatorActionTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_operator_action',
      description: 'Run one confirmed allowlisted operator action.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: Object.keys(getOperatorActions()),
            description: 'Exact allowlisted public operator method id to execute.',
          },
          targetId: {
            type: 'string',
            description: 'Generic target id.',
          },
          approvalId: {
            type: 'string',
            description: 'Approval id for approvals.approve, approvals.deny, or approvals.cancel.',
          },
          jobId: {
            type: 'string',
            description: 'Automation job id.',
          },
          runId: {
            type: 'string',
            description: 'Automation run id for automation.runs.cancel or automation.runs.retry.',
          },
          scheduleId: {
            type: 'string',
            description: 'Schedule id for run, enable, disable, or delete.',
          },
          note: {
            type: 'string',
            description: 'Optional approval note for approval actions.',
          },
          remember: {
            type: 'boolean',
            description: 'Optional approval remember flag for approval actions only.',
          },
          confirm: {
            type: 'boolean',
            description: 'Required true for confirmed operator action.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Short quote or summary of the user request that authorized this action.',
          },
        },
        required: ['action', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs: unknown) => {
      const request = buildOperatorActionRequest(rawArgs);
      if (!request.ok) {
        return { success: false, error: request.error };
      }
      const args = isRecord(rawArgs) ? rawArgs as OperatorActionToolArgs : {};
      const explicitUserRequest = readOperatorActionString(args.explicitUserRequest);
      if (!explicitUserRequest) {
        return {
          success: false,
          error: formatOperatorActionToolPreview(request, ''),
        };
      }
      if (!readOperatorActionBoolean(args.confirm)) {
        return {
          success: false,
          error: formatOperatorActionToolPreview(request, explicitUserRequest),
        };
      }
      const connection = resolveAgentConnectedHostConnection(configManager, shellPaths.homeDirectory);
      if (!connection.token) {
        return {
          success: false,
          error: `auth_required: no connected-host operator token found at ${connection.tokenPath}`,
        };
      }
      const result = await postOperatorAction(connection, request);
      if (!result.ok) return { success: false, error: formatOperatorActionFailure(result) };
      return {
        success: true,
        output: formatOperatorActionSuccess(connection.baseUrl, result),
      };
    },
  };
}

export function registerAgentOperatorActionTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentOperatorActionTool(shellPaths, configManager));
}
