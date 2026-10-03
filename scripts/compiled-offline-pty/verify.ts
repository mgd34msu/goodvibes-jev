#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanArtifactForEagerNamespaceReads } from '../../packages/engine/toolchain/src/lib/post-build-smoke.ts';
import { verifyTuiCiArtifact } from '../../products/tui/scripts/ci-artifact.ts';
import { installTestNetworkGuard } from '../../packages/engine/toolchain/src/test-runner/test-network-guard.ts';
import { freePort, isolatedEnv, startStubModel, lastUserText } from '../../products/tui/src/test/e2e/harness.ts';
import { TuiConfigManager } from '../../products/tui/src/config/host-settings.ts';
import { seedProviderMetadataCacheFixture } from '../../products/tui/src/test/helpers/provider-metadata-cache-fixture.ts';
import { seedProviderModelListCacheFixture } from '../../products/agent/src/test/helpers/provider-metadata-cache-fixture.ts';
import { startE2EJudgments } from '../../products/agent/src/test/e2e/judgment-fixture.ts';

const usage = 'Usage: bun scripts/compiled-offline-pty/verify.ts --artifact-root <products/tui> --evidence <new-directory> --source-commit <SHA> --source-tree <SHA> --head-commit <SHA> --binary-sha256 <SHA256>';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
const flags = ['--artifact-root', '--evidence', '--source-commit', '--source-tree', '--head-commit', '--binary-sha256'];
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]!;
  const value = args[i + 1];
  if (!flags.includes(flag) || options.has(flag) || !value || value.startsWith('--')) throw new Error(usage);
  options.set(flag, value);
}
if (options.size !== flags.length) throw new Error(usage);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This compiled proof requires Linux x64');
if (Bun.version !== '1.3.14') throw new Error('This proof requires Bun 1.3.14');
const artifactRoot = realpathSync(options.get('--artifact-root')!);
const evidence = resolve(options.get('--evidence')!);
const source = {
  sourceCommit: options.get('--source-commit')!,
  sourceTree: options.get('--source-tree')!,
  headCommit: options.get('--head-commit')!,
};
const expectedHash = options.get('--binary-sha256')!;
if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('Expected binary SHA256 must be exactly 64 lowercase hex characters');
// Fail closed on the caller's independently established source/tree/head and payload
// bytes/modes. Never derive expected provenance from the downloaded manifest itself.
await verifyTuiCiArtifact(artifactRoot, source);
const binary = realpathSync(join(artifactRoot, 'dist', 'goodvibes-linux-x64'));
const binarySHA256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (binarySHA256 !== expectedHash) throw new Error('Compiled binary SHA256 differs from the expected receipt');
const eagerNamespaceReads = scanArtifactForEagerNamespaceReads(readFileSync(binary, 'latin1'));
if (eagerNamespaceReads.length > 0) throw new Error(`Compiled artifact has eager namespace reads: ${eagerNamespaceReads.join(', ')}`);
const python = Bun.spawnSync(['python3', '-c', 'import fcntl, pty, termios'], { stdout: 'pipe', stderr: 'pipe' });
if (python.exitCode !== 0) throw new Error('python3 with POSIX stdlib PTY support is required');

