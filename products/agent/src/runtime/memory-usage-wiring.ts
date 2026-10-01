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
 * turn completes runs heuristic reference detection over the model's output to
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
  private readonly injectedByTurn = new Map<string, readonly string[]>();

  public constructor(
    private readonly store: MemoryUsageStatsStore,
    private readonly memoryRegistry: MemoryRegistry,
  ) {}

  /** At prompt composition: count the injection and remember it for this turn. */
  public onComposed(turnId: string | null, receipt: PromptContextReceiptDraft): void {
    const ids = extractInjectedMemoryIds(receipt);
    if (ids.length === 0) return;
    this.store.recordInjected(ids);
    if (turnId) this.injectedByTurn.set(turnId, ids);
  }

  /** At turn completion: detect which injected memories the output plausibly used. */
  public onTurnCompleted(turnId: string, response: string): void {
    const ids = this.injectedByTurn.get(turnId);
    this.injectedByTurn.delete(turnId);
    if (!ids || ids.length === 0) return;
    const records: MemoryReferenceInput[] = [];
    for (const id of ids) {
      const record = this.memoryRegistry.get(id);
      if (record) records.push({ id: record.id, summary: record.summary, detail: record.detail });
    }
    if (records.length === 0) return;
    const result = detectReferencedMemoryIds(response, records);
    if (result.referenced.length > 0) this.store.recordReferenced(result.referenced);
  }

  /** At turn error/cancel: forget the injection without crediting a reference. */
  public onTurnAborted(turnId: string): void {
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
