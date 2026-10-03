/**
 * settings-read-write-one-resolution.test.ts
 *
 * One process, one daemon, two answers.
 *
 * A whole session was spent on this: every daemon-owned settings READ in the
 * agent came back `unavailable` against `http://127.0.0.1:4444`, while WRITES in
 * the same process, in the same minutes, reached the live daemon on 3421 and
 * applied cleanly. 4444 was not a fiction and not a test fixture, it is the
 * port this machine's daemon really listened on for weeks (daemon 1.27.0 through
 * 1.28.4) before it moved. What was left behind was a stale ADDRESS, in two
 * places at once: the running-daemon record, and the control-plane binding in
 * the daemon's own config.
 *
 * That double staleness is why the existing recovery could not help. Discovery
 * reaps a runtime record that does not answer and falls back to the derived
 * control-plane binding, but here the binding named the same dead port, so both
 * rungs of the ladder were rotten together and the read reported `unavailable`
 * for a daemon that was up the entire time.
 *
 * The fix is not a better guess. It is refusing to guess twice: writes already
 * went through a connection this process HELD, and reads now come back from that
 * same connection. These tests pin that by construction, with a client
 * installed, no settings read may dial a discovered address at all, however
 * stale, however plausible.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import {
  buildAgentConfigRouting,
  installAgentDaemonConfigClient,
  openEffectiveConfigView,
  routeConfigWrite,
} from '../../config/daemon-config-routing.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** The port this machine's daemon really used, and really left. */
const ABANDONED_PORT = 4444;
/** Where the daemon actually is. */
const LIVE_PORT = 3421;

/** A daemon-owned key: reads and writes for it must both leave this process. */
const DAEMON_KEY = 'surfaces.telegram.botUsername';

const roots: string[] = [];
/** Daemon homes this file planted wreckage in; emptied again after each test. */
const planted: string[] = [];

function home(): string {
  const dir = makeProjectTempDir('gv-one-resolution');
  roots.push(dir);
  return dir;
}

/**
 * Plant the exact wreckage the owner's machine carried: a running-daemon record
 * naming the abandoned port with a pid that IS alive (this process, a pid alive
 * on a dead port is precisely the recycled-pid case), and a daemon config whose
 * control-plane binding names that same abandoned port.
 *
 * The destination is the daemon home ROUTING ITSELF resolves, never a path
 * assembled here. The test suite pins GOODVIBES_DAEMON_HOME to a hermetic
 * directory so no test can reach a real daemon, and planting at a hand-built
 * `<home>/.goodvibes/daemon` therefore plants where nothing reads, the wreckage
 * would be absent, the assertions would pass, and they would prove nothing.
 */
