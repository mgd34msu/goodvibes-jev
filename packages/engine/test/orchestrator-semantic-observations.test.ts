import { bindContractPlanConsumer } from '../sdk/src/platform/tools/agent/contract-binding.js';
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort, bindJudgmentPortAuthority } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { prepareProjectFramework, readRepeatedCalls, OrchestratorObservationHeldError, type RetainedToolObservation } from '../sdk/src/platform/agents/orchestrator-observations.js';
import { runAgentTask, type AgentOrchestratorRunContext } from '../sdk/src/platform/agents/orchestrator-runner.js';
import { buildOrchestratorSystemPrompt } from '../sdk/src/platform/agents/orchestrator-prompts.js';
import { ToolRegistry, assertCurrentExecInvocation } from '../sdk/src/platform/tools/registry.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/index.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.js';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.js';
import { AGENT_OWNER_TERMINAL_GUARD } from '../sdk/src/platform/gate/policy/index.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted } from '../sdk/src/platform/runtime/emitters/agents.js';
import { registry } from '../sdk/src/platform/core/judgment-registry.js';

const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function semanticPort(answer: Parameters<typeof fakePort>[0], completion?: (name: string, state: unknown) => number) {
  return fakePort((name, question, state) => {
    if (['false_blocker', 'unfinished', 'unsupported', 'unanswered', 'unnecessary_permission', 'implementation_presented', 'verification_claimed', 'criteria_altered', 'ineffective_fix', 'irrelevant_verification', 'weakened_criteria', 'missing_results', 'unresolved_conflict'].includes(name)) return noulAnswer(completion?.(name, state) ?? .01);
    if (name === 'kind') return choiceAnswer(question, 'secret', 0.99);
    if (name === 'credentialRemains') return noulAnswer(0.03);
    if (name === 'category') return choiceAnswer(question, 'unknown', 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    if (['billing', 'rate_limited', 'context_exceeded', 'transient_network', 'provider_unusable', 'before_response'].includes(name)) return noulAnswer(0.03);
    return answer(name, question, state);
  });
}function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function setup(rounds = 0, output: (n: number) => string = () => 'same result') {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-observation-')); roots.push(root);
  const controller = new AbortController(), requests: unknown[] = [], events: string[] = [];
  const bus = new RuntimeEventBus(), completed: unknown[] = [], streams: string[] = [];
  let readSnapshot: () => unknown[] = () => [];
  bus.on('AGENT_COMPLETED', event => { completed.push(event); });
  const controls: { beforeTool?: (args: Record<string, unknown>) => Promise<void>; beforeRetry?: () => void; beforeDelta?: () => void; finalReplies?: string[]; toolName?: string; batchSize: number } = { batchSize: 1 };
  const record: AgentRecord = { id: 'agent', task: 'inspect progress', template: 'engineer', tools: ['probe'], status: 'running', startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' };
  const tools = new ToolRegistry(); let executions = 0, chats = 0;
  tools.register({ definition: { name: 'probe', description: 'Read progress', parameters: { type: 'object', properties: {} } }, async execute(args) { executions++; await controls.beforeTool?.(args); return { success: true, output: output(executions) }; } });
  const provider: LLMProvider = { name: 'fake', models: ['fake'], async chat(request) {
    await request.beforeAttempt?.(); controls.beforeRetry?.(); await request.beforeAttempt?.();
    controls.beforeDelta?.(); request.onDelta?.({ content: 'visible delta' });
    requests.push(structuredClone({ messages: request.messages, systemPrompt: request.systemPrompt }));
    return { content: chats++ < rounds ? '' : (controls.finalReplies?.shift() ?? 'done'), toolCalls: chats <= rounds ? Array.from({ length: controls.batchSize }, (_, i) => ({ id: `call-${chats}-${i}`, name: controls.toolName ?? 'probe', arguments: { job: 'a' } })) : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: chats <= rounds ? 'tool_call' : 'completed' };
  } };
  const model = { id: 'fake', provider: 'fake', registryKey: 'fake:fake' };
  const context: AgentOrchestratorRunContext = {
    workingDirectory: root, runtimeBus: bus, featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'session', traceId: 'trace', source: 'test' }),
    emitAgentProgress() {}, emitAgentStarted() {}, emitAgentCancelledEvent() { events.push('cancelled'); }, emitAgentFailedEvent() { events.push('failed'); }, emitAgentCompletedEvent(id, durationMs, output, toolCallsMade) { events.push('completed'); emitAgentCompleted(bus, { sessionId: 'session', traceId: 'trace', source: 'test' }, { agentId: id, durationMs, output, toolCallsMade }); }, emitStreamDelta(_id, content) { streams.push(content); },
    registerConversationSource(_id, source) { readSnapshot = source; },
    getCancellationSignal: () => controller.signal, messageBus: { getMessages: () => [] },
    getFullRegistry: () => tools, buildScopedRegistry: (_names, all) => all,
    providerRegistry: { getCurrentModel: () => model as never, getForModel: () => provider, listModels: () => [], getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection() {} },
    resolveProviderForRecord: () => ({ provider, modelId: 'fake', requestedModelId: 'fake:fake' }), resolveFallbackModelRoutes: () => [],
  };
  return { root, context, record, requests, events, controller, tools, controls, completed, streams, get snapshot() { return readSnapshot(); }, get executions() { return executions; } };
}
function project(root: string, value: unknown) { writeFileSync(join(root, 'package.json'), JSON.stringify(value)); }
function history(outputs = ['same', 'same']): RetainedToolObservation[] { return outputs.map((output, i) => ({ signature: 'probe::{"job":"a"}', requested: { id: `call-${i}`, name: 'probe', arguments: { job: 'a' } }, executed: { name: 'probe', arguments: '{"job":"a"}' }, result: { callId: `call-${i}`, success: true, output } })); }

