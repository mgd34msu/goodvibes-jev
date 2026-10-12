import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDaemonNativePayloads } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { admitNativeReleaseArchive } from '../../../.github/scripts/stage-native-release-assets.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const payloads = resolveDaemonNativePayloads('linux', 'x64');
if (!payloads) throw new Error('Expected the declared Linux fixture cohort');
const members = [...payloads.map(payload => ({ path: payload.relativePath, mode: payload.executable ? 0o755 : 0o644 })),
  { path: 'ci-artifact.json', mode: 0o644 }].map(member => ({ ...member, path: 'products/daemon/native/' + member.path }));

// These are authored archive-boundary samples; no native artifact or CI authority is claimed.
function archive(mutation = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'native-release-admission-'));
  try {
    for (const member of members) {
      const path = join(root, member.path); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'public archive fixture'); chmodSync(path, member.mode);
    }
    const names = members.map(member => member.path);
    if (mutation === 'missing') names.pop();
    if (mutation === 'duplicate') names.push(names[0]);
    if (mutation === 'extra') { writeFileSync(join(root, 'unexpected'), 'public extra'); names.push('unexpected'); }
    if (mutation === 'path') {
      const replacement = 'products/daemon/native/unexpected';
      writeFileSync(join(root, replacement), 'public unexpected'); chmodSync(join(root, replacement), members[0].mode);
      names[0] = replacement;
    }
    if (mutation === 'symlink' || mutation === 'directory') {
      const path = join(root, names[0]); rmSync(path);
      if (mutation === 'symlink') symlinkSync('/unavailable-public-fixture', path); else mkdirSync(path);
    }
    if (mutation === 'mode') chmodSync(join(root, names.at(-1)), 0o755);
    const path = join(root, 'cohort.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', path, ...names], { cwd: root, timeout: 30_000, stdio: 'pipe' });
    const bytes = readFileSync(path);
    if (mutation === 'truncated') return bytes.subarray(0, 30);
    if (mutation === 'header') { const tar = gunzipSync(bytes); tar[148] = 0x37; return gzipSync(tar); }
    if (mutation === 'trailing') return gzipSync(Buffer.concat([gunzipSync(bytes), Buffer.from('public trailing data')]));
    return bytes;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('importing release staging neither starts the CLI nor installs signal handlers', () => {
  const module = pathToFileURL(join(repo, '.github/scripts/stage-native-release-assets.mjs')).href;
  const code = `const before = ['SIGINT','SIGTERM'].map(name => process.listenerCount(name));
await import(${JSON.stringify(module)});
if (before.some((count, index) => count !== process.listenerCount(['SIGINT','SIGTERM'][index]))) process.exit(19);
console.log('release utility imported');`;
  const child = spawnSync(process.execPath, ['-e', code], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(0);
  expect(child.stdout).toBe('release utility imported\n'); expect(child.stderr).toBe('');
});

test('release admission returns only the exact declared regular archive members', () => {
  const entries = admitNativeReleaseArchive(archive(), members);
  expect(entries.map(({ path, mode }) => ({ path, mode }))).toEqual(members);
  expect(entries.every(entry => entry.kind === 'file' && entry.data.toString() === 'public archive fixture')).toBe(true);
});

for (const mutation of ['missing', 'duplicate', 'extra', 'path', 'symlink', 'directory', 'mode', 'truncated', 'header', 'trailing']) {
  test(`release admission refuses ${mutation} before returning extractable entries`, () => {
    const bytes = archive(mutation);
    expect(() => admitNativeReleaseArchive(bytes, members)).toThrow();
  });
}
