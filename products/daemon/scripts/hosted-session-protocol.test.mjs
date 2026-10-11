import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionEventDecoder, syntheticSystemOneAnswers } from './hosted-session-protocol.mjs';

test('synthetic answers preserve requested types and normalized criteria distributions', () => {
  const answers = syntheticSystemOneAnswers({
    route: { type: 'choice', criteria: { contract: null, converse: null } },
    intent: { type: 'choice', criteria: { chat: null, task: null } },
    risk: { type: 'score', criteria: ['none', 'high'] },
    plan: { type: 'noul' },
  });
  assert.equal(answers.route.choice, 'converse');
  assert.equal(answers.intent.choice, 'chat');
  assert.deepEqual(answers.risk.legend, { 0: 'none', 1: 'high' });
  assert.deepEqual(answers.plan, { type: 'noul', noul: 0.01 });
  for (const answer of [answers.route, answers.intent, answers.risk]) {
    assert.equal(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0), 1);
  }
});

test('new or malformed question protocols fail instead of silently synthesizing a pass', () => {
  for (const questions of [null, [], { bad: { type: 'unknown' } }, { bad: { type: 'choice', criteria: {} } }, { bad: { type: 'score', criteria: [] } }]) {
    assert.throws(() => syntheticSystemOneAnswers(questions));
  }
});

test('stream evidence survives one-byte UTF-8 chunks and does not confuse comments with data', () => {
  const values = [];
  const decode = sessionEventDecoder(value => values.push(value));
  const bytes = new TextEncoder().encode(': heartbeat\n\nevent: turn\ndata: {"content":"café 🌻"}\n\ndata: {"type":"TURN_COMPLETED"}\n\n');
  for (const byte of bytes) decode(Uint8Array.of(byte));
  assert.deepEqual(values, [{ content: 'café 🌻' }, { type: 'TURN_COMPLETED' }]);
});

test('malformed and oversized event evidence fails closed', () => {
  assert.throws(() => sessionEventDecoder(() => {})(new TextEncoder().encode('data: not-json\n\n')));
  assert.throws(() => sessionEventDecoder(() => {})(new Uint8Array(1_048_576)));
});
