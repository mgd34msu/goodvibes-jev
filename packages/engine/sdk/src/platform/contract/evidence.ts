/**
 * A unit's evidence (docs/design/contract-runner.md section 4.3): what Jev
 * reads when it checks the unit. The diff of the paths the unit touched, the
 * claim verification and gate results (at the triggers that run them), the
 * agent's complete output and the commands it ran.
 *
 * Where the diff comes from:
 * - In git (the unit's item worktree in worktree mode, the project root in
 *   shared mode): paths whose working-tree hash differs from the unit's
 *   baseline (taken in that tree when its agent was spawned), that are new, or
 *   that commits since the baseline changed, each diffed against the baseline
 *   HEAD, or shown whole when git has no diff for it. The agent's work is
 *   uncommitted until the unit passes, so the item branch's commits alone
 *   would show none of it.
 * - Outside git: the paths the unit's write and edit calls named, with their
 *   current text.
 *
 * Everything here is collection and arithmetic over sizes; no judgment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { estimateTokens, type JsonValue } from '@goodvibes-jev/judgment';
import { GitService } from '../git/service.js';
import { hashWorkingTreeFile, snapshotDirtyTree } from '../orchestration/dirty-guard.js';
import { readNativePrivateReceiptArchives, verifyPrivateReceiptPreservation } from './private-read-receipts.js';
import type { ToolResult } from '../types/tools.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { CompletionReport } from '../agents/completion-report.js';
import { verifyUnitClaims, type ClaimVerificationResult } from './claims.js';
import type { ContractConfigReader } from './config.js';
import { runContractGates, type QualityGateResult } from './gates.js';
import type { CheckTrigger, ContractUnit, ContractView } from './types.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

// Kept as compatibility exports; evidence collection no longer discards content.
/** @deprecated No application evidence budget. Provider context limits apply. */
export const EVIDENCE_TOKEN_BUDGET = Number.POSITIVE_INFINITY;
/** @deprecated Full output is retained. */
export const OUTPUT_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated Full gate output is retained. */
export const GATE_OUTPUT_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated Full diffs are retained. */
export const DIFF_FILE_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated Full command output is retained. */
export const COMMAND_HEAD_LINES = Number.POSITIVE_INFINITY;
/** @deprecated Full command lines are retained. */
export const COMMAND_LINE_CAP_CHARS = Number.POSITIVE_INFINITY;
/** @deprecated All commands are retained. */
export const MAX_COMMANDS = Number.POSITIVE_INFINITY;
/** @deprecated All paths are retained. */
export const MAX_LISTED_PATHS = Number.POSITIVE_INFINITY;

// ── Shapes ────────────────────────────────────────────────────────────────────

/** One turn of a contract-bound agent, as the turn-end hook sees it (design 4.1). */
export interface ContractTurnRecord {
  readonly turn: number;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
  /** One result per tool call, in the same order. */
  readonly results: readonly ToolResult[];
  readonly assistantText: string;
}

export interface EvidenceCommand {
  readonly command: string;
  readonly success: boolean;
  /** Complete command output. */
  readonly head: string;
}

/** One observed execution, identified by its host agent and tool result. */
export interface CommandExecutionReceipt extends EvidenceCommand {
  readonly agentId: string;
  readonly turn: number;
  readonly callIndex: number;
  readonly callId: string;
}

/** One changed path and its full diff (or text, for a new file or outside git). */
export interface FileChange {
  readonly path: string;
  readonly diff: string;
}

/** Captured read scope and selected returned text; scope alone proves no review quality. */
export interface SourceReadEvidence {
  readonly path: string;
  readonly returnedRanges: readonly string[];
  readonly returnedLines: number;
  /** Actual returned text of a declared reference input, when needed by a read-only unit. */
  readonly returnedContent?: string;
  readonly contentKind?: 'declared-reference' | 'cited-source';
}

export interface UnitEvidence {
  readonly orchestration?: JsonValue;
  readonly sourceReads?: readonly SourceReadEvidence[];
  /** record.fullOutput at completion; the last assistant text mid-run. */
  readonly output: string;
  readonly changedPaths: readonly string[];
  /** Complete collected evidence. */
  readonly diff: string;
  /** Paths whose diff did not fit. */
  readonly omitted: readonly string[];
  readonly claims?: ClaimVerificationResult | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly commands: readonly EvidenceCommand[];
}

