/**
 * What code does with a reading. Confidence is a second decision axis: the
 * answer says what, the band says whether to act on it (docs.typesafe.ai/confidence).
 *
 * - act: proceed automatically.
 * - confirm: proceed only after the owner or caller confirms.
 * - escalate: do not act; hand the case to a person or a stronger model.
 */
export type Outcome = 'act' | 'confirm' | 'escalate';

/**
 * How costly a wrong action is. Thresholds scale with stakes: a read-only
 * lookup can act on a modest reading, an irreversible outward effect needs
 * a very strong one.
 */
export type Stakes = 'low' | 'medium' | 'high' | 'critical';

/** Confidence band for a choice or score. */
export interface ConfidenceBand {
  /** Threshold for 'act'; `null` for a decision that never acts on a reading alone. */
  readonly actAt: number | null;
  /** Threshold for 'confirm'. */
  readonly confirmAt: number;
}

/** A choice band with optional stricter bands for options with higher stakes. */
export interface ChoiceBand<O extends string = string> extends ConfidenceBand {
  readonly perOption?: Partial<Readonly<Record<O, ConfidenceBand>>>;
}

/**
 * Yes/no band: one confidence band per side, the no side read on one minus
 * the probability. The sides are separate because the cost of a false yes
 * and a false no usually differ.
 */
export interface YesNoBand {
  readonly yes: ConfidenceBand;
  readonly no: ConfidenceBand;
}

/** A stake level's bands: one confidence band, also used on both sides of a yes/no. */
const bandsFrom = (confidence: ConfidenceBand): { readonly yesNo: YesNoBand; readonly confidence: ConfidenceBand } => ({
  yesNo: { yes: confidence, no: confidence },
  confidence,
});

/**
 * Default bands per stake level, from the Jev documentation's worked examples
 * (a 0.5 to 0.6 floor for anything, 0.85 and above to act on a high-stakes
 * choice, a 0.3 to 0.7 review band on yes/no). Calibration replaces them
 * battery by battery.
 */
export const STAKES_BANDS: Readonly<Record<Stakes, ReturnType<typeof bandsFrom>>> = {
  low: bandsFrom({ actAt: 0.6, confirmAt: 0.55 }),
  medium: bandsFrom({ actAt: 0.75, confirmAt: 0.6 }),
  high: bandsFrom({ actAt: 0.85, confirmAt: 0.7 }),
  critical: bandsFrom({ actAt: null, confirmAt: 0.9 }),
};

/** True when the values lie within [0, 1], each no greater than the next. */
export function orderedInUnit(values: readonly number[]): boolean {
  const bounded = [0, ...values, 1];
  return bounded.every((value, index) => index === 0 || bounded[index - 1]! <= value);
}

/** A band's thresholds in rising order: confirm, then act when the band acts at all. */
const thresholdsOf = (band: ConfidenceBand): number[] => (band.actAt === null ? [band.confirmAt] : [band.confirmAt, band.actAt]);

/** Outcomes from the lowest confidence to the highest; a confidence reaching n thresholds has the nth. */
const RISING_OUTCOMES: readonly Outcome[] = ['escalate', 'confirm', 'act'];

/** Throws unless a confidence band's thresholds are orderedInUnit; `whole` is the band the error reports. */
function assertOrdered(band: ConfidenceBand, whole: ConfidenceBand | YesNoBand): void {
  if (!orderedInUnit(thresholdsOf(band))) throw new RangeError(`band thresholds out of order: ${JSON.stringify(whole)}`);
}

/** Throws unless the band can be used; a yes/no band is checked side by side. */
export function assertBand(band: ConfidenceBand | YesNoBand): void {
  if (!('yes' in band)) return assertOrdered(band, band);
  assertOrdered(band.yes, band);
  assertOrdered(band.no, band);
  if (band.yes.confirmAt + band.no.confirmAt <= 1) throw new RangeError(`yes/no band sides overlap, so one probability could confirm both: ${JSON.stringify(band)}`);
}

/** The outcome a confidence reaches in a band. */
export function outcomeForConfidence(confidence: number, band: ConfidenceBand): Outcome {
  return RISING_OUTCOMES[thresholdsOf(band).filter((threshold) => confidence >= threshold).length]!;
}
