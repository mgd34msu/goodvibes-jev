/**
 * A contract's progress lines are the owner's, and they carry no contract id.
 *
 * This family is owner-facing on purpose: someone who asked for a
 * long-running piece of work is owed its legs. The text must not lead with
 * `Contract ctr-7f3a91c0`, a name for the machinery and a register id, since
 * outward-facing text carries neither.
 *
 * These tests hold three things at once, because getting one without the others
 * is a different defect:
 *
 *   1. no rendered line contains the contract id (or a prefix of it);
 *   2. the lines still ARRIVE, this is not a suppression fix;
 *   3. two workstreams running at once are still told apart, in words.
 */
import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { ChannelReplyPipeline } from '../sdk/src/platform/channels/reply-pipeline.js';
import { WebhookNotifier } from '../sdk/src/platform/integrations/webhooks.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';

/**
 * The envelope type `emit` accepts for the `contracts` domain specifically.
 *
 * `Parameters<typeof bus.emit>[1]` would be wrong here: `emit` is generic over
 * the domain, so reading its parameters without supplying one instantiates the
 * type variable at its constraint and yields the union envelope across every
 * domain, which the `contracts` overload does not accept. The instantiation
 * expression pins the domain, so this alias stays correct as the event map
 * grows instead of silently widening again.
 */
type ContractsEnvelope = Parameters<typeof RuntimeEventBus.prototype.emit<'contracts'>>[1];
import { eventLine, normalizeChannelRenderEventFromRuntime } from '../sdk/src/platform/channels/reply-render.js';
import { DEFAULT_POLICY } from '../sdk/src/platform/channels/reply-policy.js';
import {
  describeContractStatus,
  describeUnitStatus,
  finishWorkstreamLabel,
  rememberWorkstreamLabel,
  resetWorkstreamLabelsForTests,
  workstreamLabel,
  workstreamLabelInline,
} from '../sdk/src/platform/channels/workstream-labels.js';
import { CONTRACT_STATUSES, CONTRACT_UNIT_STATUSES } from '../sdk/src/events/contract.js';
import type { ChannelSurface } from '../sdk/src/platform/channels/types.js';
import { settleEvents, waitFor } from './_helpers/test-timeout.js';

/**
 * A contract id shaped like the real thing, and the hex part alone, so a test
 * catches a line that carries either the whole id or its distinctive part.
 */
const CONTRACT_ID = 'ctr-7f3a91c0';
const CONTRACT_ID_SHORT = '7f3a91c0';
const OTHER_CONTRACT_ID = 'ctr-c5b4a3f2';

const ALL_SURFACES = Object.keys(DEFAULT_POLICY) as ChannelSurface[];

const TASK = 'rewrite the retry backoff so it stops hammering the mail host';

/**
 * Every contract event the renderer turns into an owner-facing line, in the
 * order a contract emits them. The last two are the terminal outcomes (passed,
 * then failed), which the tests below reach with `.at(-2)` and `.at(-1)`.
 *
 * Each envelope gets its own trace id and timestamp because the pipeline's
 * delta watermark keys on the render event id, which is built from both, reuse
 * them and the second event of a contract looks like one already delivered.
 */
