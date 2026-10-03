import type { RuntimeEventBus, ToolEvent } from '@/runtime/index.ts';

export type AgentExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AgentExecutionRouteKind = 'read' | 'write' | 'shell' | 'network' | 'browser' | 'delegation' | 'other';

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

/**
 * Classify a tool call into a route kind for display and filtering.
 *
 * Keyword precedence (first match wins):
 *   1. browser  , browser/desktop/screenshot keywords
 *   2. delegation, delegate/agent keywords
 *   3. shell    , exec/shell/bash keywords OR args.command is a string
 *   4. write    , write/edit/patch/delete keywords
 *   5. network  , fetch/web/http/url keywords
 *   6. read     , read/find/inspect/grep/search keywords
 *   7. other    , fallback for unrecognized tool names
 *
 * N2: precedence is intentional, shell beats write/read so that bash-exec tools
 * that also match 'exec' are not misclassified as filesystem writes.
 */
function routeKindForTool(tool: string, args: Record<string, unknown>): AgentExecutionRouteKind {
  const name = tool.toLowerCase();
  if (name.includes('browser') || name.includes('desktop') || name.includes('screenshot')) return 'browser';
  if (name.includes('delegate') || name.includes('agent')) return 'delegation';
  if (name.includes('exec') || name.includes('shell') || name.includes('bash') || typeof args.command === 'string') return 'shell';
  if (name.includes('write') || name.includes('edit') || name.includes('patch') || name.includes('delete')) return 'write';
  if (name.includes('fetch') || name.includes('web') || name.includes('http') || name.includes('url')) return 'network';
  if (name.includes('read') || name.includes('find') || name.includes('inspect') || name.includes('grep') || name.includes('search')) return 'read';
  return 'other';
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

  public dispose(): void {
    this.unsubscribe();
    this.subscribers.clear();
  }

  private handleToolEvent(event: ToolEvent, timestamp: number): void {
    if (!('callId' in event)) return;
    if (event.type === 'TOOL_RECEIVED') {
      this.recordReceived(event, timestamp);
      return;
    }
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

  private recordReceived(event: Extract<ToolEvent, { type: 'TOOL_RECEIVED' }>, timestamp: number): void {
    const record: MutableAgentExecutionRecord = {
      id: event.callId,
      callId: event.callId,
      turnId: event.turnId,
      tool: event.tool,
      routeKind: routeKindForTool(event.tool, event.args),
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
