import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { createMemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeBaseContext(registry: MemoryRegistry, printed: string[]): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  const shellPaths = createShellPathService({ workingDirectory: process.cwd(), homeDirectory: process.cwd() });
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-1',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths,
    },
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: { listServerSecurity: () => [] } as never,
      memoryRegistry: registry,
    },
    clients: {
      agentKnowledgeApi: {
        memory: createMemoryApi(registry),
      } as never,
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('recall command breadth', () => {
  let dir: string;
  let store: MemoryStore;
  let registry: MemoryRegistry;
  let printed: string[];
  let configManager: ConfigManager;
  let previousJudgment: ReturnType<typeof installJudgmentPort>;
  let readings: ReturnType<typeof fakePort>;

  // Authored readings for these exact fixtures. Unknown requests fail closed;
  // no lexical classifier or production decision implementation is substituted.
  function rankFixture(name: string, state: unknown) {
    const input = state as {
      record?: { summary?: string; review_state?: string };
      candidate?: { summary?: string };
      query?: string;
    };
    if (name === 'needs_review' && input.record?.summary === 'Deploy runbook') {
      if (input.record.review_state === 'fresh') return noulAnswer(0.97);
      if (input.record.review_state === 'reviewed') return noulAnswer(0.03);
    }
    if (name === 'match' && input.query === 'orchestration runtime') {
      if (input.candidate?.summary === 'Use orchestration graph runtime edits for node scheduling changes') return noulAnswer(0.98);
      if (input.candidate?.summary === 'Slack channel adapter handles slash commands') return noulAnswer(0.02);
    }
    throw new Error(`Unexpected recall breadth reading: ${name}`);
  }

  beforeEach(async () => {
    dir = makeProjectTempDir('gv-recall');
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(dir, '.goodvibes', 'tui'), workingDir: dir });
    store = new MemoryStore(join(dir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    registry = new MemoryRegistry(store);
    printed = [];
    readings = fakePort((name, _question, state) => rankFixture(name, state));
    previousJudgment = installJudgmentPort(readings.port);
  });

  afterEach(() => {
    installJudgmentPort(previousJudgment);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('supports scoped add, queue, and review flows', async () => {
    const context = makeBaseContext(registry, printed);

    await recallCommand.handler(['add', 'runbook', 'Deploy', 'runbook', '--scope', 'team', '--tags', 'ops,release'], context);
    const created = registry.getAll()[0];
    expect(created?.scope).toBe('team');

    await recallCommand.handler(['queue', '5'], context);
    expect(printed.join('\n')).toContain('Review queue (1)');
    expect(readings.requests).toHaveLength(1);
    expect(readings.requests[0]?.state).toMatchObject({ record: { summary: 'Deploy runbook', review_state: 'fresh' } });
    expect(Object.keys(readings.requests[0]!.questions)).toEqual(['needs_review']);

    printed.length = 0;
    await recallCommand.handler(['review', created!.id, 'reviewed', '--confidence', '92', '--by', 'operator'], context);
    expect(registry.get(created!.id)?.reviewState).toBe('reviewed');
    expect(registry.get(created!.id)?.confidence).toBe(92);
    expect(printed.join('\n')).toContain('Reviewed');

    // Review changes the priority, not membership: even a reviewed record is
    // ranked before the queue limit is applied.
    printed.length = 0;
    await recallCommand.handler(['queue', '1'], context);
    expect(printed.join('\n')).toContain('Review queue (1)');
    expect(printed.join('\n')).toContain(created!.id);
    expect(readings.requests).toHaveLength(2);
    expect(readings.requests[1]?.state).toMatchObject({ record: { review_state: 'reviewed', confidence: 92 } });
    expect(registry.get(created!.id)?.scope).toBe('team');
  });

  test('supports sqlite-vec semantic search and vector status commands', async () => {
    const context = makeBaseContext(registry, printed);
    await registry.add({
      scope: 'project',
      cls: 'runbook',
      summary: 'Use orchestration graph runtime edits for node scheduling changes',
      tags: ['runtime', 'orchestration'],
      review: { state: 'reviewed', confidence: 92 },
    });
    await registry.add({
      scope: 'project',
      cls: 'fact',
      summary: 'Slack channel adapter handles slash commands',
      tags: ['slack'],
      review: { state: 'reviewed', confidence: 90 },
    });

    await recallCommand.handler(['search', '--semantic', 'orchestration', 'runtime', '--limit', '1'], context);
    expect(printed.join('\n')).toContain('semantic record');
    expect(printed.join('\n')).toContain('orchestration graph runtime edits');
    expect(printed.join('\n')).toContain('sim ');
    expect(printed.join('\n')).not.toContain('Slack channel adapter handles slash commands');
    expect(readings.requests).toHaveLength(2);
    expect(readings.requests.map(request => (request.state as { candidate: { summary: string } }).candidate.summary).sort()).toEqual([
      'Slack channel adapter handles slash commands',
      'Use orchestration graph runtime edits for node scheduling changes',
    ]);
    for (const request of readings.requests) {
      expect(request.state).toMatchObject({ query: 'orchestration runtime' });
      expect(Object.keys(request.questions)).toEqual(['match']);
    }

    printed.length = 0;
    await recallCommand.handler(['vector', 'status'], context);
    expect(printed.join('\n')).toContain('backend: sqlite-vec');
    expect(printed.join('\n')).toContain('indexed records: 2');

    printed.length = 0;
    await recallCommand.handler(['vector', 'rebuild'], context);
    expect(printed.join('\n')).toContain('rebuild complete');
  });

  test('exports and imports durable memory bundles', async () => {
    const context = makeBaseContext(registry, printed);

    await registry.add({ scope: 'team', cls: 'decision', summary: 'Shared deploy decision' });
    const exportPath = join(dir, 'knowledge', 'team-bundle.json');

    await recallCommand.handler(['export', exportPath, '--scope', 'team'], context);
    expect(printed.join('\n')).toContain('Refusing to export durable memory bundle');
    expect(existsSync(exportPath)).toBe(false);

    printed.length = 0;
    await recallCommand.handler(['export', exportPath, '--scope', 'team', '--yes'], context);
    const bundleText = readFileSync(exportPath, 'utf-8');
    expect(bundleText).toContain('"scope": "team"');
    expect(bundleText).toContain('"recordCount": 1');

    const importDir = makeProjectTempDir('gv-recall-import');
    const importConfig = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(importDir, '.goodvibes', 'tui'), workingDir: importDir });
    const importStore = new MemoryStore(join(importDir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: importConfig }),
    });
    await importStore.init();
    const importRegistry = new MemoryRegistry(importStore);
    const importPrinted: string[] = [];

    try {
      const importContext = makeBaseContext(importRegistry, importPrinted);
      await recallCommand.handler(['import', exportPath], importContext);
      expect(importRegistry.getAll()).toHaveLength(0);
      expect(importPrinted.join('\n')).toContain('Refusing to import durable memory bundle');

      importPrinted.length = 0;
      await recallCommand.handler(['import', exportPath, '--yes'], importContext);
      expect(importRegistry.getAll()).toHaveLength(1);
      expect(importRegistry.getAll()[0]?.scope).toBe('team');
      expect(importPrinted.join('\n')).toContain('Imported bundle');
    } finally {
      importStore.close();
      rmSync(importDir, { recursive: true, force: true });
    }
  });

  test('supports handoff inspection and import flows', async () => {
    const context = makeBaseContext(registry, printed);
    await registry.add({ scope: 'team', cls: 'runbook', summary: 'Shared rollout checklist' });
    const handoffPath = join(dir, 'handoff', 'team.json');

    await recallCommand.handler(['handoff-export', handoffPath, '--scope', 'team'], context);
    expect(printed.join('\n')).toContain('Refusing to export memory handoff bundle');
    expect(existsSync(handoffPath)).toBe(false);

    printed.length = 0;
    await recallCommand.handler(['handoff-export', handoffPath, '--scope', 'team', '--yes'], context);
    expect(readFileSync(handoffPath, 'utf-8')).toContain('"scope": "team"');

    printed.length = 0;
    await recallCommand.handler(['handoff-inspect', handoffPath], context);
    expect(printed.join('\n')).toContain('Memory Handoff Review');

    const importDir = makeProjectTempDir('gv-recall-handoff-import');
    const importConfig = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(importDir, '.goodvibes', 'tui'), workingDir: importDir });
    const importStore = new MemoryStore(join(importDir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: importConfig }),
    });
    await importStore.init();
    const importRegistry = new MemoryRegistry(importStore);
    const importPrinted: string[] = [];

    try {
      const importContext = makeBaseContext(importRegistry, importPrinted);
      await recallCommand.handler(['handoff-import', handoffPath], importContext);
      expect(importRegistry.getAll()).toHaveLength(0);
      expect(importPrinted.join('\n')).toContain('Refusing to import durable memory bundle');

      importPrinted.length = 0;
      await recallCommand.handler(['handoff-import', handoffPath, '--yes'], importContext);
      expect(importRegistry.getAll()).toHaveLength(1);
      expect(importPrinted.join('\n')).toContain('Imported bundle');
    } finally {
      importStore.close();
      rmSync(importDir, { recursive: true, force: true });
    }
  });
});
