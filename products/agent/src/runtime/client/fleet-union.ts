/**
 * fleet-union.ts, the Activity modal shows work running anywhere, not only
 * the sub-agents this process spawned.
 *
 * This Agent's `processRegistry` answers for the agents, chains, workflows and
 * background processes started in THIS process. The daemon runs its own,
 * scheduled jobs, channel-driven runs, work other surfaces submitted, and none
 * of it appears in a registry this process owns.
 *
 * The policy lives in the SDK's client seam:
 * `createDaemonFleetRowsPoller` (poll cadence, and keeping the last known rows
 * when a poll fails, so one bad request does not make half the fleet blink out)
 * and `mergeFleetNodes` (local-first, deduped by node id). This module is the
 * Agent's binding of it: a node source the renderer reads, and a stop handle
 * shutdown calls.
 *
 * Local rows win on a shared id. They are live, the registry pushes on every
 * state change, while the daemon's copy arrives on an interval and is
 * necessarily staler.
 *
 * Reading only. Every act the Activity modal can lead to (interrupt, resume, kill,
 * steer) reaches a child process of this one, and a daemon row has no child
 * here to signal; the Agent drives the daemon's own verbs for the acts the
 * daemon serves.
 */
import {
  createDaemonFleetRowsPoller,
  DEFAULT_FLEET_REFRESH_MS,
  mergeFleetNodes,
  type DaemonVerbCaller,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { logger } from '@goodvibes-jev/engine/sdk/platform/utils';

export { DEFAULT_FLEET_REFRESH_MS, mergeFleetNodes };

/** The narrow local source: whatever already answers this process's own nodes. */
export interface LocalFleetNodeSource {
  nodes(): readonly ProcessNode[];
}

export interface AgentFleetUnionOptions {
  readonly local: LocalFleetNodeSource;
  readonly verbs: DaemonVerbCaller;
  readonly refreshIntervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug'>;
}

export interface AgentFleetUnion {
  /** Local nodes, then every daemon node whose id no local node carries. */
  nodes(): readonly ProcessNode[];
  /** True once the daemon has answered at least one poll. */
  hasDaemonRows(): boolean;
  /** Re-read the daemon's rows now. Never throws. */
  refresh(): Promise<void>;
  /** Stop the refresh timer. Idempotent. */
  stop(): void;
}

/**
 * Build the union node source over this process's registry and the adopted
 * daemon's rows.
 *
 * Inert until the first poll lands, and whenever no daemon is configured or one
 * cannot answer: the node list is then exactly the local one, which is the
 * honest answer rather than a degraded one.
 */
export function createAgentFleetUnion(options: AgentFleetUnionOptions): AgentFleetUnion {
  const poller = createDaemonFleetRowsPoller({
    verbs: options.verbs,
    ...(options.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: options.refreshIntervalMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  return {
    nodes(): readonly ProcessNode[] {
      const local = options.local.nodes();
      const daemonRows = poller.rows();
      if (!daemonRows || daemonRows.nodes.length === 0) return local;
      return mergeFleetNodes(local, daemonRows.nodes);
    },
    hasDaemonRows: () => poller.rows() !== null,
    refresh: () => poller.refresh(),
    stop: () => { poller.stop(); },
  };
}