/** Evidence before trimming. */
export interface RawUnitEvidence {
  readonly orchestration?: JsonValue;
  readonly sourceReads?: readonly SourceReadEvidence[];
  readonly output: string;
  readonly changes: readonly FileChange[];
  readonly claims?: ClaimVerificationResult | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly commands: readonly EvidenceCommand[];
}

// ── Commands and written paths from the agent's turns (fixed tool formats) ─────

/** Count actual numbered contents, never requested ranges, file totals or previews. */
export function sourceReadsFromTurns(turns: readonly ContractTurnRecord[], referencePaths: readonly string[] = [], citationText = ''): SourceReadEvidence[] {
  const files = new Map<string, Set<number>>();
  const references = new Set(referencePaths);
  const referenceLines = new Map<string, Map<number, string>>();
  for (const turn of turns) for (let index = 0; index < turn.toolCalls.length; index++) {
    if (turn.toolCalls[index]!.name !== 'read') continue;
    const result = turn.results[index];
    if (!result?.success || !result.output) continue;
    let body: { success?: boolean; files?: unknown[] };
    try { body = JSON.parse(result.output); } catch { continue; }
    if (body?.success !== true || !Array.isArray(body.files)) continue;
    for (const value of body.files) {
      if (!value || typeof value !== 'object') continue;
      const file = value as { path?: unknown; extract?: unknown; content?: unknown; error?: unknown; binary?: unknown };
      if (typeof file.path !== 'string' || typeof file.content !== 'string' || file.error || file.binary
        || (file.extract !== 'content' && file.extract !== 'lines')) continue;
      const lines = files.get(file.path) ?? new Set<number>();
      const escaped = file.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const citations = [...citationText.matchAll(new RegExp('(?<![\\w./-])' + escaped + '(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g'))]
        .map(match => [Number(match[1]), Number(match[2] ?? match[1])] as const);
      for (const row of file.content.split('\n')) {
        const match = /^[ \t]*(\d+) \|/.exec(row);
        if (!match) continue;
        const line = Number(match[1]);
        if (Number.isSafeInteger(line) && line > 0) {
          lines.add(line);
          if (references.has(file.path) || citations.some(([start, end]) => line >= start && line <= end)) {
            const contents = referenceLines.get(file.path) ?? new Map<number, string>();
            contents.set(line, row);
            referenceLines.set(file.path, contents);
          }
        }
      }
      if (lines.size) files.set(file.path, lines);
    }
  }
  return [...files].map(([path, lines]) => {
    const sorted = [...lines].sort((a, b) => a - b), returnedRanges: string[] = [];
    for (let index = 0; index < sorted.length; index++) {
      const start = sorted[index]!;
      let end = start;
      while (sorted[index + 1] === end + 1) end = sorted[++index]!;
      returnedRanges.push(start === end ? String(start) : `${start}-${end}`);
    }
    const content = referenceLines.get(path);
    return { path, returnedRanges, returnedLines: lines.size,
      ...(content ? { returnedContent: [...content].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n'),
        contentKind: references.has(path) ? 'declared-reference' as const : 'cited-source' as const } : {}) };
  });
}

