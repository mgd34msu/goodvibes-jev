import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { noul, SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.ts';
import { SecretsManager } from '../sdk/src/platform/config/secrets.ts';
import { captureJudgmentFallbackSettings } from '../sdk/src/platform/config/judgment-fallback-settings.ts';
import { createJudgmentSourceLifetime } from '../sdk/src/platform/runtime/judgment-source-lifetime.ts';
import { createSettingsJudgmentPort, judgmentConfigFromSettings, type JudgmentSettingsSource } from '../sdk/src/platform/runtime/judgment-services.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const fallback = (endpoint = 'https://fallback.example.test') => ({ endpoint, model: 'jev-latest', keySource: 'env' as const, keyName: 'FALLBACK_KEY' });
const request = { state: { fixture: 'owned persisted failover' }, questions: { allowed: noul('Is this allowed?') } };
function source(settings: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}): JudgmentSettingsSource {
  return { config: { get: key => settings[key] }, secrets: { get: async () => null }, env: { TYPESAFE_API_KEY: 'synthetic-primary', FALLBACK_KEY: 'synthetic-fallback', ...env } };
}
function configFixture() {
  const path = mkdtempSync(join(tmpdir(), 'judgment-persisted-failover-')); roots.push(path);
  const project = join(path, 'project'); mkdirSync(project);
  const config = new ConfigManager({ configDir: join(path, 'config'), workingDir: project, surfaceRoot: 'tui',
    sharedTierPath: join(path, 'shared.json'), daemonTierPath: join(path, 'daemon.json') });
  return { config, path, projectPath: config.getProjectConfigPath()! };
}
function endpoint(status: number, verdict = 0.001) {
  const calls: { authorization: string | null; model: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(input) {
    const body: unknown = await input.json();
    if (!body || typeof body !== 'object' || !('model' in body) || typeof body.model !== 'string') throw new Error('Invalid fixture request');
    calls.push({ authorization: input.headers.get('authorization'), model: body.model });
    if (status !== 200) return new Response('', { status });
    return Response.json({ model: body.model, answers: { allowed: { type: 'noul', noul: verdict } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

test('old primary-only settings and explicit empty fallback settings retain their original transport config', async () => {
  const primary = await judgmentConfigFromSettings(source());
  expect(primary.fallbacks).toBeUndefined();
  expect(await judgmentConfigFromSettings(source({ 'judgment.fallbacks': [] }))).toEqual(primary);
});

test('an explicit project empty chain survives bulk save and reload, then removal restores the global chain', () => {
  const f = configFixture();
  f.config.set('judgment.fallbacks', [fallback()]);
  f.config.setProjectValue('judgment.fallbacks', []);
  f.config.saveProject();
  expect(JSON.parse(readFileSync(f.projectPath, 'utf8'))).toMatchObject({ judgment: { fallbacks: [] } });
  f.config.load(); expect(f.config.get('judgment.fallbacks')).toEqual([]);
  writeFileSync(f.projectPath, '{}'); f.config.load();
  expect(f.config.get('judgment.fallbacks')).toEqual([fallback()]);
});

test('default-strip migration preserves an explicit empty project chain in a full configuration dump', () => {
  const f = configFixture(); f.config.set('judgment.fallbacks', [fallback()]);
  mkdirSync(join(f.projectPath, '..'), { recursive: true });
  writeFileSync(f.projectPath, JSON.stringify(DEFAULT_CONFIG)); f.config.load();
  expect(f.config.get('judgment.fallbacks')).toEqual([]);
  expect(JSON.parse(readFileSync(f.projectPath, 'utf8'))).toMatchObject({ judgment: { fallbacks: [] } });
});

test('runtime chain overrides remain detached and survive reload without entering persisted files', () => {
  const f = configFixture(); const targets = [fallback()];
  f.config.setRuntimeOverride('judgment.fallbacks', targets);
  targets[0]!.endpoint = 'https://mutated.example.test';
  f.config.save(); f.config.load();
  expect(f.config.get('judgment.fallbacks')).toEqual([fallback()]);
  expect(readFileSync(f.config.getConfigPath(), 'utf8')).not.toContain('fallback.example.test');
});

test('malformed persisted chains refuse reload and retain the complete last-good snapshot', () => {
  const f = configFixture(); f.config.set('judgment.fallbacks', [fallback()]);
  const before = f.config.getRaw();
  writeFileSync(f.config.getConfigPath(), JSON.stringify({ display: { themeMode: 'light' }, judgment: { fallbacks: [{ ...fallback(), apiKey: 'SYNTHETIC_DO_NOT_LOG' }] } }));
  let failure: unknown;
  try { f.config.load(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Missing original malformed settings refusal');
  expect(failure.message).toContain('judgment.fallbacks');
  expect(failure.message).not.toContain('SYNTHETIC_DO_NOT_LOG');
  expect(f.config.getRaw()).toEqual(before);
});

for (const value of [null, 'SYNTHETIC_DO_NOT_LOG', {}, [null], [{ ...fallback(), model: 'invalid model' }],
  [{ ...fallback(), endpoint: 'https://user:password@example.test' }], [{ ...fallback(), keySource: 'file' }],
  [{ ...fallback(), apiKey: 'SYNTHETIC_DO_NOT_LOG' }]]) {
  test(`strict fallback admission rejects malformed shape ${JSON.stringify(value).length} without credential text`, async () => {
    const rejected = judgmentConfigFromSettings(source({ 'judgment.fallbacks': value })).catch(error => error);
    const error: unknown = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('SYNTHETIC_DO_NOT_LOG');
    expect(String(error)).not.toContain('password');
  });
}

test('configured fallback chains have no implicit length cap', async () => {
  const targets = Array.from({ length: 9 }, () => fallback());
  expect((await judgmentConfigFromSettings(source({ 'judgment.fallbacks': targets }))).fallbacks).toHaveLength(9);
});

test('accessor-shaped entries are refused without invoking borrowed code', () => {
  let invoked = false;
  const target = { ...fallback(), get keyName() { invoked = true; return 'FALLBACK_KEY'; } };
  expect(() => captureJudgmentFallbackSettings([target])).toThrow(); expect(invoked).toBe(false);
});

test('fallback destination, model and environment credential are captured before a primary secret read yields', async () => {
  const targets = [fallback()];
  const settings: Record<string, unknown> = { 'judgment.keySource': 'secret', 'judgment.fallbacks': targets };
  const env = { TYPESAFE_API_KEY: 'unused', FALLBACK_KEY: 'synthetic-old-fallback' };
  const key = Promise.withResolvers<string | null>();
  const pending = judgmentConfigFromSettings({ config: { get: name => settings[name] }, env, secrets: { get: () => key.promise } });
  targets[0]!.endpoint = 'https://new.example.test'; env.FALLBACK_KEY = 'synthetic-new-fallback';
  key.resolve('synthetic-primary-secret');
  expect((await pending).fallbacks).toEqual([{ endpoint: { kind: 'hosted', baseURL: 'https://fallback.example.test', apiKey: 'synthetic-old-fallback' }, model: 'jev-latest' }]);
});

test('missing and rejected named credentials fail without silently substituting the primary key', async () => {
  await expect(judgmentConfigFromSettings(source({ 'judgment.fallbacks': [fallback()] }, { FALLBACK_KEY: undefined }))).rejects.toThrow('no resolved credential');
  const configured = source({ 'judgment.fallbacks': [{ ...fallback(), keySource: 'secret' }] });
  await expect(judgmentConfigFromSettings({ ...configured, secrets: { get: async () => { throw new Error('SYNTHETIC_DO_NOT_LOG'); } } }))
    .rejects.toThrow('credential resolution failed');
});

test('cancellation while acquiring a fallback secret prevents every transmission even after the secret arrives', async () => {
  const primary = endpoint(200), next = endpoint(200); const controller = new AbortController();
  const entered = Promise.withResolvers<void>(), credential = Promise.withResolvers<string | null>();
  const configured = source({ 'judgment.endpoint': primary.url,
    'judgment.fallbacks': [{ ...fallback(next.url), keySource: 'secret' }] });
  const port = createSettingsJudgmentPort({ ...configured, secrets: { get: () => { entered.resolve(); return credential.promise; } } });
  using log = new SqliteDecisionLog(':memory:');
  try {
    const pending = withDecisionLog(port, log).ask({ ...request, signal: controller.signal });
    await entered.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    credential.resolve('synthetic-late-secret'); await Bun.sleep(5);
    expect(primary.calls).toHaveLength(0); expect(next.calls).toHaveLength(0);
    expect(log.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
    expect(log.query()).toHaveLength(1);
    expect(JSON.stringify(log.query())).not.toContain('synthetic-late-secret');
  } finally { credential.resolve(null); controller.abort(); primary.stop(); next.stop(); }
});

test('the configured port visits ordered compatible fallbacks and records their actual lineage', async () => {
  const primary = endpoint(503), first = endpoint(503), second = endpoint(200);
  const controller = new AbortController();
  try {
    const settings = { 'judgment.endpoint': primary.url, 'judgment.fallbacks': [fallback(first.url), fallback(second.url)] };
    const result = await createSettingsJudgmentPort(source(settings)).ask({ ...request, signal: controller.signal });
    expect(result.lineage?.attempts.map(attempt => [attempt.endpointIndex, attempt.outcome])).toEqual([[0, 'unavailable'], [1, 'unavailable'], [2, 'answered']]);
    expect(primary.calls).toEqual([{ authorization: 'Bearer synthetic-primary', model: 'jev-latest' }]);
    expect(first.calls).toEqual([{ authorization: 'Bearer synthetic-fallback', model: 'jev-latest' }]);
    expect(second.calls).toEqual(first.calls);
    expect(JSON.stringify(result)).not.toContain('synthetic-');
  } finally { controller.abort(); primary.stop(); first.stop(); second.stop(); }
});

test('a primary semantic refusal is returned without asking a fallback for a different answer', async () => {
  const primary = endpoint(200, 0.999), next = endpoint(200);
  try {
    const result = await createSettingsJudgmentPort(source({ 'judgment.endpoint': primary.url, 'judgment.fallbacks': [fallback(next.url)] })).ask(request);
    expect(result.answers.allowed).toEqual({ type: 'noul', noul: 0.999 }); expect(next.calls).toHaveLength(0);
  } finally { primary.stop(); next.stop(); }
});

test('an all-target outage exhausts once without advertising a retry after the final fallback', async () => {
  const primary = endpoint(503), next = endpoint(503); const controller = new AbortController();
  using log = new SqliteDecisionLog(':memory:');
  try {
    let settled = false;
    const retries: number[] = [];
    const attempts = [
      { attempt: 1, endpointIndex: 0, outcome: 'unavailable', status: 503 },
      { attempt: 2, endpointIndex: 1, outcome: 'unavailable', status: 503 },
    ];
    const port = withDecisionLog(createSettingsJudgmentPort(source({ 'judgment.endpoint': primary.url,
      'judgment.fallbacks': [fallback(next.url)] })), log);
    const pending = port.ask({ ...request, signal: controller.signal, onRetry: event => {
      expect(settled).toBe(false); expect(log.query()).toHaveLength(0);
      retries.push(event.attempt.endpointIndex);
      if (event.attempt.endpointIndex === 1) controller.abort();
    } });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable', status: 503, lineage: { attempts } });
    expect(retries).toEqual([0]);
    expect(controller.signal.aborted).toBe(false);
    expect(primary.calls).toHaveLength(1); expect(next.calls).toHaveLength(1);
    expect(primary.calls).toEqual([{ authorization: 'Bearer synthetic-primary', model: 'jev-latest' }]);
    expect(next.calls).toEqual([{ authorization: 'Bearer synthetic-fallback', model: 'jev-latest' }]);
    expect(log.query()).toHaveLength(1);
    expect(log.query()).toMatchObject([{ status: 'failed', error: { kind: 'unavailable' }, lineage: { attempts } }]);
    expect(log.query()[0]?.lineage?.attempts).toHaveLength(2);
    expect(JSON.stringify(log.query())).not.toContain('synthetic-');
  } finally { controller.abort(); primary.stop(); next.stop(); }
});

test('fallback environment changes and config ABA revoke a captured composed source before another dispatch', () => {
  const f = configFixture(); f.config.set('judgment.fallbacks', [fallback()]);
  const env = { TYPESAFE_API_KEY: 'synthetic-primary', FALLBACK_KEY: 'synthetic-fallback' };
  const lifetime = createJudgmentSourceLifetime({ config: f.config, env, secrets: {} });
  try {
    const first = lifetime.capture(); env.FALLBACK_KEY = 'synthetic-new';
    expect(() => first.assertCurrent()).toThrow(); expect(first.signal?.aborted).toBe(true);
    const second = lifetime.capture();
    f.config.set('judgment.fallbacks', []); f.config.set('judgment.fallbacks', [fallback()]);
    expect(() => second.assertCurrent()).toThrow(); expect(second.signal?.aborted).toBe(true);
    expect(() => lifetime.capture().assertCurrent()).not.toThrow();
  } finally { lifetime.dispose(); }
});

test('named local secret references resolve privately and alias ABA or external store changes revoke authority', async () => {
  const f = configFixture(); f.config.set('storage.secretPolicy', 'plaintext_allowed');
  const alias = 'JEV_FIXTURE_FALLBACK_ALIAS', leaf = 'JEV_FIXTURE_FALLBACK_LEAF';
  f.config.set('judgment.fallbacks', [{ ...fallback(), keySource: 'secret', keyName: alias }]);
  const secrets = new SecretsManager({ projectRoot: join(f.path, 'project'), globalHome: join(f.path, 'home'),
    surfaceRoot: 'tui', configManager: f.config });
  await secrets.set(alias, `goodvibes://secrets/goodvibes/${leaf}`, { scope: 'user', medium: 'plaintext' });
  await secrets.set(leaf, 'synthetic-reference-key', { scope: 'project', medium: 'plaintext' });
  const configured = { config: f.config, secrets, env: { TYPESAFE_API_KEY: 'synthetic-primary' } };
  const lifetime = createJudgmentSourceLifetime(configured);
  try {
    expect((await judgmentConfigFromSettings(configured)).fallbacks?.[0]?.endpoint.apiKey).toBe('synthetic-reference-key');
    const first = lifetime.capture();
    await secrets.set(leaf, 'synthetic-other-key', { scope: 'project', medium: 'plaintext' });
    await secrets.set(leaf, 'synthetic-reference-key', { scope: 'project', medium: 'plaintext' });
    expect(first.signal?.aborted).toBe(true); expect(() => first.assertCurrent()).toThrow();
    const second = lifetime.capture();
    const path = (await secrets.listDetailed()).find(row => row.key === leaf)?.path;
    if (!path) throw new Error('Missing fixture secret file');
    writeFileSync(path, JSON.stringify({ version: 1, secrets: { [leaf]: 'synthetic-external-key' } }));
    expect(() => second.assertCurrent()).toThrow(); expect(second.signal?.aborted).toBe(true);
    expect(Object.keys(lifetime.capture().identity)).toEqual([]);
  } finally { lifetime.dispose(); }
});
