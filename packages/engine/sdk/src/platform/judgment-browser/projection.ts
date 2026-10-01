import type { Reading } from '@goodvibes-jev/judgment/decisions';
import {
  BrowserJudgmentError, judgmentRecord, type BrowserJudgmentRequest,
} from '@goodvibes-jev/engine/daemon-sdk';
import type { BrowserJudgmentProjection } from './types.js';

const invalid = (): never => { throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE'); };
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function validateReading(reading: Reading): void {
  if (!reading || !['act', 'confirm', 'escalate'].includes(reading.outcome)) return invalid();
  if (reading.kind === 'yes-no') {
    judgmentRecord(reading, ['kind', 'probability', 'verdict', 'outcome']);
    if (!probability(reading.probability) || !['yes', 'no', 'uncertain'].includes(reading.verdict)) return invalid();
  } else if (reading.kind === 'choice') {
    judgmentRecord(reading, ['kind', 'choice', 'confidence', 'probabilities', 'outcome']);
    if (!probability(reading.confidence) || !Object.hasOwn(reading.probabilities, reading.choice)
      || !Object.values(reading.probabilities).every(probability)) return invalid();
  } else return invalid(); // First browser readers expose no score rubric.
}

/** Reject malformed values and refuse executable values backed by unsettled readings. */
export function validateBrowserJudgmentProjection(request: BrowserJudgmentRequest, result: BrowserJudgmentProjection<unknown>): void {
  try {
    judgmentRecord(result, result.status === 'settled' ? ['status', 'value', 'readings'] : ['status', 'reason', 'readings']);
    if (!result.readings || typeof result.readings !== 'object' || Array.isArray(result.readings)) return invalid();
    const readings = Object.values(result.readings);
    if (!readings.length || readings.length > 128) return invalid();
    readings.forEach(validateReading);
    if (result.status === 'held') { if (result.reason !== 'uncertain') return invalid(); return; }
    if (result.status !== 'settled' || readings.some((r) => r.outcome !== 'act' || (r.kind === 'yes-no' && r.verdict === 'uncertain'))) return invalid();
    if (request.battery === 'webui.errors.daemon-refusal') {
      const names = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'];
      const value = judgmentRecord(result.value, names);
      judgmentRecord(result.readings, names);
      if (names.some((key) => typeof value[key] !== 'boolean' || result.readings[key]?.kind !== 'yes-no'
        || value[key] !== (result.readings[key]?.kind === 'yes-no' && result.readings[key].verdict === 'yes'))) return invalid();
    } else if (request.battery === 'webui.status.badge-tone') {
      const value = judgmentRecord(result.value, ['vocabulary', 'tone']);
      if (value.vocabulary !== request.input.vocabulary) return invalid();
      const tones = value.vocabulary === 'badge' ? ['ok', 'warning', 'bad', 'neutral'] : ['ok', 'warn', 'bad', 'info', 'idle'];
      if (!tones.includes(String(value.tone))) return invalid();
      if (readings.length !== 1 || readings[0]?.kind !== 'choice' || readings[0].choice !== value.tone) return invalid();
      judgmentRecord(readings[0].probabilities, tones);
    } else {
      const value = judgmentRecord(result.value, ['registryVersion', 'accepted', 'rejected']);
      if (value.registryVersion !== request.input.registryVersion || !Array.isArray(value.accepted) || !Array.isArray(value.rejected)) return invalid();
      const seen = new Set<number>(); const count = request.input.candidates.length;
      const add = (index: unknown): number => {
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return invalid();
        seen.add(index); return index;
      };
      let previous = 2; let previousIndex = -1;
      for (const item of value.accepted) {
        const accepted = judgmentRecord(item, ['candidateIndex', 'probability']);
        const index = add(accepted.candidateIndex); const p = accepted.probability;
        if (!probability(p) || p > previous || (p === previous && index < previousIndex)) return invalid();
        previous = p; previousIndex = index;
      }
      value.rejected.forEach(add);
      if (seen.size !== count) return invalid();
    }
  } catch { return invalid(); }
}
