/** Owned real daemon, native capture/admission and host-bound paired principal. */
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getProviderModelsCachePath } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { startDaemonFixture } from '@goodvibes-jev/daemon/testing';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { beginTuiHostPairing, completeTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { seedBenchmarkCacheFixture } from '../helpers/benchmark-cache-fixture.ts';
import { startE2EJudgments } from './judgment-fixture.ts';
import type { E2EHome } from './harness.ts';

export async function startE2ENativeHost(home: E2EHome) {
  const judgments = startE2EJudgments();
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'local-e2e-judgment-fixture-not-a-secret';
  const restore = () => {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    judgments.stop();
  };
  try {
    const root = join(home.root, 'native-host');
    const daemon = await startDaemonFixture({ root, hostSessions: false,
      configure(configManager) {
        const homeDirectory = join(root, 'home'), workingDirectory = join(root, 'workspace');
        configManager.set('judgment.endpoint', judgments.baseURL);
        seedProviderMetadataCacheFixture({ configManager, homeDirectory, workingDirectory });
        seedBenchmarkCacheFixture({ homeDirectory, workingDirectory, surfaceRoot: 'goodvibes' });
        const models = getProviderModelsCachePath(configManager.getControlPlaneConfigDir(), 'openai');
        mkdirSync(dirname(models), { recursive: true });
        writeFileSync(models, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: [] }));
      },
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    try {
      const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(daemon.services.shellPaths),
        homeDir: daemon.homeDirectory, daemonStateDir: daemon.services.shellPaths.resolveUserPath() });
      await scopes.add(daemon.workingDirectory);
      // Explicit fixture setup follows the production authenticated migration;
      // product startup never creates authority or falls back to this token.
      const migration = await daemon.fetch('/api/control-plane/methods/pairing.tokens.migrate/invoke', {
        method: 'POST', body: JSON.stringify({ body: { name: 'Owned TUI turn E2E principal' } }),
      });
      if (!migration.ok) throw new Error(`E2E native pairing setup failed: ${migration.status}`);
      const paired = (await migration.json() as { token: { token: string; id: string; name: string; createdAt: number } }).token;
      const attempt = { attemptId: crypto.randomUUID(), name: paired.name, startedAt: Date.now() };
      if ((await beginTuiHostPairing(home.home, daemon.baseUrl, attempt)).status !== 'begun') throw new Error('E2E pairing intent was not stored');
      if ((await completeTuiHostPairing(home.home, daemon.baseUrl, attempt.attemptId, {
        token: paired.token, tokenId: paired.id, name: paired.name, createdAt: paired.createdAt,
      })).status !== 'paired') throw new Error('E2E paired authority was not stored');
      const config = new TuiConfigManager({ configDir: join(home.home, '.goodvibes/tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
      config.set('controlPlane.publicBaseUrl', daemon.baseUrl);
      config.set('daemon.enabled', true);
      config.set('hostedSessions.routeConversationTurns', false);
      config.set('judgment.endpoint', judgments.baseURL);
      return { daemon, judgments, env: { TYPESAFE_API_KEY: 'local-e2e-judgment-fixture-not-a-secret', TYPESAFE_BASE_URL: judgments.baseURL },
        async stop() { try { await daemon.stop(); judgments.assertNoUnexpected(); } finally { restore(); } },
      };
    } catch (error) { await daemon.stop(); throw error; }
  } catch (error) { restore(); throw error; }
}
