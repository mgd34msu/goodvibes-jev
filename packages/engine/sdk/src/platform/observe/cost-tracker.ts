/**
 * CostTracker, the per-session and per-agent cost tracking data model.
 *
 * Hoisted from goodvibes-tui's CostTrackerPanel (src/panels/cost-tracker-panel.ts),
 * which kept this state inside the panel: the session's cumulative usage and
 * model, a rolling per-refresh cost-delta history (the panel's sparkline), and
 * one row per spawned agent filled in from the agent's own usage record. The
 * panel keeps its view, keys and budget and price entry; the numbers it shows
 * come from here. Every figure is token arithmetic priced through
 * the shared session-cost quote, the one cost formula; nothing here is a judgment.
 */

import type { AgentEvent, TurnEvent } from '../runtime/events/index.js';
import { resolveSessionCost, type PricingSourceKind, type SessionCostResult } from '../providers/session-cost.js';
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
  readonly status: 'running' | 'done' | 'failed' | 'cancelled';
  /** False when the monetary zero is only an unpriced placeholder. */
  readonly priced: boolean;
  /** Source of the quote used for this row, absent for a custom pricer. */
  readonly pricingSource?: PricingSourceKind | undefined;
  /** Source snapshot date when the pricing provider supplied one. */
  readonly pricingAsOf?: string | undefined;
  /** Owners aggregate their children; their displayed cost is excluded from agentsCost(). */
  readonly contractRole?: AgentRecord['contractRole'];
}

/** Prices cumulative token counters for a model, in USD. */
export type SessionPricer = (input: number, output: number, cacheRead: number, cacheWrite: number, model: string) => number;

export interface CostTrackerOptions {
  /** The agent record for an id, for real usage on completion and while running; without it agent rows stay at zero (usage unavailable). */
  readonly getAgentStatus?: ((agentId: string) => AgentRecord | null) | undefined;
  /** Optional explicit pricing override; treated as priced with no invented provenance. */
  readonly price?: SessionPricer | undefined;
  /** Cost deltas kept for the history; 16 by default, the Cost panel's sparkline width. */
  readonly historyLength?: number | undefined;
  /** Maximum retained rows (200 by default). Evicts oldest terminal details first; running rows and lifetime totals survive. */
  readonly maxAgents?: number | undefined;
}

/** The Cost panel's sparkline width. */
export const COST_HISTORY_LENGTH = 16;
/** Default retained agent-row limit; active work may exceed it. */
export const COST_TRACKER_MAX_AGENTS = 200;
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
  private readonly price: (...args: Parameters<SessionPricer>) => SessionCostResult;
  private readonly maxAgents: number;
  private readonly terminalOrder = new Set<string>();
  /** Cost of retired rows stays in the session total after their detail is evicted. */
  private retiredAgentsCost = 0;
  private retiredUnpricedUsage = false;
  private readonly historyLength: number;
  private readonly getAgentStatus: ((agentId: string) => AgentRecord | null) | undefined;

  constructor(options: CostTrackerOptions = {}) {
    const price = options.price;
    this.price = price ? (...args) => ({ cost: price(...args), priced: true }) : resolveSessionCost;
    this.maxAgents = options.maxAgents ?? COST_TRACKER_MAX_AGENTS;
    if (!Number.isInteger(this.maxAgents) || this.maxAgents < 0) {
      throw new RangeError('CostTracker maxAgents must be a non-negative integer');
    }
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
      agents.on('AGENT_CANCELLED', (payload) => this.agentCancelled(payload.agentId)),
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
    if (this.agentRows.has(agentId)) return;
    const record = this.getAgentStatus?.(agentId);
    this.agentRows.set(agentId, {
      agentId,
      shortId: agentId.slice(0, SHORT_ID_LENGTH),
      task,
      model: record?.model ?? 'unknown',
      contractRole: record?.contractRole,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      priced: false,
      status: 'running',
    });
    this.trimAgents();
    this.notify();
  }

  /** Records final usage and the terminal outcome. Cancellation is never changed into success or failure. */
  agentCompleted(agentId: string): void { this.finishAgent(agentId, 'done'); }
  /** Capture final usage on failure, preserving an already recorded cancellation. */
  agentFailed(agentId: string): void { this.finishAgent(agentId, 'failed'); }
  /** Capture final usage and retain cancellation as its own terminal state. */
  agentCancelled(agentId: string): void { this.finishAgent(agentId, 'cancelled'); }

  private finishAgent(agentId: string, status: 'done' | 'failed' | 'cancelled'): void {
    const row = this.agentRows.get(agentId);
    if (!row) return;
    if (row.status !== 'cancelled') row.status = status;
    const record = this.getAgentStatus?.(agentId);
    if (record) this.applyUsage(row, record);
    this.terminalOrder.add(agentId);
    this.trimAgents();
    this.notify();
  }

  private trimAgents(): void {
    for (const agentId of this.terminalOrder) {
      if (this.agentRows.size <= this.maxAgents) break;
      const row = this.agentRows.get(agentId);
      if (row && row.contractRole !== 'owner') {
        this.retiredAgentsCost += row.cost;
        this.retiredUnpricedUsage ||= !row.priced && row.inputTokens + row.outputTokens > 0;
      }
      this.agentRows.delete(agentId);
      this.terminalOrder.delete(agentId);
    }
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
      if (!record) continue;
      const before = { ...row };
      this.applyUsage(row, record);
      if (
        before.inputTokens !== row.inputTokens || before.outputTokens !== row.outputTokens
        || before.cost !== row.cost || before.model !== row.model || before.priced !== row.priced
        || before.pricingSource !== row.pricingSource || before.pricingAsOf !== row.pricingAsOf
        || before.contractRole !== row.contractRole
      ) changed = true;
    }
    if (changed) this.notify();
    return changed;
  }

  private applyUsage(row: MutableAgentCost, record: AgentRecord): void {
    if (record.model && record.model !== 'unknown') row.model = record.model;
    row.contractRole = record.contractRole;
    const usage = record.usage;
    if (!usage) return;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    row.inputTokens = usage.inputTokens + cacheRead + cacheWrite;
    row.outputTokens = usage.outputTokens;
    const quote = this.price(usage.inputTokens, usage.outputTokens, cacheRead, cacheWrite, row.model);
    row.cost = quote.cost;
    row.priced = quote.priced;
    row.pricingSource = quote.source;
    row.pricingAsOf = quote.asOf;
  }

  sessionUsage(): CostTrackerUsage { return this.usage; }
  sessionModel(): string { return this.model; }
  /** The session's cost so far, priced on its current model. */
  sessionCost(): number {
    const { input, output, cacheRead, cacheWrite } = this.usage;
    return this.price(input, output, cacheRead, cacheWrite, this.model).cost;
  }
  /** Cost added per refresh, oldest first, at most the history length. */
  costHistory(): readonly number[] { return this.history; }
  /** Agent rows in spawn order. */
  agents(): readonly TrackedAgentCost[] { return [...this.agentRows.values()]; }
  /** Lifetime agent cost, excluding owner rollups and including evicted terminal rows. */
  agentsCost(): number {
    return [...this.agentRows.values()].reduce((sum, row) => sum + (row.contractRole === 'owner' ? 0 : row.cost), this.retiredAgentsCost);
  }

  /** Whether any non-owner usage remains unpriced, including evicted terminal rows. */
  hasUnpricedAgentUsage(): boolean {
    return this.retiredUnpricedUsage || [...this.agentRows.values()].some((row) =>
      row.contractRole !== 'owner' && !row.priced && row.inputTokens + row.outputTokens > 0);
  }

  /** Calls `cb` after every change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }
}
