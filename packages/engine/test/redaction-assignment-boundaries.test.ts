import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { redactSensitiveDataAsync } from '../sdk/src/platform/utils/redaction.ts';
import type { RedactionPart } from '../sdk/src/platform/utils/batteries/redaction.ts';
import { errorSpan, errorText } from './_helpers/authored-error-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function authoredAssignments(parts: readonly RedactionPart[]) {
  const roles = { label: 'other', documentId: 'other', token: 'secret', password: 'secret', body: 'content' } as const;
  const spans = parts.filter((part) => part.kind === 'span');
  const containsCredential = spans.some((part) => part.field === 'token' || part.field === 'password');
  const sources = new Map(spans.map((part) => [JSON.stringify({ phase: 'source', parts, target: part.reference }),
    { line: containsCredential, span: part.field === 'token' || part.field === 'password' }]));
  const residual = JSON.stringify({ parts: parts.map((part) => part.kind === 'span'
    ? { kind: 'withheld', reference: part.reference } : part) });
  return fakePort((name, question, state) => {
    if (name === 'kind') {
      const entry = Object.entries(roles).find(([field]) => JSON.stringify(state) === JSON.stringify({ field }));
      if (!entry) throw new Error('Unspecified authored assignment role');
      return choiceAnswer(question, entry[1], 0.99);
    }
    if (name === 'lineHasCredential' || name === 'spanIsCredential') {
      const source = sources.get(JSON.stringify(state));
      if (!source) throw new Error('Unspecified authored assignment source');
      return noulAnswer((name === 'lineHasCredential' ? source.line : source.span) ? 0.99 : 0.01);
    }
    if (name === 'credentialRemains' && JSON.stringify(state) === residual) return noulAnswer(0.01);
    throw new Error('Unspecified authored assignment question or residual');
  });
}

