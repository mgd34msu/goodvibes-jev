import { describe, expect, test } from 'bun:test';
import { createAtRestCipher, type DaemonCredentialStore } from '../sdk/src/platform/config/daemon-credential-store.js';

const FIXTURE_KEY = Buffer.alloc(32, 7).toString('base64');
function store(initial: string | null) {
  let value = initial;
  let writes = 0;
  const port: DaemonCredentialStore = {
    async resolveRef() { return value; },
    async resolveConfigSecret() { return value; },
    async put(_name, next) { writes++; value = next; },
    async has() { return value !== null; },
  };
  return { port, get value() { return value; }, get writes() { return writes; } };
}

describe('pinned draft key preservation', () => {
  test('existing valid fixture key round-trips without changing it', async () => {
    const fixture = store(FIXTURE_KEY); const cipher = createAtRestCipher(fixture.port);
    const encrypted = await cipher.encrypt('fixture draft');
    expect(await cipher.decrypt(encrypted)).toBe('fixture draft');
    expect(fixture.value).toBe(FIXTURE_KEY); expect(fixture.writes).toBe(0);
  });
  test('malformed existing key refuses rather than replacing it', async () => {
    const fixture = store('dummy-malformed-existing-key');
    await expect(createAtRestCipher(fixture.port).encrypt('fixture draft')).rejects.toThrow();
    expect(fixture.value).toBe('dummy-malformed-existing-key'); expect(fixture.writes).toBe(0);
  });
  test('decrypt with missing key refuses without generating a replacement', async () => {
    const ciphertext = await createAtRestCipher(store(FIXTURE_KEY).port).encrypt('fixture draft');
    const fixture = store(null);
    await expect(createAtRestCipher(fixture.port).decrypt(ciphertext)).rejects.toThrow();
    expect(fixture.writes).toBe(0); expect(fixture.value).toBeNull();
  });
});

describe('draft cipher lifecycle', () => {
  test('concurrent encrypt calls create one key and use fresh IVs', async () => {
    const fixture = store(null); const cipher = createAtRestCipher(fixture.port);
    const [first, second] = await Promise.all([cipher.encrypt('fixture'), cipher.encrypt('fixture')]);
    expect(fixture.writes).toBe(1);
    expect(Buffer.from(fixture.value!, 'base64').length).toBe(32);
    expect(first).not.toBe(second);
    expect(await cipher.decrypt(first)).toBe('fixture');
    expect(await cipher.decrypt(second)).toBe('fixture');
  });
  test('a missing-key decrypt does not prevent later explicit encryption', async () => {
    const fixture = store(null); const cipher = createAtRestCipher(fixture.port);
    await expect(cipher.decrypt(Buffer.alloc(28).toString('base64'))).rejects.toThrow('missing');
    expect(fixture.writes).toBe(0);
    expect(await cipher.decrypt(await cipher.encrypt('fixture'))).toBe('fixture');
    expect(fixture.writes).toBe(1);
  });
  test('authenticated corruption is refused without changing the key', async () => {
    const fixture = store(FIXTURE_KEY); const cipher = createAtRestCipher(fixture.port);
    const payload = Buffer.from(await cipher.encrypt('fixture'), 'base64');
    payload[payload.length - 1]! ^= 1;
    await expect(cipher.decrypt(payload.toString('base64'))).rejects.toThrow();
    expect(fixture.writes).toBe(0);
  });
  test('a failed store write is reread before retry, preserving a write that actually landed', async () => {
    const fixture = store(null); const put = fixture.port.put;
    let failed = false;
    fixture.port.put = async (...args) => {
      await put(...args);
      if (!failed) { failed = true; throw new Error('fixture uncertain write'); }
    };
    const cipher = createAtRestCipher(fixture.port);
    await expect(cipher.encrypt('first')).rejects.toThrow('fixture uncertain write');
    const firstValue = fixture.value;
    expect(await cipher.decrypt(await cipher.encrypt('retry'))).toBe('retry');
    expect(fixture.writes).toBe(1);
    expect(fixture.value === firstValue).toBe(true);
  });
  for (const invalid of ['', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    test(`wrong-sized stored key of length ${invalid.length} is preserved`, async () => {
      const fixture = store(invalid); const cipher = createAtRestCipher(fixture.port);
      await expect(cipher.encrypt('fixture')).rejects.toThrow('invalid');
      await expect(cipher.decrypt(Buffer.alloc(28).toString('base64'))).rejects.toThrow('invalid');
      expect(fixture.writes).toBe(0);
      expect(fixture.value === invalid).toBe(true);
    });
  }
});
