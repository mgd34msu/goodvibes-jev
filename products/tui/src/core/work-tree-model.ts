/**
 * work-tree-model.ts, one assistant turn as the rows of its lane graph.
 *
 * A turn is every assistant and tool message between two user messages. Its
 * rows, in display order:
 *
 *   head    the turn header (the spine opens)
 *   prose   narration between tool calls, on the spine
 *   bead    one tool call, on the lane of whoever made it
 *   spawn   an agent branching into its own lane
 *   merge   that agent finishing, back into the lane it came from
 *   folded  a folded agent lane: one ◉ bead on its parent's lane
 *   answer  the final prose (the spine closes on its first row)
 *
 * Ordering: calls are placed by when they started when the timing store
 * knows (so lanes that ran at the same time interleave), and otherwise in
 * transcript order with a child lane's rows directly under the call that
 * started it.
 *
 * Pure: every live fact comes in through WorkTreeSources.
 */

import type { ContractView, ContractUnitView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { contractIsActive, contractCommitNote, contractStatusSummary, projectContractTree } from './work-tree-contract.ts';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ToolCall } from '@goodvibes-jev/engine/sdk/platform/types';
import {
  beadArgument,
  beadBody,
  beadName,
  beadStatus,
  beadSummary,
  cellText,
  formatBeadTime,
  formatCost,
  inferResultToolName,
  isBackgroundCall,
  needsAttention,
  toolFamily,
  type BeadBody,
  type BeadStatus,
  type BeadSummary,
} from '../renderer/lane-graph/bead.ts';
import { SPINE, type LaneId } from '../renderer/lane-graph/layout.ts';
import { userMessageFingerprint, type AgentLaneInfo, type TurnOutcome, type TurnTiming, type WorkTreeSources } from './work-tree-sources.ts';

type Message = ConversationMessageSnapshot;
type AssistantMessage = Extract<Message, { role: 'assistant' }>;
type ToolMessage = Extract<Message, { role: 'tool' }>;

/** Deepest agent nesting drawn as lanes; deeper work folds to one bead that says so. */
export const MAX_NEST_DEPTH = 8;

/** Collapse key of a turn (true = folded to its header). */
export function turnKeyOf(headIdx: number): string {
  return `turn_${headIdx}`;
}
/** Collapse key of a bead's body (true or unset = closed). */
export function beadKeyOf(beadId: string): string {
  return `bead_${beadId}`;
}
/** Collapse key of a bead body's "… N more" (false or unset = capped). */
export function beadMoreKeyOf(beadId: string): string {
  return `beadmore_${beadId}`;
}
/** Collapse key of an agent lane (true = folded to one ◉ bead). */
export function laneKeyOf(scope: string, agentId: string): string {
  return `lane_${scope}${agentId}`;
}

export interface BeadModel {
  /** Stable id: `<scope>c:<messageIndex>:<callIndex>`. */
  readonly id: string;
  readonly lane: LaneId;
  readonly call: ToolCall;
  /** Absolute index (in its own transcript) of the message that made the call. */
  readonly messageIndex: number;
  /** Absolute index of the result message, when settled (root transcript only). */
  readonly resultIndex: number | undefined;
  readonly scope: string;
  readonly result: string | undefined;
  readonly status: BeadStatus;
  readonly name: string;
  readonly arg: string;
  readonly summary: BeadSummary | null;
  readonly time: string | undefined;
  readonly body: BeadBody | null;
  readonly open: boolean;
  readonly expanded: boolean;
  /** A correction row can identify the finding it answers. */
  readonly answers?: string | undefined;
}

export interface LaneModel {
  readonly id: LaneId;
  readonly key: string;
  readonly parent: LaneId;
  readonly name: string;
  readonly arg: string;
  /** ok ✓, warn ! (finished carrying a failure), err ✕ (the agent failed), run (still working). */
  readonly outcome: 'ok' | 'warn' | 'err' | 'run';
  readonly mergeText: string;
  /** Folded row summary: "5 tools · $0.12". */
  readonly foldSummary: string;
  readonly time: string | undefined;
  readonly folded: boolean;
  /** Recursion stopped here (depth ceiling or a cycle); the lane is drawn folded and says why. */
  readonly truncated?: 'depth' | 'cycle' | undefined;
}

