import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPostBuildSmoke } from '@goodvibes-jev/engine/toolchain';

// Explicit local Linux artifact proof. This consumes the production binary;
// it never builds a fixture launcher or supplies an inbox composition module.
assert(!process.versions.bun, 'Run verify:binary with ordinary Node, not Bun.');
assert.equal(process.platform, 'linux', 'Isolated native verification currently requires Linux and bubblewrap.');
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
let server;
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
  for (const argv of [[], ['serve'], ['install-service'], ['start-service'], ['restart-service'], ['migrate-service', '-y']]) {
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
    { path: '/synthetic-override-topic', method: 'POST', body: 'synthetic first line\nsecond line\n', title: 'Stdin title', authorization: 'Bearer synthetic-owned-token' },
  ]);
  assert.equal(readFileSync(join(daemon, 'settings.json'), 'utf8'), settings);
  assert.equal(readFileSync(join(daemon, 'secrets.json'), 'utf8'), secrets);
  assert(!readdirSync(root, { recursive: true }).map(String).join('\n').match(/operator-tokens|daemon-lifecycle|daemon-receipts|detached-daemon/));
  assert(!existsSync(join(home, '.goodvibes')));
  console.log(`Native daemon ${manifest.version}: relocated shared smoke, exact identity, help, refusal, config and argv/stdin send passed without checkout or node_modules.`);
} finally {
  if (server?.listening) { server.closeAllConnections(); await new Promise((yes, no) => server.close(error => error ? no(error) : yes())); }
  rmSync(root, { recursive: true, force: true });
}
