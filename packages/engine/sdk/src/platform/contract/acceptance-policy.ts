import { hashState } from '@goodvibes-jev/judgment';
import { DELIVERABLE_JUDGES } from './batteries/deliverable-judge.js';
import { FINAL_ANSWER_REVIEWS } from './batteries/final-answer-review.js';
import type { ContractAcceptanceStakes } from './config.js';
import type { ContractView } from './types.js';

/** A changed policy requests a fresh check; it never changes a saved verdict. */
export function changedFinalAcceptancePolicy(contract: ContractView, stakes: ContractAcceptanceStakes): boolean {
  const review = contract.decisions.findLast(decision => decision.targetId === `${contract.id}.final-answer-review`);
  const check = contract.checks.at(-1);
  if (!review || !check || check.result === 'pass' || !review.decisionIds.every(id => check.decisionIds.includes(id))) return false;
  try {
    const receipt = JSON.parse(review.reason), fulfillment = DELIVERABLE_JUDGES[stakes], content = FINAL_ANSWER_REVIEWS[stakes];
    const policy = { fulfillment: { name: fulfillment.name, version: fulfillment.version }, content: { name: content.name, version: content.version }, stakes };
    return receipt.schemaVersion === 2 && hashState(receipt.policy ?? null) !== hashState(policy);
  } catch { return false; }
}
