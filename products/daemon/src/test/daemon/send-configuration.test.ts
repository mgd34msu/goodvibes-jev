import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment } from '@goodvibes-jev/engine/toolchain/test-runner';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

test('valid JSON with a quarantined credential cannot silently use a synthetic environment account', () => {
  const root = makeOwnedTempDir('daemon-send-quarantined-credential');
  const work = join(root, 'work'); const daemon = join(root, 'daemon');
  mkdirSync(work, { recursive: true }); mkdirSync(daemon, { recursive: true });
  const malformed = 'goodvibes://owned-private-host-reference/';
  writeFileSync(join(daemon, 'settings.json'), JSON.stringify({
    controlPlane: { gateway: true }, integrations: { routeBinding: true, deliveryTracking: true }, service: { enabled: true },
    surfaces: { ntfy: { enabled: true, baseUrl: 'http://127.0.0.1:1', topic: 'synthetic-topic', token: malformed } },
  }));
  const env = isolatedTestEnvironment(process.env, root, {
    GOODVIBES_HOME: join(root, 'tree'), GOODVIBES_DAEMON_HOME: daemon, GOODVIBES_WORKING_DIR: work,
    NTFY_ACCESS_TOKEN: 'synthetic-environment-token',
  });
  try {
    const child = spawnSync(process.execPath, ['--no-env-file', '--preload',
      fileURLToPath(new URL('../../../../../packages/engine/toolchain/src/test-runner/test-network-preload.ts', import.meta.url)),
      fileURLToPath(new URL('../helpers/send-quarantined-credential-child.ts', import.meta.url)),
    ], { cwd: work, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).not.toContain('owned-private-host-reference');
    expect(child.stderr).not.toContain('owned-private-host-reference');
    expect(child.stdout).not.toContain('synthetic-environment-token');
    expect(child.stderr).not.toContain('synthetic-environment-token');
    expect(JSON.parse(child.stdout)).toEqual({
      exitCode: 2, stdout: [],
      stderr: ['Configured credentials were withheld: surfaces.ntfy.token. Nothing was sent.'],
      secretLookups: 0, serviceLookups: 0, fetches: 0, stacks: 0, hasSyntheticEnvironmentToken: true,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
