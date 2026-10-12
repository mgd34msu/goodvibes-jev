import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGzEntries } from '../../packages/engine/sdk/dist/platform/browser/index.js';
import { assertDaemonNativePayloadBytes, parseDaemonCiArtifact, resolveDaemonNativePayloads, resolveSqliteVecAsset } from '../../packages/engine/sdk/dist/platform/runtime/self-update.js';
import { verifyAgentCiArtifact } from '../../products/agent/scripts/ci-artifact.ts';
import { resolveSqliteVecArchive } from '../../products/agent/src/runtime/release-artifacts.ts';
import { readVerifiedDaemonCiArtifact } from '../../products/daemon/scripts/ci-artifact.ts';
import { nativeExecutionMembers, retainNativeExecutionFiles, verifyNativeExecutionArtifact } from '../../products/daemon/scripts/native-execution-artifact.mjs';
import { boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from '../../products/daemon/scripts/native-execution-process.mjs';
import { verifyTuiCiArtifact } from '../../products/tui/scripts/ci-artifact.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stop = new AbortController();
const cancel = () => stop.abort(new Error('Native release staging cancelled'));
let phase = 'argument admission';

/**
 * @param {Uint8Array} bytes
 * @param {readonly { path: string, mode: number }[]} members
 */
export function admitNativeReleaseArchive(bytes, members) {
  assert(bytes.length <= 256 * 1024 * 1024, 'Native archive exceeds the compressed size limit');
  const entries = [...readTarGzEntries(bytes, { strict: true, maxOutputLength: 512 * 1024 * 1024 })];
  assert.equal(entries.length, members.length, 'Native archive must contain exactly its declared cohort');
  assert.equal(new Set(entries.map(entry => entry.path)).size, members.length, 'Native archive has duplicate members');
  for (const entry of entries) {
    const member = members.find(member => member.path === entry.path);
    assert(member && entry.kind === 'file' && entry.mode === member.mode, 'Unexpected native archive path, type or mode');
  }
  return entries;
}

async function archiveCommand(args, cwd) {
  stop.signal.throwIfAborted();
  const child = spawn('tar', args, { cwd, detached: true, stdio: 'ignore' });
  const closed = new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', (code, signal) => code === 0 && signal === null ? yes() : no(new Error('Native archive command failed')));
  });
  const cancelChild = () => signalNativeProcessGroup(child, 'SIGTERM');
  stop.signal.addEventListener('abort', cancelChild, { once: true });
  let failure;
  try {
    if (stop.signal.aborted) cancelChild();
    await boundedNativeProcessClose(closed, 30_000, 'Native archive command exceeded its deadline');
    stop.signal.throwIfAborted();
  }
  catch (error) { failure = error; }
  finally {
    stop.signal.removeEventListener('abort', cancelChild);
    try { await drainNativeProcessGroup(child, closed); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Native archive drain failed') : error; }
  }
  if (failure) throw failure;
}

