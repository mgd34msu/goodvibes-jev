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
 * Default bands per stake level. The numbers come from the Jev documentation's
 * worked examples (a 0.5 to 0.6 floor for anything, 0.85 and above to act on
 * a high-stakes choice, a 0.3 to 0.7 review band on yes/no). Calibration
 * replaces them with measured values battery by battery. Critical decisions
 * never act on a reading alone: they have no act bounds, so the best they can
 * do is confirm.
 */
export const STAKES_BANDS: Readonly<Record<Stakes, { readonly yesNo: YesNoBand; readonly confidence: ConfidenceBand }>> = {
  low: {
    yesNo: { act: { yes: 0.6, no: 0.4 }, confirm: { yes: 0.55, no: 0.45 } },
    confidence: { actAt: 0.6, confirmAt: 0.5 },
  },
  medium: {
    yesNo: { act: { yes: 0.7, no: 0.3 }, confirm: { yes: 0.6, no: 0.4 } },
    confidence: { actAt: 0.75, confirmAt: 0.6 },
  },
  high: {
    yesNo: { act: { yes: 0.85, no: 0.15 }, confirm: { yes: 0.7, no: 0.3 } },
    confidence: { actAt: 0.85, confirmAt: 0.6 },
  },
  critical: {
    yesNo: { act: null, confirm: { yes: 0.9, no: 0.1 } },
    confidence: { actAt: null, confirmAt: 0.9 },
  },
};

const inUnit = (value: number): boolean => value >= 0 && value <= 1;

/** True when every value lies in [0, 1] and each is no greater than the next. */
function ascendingInUnit(values: readonly number[]): boolean {
  return values.every(inUnit) && values.every((value, index) => index === 0 || values[index - 1]! <= value);
}

/** Throws when a yes/no band is not ordered act.no <= confirm.no < confirm.yes <= act.yes within [0, 1]. */
export function assertYesNoBand(band: YesNoBand): void {
  const { act, confirm } = band;
  const bounds = act === null ? [confirm.no, confirm.yes] : [act.no, confirm.no, confirm.yes, act.yes];
  const middleIsOpen = confirm.no < confirm.yes;
  if (!ascendingInUnit(bounds) || !middleIsOpen) {
    throw new RangeError(`yes/no band must satisfy act.no <= confirm.no < confirm.yes <= act.yes within [0, 1]: ${JSON.stringify(band)}`);
  }
}

/** Throws when a confidence band is not ordered confirmAt <= actAt within [0, 1]. */
export function assertConfidenceBand(band: ConfidenceBand): void {
  const bounds = band.actAt === null ? [band.confirmAt] : [band.confirmAt, band.actAt];
  if (!ascendingInUnit(bounds)) {
    throw new RangeError(`confidence band must satisfy confirmAt <= actAt within [0, 1]: ${JSON.stringify(band)}`);
  }
}

export function outcomeForConfidence(confidence: number, band: ConfidenceBand): Outcome {
  if (band.actAt !== null && confidence >= band.actAt) return 'act';
  if (confidence >= band.confirmAt) return 'confirm';
  return 'escalate';
}
