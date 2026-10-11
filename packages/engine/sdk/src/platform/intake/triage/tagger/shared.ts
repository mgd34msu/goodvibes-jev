/** Fixed provider meanings. No message-derived heuristics or arbitrary flags. */
export const TAGS = Object.freeze({
  'GoodVibes/Spam': Object.freeze({ imap: 'GoodVibes_Spam', slack: 'no_entry_sign', discord: '🚫' }),
  'GoodVibes/Priority': Object.freeze({ imap: 'GoodVibes_Priority', slack: 'rotating_light', discord: '🚨' }),
  'GoodVibes/Normal': Object.freeze({ imap: 'GoodVibes_Normal', slack: 'inbox_tray', discord: '📥' }),
});
export type TriageProviderTag = keyof typeof TAGS;
export function captureTags(tags: readonly string[]): readonly TriageProviderTag[] {
  if (!Array.isArray(tags) || !tags.length || tags.length > 3 || tags.some(tag => !Object.hasOwn(TAGS, tag))) throw new Error('Unsupported triage tag');
  return Object.freeze([...new Set(tags)] as TriageProviderTag[]);
}
export interface TaggerGuard { readonly signal: AbortSignal; assertCurrent(): void }
export function current(guard: TaggerGuard): void { guard.signal.throwIfAborted(); if (guard.assertCurrent() !== undefined) throw new Error('Invalid triage lifetime proof'); }
export type TaggerHttp = typeof fetch;
/** Redirects cannot move credentials/effects. Guard every actual request and body await. */
export async function request(fetcher: TaggerHttp, url: string, init: RequestInit, guard: TaggerGuard): Promise<Response> {
  current(guard);
  const response = await fetcher(url, { ...init, redirect: 'error', signal: guard.signal });
  current(guard); return response;
}
export async function json(response: Response, guard: TaggerGuard): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error('Triage provider rejected request');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Triage provider response unavailable');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      current(guard); const part = await reader.read(); current(guard);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) { void reader.cancel().catch(() => {}); throw new Error('Triage provider response exceeds bound'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Triage provider response invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Triage provider response invalid');
  return value as Record<string, unknown>;
}
