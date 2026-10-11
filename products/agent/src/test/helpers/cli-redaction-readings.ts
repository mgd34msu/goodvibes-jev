import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { EntryType, Question } from '@goodvibes-jev/judgment';

const secretFields = new Set(['token', 'api_key', 'api-key', 'secret', 'password', 'access_token',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'GOODVIBES_DAEMON_TOKEN']);
const ordinaryFields = new Set(['monkey', 'donkey', 'keyboard', 'hotkey', 'status', 'count']);
const safeResiduals = new Set([
  ...[...secretFields, ...ordinaryFields].flatMap(field => [`${field}=`, `${field}: `]),
  'hello world, status=, count=', 'the run failed while using  as auth',
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Exact authored text controls. Unknown roles remain unsettled. */
export function cliRedactionAnswer(name: string, question: Question, state: EntryType): unknown {
  const input = record(state);
  if (name === 'kind') {
    const field = input.field;
    if (typeof field !== 'string') throw new Error('Invalid fixture field.');
    if (secretFields.has(field)) return choiceAnswer(question, 'secret', 0.99);
    if (ordinaryFields.has(field)) return choiceAnswer(question, 'other', 0.99);
    return choiceAnswer(question, 'other', 0.5);
  }
  if (name === 'credentialRemains') {
    const parts = Array.isArray(input.parts) ? input.parts.map(record) : [];
    const text = parts.map(part => typeof part.text === 'string' ? part.text : '').join('');
    return noulAnswer(parts.some(part => part.kind === 'withheld') && safeResiduals.has(text) ? 0.01 : 0.5);
  }
  if (name === 'lineHasCredential' || name === 'spanIsCredential') {
    const parts = Array.isArray(input.parts) ? input.parts.map(record) : [];
    const target = parts.find(part => part.reference === input.target);
    if (input.target === 'whole-line' && parts.some(part => part.kind === 'withheld')
      && safeResiduals.has(parts.map(part => typeof part.text === 'string' ? part.text : '').join(''))) return noulAnswer(0.01);
    if (typeof target?.field === 'string' && ordinaryFields.has(target.field)) return noulAnswer(0.01);
    if (parts.length === 3 && parts[0]?.text === 'the run failed while using ' && parts[1]?.syntax === 'candidate-token'
      && parts[2]?.text === ' as auth') return noulAnswer(0.99);
    throw new Error('Unrecognized redaction text fixture.');
  }
  throw new Error(`Unexpected redaction fixture question: ${name}`);
}

export function cliRedactionReadings() { return fakePort(cliRedactionAnswer); }
