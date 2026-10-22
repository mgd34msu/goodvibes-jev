import { createHash } from 'node:crypto';
import type { VerificationSource } from './types.js';

export const VERIFICATION_FRAME_CHARACTERS = 28_000;
export const VERIFICATION_OVERVIEW_CHARACTERS = 16_000;
// A letter-only encoding keeps opaque digests from accidentally looking like
// payment-card material to the mandatory privacy screen. All 256 bits remain.
export const verificationHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').replace(/\d/g, digit => 'ghijklmnop'[Number(digit)]!);

/** Every byte belongs to an identified source interval. Boundaries are visible;
 * no middle is dropped and a fragment never claims to be a whole observation. */
export function verificationSources(state: Record<string, unknown>): VerificationSource[] {
  const result: VerificationSource[] = [];
  const add = (kind: VerificationSource['kind'], reference: string, value: unknown, messageRole?: VerificationSource['messageRole'], execution?: VerificationSource['execution']) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return;
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 12_000);
      while (JSON.stringify(text.slice(start, end)).length > VERIFICATION_FRAME_CHARACTERS / 2) end = start + Math.max(1, Math.floor((end - start) / 2));
      // A cut inside a long numeric identity can manufacture a 13–19 digit
      // card shape that did not exist in the admitted original. Keep ordinary
      // runs intact. For a run larger than a frame, keep both resulting groups
      // longer than the card limit. Every resulting source is still screened.
      const digit = (index: number) => index >= 0 && index < text.length && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57;
      if (digit(end - 1) && digit(end)) {
        let beginning = end;
        while (beginning > start && digit(beginning - 1)) beginning--;
        if (beginning > start) end = beginning;
        else {
          let tail = 0;
          while (tail < 20 && digit(end + tail)) tail++;
          if (tail < 20) end -= 20 - tail;
        }
      }
      const label = `${reference}; ${start === 0 && end === text.length ? 'complete observation' : 'partial observation'}; characters ${start}..${end} of ${text.length}`;
      result.push({ id: `s-${verificationHash([kind, label, text.slice(start, end)]).slice(0, 24)}`, kind,
        reference: label, text: text.slice(start, end), ...(messageRole ? { messageRole, completeMessage: start === 0 && end === text.length } : {}), ...(execution ? { execution } : {}) });
      start = end;
    }
  };
  add('instruction', 'current user request', state.request);
  if (state.requirements != null) add('instruction', 'host acceptance criteria, subordinate to original user scope', state.requirements);
  const seenExecutions = new Set<string>();
  const mainCalls = new Map<string, { id: string; name?: string; arguments?: unknown }>();
  const transcript = (messages: unknown, prefix: string, callContext = new Map<string, { id: string; name?: string; arguments?: unknown }>(), lane = 'main', originalInstructions = true) => {
    if (!Array.isArray(messages)) return;
    messages.forEach((message: Record<string, unknown>, index) => {
      const calls = message.toolCalls as { id: string; name?: string; arguments?: unknown }[] | undefined;
      if (message.role === 'assistant') for (const call of calls ?? []) if (typeof call.id === 'string') callContext.set(call.id, call);
      const identity = message.role === 'tool' ? message.callId : calls?.map(call => call.id);
      if (identity) {
        // Only a repeated snapshot of the SAME execution is redundant. Equal
        // queries with different call IDs (including A B A) remain distinct.
        const key = verificationHash([lane, identity, message]);
        if (seenExecutions.has(key)) return;
        seenExecutions.add(key);
      }
      const role = ['user', 'assistant', 'tool', 'system'].includes(String(message.role)) ? message.role as VerificationSource['messageRole'] : undefined;
      const call = message.role === 'tool' && typeof message.callId === 'string' ? callContext.get(message.callId) : undefined;
      const execution = message.role === 'tool' ? { callId: message.callId, outcome: message.outcome ?? 'unknown', ...(call ? { tool: call.name,
        ...(JSON.stringify(call.arguments ?? null).length <= 2_000 ? { exactArguments: call.arguments ?? null } : { argumentsSource: `Original assistant call ${call.id}; arguments are retained separately, not clipped or inferred.` }) } : {}) } : undefined;
      add(originalInstructions && message.role === 'user' ? 'instruction' : 'observation', `${prefix}[${index}]; role ${message.role}`, message, role, execution);
    });
  };
  const archive = state.archive as readonly { messages: unknown }[] | undefined;
  archive?.forEach((entry, index) => transcript(entry.messages, `original history before compaction ${index}`, mainCalls));
  const initial = state.initial as { request?: unknown; transcript?: unknown } | null;
  if (initial) {
    add('instruction', 'original request at turn entry', initial.request);
    const current = state.transcript as readonly unknown[];
    const before = initial.transcript;
    if (!Array.isArray(before) || !before.every((message, index) => JSON.stringify(message) === JSON.stringify(current[index]))) transcript(before, 'initial.transcript', mainCalls);
  }
  transcript(state.transcript, 'transcript', mainCalls);
  for (const agent of (state.delegated ?? []) as Record<string, unknown>[]) {
    add('observation', `delegated assignment/result ${agent.id}`, { ...agent, evidence: undefined });
    transcript(agent.evidence, `delegated ${agent.id}.evidence`, new Map(), `delegated:${agent.id}`, false);
  }
  for (const work of (state.completedWork ?? []) as Record<string, unknown>[]) {
    add('observation', `host completed contract ${work.id ?? 'unavailable'}; scoped checks and publication, not final response approval`, work);
    if (work.kind === 'host-completed-contract') {
      // Keep the full record above. Also expose its exact acceptance fields as
      // an independently retrievable primary, so a long answer/unit history
      // cannot bury the scope, actual final check or publication outcome.
      const { units: _units, answer: _answer, ...acceptance } = work;
      add('observation', `host completed contract ${work.id}; acceptance and publication`, acceptance);
      if (typeof work.answer === 'string') add('observation', `host completed contract ${work.id}; exact saved answer`, {
        kind: 'host-saved-contract-answer', id: work.id, answer: work.answer, savedAnswerDigest: work.savedAnswerDigest,
        contentReview: work.contentReview, goalCoverage: work.goalCoverage,
        meaning: 'Exact saved result whose native review bindings are supplied beside it. This is the prior checked result, not the current proposed answer, user instructions or a new completion permit.',
      });
    }
  }
  if (typeof state.response === 'string' && JSON.stringify(state.response).length > 12_000) add('answer', 'exact proposed answer, not an execution observation', state.response);
  return result;
}