async function main() {
  const [sourceCommit, runId, downloads, destination, ...extra] = process.argv.slice(2);
  assert(!extra.length && sourceCommit && runId && downloads && destination, 'Expected verified source, CI run and owned input/output directories');
  assert.match(runId, /^[1-9][0-9]*$/, 'Expected a verified CI run');
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000 }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Release checkout must match the admitted producer');
  git('diff', '--exit-code', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  const inputRoot = mkdtempSync(join(tmpdir(), 'goodvibes-native-release-'));
  let ownsOutput = false;
  const retained = [];
  const assertCurrent = () => {
    stop.signal.throwIfAborted();
    assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Release checkout changed');
    git('diff', '--exit-code', 'HEAD');
    for (const owner of retained) owner.assertCurrent();
  };
  const put = (name, bytes, mode) => {
    assert.equal(basename(name), name, 'A release asset must have one filename');
    assertCurrent();
    const path = join(destination, name);
    if (existsSync(path)) {
      assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Asset collision is not a regular file');
      assert.equal(lstatSync(path).mode & 0o777, mode, 'Shared native asset modes differ');
      assert(readFileSync(path).equals(bytes), 'Shared native asset bytes differ');
    } else writeFileSync(path, bytes, { flag: 'wx', mode });
    assertCurrent();
  };
  const restore = (name, members) => {
    const directory = join(downloads, name);
    const archiveName = name + '.tgz';
    const archive = retainNativeExecutionFiles(directory, [{ path: archiveName, mode: 0o644 }]);
    retained.push(archive); assertCurrent();
    const bytes = archive.files[0].bytes;
    const entries = admitNativeReleaseArchive(bytes, members);
    assertCurrent();
    const root = join(inputRoot, name); mkdirSync(root);
    for (const entry of entries) {
      assertCurrent();
      const path = join(root, entry.path); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.data, { flag: 'wx', mode: entry.mode }); chmodSync(path, entry.mode);
    }
    assertCurrent(); return { root, archive: archive.files[0] };
  };
  try {
    mkdirSync(destination, { mode: 0o755 }); ownsOutput = true;
    phase = 'Agent native admission';
    const agent = join(repo, 'products/agent');
    verifyAgentCiArtifact(agent, sourceCommit);
    const agentManifest = JSON.parse(readFileSync(join(agent, 'dist/ci-artifact.json'), 'utf8'));
    const agentOwner = retainNativeExecutionFiles(join(agent, 'dist'), [...agentManifest.files, { path: 'ci-artifact.json', mode: 0o644 }]);
    retained.push(agentOwner); verifyAgentCiArtifact(agent, sourceCommit); assertCurrent();
    for (const file of agentOwner.files) {
      if (file.path.startsWith('lib/')) continue;
      put(file.path === 'ci-artifact.json' ? 'goodvibes-agent-linux-x64.ci-artifact.json' : file.path, file.bytes, file.mode);
    }
    const addon = resolveSqliteVecArchive('linux', 'x64'); assert(addon, 'Agent native addon is unsupported');
    const agentAddon = agentOwner.files.find(file => file.path === addon.entryPath); assert(agentAddon, 'Agent native addon is absent');
    const addonRoot = join(inputRoot, 'agent-addon'); mkdirSync(join(addonRoot, dirname(addon.entryPath)), { recursive: true });
    writeFileSync(join(addonRoot, addon.entryPath), agentAddon.bytes, { flag: 'wx', mode: agentAddon.mode });
    assertCurrent(); await archiveCommand(['--format=ustar', '-czf', join(destination, addon.assetName), addon.entryPath], addonRoot); assertCurrent();

    phase = 'TUI native admission';
    const tuiBinary = 'goodvibes-linux-x64';
    const tuiRestored = restore('tui-native-linux-x64', [
      { path: tuiBinary, mode: 0o755 }, { path: tuiBinary + '.bun', mode: 0o755 },
      { path: tuiBinary + '.bun.LICENSE.md', mode: 0o644 }, { path: tuiBinary + '.bun.json', mode: 0o644 },
      { path: addon.entryPath, mode: 0o644 }, { path: 'ci-artifact.json', mode: 0o644 },
    ].map(member => ({ ...member, path: 'products/tui/dist/' + member.path })));
    const tui = join(tuiRestored.root, 'products/tui');
    const tuiSource = { sourceCommit, sourceTree, headCommit: sourceCommit };
    await verifyTuiCiArtifact(tui, tuiSource);
    const tuiManifest = JSON.parse(readFileSync(join(tui, 'dist/ci-artifact.json'), 'utf8'));
    const tuiOwner = retainNativeExecutionFiles(join(tui, 'dist'), [...tuiManifest.files, { path: 'ci-artifact.json', mode: 0o644 }]);
    retained.push(tuiOwner); await verifyTuiCiArtifact(tui, tuiSource); assertCurrent();
    const tuiAddon = resolveSqliteVecAsset('linux', 'x64'); assert(tuiAddon, 'TUI native addon is unsupported');
    for (const file of tuiOwner.files) put(file.path === 'ci-artifact.json' ? 'goodvibes-linux-x64.ci-artifact.json' : file.path.startsWith('lib/') ? tuiAddon.assetName : file.path, file.bytes, file.mode);
    assert(tuiOwner.files.find(file => file.path === addon.entryPath).bytes.equals(agentAddon.bytes), 'Product native addon suppliers differ');

    for (const target of ['linux-x64', 'linux-arm64']) {
      phase = 'Daemon Linux native admission';
      const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length)); assert(payloads, 'Daemon native target is unsupported');
      const restored = restore('daemon-native-' + target, [
        ...payloads.map(payload => ({ path: payload.relativePath, mode: payload.executable ? 0o755 : 0o644 })),
        { path: 'ci-artifact.json', mode: 0o644 },
      ].map(member => ({ ...member, path: 'products/daemon/native/' + member.path })));
      const daemon = join(restored.root, 'products/daemon');
      const source = { sourceCommit, sourceTree, headCommit: sourceCommit, target };
      const artifact = parseDaemonCiArtifact(await readVerifiedDaemonCiArtifact(daemon, source), target);
      const native = join(daemon, 'native');
      const owner = retainNativeExecutionFiles(native, [...artifact.files, { path: 'ci-artifact.json', mode: 0o644 }]);
      retained.push(owner); await readVerifiedDaemonCiArtifact(daemon, source);
      assertDaemonNativePayloadBytes(artifact, owner.files.slice(0, -1).map(file => file.bytes)); assertCurrent();
      for (const payload of payloads) {
        const file = owner.files.find(file => file.path === payload.relativePath); assert(file, 'Daemon native companion is absent');
        put(payload.assetName, file.bytes, file.mode);
      }
      put(payloads[0].assetName + '.ci-artifact.json', owner.files.at(-1).bytes, 0o644);
      put('daemon-native-' + target + '.tgz', restored.archive.bytes, 0o644);
    }
    for (const target of ['darwin-x64', 'darwin-arm64']) {
      phase = 'Daemon Darwin native admission';
      const members = nativeExecutionMembers(join(repo, 'products/daemon'), target);
      const restored = restore('daemon-native-' + target, [...members, { path: 'native-execution-artifact.json', mode: 0o644 }]
        .map(member => ({ ...member, path: 'products/daemon/native/' + member.path })));
      const daemon = join(restored.root, 'products/daemon');
      for (const name of ['package.json', 'toolchain.config.json']) writeFileSync(join(daemon, name), readFileSync(join(repo, 'products/daemon', name)), { flag: 'wx', mode: 0o644 });
      const artifact = JSON.parse(readFileSync(join(daemon, 'native/native-execution-artifact.json'), 'utf8'));
      const verified = verifyNativeExecutionArtifact(daemon, { sourceCommit, sourceTree, headCommit: sourceCommit, target, runId, runAttempt: artifact.runAttempt });
      retained.push(verified.retained); assertCurrent();
      put('daemon-native-' + target + '.tgz', restored.archive.bytes, 0o644);
    }
    assertCurrent(); phase = 'complete';
  } catch (error) {
    if (ownsOutput) rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { rmSync(inputRoot, { recursive: true, force: true }); }
}

if (import.meta.main) {
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await main(); console.log('Native release assets staged.'); }
  catch { console.error('Native release asset staging failed at ' + phase + '.'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