function plantStaleAddressEverywhere(h: string): string {
  const daemonHome = buildAgentConfigRouting({ homeDir: h }).daemonHomeDir!;
  // That directory is shared by the whole test RUN (the suite pins one hermetic
  // GOODVIBES_DAEMON_HOME), so what is planted here has to be taken away again.
  // Leaving it behind pointed every later test in the process at a dead daemon.
  planted.push(daemonHome);
  mkdirSync(daemonHome, { recursive: true });
  writeFileSync(
    join(daemonHome, 'detached-daemon.json'),
    JSON.stringify({
      pid: process.pid,
      host: '0.0.0.0',
      port: ABANDONED_PORT,
      command: 'goodvibes-daemon',
      startedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(daemonHome, 'settings.json'),
    JSON.stringify({ controlPlane: { hostMode: 'network', host: '0.0.0.0', port: ABANDONED_PORT } }),
  );
  return daemonHome;
}

/**
 * A connected host that knows the truth. `snapshot` answers what the live daemon
 * holds; `set` records what it was told. Nothing here consults an address,
 * that is the point of holding a connection.
 */
function connectedHost(config: Record<string, unknown>) {
  const writes: { key: string; value: unknown }[] = [];
  let snapshots = 0;
  return {
    writes,
    snapshotCount: () => snapshots,
    client: {
      ownsKey: (key: string) => key.startsWith('surfaces.'),
      set: async (key: string, value: unknown) => {
        writes.push({ key, value });
      },
      get: async (key: string) => {
        const [head, ...rest] = key.split('.');
        let cursor: unknown = config[head!];
        for (const segment of rest) {
          if (cursor === null || typeof cursor !== 'object') return undefined;
          cursor = (cursor as Record<string, unknown>)[segment];
        }
        return cursor;
      },
      snapshot: async () => {
        snapshots += 1;
        return config;
      },
    },
  };
}

afterEach(() => {
  installAgentDaemonConfigClient(null);
  // The record and the daemon settings file, not the directory: the directory is
  // the run's, and other tests are entitled to find it as they left it.
  while (planted.length > 0) {
    const dir = planted.pop()!;
    rmSync(join(dir, 'detached-daemon.json'), { force: true });
    rmSync(join(dir, 'settings.json'), { force: true });
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('a settings read comes back from the host the write went to', () => {
  test('a held connection answers reads, so a doubly-stale address is never dialled', async () => {
    const h = home();
    plantStaleAddressEverywhere(h);
    const host = connectedHost({ surfaces: { telegram: { botUsername: 'goodvibes_agent_bot' } } });
    installAgentDaemonConfigClient(host.client);

    const view = await openEffectiveConfigView(new ConfigManager({ homeDir: h, surfaceRoot: 'agent' }), {
      homeDir: h,
    });

    // The live value, from the daemon that holds it, not `unavailable`, and
    // not a local default dressed up as the current setting.
    expect(view.get(DAEMON_KEY)).toBe('goodvibes_agent_bot');
    expect(view.unavailable.has(DAEMON_KEY)).toBe(false);
    expect(view.daemonError).toBeNull();
    expect(host.snapshotCount()).toBeGreaterThan(0);

    // The abandoned port never entered the answer. This is the assertion that
    // would have failed for the whole lost session.
    expect(String(view.daemonBaseUrl)).not.toContain(String(ABANDONED_PORT));
    expect(view.describe(DAEMON_KEY).store).not.toContain(String(ABANDONED_PORT));
  });

  test('read and write resolve the same endpoint, by construction', async () => {
    const h = home();
    plantStaleAddressEverywhere(h);
    const host = connectedHost({ surfaces: { telegram: { botUsername: 'before' } } });
    installAgentDaemonConfigClient(host.client);
    const config = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });

    const outcome = await routeConfigWrite(config, DAEMON_KEY, 'after', { homeDir: h });
    const view = await openEffectiveConfigView(config, { homeDir: h });

    // The write left this process through the connected host...
    expect(outcome.appliedBy).toBe('daemon');
    expect(host.writes).toEqual([{ key: DAEMON_KEY, value: 'after' }]);
    // ...and the read came back from that same host. Both legs name the
    // connection rather than an address, which is the property that matters:
    // an address is a thing two resolutions can disagree about, and these two
    // no longer resolve anything. Neither answer carries a port at all.
    expect(view.describe(DAEMON_KEY).store).toContain('connected host');
    expect(outcome.persistedTo).toContain('connected host');
    expect(view.describe(DAEMON_KEY).store).not.toMatch(/:\d+/);
    expect(outcome.persistedTo).not.toMatch(/:\d+/);
  });

  test('the routing deps carry the snapshot seam whenever a client is installed', () => {
    const h = home();
    expect(buildAgentConfigRouting({ homeDir: h }).readDaemonSnapshot).toBeUndefined();

    installAgentDaemonConfigClient(connectedHost({}).client);

    // Presence is what makes the read route 'daemon' rather than discovery. A
    // process holding a connection must never fall through to an address.
    expect(buildAgentConfigRouting({ homeDir: h }).readDaemonSnapshot).toBeDefined();
  });

  test('a client installed after the deps were built still answers the read', async () => {
    const h = home();
    const host = connectedHost({ surfaces: { telegram: { botUsername: 'late-but-live' } } });
    // Installed BEFORE the view opens but conceptually after composition order
    // has already moved on: the client is resolved when the snapshot is taken,
    // not captured when the deps were assembled.
    installAgentDaemonConfigClient(host.client);
    plantStaleAddressEverywhere(h);

    const view = await openEffectiveConfigView(new ConfigManager({ homeDir: h, surfaceRoot: 'agent' }), {
      homeDir: h,
    });

    expect(view.get(DAEMON_KEY)).toBe('late-but-live');
  });

  test('with no connection held, discovery still runs: and the live daemon wins over a dead record', async () => {
    const h = home();
    const daemonHome = plantStaleAddressEverywhere(h);
    // The binding now names the port a daemon really is on, while the record
    // still names the abandoned one. This is the case discovery's reap DOES
    // cover, and it must keep covering it for a process holding no connection.
    writeFileSync(
      join(daemonHome, 'settings.json'),
      JSON.stringify({ controlPlane: { hostMode: 'network', host: '127.0.0.1', port: LIVE_PORT } }),
    );

    const deps = buildAgentConfigRouting({ homeDir: h });
    expect(deps.readDaemonSnapshot).toBeUndefined();
    expect(deps.readDaemonBinding?.()?.port).toBe(LIVE_PORT);
  });
});
