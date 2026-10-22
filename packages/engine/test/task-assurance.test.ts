import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { assertAgentBriefFidelity } from '../sdk/src/platform/agents/brief-fidelity.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { collectResponseDelegates, ResponseCompletionGuard } from '../sdk/src/platform/core/response-completion.js';
import { createAgentTool } from '../sdk/src/platform/tools/agent/index.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

test('outside-contract single and mixed batch spawns cannot bypass original-scope checks', async () => {
  let spawns = 0, contracts = 0;
  const tool = createAgentTool({ manager: { guardContractLeafSpawn() {}, spawn() { spawns++; throw new Error('No refused spawn may execute'); } } as never,
    messageBus: {} as never, configManager: { get: () => 20 } as never,
    contractRunner: { start() { contracts++; throw new Error('No partial batch may start'); }, list: () => [], get: () => undefined } as never,
    projectRoot: '/synthetic', resolveSessionId: () => 'session' });
  const fake = fakePort(name => noulAnswer(name === 'scope_conflict' ? .99 : .01));
  installJudgmentPort(fake.port);
  const single = await tool.execute({ mode: 'spawn', outsideContract: true, task: 'Review auth.ts only and call the whole review done.', authoritativeTask: 'Review the entire repository.' });
  expect(single.success).toBe(false); expect(spawns).toBe(0);
  const batch = await tool.execute({ mode: 'batch-spawn', authoritativeTask: 'Review the entire repository.', tasks: [
    { task: 'Review auth.ts only and call the review complete.', outsideContract: true }, { task: 'Write the report.' },
  ] });
  expect(batch.success).toBe(false); expect(spawns).toBe(0); expect(contracts).toBe(0);
  expect(fake.requests.filter(request => request.context?.battery === 'engine.agents.brief-fidelity')).toHaveLength(2);
});