/** Exact run encoding, not a summary: joining every segment count times
 * reconstructs the original code units, including escaped JSON newlines. */
export function verificationWireSource(source: VerificationSource) {
  const { messageRole: _localRole, completeMessage: _localBoundary, ...wire } = source;
  const segments = source.text.split(/(?<=\n)|(?<=\\n)/u);
  const runs: { text: string; count: number }[] = [];
  for (const text of segments) {
    const last = runs.at(-1);
    if (last?.text === text) last.count++; else runs.push({ text, count: 1 });
  }
  const encoded = { encoding: 'lossless consecutive segment runs; concatenate text repeated count times, without separators', codeUnits: source.text.length, runs };
  return JSON.stringify(encoded).length < JSON.stringify(source.text).length * .7 ? { ...wire, text: encoded } : wire;
}

export function verificationFrames<T>(values: readonly T[], limit = VERIFICATION_FRAME_CHARACTERS, sizeOf = (value: T) => JSON.stringify(value).length): T[][] {
  const groups: T[][] = []; let group: T[] = [], length = 0;
  for (const value of values) {
    const size = sizeOf(value);
    if (size > limit) throw new Error('Verification source exceeds its native frame size');
    if (group.length && length + size > limit) { groups.push(group); group = []; length = 0; }
    group.push(value); length += size;
  }
  if (group.length) groups.push(group);
  return groups;
}