describe('canonical spawn framework', () => {
  test('registered batteries and contradictory scripts override first dependency match', async () => {
    expect(registry.get('engine.agents.project-test-framework')).toBeDefined(); expect(registry.get('engine.agents.repeat-stuck')).toBeDefined();
    const f = setup(); project(f.root, { dependencies: { vitest: '1', jest: '1' }, scripts: { test: 'jest', late: 'full evidence' } });
    const fake = semanticPort((_name, question) => choiceAnswer(question, 'jest', .99)); installJudgmentPort(fake.port);
    const observation = await prepareProjectFramework(f.context, f.record);
    expect(observation.framework).toBe('jest');
    const prompt = buildOrchestratorSystemPrompt(f.record, undefined, { workingDirectory: f.root, projectFramework: observation });
    expect(prompt).toContain('Test framework: jest'); expect(prompt).not.toContain('Test framework: vitest');
    expect(fake.requests).toHaveLength(0);
  });
  test('every choice, none, uncertain and absent reader are honest optional labels', async () => {
    const f = setup(); project(f.root, { scripts: { test: 'bun scripts/run-tests.ts' }, dependencies: { vitest: '1' } });
    for (const framework of ['vitest', 'jest', 'bun', 'node', 'mocha', 'ava', 'playwright', 'cypress', 'other', 'none']) {
      installJudgmentPort(semanticPort((_n, q) => choiceAnswer(q, framework, .99)).port);
      expect((await prepareProjectFramework(f.context, f.record)).framework).toBe(framework === 'none' ? undefined : framework === 'bun' ? 'bun:test' : framework);
    }
    installJudgmentPort(semanticPort((_n, q) => choiceAnswer(q, 'vitest', .2)).port); expect((await prepareProjectFramework(f.context, f.record)).framework).toBeUndefined();
    installJudgmentPort(undefined); expect((await prepareProjectFramework(f.context, f.record)).framework).toBeUndefined();
  });
  test('private manifest tails omit the hint before port lookup', async () => {
    const f = setup(); project(f.root, { scripts: { test: 'jest' }, tail: 'x'.repeat(210_000) + ' password=private-value' });
    const fake = semanticPort((_n, q) => choiceAnswer(q, 'jest', .99)); installJudgmentPort(fake.port);
    expect((await prepareProjectFramework(f.context, f.record)).framework).toBeUndefined(); expect(fake.requests).toHaveLength(0);
  });
  test('large manifests and repeated-call results reach Jev without arbitrary size caps', async () => {
    const f = setup(), tail = 'z'.repeat(800_000);
    project(f.root, { scripts: { test: 'node scripts/check-suite.js' }, description: tail });
    const fake = semanticPort((name, q) => name === 'framework' ? choiceAnswer(q, 'jest', .99) : noulAnswer(.01)); installJudgmentPort(fake.port);
    expect((await prepareProjectFramework(f.context, f.record)).framework).toBe('jest');
    expect((await readRepeatedCalls(history([tail, 'progress']), f.context, f.record))?.stuck).toBe(false);
    expect(fake.requests.filter(r => JSON.stringify(r.state).includes(tail))).toHaveLength(2);
  });
  test('service refresh does not interrupt admitted tools but an unavailable final checker cannot approve completion', async () => {
    const fixtures = Array.from({ length: 6 }, () => setup(1));
    const entered = deferred(), release = deferred(); let count = 0;
    installJudgmentPort(semanticPort((_n, q) => choiceAnswer(q, 'jest', .99)).port);
    for (const f of fixtures) {
      project(f.root, { scripts: { test: 'jest' } });
      f.controls.beforeTool = async () => { if (++count === fixtures.length) entered.resolve(); await release.promise; };
    }
    const pending = Promise.all(fixtures.map(f => runAgentTask(f.context, f.record)));
    await entered.promise; installJudgmentPort(undefined); release.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const f of fixtures) { expect(f.executions).toBe(1); expect(f.record.status).toBe('running'); expect(f.completed).toHaveLength(0); }
    installJudgmentPort(semanticPort(() => noulAnswer(.01)).port);
    await pending;
    for (const f of fixtures) expect(f.record.status).toBe('completed');
  });
  test('one spawn reading across multiple turns and real prompt use', async () => {
    const f = setup(4, n => String(n)); project(f.root, { dependencies: { vitest: '1' }, scripts: { test: 'node scripts/check-suite.js' } });
    const fake = semanticPort((name, q) => name === 'framework' ? choiceAnswer(q, 'jest', .99) : noulAnswer(.01)); installJudgmentPort(fake.port);
    await runAgentTask(f.context, f.record);
    expect(f.record.status).toBe('completed'); expect(fake.requests.filter(r => r.context?.battery === 'engine.agents.project-test-framework')).toHaveLength(1);
    expect(JSON.stringify(f.requests)).toContain('Test framework: jest'); expect(f.executions).toBe(4);
  });
});

