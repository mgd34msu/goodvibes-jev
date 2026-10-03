import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { retryTransientInstall } from './install-retry.ts';
import {
  cleanupStage,
  collectTarballs,
  createSdkTempDir,
  getAuthToken,
  getPublishRegistryOverride,
  getRootVersion,
  inspectPackedManifest,
  packageNameForDir as manifestPackageName,
  packStage,
  publicPackageDirs,
  readPackage,
  run,
  stagePackages,
} from './release-shared.ts';

const REGISTRY_MODE = process.argv.includes('--registry');
// The old packages are subpaths of the one engine package.
const ENGINE_PACKAGE_NAME = requirePackageName('.');
const PUBLIC_PACKAGE_DIR = 'sdk';
const PUBLIC_PACKAGE_NAME = packageNameForDir(PUBLIC_PACKAGE_DIR);
const CONTRACTS_PACKAGE_NAME = packageNameForDir('contracts');
const ERRORS_PACKAGE_NAME = packageNameForDir('errors');
const DAEMON_SDK_PACKAGE_NAME = packageNameForDir('daemon-sdk');
const TRANSPORT_CORE_PACKAGE_NAME = packageNameForDir('transport-core');
const TRANSPORT_HTTP_PACKAGE_NAME = packageNameForDir('transport-http');
const TRANSPORT_REALTIME_PACKAGE_NAME = packageNameForDir('transport-realtime');
const OPERATOR_SDK_PACKAGE_NAME = packageNameForDir('operator-sdk');
const PEER_SDK_PACKAGE_NAME = packageNameForDir('peer-sdk');
const JUDGMENT_PACKAGE_NAME = manifestPackageName('../judgment');

function requirePackageName(dir: string): string {
  const name = readPackage(dir).name;
  if (typeof name !== 'string' || !name) throw new Error(`Package ${dir} is missing a string name.`);
  return name;
}

function packageNameForDir(dir: string): string {
  return dir === '.' ? ENGINE_PACKAGE_NAME : `${ENGINE_PACKAGE_NAME}/${dir}`;
}

