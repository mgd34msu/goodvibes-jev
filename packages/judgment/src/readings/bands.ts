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

/**
 * Yes/no band. A probability at or above `act.yes` is a yes to act on; at or
 * above `confirm.yes` a yes to confirm; at or below `act.no` a no to act on;
 * at or below `confirm.no` a no to confirm; anything between is uncertain and
 * escalates. Yes and no carry separate bounds because the cost of a false yes
 * and a false no usually differ.
 */
export interface YesNoBand {
  /** `null` means this decision never acts on a reading alone. */
  readonly act: { readonly yes: number; readonly no: number } | null;
  readonly confirm: { readonly yes: number; readonly no: number };
}

/**
 * Confidence band for a choice or score. Confidence at or above `actAt`
 * acts, at or above `confirmAt` confirms, below escalates.
 */
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
 * A yes/no band symmetric around one half: acting on yes at `act` means
 * acting on no at `1 - act`, and likewise for confirming. `act` null means
 * the decision never acts on a reading alone.
 */
export function symmetricBand(act: number | null, confirm: number): YesNoBand {
  return { act: act === null ? null : { yes: act, no: 1 - act }, confirm: { yes: confirm, no: 1 - confirm } };
}

/**
 * Default thresholds per stake level: the probability or confidence at which
 * code acts, and the one at which it confirms. The numbers come from the Jev documentation's
 * worked examples (a 0.5 to 0.6 floor for anything, 0.85 and above to act on
 * a high-stakes choice, a 0.3 to 0.7 review band on yes/no). Calibration
 * replaces them with measured values battery by battery. Critical decisions
 * never act on a reading alone: they have no act bounds, so the best they can
 * do is confirm.
 */
export const STAKES_THRESHOLDS: Readonly<Record<Stakes, { readonly act: number | null; readonly confirm: number }>> = {
  low: { act: 0.6, confirm: 0.55 },
  medium: { act: 0.75, confirm: 0.6 },
  high: { act: 0.85, confirm: 0.7 },
  critical: { act: null, confirm: 0.9 },
};

/** The yes/no and confidence bands each stake level's thresholds give. */
export const STAKES_BANDS = Object.fromEntries(
  Object.entries(STAKES_THRESHOLDS).map(([stakes, { act, confirm }]) => [
    stakes,
    { yesNo: symmetricBand(act, confirm), confidence: { actAt: act, confirmAt: confirm } },
  ]),
) as Readonly<Record<Stakes, { readonly yesNo: YesNoBand; readonly confidence: ConfidenceBand }>>;

const inUnit = (value: number): boolean => value >= 0 && value <= 1;
/** True when each value is no greater than the next. */
export const isNonDecreasing = (values: readonly number[]): boolean => values.every((value, index) => index === 0 || values[index - 1]! <= value);

/** Throws `message` unless the bounds lie in [0, 1] in non-decreasing order. */
function assertOrderedInUnit(bounds: readonly number[], message: string): void {
  if (!bounds.every(inUnit) || !isNonDecreasing(bounds)) throw new RangeError(message);
}

/** Throws when a yes/no band is not ordered act.no <= confirm.no < confirm.yes <= act.yes within [0, 1]. */
export function assertYesNoBand(band: YesNoBand): void {
  const { act, confirm } = band;
  const message = `yes/no band must satisfy act.no <= confirm.no < confirm.yes <= act.yes within [0, 1]: ${JSON.stringify(band)}`;
  assertOrderedInUnit(act === null ? [confirm.no, confirm.yes] : [act.no, confirm.no, confirm.yes, act.yes], message);
  if (confirm.no === confirm.yes) throw new RangeError(message);
}

/** Throws when a confidence band is not ordered confirmAt <= actAt within [0, 1]. */
export function assertConfidenceBand(band: ConfidenceBand): void {
  const message = `confidence band must satisfy confirmAt <= actAt within [0, 1]: ${JSON.stringify(band)}`;
  assertOrderedInUnit(band.actAt === null ? [band.confirmAt] : [band.confirmAt, band.actAt], message);
}

export function outcomeForConfidence(confidence: number, band: ConfidenceBand): Outcome {
  if (band.actAt !== null && confidence >= band.actAt) return 'act';
  if (confidence >= band.confirmAt) return 'confirm';
  return 'escalate';
}
