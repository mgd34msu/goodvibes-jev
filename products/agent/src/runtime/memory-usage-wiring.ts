import {
  MemoryUsageStatsStore,
  detectReferencedMemoryIds,
  type MemoryRegistry,
  type MemoryConsolidationUsageSignal,
  type MemoryReferenceInput,
} from '@goodvibes-jev/engine/sdk/platform/state';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { PromptContextReceiptDraft } from '../agent/prompt-context-receipts.ts';

/**
 * Ties the two ends of a turn together for usage-outcome instrumentation:
 * records which memory ids were injected when a prompt is composed, then when the
 * turn completes runs reference detection over the model's output to
 * mark which of those injections were plausibly used. Aborted turns (error or
 * cancel) simply forget the injection, no reference credit is invented.
 */
export function extractInjectedMemoryIds(receipt: PromptContextReceiptDraft): string[] {
  const segment = receipt.segments.find((entry) => entry.id === 'memory');
  const selected = segment?.selected ?? [];
  const ids: string[] = [];
  for (const entry of selected) {
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) ids.push(id);
  }
  return ids;
}

export class MemoryUsageTracker {
  private readonly injectedByTurn = new Map<string, { readonly records: readonly MemoryReferenceInput[]; readonly controller: AbortController; started: boolean }>();

  public constructor(
    private readonly store: MemoryUsageStatsStore,
    private readonly memoryRegistry: MemoryRegistry,
  ) {}

  /** At prompt composition: count the injection and remember it for this turn. */
  public onComposed(turnId: string | null, receipt: PromptContextReceiptDraft): void {
    if (turnId) this.onTurnAborted(turnId);
    const ids = extractInjectedMemoryIds(receipt);
    if (ids.length === 0) return;
    this.store.recordInjected(ids);
    if (turnId) {
      const records = ids.flatMap(id => {
        const record = this.memoryRegistry.get(id);
        return record ? [{ id: record.id, summary: record.summary, detail: record.detail }] : [];
      });
      this.injectedByTurn.set(turnId, { records, controller: new AbortController(), started: false });
    }
  }

  /** At turn completion: detect which injected memories the output plausibly used. */
  public async onTurnCompleted(turnId: string, response: string): Promise<void> {
    const turn = this.injectedByTurn.get(turnId);
    if (!turn || turn.started) return;
    turn.started = true;
    const assertCurrent = () => {
      turn.controller.signal.throwIfAborted();
      if (this.injectedByTurn.get(turnId) !== turn) throw new Error('Memory usage turn is no longer current.');
      for (const original of turn.records) {
        const current = this.memoryRegistry.get(original.id);
        if (!current || current.summary !== original.summary || current.detail !== original.detail) throw new Error('Injected memory changed before usage could be credited.');
      }
    };
    try {
      const result = await detectReferencedMemoryIds(response, turn.records, { signal: turn.controller.signal, assertCurrent });
      result.assertCurrent();
      if (result.referenced.length > 0) this.store.recordReferenced(result.referenced);
    } catch (error) {
      if (!turn.controller.signal.aborted) throw error;
    } finally {
      if (this.injectedByTurn.get(turnId) === turn) this.injectedByTurn.delete(turnId);
      turn.controller.abort();
    }
  }

  /** At turn error/cancel: forget the injection without crediting a reference. */
  public onTurnAborted(turnId: string): void {
    this.injectedByTurn.get(turnId)?.controller.abort();
    this.injectedByTurn.delete(turnId);
  }

  /** Consolidation decay-ordering seam. */
  public lookup(id: string): MemoryConsolidationUsageSignal | undefined {
    return this.store.lookup(id);
  }
}

export function createMemoryUsageTracker(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry): MemoryUsageTracker {
  const store = new MemoryUsageStatsStore(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'memory-usage.json'));
  return new MemoryUsageTracker(store, memoryRegistry);
}
