/**
 * plugin-trust-signature.test.ts
 *
 * A plugin reaches the trusted tier through a signed manifest only when its
 * signature equals the HMAC-SHA256 of the canonical manifest under the
 * verification key. A signature that merely looks like base64 is not
 * verified: with no key, or the wrong key, trustSigned refuses.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { PluginTrustStore, validatePluginSignature } from '../sdk/src/platform/runtime/plugins/trust.ts';

const KEY = 'plugin-signing-key-for-tests';
const manifest = (signature: string | undefined) => ({
  name: 'repo-tools',
  version: '1.2.0',
  capabilities: ['fs.read', 'net.fetch'],
  signature,
});

function sign(key: string): string {
  const payload = JSON.stringify({ name: 'repo-tools', version: '1.2.0', capabilities: ['fs.read', 'net.fetch'].sort() });
  return createHmac('sha256', key).update(payload).digest('base64');
}

describe('validatePluginSignature', () => {
  test('a signature equal to the HMAC under the key is valid', () => {
    const result = validatePluginSignature(manifest(sign(KEY)), KEY);
    expect(result.valid).toBe(true);
    expect(result.fingerprint).toBe(sign(KEY).slice(0, 16));
  });

  test('without a key the signature is not verified, however well formed', () => {
    const result = validatePluginSignature(manifest(sign(KEY)));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No verification key');
  });

  test('a signature made with another key is refused', () => {
    expect(validatePluginSignature(manifest(sign('someone-else')), KEY)).toMatchObject({ valid: false, reason: 'HMAC mismatch' });
  });

  test('base64-shaped text that is not the HMAC is refused', () => {
    expect(validatePluginSignature(manifest('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'), KEY).valid).toBe(false);
  });

  test('a missing or malformed signature is refused', () => {
    expect(validatePluginSignature(manifest(undefined), KEY).valid).toBe(false);
    expect(validatePluginSignature(manifest('not base64!'), KEY).valid).toBe(false);
  });
});

describe('PluginTrustStore.trustSigned', () => {
  test('elevates to trusted only on a verified signature', () => {
    const store = new PluginTrustStore();
    expect(store.trustSigned('repo-tools', manifest(sign(KEY)))).toMatchObject({ ok: false });
    const trusted = store.trustSigned('repo-tools', manifest(sign(KEY)), KEY);
    expect(trusted.ok).toBe(true);
    if (trusted.ok) expect(trusted.record.tier).toBe('trusted');
  });
});
