import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureStructuredCredentialReferenceConfigValue, ConfigManager, type JudgmentFallbackSettings } from '@goodvibes-jev/engine/sdk/platform/config';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { handleBundleCommand } from '../../cli/bundle-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { startBundleJudgmentFixture, bundleRecord } from '../helpers/bundle-judgment-fixture.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { SecretsManager } from '../../config/secrets.ts';

const privateCard = '4111111111111111';
const privateSigningValue = 'bundle-private-signing-fixture';
let previous: ReturnType<typeof installJudgmentPort>;
let savedKey: string | undefined;
let activeExport: { cancel: AbortController; settled: Promise<unknown> } | undefined;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  savedKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'synthetic-bundle-transport-key';
});
afterEach(async () => {
  activeExport?.cancel.abort();
  await activeExport?.settled;
  activeExport = undefined;
  installJudgmentPort(previous);
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
});

function fixture(url: string) {
  const root = makeProjectTempDir('agent-bundle-redaction');
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root });
  config.setDynamic('judgment.endpoint', url);
  config.setDynamic('judgment.keySource', 'env');
  config.setDynamic('relay.label', `Synthetic checkout card ${privateCard}`);
  config.setDynamic('payments.currency', 'USD');
  config.setDynamic('surfaces.slack.signingSecret', privateSigningValue);
  seedProviderMetadataCacheFixture({ configManager: config, workingDirectory: root, homeDirectory: root });
  const path = join(root, 'export', 'bundle.json');
  return { root, config, path, runtime: { cli: parseGoodVibesCli(['bundle', 'export', path]), configManager: config,
    workingDirectory: root, homeDirectory: root } };
}

describe('Agent support bundle retained canonical redaction', () => {
  test('standalone export owns a real composition through publication without exposing raw values', async () => {
    const backend = startBundleJudgmentFixture(false, true); const f = fixture(backend.url);
    const backupValue = 'synthetic-backup-transport-key';
    const secrets = new SecretsManager({ projectRoot: f.root, globalHome: f.root, configManager: f.config });
    try { await secrets.set('bundle.judgment.backup', backupValue, { scope: 'project' }); }
    catch (error) { backend.close(); throw error; }
    const references = [
      { endpoint: backend.url, model: 'jev-1.13.0', keySource: 'env', keyName: 'TYPESAFE_API_KEY' },
      { endpoint: backend.url, model: 'jev-1.13.0', keySource: 'secret', keyName: 'bundle.judgment.backup' },
    ] satisfies readonly JudgmentFallbackSettings[];
    f.config.setDynamic('judgment.fallbacks', references);
    const original = f.config.getRaw(); const logs: string[] = []; const cancel = new AbortController();
    expect(f.config.get('relay.label')).toContain(privateCard);
    let guards = 0;
    const log = spyOn(console, 'log').mockImplementation((...values) => { logs.push(values.map(String).join(' ')); });
    const warn = spyOn(console, 'warn').mockImplementation((...values) => { logs.push(values.map(String).join(' ')); });
    try {
      const pending = handleBundleCommand(f.runtime, { signal: cancel.signal, assertCurrent: () => { guards++; } });
      const settled = pending.then(result => ({ kind: 'completed', result } as const),
        (error: unknown) => ({ kind: 'failed', error } as const));
      activeExport = { cancel, settled };
      const outcome = await settled;
      if (cancel.signal.aborted) return;
      if (outcome.kind === 'failed') throw outcome.error;
      const result = outcome.result;
      expect(result.exitCode).toBe(0);
      expect(backend.calls.length).toBeGreaterThan(0);
      expect(guards).toBeGreaterThan(0);
      expect(backend.questionCounts().family ?? 0).toBe(0);
      expect(backend.questionCounts().route ?? 0).toBe(0);
      const credentialKeys = backend.calls.filter(call => Object.hasOwn(bundleRecord(call.questions), 'credential'))
        .map(call => bundleRecord(call.state).key);
      expect(credentialKeys.length).toBeGreaterThan(0);
      expect(new Set(credentialKeys).size).toBe(credentialKeys.length);
      const payload = readFileSync(f.path, 'utf-8');
      const parsed = bundleRecord(JSON.parse(payload));
      expect(parsed.version).toBe(2);
      const exportedConfig = bundleRecord(parsed.config);
      expect(bundleRecord(exportedConfig.payments)).toMatchObject({ currency: 'USD' });
      expect(bundleRecord(exportedConfig.relay).label).toBe('[REDACTED]');
      const exportedReferences = captureStructuredCredentialReferenceConfigValue('judgment.fallbacks', bundleRecord(exportedConfig.judgment).fallbacks);
      expect([...exportedReferences]).toEqual(references);
      const importRoot = makeProjectTempDir('agent-bundle-reference-import');
      const importedConfig = new ConfigManager({ surfaceRoot: 'agent', workingDir: importRoot, homeDir: importRoot });
      const imported = await handleBundleCommand({ cli: parseGoodVibesCli(['bundle', 'import', f.path]), configManager: importedConfig,
        workingDirectory: importRoot, homeDirectory: importRoot });
      expect(imported.exitCode).toBe(0);
      expect([...captureStructuredCredentialReferenceConfigValue('judgment.fallbacks', importedConfig.get('judgment.fallbacks'))]).toEqual(references);
      expect(f.config.getRaw()).toEqual(original);
      for (const output of [payload, JSON.stringify(backend.calls), JSON.stringify(logs), result.output]) {
        expect(output).not.toContain(privateCard);
        expect(output).not.toContain(privateSigningValue);
        expect(output).not.toContain(backupValue);
      }
      expect(() => judgmentPort('after-standalone-bundle')).toThrow('No judgment port is installed');
    } finally {
      log.mockRestore(); warn.mockRestore(); backend.close();
    }
  }, 60_000);

  test.each(['cancel', 'config replacement', 'config ABA', 'config no-op'] as const)('%s during a real canonical read prevents the export file', async mode => {
    const backend = startBundleJudgmentFixture(true); const f = fixture(backend.url); const cancel = new AbortController();
    try {
      const pending = handleBundleCommand(f.runtime, { signal: cancel.signal }).then(() => undefined, (error: unknown) => error);
      await backend.entered.promise;
      if (mode === 'cancel') cancel.abort();
      else {
        const original = f.config.get('payments.currency');
        f.config.setDynamic('payments.currency', mode === 'config no-op' ? original : 'EUR');
        if (mode === 'config ABA') f.config.setDynamic('payments.currency', original);
      }
      backend.release.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(existsSync(f.path)).toBe(false);
      expect(JSON.stringify(backend.calls)).not.toContain(privateCard);
      expect(JSON.stringify(backend.calls)).not.toContain(privateSigningValue);
      expect(() => judgmentPort('after-held-bundle')).toThrow('No judgment port is installed');
    } finally { backend.close(); }
  }, 60_000);
});