function contractEnvelopes(contractId: string, task: string) {
  const base = { ts: 1, traceId: `trace-${contractId}`, source: 'test' };
  const criteria = (verdicts: readonly ('met' | 'unmet')[]) => verdicts.map((verdict, index) => ({
    criterionId: `c${index + 1}`,
    verdict,
    probabilityUnmet: verdict === 'met' ? 0.05 : 0.9,
    outcome: 'act',
  }));
  const check = (scope: 'group' | 'deliverable', targetId: string, result: 'pass' | 'nudge', verdicts: readonly ('met' | 'unmet')[]) => ({
    type: 'CONTRACT_CHECKED', contractId, scope, targetId, checkId: `${targetId}.k1`, trigger: 'completion', result,
    criteria: criteria(verdicts), goal: { verdict: result === 'pass' ? 'met' : 'unmet', outcome: 'act' }, quality: [], gates: [], decisionIds: [],
  });
  return [
    { ...base, type: 'CONTRACT_CREATED', payload: { type: 'CONTRACT_CREATED', contractId, sessionId: 's1', origin: 'turn', ask: task, ownerAgentId: 'owner-1' } },
    { ...base, type: 'CONTRACT_CHECKED', payload: check('group', 'g1', 'nudge', ['met', 'unmet']) },
    { ...base, type: 'CONTRACT_STATUS_CHANGED', payload: { type: 'CONTRACT_STATUS_CHANGED', contractId, from: 'running', to: 'awaiting-owner' } },
    { ...base, type: 'CONTRACT_CHECKED', payload: check('deliverable', contractId, 'pass', ['met', 'met', 'met', 'unmet']) },
    { ...base, type: 'CONTRACT_ESCALATED', payload: { type: 'CONTRACT_ESCALATED', contractId, escalationId: 'e1', scope: 'unit', targetId: 'u1', reason: 'stalled', question: `Contract ${contractId} needs your decision on unit "parser".\nThe unit stopped making progress.\nReply to approve, to change what is required (say how), or to stop the contract.`, unmetCriterionIds: ['u1.c1'] } },
    { ...base, type: 'CONTRACT_COMMITTED', payload: { type: 'CONTRACT_COMMITTED', contractId, status: 'committed', hash: 'abc1234', note: 'committed on main' } },
    { ...base, type: 'CONTRACT_PASSED', payload: { type: 'CONTRACT_PASSED', contractId, criteriaMet: 4, criteriaJudged: 4, excluded: 0, nudges: 2 } },
    { ...base, type: 'CONTRACT_FAILED', payload: { type: 'CONTRACT_FAILED', contractId, reason: 'the gates never went green', failureKind: 'other', membersSettled: true } },
  ].map((envelope, index) => ({
    ...envelope,
    ts: base.ts + index,
    traceId: `${base.traceId}-${index}`,
  })) as unknown as Parameters<typeof normalizeChannelRenderEventFromRuntime>[0][];
}

/** Render one contract's whole lifecycle to the lines a person would receive. */
function renderLifecycle(contractId: string, task: string): string[] {
  return contractEnvelopes(contractId, task)
    .flatMap((envelope) => normalizeChannelRenderEventFromRuntime(envelope))
    .map((event) => eventLine(event, 'public'))
    .filter((line): line is string => Boolean(line));
}

beforeEach(() => {
  resetWorkstreamLabelsForTests();
});

describe('the id never reaches a rendered line', () => {
  test('no line in a whole contract lifecycle contains the contract id', () => {
    const lines = renderLifecycle(CONTRACT_ID, TASK);
    const body = lines.join('\n');
    expect(body).not.toContain(CONTRACT_ID);
    expect(body).not.toContain(CONTRACT_ID_SHORT);
    // The name for the machinery goes with it, outward-facing text carries
    // neither an id nor an internal codename.
    expect(body).not.toContain('Contract ');
  });

  test('a contract whose opening line was never seen still renders no id', () => {
    // The daemon restarted, or the reply pipeline attached mid-workstream: the
    // label was never learned. It says so in words rather than falling back to
    // the identifier.
    const lines = contractEnvelopes(CONTRACT_ID, TASK)
      .filter((envelope) => envelope.payload.type !== 'CONTRACT_CREATED')
      .flatMap((envelope) => normalizeChannelRenderEventFromRuntime(envelope))
      .map((event) => eventLine(event, 'public'))
      .filter((line): line is string => Boolean(line));
    const body = lines.join('\n');
    expect(body).not.toContain(CONTRACT_ID);
    expect(body).not.toContain(CONTRACT_ID_SHORT);
    expect(body).toContain('the workstream');
  });

  test('the raw status name never reaches the reader either', () => {
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    const [line] = renderLifecycle(CONTRACT_ID, TASK).filter((text) => text.includes('is now'));
    expect(line).toContain('waiting for your decision');
    expect(line).not.toContain('awaiting-owner');
  });

  test('the escalation question names the contract in words, and keeps the question', () => {
    const lines = renderLifecycle(CONTRACT_ID, TASK);
    const [question] = lines.filter((text) => text.includes('needs your decision'));
    expect(question).toBeDefined();
    expect(question).toContain('"rewrite the retry backoff');
    expect(question).toContain('needs your decision on unit "parser"');
    expect(question).toContain('stopped making progress');
    expect(question).not.toContain(CONTRACT_ID_SHORT);
  });

  test("a unit's own checks, nudges and cancellation lines stay with the operator or read plainly", () => {
    const base = { ts: 1, traceId: 'trace-unit', source: 'test' };
    const unitCheck = { ...base, type: 'CONTRACT_CHECKED', payload: { type: 'CONTRACT_CHECKED', contractId: CONTRACT_ID, scope: 'unit', targetId: 'u1', checkId: 'u1.k1', trigger: 'turn-end', result: 'nudge', criteria: [], goal: { verdict: 'met', outcome: 'act' }, quality: [], gates: [], decisionIds: [] } };
    const nudged = { ...base, type: 'CONTRACT_NUDGED', payload: { type: 'CONTRACT_NUDGED', contractId: CONTRACT_ID, unitId: 'u1', nudgeId: 'n1', checkId: 'u1.k1', kinds: ['unmet'], criterionIds: ['u1.c1'], delivery: 'bus', agentId: 'a1' } };
    for (const envelope of [unitCheck, nudged]) {
      expect(normalizeChannelRenderEventFromRuntime(envelope as unknown as Parameters<typeof normalizeChannelRenderEventFromRuntime>[0])).toEqual([]);
    }
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    const cancelled = { ...base, type: 'CONTRACT_CANCELLED', payload: { type: 'CONTRACT_CANCELLED', contractId: CONTRACT_ID, reason: 'stopped by the owner', filesModified: 2 } };
    const [event] = normalizeChannelRenderEventFromRuntime(cancelled as unknown as Parameters<typeof normalizeChannelRenderEventFromRuntime>[0]);
    expect(event?.phase).toBe('final');
    expect(eventLine(event!, 'public')).toBe('"rewrite the retry backoff so it stops hammering…" was cancelled: stopped by the owner');
  });
});

