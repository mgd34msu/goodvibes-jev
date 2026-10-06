/** Installed vendor SDKs must not hide transport retries from native live-source fences. */
import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { OpenAICompatProvider } from '../sdk/src/platform/providers/openai-compat.js';
import { AnthropicSdkProvider } from '../sdk/src/platform/providers/anthropic-sdk-provider.js';
import { ProviderAttemptDeniedError } from '../sdk/src/platform/providers/attempt-guard.js';
import type { ChatRequest, LLMProvider } from '../sdk/src/platform/providers/interface.js';

const requireProvider = createRequire(new URL('../sdk/src/platform/providers/anthropic-sdk-provider.ts', import.meta.url));
const openaiSse = [
  { id: 'guard-test', object: 'chat.completion.chunk', created: 1, model: 'guard-test', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }] },
  { id: 'guard-test', object: 'chat.completion.chunk', created: 1, model: 'guard-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
const anthropicEvents = [
  { type: 'message_start', message: { id: 'msg_guard', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const anthropicSse = anthropicEvents.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');

function fixture(kind: 'openai' | 'anthropic') {
  const sdkRetries: (string | null)[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    sdkRetries.push(request.headers.get('x-stainless-retry-count'));
    if (sdkRetries.length === 1) return Response.json({ type: 'error', error: { type: 'api_error', message: 'Synthetic retryable failure' } }, { status: 503, headers: { 'retry-after-ms': '1' } });
    return new Response(kind === 'openai' ? openaiSse : anthropicSse, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const baseURL = `http://127.0.0.1:${server.port}`;
  let provider: LLMProvider;
  if (kind === 'openai') provider = new OpenAICompatProvider({ name: 'guard-loopback', baseURL: `${baseURL}/v1`, apiKey: 'synthetic-key', defaultModel: 'guard-test', models: ['guard-test'] });
  else {
    // Resolve the installed SDK from its consuming provider workspace, never a fake stream.
    const { default: Anthropic } = requireProvider('@anthropic-ai/sdk') as { default: typeof import('@anthropic-ai/sdk').default };
    const client = new Anthropic({ apiKey: 'synthetic-key', baseURL });
    provider = new AnthropicSdkProvider({ name: 'guard-anthropic', label: 'Guard Anthropic', defaultModel: 'claude-test', models: ['claude-test'],
      createClient: () => client, auth: { mode: 'api-key', configured: true, detail: 'synthetic loopback' }, streamProtocol: 'anthropic-sdk-stream' });
  }
  return { provider, sdkRetries, close: () => server.stop(true), request: { model: kind === 'openai' ? 'guard-test' : 'claude-test', messages: [{ role: 'user', content: 'Synthetic current task.' }] } satisfies ChatRequest };
}

for (const kind of ['openai', 'anthropic'] as const) {
  test(`${kind}: revoked guarded request sends exactly one HTTP attempt with no hidden SDK retry`, async () => {
    const f = fixture(kind); let valid = true; let retries = 0;
    try {
      await expect(f.provider.chat({ ...f.request, beforeAttempt() { if (!valid) throw new Error('Native source revoked'); }, onRetry() { retries++; valid = false; } })).rejects.toThrow('Native source revoked');
      expect(f.sdkRetries).toEqual(['0']); expect(retries).toBe(1);
    } finally { f.close(); }
  }, 10_000);

  test(`${kind}: successful guarded retry is owned by shared retry rather than nested SDK retry`, async () => {
    const f = fixture(kind); let retries = 0; let fences = 0;
    try {
      const result = await f.provider.chat({ ...f.request, beforeAttempt() { fences++; }, onRetry() { retries++; } });
      expect(result.content).toBe('Done.'); expect(f.sdkRetries).toEqual(['0', '0']); expect(retries).toBe(1); expect(fences).toBe(4);
    } finally { f.close(); }
  }, 10_000);

  test(`${kind}: unguarded requests preserve installed SDK retry behavior`, async () => {
    const f = fixture(kind); let retries = 0;
    try {
      const result = await f.provider.chat({ ...f.request, onRetry() { retries++; } });
      expect(result.content).toBe('Done.'); expect(f.sdkRetries).toEqual(['0', '1']); expect(retries).toBe(0);
    } finally { f.close(); }
  }, 10_000);
}

test('asynchronous SDK client setup cannot retain a stale guard or turn final denial into retry', async () => {
  let valid = true; let streams = 0; let retries = 0;
  const provider = new AnthropicSdkProvider({ name: 'async-guard', label: 'Async guard', defaultModel: 'claude-test', models: ['claude-test'],
    async createClient() { await Promise.resolve(); valid = false; return { messages: { stream() { streams++; throw new Error('Unexpected send'); } } }; },
    auth: { mode: 'api-key', configured: true, detail: 'synthetic' }, streamProtocol: 'anthropic-sdk-stream' });
  await expect(provider.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'Current task' }],
    beforeAttempt() { if (!valid) throw Object.assign(new Error('Final native fence denied'), { status: 503 }); }, onRetry() { retries++; },
  })).rejects.toBeInstanceOf(ProviderAttemptDeniedError);
  expect(streams).toBe(0); expect(retries).toBe(0);
});
