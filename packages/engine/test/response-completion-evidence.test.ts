import { expect, test } from 'bun:test';
import { CompletionEvidenceProjection } from '../sdk/src/platform/core/response-completion-evidence.js';
import { passesLuhn } from '../sdk/src/platform/security/card-shapes.js';
import { snapshotJudgmentEvidence } from '../sdk/src/platform/gate/judgment-input.js';

function checkedNumber(prefix: string): string {
  return Array.from({ length: 10 }, (_, digit) => prefix + digit).find(passesLuhn)!;
}
const epoch = checkedNumber('179234168179');
const later = checkedNumber('179234168189');
const card = checkedNumber('411111111111111111');
function input(transcript: Record<string, unknown>[]) {
  return { request: 'Review the repository and write its report.', response: 'The report is written.', transcript,
    tools: ['agent', 'exec'], delegated: [], requirements: null, initial: null };
}

test('agent times, contract history and overflow paths remain usable observations without sending card-shaped numbers', () => {
  const original = input([
    { role: 'tool', content: JSON.stringify({ startedAt: Number(epoch), status: 'completed', output: 'Reviewed parser.ts.' }) },
    { role: 'tool', content: JSON.stringify({ history: [{ at: Number(epoch), status: 'running' }, { at: Number(later), status: 'passed' }] }) },
    { role: 'tool', content: JSON.stringify({ progress_file: `.goodvibes/.overflow/${epoch}-exec-progress.txt`, exitCode: 0 }) },
  ]);
  const before = JSON.stringify(original), projection = new CompletionEvidenceProjection();
  const projected = projection.prepare(original) as ReturnType<typeof input> & { evidenceProjection: { withheld: string[] } };
  const messages = projected.transcript.map(message => JSON.parse(String(message.content)));
  expect(messages[0].startedAt).toStartWith('[WITHHELD:card-shaped-number:');
  expect(messages[1].history[0].at).toBe(messages[0].startedAt);
  expect(messages[1].history[1].at).not.toBe(messages[0].startedAt);
  expect(messages[2].progress_file).toContain(messages[0].startedAt);
  expect(messages[0].output).toBe('Reviewed parser.ts.');
  expect(messages[1].history[1].status).toBe('passed');
  expect(messages[2].exitCode).toBe(0);
  expect(projected.evidenceProjection.withheld).toHaveLength(2);
  expect(JSON.stringify(projected)).not.toContain(epoch);
  expect(JSON.stringify(projected)).not.toContain(later);
  expect(snapshotJudgmentEvidence(projected)).toEqual(projected);
  expect(projection.prepare(original)).toEqual(projected);
  expect(JSON.stringify(original)).toBe(before);
});

test('nested JSON numbers are screened before precision loss and escaped strings stay parseable', () => {
  const inner = `{"amount":${card},"description":"quoted \\\"value\\\"","path":"${epoch}-progress.txt"}`;
  const projected = new CompletionEvidenceProjection().prepare(input([
    { role: 'tool', content: JSON.stringify({ nested: inner }) },
  ])) as ReturnType<typeof input>;
  const nested = JSON.parse(JSON.parse(String(projected.transcript[0]!.content)).nested);
  expect(nested.amount).toStartWith('[WITHHELD:');
  expect(nested.description).toBe('quoted "value"');
  expect(JSON.stringify(projected)).not.toContain(card);
  expect(JSON.stringify(projected)).not.toContain(String(Number(card)));
  expect(snapshotJudgmentEvidence(projected)).toEqual(projected);
});

test('protected observations become explicit missing evidence while relevant public observations remain', () => {
  const projected = new CompletionEvidenceProjection().prepare(input([
    { role: 'tool', content: JSON.stringify({ cvv: '123', status: 'success' }) },
    { role: 'tool', content: 'password=synthetic-private-value' },
    { role: 'tool', content: 'Wrote review.md; inspected only parser.ts, other requested files remain unread.' },
  ])) as ReturnType<typeof input> & { evidenceProjection: { meaning: string } };
  expect(projected.transcript[0]).toHaveProperty('unavailableObservation');
  expect(projected.transcript[1]).toHaveProperty('unavailableObservation');
  expect(projected.transcript[2]!.content).toContain('remain unread');
  expect(projected.evidenceProjection.meaning).toContain('missing evidence never establishes completion');
  expect(JSON.stringify(projected)).not.toContain('synthetic-private-value');
  expect(JSON.stringify(projected)).not.toContain('"cvv"');
  expect(snapshotJudgmentEvidence(projected)).toEqual(projected);
});

test('neither original user instructions nor the exact final draft can be rewritten to bypass the privacy screen', () => {
  for (const change of ['request', 'response', 'user', 'initial'] as const) {
    const original: Omit<ReturnType<typeof input>, 'initial'> & { initial: unknown } = input([]);
    const secret = 'password=synthetic-private-value';
    if (change === 'request' || change === 'response') original[change] = secret;
    if (change === 'user') original.transcript.push({ role: 'user', content: secret });
    if (change === 'initial') original.initial = { request: secret, transcript: [] };
    expect(() => new CompletionEvidenceProjection().prepare(original)).toThrow();
  }
});
