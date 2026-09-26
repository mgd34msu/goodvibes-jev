import type { DecisionContext, EntryType, JudgmentPort, JudgmentResult, Questions } from '../port/types.ts';

/** The patterns and compounds that issue calls, as the decision log names them. */
export type PatternName =
  | 'battery'
  | 'dispatch'
  | 'judge'
  | 'rerank'
  | 'existence'
  | 'reply'
  | 'alignment'
  | 'fidelity'
  | 'policy'
  | 'select'
  | 'date-parts'
  | 'count'
  | 'coarsen'
  | 'ladder'
  | 'call'
  | 'extraction'
  | 'structure.stitch'
  | 'structure.classify'
  | 'rank-recheck.wide'
  | 'rank-recheck.recheck'
  | 'hierarchy'
  | 'composite'
  | 'fan-out'
  | 'features'
  | 'compound-split';

/** What every named decision declares about itself. */
export interface PatternHeader {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly accuracyFloor: number;
  readonly model?: string;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** The decision site, recorded in the decision log. */
  readonly site?: string;
}

/** What a decision concluded, as the decision log keeps it. */
export type Conclusions = Readonly<Record<string, unknown>>;

/** The attribution a call carries into the decision log. */
export function contextFor(header: PatternHeader, pattern: PatternName, site: string | undefined): DecisionContext {
  return { battery: header.name, batteryVersion: header.version, pattern, ...(site === undefined ? {} : { site }) };
}

/** Asks on behalf of a named decision, attributing the call in the decision log. */
export function askAs<const Q extends Questions>(
  port: JudgmentPort,
  header: PatternHeader,
  pattern: PatternName,
  state: EntryType,
  questions: Q,
  options: CallOptions = {},
): Promise<JudgmentResult<Q>> {
  return port.ask({
    state,
    questions,
    ...(header.model === undefined ? {} : { model: header.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    context: contextFor(header, pattern, options.site),
  });
}

/** Attaches a decision's conclusions to its call's decision log entry. */
export function recordReadings(port: JudgmentPort, result: { readonly decisionId?: string }, conclusions: object): void {
  if (result.decisionId !== undefined) port.recorder?.recordReadings(result.decisionId, conclusions as Conclusions);
}

/** Records what code did with a decision; a no-op when the port keeps no log. */
export function recordAction(port: JudgmentPort, decisionId: string | undefined, action: string): void {
  if (decisionId !== undefined) port.recorder?.recordAction(decisionId, action);
}
