import type { Reading } from '@goodvibes-jev/judgment/decisions';
import { checkAnswers } from '@goodvibes-jev/judgment';
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
    checkAnswers({ choice: { type: 'choice', instructions: 'Closed result validation',
      criteria: Object.fromEntries(Object.keys(reading.probabilities).map((key) => [key, null])) } },
    { choice: { type: 'choice', choice: reading.choice, confidence: reading.confidence, probabilities: reading.probabilities } });
  } else return invalid(); // First browser readers expose no score rubric.
}

/** Reject malformed values and refuse executable values backed by unsettled readings. */
export function validateBrowserJudgmentProjection(request: BrowserJudgmentRequest, result: BrowserJudgmentProjection<unknown>, state?: unknown): void {
  try {
    const hasBasis = Object.hasOwn(result, 'structuralBasis');
    const hasCompound = Object.hasOwn(result, 'compoundOutcome');
    judgmentRecord(result, [...(result.status === 'settled' ? ['status', 'value', 'readings'] : ['status', 'reason', 'readings']),
      ...(hasBasis ? ['structuralBasis'] : []), ...(hasCompound ? ['compoundOutcome'] : [])]);
    if (hasCompound && (result.status !== 'held' || !['confirm', 'escalate'].includes(result.compoundOutcome!))) return invalid();
    let non404Basis = false;
    if (hasBasis) {
      if (request.battery !== 'webui.errors.daemon-refusal') return invalid();
      const basis = judgmentRecord(result.structuralBasis, ['method_unknown']);
      if (basis.method_unknown !== 'http-status-not-404' || !state || typeof state !== 'object' || Array.isArray(state)) return invalid();
      const prototype: unknown = Object.getPrototypeOf(state);
      const status: unknown = Object.getOwnPropertyDescriptor(state, 'status')?.value;
      if ((prototype !== Object.prototype && prototype !== null) || typeof status !== 'number' || !Number.isInteger(status)
        || status < 100 || status > 599 || status === 404) return invalid();
      non404Basis = true;
    }
    if (!result.readings || typeof result.readings !== 'object' || Array.isArray(result.readings)) return invalid();
    const readings = Object.values(result.readings);
    if (!readings.length || readings.length > 128) return invalid();
    readings.forEach(validateReading);
    const errorNames = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'];
    if (request.battery === 'webui.errors.daemon-refusal') {
      // No invented fifth reading: omission needs this exact server-owned HTTP fact.
      judgmentRecord(result.readings, non404Basis && !Object.hasOwn(result.readings, 'method_unknown') ? errorNames.slice(0, -1) : errorNames);
      if (readings.some((reading) => reading.kind !== 'yes-no')) return invalid();
    } else if (request.battery === 'webui.mail.reply-subject') {
      judgmentRecord(result.readings, ['already_reply']);
      if (readings[0]?.kind !== 'yes-no') return invalid();
    } else if (request.battery === 'webui.status.badge-tone') {
      const name = request.input.vocabulary === 'badge' ? 'badge' : 'library_dot';
      judgmentRecord(result.readings, [name]);
      const reading = result.readings[name];
      const tones = request.input.vocabulary === 'badge' ? ['ok', 'warning', 'bad', 'neutral'] : ['ok', 'warn', 'bad', 'info', 'idle'];
      if (reading?.kind !== 'choice' || !tones.includes(reading.choice)) return invalid();
      judgmentRecord(reading.probabilities, tones);
    } else {
      judgmentRecord(result.readings, request.input.candidates.map((_, index) => `candidate_${index}`));
      if (readings.some((reading) => reading.kind !== 'yes-no')) return invalid();
    }
    if (result.status === 'held') {
      if (result.reason !== 'uncertain' || (!hasCompound && readings.every((reading) => reading.outcome === 'act'))) return invalid();
      return;
    }
    if (result.status !== 'settled' || readings.some((r) => r.outcome !== 'act' || (r.kind === 'yes-no' && r.verdict === 'uncertain'))) return invalid();
    if (request.battery === 'webui.errors.daemon-refusal') {
      const value = judgmentRecord(result.value, errorNames);
      if (errorNames.some((key) => {
        const reading = result.readings[key];
        if (typeof value[key] !== 'boolean') return true;
        if (key === 'method_unknown' && non404Basis) return value[key] !== false;
        return reading?.kind !== 'yes-no' || value[key] !== (reading.verdict === 'yes');
      })) return invalid();
      const method = result.readings.method_unknown;
      // A structural false is explicitly attributed above. A semantic yes still
      // requires both an actual yes reading and the resolved server's HTTP 404.
      if (value.method_unknown && (method?.kind !== 'yes-no' || method.verdict !== 'yes'
        || !state || typeof state !== 'object' || !('status' in state) || state.status !== 404)) return invalid();
    } else if (request.battery === 'webui.mail.reply-subject') {
      const value = judgmentRecord(result.value, ['alreadyReply']);
      if (typeof value.alreadyReply !== 'boolean' || readings[0]?.kind !== 'yes-no'
        || value.alreadyReply !== (readings[0].verdict === 'yes')) return invalid();
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
        const reading = result.readings[`candidate_${index}`];
        if (reading?.kind !== 'yes-no' || reading.verdict !== 'yes' || reading.probability !== p) return invalid();
        previous = p; previousIndex = index;
      }
      for (const item of value.rejected) {
        const index = add(item);
        const reading = result.readings[`candidate_${index}`];
        if (reading?.kind !== 'yes-no' || reading.verdict !== 'no') return invalid();
      }
      if (seen.size !== count) return invalid();
    }
  } catch { return invalid(); }
}
