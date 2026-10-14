import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { StyleReplyReadingError } from '@goodvibes-jev/engine/sdk/platform/email';
import { runPersonalOpsStyleDraft, STYLE_DRAFT_RECORD_ID } from '../../tools/agent-harness-personal-ops-style-draft.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => { throw new Error('This fixture has no name or corpus reading'); }).port); });
afterEach(async () => { installJudgmentPort(previous); await cleanupResearchScreeningFixtures(); });
function fields() {
  return { inbound: { from: '', subject: 'Project update', bodyPreview: 'Complete inbound message.' }, sentMessages: [], context: 'The milestone is ready.' };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected native draft result');
  return Object.fromEntries(Object.entries(value));
}

test('supplied empty corpus still protects complete inbound and returns a detached draft', async () => {
  const owner = researchScreeningFixture(), input = fields();
  const result = await runPersonalOpsStyleDraft(input, { sourceOwner: owner.owner });
  expect(result.status).toBe('drafted'); expect(result.recordId).toBe(STYLE_DRAFT_RECORD_ID);
  const draft = object(result.draft), profile = object(draft.profile);
  expect(draft.body).toContain(input.context); expect(draft.requiresBeforeSendReview).toBe(true);
  expect(profile.isDefault).toBe(true); expect(profile.greeting).toBe('Hi');
  input.context = 'Changed caller context.'; expect(draft.body).not.toContain(input.context);
  expect(JSON.stringify(owner.calls)).toContain('Complete inbound message.');
});
test('no source owner cannot publish supplied context even when the corpus and From are empty', async () => {
  await expect(runPersonalOpsStyleDraft(fields(), {})).rejects.toBeInstanceOf(StyleReplyReadingError);
});
test.each(['confirm', 'send', 'saveReviewCards'] as const)('undeclared %s control is refused before screening', async key => {
  const owner = researchScreeningFixture();
  await expect(runPersonalOpsStyleDraft({ ...fields(), [key]: true }, { sourceOwner: owner.owner })).rejects.toThrow();
  expect(owner.calls).toHaveLength(0);
});
test.each(['accessor', 'hidden', 'proxy'] as const)('%s original DTO refuses without getters or screening', async kind => {
  const owner = researchScreeningFixture(), input = fields(); let getters = 0;
  if (kind === 'accessor') Object.defineProperty(input.inbound, 'subject', { enumerable: true, get() { getters++; return 'Project update'; } });
  if (kind === 'hidden') Object.defineProperty(input, 'unused', { enumerable: false, value: 'private hidden source' });
  const original = kind === 'proxy' ? new Proxy(input, { get() { getters++; throw new Error('Do not invoke'); } }) : input;
  await expect(runPersonalOpsStyleDraft(original, { sourceOwner: owner.owner })).rejects.toThrow();
  expect(owner.calls).toHaveLength(0); expect(getters).toBe(0);
});
test.each(['inbound', 'context', 'empty-corpus-extra'] as const)('private %s source never appears in a draft', async field => {
  const privateText = 'synthetic-style-private-leaf', owner = researchScreeningFixture({ spans: exactSensitiveSpans([privateText]) });
  const input = fields();
  const supplied = field === 'inbound' ? { ...input, inbound: { ...input.inbound, unused: privateText } }
    : field === 'context' ? { ...input, context: privateText }
    : { ...input, sentMessages: [{ bodyPreview: '', unused: privateText }] };
  await expect(runPersonalOpsStyleDraft(supplied, { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
  expect(JSON.stringify(owner.calls)).toContain(privateText);
});
test.each(['source', 'caller', 'cancel'] as const)('%s retirement during native screening holds the original publication', async kind => {
  const input = fields(), controller = new AbortController();
  const options: { signal: AbortSignal; assertCurrent: () => void; sourceOwner: ReturnType<typeof researchScreeningFixture>['owner'] } = { signal: controller.signal, assertCurrent: () => {}, sourceOwner: researchScreeningFixture({ beforeProposal: async () => {
    if (kind === 'source') input.context = 'Changed original context.';
    if (kind === 'caller') options.assertCurrent = () => {};
    if (kind === 'cancel') controller.abort();
  } }).owner };
  await expect(runPersonalOpsStyleDraft(input, options)).rejects.toBeInstanceOf(StyleReplyReadingError);
});
test('retained final restrictions observe the original fields without caller recursion', async () => {
  const owner = researchScreeningFixture(), input = fields(), guards: Array<() => void> = [];
  const result = await runPersonalOpsStyleDraft(input, { sourceOwner: owner.owner,
    assertCurrent: () => guards.forEach(guard => guard()), retainCurrent: guard => { guards.push(guard); } });
  expect(result.status).toBe('drafted'); expect(guards.length).toBeGreaterThan(0);
  guards.forEach(guard => guard()); input.inbound.bodyPreview = 'Changed original body.';
  expect(() => guards.forEach(guard => guard())).toThrow();
});

test.each([
  { inbound: { from: 3, subject: 'Project update', bodyPreview: 'Complete inbound.' }, sentMessages: [] },
  { inbound: { from: '', subject: 'Project update', bodyPreview: 'Complete inbound.' }, sentMessages: [{ bodyPreview: 3 }] },
  { inbound: { from: '', subject: 'Project update', bodyPreview: 'Complete inbound.' }, sentMessages: [], context: false },
])('malformed supplied DTO refuses before native screening', async input => {
  const owner = researchScreeningFixture();
  await expect(runPersonalOpsStyleDraft(input, { sourceOwner: owner.owner })).rejects.toThrow();
  expect(owner.calls).toHaveLength(0);
});
