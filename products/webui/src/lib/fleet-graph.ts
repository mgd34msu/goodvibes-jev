/**
 * fleet-graph.ts, display helpers for fleet.graph.get (SDK 1.8.0's fix-phase
 * workstream rework): the dependency-graph view of one workstream (nodes,
 * edges, elastic-pool state).
 *
 * Node `state` is a WorkItemState (platform/orchestration/types.ts), a
 * DIFFERENT vocabulary from fleet.snapshot's ProcessState (lib/fleet.ts):
 * this is the work item's own internal scheduling state ('pending' /
 * 'awaiting-capacity' / 'in-phase' / 'passed' / 'failed' / 'blocked-budget' /
 * 'blocked-dependency' / 'blocked-bookkeeping' / 'held-merge'), read as an open string for the same
 * reason lib/fleet.ts reads ProcessState as one: this client is hand-mirrored
 * from the SDK source (contract-bridge-types.ts's generic bridge for
 * fleet.graph.get) rather than generated, so a daemon newer than this client
 * may report a state it has never seen, render it verbatim, never drop it.
 */
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import type { BadgeTone } from './presentation-bridge';

export type FleetGraphResult = OperatorMethodOutput<'fleet.graph.get'>;
export type FleetGraphNode = FleetGraphResult['nodes'][number];
export type FleetGraphPool = FleetGraphResult['pool'];

/** WorkItemState (platform/orchestration/types.ts) at the time this was written. */
export const KNOWN_GRAPH_NODE_STATES = [
  'pending',
  'awaiting-capacity',
  'in-phase',
  'passed',
  'failed',
  'blocked-budget',
  'blocked-dependency',
  'blocked-bookkeeping',
  'held-merge',
] as const;

export function isKnownGraphNodeState(state: string): boolean {
  return (KNOWN_GRAPH_NODE_STATES as readonly string[]).includes(state);
}

/** The plain-language "tell" a task-graph row shows for its state, matches the
 *  brief's own vocabulary (ready/running/blocked/at-cap/stalled) where it maps
 *  cleanly, and states an unknown value verbatim otherwise. */
export function graphNodeStateLabel(state: string): string {
  switch (state) {
    case 'pending': return 'Ready';
    case 'awaiting-capacity': return 'Ready, waiting for a free slot';
    case 'in-phase': return 'Running';
    case 'passed': return 'Done';
    case 'failed': return 'Failed';
    case 'blocked-budget': return 'Blocked';
    case 'blocked-dependency': return 'Blocked';
    case 'blocked-bookkeeping': return 'Held (repository condition unresolved)';
    case 'held-merge': return 'Held (attempts)';
    default: return state.trim() || 'unknown';
  }
}

export function graphNodeStateTone(state: string): BadgeTone {
  switch (state) {
    case 'pending': return 'neutral';
    case 'awaiting-capacity': return 'warning';
    case 'in-phase': return 'ok';
    case 'passed': return 'neutral';
    case 'failed': return 'bad';
    case 'blocked-budget': return 'warning';
    case 'blocked-dependency': return 'warning';
    case 'blocked-bookkeeping': return 'warning';
    case 'held-merge': return 'warning';
    default: return 'warning'; // unknown-to-this-client state, honesty warning, same as lib/fleet.ts
  }
}

/**
 * The pool summary line, verbatim in the brief's own wording:
 * "N ready, M running, at the limit of N running at once", only the limit clause is
 * conditional (pool.atCap). `pool` is null when the daemon reports no elastic
 * pool for this workstream (a fixed-capacity or single-agent run), callers
 * should not render a summary line at all in that case.
 */
export function poolSummaryLabel(pool: NonNullable<FleetGraphPool>): string {
  const base = `${pool.ready} ready, ${pool.running} running`;
  return pool.atCap ? `${base}, at the limit of ${pool.maxSize} running at once` : base;
}
