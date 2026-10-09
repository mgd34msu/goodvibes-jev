import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readNaturalLanguageSchedule } from '@goodvibes-jev/engine/sdk/platform/automation';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { sourceFindings } from '../scripts/judgment-lint-rules.ts';
import { registry } from '../sdk/src/platform/automation/judgment-registry.ts';

const path = 'packages/engine/sdk/src/platform/automation/schedule-reading.ts';

test('actual schedule source is attributable only while its decision is registered', () => {
  const source = readFileSync(new URL('../sdk/src/platform/automation/schedule-reading.ts', import.meta.url), 'utf8');
  const registered = new Set(registry.list().map(decision => decision.name));
  expect(sourceFindings(path, source, registered)).toEqual([]);
  expect(sourceFindings(path, source, new Set()).some(finding => finding.rule === 'registered-use')).toBe(true);
});

test('public scheduling and calibration invoke the same registered owner', async () => {
  const module = await import('../sdk/src/platform/automation/schedule-reading.ts');
  const owner = Reflect.get(module, 'scheduleReading') as typeof module.scheduleReading | undefined;
  expect(owner).toBeDefined();
  if (owner === undefined) throw new Error('The schedule decision owner is missing');
  const decision = registry.get('automation.schedule')!;
  expect(decision).toBe(owner);
  const read = spyOn(owner, 'read');
  const f = fakePort((_name, question) => choiceAnswer(question, 'unknown', 0.99));
  const input = { phrase: 'later', now: Date.parse('2026-07-10T23:50:00Z'), timezone: 'UTC' };
  try {
    await readNaturalLanguageSchedule(input, { port: f.port });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toBe(input);
    const checks = await decision.checkFixtures(f.port);
    expect(checks).toHaveLength(18);
    expect(read).toHaveBeenCalledTimes(19);
    expect(f.requests).toHaveLength(19);
    expect(f.requests.every(request => request.context?.battery === decision.name && request.context?.batteryVersion === decision.version)).toBe(true);
  } finally {
    read.mockRestore();
  }
});
