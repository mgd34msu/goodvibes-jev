import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry, type ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

const names = ['agent_autonomy_schedule', 'agent_reminder_schedule', 'agent_schedule_edit'];
const ordinaryFields = new Set(['methodId', 'status', 'ok', 'route', 'effect', 'id', 'name', 'labels', 'createdAt',
  'updatedAt', 'mutationRevision', 'enabled', 'schedule', 'kind', 'expression', 'timezone', 'intervalMs', 'at',
  'execution', 'target', 'delivery', 'mode', 'targets', 'fallbackTargets', 'includeSummary', 'includeTranscript',
  'includeLinks', 'failure', 'action', 'maxConsecutiveFailures', 'cooldownMs', 'retryPolicy', 'maxAttempts',
  'delayMs', 'strategy', 'source', 'label', 'metadata', 'runCount', 'successCount', 'failureCount', 'deleteAfterRun',
  'jobs', 'runs', 'error']);
const contentFields = new Set(['body', 'prompt']);
const syntheticNoFacts = new Set(['mutates', 'outward', 'secrets', 'obfuscated', 'irreversible', 'beyondProject',
  'weakensSecurity', 'catastrophic', 'cardDetails', 'lineHasCredential', 'spanIsCredential', 'credentialRemains']);

/** Named synthetic schedules, recorded through the real manager and child registry. */
export function scheduleEffectAdmission(directory: string, mode: PermissionMode = 'prompt', onDisposition?: (index: number) => void) {
  let incarnation = 0, disposition = 0;
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory, incarnation }),
    getSnapshot: () => ({ permissions: permissions() }), getWorkingDirectory: () => directory, isAutoApproveEnabled: () => false,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  const answers = fakePort((name, question, state) => {
    if (question.type === 'noul') {
      if (name === 'security_code' || name === 'expiry') {
        if (typeof state !== 'string' || /\p{Nd}/u.test(state)) throw new Error('Synthetic schedule card-talk state must have every digit masked');
        return noulAnswer(0.001);
      }
      if (!syntheticNoFacts.has(name)) throw new Error(`Unexpected synthetic schedule fact ${name}`);
      return noulAnswer(0.001);
    }
    if (question.type !== 'choice') throw new Error(`Unexpected synthetic schedule question ${name}`);
    const field = state && typeof state === 'object' && !Array.isArray(state) ? state.field : undefined;
    if (name === 'kind' && field !== undefined && Object.hasOwn(question.criteria, 'other')) {
      if (typeof field !== 'string' || (!ordinaryFields.has(field) && !contentFields.has(field))) throw new Error('Unexpected authored synthetic schedule response field');
      return choiceAnswer(question, contentFields.has(field) ? 'content' : 'other', 0.999);
    }
    const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label || !Object.hasOwn(question.criteria, label)) throw new Error(`Unexpected synthetic schedule choice ${name}`);
    if (name === 'disposition') onDisposition?.(++disposition);
    return choiceAnswer(question, label, 0.999);
  });
  return {
    registry,
    revoke() { incarnation++; },
    async run(tool: Tool, args: Record<string, unknown>, options?: ToolExecuteOptions) {
      if (!names.includes(tool.definition.name)) throw new Error('Only named synthetic schedule fixtures may use this admission.');
      const log = new SqliteDecisionLog(':memory:');
      const previous = installJudgmentPort(withDecisionLog(answers.port, log));
      try {
        if (!registry.has(tool.definition.name)) registry.register(tool);
        const call = await registry.prepareCall('synthetic-schedule', tool.definition.name, args, options);
        const admission = await manager.admitAutonomous(call.callId, tool.definition.name, call.args, {
          sourceOf: () => ({ goal: 'Exercise named synthetic schedule effects', criteria: ['Use isolated temporary state and mocked HTTP only'] }),
          signal: options?.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
        });
        return await registry.executePrepared(call, admission, options);
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
      finally { installJudgmentPort(previous); log[Symbol.dispose](); }
    },
  };
}
