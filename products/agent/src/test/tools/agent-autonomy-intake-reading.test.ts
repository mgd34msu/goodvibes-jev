import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { autonomyIntake, readAutonomyIntake, type AutonomyIntakeOptions } from '@goodvibes-jev/engine/sdk/platform/routing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

const defaults = { cadence: 'none', eventTrigger: false, reminder: false, routine: false, research: false, autonomousSchedule: false, delegation: false, approval: false, automationControl: false, mailOrCalendar: false };
function fixture(readings: Partial<typeof defaults> = {}, uncertain?: string, schedule: Readonly<Record<string, string>> = {}) {
  const answers = { ...defaults, ...readings };
  const scheduleParts = { format: 'natural', shape: 'interval', quantity: 'stated', unit: 'hour', ...schedule };
  const synthetic = fakePort((name, question) => {
    if (question.type === 'choice') {
      const choice = name === 'cadence' ? answers.cadence : Object.entries(scheduleParts).find(([key]) => key === name)?.[1];
      if (choice === undefined) throw new Error(`Missing synthetic schedule reading: ${name}.`);
      return choiceAnswer(question, choice, name === uncertain ? 0.51 : 0.99);
    }
    return noulAnswer(name === uncertain ? 0.5 : Object.entries(answers).find(([key]) => key === name)?.[1] === true ? 0.99 : 0.01);
  });
  const screening = researchScreeningFixture();
  return { ...synthetic, ...screening, options: { sourceOwner: screening.owner } satisfies AutonomyIntakeOptions };
}
function deferred<T>() { return Promise.withResolvers<T>(); }

