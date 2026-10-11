import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NATIVE_EXECUTION_TARGETS, nativeExecutionMembers, recordNativeExecutionArtifact, verifyNativeExecutionArtifact } from './native-execution-artifact.mjs';

// Inert source admission fixtures. Actual target execution belongs to the
// independent native consumer jobs; these bytes cannot prove native behavior.
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(target) {
  const product = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-execution-owner-')); roots.push(product);
  copyFileSync(new URL('../toolchain.config.json', import.meta.url), join(product, 'toolchain.config.json'));
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', version: '2.0.23' }));
  const source = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), runId: '17', runAttempt: '2', target };
  const members = nativeExecutionMembers(product, target), root = join(product, 'native');
  for (const member of members) {
    const file = join(root, member.path); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `inert ${target} ${member.path}`, { mode: member.mode }); chmodSync(file, member.mode);
  }
  if (target.startsWith('darwin-')) {
    const row = JSON.parse(readFileSync(join(product, 'toolchain.config.json'), 'utf8')).build.targets.find(row => row.key === target);
    const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target === 'darwin-x64' ? 0x01000007 : 0x0100000c, 4); bytes.writeUInt32LE(6, 12);
    writeFileSync(join(root, row.sqliteRuntime.libraryPath), bytes);
    writeFileSync(join(root, row.sqliteRuntime.provenancePath), JSON.stringify({ schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: '2.0.23', target,
      sqliteVersion: row.sqliteRuntime.sqliteVersion, sourceUrl: row.sqliteRuntime.sourceUrl, sourceSha3: row.sqliteRuntime.sourceSha3,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }));
  }
  const artifact = recordNativeExecutionArtifact(product, source);
  return { product, root, source, members, artifact };
}

for (const target of NATIVE_EXECUTION_TARGETS) {
  test(`${target} records/restores only its fixed source-declared companions`, () => {
    const f = fixture(target); const verified = verifyNativeExecutionArtifact(f.product, f.source);
    assert.equal(verified.artifact.target, target); assert.equal(verified.artifact.runAttempt, '2'); verified.retained.assertCurrent();
    assert.equal(f.members.length, target.startsWith('linux-') ? 5 : 4);
    assert.deepEqual(verified.artifact.files.map(file => file.path), f.members.map(file => file.path));
    assert.equal(f.artifact.kind, 'daemon-native-execution');
    assert(!verified.artifact.files.some(file => file.path === 'daemon-installation.json'));
  });
  for (const field of ['sourceCommit', 'sourceTree', 'headCommit', 'runId', 'runAttempt', 'target']) {
    test(`${target} refuses a different ${field} owner`, () => {
      const f = fixture(target);
      const changed = field === 'target' ? NATIVE_EXECUTION_TARGETS.find(value => value !== target) : field.startsWith('run') ? '3' : 'd'.repeat(40);
      assert.throws(() => verifyNativeExecutionArtifact(f.product, { ...f.source, [field]: changed }));
    });
  }
  for (const mutation of ['bytes', 'mode', 'missing', 'manifest-path', 'symlink', 'parent-aba', 'foreign-inode']) {
    test(`${target} refuses retained ${mutation} admission/lifetime`, () => {
      const f = fixture(target); const verified = verifyNativeExecutionArtifact(f.product, f.source);
      const full = join(f.root, f.members.at(-2).path);
      if (mutation === 'bytes') writeFileSync(full, 'foreign bytes');
      if (mutation === 'mode') chmodSync(full, 0o600);
      if (mutation === 'missing') rmSync(full);
      if (mutation === 'manifest-path') {
        const artifact = structuredClone(f.artifact); artifact.files[0].path = '../foreign';
        writeFileSync(join(f.root, 'native-execution-artifact.json'), JSON.stringify(artifact));
      }
      if (mutation === 'symlink') { const foreign = join(f.product, 'foreign'); copyFileSync(full, foreign); rmSync(full); symlinkSync(foreign, full); }
      if (mutation === 'parent-aba') { renameSync(f.root, f.root + '.old'); renameSync(f.root + '.old', f.root); }
      if (mutation === 'foreign-inode') { const bytes = readFileSync(full), mode = f.members.at(-2).mode; writeFileSync(full + '.foreign', bytes, { mode }); renameSync(full + '.foreign', full); }
      assert.throws(() => verified.retained.assertCurrent());
      if (mutation !== 'parent-aba' && mutation !== 'foreign-inode') assert.throws(() => verifyNativeExecutionArtifact(f.product, f.source));
    });
  }
}

test('source target retirement and invalid SQLite supplier refuse instead of reducing coverage', () => {
  for (const change of ['retire', 'supplier']) {
    const f = fixture('darwin-arm64'), path = join(f.product, 'toolchain.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (change === 'retire') config.build.targets.pop(); else config.build.targets.at(-1).sqliteRuntime.sourceSha3 = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(config)); assert.throws(() => verifyNativeExecutionArtifact(f.product, f.source));
  }
});
