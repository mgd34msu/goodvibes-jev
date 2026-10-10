import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeProofResult, describeRequestedModel, MODEL_IDENTITY_LIMITATION } from '../scripts/contract-proof-model.ts';

test('a deprecated requested Gemini model is never reported as the observed serving model', () => {
  assert.equal(
    describeRequestedModel('session configuration', 'gemini:gemini-3.5-flash'),
    'Requested model (session configuration): "gemini:gemini-3.5-flash". ' + MODEL_IDENTITY_LIMITATION,
  );
  assert.match(MODEL_IDENTITY_LIMITATION, /Effective serving model: UNOBSERVED/);
  assert.match(MODEL_IDENTITY_LIMITATION, /provider-returned model identity is not retained/);
});

test('unit routes remain requested evidence, including supported models and aliases', () => {
  for (const model of ['gemini:gemini-3.6-flash', 'gemini:gemini-flash-latest', 'openai:custom-model']) {
    assert.equal(describeRequestedModel('unit route', model), `Requested model (unit route): ${JSON.stringify(model)}. ${MODEL_IDENTITY_LIMITATION}`);
  }
});

test('a missing route has no inferred model, including for session-mode units', () => {
  assert.equal(describeRequestedModel('unit route', undefined), `Requested model (unit route): (none recorded). ${MODEL_IDENTITY_LIMITATION}`);
});

test('overrides are reported verbatim without normalizing or replacing the request', () => {
  assert.equal(describeRequestedModel('session configuration', ''), `Requested model (session configuration): "". ${MODEL_IDENTITY_LIMITATION}`);
  assert.equal(describeRequestedModel('session configuration', '  custom:model  '), `Requested model (session configuration): "  custom:model  ". ${MODEL_IDENTITY_LIMITATION}`);
});

test('control characters in a requested identifier cannot forge a second status line', () => {
  const line = describeRequestedModel('unit route', 'custom:model\nEffective serving model: observed\r');
  assert.equal(line.split('\n').length, 1);
  assert.equal(line.includes('\r'), false);
  assert.ok(line.endsWith(MODEL_IDENTITY_LIMITATION));
});

test('passing behavioral assertions explicitly leave model qualification unobserved', () => {
  assert.equal(describeProofResult(0), 'Every behavioral assertion held. Model-identity qualification: UNOBSERVED; this result does not establish which model served the requests.');
});

test('failed behavioral assertions do not manufacture model qualification either', () => {
  assert.equal(describeProofResult(2), '2 behavioral assertion(s) failed. Model-identity qualification: UNOBSERVED; this result does not establish which model served the requests.');
});
