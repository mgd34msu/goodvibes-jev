import { describe, expect, test } from 'bun:test';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { createEmitterContext } from '../sdk/src/platform/core/orchestrator-runtime.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { classifyIntent } from '../sdk/src/platform/core/intent-classifier.js';
import { maybeEmitAdaptivePlannerDecision, prepareConversationForTurn } from '../sdk/src/platform/core/orchestrator-turn-helpers.js';
import type { ExecutionPlan } from '../sdk/src/platform/core/execution-plan.js';
import { AdaptivePlanner } from '../sdk/src/platform/core/adaptive-planner.js';
import { useCoreReadings } from './_helpers/core-readings.ts';

const readings = useCoreReadings({ intent: 'task', needsPlan: false, risk: 0 });
const providerRegistry = () => ({ getCurrentModel: () => ({ id: 'test', provider: 'test', registryKey: 'test:test', displayName: 'test', description: '', capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 128_000, selectable: true }) });
const systemMessages = (conversation: ConversationManager) => conversation.getMessageSnapshot().filter((message) => message.role === 'system').map((message) => String(message.content));
const prime = (conversation: ConversationManager, text: string) => prepareConversationForTurn(conversation, providerRegistry(), text, undefined, 'session-1');

const retrospective = [
  'list all of the things you did, from start to finish, to get qemu working. we will need to make a workflow to follow for other installations of goodvibes. additionally you should list the things that should be installed in the qemu image that were not already there, like the other repls for example. I want to make an easy to follow instruction guide that can be fed to llms so setup can be easier.',
  'write an instruction guide for installing the QEMU image on another laptop.',
  'summarize the workflow we used to get QEMU working.',
  'document the setup steps and list what should be installed in the image.',
  'make an easy to follow guide for future installations.',
];

describe('recorded turn intent and project priming', () => {
  test.each(retrospective)('retrospective documentation uses the supplied reading: %s', async (prompt) => {
    const result = await classifyIntent(prompt);
    expect(result.intent).toBe('task');
    expect(result.confidence).toBe(0.97);
    expect(result.outcome).toBe('act');
    expect(result.signals).toEqual(['intent:task', 'planning:no', 'outcome:act']);
    expect(readings.requests[0]?.state).toEqual({ purpose: 'conversation', work: prompt });
    expect(readings.requests[0]?.context?.battery).toBe('engine.core.turn-shape');
  });

  test('a long retrospective request does not inject implementation project mode', async () => {
    const conversation = new ConversationManager();
    await prime(conversation, retrospective[0]!);
    expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(false);
  });

  test('a short project primes only because the plan-needed reading says yes', async () => {
    readings.set({ intent: 'project', needsPlan: true });
    const conversation = new ConversationManager();
    await prime(conversation, 'Replace billing safely.');
    expect(systemMessages(conversation).filter((message) => message.includes('[Project mode]'))).toHaveLength(1);
    expect(readings.requests).toHaveLength(1);
  });

  test('old trigger words cannot override a contrary reading', async () => {
    readings.set({ intent: 'chat', needsPlan: false });
    const text = 'Build architecture phases, parallel agents, src/app.ts, tests and deployments. '.repeat(20);
    const conversation = new ConversationManager();
    const result = await classifyIntent(text);
    expect(result.intent).toBe('chat');
    await prime(conversation, text);
    expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(false);
  });

  test('an unsettled planning reading does not inject a guessed plan', async () => {
    readings.set({ intent: 'project', needsPlan: 'uncertain', confidence: 0.57 });
    const result = await classifyIntent('Build a system.');
    expect(result.confidence).toBe(0.57);
    expect(result.outcome).not.toBe('act');
    const conversation = new ConversationManager();
    await prime(conversation, 'Build a system.');
    expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(false);
  });

  test('the empty-text choice remains an explicit reading', async () => {
    readings.set({ intent: 'chat' });
    expect((await classifyIntent('')).intent).toBe('chat');
    expect(readings.requests[0]?.state).toEqual({ purpose: 'conversation', work: '' });
  });

  test('missing and failed judgment never fall back to the old heuristics', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      await expect(classifyIntent('build a task')).rejects.toBeInstanceOf(JudgmentPortMissingError);
      const failure = new JudgmentError('unavailable', 'synthetic outage');
      installJudgmentPort({ model: 'test', ask: async () => { throw failure; } });
      const conversation = new ConversationManager();
      await expect(prime(conversation, 'Keep my submitted request')).rejects.toBe(failure);
      expect(conversation.getMessageSnapshot().some((message) => message.role === 'user' && message.content === 'Keep my submitted request')).toBe(true);
      expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(false);
    } finally { installJudgmentPort(previous); }
  });

  test('cancelled classification performs no judgment call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(classifyIntent('task', { signal: controller.signal })).rejects.toThrow();
    expect(readings.requests).toEqual([]);
  });

  test('protected material never reaches the new reading', async () => {
    await expect(classifyIntent('OPENAI_API_KEY=SYNTHETIC_SECRET')).rejects.toThrow('Refused before judgment');
    expect(readings.requests).toEqual([]);
  });

  test('planner consumes actual risk and full text, sharing the preparation reading', async () => {
    readings.set({ intent: 'project', risk: 2, strategy: 'cohort' });
    const text = 'Build the independent modules. '.repeat(15);
    const planner = new AdaptivePlanner();
    const runtimeBus = new RuntimeEventBus();
    const decisions: unknown[] = [];
    runtimeBus.on('PLAN_STRATEGY_SELECTED', (event) => { decisions.push(event.payload); });
    const conversation = new ConversationManager();
    await prepareConversationForTurn(conversation, providerRegistry(), text, undefined, 'session', null, {
      onClassification: (reading) => maybeEmitAdaptivePlannerDecision(text, true, planner, runtimeBus, () => createEmitterContext('session', 'turn'), 'turn', reading),
    });
    expect(readings.requests).toHaveLength(2);
    expect(planner.getLatest()?.inputs.riskScore).toBeCloseTo(2 / 3);
    expect(planner.getLatest()?.inputs.taskDescription).toBe(text);
    expect(planner.getLatest()?.selected).toBe('cohort');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ type: 'PLAN_STRATEGY_SELECTED', selected: 'cohort', reasonCode: 'JUDGMENT_SELECTED', outcome: 'act' });
  });
});


test('an existing execution plan remains authoritative without duplicate priming', async () => {
  readings.set({ intent: 'project', needsPlan: true });
  const plan = { id: 'existing-plan' } as unknown as ExecutionPlan;
  const conversation = new ConversationManager();
  const result = await prepareConversationForTurn(conversation, providerRegistry(), 'continue the project', undefined, 'session', { getActive: () => plan, toMarkdown: () => 'Approved plan details' });
  expect(result).toBe(plan);
  expect(systemMessages(conversation).filter((message) => message.includes('Approved plan details'))).toHaveLength(1);
  expect(systemMessages(conversation).some((message) => message.includes('[Project mode]'))).toBe(false);
});

test('a non-multimodal provider still receives text-only input before judgment', async () => {
  const conversation = new ConversationManager();
  await prepareConversationForTurn(conversation, providerRegistry(), 'caption', [
    { type: 'text', text: 'the text content' },
    { type: 'image', mediaType: 'image/png', data: 'synthetic-image' },
  ]);
  expect(conversation.getMessageSnapshot().some((message) => message.role === 'user' && message.content === 'the text content')).toBe(true);
  expect(systemMessages(conversation).some((message) => message.includes('Images have been removed'))).toBe(true);
});
