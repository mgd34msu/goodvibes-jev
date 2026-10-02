import { useMemoryReadings } from '../helpers/memory-readings.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { buildRecallSnapshot, createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { AgentPromptContextReceiptStore, composeRuntimePromptWithReceipt } from '../../agent/prompt-context-receipts.ts';
import { importVibeFilesIntoMemoryOnce } from '../../agent/vibe-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function withReceiptFixture<T>(
  fn: (fixture: {
    readonly root: string;
    readonly shellPaths: ReturnType<typeof createShellPathService>;
    readonly memoryRegistry: MemoryRegistry;
  }) => Promise<T>,
): Promise<T> {
  const root = makeProjectTempDir('goodvibes-agent-prompt-receipts');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: join(home, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: workspace,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  const memoryRegistry = new MemoryRegistry(store);
  try {
    return await fn({ root, shellPaths, memoryRegistry });
  } finally {
    await store.save();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

useMemoryReadings();

describe('prompt context receipts', () => {
  test('composes the runtime prompt and records sanitized selected context', async () => {
    await withReceiptFixture(async ({ root, shellPaths, memoryRegistry }) => {
      writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
        '---',
        'name: Project Vibe',
        '---',
        '- Be direct and make the next user action obvious.',
      ].join('\n'));
      writeFileSync(join(shellPaths.workingDirectory, 'AGENTS.md'), 'Prefer visible autonomous work and reviewable local records.');

      // VIBE.md is now a PROJECTION of persona records, migrate the file into
      // the store (as boot does) so the projected '## GoodVibes Agent VIBE.md' block renders.
      // importVibeFilesIntoMemoryOnce writes through the memory-spine's MemoryAccess
      // surface in production (services.memorySpineClient); wrap the local registry
      // the same way here.
      await importVibeFilesIntoMemoryOnce(createLocalMemoryAccess(memoryRegistry), shellPaths);

      const reviewed = await memoryRegistry.add({
        scope: 'project',
        cls: 'constraint',
        summary: 'Use only Agent-local knowledge routes.',
        provenance: [{ kind: 'event', ref: 'receipt-test' }],
      });
      const lowConfidence = await memoryRegistry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'Low-confidence records should not enter the prompt.',
        provenance: [{ kind: 'event', ref: 'receipt-low-confidence' }],
      });
      memoryRegistry.review(reviewed.id, { state: 'reviewed', confidence: 94, reviewedBy: 'test' });
      memoryRegistry.review(lowConfidence.id, { state: 'reviewed', confidence: 25, reviewedBy: 'test' });

      const composed = await composeRuntimePromptWithReceipt({
        sessionId: 'session-receipts',
        turnId: 'turn-receipts',
        source: 'turn',
        provider: 'openai',
        model: { registryKey: 'openai:gpt-4.1', id: 'gpt-4.1' },
        contextWindow: 128_000,
        tierPrompt: '',
        runtimePrompt: 'Base runtime prompt.',
        operatorPolicy: 'Operator policy prompt.',
        shellPaths,
        memoryRegistry,
      });

      expect(composed.prompt).toContain('Base runtime prompt.');
      expect(composed.prompt).toContain('GoodVibes Agent VIBE.md');
      expect(composed.prompt).toContain('Project Context Files');
      expect(composed.prompt).toContain('Operator policy prompt.');
      expect(composed.prompt).toContain('Reviewed GoodVibes Agent Memory');

      const receipt = composed.receipt;
      expect(receipt.turnId).toBe('turn-receipts');
      expect(receipt.model).toBe('openai:gpt-4.1');
      expect(receipt.promptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.promptChars).toBe(composed.prompt.length);
      expect(receipt.activeRecords).toBeGreaterThan(3);
      expect(receipt.suppressedRecords).toBeGreaterThan(0);

      const memorySegment = receipt.segments.find((segment) => segment.id === 'memory');
      expect(memorySegment?.status).toBe('attention');
      expect(memorySegment?.selected?.some((entry) => entry.id === reviewed.id)).toBe(true);
      expect(memorySegment?.suppressed?.some((entry) => entry.id === lowConfidence.id && String(entry.reason).includes('confidence'))).toBe(true);
      expect(String(memorySegment?.selected?.[0]?.summary ?? '')).toBe('');

      const receiptPath = join(root, 'prompt-context-receipts.jsonl');
      const store = new AgentPromptContextReceiptStore(receiptPath);
      const stored = store.record(receipt);
      const outcome = store.recordTurnOutcome({
        turnId: 'turn-receipts',
        status: 'completed',
        terminalEvent: 'TURN_COMPLETED',
        stopReason: 'completed',
        completedAt: 1_700_000_000_000,
      });
      const reloaded = new AgentPromptContextReceiptStore(receiptPath);

      expect(outcome?.receiptIds).toContain(stored.receiptId);
      expect(store.latest()?.receiptId).toBe(stored.receiptId);
      expect(store.latest()?.turnOutcome?.status).toBe('completed');
      expect(reloaded.latest()?.receiptId).toBe(stored.receiptId);
      expect(reloaded.latest()?.promptHash).toBe(receipt.promptHash);
      expect(reloaded.latest()?.turnOutcome?.terminalEvent).toBe('TURN_COMPLETED');
    });
  });

  test('ranks the memory segment by relevance to the current turn text, with honest per-record wording', async () => {
    await withReceiptFixture(async ({ shellPaths, memoryRegistry }) => {
      const onTopic = await memoryRegistry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'The deploy pipeline requires a green typecheck before merge.',
        provenance: [{ kind: 'event', ref: 'on-topic' }],
      });
      const offTopic = await memoryRegistry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'User prefers herbal tea over coffee in the afternoon.',
        provenance: [{ kind: 'event', ref: 'off-topic' }],
      });
      memoryRegistry.review(onTopic.id, { state: 'reviewed', confidence: 61, reviewedBy: 'test' });
      memoryRegistry.review(offTopic.id, { state: 'reviewed', confidence: 95, reviewedBy: 'test' });

      const composed = await composeRuntimePromptWithReceipt({
        sessionId: 'session-relevance',
        turnId: 'turn-relevance',
        source: 'turn',
        provider: 'openai',
        model: { registryKey: 'openai:gpt-4.1', id: 'gpt-4.1' },
        contextWindow: 128_000,
        tierPrompt: '',
        runtimePrompt: 'Base runtime prompt.',
        operatorPolicy: 'Operator policy prompt.',
        shellPaths,
        memoryRegistry,
        turnText: 'what does the deploy pipeline require before merge',
      });

      const memorySegment = composed.receipt.segments.find((segment) => segment.id === 'memory');
      expect(memorySegment?.note).toBeUndefined();
      const onTopicSelected = memorySegment?.selected?.find((entry) => entry.id === onTopic.id);
      const offTopicSelected = memorySegment?.selected?.find((entry) => entry.id === offTopic.id);
      // F7a: the raw percent is paired with a qualitative band so a genuinely-lower
      // score doesn't read as noise on its own.
      expect(String(onTopicSelected?.relevance ?? '')).toMatch(/^relevance to this turn: \d+% \((high|moderate|low) match\)$/);
      expect(String(offTopicSelected?.relevance ?? '')).toMatch(/^relevance to this turn: \d+% \((high|moderate|low) match\)$/);
      const onTopicPercent = Number(String(onTopicSelected?.relevance).match(/(\d+)%/)?.[1] ?? '0');
      const offTopicPercent = Number(String(offTopicSelected?.relevance).match(/(\d+)%/)?.[1] ?? '0');
      expect(onTopicPercent).toBeGreaterThan(offTopicPercent);

      // The actual injected prompt (not just the receipt) is ranked the same way, the
      // real seam this closes is the injected content, not only what gets reported.
      expect(composed.prompt.indexOf('deploy pipeline')).toBeLessThan(composed.prompt.indexOf('herbal tea'));
    });
  });

  test('degrades the memory segment honestly (stated reason, no relevance field) when no turn text is supplied', async () => {
    await withReceiptFixture(async ({ shellPaths, memoryRegistry }) => {
      const fact = await memoryRegistry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'A fact recorded with no active turn to rank against.',
        provenance: [{ kind: 'event', ref: 'no-turn' }],
      });
      memoryRegistry.review(fact.id, { state: 'reviewed', confidence: 80, reviewedBy: 'test' });

      const composed = await composeRuntimePromptWithReceipt({
        sessionId: 'session-no-turn-text',
        turnId: null,
        source: 'follow_up',
        provider: 'openai',
        model: 'openai:gpt-4.1',
        contextWindow: 128_000,
        tierPrompt: '',
        runtimePrompt: 'Base runtime prompt.',
        operatorPolicy: 'Operator policy prompt.',
        shellPaths,
        memoryRegistry,
      });

      const memorySegment = composed.receipt.segments.find((segment) => segment.id === 'memory');
      expect(memorySegment?.note).toContain('no current-turn text');
      const selected = memorySegment?.selected?.find((entry) => entry.id === fact.id);
      expect(selected).toBeDefined();
      expect(selected?.relevance).toBeUndefined();
    });
  });

  // Cross-checks the SDK's reworded recall-snapshot note (recall-snapshot.ts:
  // humanized age, honest "browse set (unfiltered)" vs "recall-eligible" count
  // clause) against the memory segment's own activeCount/suppressedCount, for
  // the exact wire-sourced shape services.memorySpineClient.recallSnapshot()
  // hands to composeRuntimePromptWithReceipt in production (bootstrap.ts). The
  // agent refreshes with `{ recall: false }` (an unfiltered browse set,
  // matching the old getAll() semantics, see the SYNC-RECALL SEAM comment on
  // RuntimePromptCompositionInput.memoryRecallSnapshot) precisely so the
  // receipt's own eligibility/ranking pipeline keeps deciding what's active vs
  // suppressed and WHY, rather than pre-filtering at the recall floor and
  // losing the "eligible but outside the top-10 slice" vs "ineligible"
  // distinction the suppressed list reports per record.
  describe('memory recall snapshot note coherence (2026-07 SDK reword)', () => {
    test('a wire-sourced (mode: client) unfiltered snapshot note and the memory segment counts tell one coherent story', async () => {
      await withReceiptFixture(async ({ shellPaths, memoryRegistry }) => {
        const reviewed = await memoryRegistry.add({
          scope: 'project',
          cls: 'fact',
          summary: 'A record that clears the prompt-eligibility bar.',
          provenance: [{ kind: 'event', ref: 'coherence-eligible' }],
        });
        const lowConfidence = await memoryRegistry.add({
          scope: 'project',
          cls: 'fact',
          summary: 'A record that does not clear the prompt-eligibility bar.',
          provenance: [{ kind: 'event', ref: 'coherence-ineligible' }],
        });
        memoryRegistry.review(reviewed.id, { state: 'reviewed', confidence: 92, reviewedBy: 'test' });
        memoryRegistry.review(lowConfidence.id, { state: 'reviewed', confidence: 20, reviewedBy: 'test' });

        // Mirrors bootstrap.ts exactly: refresh with { recall: false } over
        // honestSearch, then hand the snapshot in as mode 'client', the
        // agent stamps 'client' whenever a daemon is adopted; this fixture
        // has no daemon, so the mode is set explicitly to exercise that path
        // (recallSnapshotNote only surfaces the SDK note for 'client' or
        // stale snapshots, see memoryRecallSnapshotNote in
        // prompt-context-receipts.ts).
        const browseSet = await memoryRegistry.honestSearch({}, { recall: false });
        expect(browseSet.recallFiltered).toBe(false);
        const snapshot = buildRecallSnapshot(browseSet, 'client', Date.now(), 30_000);

        const composed = await composeRuntimePromptWithReceipt({
          sessionId: 'session-recall-snapshot-coherence',
          turnId: 'turn-recall-snapshot-coherence',
          source: 'turn',
          provider: 'openai',
          model: { registryKey: 'openai:gpt-4.1', id: 'gpt-4.1' },
          contextWindow: 128_000,
          tierPrompt: '',
        runtimePrompt: 'Base runtime prompt.',
          operatorPolicy: 'Operator policy prompt.',
          shellPaths,
          memoryRegistry,
          memoryRecallSnapshot: snapshot,
        });

        const memorySegment = composed.receipt.segments.find((segment) => segment.id === 'memory');
        expect(memorySegment).toBeDefined();

        // The note must be present (mode 'client') and must honestly say this
        // was an UNFILTERED browse set, not a recall-eligible count, the
        // exact reword this test locks in.
        expect(memorySegment?.note).toContain('over the wire from the adopted daemon');
        expect(memorySegment?.note).toContain('in the browse set (unfiltered, recall floor not applied)');
        expect(memorySegment?.note).not.toContain('recall-eligible');
        // Humanized age (whole seconds), not raw milliseconds.
        expect(memorySegment?.note).toMatch(/captured \d+s ago/);

        // Coherence: the note's own record count must equal EVERY record the
        // memory segment accounted for (active + suppressed), the segment's
        // own local eligibility/ranking filter re-partitions the exact same
        // browse set the note describes, it never drops or adds records.
        const noteCount = Number(memorySegment?.note?.match(/(\d+) record\(s\) in the browse set/)?.[1] ?? -1);
        expect(noteCount).toBe(browseSet.records.length);
        expect((memorySegment?.activeCount ?? 0) + (memorySegment?.suppressedCount ?? 0)).toBe(noteCount);

        // And the two records placed in the fixture land on the honest sides
        // of that partition: the reviewed high-confidence record is active,
        // the low-confidence one is suppressed with its own real reason.
        expect(memorySegment?.selected?.some((entry) => entry.id === reviewed.id)).toBe(true);
        expect(memorySegment?.suppressed?.some((entry) => entry.id === lowConfidence.id)).toBe(true);
      });
    });

    test('a recall-filtered (recall: true) snapshot would report "recall-eligible", not "browse set": documenting why the agent stays on recall:false', async () => {
      await withReceiptFixture(async ({ memoryRegistry }) => {
        const reviewed = await memoryRegistry.add({
          scope: 'project',
          cls: 'fact',
          summary: 'A record that clears the prompt-eligibility bar.',
          provenance: [{ kind: 'event', ref: 'coherence-recall-true' }],
        });
        memoryRegistry.review(reviewed.id, { state: 'reviewed', confidence: 92, reviewedBy: 'test' });

        const recallFilteredResult = await memoryRegistry.honestSearch({}, { recall: true });
        expect(recallFilteredResult.recallFiltered).toBe(true);
        const snapshot = buildRecallSnapshot(recallFilteredResult, 'client', Date.now(), 30_000);

        // recall:true already dropped flagged/sub-floor records BEFORE this
        // snapshot exists, so a record excluded by the recall floor would
        // never reach the receipt's own suppressed list with a per-record
        // reason at all, it would simply be absent, which is exactly the
        // granularity loss the SYNC-RECALL SEAM comment on
        // RuntimePromptCompositionInput.memoryRecallSnapshot rules out. This
        // assertion documents the wording difference the ruling rests on,
        // not a recommendation to switch.
        expect(snapshot.note).toContain('recall-eligible');
        expect(snapshot.note).not.toContain('browse set');
      });
    });
  });
});
