import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { coverageFindings, questionCoverage, sourceFindings } from '../scripts/judgment-lint-rules.ts';
import { autonomousDisposition, autonomousRefusal } from '../sdk/src/platform/gate/batteries/autonomous.js';
import { registry } from '../sdk/src/platform/gate/judgment-registry.js';

const dispositionName = 'engine.gate.autonomous-disposition';
const refusalName = 'engine.gate.autonomous-refusal';

test('shared autonomous questions are registered decisions with recognized source attribution', () => {
  expect(registry.get(dispositionName)).toBe(autonomousDisposition);
  expect(registry.get(refusalName)).toBe(autonomousRefusal);
  const registered = new Set(registry.list().map(decision => decision.name));
  for (const path of ['../sdk/src/platform/gate/batteries/autonomous.ts', '../sdk/src/platform/gate/autonomous-decision.ts']) {
    expect(sourceFindings(path, readFileSync(new URL(path, import.meta.url), 'utf8'), registered)).toEqual([]);
  }
  const source = readFileSync(new URL('../sdk/src/platform/gate/batteries/autonomous.ts', import.meta.url), 'utf8');
  // Removing either registration must be caught; neither call relies on a
  // forwarding-wrapper exemption or a lint-recognized factory name alone.
  for (const name of [dispositionName, refusalName]) {
    const missing = new Set(registered); missing.delete(name);
    expect(sourceFindings('autonomous.ts', source, missing).some(finding => finding.message.includes(`"${name}"`))).toBe(true);
  }
});

test('autonomous fixture coverage includes every outcome family and both refusal answers', async () => {
  const decisions = [autonomousDisposition, autonomousRefusal];
  expect(await coverageFindings(decisions)).toEqual({ findings: [], open: [`${dispositionName} disposition`] });
  const expected = ['act', 'reject', 'revise_0', 'revise_1', 'defer_0', 'revise_0'];
  let index = 0;
  const disposition = fakePort((_name, question) => choiceAnswer(question, expected[index++]!, 0.99));
  const checks = await autonomousDisposition.checkFixtures(disposition.port);
  expect(checks).toHaveLength(autonomousDisposition.fixtureCount);
  expect(checks.every(check => check.correct && check.outcome === 'act')).toBe(true);
  expect(questionCoverage(checks)).toEqual([{ question: 'disposition', answers: undefined, expected: ['act', 'defer_0', 'reject', 'revise_0', 'revise_1'], missing: [] }]);
  const offered = disposition.requests.map(request => {
    const question = request.questions.disposition!;
    if (question.type !== 'choice') throw new Error('not a disposition');
    return Object.keys(question.criteria);
  });
  expect(offered[3]).toEqual(['reject', 'revise_0', 'revise_1']);
  expect(offered[4]).toEqual(['reject', 'defer_0']);
  expect(offered[5]).toEqual(['reject', 'revise_0']);
  expect(disposition.requests[5]!.state).toHaveProperty('uncertainty');
  for (const request of disposition.requests) {
    expect(request.context).toMatchObject({ battery: dispositionName, batteryVersion: 1, pattern: 'dispatch', site: 'calibration' });
    expect(request.context?.fixture).toBeTruthy();
    expect(request.state).not.toHaveProperty('expect');
  }
  let refusalIndex = 0;
  const refusal = fakePort(() => noulAnswer(refusalIndex++ === 0 ? 0.99 : 0.01));
  const refusalChecks = await autonomousRefusal.checkFixtures(refusal.port);
  expect(refusalChecks.map(check => [check.expected, check.got, check.correct])).toEqual([['yes', 'yes', true], ['no', 'no', true]]);
  expect(questionCoverage(refusalChecks)).toEqual([{ question: 'refuse', answers: ['no', 'yes'], expected: ['no', 'yes'], missing: [] }]);
});

test('recorded autonomous calibration retains question identity, labels and high-stakes readings', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const controller = new AbortController();
  const disposition = fakePort((_name, question) => choiceAnswer(question, Object.keys(question.type === 'choice' ? question.criteria : {})[0]!, 0.7));
  const checks = await autonomousDisposition.checkFixtures(withDecisionLog(disposition.port, log), { signal: controller.signal });
  expect(checks.every(check => check.outcome !== 'act')).toBe(true);
  expect(disposition.requests.every(request => request.signal === controller.signal)).toBe(true);
  expect(log.query({ battery: dispositionName })).toHaveLength(autonomousDisposition.fixtureCount);
  for (const entry of log.query()) {
    expect(entry.context.site).toBe('calibration');
    expect(entry.context.fixture).toBeTruthy();
    expect(entry.status).toBe('answered');
    if (entry.status === 'answered') expect(entry.notes[0]).toMatchObject({ kind: 'readings', readings: { confidence: 0.7, bandOutcome: 'confirm' } });
  }
});
