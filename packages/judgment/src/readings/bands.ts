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

/** Confidence band for a choice or score, read by `outcomeForConfidence`. */
export interface ConfidenceBand {
  /** `null` means this decision never acts on a reading alone. */
  readonly actAt: number | null;
  readonly confirmAt: number;
}

/** A choice band with optional stricter bands for options with higher stakes. */
export interface ChoiceBand<O extends string = string> extends ConfidenceBand {
  readonly perOption?: Partial<Readonly<Record<O, ConfidenceBand>>>;
}

/**
 * Yes/no band: one confidence band per side. The yes side is read on the
 * probability of yes, the no side on the probability of no (one minus it),
 * so each side acts, confirms or escalates the way a choice does. Anything
 * neither side settles is uncertain and escalates. Yes and no carry separate
 * bands because the cost of a false yes and a false no usually differ.
 */
export interface YesNoBand {
  readonly yes: ConfidenceBand;
  readonly no: ConfidenceBand;
}

/** The bands one confidence band gives: itself for choices and scores, and the same band on both sides of a yes/no. */
const bandsFrom = (confidence: ConfidenceBand): { readonly yesNo: YesNoBand; readonly confidence: ConfidenceBand } => ({
  yesNo: { yes: confidence, no: confidence },
  confidence,
});

/**
 * Default bands per stake level. The numbers come from the Jev
 * documentation's worked examples (a 0.5 to 0.6 floor for anything, 0.85 and
 * above to act on a high-stakes choice, a 0.3 to 0.7 review band on yes/no).
 * Calibration replaces them with measured values battery by battery.
 * Critical decisions have no act threshold.
 */
export const STAKES_BANDS: Readonly<Record<Stakes, ReturnType<typeof bandsFrom>>> = {
  low: bandsFrom({ actAt: 0.6, confirmAt: 0.55 }),
  medium: bandsFrom({ actAt: 0.75, confirmAt: 0.6 }),
  high: bandsFrom({ actAt: 0.85, confirmAt: 0.7 }),
  critical: bandsFrom({ actAt: null, confirmAt: 0.9 }),
};

const inUnit = (value: number): boolean => value >= 0 && value <= 1;
/** True when each value is no greater than the next. */
export const isNonDecreasing = (values: readonly number[]): boolean => values.every((value, index) => index === 0 || values[index - 1]! <= value);

const BAND_ORDER = 'confirmAt <= actAt within [0, 1]';

/** Whether a confidence band satisfies BAND_ORDER. */
function isOrderedBand(band: ConfidenceBand): boolean {
  const bounds = band.actAt === null ? [band.confirmAt] : [band.confirmAt, band.actAt];
  return bounds.every(inUnit) && isNonDecreasing(bounds);
}

/**
 * Whether a probability could settle both sides at once: the yes side
 * confirms from `yes.confirmAt` up, the no side from `1 - no.confirmAt` down.
 */
const sidesOverlap = (band: YesNoBand): boolean => band.yes.confirmAt + band.no.confirmAt <= 1;

/** Throws when either side is not a well-formed confidence band, or the two sides could both settle one probability. */
export function assertYesNoBand(band: YesNoBand): void {
  if (!isOrderedBand(band.yes) || !isOrderedBand(band.no)) throw new RangeError(`yes/no band sides must each satisfy ${BAND_ORDER}: ${JSON.stringify(band)}`);
  if (sidesOverlap(band)) throw new RangeError(`yes/no band sides overlap; yes.confirmAt + no.confirmAt must exceed 1: ${JSON.stringify(band)}`);
}

/** Throws when a confidence band does not satisfy BAND_ORDER. */
export function assertConfidenceBand(band: ConfidenceBand): void {
  if (!isOrderedBand(band)) throw new RangeError(`confidence band must satisfy ${BAND_ORDER}: ${JSON.stringify(band)}`);
}

/** Acts at or above `actAt`, confirms at or above `confirmAt`, escalates below; the one rule every band applies. */
export function outcomeForConfidence(confidence: number, band: ConfidenceBand): Outcome {
  if (band.actAt !== null && confidence >= band.actAt) return 'act';
  if (confidence >= band.confirmAt) return 'confirm';
  return 'escalate';
}
