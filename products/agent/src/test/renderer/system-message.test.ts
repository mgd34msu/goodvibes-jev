import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { classifySystemMessage } from '../../renderer/system-message.ts';

let previous: JudgmentPort | undefined;
afterEach(() => { installJudgmentPort(previous); });
function port(severity: 'error' | 'warning' | 'info', confidence = 0.99) {
  const fake = fakePort((name, question) => choiceAnswer(question, name === 'severity' ? severity : name === 'activity' ? 'system' : 'system_notice', confidence));
  previous = installJudgmentPort(fake.port); return fake;
}
describe('system message presentation boundary', () => {
  test('uses the full message and the Jev result, including negation after a long prefix', async () => {
    const fake = port('info');
    const content = 'Error report '.repeat(1000) + ' — examples only; no errors occurred.';
    expect(await classifySystemMessage(content)).toBe('info');
    expect(fake.requests[0]?.state).toEqual({ content });
  });
  test('unsettled severity stays unclassified', async () => {
    port('error', 0.4);
    expect(await classifySystemMessage('The operation had an unusual result.')).toBeUndefined();
  });
  test('a settled result is reused only on the same configured port', async () => {
    const fake = port('warning');
    expect(await classifySystemMessage('The worker is recovering.')).toBe('warning');
    expect(await classifySystemMessage('The worker is recovering.')).toBe('warning');
    expect(fake.requests).toHaveLength(1);
    const next = fakePort((name, q) => choiceAnswer(q, name === 'severity' ? 'info' : name === 'activity' ? 'system' : 'system_notice'));
    installJudgmentPort(next.port);
    expect(await classifySystemMessage('The worker is recovering.')).toBe('info');
    expect(next.requests).toHaveLength(1);
  });
  test('protected material is rejected before any request', async () => {
    const fake = port('info');
    await expect(classifySystemMessage('Authorization: Bearer synthetic-test-value')).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});
