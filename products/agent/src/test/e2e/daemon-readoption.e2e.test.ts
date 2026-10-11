import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { seedProviderMetadataCacheFixture, seedProviderModelListCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
/**
 * Daemon drop and re-adoption, on the built binary.
 *
 * A real GoodVibes daemon (the SDK's fully composed `bootDaemon`, on the
 * isolated home, sharing one bearer token with the Agent) answers behind the
 * configured port. The port is held by a recording door (harness
 * createDaemonDoor), so the test sees every call the Agent makes to it.
 *
 *   adopt       the Agent attaches to the running daemon: one consuming
 *               `/status?receipts=consume` read (the attach edge) and the
 *               session-input poll it starts on attach
 *   drop        the daemon stops and the port refuses connections
 *   return      a NEW daemon process comes up behind the same port; the Agent
 *               attaches again on its own: a second consuming status read, its
 *               rewind host registered again, the input poll running again
 *
 * The attach edge fires only on a transition into adoption, so the second
 * consuming read also proves the Agent noticed the loss. The Agent never
 * starts a daemon of its own (it is adopt-only), so nothing answers while the
 * door is closed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '@goodvibes-jev/engine/sdk/daemon';
import {
  createDaemonDoor,
  inputAreaVisible,
  launchAgent,
  makeHome,
  removeHome,
  startStubModel,
  waitFor,
  type AgentSession,
  type DaemonDoor,
  type E2EHome,
} from './harness.ts';

const TOKEN = 'e2e-shared-daemon-token';
const ATTACH = 'GET /status?receipts=consume';
const INPUT_POLL = 'POST /api/control-plane/methods/sessions.inputs.list/invoke';
const REWIND_HOST = 'POST /api/control-plane/methods/rewind.conversation.host.register/invoke';

const model = startStubModel(() => ({ text: 'unused' }));
let agent: AgentSession | null = null;
let daemon: BootedDaemon | null = null;
let door: DaemonDoor | null = null;
let home: E2EHome | null = null;
afterAll(async () => {
  await agent?.stop();
  await door?.stop();
  await daemon?.stop();
  model.stop();
  removeHome(home);
});

function count(calls: readonly string[], call: string): number {
  return calls.filter((seen) => seen === call).length;
}

describe('daemon drop and re-adoption', () => {
  test('the Agent adopts a running daemon, notices it go, and adopts the one that comes back', async () => {
    home = await makeHome(model);
    // The reachability heartbeat (watchers.heartbeatIntervalMs, daemon-owned
    // settings) set to 1 s so a drop and a return are noticed within seconds.
    const daemonSettings = join(home.daemonHome, 'settings.json');
    const settings = JSON.parse(readFileSync(daemonSettings, 'utf8')) as Record<string, unknown>;
    writeFileSync(daemonSettings, JSON.stringify({ ...settings, watchers: { enabled: true, heartbeatIntervalMs: 1000 } }, null, 2));

    const e2eHome = home;
    const boot = () => {
      const configManager = new ConfigManager({
        workingDir: e2eHome.workspace, homeDir: e2eHome.home,
        surfaceRoot: 'goodvibes', ownsDaemonTier: true,
      });
      // Adoption exercises the real daemon, not remote metadata services.
      seedProviderMetadataCacheFixture({ configManager, homeDirectory: e2eHome.home,
        workingDirectory: e2eHome.workspace, surfaceRoot: 'goodvibes' });
      seedProviderModelListCacheFixture(configManager, 'openai');
      return bootDaemon({
        configManager,
        homeDirectory: e2eHome.home,
        workingDir: e2eHome.workspace,
        daemonHomeDir: e2eHome.daemonHome,
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        hasOverriddenHome: true,
      });
    };
    const theDoor = createDaemonDoor(home.daemonPort);
    door = theDoor;
    daemon = await boot();
    await theDoor.open(daemon.port);

    agent = launchAgent(home, { cols: 100, rows: 30, env: { GOODVIBES_CONNECTED_HOST_TOKEN: TOKEN } });
    await agent.waitForScreen('the main screen', inputAreaVisible, 45_000);

    // Adopt.
    await waitFor('the first attach and the input poll', () => (
      count(theDoor.seen, ATTACH) === 1 && count(theDoor.seen, INPUT_POLL) > 0
    ), 30_000);

    // Drop: the daemon stops and nothing listens on the port.
    await theDoor.close();
    await daemon.stop();
    daemon = null;
    const beforeReturn = theDoor.seen.length;
    // Longer than several heartbeats: the Agent must notice the loss by itself.
    await Bun.sleep(4_000);
    expect(theDoor.seen.length).toBe(beforeReturn);
    expect(agent.alive()).toBe(true);

    // Return: a new daemon process behind the same port.
    daemon = await boot();
    await theDoor.open(daemon.port);
    await waitFor('the second attach', () => count(theDoor.seen.slice(beforeReturn), ATTACH) === 1, 30_000);
    await waitFor('the rewind host registered again and the input poll running again', () => {
      const after = theDoor.seen.slice(beforeReturn);
      return count(after, REWIND_HOST) > 0 && count(after, INPUT_POLL) > 0;
    }, 30_000);

    expect(count(theDoor.seen, ATTACH)).toBe(2);
    expect(agent.alive()).toBe(true);
    expect(agent.stderr()).not.toMatch(/Error|panic|Unhandled/);
  }, 150_000);
});
