import { CALIBRATION_SITE, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import type { DecisionEntry, DecisionLog } from '../log/types.ts';
import type { JudgmentPort } from '../port/types.ts';
import { summarize, type CalibrationReport, type DecisionReport } from './report.ts';

export interface CalibrateOptions {
  readonly endpoint: { readonly kind: string; readonly baseURL: string };
  /** Only these decision names; all when omitted. */
  readonly only?: readonly string[];
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /**
   * The decision log the port records to. When given, each fixture's checks
   * are attached to that fixture's logged call as ground truth, so accuracy
   * against confidence can later be read from the log alone.
   */
  readonly log?: DecisionLog;
}

/** How far back to look for one decision's calibration calls; one decision's fixtures never come near it. */
const RECENT_CALLS = 100_000;

/** The id of the newest entry in the log, or '' when it is empty. Entry ids are UUIDv7, so later entries sort after it. */
const newestId = (log: DecisionLog): string => log.query({ limit: 1 })[0]?.id ?? '';

/**
 * Attaches each fixture's checks to the newest calibration call recorded for
 * it since `after`, preferring the decision's own calls over any it delegated
 * to. Returns how many fixtures had a call to attach to.
 */
function recordFixtureTruth(log: DecisionLog, decision: NamedDecision, checks: readonly FixtureCheck[], after: string): number {
  const calls = log
    .query({ site: CALIBRATION_SITE, status: 'answered', limit: RECENT_CALLS })
    .filter((entry) => entry.id > after && entry.context.fixture !== undefined);
  const fixtures = [...new Set(checks.map((check) => check.fixture))];
  let recorded = 0;
  for (const fixture of fixtures) {
    const forFixture = calls.filter((entry) => entry.context.fixture === fixture);
    const call: DecisionEntry | undefined = forFixture.find((entry) => entry.context.battery === decision.name) ?? forFixture[0];
    if (call === undefined) continue;
    log.attach(call.id, { kind: 'truth', truth: { source: 'fixture', checks: checks.filter((check) => check.fixture === fixture) } });
    recorded++;
  }
  return recorded;
}

/**
 * Runs every decision's fixtures live through the port (which should record
 * to a decision log) and scores each against its accuracy floor. A decision
 * that cannot run at all is reported as failed with its error; the others
 * still run.
 */
export async function calibrate(
  port: JudgmentPort,
  decisions: readonly NamedDecision[],
  options: CalibrateOptions,
): Promise<CalibrationReport> {
  const selected = options.only === undefined ? decisions : decisions.filter((decision) => options.only!.includes(decision.name));
  if (options.only !== undefined) {
    const missing = options.only.filter((name) => !decisions.some((decision) => decision.name === name));
    if (missing.length > 0) throw new RangeError(`no decision named ${missing.join(', ')}`);
  }
  const { log } = options;
  const reports: DecisionReport[] = [];
  for (const decision of selected) {
    const model = decision.model ?? port.model;
    const after = log === undefined ? '' : newestId(log);
    try {
      const checks = await decision.checkFixtures(port, options.signal === undefined ? {} : { signal: options.signal });
      const report = summarize(decision, model, checks);
      reports.push(log === undefined ? report : { ...report, truthRecorded: recordFixtureTruth(log, decision, checks, after) });
    } catch (error) {
      reports.push({
        ...summarize(decision, model, []),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
  return {
    at: (options.now ?? (() => new Date()))().toISOString(),
    endpoint: options.endpoint,
    decisions: reports,
    passed: reports.length > 0 && reports.every((report) => report.passed),
  };
}