describe('canonical repeated-call observation and actual runner', () => {
  test('complete changing results yield no nudge despite exact repeated calls', async () => {
    const f = setup(5, n => `progress ${n}`), fake = semanticPort((_n, _q, state) => { expect(JSON.stringify(state)).toContain('progress'); return noulAnswer(.01); }); installJudgmentPort(fake.port);
    await runAgentTask(f.context, f.record); expect(f.record.status).toBe('completed'); expect(f.executions).toBe(5); const feature = assertReadingPartition(fake.requests, Array<string>(4).fill('engine.agents.repeat-stuck'));
    for (const [index, request] of feature.entries()) {
      expect(Object.keys(request.questions)).toEqual(['stuck']);
      expect(request.state).toEqual({
        calls: Array.from({ length: index + 2 }, (_, turn) => ({
          signature: 'probe::{"job":"a"}',
          requested: { id: `call-${turn + 1}-0`, name: 'probe', arguments: { job: 'a' } },
          executed: { name: 'probe', arguments: '{"job":"a"}' },
          result: { success: true, output: `progress ${turn + 1}`, callId: `call-${turn + 1}-0` },
        })),
        repeatedSignature: 'probe::{"job":"a"}',
      });
    }
    expect(JSON.stringify(f.requests)).not.toContain('You are repeating the same tool call'); expect(JSON.stringify(f.requests)).not.toContain('You have already executed this exact call');
  });
  test('settled stuck injects existing three/five thresholds using honest result wording', async () => {
    const f = setup(5); installJudgmentPort(semanticPort(() => noulAnswer(.99)).port); await runAgentTask(f.context, f.record);
    expect(f.record.status).toBe('completed'); expect(f.executions).toBe(5);
    expect(JSON.stringify(f.snapshot)).toContain('You have already executed this exact call'); expect(JSON.stringify(f.requests)).toContain('You are repeating the same tool call');
    expect(JSON.stringify(f.requests)).not.toContain('identical arguments and results');
  });
  test('unavailable, uncertain and malformed advisory readings do not stop the agent', async () => {
    for (const port of [undefined, semanticPort(() => noulAnswer(.5)).port, semanticPort(() => ({ type: 'noul', noul: NaN })).port]) {
      const f = setup(5); installJudgmentPort(port);
      const restored = !port ? setTimeout(() => installJudgmentPort(semanticPort(() => noulAnswer(.01)).port), 20) : undefined;
      await runAgentTask(f.context, f.record);
      if (restored) clearTimeout(restored);
      expect(f.executions).toBe(5); expect(f.requests).toHaveLength(6); expect(f.record.status).toBe('completed');
      expect(JSON.stringify(f.requests)).not.toContain('You are repeating');
    }
  });
  test('private result tails are withheld and completion stays held until cancelled', async () => {
    const f = setup(5, () => 'x'.repeat(200_000) + ' password=private-value'), fake = semanticPort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
    const pending = runAgentTask(f.context, f.record);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.completed).toHaveLength(0);
    f.record.status = 'cancelled'; f.controller.abort(); await pending;
    expect(JSON.stringify(fake.requests)).not.toContain('private-value');
    expect(JSON.stringify(fake.requests)).not.toContain('x'.repeat(200_000));
    expect(fake.requests.filter(r => r.context?.battery === 'engine.agents.repeat-stuck')).toHaveLength(0);
    expect(f.executions).toBe(5); expect(f.record.status).toBe('cancelled'); expect(f.completed).toHaveLength(0);
  });
  test('run cancellation interrupts a non-cooperating judgment without stale messages', async () => {
    const f = setup(5), start = deferred(), release = deferred(), fake = semanticPort(() => noulAnswer(.99));
    installJudgmentPort({ model: fake.port.model, async ask(request) { if (request.context?.battery !== 'engine.agents.repeat-stuck') return fake.port.ask(request); expect(Object.keys(request.questions)).toEqual(['stuck']); expect(JSON.stringify(request.state)).toContain('same'); start.resolve(); await release.promise; return fake.port.ask(request); } });
    const pending = runAgentTask(f.context, f.record); await start.promise; f.record.status = 'cancelled'; f.controller.abort(); await pending;
    release.resolve(); await Promise.resolve(); expect(f.executions).toBe(2); expect(f.events).toEqual(['cancelled']); expect(JSON.stringify(f.requests)).not.toContain('You are repeating');
  });
  test('changed result source revokes a hint, service refresh does not revoke consumed observations', async () => {
    const f = setup(), calls = history(); const fake = semanticPort(() => noulAnswer(.99)); installJudgmentPort(fake.port);
    const observed = await readRepeatedCalls(calls, f.context, f.record); calls.push(...history(['changed'])); expect(observed!.assertCurrent).toThrow();
    const second = await readRepeatedCalls(history(), f.context, f.record); installJudgmentPort(semanticPort(() => noulAnswer(.01)).port); expect(second!.assertCurrent).not.toThrow();
  });
  test('project, request and configuration source changes cannot publish late readings', async () => {
    for (const change of ['project', 'request', 'config', 'same-port']) {
      const f = setup(), start = deferred(), release = deferred(), fake = semanticPort((_n, q) => choiceAnswer(q, 'jest', .99)); project(f.root, { scripts: { test: 'node scripts/check-suite.js' } });
      let current = true;
      const installed: typeof fake.port = { model: fake.port.model, async ask(request) { if (request.context?.battery === 'engine.redaction.field-kind') return fake.port.ask(request); start.resolve(); await release.promise; return fake.port.ask(request); } };
      bindJudgmentPortAuthority(installed, () => ({ identity: f.context, assertCurrent() { if (!current) throw new Error('retired'); } }));
      installJudgmentPort(installed);
      const pending = prepareProjectFramework(f.context, f.record); await start.promise;
      if (change === 'project') project(f.root, { scripts: { test: 'bun test' } });
      if (change === 'request') f.record.task = 'new request';
      if (change === 'config') (f.context as { configManager?: unknown }).configManager = { get: () => 5 };
      if (change === 'same-port') current = false; release.resolve();
      if (change === 'request' || change === 'config') await expect(pending).rejects.toThrow();
      else expect((await pending).framework).toBeUndefined();
    }
  });
});

