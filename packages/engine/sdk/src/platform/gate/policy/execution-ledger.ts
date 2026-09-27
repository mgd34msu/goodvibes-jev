/**
 * The execution ledger: one record per tool call the runtime handles, built
 * from the `tools` event domain, for the execution surfaces to list and
 * filter.
 *
 * Hoisted from the agent (src/runtime/execution-ledger.ts) into the engine
 * gate. Each record's route kind is Jev's reading of the call
 * (`readSideEffectKind`, the side-effect battery's `kind` question, asked at
 * the `engine.gate.execution-ledger` site); it replaces the tool-name keyword
 * ladder the agent used. The kind vocabulary is the ledger's own.
 *
 * The reading is asynchronous, so a call's record is added once its kind is
 * read, and the call's later lifecycle events are applied after that, in the
 * order they arrived. When the reading itself fails, the record is still
 * added so the call is never lost, with the kind `other` and the failure
 * stated in `routeKindError`.
 */
import type { ToolEvent } from '../../../events/tools.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type { SideEffectKind } from '../batteries/side-effect.js';
import { readSideEffectKind } from '../reading.js';

/** The decision site the ledger's route-kind readings are logged under. */
export const EXECUTION_LEDGER_SITE = 'engine.gate.execution-ledger';

export type AgentExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AgentExecutionRouteKind = SideEffectKind;

export interface AgentExecutionResultSummary {
  readonly kind: string;
  readonly byteSize: number;
  readonly preview?: string | undefined;
}

export interface AgentExecutionRecord {
  readonly id: string;
  readonly callId: string;
  readonly turnId: string;
  readonly tool: string;
  readonly routeKind: AgentExecutionRouteKind;
  /** Why the route kind could not be read, when the reading failed. */
  readonly routeKindError?: string | undefined;
  readonly status: AgentExecutionStatus;
  readonly phase: ToolEvent['type'];
  readonly receivedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly permissionApproved?: boolean | undefined;
  readonly argsPreview: string;
  readonly argsKeys: readonly string[];
  readonly commandPreview?: string | undefined;
  readonly targetPreview?: string | undefined;
  readonly resultSummary?: AgentExecutionResultSummary | undefined;
  readonly error?: string | undefined;
  readonly cancelReason?: string | undefined;
}

interface MutableAgentExecutionRecord {
  id: string;
  callId: string;
  turnId: string;
  tool: string;
  routeKind: AgentExecutionRouteKind;
  routeKindError?: string | undefined;
  status: AgentExecutionStatus;
  phase: ToolEvent['type'];
  receivedAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
  durationMs?: number | undefined;
  permissionApproved?: boolean | undefined;
  argsPreview: string;
  argsKeys: readonly string[];
  commandPreview?: string | undefined;
  targetPreview?: string | undefined;
  resultSummary?: AgentExecutionResultSummary | undefined;
  error?: string | undefined;
  cancelReason?: string | undefined;
}

export interface AgentExecutionLedgerSnapshot {
  readonly records: readonly AgentExecutionRecord[];
  readonly total: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

const DEFAULT_LIMIT = 500;
const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|password|secret|token)/i;

