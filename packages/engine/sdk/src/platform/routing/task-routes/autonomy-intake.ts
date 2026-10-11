import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { defineBattery, oneOf, STAKES_BANDS, yesNo, type BatteryRun, type EntryType, type JudgmentPort, type Questions, type JudgmentResult } from '@goodvibes-jev/judgment';
import { prepareJudgmentResult, captureStrictJudgmentJson } from '../../gate/judgment-result.js';
import { assertJudgmentInput, captureOwnedJson } from '../../gate/judgment-input.js';
import { readNaturalLanguageSchedule, type ScheduleReading } from '../../automation/schedule-reading.js';
import { formatEveryInterval } from '../../automation/schedules.js';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type SourceScreeningReceipt } from '../../security/index.js';

const LOW = STAKES_BANDS.low;
const CADENCES = {
  none: 'The request does not ask to create or change any timed work.',
  at: 'The request specifies one exact, unambiguous execution time or elapsed delay.',
  every: 'The request specifies one exact recurring elapsed interval.',
  cron: 'The request specifies one exact cron expression or calendar recurrence with an explicit time.',
  inexact: 'Timed work is requested, but its time, interval, day or timezone is unstated, ambiguous, contradictory or unsupported.',
} as const;
const noFlags = { eventTrigger: 'no', reminder: 'no', routine: 'no', research: 'no', autonomousSchedule: 'no', delegation: 'no', approval: 'no', automationControl: 'no', mailOrCalendar: 'no' } as const;
const fixture = (request: string, cadence: keyof typeof CADENCES, flags: Partial<{ readonly [K in keyof typeof noFlags]: 'yes' | 'no' }> = {}) => ({
  name: request, state: { request }, expect: { cadence, ...noFlags, ...flags },
});

/** One complete request, one semantic fan-out. The result never authorizes an effect. */
export const autonomyIntake = defineBattery({
  name: 'routing.autonomy-intake', version: 1,
  description: 'Read the requested autonomous work, trigger and cadence without keyword routing or granting effect authority.',
  accuracyFloor: 0.9,
  items: {
    cadence: oneOf('Read the complete request. What timing does it affirmatively ask to create or change? Distinguish an exact execution cadence from a vague recurrence. Existing-job control without a new cadence and event-driven timing such as whenever mail arrives are none. Bare daily or weekly is inexact because it has no time of day; never infer midnight or turn a calendar recurrence into an elapsed interval. Quoted examples, negated instructions and words in identifiers are not requests.', CADENCES, LOW.confidence),
    eventTrigger: yesNo('Does the complete request affirmatively ask for work to begin when an external event, inbound message, webhook or watched source changes? A time-based schedule or merely discussing trigger implementation does not count.', LOW.yesNo),
    reminder: yesNo('Does the complete request affirmatively ask to remind or notify the user later, rather than carry out substantive autonomous work? Quoted and negated reminders do not count.', LOW.yesNo),
    routine: yesNo('Does the complete request explicitly refer to an existing reviewed routine or checklist and ask to run or promote it? A request to run a report AS a reviewed routine does count even though its deliverable is a report. A new audit, report or recurring job is not an existing routine merely because it repeats. Require an actual routine/checklist reference, not an inferred routine.', LOW.yesNo),
    research: yesNo('Does the complete request ask for a research investigation or a substantive source-backed research deliverable? Explaining a failed test, debugging code, reporting operational status, source identifiers, code files and quoted report titles do not count as research.', LOW.yesNo),
    autonomousSchedule: yesNo('Does the complete request affirmatively ask for substantive Agent work to run on a time-based cadence, rather than a reminder notification? A vague cadence still counts, but event-triggered work and control of an existing job alone do not.', LOW.yesNo),
    delegation: yesNo('Does the complete request ask to delegate isolated implementation, build, fix, refactor or test work to another agent, parallel worker or background owner? An ordinary local command, quoted delegation example or request to avoid delegation does not count.', LOW.yesNo),
    approval: yesNo('Does the complete request ask to inspect or decide a particular pending approval? Discussing approval policy, saying no approval is needed, or ordinary approved work does not count.', LOW.yesNo),
    automationControl: yesNo('Does the complete request ask to act on a particular already-existing job/run/schedule by running it now, cancelling, retrying, pausing or resuming it? The word run by itself does not establish an existing job. Run a daily report or run an audit with cron asks to create timed work, so is no. Discussing control implementation and negated control commands are no.', LOW.yesNo),
    mailOrCalendar: yesNo('Does the complete request require access to a personal mail or calendar ACCOUNT, such as its inbox, incoming email, saved appointments or availability? Specifying a date/time or asking for a reminder does not itself require a calendar account. Mail-related source filenames and quoted examples do not count.', LOW.yesNo),
  },
  fixtures: [
    fixture('Remind me every 2 hours to check the deploy.', 'every', { reminder: 'yes' }),
    fixture('Let me know in two hours that it is time to stretch.', 'at', { reminder: 'yes' }),
    fixture('Run a daily operator report.', 'inexact', { autonomousSchedule: 'yes' }),
    fixture('Run the weekly operator report as a reviewed routine.', 'inexact', { routine: 'yes', autonomousSchedule: 'yes' }),
    fixture('Cancel the running automation run.', 'none', { automationControl: 'yes' }),
    fixture('When a webhook arrives from billing, run a triage brief.', 'none', { eventTrigger: 'yes' }),
    fixture('React whenever a new message arrives in my inbox.', 'none', { eventTrigger: 'yes', mailOrCalendar: 'yes' }),
    fixture('Investigate our competitors and produce a source-backed report.', 'none', { research: 'yes' }),
    fixture('Run a source-backed market investigation every 2 hours.', 'every', { research: 'yes', autonomousSchedule: 'yes' }),
    fixture('Have a parallel worker implement the isolated parser fix.', 'none', { delegation: 'yes' }),
    fixture('Approve pending approval 42.', 'none', { approval: 'yes' }),
    fixture('Inspect my appointments for tomorrow.', 'none', { mailOrCalendar: 'yes' }),
    fixture('At 2026-11-12T14:30:00Z remind me to check the deploy.', 'at', { reminder: 'yes' }),
    fixture('Run the audit with cron 0 9 * * 1-5.', 'cron', { autonomousSchedule: 'yes' }),
    fixture('Do not schedule, remind, delegate, approve, or cancel anything. Explain how those actions work.', 'none'),
    fixture('The test case is named "cancel automation job". Explain why it failed.', 'none'),
    fixture('Fix email-source-report.ts in this conversation without background workers.', 'none'),
    fixture('What should we do next?', 'none'),
  ],
});

