import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isolatedTestEnvironment } from '../scripts/test-isolation.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

type Scenario = 'untrusted' | 'trusted' | 'wrong-host';

function isolatedScenario(mode: Scenario, weakened: boolean): void {
  const root = makeProjectTempDir('imap-tls-identity');
  const originalReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const originalCa = process.env.NODE_EXTRA_CA_CERTS;
  try {
    // Ephemeral, owned test material only. The certificate's trust is added at
    // child startup, through the same supported CA mechanism an operator uses.
    const key = join(root, 'synthetic-imap.key');
    const cert = join(root, 'synthetic-imap.crt');
    const name = mode === 'wrong-host' ? 'other-imap.example.test' : 'localhost';
    const generated = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-days', '1',
    ], { env: isolatedTestEnvironment(process.env, root), encoding: 'utf8', timeout: 10_000 });
    expect(generated.error?.message ?? null).toBeNull();
    expect(generated.status, generated.stderr).toBe(0);

    const result = spawnSync(process.execPath, [
      '--preload', resolve(import.meta.dir, '../toolchain/src/test-runner/test-network-preload.ts'),
      resolve(import.meta.dir, 'fixtures/imap-tls-identity-child.ts'), mode, key, cert,
    ], {
      env: isolatedTestEnvironment(process.env, root, {
        NODE_TLS_REJECT_UNAUTHORIZED: weakened ? '0' : '1',
        ...(mode === 'untrusted' ? {} : { NODE_EXTRA_CA_CERTS: cert }),
      }),
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    });
    expect(result.error?.message ?? null).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode, passed: true, loginCount: mode === 'trusted' ? 1 : 0,
      secretTransferred: mode === 'trusted',
    });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(originalReject);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(originalCa);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('IMAP TLS server identity before service credentials', () => {
  for (const weakened of [false, true]) {
    const environment = weakened ? 'NODE_TLS_REJECT_UNAUTHORIZED=0' : 'normal TLS verification';
    test(`rejects an untrusted certificate before LOGIN with ${environment}`, () => {
      isolatedScenario('untrusted', weakened);
    });
    test(`keeps an explicitly trusted local CA usable with ${environment}`, () => {
      isolatedScenario('trusted', weakened);
    });
  }

  test('rejects a trusted certificate for the wrong hostname even with weakened TLS environment', () => {
    isolatedScenario('wrong-host', true);
  });
});