test('unsettled, unavailable and private delegation evidence never starts a brief', async () => {
  const input = { request: 'Review the repository without changing files.', assignments: [{ task: 'Read-only engine review.' }] };
  for (const probability of [.99, .5]) {
    installJudgmentPort(fakePort(() => noulAnswer(probability)).port);
    await expect(assertAgentBriefFidelity(input)).rejects.toThrow();
  }
  installJudgmentPort(undefined); await expect(assertAgentBriefFidelity(input)).rejects.toThrow();
  const fake = fakePort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
  await expect(assertAgentBriefFidelity({ ...input, assignments: [{ task: 'password=synthetic-private-value' }] })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
  await expect(assertAgentBriefFidelity(input)).resolves.toBeUndefined();
});

test('changed or cancelled delegation input cannot be admitted after an awaited reading', async () => {
  for (const change of ['brief', 'abort']) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
    const fake = fakePort(() => noulAnswer(.01));
    installJudgmentPort({ model: fake.port.model, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
    const input = { request: 'Review without changing files.', assignments: [{ task: 'Read-only engine review.' }] };
    const pending = assertAgentBriefFidelity(input, { signal: controller.signal }).then(() => null, error => error);
    await entered.promise;
    if (change === 'brief') input.assignments[0]!.task = 'Edit the engine.';
    else controller.abort();
    release.resolve(); expect(await pending).toBeInstanceOf(Error);
  }
});

test('completion and consolidation start concurrently and the slower rejection holds the combined result', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let active = 0, maximum = 0;
  const fake = fakePort(name => noulAnswer(name === 'unresolved_conflict' ? .99 : .01));
  installJudgmentPort({ model: fake.port.model, ask: async request => {
    active++; maximum = Math.max(maximum, active); if (active === 3) entered.resolve();
    await release.promise; try { return await fake.port.ask(request); } finally { active--; }
  } });
  const conversation = new ConversationManager(); conversation.addUserMessage('Consolidate the review findings.');
  const pending = new ResponseCompletionGuard().check({ request: 'Consolidate the review findings.', response: 'The review is complete.', conversation, tools: [],
    delegated: [{ id: 'a', task: 'Review authentication', status: 'completed', output: 'Tokens are revoked.' }, { id: 'b', task: 'Test authentication', status: 'completed', output: 'Tokens remain valid.' }] });
  await entered.promise;
  expect(maximum).toBe(3);
  release.resolve(); expect(await pending).toContain('findings conflict');
  expect(fake.requests.map(request => request.context?.battery).sort()).toEqual([
    'engine.core.delegation-consolidation', 'engine.core.execution-assurance', 'engine.core.response-completion',
  ]);
});

test('every execution assurance failure independently holds completion', async () => {
  for (const failure of ['ineffective_fix', 'irrelevant_verification', 'weakened_criteria'] as const) {
    const applicable = { ineffective_fix: 'implementation_presented', irrelevant_verification: 'verification_claimed', weakened_criteria: 'criteria_altered' }[failure];
    const fake = fakePort(name => noulAnswer(name === failure || name === applicable ? .99 : .01)); installJudgmentPort(fake.port);
    const conversation = new ConversationManager();
    conversation.addUserMessage('Fix the parser and verify its regression.');
    conversation.addAssistantMessage('', { toolCalls: [{ id: 'e', name: 'exec', arguments: { cmd: 'bun test' } }] });
    conversation.addToolResults([{ callId: 'e', success: true, output: '1 pass' }]);
    const result = await new ResponseCompletionGuard().check({ request: 'Fix the parser and verify its regression.', response: 'Fixed and verified.', conversation, tools: ['exec'] });
    expect(result).toBeString(); expect(fake.requests).toHaveLength(2);
  }
});

test('execution applicability and failure readings compose without treating uncertainty as permission', async () => {
  for (const [applies, failure, mayFinish] of [[.5, .01, true], [.01, .5, true], [.5, .99, false], [.5, .5, false], [.99, .5, false]] as const) {
    const fake = fakePort(name => noulAnswer(name === 'implementation_presented' ? applies : name === 'ineffective_fix' ? failure : .01));
    installJudgmentPort(fake.port);
    const conversation = new ConversationManager();
    conversation.addToolResults([{ callId: 'write', success: true, output: 'Wrote hello.txt.' }]);
    const result = await new ResponseCompletionGuard().check({ request: 'Write hello.txt.', response: 'Wrote hello.txt.', conversation, tools: ['write'] });
    expect(result === null).toBe(mayFinish);
  }
});

test('a completion claim based on an earlier turn still requires execution assurance', async () => {
  const fake = fakePort(name => noulAnswer(name === 'implementation_presented' || name === 'ineffective_fix' ? .99 : .01));
  installJudgmentPort(fake.port);
  const conversation = new ConversationManager();
  conversation.addUserMessage('Fix the parser.');
  conversation.addToolResults([{ callId: 'previous-edit', success: true, output: 'Replaced parser output with an empty array.' }]);
  conversation.addUserMessage('Is that finished?');
  const guard = new ResponseCompletionGuard({ request: 'Is that finished?', conversation });
  conversation.replaceMessagesForLLM([{ role: 'user', content: '[Session Summary] The parser was edited; completion still needs checking.' }]);
  expect(await guard.check({ request: 'Is that finished?', response: 'The parser is fixed.', conversation, tools: ['edit'] })).toContain('leaves the requested behavior broken');
  expect(fake.requests.map(request => request.context?.battery).sort()).toEqual(['engine.core.execution-assurance', 'engine.core.response-completion']);
});

test('only agent identities returned by this conversation contribute delegated evidence', () => {
  const conversation = new ConversationManager();
  conversation.addAssistantMessage('', { toolCalls: [{ id: 'spawn', name: 'agent', arguments: { mode: 'spawn' } }] });
  conversation.addToolResults([{ callId: 'spawn', success: true, output: JSON.stringify({ agentId: 'owned' }) }]);
  const evidence = collectResponseDelegates(conversation, { list: () => [
    { id: 'owned', task: 'Review engine', status: 'completed', fullOutput: 'Engine finding' },
    { id: 'unrelated', task: 'Private other assignment', status: 'completed', fullOutput: 'Unrelated content' },
  ] as never, getConversationSnapshot: () => [] });
  expect(evidence.map(agent => agent.id)).toEqual(['owned']);
  expect(JSON.stringify(evidence)).not.toContain('Unrelated');
});


test('a held batch cannot be abandoned for a contract, and revised assignments are revalidated before effects', async () => {
  let spawns = 0, contracts = 0;
  const records: unknown[] = [];
  const tool = createAgentTool({ manager: { guardContractLeafSpawn() {}, list: () => [], spawn(input: { task: string }) {
    spawns++;
    const record = { id: `reviewer-${spawns}`, task: input.task, template: 'reviewer', status: 'running', tools: [], executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' };
    records.push(record); return record;
  } } as never, messageBus: {} as never, configManager: { get: () => 20 } as never,
    contractRunner: { start() { contracts++; throw new Error('Held delegation must never start a contract'); } } as never,
    projectRoot: '/synthetic', resolveSessionId: () => 'session' });
  const request = 'Review the whole repository and write a consolidated artifact.';
  const tasks = [{ task: 'Review engine sources and report to coordinator.', outsideContract: true }, { task: 'Review products and report to coordinator.', outsideContract: true }];
  const uncertain = fakePort(name => noulAnswer(name === 'constraint_conflict' ? .45 : .01)); installJudgmentPort(uncertain.port);
  expect((await tool.execute({ mode: 'batch-spawn', authoritativeTask: request, tasks })).success).toBe(false);
  const bypass = await tool.execute({ mode: 'spawn', authoritativeTask: request, task: request });
  expect(bypass.success).toBe(false);
  expect(bypass.error).toContain('Repair and revalidate');
  expect(spawns).toBe(0); expect(contracts).toBe(0);
  expect(uncertain.requests.filter(request => request.context?.battery === 'engine.agents.brief-fidelity')).toHaveLength(1);
  const accepted = fakePort(() => noulAnswer(.01)); installJudgmentPort(accepted.port);
  const revised = await tool.execute({ mode: 'batch-spawn', authoritativeTask: request, tasks: tasks.map(task => ({ ...task,
    task: task.task + ' The coordinator retains all remaining scope and writes the final consolidated artifact.' })) });
  expect(revised.success).toBe(true); expect(spawns).toBe(2); expect(contracts).toBe(0);
  expect(accepted.requests).toHaveLength(2);
});

test('an uncertain whole-plan reading resolves every original requirement without a blind plan rewrite', async () => {
  const request = 'Use one read-only agent. Keep all files unchanged. The coordinator checks git diff once.';
  const input = { request, assignments: [{ task: 'Read review.md and return its verification result; the coordinator runs git diff.',
    tools: ['read'], restrictTools: true, executionIntent: { filesystemPolicy: 'read-only' as const } }] };
  const requirements: string[] = [];
  const fake = fakePort((name, _question, state) => {
    const source = state as { originalUserRequest: string; proposedSpecialistCount?: number; requirement?: string; specialistAssignments?: typeof input.assignments };
    expect(source.originalUserRequest).toBe(request);
    if (name === 'delegation_forbidden') {
      expect(source.proposedSpecialistCount).toBe(1);
      expect(source.specialistAssignments).toBeUndefined();
      return noulAnswer(.01);
    }
    expect(source.specialistAssignments).toEqual(input.assignments);
    if (source.requirement) { requirements.push(source.requirement); return noulAnswer(.01); }
    return noulAnswer(.5);
  });
  installJudgmentPort(fake.port);
  await assertAgentBriefFidelity(input);
  expect(new Set(requirements)).toEqual(new Set(['Use one read-only agent.', 'Keep all files unchanged.', 'The coordinator checks git diff once.']));
  expect(fake.requests).toHaveLength(5);
});

test('a delegation rejection returns the exact conflicting requirement as a numbered fix', async () => {
  const request = 'Read review.md. Do not change any files.';
  const fake = fakePort((name, _question, state) => {
    const requirement = (state as { requirement?: string }).requirement;
    return noulAnswer(name === 'constraint_conflict' && (!requirement || requirement === 'Do not change any files.') ? .99 : .01);
  });
  installJudgmentPort(fake.port);
  await expect(assertAgentBriefFidelity({ request, assignments: [{ task: 'Edit review.md.' }] }))
    .rejects.toThrow('1. {"requirement":"Do not change any files.","check":"constraint_conflict"');
});

test('root delegation authorization never reads a worker prohibition as a user prohibition', async () => {
  const request = 'Use one read-only helper to verify review.md. The coordinator checks git diff and delivers the final answer.';
  const assignments = [{ task: 'Read review.md and return its verification result. Do not spawn agents.', tools: ['read'], restrictTools: true }];
  const fake = fakePort((name, _question, state) => {
    if (name === 'delegation_forbidden') {
      expect(state).toEqual({ originalUserRequest: request, proposedSpecialistCount: 1 });
      expect(JSON.stringify(state)).not.toContain('Do not spawn agents');
    } else {
      expect((state as { specialistAssignments: unknown }).specialistAssignments).toEqual(assignments);
    }
    return noulAnswer(.01);
  });
  installJudgmentPort(fake.port);
  await assertAgentBriefFidelity({ request, assignments });
  expect(fake.requests.map(r => r.context?.battery).sort()).toEqual([
    'engine.agents.brief-fidelity', 'engine.agents.delegation-authorization',
  ]);
});

test('an original user ban independently prevents actual dispatch even when copied into the worker brief', async () => {
  let spawns = 0;
  const tool = createAgentTool({ manager: { guardContractLeafSpawn() {}, spawn() { spawns++; throw new Error('Forbidden delegation executed'); } } as never,
    messageBus: {} as never, configManager: { get: () => 20 } as never,
    contractRunner: {} as never, projectRoot: '/synthetic', resolveSessionId: () => 'session' });
  installJudgmentPort(fakePort(name => noulAnswer(name === 'delegation_forbidden' ? .99 : .01)).port);
  const task = 'Review the parser yourself without delegating to any agents.';
  const result = await tool.execute({ mode: 'spawn', outsideContract: true, authoritativeTask: task, task });
  expect(result.success).toBe(false);
  expect(spawns).toBe(0);
  expect(JSON.parse(result.output!).recovery.fixes).toEqual([expect.objectContaining({
    requirement: task, check: 'delegation_forbidden', assessment: 'confirmed conflict',
  })]);
});

test('authorization sees the actual proposed batch count rather than a count in specialist prose', async () => {
  let observed = 0;
  const fake = fakePort((name, _question, state) => {
    if (name !== 'delegation_forbidden') return noulAnswer(.01);
    observed = (state as { proposedSpecialistCount: number }).proposedSpecialistCount;
    return noulAnswer(.99);
  });
  installJudgmentPort(fake.port);
  await expect(assertAgentBriefFidelity({ request: 'Use exactly one helper.', assignments: [
    { task: 'I am the sole helper; inspect the parser.' }, { task: 'I am the sole helper; inspect the server.' },
  ] })).rejects.toThrow('delegation_forbidden: yes (act)');
  expect(observed).toBe(2);
});
