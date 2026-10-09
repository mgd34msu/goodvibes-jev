import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WEBUI_CODE_LANGUAGES } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { invalidateClientLifetime } from '../lib/client-lifetime';

type Request = BrowserJudgmentRequest<'webui.code.language'>;
let calls: { request: Request; signal: AbortSignal }[] = [];
let transport: (request: Request) => Promise<unknown> = async request => response(request);
mock.module('../lib/goodvibes', () => ({ runBrowserJudgment: (request: Request, signal: AbortSignal) => { calls.push({ request, signal }); return transport(request); } }));
const { MarkdownMessage } = await import('./MarkdownMessage');
const { readCodeLanguageResponse } = await import('../lib/code-language-judgment');
const { highlightCode, normalizeLanguage } = await import('../lib/highlight');
const source = { sessionId: 'synthetic-session', messageId: 'synthetic-message' };
const content = 'Before\n```\nconst count: number = 2;\n```\nAfter';
function response(request: Request, held = false) {
  return { protocolVersion: 1, batteryVersion: 1, requestId: request.requestId, battery: request.battery,
    status: held ? 'held' : 'settled', ...(held ? { reason: 'uncertain' } : { value: { language: 'typescript' } }),
    readings: { language: { kind: 'choice', choice: 'typescript', confidence: held ? 0.5 : 0.99,
      probabilities: Object.fromEntries(WEBUI_CODE_LANGUAGES.map(language => [language, language === 'typescript' ? 1 : 0])), outcome: held ? 'confirm' : 'act' } },
    outcome: held ? 'confirm' : 'act', evidence: [{ decisionId: 'synthetic', model: 'synthetic', requestedModel: 'synthetic', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }] };
}
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
function render(text = content, withSource = true) {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  flushSync(() => root!.render(<MarkdownMessage content={text} source={withSource ? source : undefined} />));
  return container;
}
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); flushSync(() => {}); }
  throw new Error('Fixture did not settle');
}
afterEach(() => {
  if (root) flushSync(() => root!.unmount()); container?.remove(); root = undefined; container = undefined;
  calls = []; transport = async request => response(request);
});
test('actual Markdown caller sends source binding only and adopts typed language without changing code', async () => {
  const el = render(); await wait(() => !!el.querySelector('.hljs-keyword'));
  expect(el.querySelector('.markdown-code-label')?.textContent).toBe('typescript');
  expect(el.querySelector('code')?.textContent).toBe('const count: number = 2;');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.request.input).toMatchObject({ sessionId: source.sessionId, messageId: source.messageId, start: content.indexOf('```'), end: content.lastIndexOf('```') + 3 });
  expect(calls[0]!.request.input.contentDigest).toHaveLength(64);
  expect(JSON.stringify(calls[0]!.request)).not.toContain('const count');
});
test('no source or an unavailable reader stays escaped plaintext with no heuristic language', async () => {
  const el = render('```\n<script>alert(1)</script>\n```', false);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(calls).toHaveLength(0); expect(el.querySelector('script')).toBeNull();
  expect(el.querySelector('.markdown-code-label')?.textContent).toBe('code');
  expect(el.querySelector('code')?.textContent).toBe('<script>alert(1)</script>');
});
test('declared library aliases stay mechanical; invented aliases do not select a grammar', async () => {
  const el = render('```ts\nconst count: number = 2;\n```');
  expect(el.querySelector('.hljs-keyword')).not.toBeNull(); expect(calls).toHaveLength(0);
  expect(normalizeLanguage('ts')).toBe('typescript'); expect(normalizeLanguage('ps1')).toBe('');
  expect(highlightCode('const count = 2;', '').language).toBe('');
});
test.each(['held', 'outage'])('%s preserves plain code', async kind => {
  transport = kind === 'held' ? async request => response(request, true) : async () => { throw new Error('fixture outage'); };
  const el = render(); await wait(() => calls.length === 1); await new Promise(resolve => setTimeout(resolve, 20));
  expect(el.querySelector('.hljs-keyword')).toBeNull(); expect(el.querySelector('code')?.textContent).toBe('const count: number = 2;');
});
test.each(['unmount', 'replace', 'identity'])('%s aborts old reading and prevents late adoption', async kind => {
  const barrier = Promise.withResolvers<unknown>(); transport = () => barrier.promise;
  const el = render(); await wait(() => calls.length === 1); const previous = calls[0]!;
  if (kind === 'unmount') { flushSync(() => root!.unmount()); root = undefined; }
  else if (kind === 'replace') render('```\nDifferent plain text\n```', false);
  else invalidateClientLifetime();
  flushSync(() => {}); await wait(() => previous.signal.aborted);
  barrier.resolve(response(previous.request)); await new Promise(resolve => setTimeout(resolve, 20)); flushSync(() => {});
  expect(el.querySelector('.hljs-keyword')).toBeNull();
});
test('client rejects wrong request, mismatched value and malformed language evidence', async () => {
  render(); await wait(() => calls.length === 1); const request = calls[0]!.request; const wire = response(request);
  expect(readCodeLanguageResponse(request, { ...wire, requestId: crypto.randomUUID() })).toBeUndefined();
  expect(readCodeLanguageResponse(request, { ...wire, value: { language: 'python' } })).toBeUndefined();
  expect(readCodeLanguageResponse(request, { ...wire, evidence: [] })).toBeUndefined();
  expect(readCodeLanguageResponse(request, { ...wire, readings: { language: { ...wire.readings.language, probabilities: { typescript: 1 } } } })).toBeUndefined();
});

test('array-coerced language and outcome cannot select a grammar', () => {
  const request: Request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.code.language', batteryVersion: 1,
    input: { ...source, start: 0, end: 5, contentDigest: 'a'.repeat(64) } };
  for (const property of ['choice', 'outcome'] as const) {
    const raw = response(request);
    Object.assign(raw.readings.language, { [property]: [raw.readings.language[property]] });
    expect(readCodeLanguageResponse(request, raw)).toBeUndefined();
  }
});