describe('actual-run observation lifetime', () => {
  test('manifest changes after classification do not cancel provider requests', async () => {
    const f = setup(); project(f.root, { scripts: { test: 'jest' } });
    installJudgmentPort(semanticPort((_n, q) => choiceAnswer(q, 'jest', .99)).port);
    (f.context as { beforeProviderRequest?: () => Promise<void> }).beforeProviderRequest = async () => { project(f.root, { scripts: { test: 'bun test' } }); };
    await runAgentTask(f.context, f.record); expect(f.requests).toHaveLength(1); expect(f.record.status).toBe('completed');
  });
  test('port replacement discards the pending hint and continues with fresh readings', async () => {
    const f = setup(5), start = deferred(), release = deferred(), fake = semanticPort(() => noulAnswer(.99));
    installJudgmentPort({ model: fake.port.model, async ask(request) { if (request.context?.battery !== 'engine.agents.repeat-stuck') return fake.port.ask(request); expect(Object.keys(request.questions)).toEqual(['stuck']); expect(JSON.stringify(request.state)).toContain('same'); start.resolve(); await release.promise; return fake.port.ask(request); } });
    const pending = runAgentTask(f.context, f.record); await start.promise;
    installJudgmentPort(semanticPort(() => noulAnswer(.01)).port); await pending; release.resolve();
    expect(f.executions).toBe(5); expect(f.requests).toHaveLength(6); expect(f.record.status).toBe('completed');
    expect(JSON.stringify(f.requests)).not.toContain('You are repeating');
  });
  test('config retirement during final settlement prevents completed delivery', async () => {
    const f = setup(2); installJudgmentPort(semanticPort(() => noulAnswer(.01)).port);
    (f.context as { beforeRunSettlement?: () => Promise<void> }).beforeRunSettlement = async () => { (f.context as { configManager?: unknown }).configManager = { get: () => 5 }; };
    await runAgentTask(f.context, f.record); expect(f.record.status).toBe('failed'); expect(f.events).not.toContain('completed');
  });
  test('changed result source discards the pending hint', async () => {
    const f = setup(), calls = history(), start = deferred(), release = deferred(), fake = semanticPort(() => noulAnswer(.99));
    installJudgmentPort({ model: fake.port.model, async ask(request) { if (request.context?.battery !== 'engine.agents.repeat-stuck') return fake.port.ask(request); expect(Object.keys(request.questions)).toEqual(['stuck']); expect(JSON.stringify(request.state)).toContain('same'); start.resolve(); await release.promise; return fake.port.ask(request); } });
    const pending = readRepeatedCalls(calls, f.context, f.record); await start.promise; calls.splice(1, 1, ...history(['new result'])); release.resolve();
    expect(await pending).toBeUndefined();
  });
  test('exact mechanical turn ceiling remains independent of progressing readings', async () => {
    const f = setup(10, n => String(n)); f.record.maxTurns = 3; installJudgmentPort(semanticPort(() => noulAnswer(.01)).port);
    await runAgentTask(f.context, f.record); expect(f.executions).toBe(3); expect(f.record.failureReason).toBe('max_turns');
  });
});