describe('the lines still arrive: this is not a suppression fix', () => {
  test('every stage of the workstream still produces a line', () => {
    const lines = renderLifecycle(CONTRACT_ID, TASK);
    const body = lines.join('\n');
    // One line per event in the family, none of them dropped.
    expect(lines.length).toBe(contractEnvelopes(CONTRACT_ID, TASK).length);
    expect(body).toContain('Started work on:');
    expect(body).toContain('The check of a part of');
    expect(body).toContain('found things to fix: 1 of 2 requirements met');
    expect(body).toContain('is now waiting for your decision');
    expect(body).toContain('passed: 3 of 4 requirements met');
    expect(body).toContain('needs your decision');
    expect(body).toContain('abc1234');
    expect(body).toContain('is done');
    expect(body).toContain('could not be finished');
  });

  test('the task itself still reaches the reader on the opening line', () => {
    const [opening] = renderLifecycle(CONTRACT_ID, TASK);
    expect(opening).toContain('rewrite the retry backoff');
  });
});

describe('two workstreams at once are told apart, in words', () => {
  test('identical tasks produce different lines', () => {
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    rememberWorkstreamLabel(OTHER_CONTRACT_ID, TASK);
    const first = workstreamLabel(CONTRACT_ID);
    const second = workstreamLabel(OTHER_CONTRACT_ID);
    expect(first).not.toBe(second);
    expect(first).toContain('the first one');
    expect(second).toContain('the second one');
    // In words, not by an identifier.
    expect(`${first}${second}`).not.toContain(CONTRACT_ID_SHORT);
    expect(`${first}${second}`).not.toContain(OTHER_CONTRACT_ID.slice(0, 12));
  });

  test('the second opening line says which one it is', () => {
    // Only the opening events, running two whole lifecycles would retire the
    // first workstream before the second one started, which is not the case
    // under test.
    const openingLine = (contractId: string): string | null => {
      const [created] = contractEnvelopes(contractId, TASK);
      const [event] = normalizeChannelRenderEventFromRuntime(created!);
      return eventLine(event!, 'public');
    };
    expect(openingLine(CONTRACT_ID)).toBe(`Started work on: ${TASK}`);
    expect(openingLine(OTHER_CONTRACT_ID)).toBe(`Started work on: ${TASK} (the second one)`);
  });

  test('a lone workstream is not qualified: there is nothing to distinguish it from', () => {
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    const label = workstreamLabel(CONTRACT_ID);
    expect(label.startsWith('"')).toBe(true);
    expect(label.endsWith('"')).toBe(true);
    expect(label).not.toContain(' one)');
  });

  test('tasks that only differ past the label length still get told apart', () => {
    const long = 'rewrite the retry backoff in the mail transport so that it ';
    rememberWorkstreamLabel(CONTRACT_ID, `${long}stops hammering the host`);
    rememberWorkstreamLabel(OTHER_CONTRACT_ID, `${long}gives up after five tries`);
    expect(workstreamLabelInline(CONTRACT_ID)).not.toBe(workstreamLabelInline(OTHER_CONTRACT_ID));
  });

  test('a place, once given, is kept after the other workstream finishes', () => {
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    rememberWorkstreamLabel(OTHER_CONTRACT_ID, TASK);
    const before = workstreamLabel(OTHER_CONTRACT_ID);
    // The first one finishes. The survivor's name does not change under the
    // reader mid-run.
    normalizeChannelRenderEventFromRuntime(contractEnvelopes(CONTRACT_ID, TASK).at(-2)!);
    expect(workstreamLabel(OTHER_CONTRACT_ID)).toBe(before);
  });

  test('a workstream started after its namesake finished stands alone again', () => {
    // The same ask, run twice, one after the other. There is nothing live to
    // tell the second run apart from, so it is not qualified, and it does not
    // reuse the place the first run wore.
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    finishWorkstreamLabel(CONTRACT_ID);
    rememberWorkstreamLabel(OTHER_CONTRACT_ID, TASK);
    expect(workstreamLabel(OTHER_CONTRACT_ID)).not.toContain(' one)');
  });

  test('a third workstream does not reuse a place the reader already saw', () => {
    rememberWorkstreamLabel('contract-a', TASK);
    rememberWorkstreamLabel('contract-b', TASK);
    finishWorkstreamLabel('contract-a');
    rememberWorkstreamLabel('contract-c', TASK);
    expect(workstreamLabel('contract-b')).toContain('the second one');
    expect(workstreamLabel('contract-c')).toContain('the third one');
  });
});

