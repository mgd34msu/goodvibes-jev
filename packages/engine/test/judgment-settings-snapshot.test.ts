import { describe, expect, test } from 'bun:test';
import { noul } from '@goodvibes-jev/judgment';
import { createSettingsJudgmentPort, judgmentConfigFromSettings, type JudgmentSettingsSource } from '../sdk/src/platform/runtime/judgment-services.ts';

const request = { state: { fixture: 'settings reload' }, questions: { allowed: noul('Is this allowed?') }, context: { site: 'test.settings-reload' } };
function fixture(keySource: 'env' | 'secret' = 'secret') {
  const settings: Record<string, unknown> = {
    'judgment.endpoint': 'https://old.example.test', 'judgment.model': 'jev-1.13.0',
    'judgment.keySource': keySource, 'judgment.timeoutMs': 1000,
  };
  const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: 'synthetic-old-key' };
  const key = Promise.withResolvers<string | null>();
  const source: JudgmentSettingsSource = { config: { get: (name) => settings[name] }, env, secrets: { get: () => key.promise } };
  return { settings, env, key, source };
}
function endpoint(failFirst = false) {
  const calls: { key: string | null; model: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(input) {
    const body = await input.json() as { model: string };
    calls.push({ key: input.headers.get('authorization'), model: body.model });
    if (failFirst && calls.length === 1) return new Response('', { status: 503 });
    return Response.json({ model: body.model, answers: { allowed: { type: 'noul', noul: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

describe('judgment settings reload captures one configuration per call', () => {
  test('a pending secret read cannot pair its old key with a new endpoint or model', async () => {
    const { settings, env, key, source } = fixture();
    const pending = judgmentConfigFromSettings(source);
    settings['judgment.endpoint'] = 'https://new.example.test';
    settings['judgment.model'] = 'jev-2.0.0';
    settings['judgment.timeoutMs'] = 2000;
    settings['judgment.keySource'] = 'env';
    env.TYPESAFE_API_KEY = 'synthetic-new-key';
    key.resolve('synthetic-old-secret');
    expect(await pending).toMatchObject({ endpoint: { baseURL: 'https://old.example.test', apiKey: 'synthetic-old-secret' }, model: 'jev-1.13.0', timeoutMs: 1000 });
    expect(await judgmentConfigFromSettings(source)).toMatchObject({ endpoint: { baseURL: 'https://new.example.test', apiKey: 'synthetic-new-key' }, model: 'jev-2.0.0', timeoutMs: 2000 });
  });

  test('environment defaults are captured with the settings before key acquisition yields', async () => {
    const { settings, env, source } = fixture('env');
    settings['judgment.endpoint'] = ''; settings['judgment.model'] = '';
    env.TYPESAFE_BASE_URL = 'https://old.example.test'; env.TYPESAFE_DEFAULT_MODEL = 'jev-1.13.0';
    const pending = judgmentConfigFromSettings(source);
    settings['judgment.endpoint'] = 'https://new.example.test'; settings['judgment.model'] = 'jev-2.0.0';
    settings['judgment.timeoutMs'] = 2000;
    env.TYPESAFE_API_KEY = 'synthetic-new-key'; env.TYPESAFE_BASE_URL = 'https://other.example.test'; env.TYPESAFE_DEFAULT_MODEL = 'jev-3.0.0';
    expect(await pending).toMatchObject({ endpoint: { baseURL: 'https://old.example.test', apiKey: 'synthetic-old-key' }, model: 'jev-1.13.0', timeoutMs: 1000 });
  });

  test('a secret resolver cannot synchronously redirect its acquired credential', async () => {
    const { settings, source } = fixture();
    const config = await judgmentConfigFromSettings({ ...source, secrets: { async get() {
      settings['judgment.endpoint'] = 'https://new.example.test';
      return 'synthetic-old-secret';
    } } });
    expect(config.endpoint).toMatchObject({ baseURL: 'https://old.example.test', apiKey: 'synthetic-old-secret' });
  });

  test('concurrent calls send each captured key only to its own endpoint even when secrets resolve out of order', async () => {
    const old = endpoint(); const next = endpoint();
    const { settings, key, source } = fixture();
    settings['judgment.endpoint'] = old.url;
    const port = createSettingsJudgmentPort(source);
    const abort = new AbortController();
    const first = port.ask({ ...request, signal: abort.signal });
    try {
      settings['judgment.endpoint'] = next.url; settings['judgment.keySource'] = 'env'; settings['judgment.model'] = 'jev-2.0.0';
      const second = await port.ask({ ...request, signal: abort.signal });
      expect(second.requestedModel).toBe('jev-2.0.0');
      key.resolve('synthetic-old-secret');
      expect((await first).requestedModel).toBe('jev-1.13.0');
      await port.ask({ ...request, signal: abort.signal });
      expect(old.calls).toEqual([{ key: 'Bearer synthetic-old-secret', model: 'jev-1.13.0' }]);
      expect(next.calls).toEqual(Array.from({ length: 2 }, () => ({ key: 'Bearer synthetic-old-key', model: 'jev-2.0.0' })));
    } finally { abort.abort(); key.resolve('synthetic-old-secret'); await first.catch(() => {}); old.stop(); next.stop(); }
  });

  test('a hot reload affects new readings while the shared retry owner preserves the pending reading', async () => {
    const old = endpoint(true); const next = endpoint();
    const { settings, env, source } = fixture('env'); settings['judgment.endpoint'] = old.url;
    const port = createSettingsJudgmentPort(source); const waiting = Promise.withResolvers<void>(); const abort = new AbortController();
    const first = port.ask({ ...request, signal: abort.signal, onRetry: () => waiting.resolve() });
    try {
      await waiting.promise;
      settings['judgment.endpoint'] = next.url; settings['judgment.model'] = 'jev-2.0.0'; env.TYPESAFE_API_KEY = 'synthetic-new-key';
      const second = await port.ask({ ...request, signal: abort.signal });
      const initial = await first;
      expect(initial.lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['unavailable', 'answered']);
      expect(second.lineage?.attempts.map((attempt) => attempt.outcome)).toEqual(['answered']);
      expect(old.calls).toEqual(Array.from({ length: 2 }, () => ({ key: 'Bearer synthetic-old-key', model: 'jev-1.13.0' })));
      expect(next.calls).toEqual([{ key: 'Bearer synthetic-new-key', model: 'jev-2.0.0' }]);
      expect(initial.answers.allowed).toEqual({ type: 'noul', noul: 0.01 });
    } finally { abort.abort(); await first.catch(() => {}); old.stop(); next.stop(); }
  });
});