describe('review regressions: complete observation through tool effects', () => {
  test('optional missing, malformed and unreadable manifests omit without any reading', async () => {
    for (const kind of ['missing', 'malformed', 'unreadable']) {
      const f = setup(), path = join(f.root, 'package.json'), fake = semanticPort((_n, q) => choiceAnswer(q, 'jest', .99));
      if (kind === 'malformed') writeFileSync(path, '{oops');
      if (kind === 'unreadable') mkdirSync(path);
      installJudgmentPort(fake.port); await runAgentTask(f.context, f.record); assertReadingPartition(fake.requests, []); expect(f.record.status).toBe('completed'); expect(f.completed).toHaveLength(1);
      expect(JSON.stringify(f.requests)).not.toContain('Test framework:');
    }
  });
  test('original source covers canonical recorder attachment, before any reading is retained', async () => {
    const f = setup(), fake = semanticPort((_n, q) => choiceAnswer(q, 'jest', .99)); project(f.root, { scripts: { test: 'node scripts/check-suite.js' } });
    let attachments = 0;
    const port: typeof fake.port = { model: fake.port.model, recorder: { recordReadings() { attachments++; }, recordAction() {} }, async ask(request) {
      const result = await fake.port.ask(request); project(f.root, { scripts: { test: 'bun test' } }); return { ...result, decisionId: 'changed-source' };
    } };
    installJudgmentPort(port); expect((await prepareProjectFramework(f.context, f.record)).framework).toBeUndefined(); expect(attachments).toBe(0);
  });
  test('manifest changes during provider retry or streaming do not revoke the run', async () => {
    for (const stage of ['retry', 'delta']) {
      const f = setup(); project(f.root, { scripts: { test: 'jest' } }); installJudgmentPort(semanticPort((_n, q) => choiceAnswer(q, 'jest', .99)).port);
      const retire = () => project(f.root, { scripts: { test: 'bun test' } });
      if (stage === 'retry') f.controls.beforeRetry = retire; else f.controls.beforeDelta = retire;
      await runAgentTask(f.context, f.record); expect(f.streams).toHaveLength(1); expect(f.completed).toHaveLength(1); expect(f.executions).toBe(0);
    }
  });
  test('permission retirement prevents the first tool and stale result publication', async () => {
    const f = setup(1); let reports = 0; f.record.contractUnitId = 'unit';
    (f.context as { contractHooks?: unknown }).contractHooks = { onTurnEnd() { reports++; } };
    (f.context as { permissionManager?: unknown }).permissionManager = { getBackgroundAgentsMode: () => 'inherit', async checkDetailed() {
      f.record.task = 'replacement'; return { approved: true };
    } };
    await expect(runAgentTask(f.context, f.record)).rejects.toBeInstanceOf(OrchestratorObservationHeldError); expect(f.executions).toBe(0); expect(reports).toBe(0); expect(f.completed).toHaveLength(0);
  });
  test('projection retirement releases owned projection and never invokes tool body', async () => {
    const f = setup(1); let released = 0, bodies = 0;
    f.tools.unregister('probe');
    f.tools.register({ definition: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: { job: { type: 'string' } } } }, async execute() { bodies++; return { success: true, output: 'no' }; } }, {
      inputProjection: { async project(request) { f.record.task = 'replacement'; return { status: 'projected', args: request.args, async release() { released++; } }; } },
    });
    await expect(runAgentTask(f.context, f.record)).rejects.toBeInstanceOf(OrchestratorObservationHeldError); expect(bodies).toBe(0); expect(released).toBe(1); expect(f.completed).toHaveLength(0);
  });
  test('tool one retirement suppresses tool two, result hook, contract publication and completed event', async () => {
    const f = setup(1); f.controls.batchSize = 2; let hooks = 0, reports = 0; f.record.contractUnitId = 'unit';
    (f.context as { onToolExecuted?: AgentOrchestratorRunContext['onToolExecuted'] }).onToolExecuted = () => { hooks++; };
    (f.context as { contractHooks?: unknown }).contractHooks = { onTurnEnd() { reports++; } };
    f.controls.beforeTool = async () => { f.record.task = 'replacement'; };
    await expect(runAgentTask(f.context, f.record)).rejects.toBeInstanceOf(OrchestratorObservationHeldError); expect(f.executions).toBe(1); expect(hooks).toBe(0); expect(reports).toBe(0); expect(f.completed).toHaveLength(0);
  });
  test('permission-modified effective arguments and full results reach repeat reader', async () => {
    const f = setup(3); const executed: unknown[] = []; f.controls.beforeTool = async args => { executed.push(args); };
    (f.context as { permissionManager?: unknown }).permissionManager = { getBackgroundAgentsMode: () => 'inherit', async checkDetailed() { return { approved: true, modifiedArgs: { job: 'authorized-effective' } }; } };
    const fake = semanticPort(() => noulAnswer(.01)); installJudgmentPort(fake.port); await runAgentTask(f.context, f.record);
    expect(executed).toEqual(Array.from({ length: 3 }, () => ({ job: 'authorized-effective' }))); const feature = assertReadingPartition(fake.requests, ['engine.agents.repeat-stuck', 'engine.agents.repeat-stuck']);
    for (const [index, request] of feature.entries()) {
      expect(Object.keys(request.questions)).toEqual(['stuck']);
      expect(request.state).toEqual({
        calls: Array.from({ length: index + 2 }, (_, turn) => ({
          signature: 'probe::{"job":"a"}',
          requested: { id: `call-${turn + 1}-0`, name: 'probe', arguments: { job: 'a' } },
          executed: { name: 'probe', arguments: '{"job":"authorized-effective"}' },
          result: { success: true, output: 'same result', callId: `call-${turn + 1}-0` },
        })),
        repeatedSignature: 'probe::{"job":"a"}',
      });
    } expect(f.completed).toHaveLength(1);
  });
  test('late rejected reader after cancellation is consumed without completion', async () => {
    const f = setup(3), start = deferred(); let reject!: (reason: unknown) => void;
    const fake = semanticPort(() => noulAnswer(.99));
    installJudgmentPort({ model: fake.port.model, ask: async request => {
      if (request.context?.battery !== 'engine.agents.repeat-stuck') return fake.port.ask(request);
      expect(Object.keys(request.questions)).toEqual(['stuck']);
      expect(JSON.stringify(request.state)).toContain('same result');
      start.resolve(); return new Promise<never>((_resolve, rejectWork) => { reject = rejectWork; });
    } });
    const pending = runAgentTask(f.context, f.record); await start.promise; expect(f.executions).toBe(2); expect(f.requests).toHaveLength(2); f.record.status = 'cancelled'; f.controller.abort(); await pending;
    reject(new Error('late rejection')); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.completed).toHaveLength(0); expect(f.events).toEqual(['cancelled']);
  });
  test('consumed repeat hint does not block the next tool after same-port retirement', async () => {
    const f = setup(4), fake = semanticPort(() => noulAnswer(.01)); let current = true, permissions = 0;
    bindJudgmentPortAuthority(fake.port, () => ({ identity: f.context, assertCurrent() { if (!current) throw new Error('retired'); } })); installJudgmentPort(fake.port);
    (f.context as { permissionManager?: unknown }).permissionManager = { getBackgroundAgentsMode: () => 'inherit', async checkDetailed() { if (++permissions === 3) current = false; return { approved: true }; } };
    const pending = runAgentTask(f.context, f.record);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.executions).toBe(4); expect(f.completed).toHaveLength(0);
    f.record.status = 'cancelled'; f.controller.abort(); await pending;
    expect(f.record.status).toBe('cancelled');
  });
});

