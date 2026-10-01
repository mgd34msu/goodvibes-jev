import { expect, spyOn, test } from 'bun:test';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test.each(['argv', 'shell'])('awaited runtime close terminates its owned %s job before releasing the graph', async (kind) => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  let fixture: DaemonFixture | undefined;
  let pid: number | undefined;
  let descendantPid: number | undefined;
  const previousPort = installJudgmentPort(undefined);
  try {
    fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-process-drain'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    // Withhold every inherited environment variable; no provider or secret is used.
    installJudgmentPort({ model: 'fixture', async ask(request) {
      return { answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: 0.99 }])) as never,
        requestedModel: 'fixture', model: 'fixture', usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, requestId: undefined };
    } });
    const manager = fixture.services.processManager;
    const options = { timeout_ms: 12_000, sigterm_grace_ms: 50 };
    const child = kind === 'argv'
      ? await manager.spawnArgv('/bin/sleep', ['10'], fixture.workingDirectory, undefined, options)
      : await manager.spawn('/bin/sleep 10 & echo $!; wait', fixture.workingDirectory, undefined, options);
    if (kind === 'shell') {
      for (let i = 0; !manager.getOutput(child.process_id!)?.stdout.trim() && i < 500; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const output = manager.getOutput(child.process_id!)!.stdout.trim();
      expect(output).toMatch(/^\d+$/);
      descendantPid = Number(output);
      expect(alive(descendantPid)).toBe(true);
    }
    pid = child.pid!;
    expect(alive(pid)).toBe(true);
    await fixture.services.close();
    expect(alive(pid)).toBe(false);
    if (descendantPid !== undefined) expect(alive(descendantPid)).toBe(false);
    expect(manager.getStatus(child.process_id!)?.done).toBe(true);
  } finally {
    // Only this test's child is signalled, even when the pre-fix assertion fails.
    if (descendantPid !== undefined && alive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    if (pid !== undefined) {
      for (let i = 0; alive(pid) && i < 500; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(alive(pid)).toBe(false);
    }
    try { await fixture?.stop(); } finally { installJudgmentPort(previousPort); benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);
