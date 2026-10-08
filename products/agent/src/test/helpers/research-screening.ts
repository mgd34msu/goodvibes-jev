import { createProtectedSourceOwner } from '@goodvibes-jev/engine/sdk/platform/security';

interface Proposal { readonly revision: string; readonly parts: readonly string[]; }
interface Span { readonly part: number; readonly start: number; readonly end: number; }
const cleanups: Array<() => Promise<void>> = [];
export async function cleanupResearchScreeningFixtures() { for (const close of cleanups.splice(0).reverse()) await close(); ordinary = undefined; }
/** Scripted synthetic local services. This supplies no live semantic/privacy proof. */
export function researchScreeningFixture(options: {
  spans?: (source: Proposal) => readonly Span[];
  beforeProposal?: (source: Proposal) => Promise<void>;
  role?: (name: string) => number;
  complete?: number;
  assertCurrent?: () => void;
} = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, unknown>;
    calls.push({ path, body });
    if (path === '/v1/chat/completions') {
      const messages = body.messages as { content: string }[];
      const source = JSON.parse(messages[1]!.content) as Proposal;
      await options.beforeProposal?.(source);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: options.spans?.(source) ?? [] }) } }] });
    }
    const state = body.state as Record<string, unknown>;
    const answers = typeof state.parameter === 'string'
      ? { credential: { type: 'noul', noul: options.role?.(state.parameter) ?? 0 } }
      : { complete: { type: 'noul', noul: options.complete ?? 1 }, precise: { type: 'noul', noul: 1 } };
    return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const lifetime = new AbortController();
  const owner = createProtectedSourceOwner({
    authority: { ownerId: 'synthetic-agent-research', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal, assertCurrent: options.assertCurrent ?? (() => {}) },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'synthetic-span-fixture' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 2_000,
  });
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  return { owner, calls, lifetime };
}

let ordinary: ReturnType<typeof researchScreeningFixture> | undefined;
export function ordinaryResearchOwner() { return (ordinary ??= researchScreeningFixture()).owner; }
export function exactSensitiveSpans(needles: readonly string[]) {
  return (source: Proposal): readonly Span[] => source.parts.flatMap((text, part) => {
    const spans: Span[] = [];
    for (const needle of needles) for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) spans.push({ part, start, end: start + needle.length });
    return spans.sort((a, b) => a.start - b.start);
  });
}
