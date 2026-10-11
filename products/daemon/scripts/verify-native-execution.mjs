import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { readNativeAddonEvidence, proveNativeMemoryRoundTrip } from './boot-smoke-reading.mjs';
import { syntheticSystemOneAnswers } from './hosted-session-protocol.mjs';
import { nativeExecutionSource, retainNativeExecutionFiles, verifyNativeExecutionArtifact } from './native-execution-artifact.mjs';
import { assertNativeProcessGroupDrained, boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from './native-execution-process.mjs';

// Portable original Darwin boot/vector obligation. Linux keeps the stronger
// namespace + hosted consumer; this script makes no isolation/install claim.
assert(!process.versions.bun, 'Native execution controller must use ordinary Node');
assert.equal(process.platform, 'darwin', 'Portable consumer requires its real Darwin host');
const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [sourceCommit, headCommit, ...extra] = process.argv.slice(2);
assert(sourceCommit && headCommit && extra.length === 0, 'Usage: verify-native-execution.mjs <checkout SHA> <head SHA>');
const source = nativeExecutionSource(product, sourceCommit, headCommit);
const original = verifyNativeExecutionArtifact(product, source);
const root = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-native-execution-'));
const artifacts = join(root, 'artifacts'), work = join(root, 'foreign-work'), home = join(root, 'home');
const tree = join(root, 'tree'), daemon = join(root, 'selected-daemon');
const token = 'synthetic-native-memory-token';
let judgment, judgmentError, host, hostStopped, hostExited = false, hostPid;
const requests = [];
let cleanupRefused = false;
const childEnv = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg'),
  GOODVIBES_HOME: tree, GOODVIBES_DAEMON_HOME: daemon, GOODVIBES_WORKING_DIR: work, NO_COLOR: '1',
  // Existing production opt-out: no wake/provider/model acquisition is part of
  // this memory-vector proof. The shipped memory embedding still runs.
  GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD: '1' };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const wait = ms => new Promise(yes => setTimeout(yes, ms));
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
}