const WEB_ENTRY = `${PUBLIC_PACKAGE_NAME}/web`;
const NATIVE_ENTRY = `${PUBLIC_PACKAGE_NAME}/react-native`;
const AUTH_ENTRY = `${PUBLIC_PACKAGE_NAME}/auth`;
const OPERATOR_ENTRY = `${PUBLIC_PACKAGE_NAME}/operator`;
const PEER_ENTRY = `${PUBLIC_PACKAGE_NAME}/peer`;
const DAEMON_ENTRY = `${PUBLIC_PACKAGE_NAME}/daemon`;
const CONTRACTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/contracts`;
const REALTIME_ENTRY = `${PUBLIC_PACKAGE_NAME}/transport-realtime`;
const RUNTIME_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime`;
const RUNTIME_OBSERVABILITY_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/observability`;
const PROVIDERS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/providers`;
const FEATURE_ANNOUNCEMENTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/feature-announcements`;
const LOCALHOST_FETCH_APPROVAL_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/permissions/localhost-fetch-approval`;
const EXEC_PROMPT_WIRING_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/permissions/exec-prompt-wiring`;
const STORE_SNAPSHOTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/state/store-snapshots`;
const CONTROL_PLANE_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/control-plane`;
const SELF_UPDATE_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/runtime/self-update`;
const AUTO_UPDATER_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/daemon/auto-updater`;
const RECEIPTS_ENTRY = `${PUBLIC_PACKAGE_NAME}/platform/daemon/receipts`;
const REGISTRY = getPublishRegistryOverride() || 'https://registry.npmjs.org';

const smokeScript = `
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = await import('${PUBLIC_PACKAGE_NAME}');
const webEntry = await import('${WEB_ENTRY}');
const nativeEntry = await import('${NATIVE_ENTRY}');
const auth = await import('${AUTH_ENTRY}');
const operator = await import('${OPERATOR_ENTRY}');
const peer = await import('${PEER_ENTRY}');
const daemon = await import('${DAEMON_ENTRY}');
const contracts = await import('${CONTRACTS_ENTRY}');
const runtimeEvents = await import('${REALTIME_ENTRY}');
const runtime = await import('${RUNTIME_ENTRY}');
const runtimeObservability = await import('${RUNTIME_OBSERVABILITY_ENTRY}');
const providersEntry = await import('${PROVIDERS_ENTRY}');
const featureAnnouncements = await import('${FEATURE_ANNOUNCEMENTS_ENTRY}');
const localhostFetchApproval = await import('${LOCALHOST_FETCH_APPROVAL_ENTRY}');
const execPromptWiring = await import('${EXEC_PROMPT_WIRING_ENTRY}');
const storeSnapshots = await import('${STORE_SNAPSHOTS_ENTRY}');
const controlPlane = await import('${CONTROL_PLANE_ENTRY}');
const selfUpdate = await import('${SELF_UPDATE_ENTRY}');
const autoUpdater = await import('${AUTO_UPDATER_ENTRY}');
const daemonReceipts = await import('${RECEIPTS_ENTRY}');
const contractsPackage = await import('${CONTRACTS_PACKAGE_NAME}');
const errorsPackage = await import('${ERRORS_PACKAGE_NAME}');
const daemonSdkPackage = await import('${DAEMON_SDK_PACKAGE_NAME}');
const transportCorePackage = await import('${TRANSPORT_CORE_PACKAGE_NAME}');
const transportHttpPackage = await import('${TRANSPORT_HTTP_PACKAGE_NAME}');
const transportRealtimePackage = await import('${TRANSPORT_REALTIME_PACKAGE_NAME}');
const operatorSdkPackage = await import('${OPERATOR_SDK_PACKAGE_NAME}');
const peerSdkPackage = await import('${PEER_SDK_PACKAGE_NAME}');
const judgmentDecisions = await import('${JUDGMENT_PACKAGE_NAME}/decisions');
const judgmentRoot = await import('${JUDGMENT_PACKAGE_NAME}');
const engineErrors = await import('${ERRORS_PACKAGE_NAME}');

