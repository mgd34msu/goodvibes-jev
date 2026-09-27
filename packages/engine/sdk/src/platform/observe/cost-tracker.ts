/**
 * CostTracker, the per-session and per-agent cost tracking data model.
 *
 * Hoisted from goodvibes-tui's CostTrackerPanel (src/panels/cost-tracker-panel.ts),
 * which kept this state inside the panel: the session's cumulative usage and
 * model, a rolling per-refresh cost-delta history (the panel's sparkline), and
 * one row per spawned agent filled in from the agent's own usage record. The
 * panel keeps its view, keys and budget and price entry; the numbers it shows
 * come from here. Every figure is token arithmetic priced through
 * calcSessionCost, the one session cost formula; nothing here is a judgment.
 */

import type { AgentEvent, TurnEvent } from '../runtime/events/index.js';
import { calcSessionCost } from '../providers/session-cost.js';
import type { AgentRecord } from '../tools/agent/record.js';
import type { UiEventFeed } from '../runtime/ui-events.js';

/** Cumulative session token counters. */
export interface CostTrackerUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** One spawned agent's cost row. */
export interface TrackedAgentCost {
  /** The full agent id. */
  readonly agentId: string;
  /** The first eight characters, the form the Cost panel shows. */
  readonly shortId: string;
  readonly task: string;
  readonly model: string;
  /** Fresh input plus cache-read and cache-write tokens. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly status: 'running' | 'done' | 'failed';
}

/** Prices cumulative token counters for a model, in USD. */
export type SessionPricer = (input: number, output: number, cacheRead: number, cacheWrite: number, model: string) => number;

export interface CostTrackerOptions {
  /** The agent record for an id, for real usage on completion and while running; without it agent rows stay at zero (usage unavailable). */
  readonly getAgentStatus?: ((agentId: string) => AgentRecord | null) | undefined;
  /** Session pricing; calcSessionCost by default. */
  readonly price?: SessionPricer | undefined;
  /** Cost deltas kept for the history; 16 by default, the Cost panel's sparkline width. */
  readonly historyLength?: number | undefined;
}

/** The Cost panel's sparkline width. */
export const COST_HISTORY_LENGTH = 16;
const SHORT_ID_LENGTH = 8;
const EMPTY_USAGE: CostTrackerUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type MutableAgentCost = { -readonly [K in keyof TrackedAgentCost]: TrackedAgentCost[K] };

export class CostTracker {
  private usage: CostTrackerUsage = EMPTY_USAGE;
  private model = 'unknown';
  private history: number[] = [];
  private lastSessionCost = 0;
  private readonly agentRows = new Map<string, MutableAgentCost>();
  private readonly subscribers = new Set<() => void>();
  private readonly price: SessionPricer;
  private readonly historyLength: number;
  private readonly getAgentStatus: ((agentId: string) => AgentRecord | null) | undefined;

  constructor(options: CostTrackerOptions = {}) {
    this.price = options.price ?? calcSessionCost;
    this.historyLength = options.historyLength ?? COST_HISTORY_LENGTH;
    this.getAgentStatus = options.getAgentStatus;
  }

  /**
   * Follows the turn and agent feeds: every completed turn and every LLM
   * response refreshes the session from `getUsage` (a turn can span many
   * calls, so the meter moves mid-turn), and agent spawn, completion and
   * failure keep the agent rows. Returns the detach.
   */
  attach(turns: UiEventFeed<TurnEvent>, agents: UiEventFeed<AgentEvent>, getUsage: () => CostTrackerUsage & { readonly model?: string | undefined }): () => void {
    const detach = [
      turns.on('TURN_COMPLETED', () => this.refreshSession(getUsage())),
      turns.on('LLM_RESPONSE_RECEIVED', () => this.refreshSession(getUsage())),
      agents.on('AGENT_SPAWNING', (payload) => this.agentSpawned(payload.agentId, payload.task)),
      agents.on('AGENT_COMPLETED', (payload) => this.agentCompleted(payload.agentId)),
      agents.on('AGENT_FAILED', (payload) => this.agentFailed(payload.agentId)),
    ];
    return () => {
      for (const off of detach) off();
    };
  }

  /** Takes the session's cumulative usage and records the cost added since the last refresh. */
  refreshSession(usage: CostTrackerUsage & { readonly model?: string | undefined }): void {
    this.takeUsage(usage);
    const total = this.sessionCost();
    this.history.push(Math.max(0, total - this.lastSessionCost));
    this.lastSessionCost = total;
    if (this.history.length > this.historyLength) this.history.shift();
    this.notify();
  }

  /** Takes the session's cumulative counters without recording a history point or changing the model (the panel's sync on activation). */
  syncSession(usage: CostTrackerUsage): void {
    this.takeUsage({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
    this.notify();
  }

  private takeUsage(usage: CostTrackerUsage & { readonly model?: string | undefined }): void {
    this.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
    if (usage.model) this.model = usage.model;
  }

  agentSpawned(agentId: string, task: string): void {
    this.agentRows.set(agentId, {
      agentId,
      shortId: agentId.slice(0, SHORT_ID_LENGTH),
      task,
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      status: 'running',
    });
    this.notify();
  }

  /** Marks the agent done and takes its real usage from its record when one is available. */
  agentCompleted(agentId: string): void {
    const row = this.agentRows.get(agentId);
    if (!row) return;
    row.status = 'done';
    const record = this.getAgentStatus?.(agentId);
    if (record?.usage) this.applyUsage(row, record, record.model ?? 'unknown');
    this.notify();
  }

  agentFailed(agentId: string): void {
    const row = this.agentRows.get(agentId);
    if (!row) return;
    row.status = 'failed';
    this.notify();
  }

  /**
   * Fills in usage for agents still running, so a long agent does not show
   * zero for its whole life. Returns whether anything changed.
   */
  pollRunningAgents(): boolean {
    if (!this.getAgentStatus) return false;
    let changed = false;
    for (const [agentId, row] of this.agentRows) {
      if (row.status !== 'running') continue;
      const record = this.getAgentStatus(agentId);
      if (!record?.usage) continue;
      const before = { ...row };
      this.applyUsage(row, record, record.model ?? row.model);
      if (before.inputTokens !== row.inputTokens || before.outputTokens !== row.outputTokens || before.cost !== row.cost || before.model !== row.model) changed = true;
    }
    if (changed) this.notify();
    return changed;
  }

  private applyUsage(row: MutableAgentCost, record: AgentRecord, pricedModel: string): void {
    const usage = record.usage!;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    row.inputTokens = usage.inputTokens + cacheRead + cacheWrite;
    row.outputTokens = usage.outputTokens;
    row.cost = this.price(usage.inputTokens, usage.outputTokens, cacheRead, cacheWrite, pricedModel);
    if (record.model && record.model !== 'unknown') row.model = record.model;
  }

  sessionUsage(): CostTrackerUsage { return this.usage; }
  sessionModel(): string { return this.model; }
  /** The session's cost so far, priced on its current model. */
  sessionCost(): number {
    const { input, output, cacheRead, cacheWrite } = this.usage;
    return this.price(input, output, cacheRead, cacheWrite, this.model);
  }
  /** Cost added per refresh, oldest first, at most the history length. */
  costHistory(): readonly number[] { return this.history; }
  /** Agent rows in spawn order. */
  agents(): readonly TrackedAgentCost[] { return [...this.agentRows.values()]; }
  /** Sum of every agent row's cost. */
  agentsCost(): number { return [...this.agentRows.values()].reduce((sum, row) => sum + row.cost, 0); }

  /** Calls `cb` after every change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }
}
