/**
 * Model provenance the contract proof can actually establish today.
 * Configured models and stored routes are requests, not response identities.
 * The contract store does not retain provider-returned serving-model metadata.
 */
export const MODEL_IDENTITY_LIMITATION = 'Effective serving model: UNOBSERVED (provider-returned model identity is not retained in the contract proof evidence).';

export function describeRequestedModel(source: 'session configuration' | 'unit route', model: string | undefined): string {
  return `Requested model (${source}): ${model === undefined ? '(none recorded)' : JSON.stringify(model)}. ${MODEL_IDENTITY_LIMITATION}`;
}

/** A successful behavioral run does not qualify any exact serving model. */
export function describeProofResult(failureCount: number): string {
  const behavior = failureCount === 0
    ? 'Every behavioral assertion held.'
    : `${failureCount} behavioral assertion(s) failed.`;
  return `${behavior} Model-identity qualification: UNOBSERVED; this result does not establish which model served the requests.`;
}
