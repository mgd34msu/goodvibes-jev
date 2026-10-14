/** A valid reading that has not settled is not a transport failure or a guessed answer. */
export class JudgmentHeldError extends Error {
  override readonly name = 'JudgmentHeldError';
  readonly outcome = 'held';

  constructor() {
    super('Jev has not settled this reading; the operation remains unexecuted.');
  }
}

/** Only acting readings can select behavior or enter a cache of settled answers. */
export function requireActingReading<T extends { readonly outcome: string }>(reading: T): T {
  if (reading.outcome !== 'act') throw new JudgmentHeldError();
  return reading;
}
