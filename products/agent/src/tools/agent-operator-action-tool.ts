import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import { isDeepStrictEqual } from 'node:util';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { assertOperatorEffect } from '../agent/operator-connection-owner.ts';
import { findOperatorContractMethod } from '../agent/operator-contract-routes.ts';
import { createOperatorInputProjector, operatorExecutionConnection, operatorExecutionWireInput, operatorExecutionRequestPolicy, operatorMethodIsOutward } from './agent-operator-input-projector.ts';
import {
  buildOperatorActionRequest,
  formatOperatorActionFailure,
  formatOperatorActionSuccess,
  getOperatorActions,
  postOperatorAction,
  renderOperatorActionPath,
} from '../agent/operator-actions.ts';

export function createAgentOperatorActionTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_operator_action',
      description: 'Run one allowlisted operator action under current recorded effect admission.',
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
            description: 'Optional audit annotation; does not grant effect authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request provenance; does not grant effect authority.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, options) => {
      try {
        const parsed = buildOperatorActionRequest(captureStrictJudgmentJson(rawArgs));
        if (!parsed.ok) return { success: false, error: parsed.error };
        const descriptor = parsed.descriptor;
        const request = captureStrictJudgmentJson(parsed);
        const method = findOperatorContractMethod(request.descriptor.action);
        const methodSnapshot = captureStrictJudgmentJson(method);
        const assertInvocation = () => {
          assertOperatorEffect(rawArgs, options, operatorMethodIsOutward(request.descriptor.action));
          if (getOperatorActions()[request.descriptor.action] !== descriptor
            || !isDeepStrictEqual(captureStrictJudgmentJson(descriptor), request.descriptor)
            || findOperatorContractMethod(request.descriptor.action) !== method
            || !isDeepStrictEqual(captureStrictJudgmentJson(method), methodSnapshot)) throw new Error('Connected operator action changed.');
        };
        assertInvocation();
        const connection = operatorExecutionConnection(rawArgs, options, shellPaths, configManager, 'action');
        if (!connection) throw new Error('Connected operator effects require a registered source projection.');
        const assertCurrent = () => { assertInvocation(); connection.assertCurrent(); };
        if (!connection.token) return { success: false, error: 'auth_required: no connected-host operator token found.' };
        const wireBody = operatorExecutionWireInput(request.body ?? {}, rawArgs, options, shellPaths, configManager, 'action');
        const wireRequest = { ...request, body: request.body === null && !Object.keys(wireBody).length ? null : wireBody };
        const requestPolicy = operatorExecutionRequestPolicy(rawArgs, options, shellPaths, configManager, 'action');
        if (!requestPolicy) throw new Error('Connected operator source policy is unavailable.');
        await requestPolicy.screen({ toolName: 'agent_operator_action', methodId: request.descriptor.action,
          endpoint: `${connection.baseUrl}${renderOperatorActionPath(request.descriptor, request.targetId)}`, payload: wireBody }, { signal: options?.signal, assertCurrent });
        const result = await postOperatorAction(connection, wireRequest, { signal: options?.signal, assertCurrent });
        assertCurrent();
        const output = await redactSensitiveDataAsync(result.ok ? formatOperatorActionSuccess(connection.baseUrl, result)
          : formatOperatorActionFailure(result), { signal: options?.signal, assertCurrent, secretValues: [connection.token] });
        assertCurrent();
        if (!result.ok) return { success: false, error: output };
        if (output === '[REDACTED]') return { success: false, error: 'Connected operator receipt could not be projected safely.' };
        return { success: true, output };
      } catch {
        return { success: false, error: 'Connected operator action requires current recorded effect admission and an unchanged connection.' };
      }
    },
  };
}

export function registerAgentOperatorActionTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentOperatorActionTool(shellPaths, configManager), { inputProjection: createOperatorInputProjector(shellPaths, configManager, 'action') });
}
