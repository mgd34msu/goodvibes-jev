/**
 * The VIBE.md → memory migration is strictly ONE-TIME (a persisted marker
 * prevents re-import, which would create near-duplicate persona records), and the VIBE
 * prompt is a PROJECTION of those persona records that preserves the precedence caveat.
 * Hermetic, temp home/workspace + a throwaway MemoryStore; no daemon, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { rmSync } from 'node:fs';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createLocalMemoryAccess, type MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { buildVibeProjectionPrompt, importVibeFilesIntoMemoryOnce } from '../../agent/vibe-file.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempShellPaths() {
  const root = makeProjectTempDir('goodvibes-agent-vibe-migration');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, shellPaths: createShellPathService({ workingDirectory: workspace, homeDirectory: home }) };
}

describe('VIBE.md persona migration', () => {
  let store: MemoryStore;
  let dbPath: string;
  let configRoot: string;
  let registry: MemoryRegistry;
  let memorySpine: MemoryAccess;
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let lineRequests: ReturnType<typeof fakePort>['requests'];

  beforeEach(async () => {
    dbPath = join(makeProjectTempDir('vibe-migration-db'), `vibe-migration-${randomUUID()}.db`);
    configRoot = makeProjectTempDir('vibe-migration-config');
    const configDir = join(configRoot, '.goodvibes', 'agent');
    mkdirSync(configDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir, workingDir: configRoot });
    const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    store = new MemoryStore(dbPath, { embeddingRegistry });
    await store.init();
    registry = new MemoryRegistry(store);
    // importVibeFilesIntoMemoryOnce now writes through the memory-spine's MemoryAccess
    // surface (services.memorySpineClient in production); wrap the local registry the
    // same way so the test exercises the real seam instead of a raw registry.
    memorySpine = createLocalMemoryAccess(registry);
    const readings = fakePort((name, _question, state) => {
      if (name !== 'instruction') throw new Error(`Unexpected VIBE question: ${name}`);
      expect((state as { line: string }).line).toBe('# VIBE.md');
      // The fixture heading names the format; only its bullets are instructions.
      return noulAnswer(0.03);
    });
    lineRequests = readings.requests;
    previousPort = installJudgmentPort(readings.port);
  });

  afterEach(() => {
    installJudgmentPort(previousPort);
    store.close();
    rmSync(configRoot, { recursive: true, force: true });
  });

  test('imports VIBE.md persona records exactly once; the marker prevents re-run', async () => {
    const { shellPaths } = tempShellPaths();
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '# VIBE.md',
      '- Be direct about tradeoffs.',
      '- Prefer visible, reversible actions.',
    ].join('\n'));

    const firstRun = await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths);
    expect(firstRun).toBe(2);
    expect(registry.getAll().filter((r) => r.cls === 'constraint')).toHaveLength(2);

    expect(lineRequests).toHaveLength(1);
    expect(Object.keys(lineRequests[0]!.questions)).toEqual(['instruction']);
    const markerPath = shellPaths.resolveUserPath('agent', 'vibe-import.migrated.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { migrated: Record<string, string> };
    const vibePath = join(shellPaths.workingDirectory, 'VIBE.md');
    expect(marker.migrated[vibePath]).toBe(createHash('sha256').update(readFileSync(vibePath, 'utf8')).digest('hex'));

    // Second run is a no-op, the persisted marker also prevents new readings.
    const secondRun = await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths);
    expect(secondRun).toBe(0);
    expect(lineRequests).toHaveLength(1);
    expect(registry.getAll().filter((r) => r.cls === 'constraint')).toHaveLength(2);
  });

  test('the VIBE projection renders from persona records with the precedence caveat', async () => {
    const { shellPaths } = tempShellPaths();
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '# VIBE.md',
      '- Ask before sending messages.',
    ].join('\n'));
    await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths);

    const projection = buildVibeProjectionPrompt(registry) ?? '';
    expect(projection).toContain('## GoodVibes Agent VIBE.md');
    expect(projection).toContain('Ask before sending messages.');
    // Precedence caveat preserved verbatim, persona never overrides explicit/safety.
    expect(projection).toContain('Follow them only when they do not conflict with explicit user instructions');
  });

  test('with no persona records the projection is null (no empty block)', () => {
    expect(buildVibeProjectionPrompt(registry)).toBeNull();
  });
});