describe('cancelled batch mechanical transcript closure', () => {
  test('cancelled tool batch records only fixed terminal outcomes, no late payload or remaining effects', async () => {
    const f = setup(1, () => 'LATE_PRIVATE_TOOL_PAYLOAD'), entered = deferred(), release = deferred();
    f.controls.batchSize = 2;
    let hooks = 0, reports = 0;
    (f.context as { onToolExecuted?: AgentOrchestratorRunContext['onToolExecuted'] }).onToolExecuted = () => { hooks++; };
    f.record.contractUnitId = 'unit';
    (f.context as { contractHooks?: unknown }).contractHooks = { onTurnEnd() { reports++; } };
    f.controls.beforeTool = async () => { entered.resolve(); await release.promise; };
    const pending = runAgentTask(f.context, f.record); await entered.promise;
    f.record.status = 'cancelled'; f.controller.abort(); release.resolve(); await pending;
    const results = f.snapshot.filter((message): message is { role: 'tool'; callId: string; content: string; outcome: string; toolName: string } =>
      !!message && typeof message === 'object' && 'role' in message && message.role === 'tool');
    expect(results).toEqual(['call-1-0', 'call-1-1'].map(callId => ({
      role: 'tool', callId, content: 'Error: Tool invocation cancelled', outcome: 'cancelled', toolName: 'probe',
    })));
    expect(f.executions).toBe(1); expect(hooks).toBe(0); expect(reports).toBe(0);
    expect(f.requests).toHaveLength(1); expect(f.completed).toHaveLength(0); expect(f.events).toEqual(['cancelled']);
    await Promise.resolve(); expect(f.snapshot.filter(message => JSON.stringify(message).includes('Tool invocation cancelled'))).toHaveLength(2);
    expect(JSON.stringify(f.snapshot)).not.toContain('LATE_PRIVATE_TOOL_PAYLOAD');
  });
  test('a reused call ID preserves prior success and closes only the second cancelled batch once', async () => {
    const f = setup(2, n => `successful result ${n}`);
    const provider = f.context.resolveProviderForRecord(f.context.providerRegistry, f.record, { id: 'fake', provider: 'fake', registryKey: 'fake:fake' }).provider;
    const chat = provider.chat.bind(provider);
    provider.chat = async request => { const response = await chat(request); return { ...response, toolCalls: response.toolCalls.map(call => ({ ...call, id: 'reused-call' })) }; };
    f.controls.beforeTool = async () => { if (f.executions === 2) { f.record.status = 'cancelled'; f.controller.abort(); } };
    await runAgentTask(f.context, f.record);
    const text = JSON.stringify(f.snapshot);
    expect(text.match(/successful result 1/g)).toHaveLength(1);
    expect(text.match(/Tool invocation cancelled/g)).toHaveLength(1);
    expect(text).not.toContain('successful result 2'); expect(f.completed).toHaveLength(0);
    const results = f.snapshot.filter((message): message is { role: 'tool'; callId: string; outcome: string } =>
      !!message && typeof message === 'object' && 'role' in message && message.role === 'tool');
    expect(results.map(({ callId, outcome }) => ({ callId, outcome }))).toEqual([
      { callId: 'reused-call', outcome: 'ok' }, { callId: 'reused-call', outcome: 'cancelled' },
    ]);
  });
  test('retirement without actual cancellation cannot create a cancellation record', async () => {
    for (const cancelledStatus of [false, true]) {
      const f = setup(1);
      f.controls.beforeTool = async () => { f.record.task = 'retired request'; if (cancelledStatus) f.record.status = 'cancelled'; };
      await expect(runAgentTask(f.context, f.record)).rejects.toBeInstanceOf(OrchestratorObservationHeldError);
      expect(JSON.stringify(f.snapshot)).not.toContain('Tool invocation cancelled');
      expect(f.snapshot.filter(message => !!message && typeof message === 'object' && 'role' in message && message.role === 'tool')).toHaveLength(0);
    }
  });
  test('config and canonical-port retirement without abort do not fabricate cancelled results', async () => {
    for (const kind of ['config', 'port']) {
      const f = setup(1); project(f.root, { scripts: { test: 'jest' } });
      installJudgmentPort(semanticPort((_name, question) => choiceAnswer(question, 'jest', .99)).port);
      let maxTurns = 50;
      (f.context as { configManager?: AgentOrchestratorRunContext['configManager'] }).configManager = { get: (key: string) => key === 'agents.maxTurns' ? maxTurns : undefined } as NonNullable<AgentOrchestratorRunContext['configManager']>;
      f.controls.beforeTool = async () => { if (kind === 'config') maxTurns++; else installJudgmentPort(undefined); };
      const pending = runAgentTask(f.context, f.record);
      if (kind === 'port') {
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(f.completed).toHaveLength(0);
        installJudgmentPort(semanticPort(() => noulAnswer(.01)).port);
      }
      await pending;
      expect(f.controller.signal.aborted).toBe(false);
      if (kind === 'config') expect(f.record.failureReason).toBe('semantic_observation_held');
      else expect(f.record.status).toBe('completed');
      expect(JSON.stringify(f.snapshot)).not.toContain('Tool invocation cancelled');
    }
  });
  test('semantic configuration and port retirement do not block genuine original-run cancellation bookkeeping', async () => {
    const f = setup(1); project(f.root, { scripts: { test: 'jest' } });
    installJudgmentPort(semanticPort((_name, question) => choiceAnswer(question, 'jest', .99)).port);
    f.controls.beforeTool = async () => {
      (f.context as { configManager?: AgentOrchestratorRunContext['configManager'] }).configManager = { get: () => undefined } as NonNullable<AgentOrchestratorRunContext['configManager']>;
      installJudgmentPort(undefined); f.record.status = 'cancelled'; f.controller.abort();
    };
    await runAgentTask(f.context, f.record);
    expect(JSON.stringify(f.snapshot).match(/Tool invocation cancelled/g)).toHaveLength(1);
    expect(f.completed).toHaveLength(0); expect(f.events).toEqual(['cancelled']);
  });
  test('replacement signal with identical cancelled status cannot inherit original transcript closure', async () => {
    const f = setup(1), replacement = new AbortController(); let signal = f.controller.signal;
    (f.context as { getCancellationSignal: NonNullable<AgentOrchestratorRunContext['getCancellationSignal']> }).getCancellationSignal = () => signal;
    f.controls.beforeTool = async () => { f.record.status = 'cancelled'; f.controller.abort(); replacement.abort(); signal = replacement.signal; };
    await expect(runAgentTask(f.context, f.record)).rejects.toBeInstanceOf(OrchestratorObservationHeldError);
    expect(JSON.stringify(f.snapshot)).not.toContain('Tool invocation cancelled'); expect(f.completed).toHaveLength(0);
  });
  test('same-record same-signal successor run owns its own conversation even with identical call IDs', async () => {
    const f = setup(2), firstEntered = deferred(), secondEntered = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
    const provider = f.context.resolveProviderForRecord(f.context.providerRegistry, f.record, { id: 'fake', provider: 'fake', registryKey: 'fake:fake' }).provider;
    const chat = provider.chat.bind(provider);
    provider.chat = async request => { const response = await chat(request); return { ...response, toolCalls: response.toolCalls.map(call => ({ ...call, id: 'identical-call' })) }; };
    const sources: Array<() => unknown[]> = [];
    (f.context as { registerConversationSource: NonNullable<AgentOrchestratorRunContext['registerConversationSource']> }).registerConversationSource = (_id, source) => { sources.push(source); };
    let bodies = 0;
    f.controls.beforeTool = async () => { if (++bodies === 1) { firstEntered.resolve(); await releaseFirst.promise; } else { secondEntered.resolve(); await releaseSecond.promise; } };
    const first = runAgentTask(f.context, f.record); await firstEntered.promise;
    const second = runAgentTask(f.context, f.record); await secondEntered.promise;
    f.record.status = 'cancelled'; f.controller.abort(); releaseFirst.resolve(); await expect(first).rejects.toBeInstanceOf(OrchestratorObservationHeldError);
    expect(JSON.stringify(sources[0]?.())).not.toContain('Tool invocation cancelled');
    releaseSecond.resolve(); await second;
    expect(JSON.stringify(sources[0]?.())).not.toContain('Tool invocation cancelled');
    expect(JSON.stringify(sources[1]?.()).match(/Tool invocation cancelled/g)).toHaveLength(1);
    expect(f.completed).toHaveLength(0);
  });
});

