import { isProxy } from 'node:util/types';
import { assertJudgmentInput, captureOwnedJson, JudgmentInputError } from './judgment-input.js';

/**
 * Capture the complete fields the canonical failure reader consumes, before
 * display projection or any getter can change the admitted wording. This is
 * input admission, not a second failure classifier.
 */
export function captureJudgmentFailure(input: unknown): unknown {
  const ancestors = new Set<object>();
  const unsupported = (): never => { throw new JudgmentInputError('unsupported-input'); };
  const field = (object: object, key: string): unknown => {
    let owner: object | null = object;
    for (let depth = 0; owner && depth < 64; depth++) {
      if (isProxy(owner)) return unsupported();
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : unsupported();
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    if (owner) return unsupported();
    return undefined;
  };
  const plain = (value: unknown): unknown => {
    // These primitive renderings are precisely the canonical fallback's full
    // String result. Functions, exotic objects and accessors fail closed.
    const source = typeof value === 'bigint' || typeof value === 'symbol' ? String(value) : value;
    const snapshot = captureOwnedJson(source, isProxy);
    assertJudgmentInput(snapshot);
    return snapshot;
  };
  const capture = (value: unknown, depth: number): unknown => {
    if (depth > 16 || isProxy(value)) return unsupported();
    if (!(value instanceof Error)) return plain(value);
    if (ancestors.has(value)) return unsupported();
    ancestors.add(value);
    try {
      const message = field(value, 'message') ?? '';
      const name = field(value, 'name') ?? 'Error';
      if (typeof message !== 'string' || typeof name !== 'string') return unsupported();
      const facts = plain({ message, name, code: field(value, 'code'), status: field(value, 'status'),
        statusCode: field(value, 'statusCode'), retryAfterMs: field(value, 'retryAfterMs') }) as Record<string, unknown>;
      const cause = capture(field(value, 'cause'), depth + 1);
      const snapshot = new Error(message, { cause });
      Object.assign(snapshot, facts);
      return Object.freeze(snapshot);
    } finally { ancestors.delete(value); }
  };
  return capture(input, 0);
}
