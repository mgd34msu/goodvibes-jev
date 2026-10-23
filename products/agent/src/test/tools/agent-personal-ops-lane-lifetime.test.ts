import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildLanes } from '../../tools/agent-harness-personal-ops-lanes.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function laneContext() {
  const record = { threadId: 'synthetic-thread', subject: 'Synthetic current subject', status: 'unread' };
  const producer = { getSnapshot: () => ({ threads: [record] }) };
  // This native read-model fixture intentionally has no installed interactive
  // session, provider, or filesystem workspace services.
  const context = { platform: { readModels: { personalOps: { inboxThreads: producer } } }, clients: {} } as unknown as CommandContext;
  return { context, record, producer };
}

function laneFixture(beforeAnswer?: (name: string) => void) {
  return fakePort((name, question) => {
    beforeAnswer?.(name);
    if (name === 'match' && question.type === 'noul') return noulAnswer(0.001);
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) return choiceAnswer(question, 'other', 0.999);
    if (question.type === 'noul' && ['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted native lane lifetime question ${name}`);
  });
}

describe('Personal Ops lane source phases', () => {
  test('all native predicates and later producers finish before parent retention, whose pure guard survives cleanup', async () => {
    const { context, record } = laneContext();
    const parent = new Map<string | (() => void), () => void>();
    let matches = 0, firstRetentionMatches = -1, privacyReads = 0, parentEnteredPrivacy = false;
    const fake = laneFixture(name => {
      if (name === 'match') {
        matches++;
        if (matches % getOperatorContract().operator.methods.length === 0) process.stderr.write(`Native lane source phase: ${matches} complete predicates\n`);
      }
      else { privacyReads++; parentEnteredPrivacy ||= parent.has('personal-ops-contract-source'); }
    });
    installJudgmentPort(fake.port);
    const lanes = await buildLanes(context, { sourceOwner: ordinaryResearchOwner(),
      assertCurrent() { for (const guard of parent.values()) guard(); },
      retainCurrent(guard, key) {
        if (firstRetentionMatches < 0) firstRetentionMatches = matches;
        if (!parent.has(key ?? guard)) parent.set(key ?? guard, guard);
      },
    });
    expect(matches).toBe(4 * getOperatorContract().operator.methods.length);
    expect(firstRetentionMatches).toBe(matches); expect(privacyReads).toBeGreaterThan(0); expect(parentEnteredPrivacy).toBe(false);
    expect(lanes.find(lane => lane.id === 'inbox')?.liveRecords?.find(entry => entry.capability === 'inbox-provider-thread')?.label).toBe(`Fresh thread: ${record.subject}`);
    for (const guard of parent.values()) guard();
    record.subject = 'Changed after complete source cleanup';
    expect(() => { for (const guard of parent.values()) guard(); }).toThrow();
  }, 60_000);

  test('a later provider cannot rewrite the native schema or publish its unavailable record', async () => {
    const { context, producer, record } = laneContext();
    const target = getOperatorContract().operator.methods[0]!;
    const descriptor = Object.getOwnPropertyDescriptor(target, 'inputSchema')!;
    let matches = 0, changed = false, parentRetentions = 0;
    const fake = laneFixture(name => { if (name === 'match') matches++; });
    producer.getSnapshot = () => {
      changed = true;
      Object.defineProperty(target, 'inputSchema', { ...descriptor, value: { type: 'object', description: 'Changed by the actual later provider' } });
      return { threads: [record] };
    };
    installJudgmentPort(fake.port);
    const lanes = await buildLanes(context, { sourceOwner: ordinaryResearchOwner(), retainCurrent() { parentRetentions++; } });
    expect(matches).toBe(4 * getOperatorContract().operator.methods.length); expect(changed).toBe(true); expect(parentRetentions).toBeGreaterThan(0);
    expect(target.inputSchema).toBe(descriptor.value);
    expect(JSON.stringify(lanes)).not.toContain(`Fresh thread: ${record.subject}`);
  }, 60_000);

  test('an original currentness callback cannot replace its binding before source acquisition', async () => {
    const { context } = laneContext();
    const fake = laneFixture(); installJudgmentPort(fake.port);
    const options = { sourceOwner: ordinaryResearchOwner(), assertCurrent: () => {} };
    options.assertCurrent = () => { options.assertCurrent = () => {}; };
    await expect(buildLanes(context, options)).rejects.toThrow(); expect(fake.requests).toHaveLength(0);
  });

  test('an asynchronous currentness callback cannot authorize source acquisition', async () => {
    const { context } = laneContext();
    const fake = laneFixture(); installJudgmentPort(fake.port);
    await expect(buildLanes(context, { sourceOwner: ordinaryResearchOwner(), assertCurrent: async () => {} })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  test('owner methods replaced inside the original currentness callback cannot acquire source authority', async () => {
    const { context } = laneContext();
    const fake = laneFixture(); installJudgmentPort(fake.port);
    const owner = ordinaryResearchOwner();
    await expect(buildLanes(context, { sourceOwner: owner, assertCurrent() {
      Object.defineProperty(owner, 'project', { value: () => [], configurable: true });
    } })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});
