import { types as nodeTypes } from 'node:util';
import type { ProtectedSourceOwner } from '../security/source-screening/types.js';
import { digestSender, normalizeWhitespace, stripMarkup } from './text-normalization.js';

export interface ProtectedInboxPreviewInput {
  readonly senderId: string;
  readonly channelId: string;
  readonly subject: string;
  readonly text: string;
}
export interface ProtectedInboxPreviewFields {
  readonly fromDigest: string;
  readonly subjectPreview: string;
  readonly bodyPreview: string;
}
/** Display bounds only; never cut half of a Unicode scalar. */
function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}

/**
 * Existing Slack/Discord mapper seam over an explicitly protected local route.
 * Both raw originals and deterministic display candidates are checked before
 * clipping. Null withholds the whole poll, never replacing content with empty
 * or raw text. This supplies no default provider composition.
 */
export function createProtectedInboxMapper(owner: ProtectedSourceOwner): (
  input: ProtectedInboxPreviewInput, signal?: AbortSignal,
) => Promise<ProtectedInboxPreviewFields | null> {
  return async (input, signal) => {
    if (signal?.aborted) return null;
    let source: ReturnType<ProtectedSourceOwner['capture']>;
    let captured: ProtectedInboxPreviewInput;
    try {
      // Provider IDs remain local protocol data, never model input or authority.
      if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = ['senderId', 'channelId', 'subject', 'text'] as const;
      if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]
        || !('value' in descriptors[key]) || typeof descriptors[key].value !== 'string')) return null;
      captured = Object.freeze(Object.fromEntries(keys.map(key => [key, descriptors[key].value]))) as unknown as ProtectedInboxPreviewInput;
      if (!captured.senderId || captured.senderId.length > 200 || !captured.channelId || captured.channelId.length > 200) return null;
      source = owner.capture([captured.subject, captured.text,
        normalizeWhitespace(stripMarkup(captured.subject)), normalizeWhitespace(stripMarkup(captured.text))]);
    } catch { return null; }
    let releasing: Promise<void> | undefined;
    const release = () => releasing ??= owner.release(source);
    const abort = () => { void release().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await owner.screen(source);
      if (signal?.aborted || result.status !== 'settled') return null;
      const parts = owner.project(result.receipt);
      const fields = Object.freeze({ fromDigest: digestSender(captured.senderId),
        subjectPreview: prefix(parts[2]!, 200), bodyPreview: prefix(parts[3]!, 500) });
      if (signal?.aborted) return null;
      return fields;
    } catch { return null; }
    finally { signal?.removeEventListener('abort', abort); await release(); }
  };
}
