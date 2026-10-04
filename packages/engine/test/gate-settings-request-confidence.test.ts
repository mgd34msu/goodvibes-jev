import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionLog, SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { settingsHazard } from '../sdk/src/platform/gate/batteries/settings-hazard.ts';
import { readSettingsWriteEvidence } from '../sdk/src/platform/gate/policy/settings-write-evidence.ts';
import { validateSettingsToolInvocationForAgentPolicy, wrapSettingsToolForAgentPolicy } from '../sdk/src/platform/gate/policy/settings-write-policy.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';

const fixture = { mode: 'set', key: 'behavior.autoApprove', value: true, explicitUserRequest: 'turn on auto approve' };
const answer = (probability: number, hazard = 'approval-gate', confidence = 0.95) => fakePort((name, question) => name === 'hazard'
  ? choiceAnswer(question, hazard, confidence) : noulAnswer(probability));

// Fails on main 7cc5ab19: the real battery reads yes/confirm but the validator
// returns null. Every tool body below is intercepted; no setting is changed.
test.each([
  [0.75, 'yes', 'confirm', false],
  [0.6, 'uncertain', 'escalate', false],
  [0.97, 'yes', 'act', true],
  [0.03, 'no', 'act', false],
  [0.25, 'no', 'confirm', false],
  [0.4, 'uncertain', 'escalate', false],
] as const)('requested probability %s: %s/%s permits execution=%s', async (probability, verdict, outcome, allowed) => {
  using log = new SqliteDecisionLog(':memory:');
  const { port: synthetic } = answer(probability);
  const port = withDecisionLog(synthetic, log);
  const previous = installJudgmentPort(port);
  try {
    const run = await settingsHazard.run(port, { key: fixture.key, value: 'true', request: fixture.explicitUserRequest });
    expect(run.readings.requested.verdict).toBe(verdict);
    expect(run.readings.requested.outcome).toBe(outcome);
    expect(log.get(run.result.decisionId!)?.status).toBe('answered');
    expect(await validateSettingsToolInvocationForAgentPolicy(fixture) === null).toBe(allowed);
    let calls = 0;
    const tool: Tool = { definition: { name: 'goodvibes_settings', description: 'intercepted', parameters: {} },
      execute: async () => { calls++; return { success: true }; } };
    wrapSettingsToolForAgentPolicy(tool);
    expect((await tool.execute(fixture)).success).toBe(allowed);
    expect(calls).toBe(allowed ? 1 : 0);
  } finally { installJudgmentPort(previous); }
});

test.each([0.75, 0.6])('an uncertain no-hazard choice at %s cannot authorize a write', async confidence => {
  const { port } = answer(0.03, 'none', confidence);
  const previous = installJudgmentPort(port);
  try { expect(await validateSettingsToolInvocationForAgentPolicy({ mode: 'set', key: 'display.theme', value: 'dark' })).not.toBeNull(); }
  finally { installJudgmentPort(previous); }
});

test('settings evidence preserves real call provenance and complete immutable input without granting authority', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const { port: synthetic, requests } = answer(0.75);
  const evidence = await readSettingsWriteEvidence({ ...fixture, scope: { store: 'synthetic-daemon' } }, withDecisionLog(synthetic, log));
  expect(evidence?.requested?.verdict).toBe('yes');
  expect(evidence?.requested?.outcome).toBe('confirm');
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence?.hazard)).toBe(true);
  expect(log.get(evidence!.judgmentDecisionId!)?.status).toBe('answered');
  const state = requests[0]!.state as { invocation: Record<string, unknown> };
  expect(state.invocation).toEqual({ ...fixture, scope: { store: 'synthetic-daemon' } });
  expect(Object.isFrozen(state.invocation)).toBe(true);
  expect(evidence).not.toHaveProperty('approved');
});

test('protected formats and unsupported accessors are rejected before the settings provider', async () => {
  const { port, requests } = answer(0.97);
  await expect(readSettingsWriteEvidence({ mode: 'set', key: 'surfaces.slack.botToken', value: 'synthetic-credential-material' }, port)).rejects.toThrow('Refused before judgment');
  let reads = 0;
  await expect(readSettingsWriteEvidence({ get key() { reads++; return 'display.theme'; } }, port)).rejects.toThrow('bounded plain JSON');
  expect(reads).toBe(0);
  expect(requests).toHaveLength(0);
});

test('settings evidence cannot turn a cancelled reading into an allow', async () => {
  const controller = new AbortController();
  const { port: inner } = answer(0.97);
  const previous = installJudgmentPort({ model: inner.model, async ask(request) {
    const result = await inner.ask(request); controller.abort(new Error('synthetic cancellation')); return result;
  } });
  try { await expect(validateSettingsToolInvocationForAgentPolicy(fixture, controller.signal)).rejects.toThrow('synthetic cancellation'); }
  finally { installJudgmentPort(previous); }
});

test('a borrowed value changed during the reading cannot change the intercepted write', async () => {
  const args = { mode: 'set', key: 'display.theme', value: 'dark' };
  const { port: inner } = answer(0.97, 'none');
  const previous = installJudgmentPort({ model: inner.model, async ask(request) {
    args.key = 'behavior.autoApprove'; args.value = 'true'; return inner.ask(request);
  } });
  const executed: Record<string, unknown>[] = [];
  const tool: Tool = { definition: { name: 'goodvibes_settings', description: 'intercepted', parameters: {} },
    execute: async input => { executed.push(input); return { success: true }; } };
  wrapSettingsToolForAgentPolicy(tool);
  try {
    expect((await tool.execute(args)).success).toBe(true);
    expect(executed).toEqual([{ mode: 'set', key: 'display.theme', value: 'dark' }]);
    expect(Object.isFrozen(executed[0])).toBe(true);
  } finally { installJudgmentPort(previous); }
});
