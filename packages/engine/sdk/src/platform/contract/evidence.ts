/**
 * A unit's evidence (docs/design/contract-runner.md section 4.3): what Jev
 * reads when it checks the unit. The diff of the paths the unit touched, the
 * claim verification and gate results (at the triggers that run them), the
 * agent's output and the commands it ran, trimmed so the request stays inside
 * the Jev context budget.
 *
 * Where the diff comes from:
 * - Worktree mode: the unit's item branch against its base (IsolatedWorktree.diff).
 * - Shared mode in git: paths whose working-tree hash differs from the unit's
 *   baseline (taken when its agent was spawned) or that are new, each diffed
 *   against the baseline HEAD, or shown whole when git has no diff for it.
 * - Outside git: the paths the unit's write and edit calls named, with their
 *   current text.
 *
 * Everything here is collection and arithmetic over sizes; no judgment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { estimateTokens, type JsonValue } from '@goodvibes-jev/judgment';
import type { IsolatedWorktree } from '../agents/worktree.js';
import { GitService } from '../git/service.js';
import { hashWorkingTreeFile, snapshotDirtyTree } from '../orchestration/dirty-guard.js';
import type { ToolResult } from '../types/tools.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { parseUnitCompletionReport, verifyUnitClaims, type ClaimVerificationResult } from './claims.js';
import type { ContractConfigReader } from './config.js';
import { runContractGates, type QualityGateResult } from './gates.js';
import type { CheckTrigger, ContractUnit, ContractView } from './types.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

// ── Budget (design 4.3) ────────────────────────────────────────────────────────

/** Estimated tokens the whole state of a check request may take (the Jev limit is 32k for state plus the longest question). */
export const EVIDENCE_TOKEN_BUDGET = 24_000;
/** The agent's output, head and tail. */
export const OUTPUT_CAP_CHARS = 12_000;
/** Each gate's output, from the end, where failures print. */
export const GATE_OUTPUT_CAP_CHARS = 4_000;
/** Each file's diff. */
export const DIFF_FILE_CAP_CHARS = 8_000;
/** Lines of each command's output. */
export const COMMAND_HEAD_LINES = 20;
/** Characters of each of those lines. */
export const COMMAND_LINE_CAP_CHARS = 240;
/** The most recent commands kept; older ones are dropped first when the budget is short. */
export const MAX_COMMANDS = 40;
/** Paths listed in `changedPaths` or `omitted` before the rest are counted. */
export const MAX_LISTED_PATHS = 300;

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
  /** The first lines of its output. */
  readonly head: string;
}

/** One changed path and its full diff (or text, for a new file or outside git). */
export interface FileChange {
  readonly path: string;
  readonly diff: string;
}

export interface UnitEvidence {
  /** record.fullOutput at completion; the last assistant text mid-run. */
  readonly output: string;
  readonly changedPaths: readonly string[];
  /** Trimmed to the budget. */
  readonly diff: string;
  /** Paths whose diff did not fit. */
  readonly omitted: readonly string[];
  readonly claims?: ClaimVerificationResult | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly commands: readonly EvidenceCommand[];
}

/** Evidence before trimming. */
export interface RawUnitEvidence {
  readonly output: string;
  readonly changes: readonly FileChange[];
  readonly claims?: ClaimVerificationResult | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly commands: readonly EvidenceCommand[];
}

// ── Commands and written paths from the agent's turns (fixed tool formats) ─────

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
  /** The unit's item worktree, in worktree mode. */
  readonly worktree?: Pick<IsolatedWorktree, 'diff'> | undefined;
  readonly configManager: ContractConfigReader;
  readonly runtimeBus: RuntimeEventBus;
  /** When given, only these changed paths are evidence (a unit's re-check after a planned fix). */
  readonly paths?: ReadonlySet<string> | null | undefined;
}

/** Triggers whose evidence includes gate results (design 4.3). */
const GATED_TRIGGERS: ReadonlySet<CheckTrigger> = new Set(['completion', 'agent-failed', 'fix-passed', 'resume', 'owner-amend']);

/** The changed files of a unit, from the source its isolation mode gives. */
export async function collectChanges(unit: Pick<ContractUnit, 'baseline'>, sources: Pick<UnitEvidenceSources, 'cwd' | 'turns' | 'worktree'>): Promise<FileChange[]> {
  if (sources.worktree !== undefined) return splitUnifiedDiff((await sources.worktree.diff()).unifiedDiff);
  if (GitService.isGitRepo(sources.cwd)) return sharedTreeChanges(sources.cwd, unit.baseline);
  return writtenChanges(sources.cwd, sources.turns);
}

/**
 * Collects a unit's evidence for one check, trimmed to the budget: the diff
 * always; claims at completion and at resume; gates at every trigger but turn-end.
 */
