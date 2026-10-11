/** Pinned daemon update-check helpers now have one existing engine owner. No update activation. */
import { expect, test } from 'bun:test';
import { detectInstallKind, fallbackUpdateCommand } from '../sdk/src/platform/runtime/install-kind.js';
import { compareVersions, normalizeVersion, parseReleaseTagFromLocation } from '../sdk/src/platform/runtime/self-update.js';

test('daemon install-kind preserves interpreter and exact package-path semantics on both separators', () => {
  for (const path of ['/usr/bin/bun', 'C:\\tools\\BUN.EXE', '/project/node_modules/bin/bun']) expect(detectInstallKind(path)).toBe('source');
  for (const path of ['/project/node_modules/goodvibes-daemon/bin/daemon', 'C:\\project\\node_modules\\goodvibes-daemon\\daemon.exe']) expect(detectInstallKind(path)).toBe('bun-global-package');
  for (const path of ['/usr/local/bin/goodvibes-daemon', '/opt/node_modules-backup/daemon', 'C:\\Tools\\daemon.exe']) expect(detectInstallKind(path)).toBe('binary');
});

test('the canonical explicit-name formatter can represent the original fallback without selecting a release policy', () => {
  // Historical caller argument only: this does not recommend/install a package or select a live release source.
  expect(fallbackUpdateCommand('bun-global-package', 'goodvibes-daemon')).toBe('bun add -g goodvibes-daemon');
  expect(fallbackUpdateCommand('source', 'goodvibes-daemon')).toBe('curl -fsSL https://goodvibes.sh/install.sh | sh');
  expect(fallbackUpdateCommand('bun-global-package', 'synthetic-owner')).toBe('bun add -g synthetic-owner');
});

test('the canonical version and release-tag owners retain the daemon re-exported operations', () => {
  expect(normalizeVersion(' v1.2.3 ')).toBe('1.2.3');
  expect(compareVersions('v1.2', '1.2.0')).toBe(0);
  expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
  expect(compareVersions('1.3.0', '1.2.3')).toBe(1);
  expect(parseReleaseTagFromLocation('https://example.test/releases/tag/v1.2.3')).toBe('v1.2.3');
  expect(parseReleaseTagFromLocation(null)).toBeNull();
});
