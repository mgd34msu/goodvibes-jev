/** A real daemon + paired authority; only external Jev/model replies are synthetic. */
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import type { E2EHome } from './harness.ts';

export async function startE2ENativeHost(home: E2EHome) {
  // These fixtures prove local permit delivery. Remote-owner coverage uses a
  // hosted-enabled daemon and must never rely on a failed route falling back.
  home.setAgentSetting('hostedSessions.routeConversationTurns', false);
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'local-e2e-judgment-fixture-not-a-secret';
  const restore = () => {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  };
  try {
    // The host has a separate owned home/project: pre-provisioning its workspace
    // authority must not answer the Agent's first-start checkpoint question.
    const daemon = await startDaemonFixture({ root: join(home.root, 'native-host'), hostSessions: false,
      configure(configManager) {
        configManager.set('judgment.endpoint', home.judgments.baseURL);
        seedProviderMetadataCacheFixture({ configManager, homeDirectory: join(home.root, 'native-host/home'),
          workingDirectory: join(home.root, 'native-host/workspace'), surfaceRoot: 'goodvibes' });
        seedProviderModelListCacheFixture(configManager, 'openai');
        const cache = new BenchmarkStore({ dir: join(home.root, 'native-host/home/.goodvibes/tui') }).getCachePath();
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
      },
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    try {
      const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(daemon.services.shellPaths),
        homeDir: daemon.homeDirectory, daemonStateDir: daemon.services.shellPaths.resolveUserPath() });
      await scopes.add(daemon.workingDirectory);
      // This is explicit fixture setup, never product startup or an implicit
      // grant. Exercise the existing authenticated migration route itself.
      const migration = await daemon.fetch('/api/control-plane/methods/pairing.tokens.migrate/invoke', {
        method: 'POST', body: JSON.stringify({ body: { name: 'Owned startup E2E principal' } }),
      });
      if (!migration.ok) throw new Error(`E2E native pairing setup failed: ${migration.status}`);
      const paired = (await migration.json() as { token: { token: string } }).token;
      return { daemon, env: { GOODVIBES_AGENT_RUNTIME_URL: daemon.baseUrl, GOODVIBES_CONNECTED_HOST_TOKEN: paired.token },
        async stop() { try { await daemon.stop(); } finally { restore(); } },
      };
    } catch (error) { await daemon.stop(); throw error; }
  } catch (error) { restore(); throw error; }
}
