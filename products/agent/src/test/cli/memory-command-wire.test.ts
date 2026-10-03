/**
 * The `goodvibes-agent memory` CLI in BOTH modes:
 *  - daemon up: a real DaemonServer (bootDaemon-style, reserved port, never a real
 *    ~/.goodvibes) is reachable, so wire-eligible subcommands route over the wire
 *    and the record lands in the DAEMON's own store, never the CLI's local file.
 *  - daemon down: proven by the existing memory-command.test.ts fixtures (fetch
 *    mocked to fail, exercising the local-direct fallback), this file focuses on
 *    the "up" half plus one direct side-by-side proof that the SAME CLI command,
 *    run against the two different fixtures, lands in two different stores.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ConfigManager as SdkConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { resolveCanonicalMemoryDbPath, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const TEST_TOKEN = 'memory-cli-wire-token-321';

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve test port')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function createUserAuth(homeDir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
  });
}

async function runCli(args: readonly string[], workingDir: string, homeDirectory: string): Promise<{ readonly exitCode: number; readonly output: string }> {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory: workingDir,
      homeDirectory,
    });
    return { exitCode: result.exitCode, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('memory CLI: daemon up routes over the wire', () => {
  let root: string;
  let workingDir: string;
  let homeDir: string;
  let daemon: DaemonServer;
  let daemonServices: RuntimeServices;
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let searchRequests: ReturnType<typeof fakePort>['requests'];
  let port: number;

  beforeEach(async () => {
    root = makeProjectTempDir('gv-memory-cli-wire');
    workingDir = join(root, 'workspace');
    homeDir = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    const daemonHomeDir = join(root, 'daemon-home');
    const daemonWorkingDir = join(root, 'daemon-workspace');
    mkdirSync(daemonHomeDir, { recursive: true });
    mkdirSync(daemonWorkingDir, { recursive: true });
    port = await reservePort();
    daemonServices = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager: new SdkConfigManager({ surfaceRoot: 'tui', configDir: join(daemonHomeDir, '.goodvibes', 'tui'), workingDir: daemonWorkingDir, homeDir: daemonHomeDir }),
      workingDir: daemonWorkingDir,
      homeDirectory: daemonHomeDir,
      featureFlags: createFeatureFlagManager(),
      getConversationTitle: () => 'memory-cli-wire-daemon',
    });
    // Composition installs its own port. Replace it only after the graph exists,
    // with the explicit reading for this file's one semantic-search fixture.
    const readings = fakePort((name, _question, state) => {
      if (name !== 'match') throw new Error(`Unexpected memory-wire question: ${name}`);
      expect(state).toMatchObject({
        query: 'distinctive wire-searchable phrase about ostriches',
        candidate: { summary: 'a distinctive wire-searchable phrase about ostriches' },
      });
      return noulAnswer(0.97);
    });
    searchRequests = readings.requests;
    previousPort = installJudgmentPort(readings.port);
    daemon = new DaemonServer({ port, host: '127.0.0.1', runtimeServices: daemonServices.asDaemonGradeView(), userAuth: createUserAuth(daemonHomeDir) });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    // Point the CLI's connection resolver (createSpineConnectionResolver reads
    // configManager + the connected-host token path under homeDirectory) at this
    // real daemon, the CLI process itself has no lasting config store, so this
    // has to be a fresh ConfigManager written to the same configDir the CLI will
    // construct in runCli().
    const cliConfigManager = new ConfigManager({ workingDir, homeDir, surfaceRoot: 'agent' });
    cliConfigManager.set('controlPlane.host', '127.0.0.1');
    cliConfigManager.set('controlPlane.port', port);
    mkdirSync(join(homeDir, '.goodvibes', 'daemon'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(homeDir, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: TEST_TOKEN }));
  });

  afterEach(async () => {
    try {
      await daemon?.stop();
    } finally {
      installJudgmentPort(previousPort);
      daemonServices?.dispose();
    }
    rmSync(root, { recursive: true, force: true });
  });

  test('memory add reaches the DAEMON store, not the CLI\'s local canonical file', async () => {
    const created = await runCli(['memory', 'add', 'fact', 'CLI wire-added fact', '--scope', 'project', '--json'], workingDir, homeDir);
    expect(created.exitCode).toBe(0);
    const parsed = JSON.parse(created.output) as { readonly kind: string; readonly data: { readonly id: string; readonly summary: string } };
    expect(parsed.kind).toBe('agent.memory.add');
    expect(parsed.data.summary).toBe('CLI wire-added fact');

    // Reached the daemon's own store...
    expect(daemonServices.memoryRegistry.get(parsed.data.id)?.summary).toBe('CLI wire-added fact');

    // ...and never touched the CLI's own local canonical store file (opening it
    // directly here to check, exactly like withMemory would have).
    const localDbPath = resolveCanonicalMemoryDbPath(homeDir);
    const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ workingDir, homeDir, surfaceRoot: 'agent' }) });
    const localStore = new MemoryStore(localDbPath, { embeddingRegistry });
    await localStore.init();
    const localRegistry = new MemoryRegistry(localStore);
    try {
      expect(localRegistry.getAll()).toHaveLength(0);
    } finally {
      localStore.close();
    }
  });

  test('memory review and memory delete also route over the wire against the daemon record', async () => {
    const created = await runCli(['memory', 'add', 'fact', 'reviewable wire fact', '--json'], workingDir, homeDir);
    const id = (JSON.parse(created.output) as { readonly data: { readonly id: string } }).data.id;

    const reviewed = await runCli(['memory', 'review', id, 'reviewed', '--confidence', '91'], workingDir, homeDir);
    expect(reviewed.exitCode).toBe(0);
    expect(daemonServices.memoryRegistry.get(id)?.reviewState).toBe('reviewed');
    expect(daemonServices.memoryRegistry.get(id)?.confidence).toBe(91);

    const deleted = await runCli(['memory', 'delete', id, '--yes'], workingDir, homeDir);
    expect(deleted.exitCode).toBe(0);
    expect(daemonServices.memoryRegistry.get(id)).toBeNull();
  });

  // ── 1.2.0 full-detach subcommands, same real-daemon proof ─────────────────

  test('memory show reads the record and its links over the wire (get + linksFor)', async () => {
    const from = await runCli(['memory', 'add', 'decision', 'wire decision', '--json'], workingDir, homeDir);
    const to = await runCli(['memory', 'add', 'constraint', 'wire constraint', '--json'], workingDir, homeDir);
    const fromId = (JSON.parse(from.output) as { readonly data: { readonly id: string } }).data.id;
    const toId = (JSON.parse(to.output) as { readonly data: { readonly id: string } }).data.id;
    await runCli(['memory', 'link', fromId, toId, 'supersedes', '--yes'], workingDir, homeDir);

    const shown = await runCli(['memory', 'show', fromId, '--json'], workingDir, homeDir);
    expect(shown.exitCode).toBe(0);
    const parsed = JSON.parse(shown.output) as { readonly data: { readonly record: { readonly id: string }; readonly links: readonly { readonly toId: string; readonly relation: string }[] } };
    expect(parsed.data.record.id).toBe(fromId);
    expect(parsed.data.links.some((link) => link.toId === toId && link.relation === 'supersedes')).toBe(true);
  });

  test('memory promote is a scope update, wire-covered, and lands on the daemon store', async () => {
    const created = await runCli(['memory', 'add', 'fact', 'promotable wire fact', '--scope', 'project', '--json'], workingDir, homeDir);
    const id = (JSON.parse(created.output) as { readonly data: { readonly id: string } }).data.id;

    const promoted = await runCli(['memory', 'promote', id, 'team', '--yes'], workingDir, homeDir);
    expect(promoted.exitCode).toBe(0);
    expect(daemonServices.memoryRegistry.get(id)?.scope).toBe('team');
  });

  test('memory search --semantic routes over the wire (searchSemantic) instead of falling back to local', async () => {
    const created = await runCli(['memory', 'add', 'fact', 'a distinctive wire-searchable phrase about ostriches', '--json'], workingDir, homeDir);
    const id = (JSON.parse(created.output) as { readonly data: { readonly id: string } }).data.id;

    const searched = await runCli(['memory', 'search', 'distinctive wire-searchable phrase about ostriches', '--semantic', '--json'], workingDir, homeDir);
    expect(searched.exitCode).toBe(0);
    const parsed = JSON.parse(searched.output) as { readonly data: { readonly path: string; readonly records: readonly { readonly id: string }[] } };
    expect(parsed.data.path).toBe('wire:connected-daemon');
    expect(parsed.data.records.some((record) => record.id === id)).toBe(true);
    expect(searchRequests).toHaveLength(1);
    expect(Object.keys(searchRequests[0]!.questions)).toEqual(['match']);
  });

  test('memory export/import round-trip a bundle over the wire against the daemon store', async () => {
    await runCli(['memory', 'add', 'fact', 'bundled wire fact', '--json'], workingDir, homeDir);
    const bundlePath = join(root, 'bundle.json');

    const exported = await runCli(['memory', 'export', bundlePath, '--yes', '--json'], workingDir, homeDir);
    expect(exported.exitCode).toBe(0);
    const exportedParsed = JSON.parse(exported.output) as { readonly data: { readonly bundle: { readonly recordCount: number } } };
    expect(exportedParsed.data.bundle.recordCount).toBe(1);

    // Re-importing the bundle that was just exported from this same daemon store
    // is an idempotent union, the record already exists there, so it is skipped.
    const imported = await runCli(['memory', 'import', bundlePath, '--yes', '--json'], workingDir, homeDir);
    expect(imported.exitCode).toBe(0);
    const importedParsed = JSON.parse(imported.output) as { readonly data: { readonly result: { readonly importedRecords: number; readonly skippedRecords: number } } };
    expect(importedParsed.data.result.importedRecords).toBe(0);
    expect(importedParsed.data.result.skippedRecords).toBe(1);
    expect(daemonServices.memoryRegistry.getAll()).toHaveLength(1);
  });
});
