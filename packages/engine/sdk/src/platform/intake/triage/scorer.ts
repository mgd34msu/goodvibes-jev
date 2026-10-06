import { checkAnswers, fanOut, type JudgmentPort } from '@goodvibes-jev/judgment';
import { inboxTriage, TRIAGE_MODEL } from './battery.js';
import { captureTriageData, captureTriageInputs, settleTriage, triageBinding, type CapturedTriageInput } from './evidence.js';
import type { TriageInput, TriageReceipt } from './types.js';

export async function scoreCapturedTriage(items: readonly CapturedTriageInput[], port?: JudgmentPort, signal?: AbortSignal): Promise<readonly TriageReceipt[]> {
  const bindings = items.map(triageBinding);
  const unavailable = () => Object.freeze(bindings.map(binding => Object.freeze({ ...binding, status: 'unavailable' as const })));
  if (!items.length) return Object.freeze([]);
  if (!port || signal?.aborted) return unavailable();
  // Each part is the same registered decision, addressed to one batch item.
  // Only the item address changes; questions, bands, fixtures and model do not.
  const parts: Record<string, typeof inboxTriage> = {};
  for (let i = 0; i < items.length; i++) {
    const addressed = (key: 'spam' | 'urgency') => ({ ...inboxTriage.items[key], question: {
      ...inboxTriage.items[key].question, instructions: `For items[${i}] only: ${String(inboxTriage.items[key].question.instructions)}`,
    } });
    parts[`item${i}`] = { ...inboxTriage, items: { spam: addressed('spam'), urgency: addressed('urgency') } };
  }
  try {
    const state = { items: items.map(item => Object.freeze({...item})) };
    Object.freeze(state.items); Object.freeze(state);
    // The shared fan-out owns request composition. This boundary decorator
    // validates an injected port's raw result before fan-out reads its fields.
    // It deliberately borrows neither the caller's recorder nor default model.
    const checkedPort: JudgmentPort = {
      model: TRIAGE_MODEL,
      async ask(request) {
        const questions = captureTriageData(request.questions) as typeof request.questions;
        const pinned = Object.freeze({ ...request, questions, model: TRIAGE_MODEL,
          context: Object.freeze({ ...request.context, batteryVersion: inboxTriage.version }) });
        const raw = await port.ask(pinned);
        if (signal?.aborted) throw new Error('Triage judgment cancelled.');
        const captured = captureTriageData(raw);
        if (!captured || typeof captured !== 'object' || Array.isArray(captured)) throw new Error('Malformed triage judgment.');
        const result = captured as Record<string, unknown>;
        if (result['model'] !== TRIAGE_MODEL || result['requestedModel'] !== TRIAGE_MODEL) throw new Error('Triage model mismatch.');
        checkAnswers(questions, result['answers'] as Record<string, { type: 'noul'; noul: number }>);
        return captured as typeof raw;
      },
    };
    const run = await fanOut(checkedPort, state, parts, { label: inboxTriage.name, site: 'intake.triage', ...(signal ? { signal } : {}) });
    if (signal?.aborted) return unavailable();
    return Object.freeze(bindings.map((binding, i) => {
      const readings = run.readings[`item${i}`]!;
      return settleTriage(binding, readings.spam, readings.urgency);
    }));
  } catch { return unavailable(); }
}
/** One injected, typed judgment request per nonempty admissible batch; never creates a provider. */
export async function scoreInboxTriage(items: readonly TriageInput[], port?: JudgmentPort, signal?: AbortSignal): Promise<readonly TriageReceipt[]> {
  return scoreCapturedTriage(captureTriageInputs(items), port, signal);
}
