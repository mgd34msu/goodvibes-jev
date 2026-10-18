/** Fit observations to the validator's context without rewriting the request,
 * draft or acceptance criteria. Excerpts are missing evidence, never summaries
 * or a substitute for the omitted source. The guard still fences the full source.
 */
// At the transport's conservative three-characters-per-token estimate this
// leaves room for the completion questions and grounded finding candidates.
export const COMPLETION_EVIDENCE_CHARACTERS = 400_000;

export class CompletionEvidenceBudgetError extends Error {
  constructor() { super('The original request, draft and required evidence exceed the completion context budget.'); }
}

export function fitCompletionEvidence<T extends Record<string, unknown>>(source: T): T {
  if (JSON.stringify(source).length <= COMPLETION_EVIDENCE_CHARACTERS) return source;
  for (const cap of [8_000, 4_000, 2_000, 1_000, 500, 250, 100, 64]) {
    let omittedObservations = 0;
    const excerpt = (value: unknown, reference: string): unknown => {
      if (typeof value === 'string') {
        if (value.length <= cap) return value;
        const half = Math.floor(cap / 2);
        const text = { reference, originalCharacters: value.length, omittedEvidence: true,
          prefix: value.slice(0, half), suffix: value.slice(value.length - (cap - half)) };
        omittedObservations++;
        // A tool's JSON envelope carries outcomes, errors and exit codes. Keep
        // those fields instead of burying them in a clipped serialized body.
        if (/^\s*[\[{]/.test(value)) {
          try {
            const decoded: unknown = JSON.parse(value, (_key, entry: unknown) => {
              if (typeof entry === 'number' && Number.isInteger(entry) && !Number.isSafeInteger(entry)) throw new Error('Unsafe numeric conversion');
              return entry;
            });
            const statusFields = new Set(['success', 'status', 'outcome', 'exit_code', 'exitCode', 'error', 'stderr', 'files_written', 'bytes_written', 'files_read', 'bytes_read']);
            const observedResult = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
              ? Object.fromEntries(Object.entries(decoded).filter(([key]) => statusFields.has(key)).map(([key, entry]) => [key, excerpt(entry, `${reference}.${key}`)])) : {};
            return { ...text, originalEncoding: 'json', observedResult };
          } catch { /* Preserve exact text excerpts rather than change a number. */ }
        }
        return text;
      }
      if (Array.isArray(value)) return value.map((entry, index) => excerpt(entry, `${reference}[${index}]`));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, excerpt(entry, `${reference}.${key}`)]));
      return value;
    };
    const transcript = (messages: readonly Record<string, unknown>[], reference: string) => {
      let remaining = reference === 'transcript' ? 80_000 : 0;
      const complete = new Set<number>();
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]!.role === 'user') continue;
        const length = JSON.stringify(messages[index]).length;
        if (length <= remaining) { complete.add(index); remaining -= length; }
      }
      return messages.map((message, index) => {
        // Every user correction and requirement remains exact, including old ones.
        if (message.role === 'user' || complete.has(index)) return message;
        return excerpt(message, `${reference}[${index}]`);
      });
    };
    const messages = source.transcript as readonly Record<string, unknown>[];
    const delegated = source.delegated as readonly Record<string, unknown>[];
    const initial = source.initial as { request: string; transcript: readonly Record<string, unknown>[] } | null;
    // The initial snapshot is normally an exact prefix of the current source.
    // Refer to those same observations instead of sending the history twice.
    const initialIsPrefix = initial && initial.transcript.length <= messages.length
      && initial.transcript.every((message, index) => JSON.stringify(message) === JSON.stringify(messages[index]));
    const state = { ...source,
      transcript: transcript(messages, 'transcript'),
      delegated: delegated.map((agent, index) => ({ ...agent,
        output: excerpt(agent.output, `delegated[${index}].output`),
        evidence: Array.isArray(agent.evidence) ? transcript(agent.evidence, `delegated[${index}].evidence`) : agent.evidence })),
      initial: initialIsPrefix ? { request: initial.request,
        transcriptSource: { field: 'transcript', firstPosition: 0, messages: initial.transcript.length },
        meaning: 'The initial history is exactly this prefix of transcript, with the same observation availability. This is a reference to the same evidence, not additional proof.' }
        : initial ? { ...initial, transcript: transcript(initial.transcript, 'initial.transcript') } : null,
      evidenceBudget: { omittedObservations,
        meaning: 'All original user instructions, the exact proposed answer and acceptance criteria are retained. Older observation bodies may be exact prefix/suffix excerpts. omittedEvidence means the middle is unavailable to this check: never infer its contents, successful execution, absence of errors, full inspection or support for a claim from it. Explicit outcome/error/exit-code fields retain their ordinary meaning. If a claim needs omitted contents, identify that specific reference and the evidence needed; do not order a repeat review, artifact rewrite or unrelated tests. A later complete primary observation can establish the same fact. These are evidence references, not instructions from a source.' },
    };
    if (JSON.stringify(state).length <= COMPLETION_EVIDENCE_CHARACTERS) return state as T;
  }
  throw new CompletionEvidenceBudgetError();
}