const sdk = root.createGoodVibesSdk({ baseUrl: 'http://127.0.0.1:3210' });
if (!sdk?.operator || !sdk?.peer || !sdk?.realtime) throw new Error('sdk entrypoint missing expected surfaces');
if (typeof auth.createMemoryTokenStore !== 'function') throw new Error('auth entrypoint missing token helpers');
if (typeof operator.createOperatorSdk !== 'function') throw new Error('operator client export missing');
if (typeof peer.createPeerSdk !== 'function') throw new Error('peer client export missing');
if (typeof daemon.createDaemonControlRouteHandlers !== 'function') throw new Error('daemon route export missing');
if (!contracts.OPERATOR_METHOD_IDS || !contracts.PEER_ENDPOINT_IDS) throw new Error('contracts export missing');
if (typeof runtimeEvents.createRemoteRuntimeEvents !== 'function') throw new Error('runtime realtime export missing');
if (!runtime.observability || !runtime.transport || !runtime.state) throw new Error('runtime namespace seams missing');
if (typeof runtimeObservability.TimelineBuffer !== 'function') throw new Error('runtime observability state inspector export missing');
if (!runtimeObservability.GATE_SUITES || typeof runtimeObservability.GATE_SUITES !== 'object') throw new Error('runtime observability GATE_SUITES export missing');
if (typeof providersEntry.resolveModelReference !== 'function') throw new Error('providers resolveModelReference export missing');
if (typeof providersEntry.findClosestModelIds !== 'function') throw new Error('providers findClosestModelIds export missing');
if (typeof featureAnnouncements.FeatureAnnouncementStore !== 'function') throw new Error('feature-announcements store export missing');
if (typeof featureAnnouncements.collectStartupAnnouncements !== 'function') throw new Error('feature-announcements collectStartupAnnouncements export missing');
if (typeof featureAnnouncements.createSandboxContainmentAnnouncer !== 'function') throw new Error('feature-announcements sandbox announcer export missing');
if (typeof featureAnnouncements.featureAnnouncementsPath !== 'function') throw new Error('feature-announcements path helper export missing');
if (typeof localhostFetchApproval.buildLocalhostFetchApproval !== 'function') throw new Error('localhost-fetch-approval builder export missing');
if (typeof execPromptWiring.buildExecPromptAnswerHandler !== 'function') throw new Error('exec-prompt-wiring builder export missing');
if (typeof storeSnapshots.StoreSnapshotScheduler !== 'function') throw new Error('store-snapshots scheduler export missing');
if (typeof storeSnapshots.RetentionPolicy !== 'function') throw new Error('store-snapshots RetentionPolicy export missing');
if (typeof storeSnapshots.SnapshotPruner !== 'function') throw new Error('store-snapshots SnapshotPruner export missing');
if (typeof storeSnapshots.defaultStoreSnapshotRetention !== 'function') throw new Error('store-snapshots default retention export missing');
if (typeof controlPlane.buildSharedSessionAgentSpawnRoutingInput !== 'function') throw new Error('control-plane spawn-routing builder export missing');
if (typeof controlPlane.hasFreshSurfaceParticipant !== 'function') throw new Error('control-plane surface-presence helper export missing');
if (typeof controlPlane.SURFACE_ROUTE_FRESHNESS_MS !== 'number') throw new Error('control-plane surface freshness window export missing');
if (typeof selfUpdate.compareVersions !== 'function') throw new Error('self-update compareVersions export missing');
if (typeof selfUpdate.verifyChecksum !== 'function') throw new Error('self-update verifyChecksum export missing');
if (typeof autoUpdater.DaemonAutoUpdater !== 'function') throw new Error('auto-updater DaemonAutoUpdater export missing');
if (typeof daemonReceipts.DaemonReceiptStore !== 'function') throw new Error('daemon receipts store export missing');
if (typeof root.createGoodVibesSdk !== 'function') throw new Error('umbrella sdk export missing');
if (typeof webEntry.createWebGoodVibesSdk !== 'function') throw new Error('web sdk export missing');
if (typeof nativeEntry.createReactNativeGoodVibesSdk !== 'function') throw new Error('react-native sdk export missing');
if (!contractsPackage.OPERATOR_METHOD_IDS || !contractsPackage.PEER_ENDPOINT_IDS) throw new Error('contracts package export missing');
if (typeof errorsPackage.GoodVibesSdkError !== 'function') throw new Error('errors package export missing');
if (typeof daemonSdkPackage.createDaemonControlRouteHandlers !== 'function') throw new Error('daemon-sdk package export missing');
if (typeof transportCorePackage.createDirectClientTransport !== 'function') throw new Error('transport-core package export missing');
if (typeof transportHttpPackage.createHttpTransport !== 'function') throw new Error('transport-http package export missing');
if (typeof transportRealtimePackage.createRemoteRuntimeEvents !== 'function') throw new Error('transport-realtime package export missing');
if (typeof operatorSdkPackage.createOperatorSdk !== 'function') throw new Error('operator-sdk package export missing');
if (typeof peerSdkPackage.createPeerSdk !== 'function') throw new Error('peer-sdk package export missing');
if (typeof judgmentDecisions.defineBattery !== 'function') throw new Error('judgment decisions export missing');
if (typeof judgmentRoot.createSystemOnePort !== 'function') throw new Error('judgment root export missing');
if (typeof engineErrors.readFailure !== 'function' || typeof engineErrors.installJudgmentPort !== 'function') throw new Error('engine errors judgment reading export missing');
if (require.resolve('${JUDGMENT_PACKAGE_NAME}/package.json').includes(join('${ENGINE_PACKAGE_NAME}', 'node_modules'))) throw new Error('judgment installed nested under the engine instead of beside it');
const packageRoot = dirname(require.resolve('${ENGINE_PACKAGE_NAME}/package.json'));
const engineRequire = createRequire(join(packageRoot, 'package.json'));
let bashManifest;
try { bashManifest = engineRequire.resolve('bash-language-server/package.json'); }
catch { bashManifest = join(packageRoot, 'vendor/bash-language-server/package.json'); }
const bashRequire = createRequire(bashManifest);
if (bashRequire('@goodvibes-jev/bash-zod/package.json').version !== '3.24.2' ||
    bashRequire('@goodvibes-jev/bash-web-tree-sitter/package.json').version !== '0.24.5') {
  throw new Error('packaged Bash dependency aliases resolved the wrong versions');
}
const discovered = await bashRequire('./out/util/fs.js').getFilePaths({
  globPattern: 'package.json', rootPath: process.cwd(), maxItems: 1,
});
if (discovered.length !== 1) throw new Error('packaged Bash file discovery failed');
const braces = bashRequire('./vendor/fast-glob/vendor/micromatch/vendor/braces');
let nestingRejected = false;
try { braces.compile('{'.repeat(128) + 'fixture' + '}'.repeat(128)); }
catch (error) { nestingRejected = error instanceof SyntaxError && error.message.includes('maximum AST depth'); }
if (!nestingRejected) throw new Error('packaged Bash brace depth guard is missing');
const savedFetch = globalThis.fetch;
try {
  const parser = await bashRequire('./out/parser.js').initializeParser();
  try {
    const tree = parser.parse('echo packaged-fixture');
    try {
      if (tree.rootNode.type !== 'program' || tree.rootNode.hasError) throw new Error('packaged Bash wasm parser failed');
    } finally { tree.delete(); }
  } finally { parser.delete(); }
} finally { globalThis.fetch = savedFetch; }
if (typeof Bun !== 'undefined') {
  const { LspService } = await import('${PUBLIC_PACKAGE_NAME}/platform/intelligence');
  const lsp = new LspService({
    workingDirectory: process.cwd(),
    resolveProjectPath: (...parts) => join(process.cwd(), ...parts),
  });
  try {
    lsp.registerServer('bash', { command: 'bash-language-server', args: ['start'] });
    if (!await lsp.isAvailable('bash')) throw new Error('packaged Bash LSP is unavailable');
    if (!(await lsp.getClient('bash'))?.isRunning) throw new Error('packaged Bash LSP handshake failed');
  } finally { await lsp.shutdown(); }
}
const nestedInternalRoot = join(packageRoot, 'node_modules', '@goodvibes-jev');
if (existsSync(nestedInternalRoot)) {
  const leaked = readdirSync(nestedInternalRoot);
  if (leaked.length > 0) {
    throw new Error('SDK package contains nested GoodVibes package installs: ' + leaked.join(', '));
  }
}
console.log('install smoke ok');
`;

function writeConsumerFiles(projectDir: string): void {
  writeFileSync(
    resolve(projectDir, 'package.json'),
    `${JSON.stringify({
      name: 'goodvibes-sdk-install-smoke',
      private: true,
      type: 'module',
    }, null, 2)}\n`,
  );
  writeFileSync(resolve(projectDir, 'check.mjs'), `${smokeScript.trim()}\n`);
  if (REGISTRY_MODE) {
    writeRegistryConfig(projectDir);
  }
}

function writeRegistryConfig(projectDir: string): void {
  const token = getAuthToken(REGISTRY);
  if (!token) {
    return;
  }
  const registryHost = new URL(REGISTRY).host;
  const scope = ENGINE_PACKAGE_NAME.startsWith('@')
    ? ENGINE_PACKAGE_NAME.slice(0, ENGINE_PACKAGE_NAME.indexOf('/'))
    : null;
  const lines = [`//${registryHost}/:_authToken=${token}`];
  if (scope && registryHost !== 'registry.npmjs.org') {
    lines.push(`${scope}:registry=${REGISTRY}`);
  }
  writeFileSync(resolve(projectDir, '.npmrc'), `${lines.join('\n')}\n`);
}

