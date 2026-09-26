import type { NamedDecision } from '../batteries/decision.ts';
import type { JudgmentPort } from '../port/types.ts';
import { summarize, type CalibrationReport, type DecisionReport } from './report.ts';

export interface CalibrateOptions {
  readonly endpoint: { readonly kind: string; readonly baseURL: string };
  /** Only these decision names; all when omitted. */
  readonly only?: readonly string[];
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
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
  const reports: DecisionReport[] = [];
  for (const decision of selected) {
    const model = decision.model ?? port.model;
    try {
      const checks = await decision.checkFixtures(port, options.signal === undefined ? {} : { signal: options.signal });
      reports.push(summarize(decision, model, checks));
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
