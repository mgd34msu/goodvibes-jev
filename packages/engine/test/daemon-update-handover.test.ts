import { describe, expect, test } from 'bun:test';
import { updateConfigDefaults, updateConfigSettings } from '../sdk/src/platform/config/schema-domain-update.js';
import { resolveDaemonInstalledFiles } from '../sdk/src/platform/daemon/auto-updater.js';
import { inspectDaemonNativeInstallation, resolveDaemonNativePayloads } from '../sdk/src/platform/runtime/self-update.js';
import { nativeCohortFixture, nativeMemoryIo } from './_helpers/daemon-native-cohort.ts';

const DAEMON_REPO_LATEST = 'https://github.com/mgd34msu/goodvibes-jev/releases/latest';
const execPath = '/home/someone/.local/bin/goodvibes-daemon';
const cohort = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'native-daemon' });
const ownedPaths = [execPath, `${execPath}.bun`, `${execPath}.bun.LICENSE.md`, `${execPath}.bun.json`,
  '/home/someone/.local/bin/lib/sqlite-vec-linux-x64/vec0.so', '/home/someone/.local/bin/daemon-installation.json'];

function installation(extra: Record<string, Buffer> = {}) {
  return nativeMemoryIo({ ...cohort.installation(execPath), ...extra });
}

describe('daemon update source', () => {
  test('the shipped default names the authorized Jev release repository', () => {
    expect(updateConfigDefaults.update.releasesUrl).toBe(DAEMON_REPO_LATEST);
  });

  test('the settings definition and defaults object have the same release source', () => {
    const definition = updateConfigSettings.find(setting => setting.key === 'update.releasesUrl');
    expect(definition?.default).toBe(DAEMON_REPO_LATEST);
  });
});

describe('the complete native daemon installation', () => {
  test('the five payload descriptors are fixed and include the runtime and its provenance', () => {
    expect(resolveDaemonNativePayloads('linux', 'x64')).toEqual([
      { relativePath: 'goodvibes-daemon-linux-x64', assetName: 'goodvibes-daemon-linux-x64', executable: true },
      { relativePath: 'goodvibes-daemon-linux-x64.bun', assetName: 'goodvibes-daemon-linux-x64.bun', executable: true },
      { relativePath: 'goodvibes-daemon-linux-x64.bun.LICENSE.md', assetName: 'goodvibes-daemon-linux-x64.bun.LICENSE.md', executable: false },
      { relativePath: 'goodvibes-daemon-linux-x64.bun.json', assetName: 'goodvibes-daemon-linux-x64.bun.json', executable: false },
      { relativePath: 'lib/sqlite-vec-linux-x64/vec0.so', assetName: 'sqlite-vec-linux-x64.so', executable: false },
    ]);
  });

  test('a daemon update owns every payload and the installation receipt', () => {
    const { io } = installation();
    const files = resolveDaemonInstalledFiles({ execPath, platform: 'linux', arch: 'x64', io });
    expect(files.map(file => file.path)).toEqual(ownedPaths);
    expect(files.map(file => file.assetName)).toEqual([
      'goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md',
      'goodvibes-daemon-linux-x64.bun.json', 'sqlite-vec-linux-x64.so', 'goodvibes-daemon-linux-x64.ci-artifact.json',
    ]);
    expect(files.map(file => file.executable)).toEqual([true, true, false, false, false, false]);
  });

  test('sibling product executables remain outside the daemon installation', () => {
    const siblings = ['/home/someone/.local/bin/goodvibes', '/home/someone/.local/bin/goodvibes-agent', '/home/someone/.local/bin/goodvibes-webui'];
    const { io } = installation(Object.fromEntries(siblings.map(path => [path, Buffer.from('sibling-product')])));
    const files = resolveDaemonInstalledFiles({ execPath, platform: 'linux', arch: 'x64', io });
    expect(files.map(file => file.path)).toEqual(ownedPaths);
    for (const sibling of siblings) expect(files.map(file => file.path)).not.toContain(sibling);
  });

  for (const missing of ownedPaths) {
    test(`inspection refuses the incomplete installation missing ${missing}`, () => {
      const memory = installation();
      memory.io.remove?.(missing);
      expect(() => inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', memory.io)).toThrow();
      expect(memory.files.has(`${execPath}.previous`)).toBe(false);
    });
  }

  test('an installation with altered runtime bytes is refused by installation admission', () => {
    const memory = installation();
    memory.io.writeFile(`${execPath}.bun`, Buffer.from('different-runtime'));
    expect(() => inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', memory.io)).toThrow();
  });

  test('an executable mode change is refused even when the bytes still match', () => {
    const memory = installation();
    memory.io.chmod(`${execPath}.bun`, 0o644);
    expect(() => inspectDaemonNativeInstallation(execPath, 'linux', 'x64', '', memory.io)).toThrow();
  });

  test('the arm64 installation owns its matching complete cohort', () => {
    const arm = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'arm-daemon', arch: 'arm64' });
    const memory = nativeMemoryIo(arm.installation(execPath));
    const files = resolveDaemonInstalledFiles({ execPath, platform: 'linux', arch: 'arm64', io: memory.io });
    expect(files.map(file => file.path)).toEqual([
      execPath, `${execPath}.bun`, `${execPath}.bun.LICENSE.md`, `${execPath}.bun.json`,
      '/home/someone/.local/bin/lib/sqlite-vec-linux-arm64/vec0.so', '/home/someone/.local/bin/daemon-installation.json',
    ]);
    expect(files.every(file => file.assetName?.includes('linux-arm64'))).toBe(true);
  });

  for (const platform of ['darwin', 'win32'] as const) {
    test(`${platform} has no supported native release cohort`, () => {
      expect(resolveDaemonNativePayloads(platform, 'x64')).toBeNull();
      const { io } = installation();
      const files = resolveDaemonInstalledFiles({ execPath, platform, arch: 'x64', io });
      expect(files.some(file => file.assetName !== null)).toBe(false);
    });
  }
});
