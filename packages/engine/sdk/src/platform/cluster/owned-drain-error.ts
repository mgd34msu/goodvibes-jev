/** Internal fail-closed marker; never a wire field or a public gate option. */
export class OwnedClusterDrainError extends Error {
  constructor() { super('An owned cluster consumer did not drain'); this.name = 'OwnedClusterDrainError'; }
}
