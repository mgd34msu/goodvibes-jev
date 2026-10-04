/** Shared recorded semantic evaluator. It selects host-owned operations; it executes none. */
import { JudgmentError, type EntryType, type JudgmentPort, type JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { captureJevDecisionContext, JEV_DECISION_BINDING_KEYS, validateJevDecision, type JevContinuation, type JevDecision, type JevDecisionBinding, type JevDecisionContext, type JevVersionRef } from '@goodvibes-jev/judgment/decisions';
import { snapshotJudgmentInput } from './judgment-input.js';
import { autonomousDisposition, autonomousRefusal } from './batteries/autonomous.js';

export interface AutonomousContinuation {
  readonly ref: JevContinuation;
  readonly description: string;
  /** Owned data explaining this operation, never executable model text. */
  readonly input: EntryType;
}
export interface AutonomousCondition {
  readonly ref: JevVersionRef;
  readonly description: string;
}
export interface AutonomousDecisionInput {
  readonly port: JudgmentPort;
  readonly site: string;
  readonly instructions: string;
  readonly actionDescription: string;
  readonly binding: JevDecisionBinding;
  readonly state: EntryType;
  readonly evidence: readonly JevVersionRef[];
  readonly supportingDecisionIds?: readonly string[] | undefined;
  readonly continuations: readonly AutonomousContinuation[];
  readonly conditions: readonly AutonomousCondition[];
  readonly allowAct: boolean;
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
  readonly onRetry?: ((progress: JudgmentRetryProgress) => void) | undefined;
}
export interface AutonomousDecision {
  readonly decision: JevDecision;
  readonly context: JevDecisionContext;
  assertCurrent(): void;
  recordClaim(): void;
}

/**
 * Canonical UUID/SHA identity encodings are protocol metadata, not raw PAN
 * candidates. Other reference text still crosses the existing privacy check;
 * naming a field as metadata does not exempt secret-shaped content.
 */
export function inspectDecisionProtocolReferences(context: JevDecisionContext): void {
  const identity = (value: string): string =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      || /^[0-9a-f]{64}$/i.test(value) ? '[host-protocol-identity]' : value;
  const ref = (value: JevVersionRef) => ({ id: identity(value.id), revision: identity(value.revision) });
  snapshotJudgmentInput({
    decisionId: identity(context.decisionId),
    binding: Object.fromEntries(JEV_DECISION_BINDING_KEYS.map(key => [key, identity(context.binding[key])])),
    judgmentDecisionIds: context.judgmentDecisionIds.map(identity), evidence: context.evidence.map(ref),
    continuations: context.continuations.map(value => ({ ...ref(value), kind: value.kind })),
    resumeConditions: context.resumeConditions.map(ref),
  });
}

/** One semantic reading, with at most one non-executing resolution of an uncertain act candidate. */
export async function decideAutonomous(input: AutonomousDecisionInput): Promise<AutonomousDecision> {
  const { port, signal, onRetry, assertCurrent, allowAct } = input;
  if (typeof allowAct !== 'boolean' || !input.site || !input.actionDescription) throw new JudgmentError('invalid-request', 'autonomous action eligibility and attribution must be explicit');
  const metadata = captureJevDecisionContext({
    decisionId: crypto.randomUUID(), binding: input.binding, judgmentDecisionIds: input.supportingDecisionIds ?? [],
    evidence: input.evidence, continuations: input.continuations.map(item => item.ref), resumeConditions: input.conditions.map(item => item.ref),
  });
  inspectDecisionProtocolReferences(metadata);
  const state = snapshotJudgmentInput(input.state) as EntryType;
  const continuations = input.continuations.map((item, index) => Object.freeze({ ref: metadata.continuations[index]!,
    description: snapshotJudgmentInput(item.description) as string, input: snapshotJudgmentInput(item.input) as EntryType }));
  const conditions = input.conditions.map((item, index) => Object.freeze({ ref: metadata.resumeConditions[index]!, description: snapshotJudgmentInput(item.description) as string }));
  if (continuations.length + conditions.length > 253 || new Set(continuations.map(item => item.ref.id)).size !== continuations.length) throw new JudgmentError('invalid-request', 'autonomous host catalog is invalid');
  const options: Record<string, string> = { ...(allowAct ? { act: input.actionDescription } : {}), reject: 'Refuse this action. Do not execute it or ask a human for approval.' };
  continuations.forEach((item, index) => { options[`revise_${index}`] = item.description; });
  conditions.forEach((item, index) => { options[`defer_${index}`] = `Wait for registered condition: ${item.description}. Obtain a fresh decision after it changes.`; });
  const ids: string[] = [...metadata.judgmentDecisionIds];
  const active = () => { signal?.throwIfAborted(); assertCurrent(); };
  if (!port.recorder) throw new JudgmentError('unrecorded', 'autonomous decisions require the recorded judgment port');
  const ask = async (criteria: Record<string, string>, resolving = false) => {
    active();
    if (Object.keys(criteria).length === 1) {
      const result = await autonomousRefusal.ask(port, { state: { input: state, deterministicConstraints: 'No action or continuation is eligible. Refusal is the only executable semantic disposition.' } as unknown as EntryType,
        instructions: input.instructions }, { site: input.site, beforeAttempt: active,
        ...(signal === undefined ? {} : { signal }), ...(onRetry === undefined ? {} : { onRetry }) });
      active();
      if (!result.decisionId) throw new JudgmentError('unrecorded', 'autonomous refusal requires recorded provenance');
      ids.push(result.decisionId);
      const reading = autonomousRefusal.read(result);
      port.recorder!.recordReadings(result.decisionId, { refusal: reading.verdict, probability: reading.probability, bandOutcome: reading.outcome });
      if (reading.verdict !== 'yes' || reading.outcome !== 'act') throw new JudgmentError('invalid-response', 'Jev did not settle refusal and no permissible continuation exists');
      return { choice: 'reject', confidence: reading.probability, outcome: reading.outcome };
    }
    const result = await autonomousDisposition.ask(port, {
      state: Object.freeze({ input: state, binding: metadata.binding, evidence: metadata.evidence,
        offeredChoices: Object.freeze({ continuations, resumeConditions: conditions }),
        ...(resolving ? { uncertainty: 'The prior act candidate did not reach the high-stakes band. Select a legal non-executing outcome.' } : {}) }) as unknown as EntryType,
      instructions: input.instructions, criteria,
    }, { site: input.site, beforeAttempt: active, ...(signal === undefined ? {} : { signal }), ...(onRetry === undefined ? {} : { onRetry }),
    });
    active();
    if (!result.decisionId) throw new JudgmentError('unrecorded', 'autonomous decisions require recorded call provenance');
    ids.push(result.decisionId);
    const reading = autonomousDisposition.read(result, criteria);
    port.recorder!.recordReadings(result.decisionId, { choice: reading.choice, confidence: reading.confidence, bandOutcome: reading.outcome });
    return reading;
  };
  let selected = await ask(options);
  if (selected.choice === 'act' && selected.outcome !== 'act') {
    const { act: _act, ...nonExecuting } = options;
    // When refusal is the only option, ask a recorded yes/no refusal rather than an invalid singleton choice.
    selected = await ask(nonExecuting, true);
  }
  const continuation = selected.choice.startsWith('revise_') ? continuations[Number(selected.choice.slice(7))] : undefined;
  const condition = selected.choice.startsWith('defer_') ? conditions[Number(selected.choice.slice(6))] : undefined;
  const outcome = continuation ? 'revise' : condition ? 'defer' : selected.choice;
  if (outcome !== 'act' && outcome !== 'revise' && outcome !== 'defer' && outcome !== 'reject') throw new JudgmentError('invalid-response', 'invalid autonomous outcome');
  const context = captureJevDecisionContext({ ...metadata, judgmentDecisionIds: ids });
  const decision = validateJevDecision({ schemaVersion: 1, decisionId: context.decisionId, binding: context.binding, judgmentDecisionIds: ids,
    evidence: context.evidence, summary: `Jev selected ${outcome} for the bound action.`, outcome,
    ...(continuation ? { next: continuation.ref } : {}), ...(condition ? { until: condition.ref } : {}) }, context);
  active();
  for (const id of ids) {
    port.recorder.recordReadings(id, { autonomousDecision: decision } as unknown as import('@goodvibes-jev/judgment').JsonValue);
    port.recorder.recordAction(id, `autonomous:${outcome}:${context.decisionId}`);
  }
  return Object.freeze({ decision, context,
    assertCurrent() { active(); validateJevDecision(decision, context); },
    recordClaim() {
      active();
      if (decision.outcome !== 'act') throw new JudgmentError('invalid-request', 'only an act decision records a claim');
      for (const id of ids) port.recorder!.recordAction(id, `autonomous:claim:${context.decisionId}`);
      active();
    },
  });
}
