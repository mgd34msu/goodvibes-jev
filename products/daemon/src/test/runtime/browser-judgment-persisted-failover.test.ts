import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager, SecretsManager, type JudgmentFallbackSettings } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { composeJudgment } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { WEBUI_COMMAND_CATALOG_VERSION } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { AuthenticatedPrincipal } from '@goodvibes-jev/engine/daemon-sdk';
import { composeBrowserJudgment } from '../../runtime/browser-judgment-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const principal: AuthenticatedPrincipal = { principalId: 'browser-failover-fixture', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const request = () => ({ protocolVersion: 1, batteryVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.palette.command-rank',
  input: { query: { kind: 'inline', text: 'Find the synthetic chat' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
    candidates: [{ kind: 'builtin', commandId: 'nav.chat' }] } });

function endpoint(status: number) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const calls: { authorization: string | null; state: unknown }[] = [];
  let held = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('model' in body) || typeof body.model !== 'string'
      || !('state' in body) || !('questions' in body) || !body.questions || typeof body.questions !== 'object') throw new Error('Invalid fixture request');
    calls.push({ authorization: request.headers.get('authorization'), state: body.state });
    if (status !== 200) return new Response(null, { status });
    if (held) { entered.resolve(); await release.promise; }
    return Response.json({ model: body.model,
      answers: Object.fromEntries(Object.keys(body.questions).map(name => [name, { type: 'noul', noul: 0.99 }])),
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  return { url: `http://127.0.0.1:${server.port}`, calls, entered: entered.promise, release: () => release.resolve(),
    hold() { held = true; }, resume() { held = false; release.resolve(); }, stop() { release.resolve(); server.stop(true); } };
}

async function fixture(kind: 'env' | 'secret' | 'alias' | 'config') {
  const root = makeOwnedTempDir('browser-persisted-failover'), project = join(root, 'project'); mkdirSync(project);
  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: project, surfaceRoot: 'daemon',
    sharedTierPath: join(root, 'shared.json'), daemonTierPath: join(root, 'daemon.json') });
  config.set('storage.secretPolicy', 'plaintext_allowed'); config.set('judgment.keySource', 'env');
  config.set('judgment.model', 'jev-1.13.0');
  const secrets = new SecretsManager({ projectRoot: project, globalHome: join(root, 'home'), surfaceRoot: 'daemon', configManager: config });
  const primary = endpoint(503), fallback = endpoint(200);
  const alias = 'JEV_BROWSER_FIXTURE_ALIAS', leaf = 'JEV_BROWSER_FIXTURE_LEAF', other = 'JEV_BROWSER_FIXTURE_OTHER';
  const env: Record<string, string | undefined> = { TYPESAFE_API_KEY: 'synthetic-primary-key', JEV_BROWSER_FIXTURE_ENV: 'synthetic-fallback-key' };
  const target = { endpoint: fallback.url, model: 'jev-1.13.0', keySource: kind === 'secret' || kind === 'alias' ? 'secret' : 'env',
    keyName: kind === 'secret' || kind === 'alias' ? alias : 'JEV_BROWSER_FIXTURE_ENV' } satisfies JudgmentFallbackSettings;
  await secrets.set(leaf, 'synthetic-fallback-key', { scope: 'user', medium: 'plaintext' });
  await secrets.set(other, 'synthetic-other-key', { scope: 'user', medium: 'plaintext' });
  await secrets.set(alias, `goodvibes://secrets/goodvibes/${leaf}`, { scope: 'user', medium: 'plaintext' });
  config.set('judgment.endpoint', primary.url); config.set('judgment.fallbacks', [target]);
  const cleanup: (() => void | Promise<void>)[] = [];
  const disposal = { add(_label: string, dispose: () => void | Promise<void>) { cleanup.push(dispose); } };
  const previous = installJudgmentPort(undefined);
  const judgment = composeJudgment({ config, secrets, env, stateRoot: join(root, 'state'), disposal });
  const service = composeBrowserJudgment({ judgment, config, secrets, env, methods: new GatewayMethodCatalog(), disposal });
  // Browser ownership is the explicit service passed above. An unrelated global
  // installation must neither admit nor strand these product-owned requests.
  installJudgmentPort(undefined);
  return { config, secrets, env, target, alias, leaf, other, primary, fallback, judgment, service,
    async close() {
      fallback.resume();
      try { for (const dispose of cleanup.reverse()) await dispose(); }
      finally { primary.stop(); fallback.stop(); installJudgmentPort(previous); }
    } };
}

test.each(['env', 'secret', 'alias', 'config'] as const)('browser persisted failover retires %s changes and fresh explicit-port admissions recover', async kind => {
  const f = await fixture(kind); f.fallback.hold();
  const pending = f.service.execute(request(), principal, new AbortController().signal, () => principal);
  void pending.catch(() => {});
  try {
    expect(() => judgmentPort('unrelated global fixture')).toThrow('No judgment port');
    await f.fallback.entered;
    if (kind === 'env') f.env.JEV_BROWSER_FIXTURE_ENV = 'synthetic-new-fallback-key';
    if (kind === 'secret') await f.secrets.set(f.leaf, 'synthetic-new-fallback-key', { scope: 'user', medium: 'plaintext' });
    if (kind === 'alias') {
      await f.secrets.set(f.alias, `goodvibes://secrets/goodvibes/${f.other}`, { scope: 'user', medium: 'plaintext' });
      await f.secrets.set(f.alias, `goodvibes://secrets/goodvibes/${f.leaf}`, { scope: 'user', medium: 'plaintext' });
    }
    if (kind === 'config') { f.config.set('judgment.fallbacks', []); f.config.set('judgment.fallbacks', [f.target]); }
    f.fallback.resume();
    await expect(pending).rejects.toMatchObject({ code: 'JUDGMENT_PERMISSION_HELD' });
    expect(f.judgment.decisionLog.query()).toEqual([]);
    expect(await f.service.execute(request(), principal, new AbortController().signal, () => principal)).toMatchObject({ status: 'settled' });
    expect(f.primary.calls).toHaveLength(2); expect(f.fallback.calls).toHaveLength(2);
    expect(f.fallback.calls[1]?.authorization).toBe(`Bearer ${kind === 'env' || kind === 'secret' ? 'synthetic-new-fallback-key' : 'synthetic-fallback-key'}`);
    const records = f.judgment.decisionLog.query(); expect(records).toHaveLength(1);
    expect(records[0]?.lineage?.attempts.map(attempt => [attempt.endpointIndex, attempt.outcome])).toEqual([[0, 'unavailable'], [1, 'answered']]);
    const recorded = JSON.stringify(records);
    for (const marker of ['synthetic-primary-key', 'synthetic-fallback-key', 'synthetic-new-fallback-key', f.alias, f.leaf, f.primary.url, f.fallback.url]) {
      expect(recorded).not.toContain(marker);
    }
  } finally { f.fallback.resume(); await pending.catch(() => {}); await f.close(); }
});
