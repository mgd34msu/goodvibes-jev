import { expect, test } from 'bun:test';
import { GroupWireRouter, type ClusterTransport } from '../sdk/src/platform/cluster/index.js';
function deferred() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release: () => release() }; }
async function turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(startHook?: () => Promise<void>, stopHook?: () => Promise<void>) {
  let running = false; let starts = 0; let stops = 0;
  const inner: ClusterTransport = {
    async start() { starts++; await startHook?.(); running = true; },
    async stop() { stops++; await stopHook?.(); running = false; },
    async send() {}, describe: () => ({ mode: 'in-memory', group: 'fixture', port: 0, peers: [] }),
  };
  const router = new GroupWireRouter({
    inner, keyring: { groupId: '', currentGeneration: 0, keyForGeneration: () => null, acceptedGenerations: () => [] },
    logger: { debug() {}, info() {}, warn() {}, error() {} }, now: () => 1000,
    onGroupMessage() {}, onOutOfBandMessage() {}, onForeignBeacon() {},
  });
  return { router, get running() { return running; }, get starts() { return starts; }, get stops() { return stops; }, cleanup: () => inner.stop() };
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