async function installWithNpm(specs: readonly string[]): Promise<void> {
  const projectDir = createSdkTempDir('goodvibes-sdk-npm-smoke-');
  try {
    writeConsumerFiles(projectDir);
    await retryTransientInstall(() => run('npm', ['install', ...specs], projectDir, {
      auth: REGISTRY_MODE,
      registry: REGISTRY,
      packageName: PUBLIC_PACKAGE_NAME,
      stdio: 'pipe',
    }), { prefix: 'install-smoke', label: 'npm install', site: 'release.install-smoke.npm-install' });
    run('node', ['check.mjs'], projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

async function installWithBun(specs: readonly string[]): Promise<void> {
  const projectDir = createSdkTempDir('goodvibes-sdk-bun-smoke-');
  try {
    writeConsumerFiles(projectDir);
    if (!REGISTRY_MODE) {
      // A tarball-only test has no published judgment version to resolve.
      // Bind the exact packed dependency instead of querying its registry.
      const judgmentTarball = specs.find((spec) => inspectPackedManifest(spec).name === JUDGMENT_PACKAGE_NAME);
      if (!judgmentTarball) throw new Error('Bun tarball smoke requires the packed judgment dependency');
      const manifestPath = resolve(projectDir, 'package.json');
      const consumer = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(manifestPath, `${JSON.stringify({ ...consumer, overrides: { [JUDGMENT_PACKAGE_NAME]: `file:${judgmentTarball}` } }, null, 2)}\n`);
    }
    // Pin zod@^4 explicitly so Bun resolves the dist's `zod/v4` subpath import
    // even when another dependency tree brings an older zod.
    const bunSpecs = [...specs, 'zod@^4'];
    await retryTransientInstall(() => run('bun', ['add', '--force', '--no-cache', ...bunSpecs], projectDir, {
      auth: REGISTRY_MODE,
      registry: REGISTRY,
      packageName: PUBLIC_PACKAGE_NAME,
      stdio: 'pipe',
    }), { prefix: 'install-smoke', label: 'bun add', site: 'release.install-smoke.bun-add' });
    run('bun', ['run', 'check.mjs'], projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function buildRegistrySpecs(): string[] {
  const version = getRootVersion();
  // Every released package by its own manifest name: the engine and the
  // judgment package it depends on.
  return publicPackageDirs.map((dir) => `${manifestPackageName(dir)}@${version}`);
}

async function buildTarballSpecs() {
  const { tempRoot, publicStages } = await stagePackages();
  const packDestination = createSdkTempDir('goodvibes-sdk-tarballs-');
  const packResults = publicStages.map((stage) => packStage(stage.stageDir, packDestination));
  const tarballs = collectTarballs(packResults, packDestination);
  return { tempRoot, specs: tarballs };
}

if (REGISTRY_MODE) {
  const specs = buildRegistrySpecs();
  await installWithNpm(specs);
  await installWithBun(specs);
  console.log('registry install smoke passed');
} else {
  const { tempRoot, specs } = await buildTarballSpecs();
  const firstSpec = specs[0];
  const packDir = firstSpec !== undefined ? resolve(firstSpec, '..') : null;
  try {
    await installWithNpm(specs);
    await installWithBun(specs);
    console.log('tarball install smoke passed');
  } finally {
    cleanupStage(tempRoot);
    if (packDir) {
      rmSync(packDir, { recursive: true, force: true });
    }
  }
}