try {
  for (const path of [artifacts, work, home, join(root, 'tmp')]) mkdirSync(path, { recursive: true });
  // Copy the retained bytes, never rebuild and never follow receipt-supplied paths.
  for (const file of original.retained.files) {
    const full = join(artifacts, file.path); mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.bytes, { flag: 'wx', mode: file.mode }); chmodSync(full, file.mode);
  }
  original.retained.assertCurrent();
  const relocated = retainNativeExecutionFiles(artifacts, [...original.members, { path: 'native-execution-artifact.json', mode: 0o644 }]);
  assert.deepEqual(relocated.files.map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })),
    original.retained.files.map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })), 'Relocation changed the retained execution cohort');
  const binary = join(artifacts, original.members[0].path), version = original.artifact.version;
  assert.equal(basename(binary), original.members[0].path);
  writeJson(join(work, 'package.json'), { name: '@fixture/foreign-package', version: '99.8.7', type: 'module' });
  async function run(argv) {
    original.retained.assertCurrent(); relocated.assertCurrent();
    const child = spawn(binary, argv, { cwd: work, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const capture = key => chunk => {
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 1_048_576) { expired = true; signalNativeProcessGroup(child); }
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    const stopped = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
    const timer = setTimeout(() => { expired = true; signalNativeProcessGroup(child); }, 20_000);
    try {
      const result = await boundedNativeProcessClose(stopped, 20_000, 'Native command close deadline'); assert(!expired, 'Portable native command exceeded its deadline/output bound');
      assert.equal(result.signal, null, stderr);
      assertNativeProcessGroupDrained(child);
      original.retained.assertCurrent(); relocated.assertCurrent();
      return { ...result, stdout, stderr };
    } finally {
      clearTimeout(timer);
      try { await drainNativeProcessGroup(child, stopped); }
      catch (error) { cleanupRefused = true; throw error; }
      finally { child.stdout.destroy(); child.stderr.destroy(); }
    }
  }
  assert.deepEqual(await run(['--version']), { code: 0, signal: null, stdout: `goodvibes-daemon ${version}\n`, stderr: '' });
  const help = await run(['--help']); assert.equal(help.code, 0); assert(help.stdout.includes('Usage: goodvibes-daemon')); assert.equal(help.stderr, '');
  const malformedHome = join(root, 'malformed-daemon'); mkdirSync(malformedHome);
  const malformedPath = join(malformedHome, 'settings.json'), malformedBytes = '{ "token": "synthetic-private-malformed-value"';
  writeFileSync(malformedPath, malformedBytes);
  const malformed = await run(['--daemon-home', malformedHome, 'serve']);
  assert.equal(malformed.code, 1, 'Malformed selected settings must refuse real startup');
  assert(malformed.stderr.includes(malformedPath)); assert(malformed.stderr.includes('could not be read as JSON'));
  assert(!malformed.stdout.includes(' bound:')); assert(!malformed.stdout.includes('host started'));
  assert(!(malformed.stdout + malformed.stderr).includes('synthetic-private-malformed-value')); assert.equal(readFileSync(malformedPath, 'utf8'), malformedBytes);

  judgment = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/systemone'); assert.equal(request.method, 'POST');
      let text = ''; for await (const chunk of request) { text += chunk; assert(text.length < 1_048_576); }
      const body = JSON.parse(text); assert.equal(body.model, 'jev-1.13.0'); assert(requests.length < 5_000, 'Unexpected native boot judgment loop'); requests.push(body);
      const answers = syntheticSystemOneAnswers(body.questions);
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === 'noul') answers[name] = { type: 'noul', noul: name === 'native_addon_failure' ? 0.01 : 0.99 };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    })().catch(error => { judgmentError = error; response.writeHead(500); response.end('Synthetic native reading failed'); });
  });
  await new Promise((yes, no) => { judgment.once('error', no); judgment.listen(0, '127.0.0.1', yes); });
  const judgmentEnv = { TYPESAFE_BASE_URL: `http://127.0.0.1:${judgment.address().port}`, TYPESAFE_API_KEY: 'synthetic-native-reading-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' };
  const readingPort = createSystemOnePort(judgmentConfigFromEnv(judgmentEnv));
  mkdirSync(daemon); writeJson(join(daemon, 'settings.json'), { cluster: { enabled: false }, relay: { enabled: false } });
  const lease = createServer(); await new Promise((yes, no) => { lease.once('error', no); lease.listen(0, '127.0.0.1', yes); });
  const port = lease.address().port; await closeServer(lease);
  original.retained.assertCurrent(); relocated.assertCurrent();
  host = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: work, env: { ...childEnv, ...judgmentEnv, GOODVIBES_DAEMON_TOKEN: token }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostPid = host.pid; let output = '', errors = '';
  host.stdout.on('data', chunk => { output += chunk; if (output.length + errors.length > 1_048_576) signalNativeProcessGroup(host); });
  host.stderr.on('data', chunk => { errors += chunk; if (output.length + errors.length > 1_048_576) signalNativeProcessGroup(host); });
  hostStopped = new Promise((yes, no) => {
    host.once('error', no); host.once('close', (code, signal) => { hostExited = true; yes({ code, signal }); });
  }); void hostStopped.catch(() => {});
  const started = Date.now();
  while (!output.includes('host started')) {
    assert(!hostExited, `Native host exited before readiness: ${output} ${errors}`); assert.ifError(judgmentError);
    assert(Date.now() - started < 20_000, `Native host startup deadline: ${output} ${errors}`); await wait(25);
  }
  assert(Number.isSafeInteger(hostPid) && hostPid > 0, 'Retain the actual spawned daemon PID');
  const lines = output.trim().split('\n');
  assert(lines[0].startsWith(`goodvibes-daemon ${version} starting:`));
  assert(lines[0].includes(`intended-host="127.0.0.1" intended-port=${port}`));
  const bound = `goodvibes-daemon ${version} bound: host="127.0.0.1" port=${port}`;
  assert(lines.includes(bound)); assert(output.indexOf(bound) < output.indexOf('host started'));
  const headers = { Authorization: `Bearer ${token}` };
  const status = await fetch(`http://127.0.0.1:${port}/status`, { headers, signal: AbortSignal.timeout(5_000) });
  assert.equal(status.status, 200); assert.equal((await status.json()).status, 'running');
  const invoke = async (method, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/control-plane/methods/${method}/invoke`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }), signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text(); assert.ifError(judgmentError);
    assert.equal(response.status, method === 'memory.records.add' ? 201 : 200, `${method}: ${text}`); return JSON.parse(text);
  };
  // Same production controls as Linux: structured extension/index availability
  // and finite distance for the exact added record, with no initialization retry.
  const { added, searched, vector } = await proveNativeMemoryRoundTrip(invoke);
  const diagnostic = await readNativeAddonEvidence(readingPort, { added, searched, stderr: errors }, AbortSignal.timeout(10_000));
  assert.ifError(judgmentError); assert(requests.some(request => 'native_addon_failure' in request.questions));
  assert(!hostExited, 'Native host exited before owned shutdown'); original.retained.assertCurrent(); relocated.assertCurrent();
  host.kill('SIGTERM');
  let timer;
  try {
    assert.deepEqual(await Promise.race([hostStopped, new Promise((_, no) => { timer = setTimeout(() => no(new Error('Native shutdown deadline')), 15_000); })]), { code: 0, signal: null });
  } finally { clearTimeout(timer); }
  assertNativeProcessGroupDrained(host);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/status`, { headers, signal: AbortSignal.timeout(1_000) }), 'Listener remains after clean shutdown');
  original.retained.assertCurrent(); relocated.assertCurrent();
  console.log(JSON.stringify({ proof: 'compiled-daemon-native-execution', target: source.target, sourceCommit, headCommit,
    runId: source.runId, runAttempt: source.runAttempt, semanticQualification: 'synthetic-only', modelAcquisition: 'disabled',
    status: 'running', malformedSettingsExit: malformed.code, nativeVectorAvailable: vector.vector.available, cleanShutdown: true, diagnostic }));
} finally {
  try {
    try { if (host && hostStopped) await drainNativeProcessGroup(host, hostStopped); }
    finally { host?.stdout.destroy(); host?.stderr.destroy(); }
  } finally { await closeServer(judgment); }
  if (!cleanupRefused) rmSync(root, { recursive: true, force: true });
}