describe('what the label module promises', () => {
  test('a terminal event leaves the name readable for every other subscriber', () => {
    rememberWorkstreamLabel(CONTRACT_ID, TASK);
    expect(workstreamLabelInline(CONTRACT_ID)).toContain('rewrite the retry backoff');
    // WORKFLOW_CHAIN_PASSED, the second-to-last envelope in the family.
    normalizeChannelRenderEventFromRuntime(contractEnvelopes(CONTRACT_ID, TASK).at(-2)!);

    // Still readable, deliberately. Three subscribers build a line from this
    // one event, the channel renderer, the conversation follow-up and the
    // webhook notifier, and dropping the name on the first of them would make
    // the other two say "the workstream" purely because of subscription order.
    // Reaping is by the map's bound, where nothing is racing.
    expect(workstreamLabelInline(CONTRACT_ID)).toContain('rewrite the retry backoff');
  });

  test('a finished workstream is evicted before a live one', () => {
    rememberWorkstreamLabel('finished-contract', 'the one that ended');
    finishWorkstreamLabel('finished-contract');
    rememberWorkstreamLabel('live-contract', 'the one still running');
    // Push exactly one entry past the 64 ceiling, so precisely one eviction
    // happens and the test says which entry it took.
    for (let index = 0; index < 63; index += 1) {
      rememberWorkstreamLabel(`filler-${index}`, `filler task ${index}`);
    }
    expect(workstreamLabelInline('finished-contract')).toBe('the workstream');
    expect(workstreamLabelInline('live-contract')).toContain('the one still running');
  });

  test('a process that never sees a terminal event cannot grow the map unbounded', () => {
    for (let index = 0; index < 500; index += 1) {
      rememberWorkstreamLabel(`contract-${index}`, `task number ${index}`);
    }
    // The oldest are evicted; an evicted workstream reads as "the workstream"
    // rather than inventing an id to fill the gap.
    expect(workstreamLabelInline('contract-0')).toBe('the workstream');
    expect(workstreamLabelInline('contract-499')).toContain('task number 499');
  });

  test('an empty task leaves no label rather than an empty pair of quotes', () => {
    rememberWorkstreamLabel(CONTRACT_ID, '   ');
    expect(workstreamLabel(CONTRACT_ID)).toBe('The workstream');
  });

  test('every contract status has plain words', () => {
    for (const status of CONTRACT_STATUSES) {
      const words = describeContractStatus(status);
      expect(words).not.toMatch(/[-_]/);
      expect(words.length).toBeGreaterThan(0);
    }
  });

  test('every unit status has plain words', () => {
    for (const status of CONTRACT_UNIT_STATUSES) {
      const words = describeUnitStatus(status);
      expect(words).not.toMatch(/[-_]/);
      expect(words.length).toBeGreaterThan(0);
    }
  });

  test('a status from a newer peer still reads as words, not a field value', () => {
    expect(describeContractStatus('waiting-on-the-moon' as never)).toBe('waiting on the moon');
  });
});

