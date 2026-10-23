export class ContractPublicationConflictError extends Error {
  constructor(readonly paths: readonly string[], options?: ErrorOptions) {
    super('captured result patch does not fit the current owner; preserve both versions for focused integration', options);
  }
}
