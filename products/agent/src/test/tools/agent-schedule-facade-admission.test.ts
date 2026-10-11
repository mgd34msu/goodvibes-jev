import { afterEach, beforeEach, expect, test } from 'bun:test';
import { assertCurrentToolEffect, assertCurrentToolInvocation } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '../../config/index.ts';
import { createAgentScheduleTool } from '../../tools/agent-schedule-tool.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  const scripted = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type !== 'choice') throw new Error('Unexpected synthetic schedule question');
    const label = name === 'disposition' ? Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject'
      : name === 'kind' ? 'read' : 'generic';
    return choiceAnswer(question, label, 0.999);
  });
  previous = installJudgmentPort(withDecisionLog(scripted.port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });

function fixture(initialMode: 'prompt' | 'plan' = 'prompt') {
  const root = makeProjectTempDir('schedule-facade-admission');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: paths.resolveUserPath('agent'), homeDir: root, workingDir: root });
  const placeholder: Tool = { definition: { name: 'schedule', description: 'Replaced by the real facade.', parameters: {} }, execute: async () => ({ success: false }) };
  const admitted = recordedEffectFixture(placeholder, initialMode, {}, root);
  const tool = createAgentScheduleTool(paths, config, admitted.registry);
  placeholder.definition = tool.definition; placeholder.execute = tool.execute;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let beforeChild: (() => void) | undefined;
  for (const name of ['agent_operator_method', 'agent_operator_action', 'agent_autonomy_schedule', 'agent_reminder_schedule', 'agent_schedule_edit']) {
    admitted.registry.register({ definition: { name, description: 'Synthetic intercepted schedule owner.', parameters: { type: 'object', additionalProperties: true } },
      async execute(args, options) {
        beforeChild?.();
        if (!assertCurrentToolInvocation(args, options) || (name !== 'agent_operator_method' && !assertCurrentToolEffect(args, options, 'write'))) return { success: false };
        calls.push({ name, args }); return { success: true, output: name };
      } });
  }
  return { ...admitted, tool, calls, beforeChild(callback: () => void) { beforeChild = callback; } };
}

test.each([
  ['list', 'agent_operator_method'], ['create', 'agent_autonomy_schedule'], ['reminder', 'agent_reminder_schedule'],
  ['edit', 'agent_schedule_edit'], ['run', 'agent_operator_action'], ['pause', 'agent_operator_action'],
  ['resume', 'agent_operator_action'], ['delete', 'agent_operator_action'],
] as const)('schedule %s prepares a separately admitted registered %s child without caller flags', async (action, owner) => {
  const f = fixture();
  const result = await f.run({ action, scheduleId: 'synthetic-schedule', task: 'Synthetic task', successCriteria: 'Synthetic criteria',
    message: 'Synthetic reminder', every: '1d' });
  expect(result.success).toBe(true); expect(f.calls).toHaveLength(1); expect(f.calls[0]?.name).toBe(owner);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(2);
});

test('raw caller flags cannot dispatch the preferred schedule facade', async () => {
  const f = fixture(); const result = await f.tool.execute({ action: 'pause', scheduleId: 'synthetic-schedule', confirm: true, explicitUserRequest: 'Caller claim' });
  expect(result.success).toBe(false); expect(f.calls).toHaveLength(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('read-only parent cannot give a write child authority even under false semantic readings', async () => {
  const f = fixture('plan'); await expect(f.run({ action: 'pause', scheduleId: 'synthetic-schedule' })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test('owner revocation at the concrete child refuses the effect', async () => {
  const f = fixture(); f.beforeChild(() => f.setMode('plan'));
  await expect(f.run({ action: 'pause', scheduleId: 'synthetic-schedule' })).rejects.toThrow(); expect(f.calls).toHaveLength(0);
});

test('the child preserves the exact canonical route id and transformed schedule values', async () => {
  const f = fixture(); await f.run({ action: 'pause', jobId: 'synthetic-job' });
  expect(f.calls[0]?.args).toEqual({ action: 'automation.schedules.disable', scheduleId: 'synthetic-job' });
});

test('reminder child preparation omits absent optional values', async () => {
  const f = fixture(); await f.run({ action: 'reminder', message: 'Synthetic reminder', every: '1d' });
  expect(f.calls[0]?.args).toEqual({ message: 'Synthetic reminder', scheduleKind: 'every', scheduleValue: '1d' });
});