describe('the other places a workstream line reaches a person', () => {
  test('a webhook body names the contract in words, not by id', async () => {
    // A webhook body is read by whatever the operator pointed it at, a Slack
    // channel, a phone. Outward-facing text, same rule.
    const sent: string[] = [];
    const bus = new RuntimeEventBus();
    const notifier = new WebhookNotifier(['https://example.com/webhook'], { force: true, metadataOnly: () => false });
    const sendSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      sent.push(String(init?.body));
      return new Response('ok');
    }, { preconnect() {} }));
    try {
      notifier.attachToRuntimeBus(bus);
      rememberWorkstreamLabel(CONTRACT_ID, TASK);
      bus.emit('contracts', contractEnvelopes(CONTRACT_ID, TASK).at(-2)! as ContractsEnvelope);
      bus.emit('contracts', contractEnvelopes(OTHER_CONTRACT_ID, TASK).at(-1)! as ContractsEnvelope);
      await waitFor(() => sent.length >= 2);
      const body = sent.join('\n');
      expect(body).not.toContain(CONTRACT_ID);
      expect(body).not.toContain(CONTRACT_ID_SHORT);
      expect(body).not.toContain('Contract ');
      // Still says what happened, to both outcomes.
      expect(body).toContain('passed all its checks');
      expect(body).toContain('could not be finished');
    } finally {
      sendSpy.mockRestore();
      notifier.detach();
    }
  });
});

/** The end-to-end path: bus -> pipeline -> the body a surface publishes. */
function harness(surfaceKind: string) {
  const published: string[] = [];
  let now = 2_000_000;
  const bus = new RuntimeEventBus();
  const pipeline = new ChannelReplyPipeline({
    channelPlugins: {
      getRenderPolicy: async () => null,
      render: async (_surface: string, request: { phase: string; text: string }) => {
        published.push(request.text);
        return { delivered: true, metadata: {} };
      },
    },
    routeBindings: { captureReplyTarget: async () => {} },
    runtimeBus: bus,
    now: () => now,
  } as unknown as ConstructorParameters<typeof ChannelReplyPipeline>[0]);

  return {
    published,
    advance(ms: number) { now += ms; },
    track(agentId: string, task: string) {
      pipeline.trackPending({
        agentId,
        surfaceKind,
        task,
        createdAt: now,
        routeId: 'route-1',
      } as unknown as Parameters<ChannelReplyPipeline['trackPending']>[0]);
    },
    async emit(envelope: unknown) {
      bus.emit('contracts', envelope as ContractsEnvelope);
      await settleEvents();
    },
  };
}

describe('end to end, on every surface', () => {
  for (const surface of ALL_SURFACES) {
    test(`${surface} receives the contract's progress with no contract id in it`, async () => {
      resetWorkstreamLabelsForTests();
      const h = harness(surface);
      h.track(`agent-${surface}`, TASK);
      h.advance(40_000);
      const [created, , stateChanged] = contractEnvelopes(CONTRACT_ID, TASK);
      await h.emit(created);
      h.advance(40_000);
      await h.emit(stateChanged);
      await waitFor(() => h.published.length > 0);

      const body = h.published.join('\n');
      expect(body).not.toContain(CONTRACT_ID);
      expect(body).not.toContain(CONTRACT_ID_SHORT);
      expect(body).not.toContain('Contract ');
      // Still delivered, the owner's contract still reports its legs.
      expect(body).toContain('rewrite the retry backoff');
    });
  }

  test('two concurrent workstreams reach the surface distinguishable', async () => {
    resetWorkstreamLabelsForTests();
    const h = harness('telegram');
    h.track('agent-one', TASK);
    h.track('agent-two', TASK);
    h.advance(40_000);
    const [createdOne, , stateOne] = contractEnvelopes(CONTRACT_ID, TASK);
    const [createdTwo, , stateTwo] = contractEnvelopes(OTHER_CONTRACT_ID, TASK);
    await h.emit(createdOne);
    await h.emit(createdTwo);
    h.advance(40_000);
    await h.emit(stateOne);
    h.advance(40_000);
    await h.emit(stateTwo);
    await waitFor(() => h.published.join('\n').includes('(the first one)')
      && h.published.join('\n').includes('(the second one)'));

    const body = h.published.join('\n');
    expect(body).not.toContain(CONTRACT_ID_SHORT);
    expect(body).not.toContain(OTHER_CONTRACT_ID.slice(0, 12));
    expect(body).toContain('(the first one)');
    expect(body).toContain('(the second one)');
  });
});
