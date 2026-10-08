import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, startHomeDaemonServer, type E2EHome } from '../e2e/harness.ts';

const homes: E2EHome[] = [];
const servers: Bun.Server<undefined>[] = [];

function own(server: Bun.Server<undefined>): Bun.Server<undefined> {
  servers.push(server);
  return server;
}

async function freshHome(): Promise<E2EHome> {
  // Only provider metadata is needed; no model or compiled TUI is launched.
  const home = await makeHome({ baseURL: 'http://127.0.0.1:1/v1', requests: [], stop() {} });
  homes.push(home);
  return home;
}

function settingsPath(home: E2EHome): string {
  return join(home.home, '.goodvibes/daemon/settings.json');
}

afterEach(async () => {
  const stopped = await Promise.allSettled(servers.splice(0).map(server => server.stop(true)));
  for (const home of homes.splice(0)) rmSync(home.root, { recursive: true, force: true });
  const errors = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'E2E listener test cleanup failed');
});

test('owned daemon listener ignores an occupied home probe and routes canonical discovery to its bound port', async () => {
  const home = await freshHome();
  let strangerRequests = 0;
  const stranger = own(Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    strangerRequests++;
    return new Response('another owner');
  } }));
  // The conflicting configured port already has an owner; never reclaim a
  // released freePort probe even in this regression setup.
  home.setDaemonPort(stranger.port!);
  const oldPort = home.daemonPort;
  const tuiSettings = join(home.home, '.goodvibes/tui/settings.json');
  const tuiBefore = readFileSync(tuiSettings);
  const before = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
  writeFileSync(settingsPath(home), JSON.stringify({ ...before, fixtureMetadata: { retained: true } }));

  const proxy = own(await startHomeDaemonServer(home, request => Response.json({ owner: 'fixture', path: new URL(request.url).pathname })));
  expect(proxy.port).not.toBe(oldPort);
  expect(home.daemonPort).toBe(proxy.port!);
  const config = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
  expect(config).toEqual({ ...before, controlPlane: { ...before.controlPlane, port: proxy.port }, fixtureMetadata: { retained: true } });
  expect(readFileSync(tuiSettings)).toEqual(tuiBefore);
  // The pairing fixture snapshots shared settings only after this setup.
  const sharedBytes = readFileSync(settingsPath(home));
  const discovery = `http://${config.controlPlane.host}:${config.controlPlane.port}`;
  expect(discovery).toBe(proxy.url.origin);
  expect(await (await fetch(`${discovery}/discovery`)).json()).toEqual({ owner: 'fixture', path: '/discovery' });
  expect(await (await fetch(new URL('/explicit-origin', proxy.url))).json()).toEqual({ owner: 'fixture', path: '/explicit-origin' });
  expect(strangerRequests).toBe(0);
  expect(readFileSync(settingsPath(home))).toEqual(sharedBytes);
  expect(await (await fetch(stranger.url)).text()).toBe('another owner');

  let occupiedError: unknown;
  try { own(Bun.serve({ hostname: '127.0.0.1', port: home.daemonPort, fetch: () => new Response('unowned') })); }
  catch (error) { occupiedError = error; }
  expect(occupiedError).toMatchObject({ code: 'EADDRINUSE' });

  // No release/reclaim occurs during setup. Only awaited teardown relinquishes
  // this port; a new real listener can bind it immediately afterward.
  await proxy.stop(true);
  const replacement = own(Bun.serve({ hostname: '127.0.0.1', port: home.daemonPort, fetch: () => new Response('replacement') }));
  expect(await (await fetch(replacement.url)).text()).toBe('replacement');
});

test('daemon port setter rejects zero or invalid port numbers without altering home or settings', async () => {
  const home = await freshHome();
  const port = home.daemonPort;
  const bytes = readFileSync(settingsPath(home));
  for (const invalid of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => home.setDaemonPort(invalid)).toThrow(RangeError);
    expect(home.daemonPort).toBe(port);
    expect(readFileSync(settingsPath(home))).toEqual(bytes);
  }
});

test('configuration write failure closes the newly bound listener before rejecting setup', async () => {
  const home = await freshHome();
  const originalPort = home.daemonPort;
  // A real filesystem failure, after the server bound, exercises rollback.
  rmSync(settingsPath(home));
  mkdirSync(settingsPath(home));
  let boundPort: number | undefined;
  const setDaemonPort = home.setDaemonPort;
  home.setDaemonPort = port => { boundPort = port; setDaemonPort(port); };
  await expect(startHomeDaemonServer(home, () => new Response('should be closed'))).rejects.toMatchObject({ code: 'EISDIR' });
  expect(home.daemonPort).toBe(originalPort);
  expect(boundPort).toBeGreaterThan(0);
  const replacement = own(Bun.serve({ hostname: '127.0.0.1', port: boundPort!, fetch: () => new Response('released after failure') }));
  expect(await (await fetch(replacement.url)).text()).toBe('released after failure');
});
