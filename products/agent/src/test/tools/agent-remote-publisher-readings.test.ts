import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { remotePublisherOutcomeKind, remotePublisherSchemaStatus } from '@goodvibes-jev/engine/sdk/platform/routing';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readRemotePublisherOutcomeKind, readRemotePublisherSchemaStatus } from '../../tools/agent-harness-remote-publisher-readings.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
const source = (status: string, kind: string, tail = 'Complete synthetic ordinary evidence.') => [
  { path: [], kind: 'object' },
  { path: ['header'], kind: 'object' },
  { path: ['header', 'selectedStatusText'], kind: 'text', parts: [{ kind: 'text', text: status }] },
  { path: ['header', 'selectedOutcomeText'], kind: 'text', parts: [{ kind: 'text', text: kind }] },
  { path: ['record'], kind: 'object' },
  { path: ['record', 'summary'], kind: 'text', parts: [{ kind: 'text', text: tail }] },
];

describe('Remote publisher meanings use canonical complete-source readings', () => {
  test('both original semantic sites have registered batteries with their authored opposition fixtures', () => {
    expect(gateJudgmentRegistry.get(remotePublisherSchemaStatus.name)).toBe(remotePublisherSchemaStatus);
    expect(gateJudgmentRegistry.get(remotePublisherOutcomeKind.name)).toBe(remotePublisherOutcomeKind);
    expect(remotePublisherSchemaStatus.fixtures).toHaveLength(9);
    expect(remotePublisherOutcomeKind.fixtures).toHaveLength(10);
  });

  test('certified status words cannot override the actual no reading', async () => {
    const fake = fakePort(name => { expect(name).toBe('certified_schema'); return noulAnswer(0.01); });
    installJudgmentPort(fake.port);
    expect(await readRemotePublisherSchemaStatus(source('certified', 'capture', 'The certificate was revoked.'), options())).toBe('legacy');
    expect(fake.requests[0]?.context?.battery).toBe('agent.remote-publisher.schema-status');
  });

  test('a supported paraphrase can be certified without belonging to the former synonym list', async () => {
    const fake = fakePort(name => { expect(name).toBe('certified_schema'); return noulAnswer(0.99); });
    installJudgmentPort(fake.port);
    expect(await readRemotePublisherSchemaStatus(source('This record passed schema validation.', 'capture'), options())).toBe('certified');
    expect(fake.requests).toHaveLength(1);
  });

  test('unresolved schema reading holds without a certified-word fallback', async () => {
    const fake = fakePort(() => noulAnswer(0.5)); installJudgmentPort(fake.port);
    await expect(readRemotePublisherSchemaStatus(source('certified', 'capture'), options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  test.each(['capture', 'export', 'closeout', 'artifact', 'other'] as const)('every original operation option maps from the actual %s reading', async kind => {
    const fake = fakePort((name, question) => { expect(name).toBe('outcome_kind'); return choiceAnswer(question, kind, 0.99); });
    installJudgmentPort(fake.port);
    expect(await readRemotePublisherOutcomeKind(source('certified', 'export-closeout-artifact-capture'), options())).toBe(kind);
    expect(fake.requests[0]?.context?.battery).toBe('agent.remote-publisher.outcome-kind');
  });

  test('unresolved outcome reading holds without substring-order fallback', async () => {
    const fake = fakePort((name, question) => { expect(name).toBe('outcome_kind'); return choiceAnswer(question, 'export', 0.2); });
    installJudgmentPort(fake.port);
    await expect(readRemotePublisherOutcomeKind(source('certified', 'export-closeout-artifact-capture'), options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  test('the complete source tail and literal display marker parts remain in both named readings', async () => {
    const tail = 'Ordinary complete evidence '.repeat(50) + 'full-tail-kept';
    const input = [...source('certified', 'capture', tail),
      { path: ['record', 'literal'], kind: 'text', parts: [{ kind: 'display-marker', text: '<redacted>' }] },
    ];
    const fake = fakePort((name, question) => name === 'certified_schema' ? noulAnswer(0.99)
      : name === 'outcome_kind' ? choiceAnswer(question, 'capture', 0.99) : (() => { throw new Error(name); })());
    installJudgmentPort(fake.port);
    expect(await readRemotePublisherSchemaStatus(input, options())).toBe('certified');
    expect(await readRemotePublisherOutcomeKind(input, options())).toBe('capture');
    for (const request of fake.requests) {
      expect(JSON.stringify(request.state)).toContain('full-tail-kept');
      expect(JSON.stringify(request.state)).toContain('display-marker');
      expect(JSON.stringify(request.state)).toContain('<redacted>');
    }
  });

  test('changed complete source retires a response before returning its operation', async () => {
    const input = source('certified', 'capture');
    const fake = fakePort((name, question) => {
      expect(name).toBe('outcome_kind'); input.push({ path: ['record', 'late'], kind: 'text', parts: [{ kind: 'text', text: 'Late source data' }] });
      return choiceAnswer(question, 'capture', 0.99);
    });
    installJudgmentPort(fake.port);
    await expect(readRemotePublisherOutcomeKind(input, options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  test('private unregistered source material holds before either hosted request', async () => {
    const secret = 'synthetic-private-remote-publisher-value';
    const privacy = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) });
    const fake = fakePort(() => { throw new Error('Private source reached publisher reading'); });
    installJudgmentPort(fake.port);
    await expect(readRemotePublisherSchemaStatus(source('certified', 'capture', secret), { sourceOwner: privacy.owner })).rejects.toThrow();
    await expect(readRemotePublisherOutcomeKind(source('certified', 'capture', secret), { sourceOwner: privacy.owner })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  test('a retired canonical backend stays held after protected receipt cleanup', async () => {
    const guards: Array<() => void> = [];
    const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
    expect(await readRemotePublisherSchemaStatus(source('certified', 'capture'), { ...options(), retainCurrent: guard => { guards.push(guard); } })).toBe('legacy');
    for (const guard of guards) guard();
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    expect(() => { for (const guard of guards) guard(); }).toThrow();
  });

  test('caller cancellation cannot publish a completed semantic response', async () => {
    const controller = new AbortController();
    const fake = fakePort((name, question) => { expect(name).toBe('outcome_kind'); controller.abort(); return choiceAnswer(question, 'capture', 0.99); });
    installJudgmentPort(fake.port);
    await expect(readRemotePublisherOutcomeKind(source('certified', 'capture'), { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });
});
