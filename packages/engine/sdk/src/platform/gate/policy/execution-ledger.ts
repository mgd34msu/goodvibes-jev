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
 *
 * Which arguments carry a credential (redacted from the preview) and which
 * one the call acts on (the target preview) are read per tool and argument
 * name (`engine.gate.ledger-arg`) and remembered for the process; they replace
 * a key-name regex and a fixed key list. A name not read as a confident no is
 * redacted, and when the reading fails every value is redacted and the
 * failure is stated in `argsReadingError`.
 */
import type { ToolEvent } from '../../../events/tools.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type { SideEffectKind } from '../batteries/side-effect.js';
import { snapshotJudgmentInput, JudgmentInputError } from '../judgment-input.js';
import { readSideEffectKind, shellCommandsIn } from '../reading.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { ledgerArg } from '../batteries/ledger-arg.js';

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
  /** Why the argument roles could not be read; every argument value is redacted then. */
  readonly argsReadingError?: string | undefined;
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
  argsReadingError?: string | undefined;
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

/** What one argument name is, for one tool (engine.gate.ledger-arg). */
interface ArgRole {
  readonly credential: boolean;
  readonly target: boolean;
}

/** Roles read so far, by tool and argument name; bounded, the oldest leaves first. */
const ARG_ROLES = new Map<string, ArgRole>();
const ARG_ROLES_LIMIT = 1024;
const ARG_READ_CONCURRENCY = 8;
const roleKey = (tool: string, argument: string): string => `${tool}\u0000${argument}`;

/** Every object key in the arguments, as deep as the preview shows them. */
function argumentNames(value: unknown, depth = 0, names = new Set<string>()): Set<string> {
  if (depth > 3 || !value || typeof value !== 'object') return names;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) argumentNames(entry, depth + 1, names);
    return names;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    names.add(key);
    argumentNames(entry, depth + 1, names);
  }
  return names;
}

/** Reads the roles of the argument names not read yet for this tool. A JudgmentError propagates. */
async function readArgRoles(tool: string, args: Record<string, unknown>): Promise<ReadonlyMap<string, ArgRole>> {
  const names = [...argumentNames(args)];
  const unread = names.filter((name) => !ARG_ROLES.has(roleKey(tool, name)));
  const port = unread.length > 0 ? judgmentPort(EXECUTION_LEDGER_SITE) : undefined;
  await mapLimit(unread, ARG_READ_CONCURRENCY, async (argument) => {
    const run = await ledgerArg.run(port!, { tool, argument }, { site: EXECUTION_LEDGER_SITE });
    const credential = !(run.readings.holds_credential.verdict === 'no' && run.readings.holds_credential.outcome === 'act');
    const target = run.readings.is_target.verdict === 'yes' && run.readings.is_target.outcome === 'act';
    run.recordAction(credential ? 'redact' : target ? 'target' : 'show');
    ARG_ROLES.set(roleKey(tool, argument), { credential, target });
    if (ARG_ROLES.size > ARG_ROLES_LIMIT) ARG_ROLES.delete(ARG_ROLES.keys().next().value!);
  });
  return new Map(names.map((name) => [name, ARG_ROLES.get(roleKey(tool, name))!]));
}

/** Forgets the argument roles read so far (tests, and a model change). */
export function forgetLedgerArgRoles(): void {
  ARG_ROLES.clear();
}

function truncateText(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}...` : compact;
}

/** A value as the preview shows it: a key not read as a confident non-credential is redacted. */
function redactValue(value: unknown, roles: ReadonlyMap<string, ArgRole> | null, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return truncateText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => redactValue(entry, roles, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 16).map(([key, entry]) => (
    [key, roles?.get(key)?.credential === false ? redactValue(entry, roles, depth + 1) : '[redacted]'] as const
  ));
  return Object.fromEntries(entries);
}

function argsPreview(args: Record<string, unknown>, roles: ReadonlyMap<string, ArgRole> | null): string {
  try {
    return truncateText(JSON.stringify(redactValue(args, roles)), 360);
  } catch {
    return '[unserializable args]';
  }
}

/** The first top-level string argument read as what the call acts on, and not as a credential. */
function targetPreview(args: Record<string, unknown>, roles: ReadonlyMap<string, ArgRole> | null): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    const role = roles?.get(key);
    if (role?.target && !role.credential && typeof value === 'string' && value.trim()) return truncateText(value, 180);
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

/** The argument roles, or the failure stated when the reading fails (every value is then redacted). */
async function readArgRolesReported(tool: string, args: Record<string, unknown>): Promise<{ roles: ReadonlyMap<string, ArgRole> | null; error?: string }> {
  try {
    return { roles: await readArgRoles(tool, args) };
  } catch (error) {
    const message = summarizeError(error);
    logger.warn('AgentExecutionLedger: argument reading failed', { tool, error: message });
    return { roles: null, error: message };
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
    // TOOL_RECEIVED precedes the permission result. Refused material must not
    // reach the independent route/argument readers or their persisted previews.
    let args: Record<string, unknown> = {};
    let refusal: string | undefined;
    try { args = snapshotJudgmentInput(event.args, event.tool) as Record<string, unknown>; }
    catch (error) {
      if (!(error instanceof JudgmentInputError)) throw error;
      refusal = error.message;
    }
    const problem = refusal !== undefined;
    const [route, roles] = refusal
      ? [{ routeKind: 'other' as const, routeKindError: refusal }, { roles: null, error: refusal }]
      : await Promise.all([readRouteKind(event.tool, args), readArgRolesReported(event.tool, args)]);
    const command = shellCommandsIn(args)[0];
    if (this.disposed) return;
    const record: MutableAgentExecutionRecord = {
      id: event.callId,
      callId: event.callId,
      turnId: event.turnId,
      tool: problem ? '[protected tool call]' : event.tool,
      routeKind: route.routeKind,
      ...(route.routeKindError !== undefined ? { routeKindError: route.routeKindError } : {}),
      status: 'running',
      phase: event.type,
      receivedAt: timestamp,
      updatedAt: timestamp,
      ...(roles.error !== undefined ? { argsReadingError: roles.error } : {}),
      argsPreview: problem ? '[redacted: protected input]' : argsPreview(args, roles.roles),
      argsKeys: Object.keys(args).filter((key) => roles.roles?.get(key)?.credential === false).sort(),
      commandPreview: command !== undefined && command.trim() ? truncateText(command, 180) : undefined,
      targetPreview: targetPreview(args, roles.roles),
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
