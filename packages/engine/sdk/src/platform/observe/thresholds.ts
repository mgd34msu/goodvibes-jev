import { DEFAULT_SWEEP } from '@goodvibes-jev/judgment';

/**
 * Every constant the observe analyses compare against, in one reviewable
 * place. None of them is a judgment: they are arithmetic cut-offs over
 * readings the decision log already holds.
 */
export const OBSERVE_THRESHOLDS = {
  drift: {
    /** A window with fewer readings than this is shown but never compared. */
    minReadings: 5,
    /** Total variation distance between two windows' act/confirm/escalate mixes that counts as a change. */
    outcomeShift: 0.2,
    /** Difference in mean signal between two windows that counts as a change. */
    signalShift: 0.1,
    /** Window length when none is given: one day. */
    windowMs: 24 * 60 * 60 * 1000,
  },
  discovery: {
    /** Decision ids shown per stuck question, so an operator can open the entries. */
    examples: 3,
    /** Actions shown per stuck question, most frequent first. */
    actions: 3,
  },
  /** Thresholds a sweep re-bands logged readings at when none are given. */
  sweep: DEFAULT_SWEEP,
  /** Entries read from the log per analysis when no limit is given. */
  entryLimit: 100_000,
} as const;