export type TurnRow =
  | { readonly kind: 'head' }
  | { readonly kind: 'prose'; readonly messageIndex: number; readonly content: string; readonly role: 'assistant' | 'system' | 'thinking' | 'summary' }
  | { readonly kind: 'bead'; readonly bead: BeadModel }
  | { readonly kind: 'spawn'; readonly lane: LaneModel; readonly bead: BeadModel }
  | { readonly kind: 'merge'; readonly lane: LaneModel }
  | { readonly kind: 'folded'; readonly lane: LaneModel; readonly bead: BeadModel }
  | { readonly kind: 'answer'; readonly messageIndex: number; readonly content: string };

export interface TurnModel {
  readonly turnKey: string;
  readonly headIndex: number;
  /** Every message index (root transcript) the turn covers. */
  readonly memberIndexes: readonly number[];
  readonly folded: boolean;
  /** "claude-opus-5-5 · 4 tools · 1 agent · 1.9s" */
  readonly headerText: string;
  readonly rows: readonly TurnRow[];
  /** Something on the turn is live (a running bead or lane): it repaints as time passes. */
  readonly live: boolean;
  readonly toolCount: number;
  readonly agentCount: number;
  /** Collapse keys of every bead in the turn (search and /expand reach them). */
  readonly beadKeys: readonly string[];
  /**
   * System notices that arrived while the turn ran ([Contracts] …, [Agents] …,
   * compaction receipts), in order. A notice is not a step of the turn: it is
   * drawn after the turn, outside its lanes (conversation-rendering.ts), the
   * way a notice between turns is.
   */
  readonly notices: ReadonlyArray<{ readonly messageIndex: number; readonly content: string }>;
}

/** A contiguous stretch of the transcript: one user message, one turn, or one standalone system message. */
export type TranscriptUnit =
  | { readonly kind: 'message'; readonly index: number }
  | { readonly kind: 'turn'; readonly start: number; readonly end: number; readonly headIndex: number };

/**
 * Split a transcript slice into units. A turn runs from the first assistant
 * message after a user message to the last assistant or tool message before
 * the next one; system messages inside that stretch belong to the turn, and
 * system messages around it stand alone.
 */
export function transcriptUnits(messages: readonly Message[], offset = 0): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const role = messages[i]!.role;
    if (role !== 'assistant' && role !== 'tool') {
      units.push({ kind: 'message', index: offset + i });
      i++;
      continue;
    }
    let end = i;
    let j = i;
    while (j < messages.length && messages[j]!.role !== 'user') {
      if (messages[j]!.role !== 'system') end = j;
      j++;
    }
    if (messages[i]!.role === 'tool' && !messages.slice(i, end + 1).some((m) => m.role === 'assistant')) {
      // Orphan results with no assistant message in the slice (a display cleared mid-turn).
      for (let k = i; k <= end; k++) units.push({ kind: 'message', index: offset + k });
    } else {
      const head = messages.slice(i, end + 1).findIndex((m) => m.role === 'assistant');
      units.push({ kind: 'turn', start: offset + i, end: offset + end, headIndex: offset + i + Math.max(0, head) });
    }
    for (let k = end + 1; k < j; k++) units.push({ kind: 'message', index: offset + k });
    i = j;
  }
  return units;
}

function hasProse(message: AssistantMessage): boolean {
  return typeof message.content === 'string' && message.content.trim().length > 0;
}

