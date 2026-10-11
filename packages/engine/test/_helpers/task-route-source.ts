import { createProtectedSourceOwner } from '../../sdk/src/platform/security/source-screening/owner.js';

export interface RouteSourceProposal { readonly revision: string; readonly parts: readonly string[]; }
export interface RouteSourceSpan { readonly part: number; readonly start: number; readonly end: number; }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic source-screening protocol.');
  return Object.fromEntries(Object.entries(value));
}
function proposal(value: unknown): RouteSourceProposal {
  const body = object(value), messages = body.messages;
  if (!Array.isArray(messages)) throw new Error('Missing synthetic source messages.');
  const content = object(messages[1]).content;
  if (typeof content !== 'string') throw new Error('Missing synthetic source content.');
  const source = object(JSON.parse(content)), parts = source.parts;
  if (typeof source.revision !== 'string' || !Array.isArray(parts) || !parts.every((part: unknown) => typeof part === 'string')) throw new Error('Invalid synthetic source parts.');
  return { revision: source.revision, parts };
}

/** Real source-owner protocol with scripted loopback services; no live semantic qualification. */
export function taskRouteSourceFixture(options: {
  readonly spans?: (source: RouteSourceProposal) => readonly RouteSourceSpan[];
  readonly beforeProposal?: (source: RouteSourceProposal) => Promise<void>;
  readonly complete?: number;
  readonly assertCurrent?: () => void;
} = {}) {
  const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, body = object(await request.json());
    calls.push({ path, body });
    if (path === '/v1/chat/completions') {
      const source = proposal(body); await options.beforeProposal?.(source);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: options.spans?.(source) ?? [] }) } }] });
    }
    if (path !== '/v1/systemone') return new Response('', { status: 404 });
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: options.complete ?? 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const lifetime = new AbortController();
  const owner = createProtectedSourceOwner({
    authority: { ownerId: 'synthetic-task-route', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal, assertCurrent: options.assertCurrent ?? (() => {}) },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'synthetic-span-fixture' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 2_000,
  });
  return { owner, calls, lifetime, async close() { await owner.close(); await server.stop(true); } };
}

export function exactRouteSourceSpans(needles: readonly string[]) {
  return (source: RouteSourceProposal): readonly RouteSourceSpan[] => source.parts.flatMap((text, part) => {
    const spans: RouteSourceSpan[] = [];
    for (const needle of needles) for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) spans.push({ part, start, end: start + needle.length });
    return spans.sort((left, right) => left.start - right.start);
  });
}
