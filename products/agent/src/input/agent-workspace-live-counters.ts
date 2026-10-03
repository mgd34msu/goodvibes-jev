import type { CommandContext } from './command-registry.ts';
import { readLiveAgentMemoryCounters, readLiveAgentRoutineCounters } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

export interface SyncAgentWorkspaceLiveCountersOptions {
  readonly context: CommandContext | null;
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  readonly setRuntimeSnapshot: (snapshot: AgentWorkspaceRuntimeSnapshot) => void;
  readonly clampSelection: () => void;
}

/**
 * Quiet, render-path refresh of the two counters a dogfood finding
 * named as stale: the memory count and the routine counts (incl. each
 * routine's live start count). Call this once per repaint, before rendering,
 * so an external disk mutation (another shell deleting a memory, a CLI
 * `routines start` bumping a start count) shows up on the NEXT paint instead
 * of requiring the user to trigger a workspace action first.
 *
 * Unlike AgentWorkspace.refreshRuntimeSnapshot(), this never touches status
 * or lastActionResult -- it must be safe to call on every passive repaint,
 * including ones triggered by unrelated key presses. It also intentionally
 * does NOT rebuild the entire runtime snapshot (~20 registry/config reads):
 * that full rebuild stays reserved for real action completions elsewhere on
 * AgentWorkspace. Re-deriving just these two counters keeps the render-path
 * cost proportional to "did the memory/routine store change", not to the
 * whole workspace's surface area.
 *
 * On a read failure the previous counters are kept (never overwritten with a
 * fabricated 0) and runtimeSnapshot.liveCountersStale is set so the render
 * path can label them honestly as refreshing rather than asserting a number
 * the disk might already contradict.
 */
export function syncAgentWorkspaceLiveCounters(options: SyncAgentWorkspaceLiveCountersOptions): void {
  const { context, runtimeSnapshot, setRuntimeSnapshot, clampSelection } = options;
  if (!context || !runtimeSnapshot) return;
  try {
    const memory = readLiveAgentMemoryCounters(context);
    const routines = readLiveAgentRoutineCounters(context);
    setRuntimeSnapshot({
      ...runtimeSnapshot,
      localMemoryCount: memory.count,
      localMemoryReviewQueueCount: memory.reviewQueueCount,
      localMemoryPromptActiveCount: memory.promptActiveCount,
      localMemories: memory.items,
      localRoutineCount: routines.count,
      enabledRoutineCount: routines.enabled,
      localRoutines: routines.items,
      liveCountersStale: false,
    });
  } catch {
    setRuntimeSnapshot({ ...runtimeSnapshot, liveCountersStale: true });
  }
  clampSelection();
}
