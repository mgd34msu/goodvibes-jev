import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentAccountRegistry, type AgentAccountCreateInput } from '../sdk/src/platform/google/account-registry.ts';
import { AsyncAgentAccountRegistry, type AsyncSecretLikeTextReader, type SecretLikeTextReading } from '../sdk/src/platform/google/async-account-registry.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(reader: AsyncSecretLikeTextReader = () => false) {
  const root = mkdtempSync(join(tmpdir(), 'account-safety-')); roots.push(root);
  const storePath = join(root, 'accounts.json');
  const sync = new AgentAccountRegistry({ storePath, containsSecretLikeText: () => false });
  return { storePath, sync, registry: new AsyncAgentAccountRegistry({ storePath, readSecretLikeText: reader }) };
}
const input = (overrides: Partial<AgentAccountCreateInput> = {}): AgentAccountCreateInput => ({
  serviceDomain: 'example.com', serviceUrl: 'https://example.com/signup',
  aliasAddress: 'owner+fixture@example.net', purpose: 'An isolated account registry fixture',
  credentialSecretKey: 'signup/example/fixture', now: new Date('2026-10-01T00:00:00Z'), ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function pendingReader() {
  const started = deferred<AbortSignal | undefined>(); const release = deferred<void>();
  let calls = 0;
  const reader: AsyncSecretLikeTextReader = async (_text, signal) => {
    calls++;
    if (calls === 1) { started.resolve(signal); await release.promise; }
    return false;
  };
  return { reader, started, release, calls: () => calls };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Account operation failed to settle on cancellation')), 500);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

describe('AsyncAgentAccountRegistry content decisions', () => {
  test('records, enumerates, looks up, sweeps and forgets through awaited readings', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const { registry } = fixture(async (_text, signal) => { signals.push(signal); return { outcome: 'clear' }; });
    const options = { signal: new AbortController().signal };
    const account = await registry.record(input(), options);
    expect(account.id).toBe('example-com');
    expect((await registry.snapshot(options)).accounts).toEqual([account]);
    expect(await registry.get(account.id.toUpperCase(), options)).toEqual(account);
    expect((await registry.sweep({ knownSecretKeys: [account.credentialSecretKey] }, options)).remaining).toBe(1);
    expect(await registry.forget(account.id, options)).toEqual(account);
    expect(await registry.list(options)).toEqual([]);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal === options.signal)).toBe(true);
  });

  for (const secret of [true, { outcome: 'secret' }] as const) test(`a ${JSON.stringify(secret)} reading refuses the write`, async () => {
    const { registry, storePath } = fixture(() => secret);
    await expect(registry.record(input())).rejects.toThrow('cannot store secret-looking values');
    expect(existsSync(storePath)).toBe(false);
  });

  for (const outcome of ['held', 'unavailable'] as const) test(`${outcome} content is neither disclosed nor compacted away`, async () => {
    const { registry, sync, storePath } = fixture(() => ({ outcome }));
    sync.record(input());
    const original = readFileSync(storePath, 'utf8');
    await expect(registry.snapshot()).rejects.toThrow('unresolved');
    await expect(registry.record(input())).rejects.toThrow('unresolved');
    await expect(registry.sweep()).rejects.toThrow('unresolved');
    expect(readFileSync(storePath, 'utf8')).toBe(original);
  });

  for (const invalid of [undefined, null, 0, 1, '', 'false', {}, { outcome: true }, { outcome: 'act', verdict: 'no' }]) {
    test(`does not coerce ${JSON.stringify(invalid)} into clearance`, async () => {
      const { registry, storePath } = fixture(async () => invalid as SecretLikeTextReading);
      await expect(registry.record(input())).rejects.toThrow(TypeError);
      expect(existsSync(storePath)).toBe(false);
    });
  }

  test('a failed stored-record reading is not an empty writable store', async () => {
    let fail = true;
    const { registry, sync, storePath } = fixture(async () => { if (fail) throw new Error('fixture reading failed'); return false; });
    const initial = sync.record(input()); const original = readFileSync(storePath, 'utf8');
    await expect(registry.record(input())).rejects.toThrow('fixture reading failed');
    expect(readFileSync(storePath, 'utf8')).toBe(original);
    fail = false;
    expect(await registry.get(initial.id)).toEqual(initial);
  });

  test('a confirmed secret record is withheld and counted, while malformed entries are counted separately', async () => {
    const { registry, sync, storePath } = fixture((text) => text === 'synthetic secret fixture');
    const clear = sync.record(input());
    sync.record(input({ purpose: 'synthetic secret fixture' }));
    const stored = JSON.parse(readFileSync(storePath, 'utf8')); stored.accounts.push({ invalid: true });
    writeFileSync(storePath, JSON.stringify(stored));
    const snapshot = await registry.snapshot();
    expect(snapshot.accounts).toEqual([clear]);
    expect(snapshot.droppedOnRead).toBe(2);
  });

  for (const raw of ['{invalid', '{}', '{"version":2,"accounts":[]}', '{"version":1,"accounts":false}']) {
    test(`an existing malformed store is not overwritten: ${raw}`, async () => {
      const { registry, storePath } = fixture(); writeFileSync(storePath, raw);
      await expect(registry.record(input())).rejects.toThrow('was not changed');
      expect(readFileSync(storePath, 'utf8')).toBe(raw);
    });
  }

  test('an unreadable non-file store is not replaced with an empty writable registry', async () => {
    const { registry, storePath } = fixture(); mkdirSync(storePath);
    await expect(registry.record(input())).rejects.toThrow('not a regular file');
    expect(statSync(storePath).isDirectory()).toBe(true);
  });
});

