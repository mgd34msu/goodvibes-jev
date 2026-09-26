import { toJson, type DecisionContext, type EntryType, type JudgmentPort, type JudgmentResult, type Questions } from '../port/types.ts';
import type { PatternHeader } from './decision.ts';

export type { PatternHeader } from './decision.ts';

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

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** The decision site, recorded in the decision log. */
  readonly site?: string;
}


/** A call's decision log entry, when the port keeps a log. */
type DecisionIdOf = JudgmentResult<Questions>['decisionId'];

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
export function recordReadings<C extends object>(port: JudgmentPort, result: { readonly decisionId?: DecisionIdOf }, conclusions: C): void {
  const { decisionId } = result;
  if (decisionId !== undefined) port.recorder?.recordReadings(decisionId, toJson(conclusions));
}

/** Records what code did with a decision; a no-op when the port keeps no log. */
export function recordAction(port: JudgmentPort, decisionId: DecisionIdOf, action: string): void {
  if (decisionId !== undefined) port.recorder?.recordAction(decisionId, action);
}