// Synthetic answers test the real reading/log/lifecycle path; genuine semantic
// accuracy is measured separately by the registered battery calibration.
describe('canonical autonomous intake reading', () => {
  test('holds an unscreened request before accessing the installed port', async () => {
    const result = await readAutonomyIntake('Please run a daily report.');
    expect(result).toEqual({ status: 'held', reason: 'source-unavailable', unsettled: [], judgment: null });
  });

  test('refuses asynchronous caller authority before local screening or a semantic call', async () => {
    const f = fixture(); installJudgmentPort(f.port);
    await expect(readAutonomyIntake('A synthetic ongoing-work request.', { ...f.options, assertCurrent: async () => { throw new Error('Rejected asynchronous fixture authority.'); } })).rejects.toThrow('Autonomy intake authority must be synchronous.');
    expect(f.requests).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  test('reads every intent once from the complete request and records the retained evidence', async () => {
    const f = fixture({ eventTrigger: true, mailOrCalendar: true });
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(f.port, log));
    const request = `${'Ordinary fixture context. '.repeat(200)}React when my inbox changes.`;
    const result = await readAutonomyIntake(request, f.options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected settled intake.');
    expect(result.intents.eventTrigger).toBe(true);
    expect(result.intents.mailOrCalendar).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.state).toEqual({ request });
    expect(Object.keys(result.judgment.readings).sort()).toEqual(Object.keys(autonomyIntake.items).sort());
    expect(result.judgment.result.decisionId).toBeDefined();
    expect(result.judgment.result.requestedModel).toBe('jev-latest');
    const entries = log.query({ battery: 'routing.autonomy-intake' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('answered');
    expect(JSON.stringify(entries)).toContain('publish read-only autonomy intake classification');
  });

  test('does not infer routes from negated or quoted keyword piles', async () => {
    const f = fixture(); installJudgmentPort(f.port);
    const result = await readAutonomyIntake('Do not remind, research, delegate, approve, cancel automation, or read email. Explain "daily routine webhook".', f.options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected settled intake.');
    expect(Object.values(result.intents).every(value => value === false)).toBe(true);
    expect(result.schedule).toEqual({ missing: [], notes: [] });
  });

  for (const key of Object.keys(autonomyIntake.items)) test(`holds the complete fan-out when ${key} does not permit action`, async () => {
    const f = fixture({ reminder: true }, key); installJudgmentPort(f.port);
    const result = await readAutonomyIntake('Remind me later.', f.options);
    expect(result.status).toBe('held');
    if (result.status !== 'held') throw new Error('Expected held intake.');
    expect(result.reason).toBe('unsettled');
    expect(result.unsettled).toEqual([key]);
    expect(result.judgment?.readings).toBeDefined();
    expect('intents' in result).toBe(false);
  });

  for (const intent of ['reminder', 'autonomousSchedule']) test(`holds contradictory ${intent} and no-cadence readings`, async () => {
    const f = fixture({ [intent]: true }); installJudgmentPort(f.port);
    const result = await readAutonomyIntake('A synthetic timed-work request.', f.options);
    expect(result.status).toBe('held');
    if (result.status !== 'held') throw new Error('Expected held intent.');
    expect(result.unsettled).toEqual(['cadence.intent']);
    expect(result.judgment?.readings.cadence.outcome).toBe('act');
    expect('intents' in result).toBe(false);
  });

  test('retains a vague cadence as missing data without choosing a time', async () => {
    const f = fixture({ cadence: 'inexact', autonomousSchedule: true }); installJudgmentPort(f.port);
    const result = await readAutonomyIntake('Run a daily report.', f.options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected settled intent.');
    expect(result.schedule.value).toBeUndefined();
    expect(result.schedule.missing).toEqual(['scheduleValue', 'timezone']);
    expect(f.requests).toHaveLength(1);
  });

  test('uses the canonical schedule owner and retains all natural schedule phases', async () => {
    const f = fixture({ cadence: 'every', reminder: true });
    using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(f.port, log));
    const result = await readAutonomyIntake('Remind me every 2 hours to check the deploy.', f.options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected settled intake.');
    expect(result.schedule).toMatchObject({ kind: 'every', value: '2h', missing: [] });
    expect(result.judgment.scheduleObservations).toHaveLength(4);
    expect(log.query({ battery: 'automation.schedule' })).toHaveLength(4);
  });

  const literalCases: readonly { readonly request: string; readonly cadence: string; readonly schedule: Readonly<Record<string, string>>; readonly value: string; readonly intents: Partial<typeof defaults> }[] = [
    { request: 'At 2026-11-12T14:30:00Z remind me to check the deploy.', cadence: 'at', schedule: { format: 'timestamp', timestamp: 'stated' }, value: '2026-11-12T14:30:00.000Z', intents: { reminder: true } },
    { request: 'Run the audit with cron 0 9 * * 1-5.', cadence: 'cron', schedule: { format: 'cron', cron: 'stated' }, value: '0 9 * * 1-5', intents: { autonomousSchedule: true } },
  ];
  for (const { request, cadence, schedule, value, intents } of literalCases) test(`delegates literal ${cadence} admission and retains its complete source evidence`, async () => {
    const f = fixture({ cadence, ...intents }, undefined, schedule);
    using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(f.port, log));
    const result = await readAutonomyIntake(request, f.options);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected settled literal cadence.');
    expect(result.schedule).toMatchObject({ kind: cadence, value, missing: [] });
    expect(result.judgment.scheduleObservations).toHaveLength(3);
    expect(result.judgment.scheduleObservations[0]?.state).toBe(request);
    expect(result.judgment.scheduleObservations[1]?.state).toMatchObject({ phrase: request, shape: schedule.format });
    expect(log.query({ battery: 'automation.schedule' })).toHaveLength(3);
  });

  test('holds an exact supplied cadence when its canonical parts reading does not settle', async () => {
    const f = fixture({ cadence: 'every', reminder: true }, 'quantity'); installJudgmentPort(f.port);
    const result = await readAutonomyIntake('Remind me every 2 hours to check the deploy.', f.options);
    expect(result.status).toBe('held');
    if (result.status !== 'held') throw new Error('Expected held cadence.');
    expect(result.reason).toBe('schedule-unsettled');
    expect(result.unsettled).toEqual(['cadence.parts']);
    expect(result.judgment?.scheduleReading?.kind).toBe('unknown');
    expect(result.judgment?.scheduleObservations).toHaveLength(3);
    expect('intents' in result).toBe(false);
  });

  test('withholds a redacted request before port lookup or judgment logging', async () => {
    const screening = researchScreeningFixture({ spans: source => [{ part: 0, start: 0, end: source.parts[0]?.length ?? 0 }] });
    const f = fixture(); installJudgmentPort(f.port);
    const result = await readAutonomyIntake('Protect this complete synthetic request.', { sourceOwner: screening.owner });
    expect(result.status).toBe('held'); expect(f.requests).toHaveLength(0);
  });

  test('rejects cancellation while local source screening is pending without a semantic call', async () => {
    const began = deferred<void>(), finish = deferred<void>();
    const screening = researchScreeningFixture({ beforeProposal: async () => { began.resolve(); await finish.promise; } });
    const f = fixture(); installJudgmentPort(f.port);
    const controller = new AbortController();
    const reading = readAutonomyIntake('A synthetic ongoing-work request.', { sourceOwner: screening.owner, signal: controller.signal });
    const observed = reading.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));
    await began.promise; controller.abort(); finish.resolve();
    expect((await observed).status).toBe('rejected'); expect(f.requests).toHaveLength(0);
  });

  test('rejects a replaced port while its original transport ignores cancellation', async () => {
    const f = fixture(), began = deferred<void>(), finish = deferred<void>();
    const port: JudgmentPort = { ...f.port, async ask(request) { began.resolve(); await finish.promise; return f.port.ask(request); } };
    installJudgmentPort(port);
    const reading = readAutonomyIntake('A synthetic ongoing-work request.', f.options);
    const observed = reading.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));
    await began.promise; installJudgmentPort(f.port); expect((await observed).status).toBe('rejected');
    finish.resolve(); await Promise.resolve();
  });

  test('fences caller/source revision changes before publication and does not reuse stale evidence', async () => {
    const f = fixture(), began = deferred<void>(), finish = deferred<void>();
    let current = true;
    const port: JudgmentPort = { ...f.port, async ask(request) { began.resolve(); await finish.promise; return f.port.ask(request); } };
    installJudgmentPort(port);
    const reading = readAutonomyIntake('A synthetic ongoing-work request.', { ...f.options, assertCurrent: () => { if (!current) throw new Error('Retired fixture source.'); } });
    const observed = reading.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));
    await began.promise; current = false; finish.resolve(); expect((await observed).status).toBe('rejected');
    current = true; installJudgmentPort(f.port);
    expect((await readAutonomyIntake('A synthetic ongoing-work request.', f.options)).status).toBe('ready');
  });

  test('a retained publication restriction rejects a later port replacement', async () => {
    const f = fixture(); installJudgmentPort(f.port);
    const guards: (() => void)[] = [];
    const result = await readAutonomyIntake('A synthetic ongoing-work request.', { ...f.options, retainCurrent: guard => { guards.push(guard); } });
    expect(result.status).toBe('ready'); expect(guards).toHaveLength(1);
    guards[0]?.(); installJudgmentPort(fixture().port);
    expect(() => guards[0]?.()).toThrow();
  });
  test('retained native restrictions do not call their own caller aggregation or its retired execution lease', async () => {
    const f = fixture(); installJudgmentPort(f.port);
    const guards = new Map<string | (() => void), () => void>();
    let live = true, calls = 0;
    const current: AutonomyIntakeOptions = { ...f.options,
      assertCurrent() {
        calls++;
        if (!live) throw new Error('Retired native execution fixture.');
        for (const guard of guards.values()) guard();
      },
      retainCurrent(guard, key) { guards.set(key ?? guard, guard); },
    };
    const result = await readAutonomyIntake('A synthetic ongoing-work request.', current);
    expect(result.status).toBe('ready'); expect(guards.size).toBe(1);
    expect(f.requests).toHaveLength(1); expect(calls).toBeGreaterThan(0);
    const settledCalls = calls; live = false;
    for (const guard of guards.values()) guard();
    expect(calls).toBe(settledCalls); expect(f.requests).toHaveLength(1);
    installJudgmentPort(fixture().port);
    expect(() => { for (const guard of guards.values()) guard(); }).toThrow();
  });

  test.each(['caller', 'owner', 'owner-method', 'registrar', 'signal'] as const)(
    'retained native restrictions reject original %s replacement without invoking a retired caller', async changed => {
      const f = fixture(); installJudgmentPort(f.port);
      const guards: (() => void)[] = [];
      const controller = new AbortController();
      let calls = 0;
      const current = { ...f.options, signal: controller.signal,
        assertCurrent() { calls++; }, retainCurrent(guard: () => void) { guards.push(guard); },
      };
      expect((await readAutonomyIntake('A synthetic ongoing-work request.', current)).status).toBe('ready');
      const settledCalls = calls;
      if (changed === 'caller') current.assertCurrent = () => { calls++; };
      if (changed === 'owner') current.sourceOwner = fixture().owner;
      if (changed === 'owner-method') Object.defineProperty(f.owner, 'project', { value: () => [], configurable: true });
      if (changed === 'registrar') current.retainCurrent = () => {};
      if (changed === 'signal') current.signal = new AbortController().signal;
      expect(() => { for (const guard of guards) guard(); }).toThrow();
      expect(calls).toBe(settledCalls); expect(f.requests).toHaveLength(1);
    },
  );

  test('retained native restrictions remain canceled after the original invocation has completed', async () => {
    const f = fixture(); installJudgmentPort(f.port);
    const controller = new AbortController(), guards: (() => void)[] = [];
    expect((await readAutonomyIntake('A synthetic ongoing-work request.', {
      ...f.options, signal: controller.signal, retainCurrent: guard => { guards.push(guard); },
    })).status).toBe('ready');
    controller.abort();
    expect(() => { for (const guard of guards) guard(); }).toThrow();
    expect(f.requests).toHaveLength(1);
  });

});
