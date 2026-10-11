import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { CommandContext } from '../../input/command-registry.ts';
import { localModelCookbook, readLocalModelCookbook } from '../../tools/agent-harness-local-model-cookbook.ts';
import { localModelServerEndpoints, localModelServerHealthMap } from '../../tools/agent-harness-local-model-endpoints.ts';
import { cliRedactionReadings } from '../helpers/cli-redaction-readings.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function fixture() {
  let reads = 0;
  const snapshot = { servers: [{ providerId: 'ollama-fixture', baseUrl: 'http://127.0.0.1:11434/v1', status: 'ready',
    summary: 'password=local-diagnostic-private-fixture', resourceSummary: 'password=resource-private-fixture',
    publicationGuarantee: 'password=publication-private-fixture', startRoute: 'password=start-private-fixture',
    provenance: ['password=provenance-private-fixture'] }] };
  const context = {
    provider: { providerRegistry: { listModels: () => [], listProviders: () => [{ id: 'ollama-fixture', baseURL: 'http://127.0.0.1:11434/v1' }] } },
    clients: { providerApi: { listProviderIds: () => ['ollama-fixture'] } },
    platform: { configManager: { get: () => undefined }, artifactStore: { list: () => [] },
      readModels: { models: { servingDiagnostics: { getSnapshot() { reads++; return snapshot; } } } } },
  } as unknown as CommandContext;
  return { context, snapshot, reads: () => reads };
}

describe('local model serving diagnostic shared redaction', () => {
  test('startup cookbook reads mechanical facts without diagnostics or a reading port', () => {
    const f = fixture();
    const result = localModelCookbook(f.context, true);
    expect(f.reads()).toBe(0);
    expect(result.enrichment).toBe('deferred');
    expect(JSON.stringify(result)).toContain('http://127.0.0.1:11434/v1');
    expect(JSON.stringify(result)).not.toContain('local-diagnostic-private-fixture');
    expect(JSON.stringify(result)).not.toContain('servingDiagnostics');
  });

  test('explicit inspection awaits the public redactor for all diagnostic prose before returning', async () => {
    const f = fixture(), readings = cliRedactionReadings(); installJudgmentPort(readings.port);
    const original = JSON.stringify(f.snapshot);
    const assertCurrent = () => { if (JSON.stringify(f.snapshot) !== original) throw new Error('Fixture diagnostic source changed.'); };
    const result = await readLocalModelCookbook(f.context, true, { assertCurrent });
    const serialized = JSON.stringify(result);
    expect(f.reads()).toBeGreaterThan(0);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('published-read-model');
    expect(serialized).not.toContain('private-fixture');
    expect(JSON.stringify(readings.requests)).not.toContain('private-fixture');
    expect(JSON.stringify(f.snapshot)).toBe(original);
  });

  test.each(['cancel', 'source replacement', 'port retirement'] as const)('%s during redaction prevents a diagnostic outcome', async mode => {
    const f = fixture(), readings = cliRedactionReadings();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const ask = readings.port.ask.bind(readings.port);
    readings.port.ask = async request => { entered.resolve(); await release.promise; return ask(request); };
    installJudgmentPort(readings.port);
    const cancel = new AbortController(), original = JSON.stringify(f.snapshot);
    const assertCurrent = () => { if (JSON.stringify(f.snapshot) !== original) throw new Error('Fixture diagnostic source changed.'); };
    const pending = (mode === 'port retirement' ? localModelServerEndpoints(f.context, true, { signal: cancel.signal, assertCurrent })
      : localModelServerHealthMap(f.context, true, { signal: cancel.signal, assertCurrent }))
      .then(() => undefined, (error: unknown) => error);
    await entered.promise;
    if (mode === 'cancel') cancel.abort();
    else if (mode === 'source replacement') f.snapshot.servers[0]!.summary = 'A newer safe observation.';
    else installJudgmentPort(cliRedactionReadings().port);
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(JSON.stringify(readings.requests)).not.toContain('private-fixture');
  });
});
