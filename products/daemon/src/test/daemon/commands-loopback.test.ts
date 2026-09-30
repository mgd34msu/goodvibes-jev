import { expect, spyOn, test } from 'bun:test';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { runStatusCommand, runUpdateCommand } from '../../daemon/status-command.js';
import { runSessionsCommand } from '../../daemon/sessions-command.js';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';

test('status, update reporting and session listing use the actual configured daemon transports', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  let fixture: DaemonFixture | undefined;
  try {
    fixture = await startDaemonFixture({
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    const target = new URL(fixture.baseUrl);
    const input = {
      configManager: fixture.services.configManager, daemonHomeDir: fixture.homeDirectory,
      controlPlaneConfigDir: fixture.services.configManager.getControlPlaneConfigDir(),
      flags: { host: target.hostname, port: Number(target.port), token: fixture.token, json: true },
    };
    const status = await runStatusCommand(input);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.lines[0]!)).toMatchObject({ ok: true, data: {
      target: fixture.baseUrl, identity: { status: 'running' }, hostedSessions: { count: 0, sessions: [] },
    } });
    const sessions = await runSessionsCommand({ ...input, args: ['list'], flags: { ...input.flags, all: false } });
    expect(sessions.exitCode).toBe(0);
    expect(JSON.parse(sessions.lines[0]!)).toMatchObject({ ok: true, data: { sessions: [] } });
    const update = await runUpdateCommand({ ...input, flags: { ...input.flags, check: true } });
    expect(update.exitCode).toBe(0);
    expect(JSON.parse(update.lines[0]!)).toMatchObject({ ok: true, data: { checkRequested: true, checkVerbAvailable: false } });
    const refused = await runStatusCommand({ ...input, flags: { ...input.flags, token: 'dummy-invalid-fixture-token' } });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.lines[0]!)).toMatchObject({ ok: false });
    await fixture.stop();
    expect(fixture.daemon.isRunning).toBe(false);
  } finally { try { await fixture?.stop(); } finally { benchmarks.mockRestore(); discovery.mockRestore(); } }
}, 30_000);
