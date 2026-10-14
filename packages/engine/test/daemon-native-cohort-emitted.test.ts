import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCohortFixture } from './_helpers/daemon-native-cohort.ts';

const nativeTest = process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64') ? test : test.skip;

nativeTest('ordinary Node qualifies the actual emitted native installation and mutation owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-emitted-cohort-input-'));
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const old = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'original emitted fixture daemon', arch });
    const next = nativeCohortFixture({ version: '2.0.24', daemonBytes: 'replacement emitted fixture daemon', arch });
    const pack = (fixture: typeof old) => ({ artifact: fixture.artifact, bytes: [...fixture.members.map(member => member.bytes), fixture.receipt].map(bytes => bytes.toString('base64')) });
    const fixturePath = join(root, 'inert-native-cohort.json');
    writeFileSync(fixturePath, JSON.stringify({ old: pack(old), next: pack(next) }));
    const home = join(root, 'isolated-runtime-home'); mkdirSync(home); writeFileSync(join(home, 'sentinel'), 'runtime home unchanged');
    const result = spawnSync('node', ['--test', '--test-reporter=tap', join(import.meta.dir, '_helpers/daemon-native-cohort-emitted.mjs')], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home, GOODVIBES_HOME: join(home, '.goodvibes'), JEV_NATIVE_EMITTED_FIXTURE: fixturePath },
    });
    if (result.status === 0) process.stdout.write(result.stdout);
    expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('# tests 17'); expect(result.stdout).toContain('# pass 17'); expect(result.stdout).toContain('# fail 0');
    expect(result.stderr).toBe('');
    expect(readFileSync(join(home, 'sentinel'), 'utf8')).toBe('runtime home unchanged'); expect(readdirSync(home)).toEqual(['sentinel']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
