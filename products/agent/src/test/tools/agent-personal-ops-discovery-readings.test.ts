import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { personalOpsLaneMembers, readPersonalOpsBoolean, readPersonalOpsReceiptStatus, readPersonalOpsResultField, readPersonalOpsSampleField, readPersonalOpsTool } from '../../tools/agent-harness-personal-ops-readings.ts';
import { partitionInvokableMethods } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { candidateResultItems, stringField } from '../../tools/agent-harness-personal-ops-runner.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
const contract = () => ({ server: 'calendar-token-in-name', tool: 'opaque', description: 'Synthetic received correspondence lookup.', inputSchema: { type: 'object', properties: { reference: { type: 'string', description: 'Thread identifier' } } } });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected captured state');
  return Object.fromEntries(Object.entries(value));
}

describe('PersonalOps canonical discovery and complete source ownership', () => {
  test('lane membership follows named readings and keeps full descriptions and native invokable facts', async () => {
    const positive = { id: 'opaque', description: 'x'.repeat(900) + ' complete-contract-tail', invokable: false };
    const negative = { id: 'email.calendar.tasks', description: 'Synthetic unrelated actor memory queue', invokable: true };
    const fake = fakePort((name, _question, raw) => {
      expect(name).toBe('match');
      return noulAnswer(object(object(raw).candidate).name === 'opaque' ? 0.99 : 0.01);
    });
    installJudgmentPort(fake.port);
    const matches = await personalOpsLaneMembers([positive, negative], 'inbox', entry => ({ id: entry.id, description: entry.description, evidence: entry }), options());
    expect(matches.map(entry => entry.id)).toEqual(['opaque']);
    expect(partitionInvokableMethods(matches)).toEqual({ available: [], unavailable: ['opaque'] });
    expect(fake.requests.every(request => request.context?.battery === 'agent.personal-ops.lane-member')).toBe(true);
    expect(JSON.stringify(fake.requests)).toContain('complete-contract-tail');
  });

  test('tool lane and effect are separate registered readings of the complete schema', async () => {
    const fake = fakePort((name, question) => {
      if (name === 'lane') return choiceAnswer(question, 'inbox', 0.99);
      if (['mutates', 'outward', 'secrets'].includes(name)) return noulAnswer(0.01);
      throw new Error(`Unknown question ${name}`);
    });
    installJudgmentPort(fake.port);
    expect(await readPersonalOpsTool(contract(), options())).toEqual({ lane: 'inbox', effect: 'read-only' });
    expect(fake.requests.map(request => request.context?.battery)).toEqual(['agent.personal-ops.tool-lane', 'engine.gate.side-effect']);
    expect(fake.requests.every(request => JSON.stringify(request.state).includes('Thread identifier'))).toBe(true);
  });

  test('a mutating tool cannot become a read from its name', async () => {
    const fake = fakePort((name, question) => name === 'lane' ? choiceAnswer(question, 'calendar', 0.99)
      : ['mutates', 'outward', 'secrets'].includes(name) ? noulAnswer(name === 'mutates' ? 0.99 : 0.01) : (() => { throw new Error(name); })());
    installJudgmentPort(fake.port);
    expect(await readPersonalOpsTool({ ...contract(), tool: 'read_calendar' }, options())).toEqual({ lane: 'calendar', effect: 'confirmed-effect' });
  });

  test('credential-reading tools and unresolved lane choices stay unavailable', async () => {
    let uncertain = false;
    const fake = fakePort((name, question) => name === 'lane' ? choiceAnswer(question, 'inbox', uncertain ? 0.2 : 0.99)
      : ['mutates', 'outward', 'secrets'].includes(name) ? noulAnswer(name === 'secrets' ? 0.99 : 0.01) : (() => { throw new Error(name); })());
    installJudgmentPort(fake.port);
    expect(await readPersonalOpsTool(contract(), options())).toBeNull();
    uncertain = true;
    expect(await readPersonalOpsTool(contract(), options())).toBeNull();
    expect(fake.requests).toHaveLength(3);
  });

  test('schema field roles follow the reading instead of a substring', async () => {
    const fake = fakePort((name, question) => { expect(name).toBe('role'); return choiceAnswer(question, 'other', 0.99); });
    installJudgmentPort(fake.port);
    const input = { field: 'from', lane: 'inbox' as const, effect: 'read-only' as const, contract: contract(), inputSchema: { properties: { from: { description: 'Sender, not a date bound' } } } };
    expect(await readPersonalOpsSampleField(input, options())).toBe('<from>');
    expect(fake.requests[0]?.context?.battery).toBe('agent.personal-ops.sample-field');
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('Sender, not a date bound');
  });

  test('source mutations during a response retire the result before publication', async () => {
    const input = contract();
    const fake = fakePort((name, question) => {
      expect(name).toBe('lane'); input.inputSchema.properties.reference.description = 'Changed native schema';
      return choiceAnswer(question, 'inbox', 0.99);
    });
    installJudgmentPort(fake.port);
    await expect(readPersonalOpsTool(input, options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  test('private source fields are screened before any canonical hosted request', async () => {
    const secret = 'synthetic-private-unregistered-value';
    const privacy = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) });
    const fake = fakePort(() => { throw new Error('Private source reached canonical port'); });
    installJudgmentPort(fake.port);
    await expect(readPersonalOpsTool({ ...contract(), description: secret }, { sourceOwner: privacy.owner })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  test('retained backend identity survives source receipt cleanup', async () => {
    const guards: Array<() => void> = [];
    const fake = fakePort((name, question) => name === 'lane' ? choiceAnswer(question, 'neither', 0.99) : (() => { throw new Error(name); })());
    installJudgmentPort(fake.port);
    expect(await readPersonalOpsTool(contract(), { ...options(), retainCurrent: guard => guards.push(guard) })).toBeNull();
    for (const guard of guards) guard();
    installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    expect(() => guards.forEach(guard => guard())).toThrow();
  });

  test('native booleans remain mechanical and prose uses the existing named boolean reader', async () => {
    expect(await readPersonalOpsBoolean({ parameter: 'unread', value: true, record: {} }, {})).toBe(true);
    expect(await readPersonalOpsBoolean({ parameter: 'unread', value: 'false', record: {} }, {})).toBe(false);
    const fake = fakePort((name, question) => { expect(name).toBe('boolean_value'); return choiceAnswer(question, 'false', 0.99); });
    installJudgmentPort(fake.port);
    expect(await readPersonalOpsBoolean({ parameter: 'unread', value: 'yes but actually already reviewed', record: { description: 'Synthetic control' } }, options())).toBe(false);
    expect(fake.requests[0]?.context?.battery).toBe('engine.tools.boolean-value');
  });

  test('receipt outcomes follow complete evidence instead of success words', async () => {
    const fake = fakePort((name, question) => { expect(name).toBe('status'); return choiceAnswer(question, 'failed', 0.99); });
    installJudgmentPort(fake.port);
    expect(await readPersonalOpsReceiptStatus({ metadata: { status: 'ready', detail: 'Synthetic operation failed' } }, options())).toBe('failed');
    expect(fake.requests[0]?.context?.battery).toBe('agent.personal-ops.receipt-status');
  });

  test('exact result keys are mapped locally from opaque selector IDs', async () => {
    const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, '1', 0.99)
      : name === 'fits_0' ? noulAnswer(0.01) : name === 'fits_1' ? noulAnswer(0.99) : (() => { throw new Error(name); })());
    installJudgmentPort(fake.port);
    const source = { subjectId: 'misleading', heading: 'Actual subject' };
    expect(await readPersonalOpsResultField(source, 'message subject', options())).toBe('heading');
    expect(await stringField(source, 'message subject', options())).toBe('Actual subject');
    expect(fake.requests.every(request => request.context?.battery === 'agent.personal-ops.result-field')).toBe(true);
  });

  test('nested results use every actual key and do not stop at a depth shortlist', async () => {
    const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, '0', 0.99)
      : name === 'fits_0' ? noulAnswer(0.99) : (() => { throw new Error(name); })());
    installJudgmentPort(fake.port);
    const records = [{ heading: 'Synthetic item' }];
    expect(await candidateResultItems({ a: { b: { c: { d: { e: { opaque: records } } } } } }, options())).toEqual(records);
    expect(fake.requests).toHaveLength(6);
  });
});
