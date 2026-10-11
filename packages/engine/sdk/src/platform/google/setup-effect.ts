/** A consumed observation is not permission: the receiving port owns the exact effect. */
export interface GoogleMutationOwnership {
  readonly assertCurrent: () => void;
  readonly consumeObservation: () => void;
  readonly committed: () => void;
}
export class GoogleSetupWriteCommittedError extends Error {
  constructor() { super('The authorized setup write committed, but setup stopped because its owner changed afterward.'); this.name = 'GoogleSetupWriteCommittedError'; }
}