/** Merge retained observations with new reads; no prior verdict is carried forward. */
export function mergeSourceReads(previous: readonly SourceReadEvidence[], current: readonly SourceReadEvidence[]): SourceReadEvidence[] {
  const files = new Map<string, { ranges: [number, number][]; content: Map<number, string>; reference: boolean }>();
  for (const read of [...previous, ...current]) {
    if (typeof read.path !== 'string' || !Array.isArray(read.returnedRanges)) throw new Error('Invalid retained source-read evidence');
    const file: { ranges: [number, number][]; content: Map<number, string>; reference: boolean } = files.get(read.path) ?? { ranges: [], content: new Map(), reference: false };
    for (const range of read.returnedRanges) {
      if (typeof range !== 'string') throw new Error('Invalid retained source-read interval');
      const match = /^(\d+)(?:-(\d+))?$/.exec(range);
      const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) throw new Error('Invalid retained source-read interval');
      file.ranges.push([start, end]);
    }
    if (read.returnedContent !== undefined) {
      if (typeof read.returnedContent !== 'string') throw new Error('Invalid retained source-read contents');
      for (const row of read.returnedContent.split('\n')) {
        const match = /^[ \t]*(\d+) \|/.exec(row), line = Number(match?.[1]);
        if (match && file.ranges.some(([start, end]) => line >= start && line <= end)) file.content.set(line, row);
      }
      file.reference ||= read.contentKind === 'declared-reference';
    }
    files.set(read.path, file);
  }
  return [...files].map(([path, file]) => {
    const ranges: [number, number][] = [];
    for (const [start, end] of file.ranges.sort(([a], [b]) => a - b)) {
      const last = ranges.at(-1);
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
    return { path, returnedRanges: ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`),
      returnedLines: ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0),
      ...(file.content.size ? { returnedContent: [...file.content].sort(([a], [b]) => a - b).map(([, row]) => row).join('\n'),
        contentKind: file.reference ? 'declared-reference' as const : 'cited-source' as const } : {}) };
  });
}

function commandText(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null;
  const { cmd, cmd_base64: encoded } = item as { cmd?: unknown; cmd_base64?: unknown };
  if (typeof cmd === 'string') return cmd;
  if (typeof encoded === 'string') return Buffer.from(encoded, 'base64').toString('utf-8');
  return null;
}

function capLine(text: string): string {
  return text.length <= COMMAND_LINE_CAP_CHARS ? text : `${text.slice(0, COMMAND_LINE_CAP_CHARS)}...`;
}

/** The first COMMAND_HEAD_LINES lines of `text`, each capped. */
export function headLines(text: string, count = COMMAND_HEAD_LINES): string {
  return text.split('\n').slice(0, count).map(capLine).join('\n');
}

/** Every `exec` call in the turns: its commands, whether the call succeeded, and the head of its output. */
export function commandsFromTurns(turns: readonly ContractTurnRecord[]): EvidenceCommand[] {
  const commands: EvidenceCommand[] = [];
  for (const turn of turns) {
    turn.toolCalls.forEach((call, index) => {
      if (call.name !== 'exec') return;
      const items = Array.isArray(call.arguments['commands']) ? (call.arguments['commands'] as unknown[]) : [];
      const text = items.map(commandText).filter((value): value is string => value !== null).join('\n');
      if (text.length === 0) return;
      const result = turn.results[index];
      commands.push({ command: capLine(text), success: result?.success === true, head: headLines(result?.output ?? result?.error ?? '') });
    });
  }
  return commands;
}

/** Keep distinct executions even when their command text and output are identical. */
export function commandReceiptsFromTurns(agentId: string, turns: readonly ContractTurnRecord[]): CommandExecutionReceipt[] {
  return turns.flatMap(turn => turn.toolCalls.flatMap((call, index) => {
    const result = turn.results[index];
    if (call.name !== 'exec' || !result) return [];
    return commandsFromTurns([{ ...turn, toolCalls: [call], results: [result] }])
      .map(command => ({ ...command, agentId, turn: turn.turn, callIndex: index, callId: result.callId }));
  }));
}

/** Merge by execution identity; replaying a receipt does not repeat a command. */
export function mergeCommandReceipts(previous: readonly CommandExecutionReceipt[], current: readonly CommandExecutionReceipt[]): CommandExecutionReceipt[] {
  const receipts = new Map<string, CommandExecutionReceipt>();
  for (const receipt of [...previous, ...current]) {
    const key = JSON.stringify([receipt.agentId, receipt.turn, receipt.callIndex, receipt.callId]);
    const retained = receipts.get(key);
    if (retained && (retained.command !== receipt.command || retained.success !== receipt.success || retained.head !== receipt.head)) {
      throw new Error('Conflicting command execution receipts');
    }
    receipts.set(key, receipt);
  }
  return [...receipts.values()];
}

/** The paths the turns' `write` and `edit` calls named, in first-seen order. */
export function writtenPaths(turns: readonly ContractTurnRecord[]): string[] {
  const paths = new Set<string>();
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const key = call.name === 'write' ? 'files' : call.name === 'edit' ? 'edits' : null;
      if (key === null) continue;
      const items = Array.isArray(call.arguments[key]) ? (call.arguments[key] as unknown[]) : [];
      for (const item of items) {
        const path = item !== null && typeof item === 'object' ? (item as { path?: unknown }).path : undefined;
        if (typeof path === 'string' && path.length > 0) paths.add(path);
      }
    }
  }
  return [...paths];
}

// ── Changed paths and their diffs ─────────────────────────────────────────────

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return code === 0 ? stdout : null;
  } catch (error) {
    logger.warn('contract evidence: git did not run', { args: args.join(' '), error: summarizeError(error) });
    return null;
  }
}

/** A file's current text for evidence, or a note when it is gone or binary. */
function fileText(cwd: string, path: string): string {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  if (!existsSync(absolute)) return `(${path} no longer exists)`;
  try {
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) return `(binary file, ${bytes.length} bytes)`;
    return bytes.toString('utf-8');
  } catch (error) {
    return `(${path} could not be read: ${summarizeError(error)})`;
  }
}

/** Splits a unified diff into one entry per file, keyed by its new path. */
export function splitUnifiedDiff(unifiedDiff: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const chunk of unifiedDiff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (header !== null) changes.push({ path: header[2]!, diff: chunk.trimEnd() });
  }
  return changes;
}

/** Shared mode: what changed in `cwd` since the unit's baseline, with each path's diff. */
async function sharedTreeChanges(cwd: string, baseline: ContractUnit['baseline']): Promise<FileChange[]> {
  const dirtyAtBaseline = baseline?.dirty ?? {};
  const now = snapshotDirtyTree(cwd);
  const paths = new Set<string>();
  for (const [path, hash] of now) if (!(path in dirtyAtBaseline) || dirtyAtBaseline[path] !== hash) paths.add(path);
  for (const [path, hash] of Object.entries(dirtyAtBaseline)) if (!now.has(path) && hashWorkingTreeFile(cwd, path) !== hash) paths.add(path);
  const head = (await git(cwd, ['rev-parse', 'HEAD']))?.trim() || null;
  const base = baseline?.head ?? head;
  if (baseline?.head && head !== null && head !== baseline.head) {
    const committed = await git(cwd, ['diff', '--name-only', baseline.head, head]);
    for (const path of (committed ?? '').split('\n').filter(Boolean)) paths.add(path);
  }
  const changes: FileChange[] = [];
  for (const path of paths) {
    const diff = base === null ? '' : ((await git(cwd, ['diff', base, '--', path])) ?? '');
    changes.push({ path, diff: diff.trim().length > 0 ? diff.trimEnd() : `new file ${path}\n${fileText(cwd, path)}` });
  }
  return changes;
}

/** Outside git: the paths the unit wrote or edited, with their current text. */
function writtenChanges(cwd: string, turns: readonly ContractTurnRecord[]): FileChange[] {
  return writtenPaths(turns).map((path) => ({
    path: isAbsolute(path) ? relative(cwd, path) : path,
    diff: `${path}\n${fileText(cwd, path)}`,
  }));
}

// ── Collection ────────────────────────────────────────────────────────────────

/** Where one unit's evidence comes from. */
export interface UnitEvidenceSources {
  /** The final output at completion; the last assistant text mid-run. */
  readonly output: string;
  /** Every turn the unit's agents reported through the turn-end hook. */
  readonly turns: readonly ContractTurnRecord[];
  /** The unit's worktree path, or the project root in shared mode. */
  readonly cwd: string;
  readonly configManager: ContractConfigReader;
  readonly signal?: AbortSignal | undefined;
  readonly runtimeBus: RuntimeEventBus;
  /**
   * The completion report the agent's output ends with, null when it gave none.
   * A check at completion parses it from `output`; a check after a restart reads
   * the one stored on the unit, since `output` is then capped head and tail.
   */
  readonly report: CompletionReport | null;
  /** Whether the unit's plan role has it change files (`unitMustWrite`), which decides whether its claims are checked. */
  readonly mustWrite: boolean;
  /** When given, only these changed paths are evidence (a unit's re-check after a planned fix). */
  readonly paths?: ReadonlySet<string> | null | undefined;
}

/** Triggers whose evidence includes gate results (design 4.3). */
const GATED_TRIGGERS: ReadonlySet<CheckTrigger> = new Set(['completion', 'agent-failed', 'fix-passed', 'resume', 'owner-amend']);

/** The changed files of a unit, from the source its isolation mode gives. */
export async function collectChanges(unit: Pick<ContractUnit, 'baseline'>, sources: Pick<UnitEvidenceSources, 'cwd' | 'turns'>): Promise<FileChange[]> {
  if (GitService.isGitRepo(sources.cwd)) return sharedTreeChanges(sources.cwd, unit.baseline);
  return writtenChanges(sources.cwd, sources.turns);
}

/**
 * Collects a unit's complete evidence for one check: the diff
 * always; claims at completion and at resume; gates at every trigger but turn-end.
 */
export async function collectUnitEvidence(
  contract: Pick<ContractView, 'id' | 'sessionId'> & Partial<Pick<ContractView, 'status' | 'decisions' | 'createdAt' | 'origin' | 'units' | 'proposedUnits' | 'projectRoot' | 'inputSnapshot'>>,
  unit: Pick<ContractUnit, 'id' | 'goal' | 'brief' | 'files' | 'baseline' | 'readEvidence' | 'commandEvidence'>,
  trigger: CheckTrigger,
  sources: UnitEvidenceSources,
): Promise<UnitEvidence> {
  const collected = await collectChanges(unit, sources);
  const scope = sources.paths;
  const changes = scope === null || scope === undefined ? collected : collected.filter((change) => scope.has(change.path));
  // Claims are checked against the unit's own baseline-scoped changes (the same paths the evidence lists), not the whole tree.
  const claims = trigger === 'completion' || trigger === 'resume'
    ? verifyUnitClaims(sources.report, { cwd: sources.cwd, mustWrite: sources.mustWrite, changedPaths: changes.map((change) => change.path) })
    : undefined;
  const configuredGates = GATED_TRIGGERS.has(trigger)
    ? await runContractGates({
      configManager: sources.configManager,
      cwd: sources.cwd,
      runtimeBus: sources.runtimeBus,
      sessionId: contract.sessionId,
      contractId: contract.id,
      targetId: unit.id,
      signal: sources.signal,
    })
    : undefined;
  const preservation = verifyPrivateReceiptPreservation(contract, unit, sources.cwd);
  const gates = preservation ? [...(configuredGates ?? []), preservation] : configuredGates;
  const planChecks = contract.decisions?.filter(decision => decision.action === 'plan-accepted' && decision.targetId === contract.id)
    .map(decision => ({ at: decision.at, reason: decision.reason, decisionIds: [...decision.decisionIds] })) ?? [];
  const firstUnitStartedAt = contract.decisions?.find(decision => decision.action === 'spawned' && contract.units?.some(unit => unit.id === decision.targetId))?.at;
  const currentReads = sourceReadsFromTurns(sources.turns, sources.mustWrite ? [] : unit.files, sources.output);
  const currentUnit = contract.units?.find(planned => planned.id === unit.id);
  const repairing = currentUnit?.criteria.some(criterion => criterion.origin === 'fix') === true;
  const privateArtifacts = readNativePrivateReceiptArchives(contract, unit.files);
  return trimEvidence({ output: sources.output, changes, claims, gates, commands: unit.commandEvidence ?? commandsFromTurns(sources.turns),
    sourceReads: sources.mustWrite ? currentReads : mergeSourceReads(unit.readEvidence ?? [], currentReads),
    ...(planChecks.length ? { orchestration: { contractId: contract.id, ...(contract.status === undefined ? {} : { status: contract.status }), planChecks,
      ...(privateArtifacts.length ? { privateArtifacts } : {}),
      ...(contract.createdAt === undefined ? {} : { createdAt: contract.createdAt }),
      ...(contract.origin === undefined ? {} : { origin: contract.origin }),
      ...(firstUnitStartedAt === undefined ? {} : { firstUnitStartedAt }),
      ...(contract.proposedUnits === undefined ? {} : { proposedUnits: contract.proposedUnits.map(unit => ({ task: unit.task, ...(unit.template === undefined ? {} : { template: unit.template }) })) }),
      ...(contract.units === undefined ? {} : { plannedUnits: contract.units.map(planned => ({ id: planned.id, title: planned.title, goal: planned.goal, role: planned.role, brief: planned.brief,
        ...(planned.id === unit.id ? {} : { status: planned.status,
          latestCheck: planned.checks.length ? { id: planned.checks.at(-1)!.id, trigger: planned.checks.at(-1)!.trigger,
            result: planned.checks.at(-1)!.result, decisionIds: [...planned.checks.at(-1)!.decisionIds],
            ...(planned.checks.at(-1)!.gates === undefined ? {} : { gates: gateEvidence(planned.checks.at(-1)!.gates!) }) } : null,
          ...(planned.status === 'passed' ? { readObservations: (planned.readEvidence ?? []).map(read => ({ path: read.path,
            returnedRanges: [...read.returnedRanges], returnedLines: read.returnedLines })),
            commands: (planned.commandEvidence ?? []).map(({ agentId, turn, callIndex, callId, command, success, head }) => ({ agentId, turn, callIndex, callId, command, success, head })),
            ...(currentUnit?.role === 'integration' || (repairing && (planned.role === 'integration' || currentUnit?.dependsOn.includes(planned.id)))
              ? { acceptedAnswer: planned.answer ?? '' } : {}) } : {}) }),
        criteria: planned.criteria.map(criterion => ({ id: criterion.id, text: criterion.text, serves: [...criterion.serves] })) })) }),
      meaning: 'Host records for this current contract. Plan acceptance establishes its plan validation, not completion or approval of the unit now being checked.' } } : {}) }, unit);
}

// ── What Jev reads ────────────────────────────────────────────────────────────

/** A path list for the state: at most MAX_LISTED_PATHS, then a count of the rest. */
export function listedPaths(paths: readonly string[]): string[] {
  if (paths.length <= MAX_LISTED_PATHS) return [...paths];
  return [...paths.slice(0, MAX_LISTED_PATHS), `(+${paths.length - MAX_LISTED_PATHS} more)`];
}

/** The evidence object the judge reads beside the output. */
/** The gate results a check state carries. */
function gateEvidence(gates: NonNullable<UnitEvidence['gates']>): JsonValue {
  return gates.map((gate) => ({ gate: gate.gate, passed: gate.passed, skipped: gate.skipped === true, output: gate.output }));
}

export function judgeEvidence(evidence: UnitEvidence): JsonValue {
  const hostOperations = privateArchiveOperations(evidence);
  return {
    ...(hostOperations.length ? { hostOperations } : {}),
    ...(evidence.orchestration === undefined ? {} : { orchestration: evidence.orchestration }),
    ...sourceReadState(evidence),
    changedPaths: listedPaths(evidence.changedPaths),
    diff: evidence.diff,
    omitted: listedPaths(evidence.omitted),
    ...(evidence.claims === undefined
      ? {}
      : { claims: { kind: evidence.claims.kind, summary: evidence.claims.summary, missingPaths: listedPaths(evidence.claims.missingPaths) } }),
    ...(evidence.gates === undefined
      ? {}
      : { gates: gateEvidence(evidence.gates) }),
    commands: evidence.commands.map((command) => ({ ...command })),
  };
}

/** A check request's state: one object of named JSON values. */
export type CheckState = { [key: string]: JsonValue };

/** The judge's whole state, as the judge pattern builds it: `{ goal, output, evidence }`. */
export function judgeState(unit: Pick<ContractUnit, 'goal'>, evidence: UnitEvidence): CheckState {
  return { goal: unit.goal, output: evidence.output, evidence: judgeEvidence(evidence) };
}

/** The quality battery's state (design 4.4). */
export function qualityState(unit: Pick<ContractUnit, 'goal' | 'brief'>, evidence: UnitEvidence): CheckState {
  const hostOperations = privateArchiveOperations(evidence);
  return {
    ...(hostOperations.length ? { hostOperations } : {}),
    ...(evidence.orchestration === undefined ? {} : { orchestration: evidence.orchestration }),
    ...sourceReadState(evidence),
    goal: unit.goal,
    brief: unit.brief,
    changedPaths: listedPaths(evidence.changedPaths),
    diff: evidence.diff,
    omitted: listedPaths(evidence.omitted),
    commands: evidence.commands.map((command) => ({ ...command })),
    // A gate's result shows a claim such as "the tests pass" as well as a command the agent ran.
    ...(evidence.gates === undefined ? {} : { gates: gateEvidence(evidence.gates) }),
    output: evidence.output,
  };
}

function privateArchiveOperations(evidence: UnitEvidence): JsonValue[] {
  const orchestration = evidence.orchestration;
  if (!orchestration || typeof orchestration !== 'object' || Array.isArray(orchestration)) return [];
  const archives = orchestration['privateArtifacts'];
  if (!Array.isArray(archives)) return [];
  return archives.flatMap(archive => archive && typeof archive === 'object' && !Array.isArray(archive)
    && archive['kind'] === 'contract-read-receipts' && archive['hostFileRead'] ? [archive['hostFileRead']] : []);
}

function sourceReadState(evidence: UnitEvidence): CheckState {
  if (!evidence.sourceReads?.length) return {};
  return {
    sourceReads: evidence.sourceReads.map(read => ({ ...read, returnedRanges: [...read.returnedRanges] })),
    sourceReadMeaning: 'These host-collected ranges establish which numbered source lines were actually returned by successful read tools. returnedContent contains only actual returned text: declared reference inputs or explicitly cited source ranges, as contentKind records; it may be a subset of returnedRanges. For large inputs, Jev may identify receipt-only citation paragraphs: their source quotations are omitted from this check view while the full report, all returned-range records and raw saved evidence remain intact. Substantive and mixed citation contexts retain their primary text. Read scope alone does not establish semantic review quality or validate findings; missing primary text is not proof of a substantive claim. Judge the substantive work against the provided source evidence separately. This is the current native acceptance check; do not demand an earlier approval of this same check.',
  };
}

/** Estimated tokens of the larger of the two check states for this evidence. */
export function evidenceTokens(unit: Pick<ContractUnit, 'goal' | 'brief'>, evidence: UnitEvidence): number {
  return Math.max(estimateTokens(judgeState(unit, evidence)), estimateTokens(qualityState(unit, evidence)));
}

// ── Trimming (design 4.3) ─────────────────────────────────────────────────────

/** The head and tail of `text` within `cap` characters, with the cut stated. */
export function headAndTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const keep = Math.floor(cap / 2);
  return `${text.slice(0, keep)}\n[... ${text.length - 2 * keep} characters omitted ...]\n${text.slice(text.length - keep)}`;
}

/** The last `cap` characters of `text`, with the cut stated. */
export function tail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `[... ${text.length - cap} characters omitted ...]\n${text.slice(text.length - cap)}`;
}

/** Changes in fill order: the unit's `files` in their listed order, then the rest smallest first. */
function fillOrder(changes: readonly FileChange[], files: readonly string[]): FileChange[] {
  const rank = (path: string): number => {
    const index = files.indexOf(path);
    return index === -1 ? files.length : index;
  };
  return [...changes].sort((a, b) => rank(a.path) - rank(b.path) || a.diff.length - b.diff.length);
}

/** Assemble complete evidence without per-file, command, output or total cuts. */
export function trimEvidence(raw: RawUnitEvidence, unit: Pick<ContractUnit, 'goal' | 'brief' | 'files'>): UnitEvidence {
  return {
    ...(raw.orchestration === undefined ? {} : { orchestration: raw.orchestration }),
    ...(raw.sourceReads?.length ? { sourceReads: raw.sourceReads } : {}),
    output: raw.output,
    changedPaths: raw.changes.map(change => change.path),
    diff: fillOrder(raw.changes, unit.files).map(change => change.diff).join('\n\n'),
    omitted: [],
    ...(raw.claims === undefined ? {} : { claims: raw.claims }),
    ...(raw.gates === undefined ? {} : { gates: raw.gates }),
    commands: raw.commands,
  };
}