type Run = BatteryRun<typeof autonomyIntake.items>;
export type AutonomyCadence = Run['readings']['cadence']['choice'];
export type AutonomyIntents = { readonly [K in keyof typeof noFlags]: boolean };
export interface AutonomyIntakeSchedule {
  readonly kind?: 'at' | 'every' | 'cron';
  readonly value?: string;
  readonly missing: readonly string[];
  readonly notes: readonly string[];
}
export interface AutonomyIntakeEvidence {
  readonly battery: typeof autonomyIntake.name;
  readonly version: typeof autonomyIntake.version;
  readonly originalRequest: string;
  readonly readings: Run['readings'];
  readonly result: Run['result'];
  readonly scheduleReading: ScheduleReading | null;
  readonly scheduleObservations: readonly { readonly state: EntryType; readonly questions: Questions; readonly result: JudgmentResult<Questions> }[];
}
export type AutonomyIntakeReading =
  | { readonly status: 'ready'; readonly cadence: AutonomyCadence; readonly intents: AutonomyIntents; readonly schedule: AutonomyIntakeSchedule; readonly judgment: AutonomyIntakeEvidence }
  | { readonly status: 'held'; readonly reason: 'source-unavailable' | 'protected-source' | 'unsettled' | 'schedule-unsettled'; readonly unsettled: readonly string[]; readonly judgment: AutonomyIntakeEvidence | null };
