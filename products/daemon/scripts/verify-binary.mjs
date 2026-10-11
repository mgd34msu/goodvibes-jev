import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { readNativeAddonEvidence, proveNativeMemoryRoundTrip } from './boot-smoke-reading.mjs';
import { syntheticSystemOneAnswers } from './hosted-session-protocol.mjs';
import { runHostedSessionProof } from './hosted-session-proof.mjs';
import { runPostBuildSmoke } from '@goodvibes-jev/engine/toolchain';

// Explicit local Linux artifact proof. This consumes the production binary;
// it never builds a fixture launcher or supplies an inbox composition module.
assert(!process.versions.bun, 'Run verify:binary with ordinary Node, not Bun.');
assert.equal(process.platform, 'linux', 'Isolated native verification currently requires Linux and bubblewrap.');
const verificationStartedAt = Date.now();
const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(product, 'toolchain.config.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(product, 'package.json'), 'utf8'));
const target = config.build.targets.find(row => row.key === `${process.platform}-${process.arch}`);
assert(target, 'No native target is configured for this host.');
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--binary'), 'Usage: verify-binary.mjs [--binary <host artifact>]');
const original = resolve(product, args[1] ?? join(config.build.outDir, target.appArtifact));
assert.equal(basename(original), target.appArtifact, 'Verify the configured host artifact.');
const root = mkdtempSync(join(tmpdir(), 'goodvibes-daemon-native-'));
const artifacts = join(root, 'artifacts');
const work = join(root, 'foreign-work');
const home = join(root, 'home');
const tree = join(root, 'tree');
const daemon = join(root, 'selected-daemon');
const binary = join(artifacts, target.appArtifact);
let server; let smokeJudgment;
async function payloadDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

try {
  for (const directory of [artifacts, work, home, join(root, 'tmp')]) mkdirSync(directory, { recursive: true });
  for (const suffix of ['', '.bun', '.bun.json', '.bun.LICENSE.md']) {
    const source = `${original}${suffix}`;
    assert(statSync(source).isFile(), `Missing required artifact: ${source}`);
    copyFileSync(source, `${binary}${suffix}`);
  }
  const addon = join('lib', target.nativeAddonPackage, target.nativeAddonFile);
  mkdirSync(dirname(join(artifacts, addon)), { recursive: true });
  copyFileSync(join(dirname(original), addon), join(artifacts, addon));
  // CI has already verified ci-artifact.json against the exact checkout/head.
  // Bind this behavioral receipt to all unchanged relocated payload bytes too.
  const payloadPaths = [target.appArtifact, ...['.bun', '.bun.json', '.bun.LICENSE.md'].map(suffix => target.appArtifact + suffix), addon];
  const payloads = await Promise.all(payloadPaths.map(async path => ({ path, sha256: await payloadDigest(join(artifacts, path)) })));
  for (const payload of payloads) assert.equal(await payloadDigest(join(dirname(original), payload.path)), payload.sha256, `Relocation changed ${payload.path}`);
  writeJson(join(work, 'package.json'), { name: '@fixture/foreign-package', version: '99.8.7', type: 'module' });
  // Only OS libraries and this owned fixture are mounted. The checkout and
  // its source/node_modules do not exist in the child filesystem namespace.
  const boundary = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--bind', root, root, '--chdir', work, '--'];
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg'),
    GOODVIBES_HOME: tree, GOODVIBES_DAEMON_HOME: daemon, GOODVIBES_WORKING_DIR: work, NO_COLOR: '1' };
  const probe = spawnSync('bwrap', [...boundary, '/usr/bin/test', '!', '-e', product], { env, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(probe.error); assert.equal(probe.status, 0, `Filesystem containment unavailable: ${probe.stderr}`);
  const smoke = runPostBuildSmoke({ binary, config: config.smoke, exec: (file, argv) => {
    const result = spawnSync('bwrap', [...boundary, file, ...argv], { env, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    assert.ifError(result.error);
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  } });
  assert(smoke.ok, smoke.detail);

  async function run(argv, input = '') {
    const child = spawn('bwrap', [...boundary, binary, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let expired = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 20_000);
    try {
      const done = new Promise((yes, no) => { child.once('error', no); child.once('close', (code, signal) => yes({ code, signal })); });
      child.stdin.end(input);
      const exit = await done;
      assert(!expired, `Native command timed out: ${argv.join(' ')}`);
      assert.equal(exit.signal, null, stderr);
      return { code: exit.code, stdout, stderr };
    } finally { clearTimeout(timeout); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  }
  const version = await run(['--version']);
  assert.deepEqual(version, { code: 0, stdout: `goodvibes-daemon ${manifest.version}\n`, stderr: '' });
  for (const [argv, text] of [[['--help'], 'Usage: goodvibes-daemon'], [['help', 'sessions'], 'Usage: goodvibes-daemon sessions list|kill <id>']]) {
    const result = await run(argv); assert.equal(result.code, 0, result.stderr); assert(result.stdout.includes(text)); assert.equal(result.stderr, '');
  }
  for (const [argv, text] of [
    [['install-servce'], 'Unknown command: install-servce'], [['--resume'], '--resume'],
    [['help', 'doctor'], 'Unknown command: doctor'],
    [['--daemon-home', 'elsewhere', 'send', 'hello'], '`send` has to be the first argument'],
  ]) {
    const result = await run(argv); assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert(result.stderr.includes(text));
  }
  for (const argv of [['install-service'], ['start-service'], ['restart-service'], ['migrate-service', '-y']]) {
    const result = await run(argv); assert.equal(result.code, 2); assert.match(result.stderr, /composition|not been migrated/);
  }
  for (const path of [daemon, tree, join(home, '.goodvibes'), join(home, '.config'), join(root, 'xdg'), join(work, 'elsewhere')]) {
    assert(!existsSync(path), `Read-only/refused command created ${path}`);
  }
  const selected = join(work, 'custom-daemon');
  const written = await run(['--daemon-home', 'custom-daemon', 'config', 'set', 'controlPlane.port', '43129']);
  assert.equal(written.code, 0, written.stderr);
  assert(readFileSync(join(selected, 'settings.json'), 'utf8').includes('43129'));
  const read = await run(['--daemon-home', 'custom-daemon', 'config', 'get', 'controlPlane.port', '--json']);
  assert.equal(read.code, 0, read.stderr); assert(read.stdout.includes('43129')); assert(!existsSync(daemon));

  // Original boot-smoke obligation: the actual compiled entrypoint must fail
  // nonzero and name malformed selected settings, without echoing their bytes.
  const malformedHome = join(root, 'malformed-daemon');
  mkdirSync(malformedHome, { recursive: true });
  const malformedPath = join(malformedHome, 'settings.json');
  const malformedSettings = '{ "token": "synthetic-private-malformed-value"';
  writeFileSync(malformedPath, malformedSettings);
  // Match real serve syntax: port 0 is deliberately invalid at the CLI boundary.
  const malformed = await run(['--daemon-home', malformedHome, 'serve']);
  assert.equal(malformed.code, 1, `Malformed-settings startup must reach the configuration reader: ${malformed.stderr}`);
  assert(malformed.stderr.includes(malformedPath));
  assert(malformed.stderr.includes('could not be read as JSON'));
  assert(!malformed.stdout.includes(' bound:')); assert(!malformed.stdout.includes('host started'));
  assert(!(malformed.stdout + malformed.stderr).includes('synthetic-private-malformed-value'));
  assert.equal(readFileSync(malformedPath, 'utf8'), malformedSettings);

  const calls = [];
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({ path: request.url, method: request.method, body, title: request.headers.title, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"id":"synthetic-private-provider-id"}');
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = server.address().port;
  mkdirSync(daemon, { recursive: true }); mkdirSync(join(tree, '.goodvibes/daemon'), { recursive: true });
  writeJson(join(daemon, 'settings.json'), {
    controlPlane: { gateway: true, enabled: true, host: '127.0.0.1', port },
    integrations: { routeBinding: true, deliveryTracking: true }, service: { enabled: true }, storage: { secretPolicy: 'plaintext_allowed' },
    surfaces: { ntfy: { enabled: true, topic: 'synthetic-owned-topic', baseUrl: `http://127.0.0.1:${port}`,
      token: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_NTFY_TOKEN' } },
  });
  writeJson(join(daemon, 'secrets.json'), { GOODVIBES_SURFACES_NTFY_TOKEN: 'synthetic-owned-token' });
  writeJson(join(tree, '.goodvibes/daemon/settings.json'), { surfaces: { ntfy: { enabled: false, topic: 'synthetic-wrong-topic' } } });
  const settings = readFileSync(join(daemon, 'settings.json'), 'utf8');
  const secrets = readFileSync(join(daemon, 'secrets.json'), 'utf8');
  for (const [argv, input] of [
    [['send', 'synthetic argument', 'message', '--title', 'Argument title'], ''],
    [['send', '--channel', 'ntfy', '--to', 'synthetic-override-topic', '--title=Stdin title'], 'synthetic first line\nsecond line\n'],
  ]) {
    const result = await run(argv, input); assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert(result.stdout.includes('send request accepted')); assert(!result.stdout.includes('synthetic-'));
  }
  assert.deepEqual(calls, [
    { path: '/synthetic-owned-topic', method: 'POST', body: 'synthetic argument message', title: 'Argument title', authorization: 'Bearer synthetic-owned-token' },
    { path: '/synthetic-override-topic', method: 'POST', body: 'synthetic first line\nsecond line', title: 'Stdin title', authorization: 'Bearer synthetic-owned-token' },
  ]);
  assert.equal(readFileSync(join(daemon, 'settings.json'), 'utf8'), settings);
  assert.equal(readFileSync(join(daemon, 'secrets.json'), 'utf8'), secrets);
  assert(!readdirSync(root, { recursive: true }).map(String).join('\n').match(/operator-tokens|daemon-lifecycle|daemon-receipts|detached-daemon/));
  assert(!existsSync(join(home, '.goodvibes')));
  // The real installed entrypoint now admits genuinely unconfigured inbox
  // providers. A separate selected home prevents the send fixture's settings
  // or identity from leaking into this host proof.
  // Recorded protocol transport for compiled memory reranking and diagnostic
  // reading. This is deliberately identified as synthetic, never live Jev.
  const smokeJudgmentRequests = []; let smokeJudgmentError;
  smokeJudgment = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/systemone');
      let text = ''; for await (const chunk of request) { text += chunk; assert(text.length < 1_048_576); }
      const body = JSON.parse(text); assert.equal(body.model, 'jev-1.13.0');
      // Production startup classifies its model catalog before memory reranking.
      // Match the existing hosted proof's finite synthetic transport budget.
      assert(smokeJudgmentRequests.length < 5_000, 'Unexpected boot SystemOne request loop'); smokeJudgmentRequests.push(body);
      const answers = syntheticSystemOneAnswers(body.questions);
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === 'noul') answers[name] = { type: 'noul', noul: name === 'native_addon_failure' ? 0.01 : 0.99 };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    })().catch(error => { smokeJudgmentError = error; response.writeHead(500); response.end('Synthetic boot reading failed'); });
  });
  await new Promise((yes, no) => { smokeJudgment.once('error', no); smokeJudgment.listen(0, '127.0.0.1', yes); });
  const smokeJudgmentEnv = { TYPESAFE_BASE_URL: `http://127.0.0.1:${smokeJudgment.address().port}`, TYPESAFE_API_KEY: 'synthetic-boot-reading-key', TYPESAFE_DEFAULT_MODEL: 'jev-1.13.0' };
  const smokePort = createSystemOnePort(judgmentConfigFromEnv(smokeJudgmentEnv));
  const serveRoot = join(root, 'serving'); const serveHome = join(serveRoot, 'home');
  const serveTree = join(serveRoot, 'tree'); const serveDaemon = join(serveRoot, 'daemon');
  const serveWork = join(serveRoot, 'work');
  for (const directory of [serveHome, serveDaemon, serveWork]) mkdirSync(directory, { recursive: true });
  writeJson(join(serveDaemon, 'settings.json'), { cluster: { enabled: false }, relay: { enabled: false } });
  const lease = createServer();
  await new Promise((yes, no) => { lease.once('error', no); lease.listen(0, '127.0.0.1', yes); });
  const servePort = lease.address().port;
  await new Promise((yes, no) => lease.close(error => error ? no(error) : yes()));
  // Run the owned daemon as namespace PID 1 and ask bubblewrap for its
  // outer PID. Signalling the supervisor kills the namespace rather than
  // exercising the daemon's shutdown handler.
  const host = spawn('bwrap', [...boundary.slice(0, -1), '--as-pid-1', '--json-status-fd', '3', '--', binary, 'serve', '--hostname', '127.0.0.1', '--port', String(servePort)], {
    env: { ...env, ...smokeJudgmentEnv, HOME: serveHome, GOODVIBES_HOME: serveTree, GOODVIBES_DAEMON_HOME: serveDaemon,
      GOODVIBES_WORKING_DIR: serveWork, GOODVIBES_DAEMON_TOKEN: 'synthetic-native-inbox-token' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let childPid; let statusBuffer = '';
  host.stdio[3].on('data', chunk => {
    statusBuffer += chunk;
    let end;
    while ((end = statusBuffer.indexOf('\n')) !== -1) {
      const status = JSON.parse(statusBuffer.slice(0, end));
      statusBuffer = statusBuffer.slice(end + 1);
      if (Number.isSafeInteger(status['child-pid']) && status['child-pid'] > 0) childPid = status['child-pid'];
    }
  });
  let output = ''; let errors = ''; let exited = false;
  host.stdout.on('data', chunk => { output += chunk; }); host.stderr.on('data', chunk => { errors += chunk; });
  const stopped = new Promise((yes, no) => {
    host.once('error', no); host.once('close', (code, signal) => { exited = true; yes({ code, signal }); });
  });
  void stopped.catch(() => {});
  let timer;
  try {
    const started = Date.now();
    while (!output.includes('host started') || childPid === undefined) {
      assert(!exited, `Native host exited before readiness: ${output} ${errors}`);
      assert(Date.now() - started < 20_000, `Native host startup deadline: ${output} ${errors}`);
      await new Promise(yes => setTimeout(yes, 25));
    }
    assert.notEqual(manifest.version, '0.0.0');
    const startupLines = output.trim().split('\n');
    assert(startupLines[0].startsWith(`goodvibes-daemon ${manifest.version} starting:`));
    assert(startupLines[0].includes(`intended-host="127.0.0.1" intended-port=${servePort}`), startupLines[0]);
    const boundLine = `goodvibes-daemon ${manifest.version} bound: host="127.0.0.1" port=${servePort}`;
    assert(startupLines.includes(boundLine));
    assert(output.indexOf(boundLine) < output.indexOf('host started'));
    assert(!errors.includes('derived-bind-mismatch'));
    const statusResponse = await fetch(`http://127.0.0.1:${servePort}/status`, {
      headers: { Authorization: 'Bearer synthetic-native-inbox-token' }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(statusResponse.status, 200); assert.equal((await statusResponse.json()).status, 'running');
    async function smokeInvoke(method, body = {}) {
      console.log(`[boot-smoke] invoking ${method}`);
      const response = await fetch(`http://127.0.0.1:${servePort}/api/control-plane/methods/${method}/invoke`, {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-native-inbox-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }), signal: AbortSignal.timeout(10_000),
      }).catch(error => { assert.ifError(smokeJudgmentError); throw new Error(`Compiled boot request failed: ${method}`, { cause: error }); });
      const text = await response.text(); assert.equal(response.status, method === 'memory.records.add' ? 201 : 200, `${method}: ${text}`);
      return JSON.parse(text);
    }
    // Readiness now waits for canonical MemoryStore.init; no retry can hide a
    // native extension failure. Check structured native availability as well as
    // the original add/search exercise, so lexical fallback cannot pass as vec0.
    const { added, searched, vector } = await proveNativeMemoryRoundTrip(smokeInvoke);
    console.log('[boot-smoke] reading compiled addon diagnostics');
    const diagnostic = await readNativeAddonEvidence(smokePort, { added, searched, stderr: errors }, AbortSignal.timeout(10_000));
    assert.ifError(smokeJudgmentError);
    assert(smokeJudgmentRequests.some(request => 'native_addon_failure' in request.questions));
    console.log(JSON.stringify({ proof: 'compiled-daemon-boot-smoke', semanticQualification: 'synthetic-only', status: 'running', malformedSettingsExit: malformed.code,
      binding: { host: '127.0.0.1', port: servePort }, nativeVectorAvailable: vector.vector.available, diagnostic }));
    const response = await fetch(`http://127.0.0.1:${servePort}/api/channels/inbox`, {
      headers: { Authorization: 'Bearer synthetic-native-inbox-token' }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200); const receipt = await response.json();
    assert.deepEqual(receipt.providers ?? receipt.data?.providers, ['slack', 'discord', 'email'].map(provider => ({
      provider, state: 'unconfigured', configured: false, syncing: false, itemCount: 0, storedCount: 0,
    })));
    assert(!exited, 'Native host exited before shutdown');
    assert.equal(readlinkSync(`/proc/${childPid}/exe`), binary, 'Signal only the verified owned native executable');
    process.kill(childPid, 'SIGTERM');
    assert.deepEqual(await Promise.race([stopped, new Promise((_, no) => {
      timer = setTimeout(() => no(new Error('Native host shutdown deadline')), 15_000);
    })]), { code: 0, signal: null });
    await assert.rejects(fetch(`http://127.0.0.1:${servePort}/api/channels/inbox`, {
      headers: { Authorization: 'Bearer synthetic-native-inbox-token' }, signal: AbortSignal.timeout(1_000),
    }), 'Daemon listener must be closed after clean shutdown');
  } finally {
    clearTimeout(timer); if (!exited) host.kill('SIGKILL');
    await stopped; host.stdout.destroy(); host.stderr.destroy(); host.stdio[3].destroy();
  }
  const hosted = await runHostedSessionProof({ binary, boundary, env, root });
  for (const payload of payloads) assert.equal(await payloadDigest(join(artifacts, payload.path)), payload.sha256, `Execution changed ${payload.path}`);
  console.log(JSON.stringify({ proof: 'compiled-daemon-hosted-session', verificationElapsedMs: Date.now() - verificationStartedAt, payloads, ...hosted }));
  console.log(`Native daemon ${manifest.version}: relocated shared smoke, exact identity, help, service refusal, config, argv/stdin send and production inbox and hosted streaming/lifecycle passed without checkout or node_modules.`);
} finally {
  if (smokeJudgment?.listening) { smokeJudgment.closeAllConnections(); await new Promise(resolve => smokeJudgment.close(resolve)); }
  if (server?.listening) { server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); }
  rmSync(root, { recursive: true, force: true });
}