function firstLine(text: string, max = 120): string {
  const line = cellText(text.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The agent ids a call started: one for `agent` spawn, several for batch-spawn. */
function spawnedAgentIds(call: ToolCall, result: string | undefined): string[] {
  if (toolFamily(call.name) !== 'agent') return [];
  const mode = call.arguments.mode;
  if (mode !== 'spawn' && mode !== 'batch-spawn' && !(mode === undefined && typeof call.arguments.task === 'string')) return [];
  if (!result) return [];
  try {
    const parsed: unknown = JSON.parse(result);
    const ids: string[] = [];
    const visit = (value: unknown, depth: number): void => {
      if (depth > 3 || value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const v of value) visit(v, depth + 1); return; }
      const rec = value as Record<string, unknown>;
      if (rec.contractStarted === true && typeof rec.ownerAgentId === 'string' && rec.ownerAgentId.length > 0) { ids.push(rec.ownerAgentId); return; }
      if (typeof rec.agentId === 'string' && rec.agentId.length > 0) ids.push(rec.agentId);
      for (const [key, child] of Object.entries(rec)) if (key !== 'agentId') visit(child, depth + 1);
    };
    visit(parsed, 0);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/** Rows of one lane plus their start times, before interleaving. */
interface TimedRow {
  readonly row: TurnRow;
  /** Epoch ms this row happened, when known. */
  readonly t: number | undefined;
}

interface BuildContext {
  readonly sources: WorkTreeSources;
  readonly collapse: ReadonlyMap<string, boolean>;
  readonly waiting: ReadonlySet<string>;
  readonly now: number;
  /** Counters for the header. */
  lanes: number;
  live: boolean;
  beadKeys: string[];
}

function callTime(ctx: BuildContext, call: ToolCall, status: BeadStatus): { t: number | undefined; text: string | undefined } {
  const timing = call.id !== undefined ? ctx.sources.callTiming?.(call.id) : undefined;
  if (!timing) return { t: undefined, text: undefined };
  if (status === 'run' && timing.startedAt !== undefined) return { t: timing.startedAt, text: formatBeadTime(ctx.now - timing.startedAt) };
  if (status === 'wait' && timing.startedAt !== undefined) return { t: timing.startedAt, text: formatBeadTime(ctx.now - timing.startedAt) };
  return { t: timing.startedAt, text: timing.durationMs !== undefined ? formatBeadTime(timing.durationMs) : undefined };
}

function makeBead(
  ctx: BuildContext,
  lane: LaneId,
  scope: string,
  call: ToolCall,
  messageIndex: number,
  callIndex: number,
  result: { content: string; index: number; outcome?: ToolMessage['outcome'] } | undefined,
  ownerActive: boolean,
  extra: { answers?: string } = {},
): { bead: BeadModel; t: number | undefined } {
  const id = `${scope}c:${messageIndex}:${callIndex}`;
  const content = result?.content;
  const outcome = result?.outcome;
  const status = beadStatus({
    outcome,
    content,
    waiting: call.id !== undefined && ctx.waiting.has(call.id),
    ownerActive,
    background: isBackgroundCall(call),
    attention: content !== undefined && outcome === 'ok' && needsAttention(call, content),
  });
  if (status === 'run' || status === 'wait') ctx.live = true;
  const body = beadBody(call, status, content);
  const key = beadKeyOf(id);
  ctx.beadKeys.push(key);
  const time = callTime(ctx, call, status);
  return {
    t: time.t,
    bead: {
      id,
      lane,
      call,
      messageIndex,
      resultIndex: scope === '' ? result?.index : undefined,
      scope,
      result: content,
      status,
      name: beadName(call),
      arg: beadArgument(call),
      summary: beadSummary(call, status, content),
      time: time.text,
      body,
      open: body !== null && ctx.collapse.get(key) === false,
      expanded: ctx.collapse.get(beadMoreKeyOf(id)) === true,
      answers: extra.answers,
    },
  };
}

/** Interleave a child lane's rows with the parent rows that follow its spawn. */
function interleave(parent: readonly TimedRow[], child: readonly TimedRow[]): TimedRow[] {
  const out: TimedRow[] = [];
  let p = 0;
  let c = 0;
  while (p < parent.length && c < child.length) {
    const pt = parent[p]!.t;
    const ct = child[c]!.t;
    // Without both times, a child's rows come first: sequential nesting.
    if (pt !== undefined && ct !== undefined && pt < ct) out.push(parent[p++]!);
    else out.push(child[c++]!);
  }
  while (c < child.length) out.push(child[c++]!);
  while (p < parent.length) out.push(parent[p++]!);
  return out;
}

/** A pending row list item: either a finished row, or a spawn whose child rows interleave with what follows. */
type Pending = TimedRow | { readonly spawn: TimedRow; readonly child: readonly TimedRow[] };

function resolvePending(items: readonly Pending[]): TimedRow[] {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if ('spawn' in item) {
      const rest = resolvePending(items.slice(i + 1));
      const before = items.slice(0, i) as TimedRow[];
      return [...before, item.spawn, ...interleave(rest, item.child)];
    }
  }
  return items as TimedRow[];
}

/** Fill in missing times so each row keeps its place relative to the timed rows before it. */
function inheritTimes(rows: readonly TimedRow[], start: number | undefined): TimedRow[] {
  let last = start;
  return rows.map((r) => {
    if (r.t !== undefined) { last = r.t; return r; }
    return { row: r.row, t: last };
  });
}

function laneOutcome(info: AgentLaneInfo, rows: readonly TimedRow[]): LaneModel['outcome'] {
  if (info.contract) {
    const status = info.contract.status;
    return status === 'passed' ? 'ok' : status === 'failed' ? 'err' : status === 'cancelled' ? 'warn' : 'run';
  }
  if (info.status === 'running' || info.status === 'pending') return 'run';
  if (info.status === 'failed') return 'err';
  if (info.status === 'cancelled') return 'warn';

  // A lane carries a failure when one of ITS OWN calls failed; a failure deeper
  // down shows on the merge row of the lane it happened in.
  const carriesFailure = rows.some((r) => r.row.kind === 'bead' && r.row.bead.lane === info.id && r.row.bead.status === 'err');
  return carriesFailure ? 'warn' : 'ok';
}

function laneTexts(info: AgentLaneInfo, name: string, rows: readonly TimedRow[], outcome: LaneModel['outcome'], ctx: BuildContext): { merge: string; fold: string; time: string | undefined } {
  const tools = info.contract ? plural(info.contract.units.length, 'unit') : plural(info.toolCallCount, 'tool');
  const end = info.completedAt ?? ctx.now;
  const elapsed = info.startedAt !== undefined ? formatBeadTime(end - info.startedAt) : undefined;
  const cost = info.costUsd !== undefined ? formatCost(info.costUsd) : undefined;
  const failedTools = rows.filter((r) => r.row.kind === 'bead' && r.row.bead.lane === info.id && r.row.bead.status === 'err').length;
  const nested = rows.filter((r) => r.row.kind === 'spawn' || r.row.kind === 'folded').length;
  let lead: string;
  if (info.contract) {
    lead = `${name} ${contractStatusSummary(info.contract)}`;
  } else if (info.status === 'failed') {
    lead = `${name} failed${info.error ? `: ${firstLine(info.error, 60)}` : ''}`;
  } else if (info.status === 'cancelled') {
    lead = `${name} cancelled`;
  } else if (failedTools > 0) {
    lead = `${name} finished with ${plural(failedTools, 'failed tool')}`;
  } else {
    lead = `${name} finished`;
  }
  const merge = [lead, tools, nested > 0 ? `${plural(nested, 'agent')} inside` : undefined, elapsed, cost].filter(Boolean).join(' · ');
  const fold = [info.contract ? contractStatusSummary(info.contract) : undefined, tools, cost].filter(Boolean).join(' · ');
  return { merge, fold, time: elapsed };
}

/**
 * The rows of an agent's own lane: its tool calls as beads, its own spawns as
 * nested lanes. `ancestors` guards cycles; `depth` guards runaway nesting.
 */
function agentLaneRows(ctx: BuildContext, info: AgentLaneInfo, scope: string, depth: number, ancestors: readonly string[]): TimedRow[] {
  const lane = info.id;
  const active = info.status === 'running' || info.status === 'pending';
  if (info.contract) return contractLaneRows(ctx, info.contract, lane, scope);
  const results = new Map<string, { content: string; index: number; outcome?: ToolMessage['outcome'] }>();
  info.messages.forEach((m, i) => { if (m.role === 'tool' && m.callId) results.set(m.callId, { content: m.content, index: i, outcome: m.outcome }); });
  const items: Pending[] = [];
  info.messages.forEach((m, messageIndex) => {
    if (m.role !== 'assistant') return;
    (m.toolCalls ?? []).forEach((call, k) => {
      const result = call.id !== undefined ? results.get(call.id) : undefined;
      items.push(...callRows(ctx, lane, scope, call, messageIndex, k, result, active, depth, ancestors));
    });
  });
  return inheritTimes(resolvePending(items), info.startedAt);
}

/** The same typed tree appears in a main lane and in the owner's full-screen view. */
function contractLaneRows(ctx: BuildContext, contract: ContractView, lane: LaneId, scope: string): TimedRow[] {
  return projectContractTree(contract).map((row) => {
    const id = `${scope}${row.id}`;
    const key = beadKeyOf(id);
    ctx.beadKeys.push(key);
    if (row.status === 'run' || row.status === 'wait') ctx.live = true;
    const lines = row.lines.flatMap((line) => line.split('\n').map(cellText));
    const result = lines.join('\n');
    const body: BeadBody | null = lines.length > 0 ? { kind: 'text', lines } : null;
    return { t: undefined, row: { kind: 'bead', bead: {
      id, lane, call: { id, name: row.name, arguments: {} }, messageIndex: -1, resultIndex: undefined,
      scope, result, status: row.status, name: row.name, arg: firstLine(row.arg, 120), summary: { ...row.summary, text: cellText(row.summary.text) },
      time: undefined, body, open: body !== null && ctx.collapse.get(key) === false,
      expanded: ctx.collapse.get(beadMoreKeyOf(id)) === true,
    } } };
  });
}

/** The row(s) one call contributes: a bead, or a spawn with its child lane(s). */
function callRows(
  ctx: BuildContext,
  lane: LaneId,
  scope: string,
  call: ToolCall,
  messageIndex: number,
  callIndex: number,
  result: { content: string; index: number; outcome?: ToolMessage['outcome'] } | undefined,
  ownerActive: boolean,
  depth: number,
  ancestors: readonly string[],
): Pending[] {
  const { bead, t } = makeBead(ctx, lane, scope, call, messageIndex, callIndex, result, ownerActive);
  const agentIds = ctx.sources.agent ? spawnedAgentIds(call, result?.content) : [];
  const out: Pending[] = [];
  const infos = agentIds.map((id) => ({ id, info: ctx.sources.agent!(id) })).filter((a): a is { id: string; info: AgentLaneInfo } => a.info !== null);
  if (infos.length === 0) return [{ row: { kind: 'bead', bead }, t }];
  for (const { id, info } of infos) {
    ctx.lanes++;
    const key = laneKeyOf(scope, id);
    const truncated: LaneModel['truncated'] = ancestors.includes(id) ? 'cycle' : depth + 1 > MAX_NEST_DEPTH ? 'depth' : undefined;
    const childScope = `${scope}a:${id}/`;
    const childRows = truncated ? [] : agentLaneRows(ctx, info, childScope, depth + 1, [...ancestors, id]);
    const outcome = laneOutcome(info, childRows);
    if (outcome === 'run') ctx.live = true;
    // A hosted agent's lane is named for its harness ("Claude Code"), its task marked hosted.
    const name = cellText(info.contract ? 'Contract' : info.hostedLabel ?? info.name);
    const texts = laneTexts(info, name, childRows, outcome, ctx);
    const arg = `${info.hostedLabel ? 'hosted · ' : ''}${firstLine(info.task, 100)}`;
    const laneModel: LaneModel = {
      id,
      key,
      parent: lane,
      name,
      arg: truncated === 'depth' ? `${arg} · nested deeper than ${MAX_NEST_DEPTH} lanes` : truncated === 'cycle' ? `${arg} · repeats an agent shown above` : arg,
      outcome,
      mergeText: texts.merge,
      foldSummary: texts.fold,
      time: texts.time,
      folded: truncated !== undefined || ctx.collapse.get(key) === true,
      truncated,
    };
    const spawnT = t ?? info.startedAt;
    if (laneModel.folded) {
      out.push({ row: { kind: 'folded', lane: laneModel, bead }, t: spawnT });
      continue;
    }
    const child: TimedRow[] = childRows.length > 0 ? inheritTimes(childRows, spawnT) : [];
    if (outcome !== 'run') child.push({ row: { kind: 'merge', lane: laneModel }, t: info.completedAt ?? child[child.length - 1]?.t ?? spawnT });
    out.push({ spawn: { row: { kind: 'spawn', lane: laneModel, bead }, t: spawnT }, child });
  }
  return out;
}

export interface BuildTurnInput {
  readonly messages: readonly Message[];
  /** Absolute index of messages[0]. */
  readonly offset: number;
  readonly unit: Extract<TranscriptUnit, { kind: 'turn' }>;
  readonly sources: WorkTreeSources;
  readonly collapse: ReadonlyMap<string, boolean>;
  /** The streaming placeholder's absolute index (its prose is drawn by the streaming path), or -1. */
  readonly streamingIndex: number;
  /** display.showThinking: reasoning text rows (collapsed to one row by default). */
  readonly showThinking?: boolean;
  /** display.showReasoningSummary: reasoning summary rows. */
  readonly showReasoningSummary?: boolean;
}

export function buildTurnModel(input: BuildTurnInput): TurnModel {
  const { messages, offset, unit, sources } = input;
  const at = (abs: number): Message => messages[abs - offset]!;
  const now = sources.now?.() ?? Date.now();
  const ctx: BuildContext = {
    sources,
    collapse: input.collapse,
    waiting: sources.waitingCallIds?.() ?? new Set<string>(),
    now,
    lanes: 0,
    live: false,
    beadKeys: [],
  };
  // Whether the main conversation says it is working. With no live source (a
  // plain transcript render) that is unknown: the header claims nothing, and
  // an unsettled call in the latest turn still reads as running (an earlier
  // turn has ended: a user message followed it).
  const turnActiveNow = sources.turnActive?.() ?? false;
  const callsMayRun = sources.turnActive?.() ?? true;

  // Is this the transcript's latest turn? Only that one can still be running.
  let isLatest = true;
  for (let abs = unit.end + 1; abs < offset + messages.length; abs++) {
    if (at(abs).role === 'user') { isLatest = false; break; }
  }
  const active = turnActiveNow && isLatest;
  const callsLive = callsMayRun && isLatest;

  const results = new Map<string, { content: string; index: number; outcome?: ToolMessage['outcome'] }>();
  const members: number[] = [];
  for (let abs = unit.start; abs <= unit.end; abs++) {
    members.push(abs);
    const m = at(abs);
    if (m.role === 'tool' && m.callId) results.set(m.callId, { content: m.content, index: abs, outcome: m.outcome });
  }

  // The answer: the last assistant message, when it has prose and no calls.
  let answerIndex = -1;
  for (let abs = unit.end; abs >= unit.start; abs--) {
    const m = at(abs);
    if (m.role !== 'assistant') continue;
    if (hasProse(m) && (m.toolCalls?.length ?? 0) === 0 && abs !== input.streamingIndex) answerIndex = abs;
    break;
  }

  const head = at(unit.headIndex) as AssistantMessage;
  let model = head.model;
  let toolCount = 0;
  const items: Pending[] = [];
  const notices: Array<{ messageIndex: number; content: string }> = [];
  const calledIds = new Set<string>();
  for (let abs = unit.start; abs <= unit.end; abs++) {
    const m = at(abs);
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) if (c.id !== undefined) calledIds.add(c.id);
  }
  for (let abs = unit.start; abs <= unit.end; abs++) {
    const m = at(abs);
    if (m.role === 'tool' && !calledIds.has(m.callId)) {
      // A result whose call is not in this turn (a cleared display, a replayed
      // journal): its own bead, where it sits.
      toolCount++;
      const orphan = orphanResultBead(m, abs, ctx.collapse);
      ctx.beadKeys.push(beadKeyOf(orphan.id));
      items.push({ row: { kind: 'bead', bead: orphan }, t: undefined });
      continue;
    }
    if (m.role === 'system') {
      notices.push({ messageIndex: abs, content: m.content });
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (m.model && model && m.model !== model) {
      items.push({ row: { kind: 'prose', messageIndex: abs, content: `switched to ${m.model}`, role: 'system' }, t: undefined });
      model = m.model;
    }
    if (input.showThinking && m.reasoningContent) {
      items.push({ row: { kind: 'prose', messageIndex: abs, content: m.reasoningContent, role: 'thinking' }, t: undefined });
    }
    if (input.showReasoningSummary && m.reasoningSummary) {
      items.push({ row: { kind: 'prose', messageIndex: abs, content: m.reasoningSummary, role: 'summary' }, t: undefined });
    }
    if (abs !== answerIndex && hasProse(m) && abs !== input.streamingIndex) {
      items.push({ row: { kind: 'prose', messageIndex: abs, content: m.content, role: 'assistant' }, t: undefined });
    }
    (m.toolCalls ?? []).forEach((call, k) => {
      toolCount++;
      const result = call.id !== undefined ? results.get(call.id) : undefined;
      items.push(...callRows(ctx, SPINE, '', call, abs, k, result, callsLive, 0, []));
    });
  }

  let rows = inheritTimes(resolvePending(items), undefined);
  if (answerIndex >= 0) {
    // With every lane finished the answer closes the turn. While a lane still
    // runs, the answer sits after the spine's own last row and the running
    // lane keeps drawing under it.
    const running = rows.some((r) => (r.row.kind === 'spawn' && r.row.lane.outcome === 'run'));
    let answerAt = rows.length;
    if (running) {
      let lastSpine = -1;
      rows.forEach((r, k) => {
        const lane = r.row.kind === 'bead' ? r.row.bead.lane : r.row.kind === 'spawn' || r.row.kind === 'merge' || r.row.kind === 'folded' ? r.row.lane.parent : SPINE;
        if (lane === SPINE) lastSpine = k;
      });
      answerAt = lastSpine + 1;
      // Merges into the spine must stay above the answer.
      while (answerAt < rows.length && rows[answerAt]!.row.kind === 'merge' && (rows[answerAt]!.row as { lane: LaneModel }).lane.parent === SPINE) answerAt++;
    }
    rows = [...rows.slice(0, answerAt), { row: { kind: 'answer', messageIndex: answerIndex, content: (at(answerIndex) as AssistantMessage).content }, t: undefined }, ...rows.slice(answerAt)];
  }

  // Header text.
  const turnKey = turnKeyOf(unit.headIndex);
  let userIndex = -1;
  for (let abs = unit.start - 1; abs >= offset; abs--) if (at(abs).role === 'user') { userIndex = abs; break; }
  const userMessage = userIndex >= 0 ? at(userIndex) : undefined;
  const timing = turnTimingFor(sources, userIndex, userMessage);
  const outcome = active ? undefined : turnOutcomeFor(sources, userIndex, userMessage, timing);
  const parts: string[] = [];
  if (model) parts.push(model);
  if (active) parts.push('working');
  else if (outcome === 'failed' || outcome === 'cancelled') parts.push(outcome);
  if (toolCount > 0) parts.push(plural(toolCount, 'tool'));
  if (ctx.lanes > 0) parts.push(plural(ctx.lanes, 'agent'));
  if (head.reasoningContent || head.reasoningSummary) parts.push('reasoning');
  const contractNotes = new Set<string>();
  for (const { row } of rows) {
    if (row.kind !== 'spawn' && row.kind !== 'folded') continue;
    const contract = sources.agent?.(row.lane.id)?.contract;
    const note = contract && contractCommitNote(contract);
    if (note && contract?.commit?.status !== 'committed') contractNotes.add(`${contract!.status} · ${note}`);
  }
  // Keep the outcome note ahead of counts so it survives an 80-column folded header.
  parts.splice(model ? 1 : 0, 0, ...contractNotes);
  // A finished turn whose end was never recorded states no time rather than a wrong one.
  if (timing && (timing.endedAt !== undefined || active)) parts.push(formatBeadTime((timing.endedAt ?? now) - timing.startedAt));

  return {
    turnKey,
    headIndex: unit.headIndex,
    memberIndexes: members,
    folded: input.collapse.get(turnKey) === true && !active,
    headerText: parts.join(' · '),
    rows: [{ kind: 'head' }, ...rows.map((r) => r.row)],
    live: ctx.live || active,
    toolCount,
    agentCount: ctx.lanes,
    beadKeys: ctx.beadKeys,
    notices,
  };
}

/** A contract owner supervises the public tree and the actual planner/unit transcripts. */
export function buildContractOwnerModel(input: {
  readonly info: AgentLaneInfo;
  readonly sources: WorkTreeSources;
  readonly collapse: ReadonlyMap<string, boolean>;
}): TurnModel {
  const { info, sources } = input;
  const contract = info.contract;
  const now = sources.now?.() ?? Date.now();
  const ctx: BuildContext = { sources, collapse: input.collapse, waiting: sources.waitingCallIds?.() ?? new Set<string>(), now, lanes: 0, live: false, beadKeys: [] };
  const scope = `contract:${contract?.id ?? info.id}/`;
  const active = contract ? contractIsActive(contract) : info.status === 'running' || info.status === 'pending';
  const items: Pending[] = contract ? contractLaneRows(ctx, contract, SPINE, scope) : [];
  const agentIds = new Set(contract?.plannerAgentIds ?? []);
  const addUnitAgents = (unit: ContractUnitView): void => {
    for (const id of unit.agentIds) agentIds.add(id);
    for (const attempt of unit.attemptUnits ?? []) addUnitAgents(attempt);
  };
  for (const unit of contract?.units ?? []) addUnitAgents(unit);
  let index = 0;
  for (const agentId of agentIds) {
    if (agentId === info.id) continue;
    // This is a structural link to a real agent, never an invented execution outcome.
    const call: ToolCall = { id: `${scope}agent:${agentId}`, name: 'agent', arguments: { mode: 'spawn' } };
    items.push(...callRows(ctx, SPINE, scope, call, -1, index++, { content: JSON.stringify({ agentId }), index: -1 }, active, 0, [info.id]));
  }
  const rows = resolvePending(items);
  const parts = ['Contract', contract ? contractStatusSummary(contract) : info.status, plural(contract?.units.length ?? 0, 'unit')];
  if (contract) parts.push(formatBeadTime((contract.completedAt ?? now) - contract.createdAt));
  return { turnKey: `${scope}turn`, headIndex: -1, memberIndexes: [], folded: false,
    headerText: parts.join(' · '), rows: [{ kind: 'head' }, ...rows.map((r) => r.row)], live: ctx.live || active,
    toolCount: 0, agentCount: ctx.lanes, beadKeys: ctx.beadKeys, notices: [] };
}

/**
 * The timing record of the turn answering the user message at `userIndex`,
 * when it is that turn's: a record made for a different message (the
 * transcript was compacted or replaced since) is ignored.
 */
function turnTimingFor(sources: WorkTreeSources, userIndex: number, userMessage: Message | undefined): TurnTiming | undefined {
  if (userIndex < 0) return undefined;
  const timing = sources.turnTiming?.(userIndex);
  if (!timing) return undefined;
  return timing.fingerprint === undefined || timing.fingerprint === userMessageFingerprint(userMessage) ? timing : undefined;
}

/**
 * How a finished turn ended: cancelled when its user message says so, else
 * the live turn-end record, else the session's saved record for this message.
 */
function turnOutcomeFor(sources: WorkTreeSources, userIndex: number, userMessage: Message | undefined, timing: TurnTiming | undefined): TurnOutcome | undefined {
  if (userMessage?.role === 'user' && userMessage.cancelled) return 'cancelled';
  if (timing?.outcome) return timing.outcome;
  if (userIndex < 0) return undefined;
  const saved = sources.turnOutcome?.(userIndex);
  return saved && saved.fingerprint === userMessageFingerprint(userMessage) ? saved.outcome : undefined;
}

/**
 * Everything a drawn turn depends on, flattened for an element-by-element
 * comparison (the line cache reuses a turn's lines while this is unchanged).
 * Strings compare by value; a bead's result only counts while its body is open.
 */
export function turnSignature(model: TurnModel): Array<string | number | boolean | undefined> {
  const parts: Array<string | number | boolean | undefined> = [model.turnKey, model.folded, model.headerText, model.live, model.rows.length];
  for (const notice of model.notices) parts.push('notice', notice.messageIndex, notice.content);
  const bead = (b: BeadModel): void => {
    parts.push(b.id, b.lane, b.status, b.name, b.arg, b.summary?.text, b.summary?.tone, b.time, b.open, b.expanded, b.answers, b.body?.kind);
    if (b.open) parts.push(b.result, b.body?.kind === 'diff' ? b.body.diff : undefined);
  };
  const lane = (l: LaneModel): void => {
    parts.push(l.id, l.key, l.parent, l.name, l.arg, l.outcome, l.mergeText, l.foldSummary, l.time, l.folded, l.truncated);
  };
  for (const row of model.rows) {
    parts.push(row.kind);
    switch (row.kind) {
      case 'prose': parts.push(row.messageIndex, row.role, row.content); break;
      case 'answer': parts.push(row.messageIndex, row.content); break;
      case 'bead': bead(row.bead); break;
      case 'spawn':
      case 'folded': lane(row.lane); bead(row.bead); break;
      case 'merge': lane(row.lane); break;
      default: break;
    }
  }
  return parts;
}

/** Whether a turn draws an opened diff (its ◈ summary may still be computing). */
export function turnHasOpenDiff(model: TurnModel): boolean {
  return model.rows.some((r) => r.kind === 'bead' && r.bead.open && r.bead.body?.kind === 'diff');
}

/**
 * A result whose call is outside the rendered slice (the display was cleared
 * mid-turn): one bead of its own, named from the result, with the same body,
 * block and open state as any other bead.
 */
export function orphanResultBead(message: ToolMessage, index: number, collapse: ReadonlyMap<string, boolean>): BeadModel {
  const ctx: BuildContext = { sources: {}, collapse, waiting: new Set(), now: 0, lanes: 0, live: false, beadKeys: [] };
  // A result stored without its call and without a tool name is named from
  // its own shape when that is unambiguous, otherwise "result", never "tool".
  const call: ToolCall = { id: message.callId, name: message.toolName ?? inferResultToolName(message.content), arguments: {} };
  const { bead } = makeBead(ctx, SPINE, 'o', call, index, 0, { content: message.content, index, outcome: message.outcome }, false);
  return bead;
}
