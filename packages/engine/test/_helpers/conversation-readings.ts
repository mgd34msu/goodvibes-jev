/** Authored plumbing responses; language accuracy lives in registered live fixtures. */
import { beforeEach, afterEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
export function useConversationReadings() {
  let previous: JudgmentPort | undefined;
  let intent: 'work' | 'conversation' | undefined;
  let reply: 'affirmative' | 'negative' | 'unrelated' | undefined;
  let confidence = 0.99;
  const work = new Set(['fix the parser in src/parse.ts', 'fix the login bug', 'refactor the session broker', 'deploy the worker']);
  const affirmative = new Set(['yes', 'yeah go for it', 'yes but only the adapter']);
  const negative = new Set(['no', 'no, not now', 'nah, not now']);
  const fake = fakePort((name, question, state) => {
    const message = (state as { message: string }).message;
    if (name === 'intent') return choiceAnswer(question, intent ?? (work.has(message) ? 'work' : 'conversation'), confidence);
    if (name === 'reply') return choiceAnswer(question, reply ?? (affirmative.has(message) ? 'affirmative' : negative.has(message) ? 'negative' : 'unrelated'), confidence);
    throw new Error(`Unexpected conversation fixture question: ${name}`);
  });
  beforeEach(() => { intent = undefined; reply = undefined; confidence = 0.99; fake.requests.length = 0; previous = installJudgmentPort(fake.port); });
  afterEach(() => installJudgmentPort(previous));
  return { port: fake.port, set(value: { intent?: typeof intent; reply?: typeof reply; confidence?: number }) { intent = value.intent; reply = value.reply; confidence = value.confidence ?? 0.99; }, requests: fake.requests };
}