export interface AutonomyIntakeOptions extends JudgmentReadingOptions {
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

type IntakeScheduleConclusion =
  | { readonly status: 'ready'; readonly schedule: AutonomyIntakeSchedule; readonly reading: ScheduleReading | null }
  | { readonly status: 'held'; readonly reading: ScheduleReading };

async function readIntakeSchedule(request: string, cadence: AutonomyCadence, port: JudgmentPort, current: () => void, signal: AbortSignal, clock: { readonly now: number; readonly timezone: string }): Promise<IntakeScheduleConclusion> {
  if (cadence === 'none') return { status: 'ready', schedule: { missing: [], notes: [] }, reading: null };
  if (cadence === 'inexact') return { status: 'ready', schedule: { missing: ['scheduleValue', 'timezone'], notes: ['The requested cadence is incomplete or ambiguous.'] }, reading: null };
  current();
  const reading = await readNaturalLanguageSchedule({ phrase: request, ...clock }, { port, signal, beforeAttempt: current, site: autonomyIntake.name });
  current();
  if (reading.kind !== 'ready' || reading.schedule.kind !== cadence) return { status: 'held', reading };
  const schedule = reading.schedule;
  return { status: 'ready', reading, schedule: { kind: schedule.kind, value: schedule.kind === 'at' ? new Date(schedule.at).toISOString() : schedule.kind === 'every' ? formatEveryInterval(schedule.intervalMs) : schedule.expression, missing: [], notes: ['Read the exact cadence through the canonical schedule owner.'] } };
}

/** Screen the original in full before port lookup, then retain every reading and response field. */
export async function readAutonomyIntake(request: string, options: AutonomyIntakeOptions = {}): Promise<AutonomyIntakeReading> {
  const signal = options.signal, owner = options.sourceOwner, originalCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const capture = owner?.capture, screen = owner?.screen, project = owner?.project, release = owner?.release, close = owner?.close;
  const clock = Object.freeze({ now: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const source = captureOwnedJson({ request });
  assertJudgmentInput(source);
  const current = () => { signal?.throwIfAborted();
    const assertion: unknown = originalCurrent?.();
    if (assertion !== undefined) {
      try { void Promise.resolve(assertion).catch(() => {}); } catch { /* Refuse asynchronous authority. */ }
      throw new Error('Autonomy intake authority must be synchronous.');
    }
    if (options.signal !== signal || options.sourceOwner !== owner || options.assertCurrent !== originalCurrent || options.retainCurrent !== retainCurrent || owner?.capture !== capture || owner?.screen !== screen || owner?.project !== project || owner?.release !== release || owner?.close !== close) throw new Error('Autonomy intake source changed.'); };
  current();
  if (!owner) return { status: 'held', reason: 'source-unavailable', unsettled: [], judgment: null };
  if (request.length > SOURCE_SCREENING_LIMITS.characters) return { status: 'held', reason: 'protected-source', unsettled: [], judgment: null };
  const handle = owner.capture([request]);
  let receipt: SourceScreeningReceipt | undefined;
  let publicationCurrent = current;
  const sourceCurrent = () => { current(); if (receipt) {
    const projected = owner.project(receipt);
    if (projected.length !== 1 || projected[0] !== request) throw new Error('Autonomy intake source changed.');
  } };
  const abort = () => { void owner.release(handle).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    sourceCurrent();
    const screened = await owner.screen(handle);
    sourceCurrent();
    if (screened.status !== 'settled') return { status: 'held', reason: 'protected-source', unsettled: [], judgment: null };
    receipt = screened.receipt;
    const projected = owner.project(receipt);
    if (projected.length !== 1 || projected[0] !== request) return { status: 'held', reason: 'protected-source', unsettled: [], judgment: null };
    const authority = captureJudgmentPort(autonomyIntake.name, { ...options, assertCurrent: sourceCurrent, prepareResultCapture: prepareJudgmentResult });
    const run = await autonomyIntake.run(authority.port, { request }, { site: autonomyIntake.name, signal: authority.signal });
    authority.assertCurrent();
    const scheduleObservations: { readonly state: EntryType; readonly questions: Questions; readonly result: JudgmentResult<Questions> }[] = [];
    const schedulePort: JudgmentPort = { model: authority.port.model, ...(authority.port.recorder ? { recorder: authority.port.recorder } : {}), async ask(input) {
      const state = captureStrictJudgmentJson(input.state);
      const result = await authority.port.ask({ ...input, state }); authority.assertCurrent();
      scheduleObservations.push(Object.freeze({ state, questions: captureStrictJudgmentJson(input.questions), result })); return result;
    } };
    const unsettled = Object.entries(run.readings).flatMap(([name, reading]) => reading.outcome !== 'act' ? [name] : []);
    if (unsettled.length === 0 && run.readings.cadence.choice === 'none'
      && (run.readings.reminder.verdict === 'yes' || run.readings.autonomousSchedule.verdict === 'yes')) unsettled.push('cadence.intent');
    const schedule = unsettled.length ? null : await readIntakeSchedule(request, run.readings.cadence.choice, schedulePort, authority.assertCurrent, authority.signal, clock);
    authority.assertCurrent();
    const judgment: AutonomyIntakeEvidence = Object.freeze({ battery: autonomyIntake.name, version: autonomyIntake.version, originalRequest: request, readings: captureStrictJudgmentJson(run.readings), result: run.result, scheduleReading: schedule?.reading ?? null, scheduleObservations: Object.freeze(scheduleObservations) });
    const result: AutonomyIntakeReading = unsettled.length || schedule === null || schedule.status === 'held'
      ? { status: 'held', reason: unsettled.length ? 'unsettled' : 'schedule-unsettled', unsettled: unsettled.length ? unsettled : ['cadence.parts'], judgment }
      : { status: 'ready', cadence: run.readings.cadence.choice, schedule: schedule.schedule, intents: {
        eventTrigger: run.readings.eventTrigger.verdict === 'yes', reminder: run.readings.reminder.verdict === 'yes', routine: run.readings.routine.verdict === 'yes', research: run.readings.research.verdict === 'yes', autonomousSchedule: run.readings.autonomousSchedule.verdict === 'yes', delegation: run.readings.delegation.verdict === 'yes', approval: run.readings.approval.verdict === 'yes', automationControl: run.readings.automationControl.verdict === 'yes', mailOrCalendar: run.readings.mailOrCalendar.verdict === 'yes',
      }, judgment };
    run.recordAction(result.status === 'ready' ? 'publish read-only autonomy intake classification' : 'hold autonomy intake: unresolved readings');
    const effectRestriction = authority.consumeObservation();
    publicationCurrent = () => { current(); effectRestriction.assertCurrent(); };
    retainCurrent?.(publicationCurrent, autonomyIntake.name);
    publicationCurrent();
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await owner.release(handle);
    publicationCurrent();
  }
}