describe('account operation ownership and cancellation', () => {
  test('pending clearance cannot disclose an existing account', async () => {
    const reading = pendingReader(); const { registry, sync } = fixture(reading.reader); sync.record(input());
    let disclosed = false;
    const pending = registry.snapshot().then((value) => { disclosed = true; return value; });
    await reading.started.promise;
    expect(disclosed).toBe(false);
    reading.release.resolve();
    expect((await pending).accounts).toHaveLength(1);
  });

  test('pending clearance cannot create the file', async () => {
    const reading = pendingReader(); const { registry, storePath } = fixture(reading.reader);
    const pending = registry.record(input());
    await reading.started.promise; expect(existsSync(storePath)).toBe(false);
    reading.release.resolve(); await pending; expect(existsSync(storePath)).toBe(true);
  });

  for (const mode of ['snapshot', 'record']) test(`cancelling ${mode} prevents a late disclosure or write and leaves the next caller usable`, async () => {
    const reading = pendingReader(); const { registry, sync, storePath } = fixture(reading.reader);
    sync.record(input()); const original = readFileSync(storePath, 'utf8');
    const controller = new AbortController(); const options = { signal: controller.signal };
    const pending = mode === 'snapshot' ? registry.snapshot(options) : registry.record(input(), options);
    const settled = pending.then(() => null, (error: unknown) => error);
    expect(await reading.started.promise).toBe(controller.signal);
    controller.abort(new Error('owner cancelled'));
    expect(await within(settled)).toMatchObject({ message: 'owner cancelled' });
    expect(readFileSync(storePath, 'utf8')).toBe(original);
    expect(await registry.list()).toHaveLength(1);
    reading.release.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(readFileSync(storePath, 'utf8')).toBe(original);
  });

  test('already aborted operations make no reading or file change', async () => {
    let reads = 0; const { registry, storePath } = fixture(() => { reads++; return false; });
    const controller = new AbortController(); controller.abort(new Error('already cancelled'));
    await expect(registry.record(input(), { signal: controller.signal })).rejects.toThrow('already cancelled');
    expect(reads).toBe(0); expect(existsSync(storePath)).toBe(false);
  });

  test('same-path instances serialize record allocation without losing either write', async () => {
    const reading = pendingReader(); const { registry, storePath } = fixture(reading.reader);
    const other = new AsyncAgentAccountRegistry({ storePath, readSecretLikeText: () => false });
    const first = registry.record(input()); await reading.started.promise;
    const second = other.record(input()); reading.release.resolve();
    const records = await Promise.all([first, second]);
    expect(records.map((account) => account.id)).toEqual(['example-com', 'example-com-2']);
    expect(await other.list()).toHaveLength(2);
  });

  test('queued input is captured before a caller can replace its fields', async () => {
    const reading = pendingReader(); const { registry } = fixture(reading.reader);
    const original = input(); const callerInput = { ...original };
    const first = registry.record(input()); await reading.started.promise;
    const queued = registry.record(callerInput);
    callerInput.purpose = 'mutated after submission';
    callerInput.now!.setUTCFullYear(2040);
    reading.release.resolve(); await first;
    const recorded = await queued;
    expect(recorded.purpose).toBe(original.purpose);
    expect(recorded.createdAt).toBe('2026-10-01T00:00:00.000Z');
  });

  test('a cancelled queued caller never starts a reader or mutation', async () => {
    const reading = pendingReader(); const { registry, storePath } = fixture(reading.reader);
    let reads = 0;
    const other = new AsyncAgentAccountRegistry({ storePath, readSecretLikeText: () => { reads++; return false; } });
    const first = registry.record(input()); await reading.started.promise;
    const controller = new AbortController();
    const queued = other.record(input(), { signal: controller.signal }).then(() => null, (error: unknown) => error);
    controller.abort(new Error('cancelled in queue'));
    expect(await within(queued)).toMatchObject({ message: 'cancelled in queue' });
    reading.release.resolve(); await first; await registry.list();
    expect(reads).toBe(0); expect(await registry.list()).toHaveLength(1);
  });

  for (const change of ['legacy write', 'deletion', 'replacement']) test(`rejects an intervening ${change} instead of overwriting or disclosing stale content`, async () => {
    const reading = pendingReader(); const { registry, sync, storePath } = fixture(reading.reader);
    sync.record(input());
    const pending = registry.record(input()); const settled = pending.then(() => null, (error: unknown) => error);
    await reading.started.promise;
    if (change === 'legacy write') sync.record(input());
    else if (change === 'deletion') unlinkSync(storePath);
    else { const replacement = `${storePath}.replacement`; writeFileSync(replacement, readFileSync(storePath)); renameSync(replacement, storePath); }
    const external = existsSync(storePath) ? readFileSync(storePath, 'utf8') : null;
    reading.release.resolve();
    expect(await settled).toMatchObject({ message: 'The account registry changed during its safety reading; retry from the current file' });
    expect(existsSync(storePath) ? readFileSync(storePath, 'utf8') : null).toBe(external);
  });

  test('an external rewrite while listing prevents stale disclosure', async () => {
    const reading = pendingReader(); const { registry, sync, storePath } = fixture(reading.reader);
    sync.record(input());
    const pending = registry.snapshot(); const settled = pending.then(() => null, (error: unknown) => error);
    await reading.started.promise;
    const external = '{"version":1,"accounts":[]}'; writeFileSync(storePath, external);
    reading.release.resolve();
    expect(await settled).toMatchObject({ message: 'The account registry changed during its safety reading; retry from the current file' });
    expect(readFileSync(storePath, 'utf8')).toBe(external);
  });
});
