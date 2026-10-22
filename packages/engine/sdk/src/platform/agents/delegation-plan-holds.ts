import type { DelegationPlanHeldError } from './brief-fidelity.js';

export interface HeldDelegationPlan {
  readonly sessionId: string;
  readonly request: string;
  readonly assignments: readonly { readonly task: string }[];
  readonly reason: string;
  readonly mode: 'spawn' | 'batch-spawn';
  readonly outsideContract?: boolean;
  readonly fixes?: DelegationPlanHeldError['fixes'];
}

// All tools using the same native contract owner must observe the same hold.
const owners = new WeakMap<object, Map<string, HeldDelegationPlan>>();
export function delegationPlanHolds(owner: object): Map<string, HeldDelegationPlan> {
  let plans = owners.get(owner);
  if (!plans) { plans = new Map(); owners.set(owner, plans); }
  return plans;
}
export function delegationPlanKey(sessionId: string, request: string): string {
  return JSON.stringify([sessionId, request]);
}
