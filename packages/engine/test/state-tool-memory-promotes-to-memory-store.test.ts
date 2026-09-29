/**
 * Defect 5, memory ingest/retrieval gap.
 *
 * Root cause: the `state` tool's `mode=memory action=set` wrote a preference ONLY to a flat
 * `.goodvibes/memory/*.json` file, while passive per-turn knowledge injection reads ONLY the
 * SQLite `memory_records` store. Two disjoint substrates with no bridge, so a "distilled"
 * preference was invisible to retrieval, the model couldn't answer it after a /reset.
 *
 * Fix (Option A): `set` also upserts a retrievable `memory_records` row (deduped per key, honest
 * `file` provenance, reviewState 'fresh' so it is not stamped as trusted). These tests prove the
 * record now exists, is retrievable by the passive-injection path, dedups on rewrite, and that the
 * flat-file write is unaffected (and still works with no registry wired).
 */
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateTool } from '../sdk/src/platform/tools/state/index.js';
import { KVState } from '../sdk/src/platform/state/kv-state.js';
import { ProjectIndex } from '../sdk/src/platform/state/project-index.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
} from '../sdk/src/platform/state/index.js';
import {
  buildPerTurnKnowledgeInjection,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
} from '../sdk/src/platform/agents/turn-knowledge-injection.js';
import { memoryReadingsPort } from './_helpers/memory-readings.ts';
import { toolReadingsPort, type ToolReadingTable } from './_helpers/tool-readings.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';

// Memory search and knowledge ranking read through the judgment port, and so
// does the class a new mirrored record is filed under
// (engine.tools.memory-class); the fakes answer them. A memory no entry names
// reads as a fact.
const CLASS_READINGS: ToolReadingTable = [['dark dashboard theme', { memoryClass: 'constraint' }]];

function statePort(classPort: JudgmentPort = toolReadingsPort(CLASS_READINGS).port): JudgmentPort {
  const memory = memoryReadingsPort().port;
  return {
    model: memory.model,
    ask: (request) => ('memory_class' in request.questions ? classPort.ask(request) : memory.ask(request)),
  };
}

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(statePort());
});
afterEach(() => {
  installJudgmentPort(previousPort);
});

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function makeHarness(opts: { withRegistry: boolean }): Promise<{
  tool: ReturnType<typeof createStateTool>;
  memoryRegistry: MemoryRegistry;
  memoryDir: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'gv-state-memory-promote-'));
  tmpRoots.push(root);
  const memoryDir = join(root, '.goodvibes', 'memory');
  mkdirSync(memoryDir, { recursive: true });

  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
  await memoryStore.init();
  const memoryRegistry = new MemoryRegistry(memoryStore);

  const kvState = new KVState({ stateDir: join(root, 'state') });
  const projectIndex = new ProjectIndex(root);
  const tool = createStateTool(kvState, projectIndex, {
    memoryDir,
    workingDir: root,
    ...(opts.withRegistry ? { memoryRegistry } : {}),
  });
  return { tool, memoryRegistry, memoryDir };
}

describe('state tool: mode=memory set mirrors into the retrievable memory store', () => {
  test('a set preference becomes a fresh, honestly-provenanced memory_record that passive injection surfaces', async () => {
    const { tool, memoryRegistry, memoryDir } = await makeHarness({ withRegistry: true });

    const result = await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'dashboard_prefs',
      memoryValue: 'The user prefers a dark dashboard theme and compact spacing.',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"retrievable":true');
    // Flat file, the source of truth for mode=memory list/get, is still written.
    expect(existsSync(join(memoryDir, 'dashboard_prefs.json'))).toBe(true);

    // 1. The record now exists in the store passive injection reads.
    const records = memoryRegistry.getAll();
    const rec = records.find((r) => r.tags.includes('state-memory:dashboard_prefs'));
    expect(rec).toBeDefined();
    expect(rec!.summary).toContain('dark dashboard theme');

    // 2. Provenance honesty: reviewState 'fresh' (not stamped reviewed), retrievable confidence,
    //    and a file link back to the flat-file twin.
    expect(rec!.reviewState).toBe('fresh');
    // The class is the memory-class reading's, not a fixed class.
    expect(rec!.cls).toBe('constraint');
    expect(rec!.confidence).toBeGreaterThanOrEqual(55);
    expect(rec!.provenance.some((link) => link.kind === 'file' && link.ref.includes('dashboard_prefs'))).toBe(true);

    // 3. The passive per-turn injection path surfaces it on a turn whose query matches.
    const { block, record } = await buildPerTurnKnowledgeInjection({
      memoryRegistry,
      task: 'Assist the user with the dashboard.',
      conversationTail: [{ role: 'user', content: 'What dashboard theme and spacing should I use?' }],
      budgetTokens: 800,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(block).not.toBeNull();
    expect(record.injectedIds).toContain(rec!.id);
    expect(block).toContain('dark dashboard theme');
  });

  test('rewriting the same key updates the single record instead of piling up duplicates', async () => {
    const { tool, memoryRegistry } = await makeHarness({ withRegistry: true });

    await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'dashboard_prefs',
      memoryValue: 'The user prefers a dark dashboard theme.',
    });
    await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'dashboard_prefs',
      memoryValue: 'The user now prefers a dark dashboard theme with a spacious layout.',
    });

    const forKey = memoryRegistry.getAll().filter((r) => r.tags.includes('state-memory:dashboard_prefs'));
    expect(forKey).toHaveLength(1);
    // The single record reflects the latest write.
    expect(forKey[0]!.summary).toContain('spacious layout');
  });

  test('a memory-class reading that escalates files the record as a fact', async () => {
    const unsure = toolReadingsPort([]).port;
    installJudgmentPort(statePort({
      model: unsure.model,
      async ask(request) {
        const answered = await unsure.ask(request);
        const [name] = Object.keys(request.questions);
        const probabilities = { decision: 0.3, constraint: 0.3, fact: 0.4 };
        return { ...answered, answers: { [name!]: { type: 'choice', choice: 'fact', confidence: 0.4, probabilities } } as never };
      },
    }));
    const { tool, memoryRegistry } = await makeHarness({ withRegistry: true });

    await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'build_notes', memoryValue: 'Maybe the build is slow on CI sometimes.' });

    const rec = memoryRegistry.getAll().find((r) => r.tags.includes('state-memory:build_notes'));
    expect(rec?.cls).toBe('fact');
  });

  test('when Jev cannot read the class, the set fails before anything is written', async () => {
    installJudgmentPort(statePort({
      model: 'jev-1.13.0',
      ask: async () => {
        throw new JudgmentError('unavailable', 'no answer');
      },
    }));
    const { tool, memoryRegistry, memoryDir } = await makeHarness({ withRegistry: true });

    const result = await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'owner', memoryValue: 'The billing module is owned by the payments team.' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Memory set failed');
    expect(existsSync(join(memoryDir, 'owner.json'))).toBe(false);
    expect(memoryRegistry.getAll().some((r) => r.tags.includes('state-memory:owner'))).toBe(false);
  });

  test('with no registry wired, set still writes the flat file and reports retrievable:false (back-compat)', async () => {
    const { tool, memoryDir } = await makeHarness({ withRegistry: false });

    const result = await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'legacy_pref',
      memoryValue: 'A preference stored without a memory registry present.',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"retrievable":false');
    expect(existsSync(join(memoryDir, 'legacy_pref.json'))).toBe(true);
  });
});