export async function collectUnitEvidence(
  contract: Pick<ContractView, 'id' | 'sessionId'>,
  unit: Pick<ContractUnit, 'id' | 'goal' | 'brief' | 'files' | 'baseline'>,
  trigger: CheckTrigger,
  sources: UnitEvidenceSources,
): Promise<UnitEvidence> {
  const collected = await collectChanges(unit, sources);
  const scope = sources.paths;
  const changes = scope === null || scope === undefined ? collected : collected.filter((change) => scope.has(change.path));
  // A check after a restart reads the completion report the earlier agent left (design 7.2).
  const claims = trigger === 'completion' || trigger === 'resume' ? verifyUnitClaims(parseUnitCompletionReport(sources.output), sources.cwd) : undefined;
  const gates = GATED_TRIGGERS.has(trigger)
    ? await runContractGates({
      configManager: sources.configManager,
      cwd: sources.cwd,
      runtimeBus: sources.runtimeBus,
      sessionId: contract.sessionId,
      contractId: contract.id,
      targetId: unit.id,
    })
    : undefined;
  return trimEvidence({ output: sources.output, changes, claims, gates, commands: commandsFromTurns(sources.turns) }, unit);
}

// ── What Jev reads ────────────────────────────────────────────────────────────

/** A path list for the state: at most MAX_LISTED_PATHS, then a count of the rest. */
export function listedPaths(paths: readonly string[]): string[] {
  if (paths.length <= MAX_LISTED_PATHS) return [...paths];
  return [...paths.slice(0, MAX_LISTED_PATHS), `(+${paths.length - MAX_LISTED_PATHS} more)`];
}

/** The evidence object the judge reads beside the output. */
export function judgeEvidence(evidence: UnitEvidence): JsonValue {
  return {
    changedPaths: listedPaths(evidence.changedPaths),
    diff: evidence.diff,
    omitted: listedPaths(evidence.omitted),
    ...(evidence.claims === undefined
      ? {}
      : { claims: { kind: evidence.claims.kind, summary: evidence.claims.summary, missingPaths: listedPaths(evidence.claims.missingPaths) } }),
    ...(evidence.gates === undefined
      ? {}
      : { gates: evidence.gates.map((gate) => ({ gate: gate.gate, passed: gate.passed, skipped: gate.skipped === true, output: gate.output })) }),
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
  return {
    goal: unit.goal,
    brief: unit.brief,
    changedPaths: listedPaths(evidence.changedPaths),
    diff: evidence.diff,
    commands: evidence.commands.map((command) => ({ ...command })),
    output: evidence.output,
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

function capFileDiff(change: FileChange): string {
  if (change.diff.length <= DIFF_FILE_CAP_CHARS) return change.diff;
  return `${change.diff.slice(0, DIFF_FILE_CAP_CHARS)}\n[... ${change.diff.length - DIFF_FILE_CAP_CHARS} characters of ${change.path} omitted ...]`;
}

/** Changes in fill order: the unit's `files` in their listed order, then the rest smallest first. */
function fillOrder(changes: readonly FileChange[], files: readonly string[]): FileChange[] {
  const rank = (path: string): number => {
    const index = files.indexOf(path);
    return index === -1 ? files.length : index;
  };
  return [...changes].sort((a, b) => rank(a.path) - rank(b.path) || a.diff.length - b.diff.length);
}

/**
 * Trims raw evidence so the larger check state stays under
 * EVIDENCE_TOKEN_BUDGET: output head and tail, gate output tails, the most
 * recent commands, then the diff filled file by file until the budget is used,
 * the rest listed in `omitted`. When even an empty diff does not fit, older
 * commands go first, then the output is cut further.
 */
export function trimEvidence(raw: RawUnitEvidence, unit: Pick<ContractUnit, 'goal' | 'brief' | 'files'>): UnitEvidence {
  let commands = raw.commands.slice(-MAX_COMMANDS);
  let output = headAndTail(raw.output, OUTPUT_CAP_CHARS);
  const gates = raw.gates?.map((gate) => ({ ...gate, output: tail(gate.output, GATE_OUTPUT_CAP_CHARS) }));
  const changedPaths = raw.changes.map((change) => change.path);
  const ordered = fillOrder(raw.changes, unit.files);
  const base = (): UnitEvidence => ({
    output,
    changedPaths,
    diff: '',
    omitted: ordered.map((change) => change.path),
    ...(raw.claims === undefined ? {} : { claims: raw.claims }),
    ...(gates === undefined ? {} : { gates }),
    commands,
  });

  while (evidenceTokens(unit, base()) > EVIDENCE_TOKEN_BUDGET && commands.length > 0) commands = commands.slice(Math.ceil(commands.length / 2));
  while (evidenceTokens(unit, base()) > EVIDENCE_TOKEN_BUDGET && output.length > 200) output = headAndTail(raw.output, Math.floor(output.length / 2));

  const included: string[] = [];
  const omitted: string[] = [];
  let evidence = base();
  for (const change of ordered) {
    const section = capFileDiff(change);
    const candidate: UnitEvidence = { ...evidence, diff: [...included, section].join('\n\n') };
    if (evidenceTokens(unit, { ...candidate, omitted: [...omitted, ...ordered.slice(included.length + omitted.length + 1).map((c) => c.path)] }) <= EVIDENCE_TOKEN_BUDGET) {
      included.push(section);
      evidence = candidate;
    } else {
      omitted.push(change.path);
    }
  }
  return { ...evidence, diff: included.join('\n\n'), omitted };
}