describe('additive registry restriction preserves admitted bindings', () => {
  test('definition or executor replacement during permission cannot reuse approval', async () => {
    for (const replacement of ['definition', 'executor']) {
      const f = setup(1); let replacements = 0;
      (f.context as { permissionManager?: unknown }).permissionManager = { getBackgroundAgentsMode: () => 'inherit', async checkDetailed() {
        const original = f.tools.list()[0]!;
        if (replacement === 'definition') original.definition.description = 'changed definition';
        else { f.tools.unregister('probe'); f.tools.register({ definition: original.definition, async execute() { replacements++; return { success: true, output: 'replacement' }; } }); }
        return { approved: true };
      } };
      await runAgentTask(f.context, f.record); expect(f.executions).toBe(0); expect(replacements).toBe(0); expect(f.completed).toHaveLength(0);
    }
  });
  test('ordinary repair cannot silently execute different permission-approved arguments', async () => {
    const tools = new ToolRegistry(); let bodies = 0;
    tools.register({ definition: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } }, async execute() { bodies++; return { success: true }; } });
    const approved = { count: '7' };
    await expect(tools.execute('call', 'probe', approved, { assertCurrent(args) { if (args && JSON.stringify(args) !== JSON.stringify(approved)) throw new Error('admitted arguments changed'); } })).rejects.toThrow();
    expect(bodies).toBe(0);
  });
  test('prepared deferred effect keeps additive restriction alongside its existing admission', async () => {
    const tools = new ToolRegistry(), start = deferred(), release = deferred(); let current = true, effects = 0, admissions = 0;
    tools.register({ definition: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }, async execute(_args, opts) {
      start.resolve(); await release.promise; opts?.assertCurrent?.(); effects++; return { success: true };
    } });
    const prepared = await tools.prepareCall('call', 'probe', {});
    const work = tools.executePrepared(prepared, () => { admissions++; }, { assertCurrent() { if (!current) throw new Error('original observation retired'); } });
    await start.promise; current = false; release.resolve(); await expect(work).rejects.toThrow();
    expect(admissions).toBe(1); expect(effects).toBe(0);
  });
  test('ordinary deferred effect keeps additive restriction without altering unrelated callers', async () => {
    const tools = new ToolRegistry(), start = deferred(), release = deferred(); let current = true, effects = 0;
    tools.register({ definition: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }, async execute(_args, opts) {
      start.resolve(); await release.promise; opts?.assertCurrent?.(); effects++; return { success: true };
    } });
    const work = tools.execute('call', 'probe', {}, { assertCurrent() { if (!current) throw new Error('original observation retired'); } });
    await start.promise; current = false; release.resolve(); await expect(work).rejects.toThrow(); expect(effects).toBe(0);
    await tools.execute('unrestricted', 'probe', {}); expect(effects).toBe(1);
  });
});

describe('real invocation guard retains restriction without minting admission', () => {
  test('ordinary invocation guard remains false while current and throws when retired', () => {
    const args = {}, options = { assertCurrent() { if (!current) throw new Error('retired'); } }; let current = true;
    expect(assertCurrentExecInvocation(args)).toBe(false);
    expect(assertCurrentExecInvocation(args, options)).toBe(false);
    current = false; expect(() => assertCurrentExecInvocation(args, options)).toThrow('retired');
  });
  test('projected deferred body carries exact original callback into the real invocation guard', async () => {
    const tools = new ToolRegistry(), start = deferred(), release = deferred(); let current = true, effects = 0;
    const guard = () => { if (!current) throw new Error('retired'); };
    tools.register({ definition: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }, async execute(args, opts) {
      expect(opts?.assertCurrent).toBe(guard); expect(assertCurrentExecInvocation(args, opts)).toBe(false);
      start.resolve(); await release.promise; assertCurrentExecInvocation(args, opts); effects++; return { success: true };
    } }, { inputProjection: { async project(request) { return { status: 'projected', args: request.args }; } } });
    const work = tools.execute('call', 'probe', {}, { assertCurrent: guard });
    await start.promise; current = false; release.resolve(); await expect(work).rejects.toThrow(); expect(effects).toBe(0);
  });
  test('ordinary Exec cannot launch after its caller retires during preparation', async () => {
    const f = setup(), manager = new ProcessManager(); let current = true;
    const launches = spyOn(manager, 'spawn').mockImplementation(async () => { throw new Error('A retired run must not spawn'); });
    const registry = new ToolRegistry(); registry.register(createExecTool(manager, { defaultWorkingDirectory: f.root,
      overflowHandler: new OverflowHandler({ baseDir: f.root }), credentialEnvScrub: { enabled: false }, ownerTerminal: AGENT_OWNER_TERMINAL_GUARD }));
    try {
      const work = registry.execute('call', 'exec', { commands: [{ cmd: 'printf actual-deferred-exec', background: true }] }, { assertCurrent() { if (!current) throw new Error('original observation retired'); } });
      current = false; await expect(work).rejects.toThrow(); expect(launches).not.toHaveBeenCalled();
    } finally { launches.mockRestore(); await manager.close(); }
  });
});