function truncateText(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}...` : compact;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return truncateText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => redactValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 16).map(([key, entry]) => (
    [key, SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactValue(entry, depth + 1)] as const
  ));
  return Object.fromEntries(entries);
}

function argsPreview(args: Record<string, unknown>): string {
  try {
    return truncateText(JSON.stringify(redactValue(args)), 360);
  } catch {
    return '[unserializable args]';
  }
}

function stringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return truncateText(value, 180);
  }
  return undefined;
}

/** Reads the call's route kind; a failed reading is reported with the record, never guessed. */
async function readRouteKind(tool: string, args: Record<string, unknown>): Promise<{ routeKind: AgentExecutionRouteKind; routeKindError?: string }> {
  try {
    return { routeKind: (await readSideEffectKind(tool, args, EXECUTION_LEDGER_SITE)).kind };
  } catch (error) {
    const routeKindError = summarizeError(error);
    logger.warn('AgentExecutionLedger: route kind reading failed', { tool, error: routeKindError });
    return { routeKind: 'other', routeKindError };
  }
}

function statusForPhase(phase: ToolEvent['type']): AgentExecutionStatus {
  if (phase === 'TOOL_SUCCEEDED') return 'succeeded';
  if (phase === 'TOOL_FAILED') return 'failed';
  if (phase === 'TOOL_CANCELLED') return 'cancelled';
  return 'running';
}

function resultSummaryFrom(value: Extract<ToolEvent, { type: 'TOOL_SUCCEEDED' | 'TOOL_FAILED' }>['result']): AgentExecutionResultSummary | undefined {
  if (!value) return undefined;
  return {
    kind: value.kind,
    byteSize: value.byteSize,
    ...(typeof value.preview === 'string' && value.preview.trim() ? { preview: truncateText(value.preview, 220) } : {}),
  };
}

function immutable(record: MutableAgentExecutionRecord): AgentExecutionRecord {
  return { ...record };
}

export class AgentExecutionLedger {
  private readonly records = new Map<string, MutableAgentExecutionRecord>();
  private readonly order: string[] = [];
  private readonly subscribers = new Set<() => void>();
  private readonly unsubscribe: () => void;
  /** Per call: the work still to finish before the call's next event applies. */
  private readonly pending = new Map<string, Promise<void>>();
  private disposed = false;

  public constructor(
    runtimeBus: RuntimeEventBus,
    private readonly limit: number = DEFAULT_LIMIT,
  ) {
    this.unsubscribe = runtimeBus.onDomain('tools', (envelope) => {
      this.handleToolEvent(envelope.payload as ToolEvent, envelope.ts);
    });
  }

  public getSnapshot(): AgentExecutionLedgerSnapshot {
    const records = this.order
      .map((id) => this.records.get(id))
      .filter((record): record is MutableAgentExecutionRecord => record !== undefined)
      .map(immutable)
      .reverse();
    return {
      records,
      total: records.length,
      running: records.filter((record) => record.status === 'running').length,
      succeeded: records.filter((record) => record.status === 'succeeded').length,
      failed: records.filter((record) => record.status === 'failed').length,
      cancelled: records.filter((record) => record.status === 'cancelled').length,
    };
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  }

  /** Resolves once every route-kind reading started so far has been applied. */
  public async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending.values()]);
  }

  public dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.subscribers.clear();
  }

  private handleToolEvent(event: ToolEvent, timestamp: number): void {
    if (!('callId' in event)) return;
    const callId = event.callId;
    const before = this.pending.get(callId);
    const step = event.type === 'TOOL_RECEIVED'
      ? (before ?? Promise.resolve()).then(() => this.recordReceived(event, timestamp))
      : before?.then(() => this.applyLifecycleEvent(event, timestamp));
    if (!step) {
      this.applyLifecycleEvent(event, timestamp);
      return;
    }
    this.pending.set(callId, step);
    void step.then(() => {
      if (this.pending.get(callId) === step) this.pending.delete(callId);
    });
  }

  private applyLifecycleEvent(event: Extract<ToolEvent, { callId: string }>, timestamp: number): void {
    if (this.disposed) return;
    const existing = this.records.get(event.callId);
    if (!existing) return;
    existing.phase = event.type;
    existing.status = statusForPhase(event.type);
    existing.updatedAt = timestamp;
    if (event.type === 'TOOL_PERMISSIONED') existing.permissionApproved = event.approved;
    if (event.type === 'TOOL_SUCCEEDED') {
      existing.completedAt = timestamp;
      existing.durationMs = event.durationMs;
      existing.resultSummary = resultSummaryFrom(event.result);
    }
    if (event.type === 'TOOL_FAILED') {
      existing.completedAt = timestamp;
      existing.durationMs = event.durationMs;
      existing.error = truncateText(event.error, 220);
      existing.resultSummary = resultSummaryFrom(event.result);
    }
    if (event.type === 'TOOL_CANCELLED') {
      existing.completedAt = timestamp;
      existing.cancelReason = event.reason ? truncateText(event.reason, 220) : undefined;
    }
    this.notify();
  }

  private async recordReceived(event: Extract<ToolEvent, { type: 'TOOL_RECEIVED' }>, timestamp: number): Promise<void> {
    const route = await readRouteKind(event.tool, event.args);
    if (this.disposed) return;
    const record: MutableAgentExecutionRecord = {
      id: event.callId,
      callId: event.callId,
      turnId: event.turnId,
      tool: event.tool,
      routeKind: route.routeKind,
      ...(route.routeKindError !== undefined ? { routeKindError: route.routeKindError } : {}),
      status: 'running',
      phase: event.type,
      receivedAt: timestamp,
      updatedAt: timestamp,
      argsPreview: argsPreview(event.args),
      argsKeys: Object.keys(event.args).filter((key) => !SECRET_KEY_PATTERN.test(key)).sort(),
      commandPreview: stringArg(event.args, ['command', 'cmd', 'script']),
      targetPreview: stringArg(event.args, ['path', 'file', 'target', 'url', 'query', 'task']),
    };
    this.records.set(record.id, record);
    this.order.push(record.id);
    while (this.order.length > this.limit) {
      const dropped = this.order.shift();
      if (dropped) this.records.delete(dropped);
    }
    this.notify();
  }

  private notify(): void {
    for (const callback of this.subscribers) callback();
  }
}
