/**
 * The silence watchdog over unit agents (docs/design/contract-runner.md
 * section 4.10).
 *
 * It keeps a last-seen time per agent from the agent events (running,
 * progress, stream deltas, and the terminal three), as WRFC's listeners did.
 * When `contract.heartbeatTimeoutMs` is above zero, a timer at a quarter of
 * the timeout (between 50 ms and 5 s) looks for unit agents that are running,
 * not held, and silent past the timeout, and hands each to the runner, which
 * retries the unit once and fails it the second time.
 *
 * Time an agent spends held at its completion point is not silence: the
 * runner's check is what it waits on. Releasing a hold restarts the clock.
 * Elapsed time is arithmetic, so all of this is code.
 */
import type { AgentEvent } from '../../events/agents.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

/** A unit agent the watchdog may time: the runner lists them on each tick. */
export interface WatchedAgent {
  readonly contractId: string;
  readonly unitId: string;
  readonly agentId: string;
  /** When the agent was spawned; the clock starts here when no event was seen. */
  readonly startedAt: number;
}

export interface UnitWatchdogDeps {
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  /** `contract.heartbeatTimeoutMs`, read on each (re)start; 0 or less turns the watchdog off. */
  readonly timeoutMs: () => number;
  /** The unit agents that are running now and not held. */
  readonly watched: () => readonly WatchedAgent[];
  /** Called once per silent agent per tick; the runner retries or fails the unit. */
  readonly onSilent: (agent: WatchedAgent, silentMs: number) => void;
  readonly now?: (() => number) | undefined;
}

export interface UnitWatchdog {
  /** The clock restarts for an agent: a hold released, or a fresh agent spawned. */
  touch(agentId: string): void;
  /** Forgets an agent (terminal, or replaced). */
  forget(agentId: string): void;
  /** Runs one check now (tests; the timer calls the same). */
  tick(): void;
  /** Restarts the timer with the current timeout setting. */
  restart(): void;
  dispose(): void;
}

/** The check interval for a timeout: a quarter of it, at least 50 ms and at most 5 s. */
export function watchdogIntervalMs(timeoutMs: number): number {
  return Math.min(5_000, Math.max(50, Math.floor(timeoutMs / 4)));
}

const SEEN_EVENTS = ['AGENT_RUNNING', 'AGENT_PROGRESS', 'AGENT_STREAM_DELTA', 'AGENT_COMPLETED', 'AGENT_FAILED', 'AGENT_CANCELLED'] as const;

export function createUnitWatchdog(deps: UnitWatchdogDeps): UnitWatchdog {
  const now = deps.now ?? Date.now;
  const lastSeen = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const unsubscribers = SEEN_EVENTS.map((type) =>
    deps.runtimeBus.on<Extract<AgentEvent, { type: typeof type }>>(type, ({ payload }) => {
      lastSeen.set(payload.agentId, now());
    }),
  );

  function tick(): void {
    const timeoutMs = deps.timeoutMs();
    if (timeoutMs <= 0) return;
    const at = now();
    for (const agent of deps.watched()) {
      const silentMs = at - (lastSeen.get(agent.agentId) ?? agent.startedAt);
      if (silentMs >= timeoutMs) deps.onSilent(agent, silentMs);
    }
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function restart(): void {
    stop();
    const timeoutMs = deps.timeoutMs();
    if (timeoutMs <= 0) return;
    timer = setInterval(tick, watchdogIntervalMs(timeoutMs));
    timer.unref?.();
  }

  restart();
  return {
    touch: (agentId) => { lastSeen.set(agentId, now()); },
    forget: (agentId) => { lastSeen.delete(agentId); },
    tick,
    restart,
    dispose: () => {
      stop();
      for (const unsubscribe of unsubscribers) unsubscribe();
      lastSeen.clear();
    },
  };
}
