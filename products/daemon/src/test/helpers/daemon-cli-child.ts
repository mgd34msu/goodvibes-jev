/** Disposable launcher exercising the emitted dispatcher, not a replacement host. */
import { spyOn } from 'bun:test';
import { join } from 'node:path';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { ProviderRegistry, BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';

if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') throw new Error('Guarded CLI fixture required');
const hosts = await import(new URL('../../../dist/runtime/daemon-host.js', import.meta.url).href) as typeof import('../../runtime/daemon-host.js');
const createHost = hosts.createDaemonHost;
spyOn(hosts, 'createDaemonHost').mockImplementation((options) => createHost(options, {
  providerDiscovery: { scan: async () => ({ servers: [], scannedHosts: 0, scannedPorts: 0, durationMs: 0 }) },
}));
const { runDaemonCli } = await import(new URL('../../../dist/cli/run.js', import.meta.url).href) as typeof import('../../cli/run.js');
const emit = (line: string) => { writeSync(1, `${line}\n`); };
if (process.stdout.isTTY === true) emit('FIXTURE_STDOUT_TTY');
spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
let held = false;
let release!: () => void;
const draining = new Promise<void>((resolve) => { release = resolve; });
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'hold') held = true;
  if (line === 'release') release();
});
const root = process.env.HOME!;
process.exitCode = await runDaemonCli(process.argv.slice(2), {
  pairingOutput: process.env.GOODVIBES_TEST_PAIRING_OUTPUT === '1' ? emit : undefined,
  runtime: {
    localUserAuthManager: new UserAuthManager({
      bootstrapFilePath: join(root, 'fixture-users.json'), bootstrapCredentialPath: join(root, 'fixture-bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }],
    }),
    inboxFactory(context, _routing, options) {
      return registerInboxSurface(context, { ...options, adapters: new Map([['fixture', {
        id: 'fixture', pollIntervalMs: 25,
        async poll() {
          if (held) { emit('POLL_HELD'); await draining; emit('POLL_DRAINED'); }
          return { state: 'ready' as const, configured: true, items: [{
            id: 'fixture:one', provider: 'fixture', kind: 'dm' as const, fromDigest: '0123456789abcdef',
            subjectPreview: 'Synthetic subject', bodyPreview: 'Synthetic body', receivedAt: 1, unread: true,
          }] };
        },
      }]]) });
    },
  },
});
input.close();