const fixtures: readonly { readonly name: string; readonly input: string; readonly output: string;
  readonly parts: readonly RedactionPart[]; readonly privateValues: readonly string[]; readonly roles: readonly string[] }[] = [
  { name: 'keeps every independent adjacent assignment role',
    input: 'label:urgent token=source-secret-token', output: 'label:urgent token=[REDACTED]',
    parts: [errorText('label:'), errorSpan('label'), errorText(' token='), errorSpan('token', 2), errorText('')],
    privateValues: ['source-secret-token'], roles: ['label', 'token'] },
  { name: 'retains an adjacent credential when the preceding ordinary field is empty',
    input: 'label: token=source-secret-token', output: 'label: token=[REDACTED]',
    parts: [errorText('label: token='), errorSpan('token'), errorText('')],
    privateValues: ['source-secret-token'], roles: ['token'] },
  { name: 'preserves spacing and local ordinary values across three assignments',
    input: 'label:urgent\t token = source-secret-token  documentId = ordinary-doc',
    output: 'label:urgent\t token = [REDACTED]  documentId = ordinary-doc',
    parts: [errorText('label:'), errorSpan('label'), errorText('\t token = '), errorSpan('token', 2),
      errorText('  documentId = '), errorSpan('documentId', 3), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['label', 'token', 'documentId'] },
  { name: 'retains independent natural-language declarations',
    input: 'label is urgent token is source-secret-token', output: 'label is urgent token is [REDACTED]',
    parts: [errorText('label is '), errorSpan('label'), errorText(' token is '), errorSpan('token', 2), errorText('')],
    privateValues: ['source-secret-token'], roles: ['label', 'token'] },
  { name: 'keeps quoted content indivisible while reading its following identifier',
    input: 'body="label:urgent token=source-secret-token" documentId=ordinary-doc',
    output: 'body=[REDACTED_TEXT] documentId=ordinary-doc',
    parts: [errorText('body='), errorSpan('body'), errorText(' documentId='), errorSpan('documentId', 2), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['body', 'documentId'] },
  { name: 'keeps single-quoted content indivisible',
    input: "body='label:urgent token=source-secret-token' documentId=ordinary-doc",
    output: 'body=[REDACTED_TEXT] documentId=ordinary-doc',
    parts: [errorText('body='), errorSpan('body'), errorText(' documentId='), errorSpan('documentId', 2), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['body', 'documentId'] },
  { name: 'keeps escaped quotes inside one content value',
    input: 'body="label:urgent \\"token=source-secret-token\\"" documentId=ordinary-doc',
    output: 'body=[REDACTED_TEXT] documentId=ordinary-doc',
    parts: [errorText('body='), errorSpan('body'), errorText(' documentId='), errorSpan('documentId', 2), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['body', 'documentId'] },
  { name: 'keeps an unmatched inner quote inside valid quoted assignment content',
    input: `body='token is "source-secret-token' documentId=ordinary-doc`,
    output: 'body=[REDACTED_TEXT] documentId=ordinary-doc',
    parts: [errorText('body='), errorSpan('body'), errorText(' documentId='), errorSpan('documentId', 2), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['body', 'documentId'] },
  { name: 'keeps an unmatched inner quote inside valid quoted declaration content',
    input: `body is "token='source-secret-token" documentId=ordinary-doc`,
    output: 'body is [REDACTED_TEXT] documentId=ordinary-doc',
    parts: [errorText('body is '), errorSpan('body'), errorText(' documentId='), errorSpan('documentId', 2), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['body', 'documentId'] },
  { name: 'does not let quoted inner syntax acquire a following quoted field',
    input: `body is "token='source-secret-token" documentId='ordinary-doc'`,
    output: "body is [REDACTED_TEXT] documentId='ordinary-doc'",
    parts: [errorText('body is '), errorSpan('body'), errorText(' documentId='), errorSpan('documentId', 2), errorText('')],
    privateValues: ['source-secret-token', 'ordinary-doc'], roles: ['body', 'documentId'] },
  { name: 'contains nested literal credentials even in an ordinary quoted field',
    input: 'documentId="password=source-secret-token"', output: 'documentId=[REDACTED]',
    parts: [errorText('documentId='), errorSpan('documentId'), errorText('')],
    privateValues: ['source-secret-token'], roles: ['documentId'] },
  { name: 'retains an ordinary candidate overlapped by its own assignment',
    input: 'documentId=key-rotation-policy-for-tenants token=source-secret-token',
    output: 'documentId=key-rotation-policy-for-tenants token=[REDACTED]',
    parts: [errorText('documentId='), errorSpan('documentId'), errorText(' token='), errorSpan('token', 2), errorText('')],
    privateValues: ['key-rotation-policy-for-tenants', 'source-secret-token'], roles: ['documentId', 'token'] },
  { name: 'retains two credential roles followed by an ordinary label',
    input: 'password=source-secret-one token=source-secret-two label:urgent',
    output: 'password=[REDACTED] token=[REDACTED] label:urgent',
    parts: [errorText('password='), errorSpan('password'), errorText(' token='), errorSpan('token', 2),
      errorText(' label:'), errorSpan('label', 3), errorText('')],
    privateValues: ['source-secret-one', 'source-secret-two'], roles: ['password', 'token', 'label'] },
];

describe('canonical outgoing assignment boundaries', () => {
  for (const fixture of fixtures) test(fixture.name, async () => {
    const { port, requests } = authoredAssignments(fixture.parts);
    installJudgmentPort(port);
    expect(await redactSensitiveDataAsync(fixture.input)).toBe(fixture.output);
    const wire = JSON.stringify(requests.map((request) => ({ state: request.state, questions: request.questions })));
    for (const value of fixture.privateValues) expect(wire).not.toContain(value);
    expect(requests.filter((request) => 'kind' in request.questions).map((request) => request.state))
      .toEqual(fixture.roles.map((field) => ({ field })));
  });

  test.each(['label:"urgent token=source-secret-token', "label:'urgent token=source-secret-token"])(
    'holds malformed quoted assignments before semantic transmission: %s', async (input) => {
      const { port, requests } = authoredAssignments([]);
      installJudgmentPort(port);
      expect(await redactSensitiveDataAsync(input)).toBe('[REDACTED]');
      expect(requests).toHaveLength(0);
    });
});