// An explicit, NEW directory owns all output and scratch. No global /tmp prefix,
// no deletion of caller-owned paths, no accumulating anonymous temporary homes.
mkdirSync(evidence, { mode: 0o700 });
const root = join(evidence, 'scratch');
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const tmp = join(root, 'tmp');
const writeJson = (name: string, value: unknown) => writeFileSync(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`);
writeJson('provenance.json', { ...source, binary, binarySHA256, target: 'linux-x64', bun: Bun.version, verifiedBeforeExecution: true, eagerNamespaceScanPassed: true });
const parentViolations: string[] = [];
const restoreGuard = installTestNetworkGuard(message => { parentViolations.push(message); });
let model: ReturnType<typeof startStubModel> | undefined;
let judgments: ReturnType<typeof startE2EJudgments> | undefined;
let activeChild: Bun.Subprocess | undefined;
let interrupted = false;
const interrupt = () => { interrupted = true; activeChild?.kill('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  for (const dir of [home, workspace, tmp, join(home, '.goodvibes', 'tui', 'providers'), join(home, '.goodvibes', 'daemon')]) mkdirSync(dir, { recursive: true });
  model = startStubModel(request => ({ text: lastUserText(request).includes('marmot question') ? 'The marmot answer is forty-two.' : 'E2E side request' }));
  judgments = startE2EJudgments();
  const daemonPort = await freePort();
  writeFileSync(join(home, '.goodvibes', 'tui', 'providers', 'e2e-stub.json'), JSON.stringify({ name: 'e2e-stub', displayName: 'E2E Stub', type: 'openai-compat', baseURL: model.baseURL, apiKey: 'e2e-not-a-secret', models: [{ id: 'stub-model', displayName: 'Stub Model', contextWindow: 64000, capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }] }));
  writeFileSync(join(home, '.goodvibes', 'tui', 'settings.json'), JSON.stringify({ provider: { model: 'e2e-stub:stub-model' } }));
  writeFileSync(join(home, '.goodvibes', 'daemon', 'settings.json'), JSON.stringify({ controlPlane: { host: '127.0.0.1', port: daemonPort } }));
  const configManager = new TuiConfigManager({ configDir: join(home, '.goodvibes', 'tui'), homeDir: home, workingDir: workspace, surfaceRoot: 'tui' });
  seedProviderMetadataCacheFixture({ configManager, homeDirectory: home, workingDirectory: workspace });
  seedProviderModelListCacheFixture(configManager, 'openai');
  const compiledLog = join(evidence, 'compiled-network-violations.log');
  writeFileSync(compiledLog, '');
  const receipt = join(evidence, 'preload-receipt.json');
  const receiptScript = join(root, 'preload-receipt.ts');
  writeFileSync(receiptScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, execPath: process.execPath, guardPreloadCompleted: true }));\n`);
  const guardPreload = resolve(import.meta.dir, '../../packages/engine/scripts/test-network-preload.ts');
  writeFileSync(join(workspace, 'bunfig.toml'), `preload = [${JSON.stringify(guardPreload)}, ${JSON.stringify(receiptScript)}]\n`);
  const env = isolatedEnv({ root, home, workspace, daemonPort, setTuiSetting: () => { throw new Error('No settings mutations in verification'); } }, {
    TYPESAFE_API_KEY: 'local-e2e-judgment-fixture-not-a-secret', TYPESAFE_BASE_URL: judgments.baseURL,
    GOODVIBES_TEST_NETWORK_VIOLATIONS: compiledLog, GIT_CEILING_DIRECTORIES: root,
  });
  writeJson('fixture.json', { root, home, workspace, daemonPort, binary, env });
  if (interrupted) throw new Error('Proof interrupted before launch');
  const child = activeChild = Bun.spawn(['python3', join(import.meta.dir, 'drive.py'), join(evidence, 'fixture.json')], { stdout: 'inherit', stderr: 'inherit' });
  const driverExit = await child.exited;
  activeChild = undefined;
  const compiledViolations = readFileSync(compiledLog, 'utf8').trim().split('\n').filter(Boolean);
  writeJson('result.json', {
    driverExit, parentViolations, compiledViolations,
    preloadReceipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) as unknown : null,
    judgments: { accepted: judgments.accepted, rejected: judgments.rejected, unexpected: judgments.unexpected },
    modelRequests: model.requests,
  });
  // Raw ANSI stripping loses cursor-positioned spaces. Only reconstructed visible
  // cells count as the reply; the driver and guard receipts must also all agree.
  if (interrupted) throw new Error('Proof interrupted; the compiled child has been stopped');
  const replay = activeChild = Bun.spawn(['python3', join(import.meta.dir, 'replay.py'), evidence], { stdout: 'inherit', stderr: 'inherit' });
  process.exitCode = await replay.exited;
  activeChild = undefined;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  judgments?.stop();
  model?.stop();
  restoreGuard();
  rmSync(root, { recursive: true, force: true });
}