test('prepared retirement releases only its owned projection exactly once before admission or body', async () => {
  const registry = new ToolRegistry(); let releases = 0, admissions = 0, bodies = 0;
  registry.register({ definition: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } }, async execute() { bodies++; return { success: true }; } }, {
    inputProjection: { async project(request) { return { status: 'projected', args: request.args, async release() { releases++; } }; } },
  });
  const prepared = await registry.prepareCall('owned', 'probe', {});
  const unrelated = await registry.prepareCall('unrelated', 'probe', {});
  await expect(registry.executePrepared({ ...prepared }, () => { admissions++; }, { assertCurrent() { throw new Error('retired'); } })).rejects.toThrow();
  expect(releases).toBe(0);
  await expect(registry.executePrepared(prepared, () => { admissions++; }, { assertCurrent() { throw new Error('retired'); } })).rejects.toThrow('retired');
  expect(releases).toBe(1); expect(admissions).toBe(0); expect(bodies).toBe(0);
  await expect(registry.executePrepared(prepared, () => { admissions++; })).rejects.toThrow(); expect(releases).toBe(1);
  await registry.executePrepared(unrelated, () => { admissions++; }); expect(releases).toBe(2); expect(admissions).toBe(1); expect(bodies).toBe(1);
});

function assertReadingPartition(requests: ReadonlyArray<{ context?: { battery?: string }; questions: object; state: unknown }>, batteries: readonly string[]) {
  const observations = requests.filter(request => !['engine.core.response-completion', 'engine.core.execution-assurance', 'engine.core.delegation-consolidation'].includes(request.context?.battery ?? ''));
  expect(observations.map(request => request.context?.battery)).toEqual([...batteries]);
  return observations;
}


describe('standalone completion enforcement', () => {
  test('a standalone coordinator must incorporate its own delegated results', async () => {
    const f = setup(1);
    f.record.task = 'Consolidate the engine and UI review.';
    f.record.tools = ['agent'];
    f.controls.toolName = 'agent';
    f.controls.finalReplies = ['Only the engine review.', 'Both engine and UI findings.'];
    f.tools.register({ definition: { name: 'agent', description: 'Read child result', parameters: { type: 'object', properties: {} } }, async execute() {
      return { success: true, output: JSON.stringify({ agentId: 'child' }) };
    } });
    (f.context as { agentManager?: unknown }).agentManager = { list: () => [{ id: 'child', task: 'Review UI', status: 'completed', fullOutput: 'UI finding' }], getConversationSnapshot: () => [] };
    const fake = semanticPort(() => noulAnswer(.01), (name, state) => name === 'missing_results' && (state as { response: string }).response === 'Only the engine review.' ? .99 : .01);
    installJudgmentPort(fake.port);
    await runAgentTask(f.context, f.record);
    const consolidation = fake.requests.filter(request => request.context?.battery === 'engine.core.delegation-consolidation');
    expect(consolidation).toHaveLength(2);
    expect((consolidation[0]!.state as { delegated: { id: string }[] }).delegated.map(agent => agent.id)).toEqual(['child']);
    expect(f.completed).toHaveLength(1);
    expect(f.record.fullOutput).toBe('Both engine and UI findings.');
  });

  test('an honest incomplete final returns to the provider with its correction before any completed event', async () => {
    const f = setup();
    const partial = 'I wrote the report, but the original review is still unfinished.';
    f.record.task = 'Finish the complete repository review and its report.';
    f.controls.finalReplies = [partial, 'Finished the assigned review and report.'];
    installJudgmentPort(semanticPort(() => noulAnswer(.01), (name, state) => name === 'unfinished' && (state as { response?: string }).response === partial ? .99 : .01).port);
    await runAgentTask(f.context, f.record);
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain('[Response completion check]');
    expect(f.completed).toHaveLength(1);
    expect(f.record.fullOutput).toBe('Finished the assigned review and report.');
  });

  test('retirement during final settlement cannot publish a previously accepted completion', async () => {
    const f = setup();
    installJudgmentPort(semanticPort(() => noulAnswer(.01)).port);
    (f.context as { beforeRunSettlement?: () => Promise<void> }).beforeRunSettlement = async () => { installJudgmentPort(undefined); };
    await runAgentTask(f.context, f.record);
    expect(f.completed).toHaveLength(0);
    expect(f.record.status).toBe('failed');
    expect(f.events).toContain('failed');
  });

  test('changing the actual output during settlement cannot reuse the checked draft', async () => {
    const f = setup();
    installJudgmentPort(semanticPort(() => noulAnswer(.01)).port);
    (f.context as { beforeRunSettlement?: () => Promise<void> }).beforeRunSettlement = async () => { f.record.fullOutput = 'Unverified replacement output'; };
    await runAgentTask(f.context, f.record);
    expect(f.completed).toHaveLength(0);
    expect(f.record.status).toBe('failed');
  });
});


test('only a host-owned contract proposal defers fulfillment to the contract plan validator; a planner label cannot bypass completion', async () => {
  const fake = semanticPort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
  const owned = setup(); owned.record.template = 'planner'; owned.record.task = 'Propose a plan. Repository map: ' + 'x'.repeat(1_722_884);
  bindContractPlanConsumer(owned.record);
  owned.controls.finalReplies = ['{"goal":"review","groups":[]}'];
  await runAgentTask(owned.context, owned.record);
  expect(owned.record.status).toBe('completed');
  expect(fake.requests.filter(request => request.context?.battery === 'engine.core.response-completion')).toHaveLength(0);
  const ordinary = setup(); ordinary.record.template = 'planner';
  await runAgentTask(ordinary.context, ordinary.record);
  expect(ordinary.record.status).toBe('completed');
  expect(fake.requests.filter(request => request.context?.battery === 'engine.core.response-completion')).toHaveLength(1);
});
