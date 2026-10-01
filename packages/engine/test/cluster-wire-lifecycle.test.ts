import { expect, test } from 'bun:test';
import { GroupWireRouter, type ClusterTransport } from '../sdk/src/platform/cluster/index.js';
import { encodeEnvelope, type ClusterKeyring } from '../sdk/src/platform/cluster/protocol-envelope.js';
function deferred() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release: () => release() }; }
async function turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(startHook?: () => Promise<void>, stopHook?: () => Promise<void>) {
  let running = false; let starts = 0; let stops = 0;
  let receive: ((raw: string) => void) | undefined;
  const keyring: ClusterKeyring = {
    groupId: 'gTESTTESTTESTTEST', currentGeneration: 1,
    keyForGeneration: (generation) => generation === 1 ? 'fixture-key' : null,
    acceptedGenerations: () => [1],
  };
  const inner: ClusterTransport = {
    async start(onMessage) { starts++; receive = onMessage; await startHook?.(); running = true; },
    async stop() { stops++; await stopHook?.(); running = false; },
    async send() {}, describe: () => ({ mode: 'in-memory', group: 'fixture', port: 0, peers: [] }),
  };
  const router = new GroupWireRouter({
    inner, keyring,
    logger: { debug() {}, info() {}, warn() {}, error() {} }, now: () => 1000,
    onGroupMessage() {}, onOutOfBandMessage() {}, onForeignBeacon() {},
  });
  return { router, heartbeat: () => receive?.(encodeEnvelope({
    type: 'HEARTBEAT', nodeId: 'fixture-peer', nodeVersion: '1.0.0', seq: 1, ts: 1000, body: {},
  }, keyring)), get running() { return running; }, get starts() { return starts; }, get stops() { return stops; }, cleanup: () => inner.stop() };
}
test('wire tenants share actual startup readiness', async () => {
  const hold = deferred(); const f = fixture(() => hold.promise); const first = f.router.ensureStarted();
  let ready = false; const second = f.router.ensureStarted().then(() => { ready = true; });
  try { await turns(); expect(ready).toBe(false); }
  finally { hold.release(); await Promise.allSettled([first, second]); await f.router.stop(); await f.cleanup(); }
});
test('wire stop cannot finish while transport start is still in flight', async () => {
  const hold = deferred(); const f = fixture(() => hold.promise); const starting = f.router.ensureStarted();
  const stopping = f.router.stop();
  try { await turns(); hold.release(); await Promise.allSettled([starting, stopping]); expect(f.running).toBe(false); }
  finally { hold.release(); await Promise.allSettled([starting, stopping]); await f.cleanup(); }
});
test('wire startup retries after a real transport failure', async () => {
  let attempts = 0; const f = fixture(async () => { if (++attempts === 1) throw new Error('fixture start'); });
  try { await expect(f.router.ensureStarted()).rejects.toThrow('fixture start'); await f.router.ensureStarted(); expect(attempts).toBe(2); }
  finally { await f.router.stop(); await f.cleanup(); }
});
test('failed wire cleanup is retried rather than reported stopped', async () => {
  let attempts = 0; const f = fixture(undefined, async () => { if (++attempts === 1) throw new Error('fixture stop'); });
  try { await f.router.ensureStarted(); await expect(f.router.stop()).rejects.toThrow('fixture stop'); await f.router.stop(); expect(f.running).toBe(false); expect(attempts).toBe(2); }
  finally { await f.cleanup(); }
});

test('a tenant refused during held stop cannot receive after group-only restart', async () => {
  const entered = deferred(); const hold = deferred();
  const f = fixture(undefined, async () => { entered.release(); await hold.promise; });
  const tenant = f.router.electionTransport('1.0.0');
  let delivered = 0;
  await f.router.ensureStarted();
  const stopping = f.router.stop();
  try {
    await entered.promise;
    await expect(tenant.start(() => { delivered++; })).rejects.toThrow('Cluster resource is stopping');
    hold.release(); await stopping;
    await f.router.ensureStarted();
    f.heartbeat();
    expect(delivered).toBe(0);
    await tenant.start(() => { delivered++; });
    f.heartbeat();
    expect(delivered).toBe(1);
    await tenant.stop();
    expect(f.running).toBe(true);
    f.heartbeat();
    expect(delivered).toBe(1);
  } finally { hold.release(); await stopping; await f.router.stop(); }
});

test('tenant stop invalidates an in-flight registration without stopping the group', async () => {
  const entered = deferred(); const hold = deferred();
  const f = fixture(async () => { entered.release(); await hold.promise; });
  const tenant = f.router.electionTransport('1.0.0');
  let delivered = 0;
  const starting = tenant.start(() => { delivered++; });
  try {
    await entered.promise;
    await tenant.stop();
    hold.release(); await starting;
    f.heartbeat();
    expect(delivered).toBe(0);
    expect(f.running).toBe(true);
    await tenant.start(() => { delivered++; });
    f.heartbeat();
    expect(delivered).toBe(1);
  } finally { hold.release(); await starting; await f.router.stop(); }
});

test('a failed tenant acquisition cannot receive after group-only retry', async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts === 1) throw new Error('fixture start'); });
  let delivered = 0;
  try {
    await expect(f.router.electionTransport('1.0.0').start(() => { delivered++; })).rejects.toThrow('fixture start');
    await f.router.ensureStarted();
    f.heartbeat();
    expect(delivered).toBe(0);
  } finally { await f.router.stop(); }
});

test('only the newest tenant registration receives traffic after shared startup', async () => {
  const entered = deferred(); const hold = deferred();
  const f = fixture(async () => { entered.release(); await hold.promise; });
  const tenant = f.router.electionTransport('1.0.0');
  let obsolete = 0; let current = 0;
  const first = tenant.start(() => { obsolete++; });
  await entered.promise;
  const second = tenant.start(() => { current++; });
  try {
    f.heartbeat();
    expect(obsolete).toBe(0);
    expect(current).toBe(0);
    hold.release(); await Promise.all([first, second]);
    f.heartbeat();
    expect(obsolete).toBe(0);
    expect(current).toBe(1);
    expect(f.starts).toBe(1);
  } finally { hold.release(); await Promise.allSettled([first, second]); await f.router.stop(); }
});

test('router stop invalidates a tenant registration waiting for ready delivery', async () => {
  const f = fixture();
  const tenant = f.router.electionTransport('1.0.0');
  let delivered = 0;
  await f.router.ensureStarted();
  const starting = tenant.start(() => { delivered++; });
  const stopping = f.router.stop();
  try {
    await Promise.allSettled([starting, stopping]);
    await f.router.ensureStarted();
    f.heartbeat();
    expect(delivered).toBe(0);
  } finally { await f.router.stop(); }
});
