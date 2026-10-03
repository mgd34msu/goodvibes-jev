import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreFile } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';

export type AgentResearchRunStatus = 'planned' | 'running' | 'paused' | 'blocked' | 'cancelled' | 'completed' | 'failed';
export type AgentResearchRunPhase = 'planning' | 'searching' | 'reading' | 'synthesizing' | 'reviewing' | 'reporting';

export interface AgentResearchRunCheckpoint {
  readonly id: string;
  readonly at: string;
  readonly phase: AgentResearchRunPhase;
  readonly status: AgentResearchRunStatus;
  readonly progress: number;
  readonly note: string;
  readonly nextSteps: readonly string[];
  readonly sourceIds: readonly string[];
}

export interface AgentResearchRunRecord {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly goal: string;
  readonly status: AgentResearchRunStatus;
  readonly phase: AgentResearchRunPhase;
  readonly progress: number;
  readonly plan: readonly string[];
  readonly nextSteps: readonly string[];
  readonly sourceIds: readonly string[];
  readonly checkpoints: readonly AgentResearchRunCheckpoint[];
  readonly reportArtifactId?: string;
  readonly note?: string;
  readonly error?: string;
  readonly provenance: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly pausedAt?: string;
  readonly cancelledAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
}

export interface AgentResearchRunCreateInput {
  readonly title: string;
  readonly question: string;
  readonly goal?: string;
  readonly plan?: readonly string[];
  readonly nextSteps?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly note?: string;
  readonly provenance?: string;
}

export interface AgentResearchRunCheckpointInput {
  readonly phase?: AgentResearchRunPhase;
  readonly status?: AgentResearchRunStatus;
  readonly progress?: number;
  readonly note: string;
  readonly nextSteps?: readonly string[];
  readonly sourceIds?: readonly string[];
}

export interface AgentResearchRunCompletionInput {
  readonly note?: string;
  readonly reportArtifactId?: string;
  readonly sourceIds?: readonly string[];
}

export interface AgentResearchRunSnapshot {
  readonly path: string;
  readonly runs: readonly AgentResearchRunRecord[];
  readonly planned: readonly AgentResearchRunRecord[];
  readonly running: readonly AgentResearchRunRecord[];
  readonly paused: readonly AgentResearchRunRecord[];
  readonly blocked: readonly AgentResearchRunRecord[];
  readonly cancelled: readonly AgentResearchRunRecord[];
  readonly completed: readonly AgentResearchRunRecord[];
  readonly failed: readonly AgentResearchRunRecord[];
}

interface ResearchRunStoreFile {
  readonly version: 1;
  readonly runs: readonly AgentResearchRunRecord[];
}

type AgentResearchRunStorePaths = Pick<ShellPathService, 'resolveProjectPath'>;

const STORE_VERSION = 1;
const TERMINAL_STATUSES = new Set<AgentResearchRunStatus>(['cancelled', 'completed', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'research-run';
}

function nowIso(): string {
  return new Date().toISOString();
}

function status(value: unknown): AgentResearchRunStatus {
  if (
    value === 'running'
    || value === 'paused'
    || value === 'blocked'
    || value === 'cancelled'
    || value === 'completed'
    || value === 'failed'
  ) return value;
  return 'planned';
}

function phase(value: unknown): AgentResearchRunPhase {
  if (
    value === 'searching'
    || value === 'reading'
    || value === 'synthesizing'
    || value === 'reviewing'
    || value === 'reporting'
  ) return value;
  return 'planning';
}

function boundedProgress(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function checkpointId(at: string, count: number): string {
  return `cp-${at.replace(/[^0-9]/g, '').slice(0, 14)}-${count + 1}`;
}

function assertRunContentSafe(fields: readonly string[]): void {
  assertNoSecretLikeText(fields, 'Research run ledger');
}

function parseCheckpoint(value: unknown): AgentResearchRunCheckpoint | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const at = readString(value.at).trim();
  const note = readString(value.note).trim();
  if (!id || !at || !note) return null;
  return {
    id,
    at,
    phase: phase(value.phase),
    status: status(value.status),
    progress: boundedProgress(value.progress),
    note,
    nextSteps: readStringArray(value.nextSteps),
    sourceIds: readStringArray(value.sourceIds),
  };
}

function parseRun(value: unknown): AgentResearchRunRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeText(readString(value.title));
  const question = normalizeText(readString(value.question));
  const goal = readString(value.goal).trim();
  if (!id || !title || !question || !goal) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const note = readString(value.note).trim();
  const error = readString(value.error).trim();
  const reportArtifactId = readString(value.reportArtifactId).trim();
  const startedAt = readString(value.startedAt).trim();
  const pausedAt = readString(value.pausedAt).trim();
  const cancelledAt = readString(value.cancelledAt).trim();
  const completedAt = readString(value.completedAt).trim();
  const failedAt = readString(value.failedAt).trim();
  return {
    id,
    title,
    question,
    goal,
    status: status(value.status),
    phase: phase(value.phase),
    progress: boundedProgress(value.progress),
    plan: readStringArray(value.plan),
    nextSteps: readStringArray(value.nextSteps),
    sourceIds: readStringArray(value.sourceIds),
    checkpoints: Array.isArray(value.checkpoints)
      ? value.checkpoints.map(parseCheckpoint).filter((entry): entry is AgentResearchRunCheckpoint => entry !== null)
      : [],
    ...(reportArtifactId ? { reportArtifactId } : {}),
    ...(note ? { note } : {}),
    ...(error ? { error } : {}),
    provenance: readString(value.provenance, 'agent-research-runs').trim() || 'agent-research-runs',
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    ...(startedAt ? { startedAt } : {}),
    ...(pausedAt ? { pausedAt } : {}),
    ...(cancelledAt ? { cancelledAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(failedAt ? { failedAt } : {}),
  };
}

function parseStore(raw: string): ResearchRunStoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { version: STORE_VERSION, runs: [] };
  return {
    version: STORE_VERSION,
    runs: Array.isArray(parsed.runs)
      ? parsed.runs.map(parseRun).filter((entry): entry is AgentResearchRunRecord => entry !== null)
      : [],
  };
}

function formatStore(store: ResearchRunStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

export function researchRunStorePath(shellPaths: AgentResearchRunStorePaths): string {
  return shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'research', 'runs.json');
}

export function researchRunReportLine(run: AgentResearchRunRecord): string {
  const sourceSummary = run.sourceIds.length > 0 ? `${run.sourceIds.length} source(s)` : 'no sources';
  const artifact = run.reportArtifactId ? ` report ${run.reportArtifactId}` : '';
  return `${run.title} | ${run.status}/${run.phase} | ${run.progress}% | ${sourceSummary}${artifact}`;
}

export function researchRunLogTail(run: AgentResearchRunRecord, limit = 5): readonly string[] {
  const entries = [
    ...(run.startedAt ? [{
      at: run.startedAt,
      line: `${run.startedAt} started ${run.status}/${run.phase} ${run.progress}%${run.note ? ` ${run.note}` : ''}`,
    }] : []),
    ...run.checkpoints.map((checkpoint) => ({
      at: checkpoint.at,
      line: [
        `${checkpoint.at} checkpoint ${checkpoint.status}/${checkpoint.phase} ${checkpoint.progress}%`,
        checkpoint.note,
        checkpoint.sourceIds.length > 0 ? `sources ${checkpoint.sourceIds.join(', ')}` : '',
        checkpoint.nextSteps.length > 0 ? `next ${checkpoint.nextSteps.join('; ')}` : '',
      ].filter(Boolean).join(' | '),
    })),
    ...(run.pausedAt ? [{ at: run.pausedAt, line: `${run.pausedAt} paused ${run.status}/${run.phase} ${run.progress}%${run.note ? ` ${run.note}` : ''}` }] : []),
    ...(run.cancelledAt ? [{ at: run.cancelledAt, line: `${run.cancelledAt} cancelled ${run.status}/${run.phase} ${run.progress}%${run.note ? ` ${run.note}` : ''}` }] : []),
    ...(run.completedAt ? [{ at: run.completedAt, line: `${run.completedAt} completed ${run.status}/${run.phase} ${run.progress}%${run.reportArtifactId ? ` artifact ${run.reportArtifactId}` : ''}` }] : []),
    ...(run.failedAt ? [{ at: run.failedAt, line: `${run.failedAt} failed ${run.status}/${run.phase} ${run.progress}%${run.error ? ` ${run.error}` : ''}` }] : []),
  ].sort((left, right) => left.at.localeCompare(right.at));
  return entries.slice(-Math.max(1, Math.min(20, Math.trunc(limit)))).map((entry) => entry.line);
}

export class AgentResearchRunRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentResearchRunStorePaths): AgentResearchRunRegistry {
    return new AgentResearchRunRegistry(researchRunStorePath(shellPaths));
  }

  public snapshot(): AgentResearchRunSnapshot {
    const runs = [...this.readStore().runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      path: this.storePath,
      runs,
      planned: runs.filter((run) => run.status === 'planned'),
      running: runs.filter((run) => run.status === 'running'),
      paused: runs.filter((run) => run.status === 'paused'),
      blocked: runs.filter((run) => run.status === 'blocked'),
      cancelled: runs.filter((run) => run.status === 'cancelled'),
      completed: runs.filter((run) => run.status === 'completed'),
      failed: runs.filter((run) => run.status === 'failed'),
    };
  }

  public list(statusFilter?: AgentResearchRunStatus): readonly AgentResearchRunRecord[] {
    const runs = this.snapshot().runs;
    return statusFilter ? runs.filter((run) => run.status === statusFilter) : runs;
  }

  public search(query: string): readonly AgentResearchRunRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((run) => [
      run.id,
      run.title,
      run.question,
      run.goal,
      run.status,
      run.phase,
      run.note ?? '',
      run.error ?? '',
      run.reportArtifactId ?? '',
      ...run.plan,
      ...run.nextSteps,
      ...run.sourceIds,
      ...run.checkpoints.flatMap((checkpoint) => [
        checkpoint.id,
        checkpoint.note,
        checkpoint.phase,
        checkpoint.status,
        ...checkpoint.nextSteps,
        ...checkpoint.sourceIds,
      ]),
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrTitle: string): AgentResearchRunRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((run) => (
      run.id.toLowerCase() === lookup
      || run.title.toLowerCase() === lookup
    )) ?? null;
  }

  public create(input: AgentResearchRunCreateInput): AgentResearchRunRecord {
    const store = this.readStore();
    const title = normalizeText(input.title);
    const question = normalizeText(input.question);
    const goal = input.goal?.trim() || question;
    const plan = normalizeList(input.plan);
    const nextSteps = normalizeList(input.nextSteps);
    const sourceIds = normalizeList(input.sourceIds);
    const note = input.note?.trim();
    if (!title) throw new Error('title is required.');
    if (!question) throw new Error('question is required.');
    if (!goal) throw new Error('goal is required.');
    assertRunContentSafe([title, question, goal, ...plan, ...nextSteps, ...sourceIds, note ?? '']);
    const id = this.uniqueId(store.runs, title);
    const timestamp = nowIso();
    const run: AgentResearchRunRecord = {
      id,
      title,
      question,
      goal,
      status: 'planned',
      phase: 'planning',
      progress: 0,
      plan,
      nextSteps,
      sourceIds,
      checkpoints: [],
      ...(note ? { note } : {}),
      provenance: input.provenance?.trim() || 'agent-research-runs',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeStore({ version: STORE_VERSION, runs: [...store.runs, run] });
    return run;
  }

  public start(id: string, note?: string): AgentResearchRunRecord {
    return this.update(id, (run) => {
      this.assertMutable(run, 'start');
      const timestamp = nowIso();
      return {
        ...run,
        status: 'running',
        phase: run.phase === 'planning' && run.progress > 0 ? run.phase : run.phase,
        progress: Math.max(run.progress, run.status === 'planned' ? 1 : run.progress),
        ...(note?.trim() ? { note: note.trim() } : {}),
        startedAt: run.startedAt ?? timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public resume(id: string, note?: string): AgentResearchRunRecord {
    return this.update(id, (run) => {
      this.assertMutable(run, 'resume');
      const timestamp = nowIso();
      return {
        ...run,
        status: 'running',
        ...(note?.trim() ? { note: note.trim() } : {}),
        startedAt: run.startedAt ?? timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public pause(id: string, note?: string): AgentResearchRunRecord {
    return this.update(id, (run) => {
      this.assertMutable(run, 'pause');
      const timestamp = nowIso();
      const finalNote = note?.trim();
      if (finalNote) assertRunContentSafe([finalNote]);
      return {
        ...run,
        status: 'paused',
        ...(finalNote ? { note: finalNote } : {}),
        pausedAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public cancel(id: string, note: string): AgentResearchRunRecord {
    const finalNote = note.trim();
    if (!finalNote) throw new Error('cancellation note is required.');
    assertRunContentSafe([finalNote]);
    return this.update(id, (run) => {
      this.assertMutable(run, 'cancel');
      const timestamp = nowIso();
      return {
        ...run,
        status: 'cancelled',
        note: finalNote,
        cancelledAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public checkpoint(id: string, input: AgentResearchRunCheckpointInput): AgentResearchRunRecord {
    const note = input.note.trim();
    if (!note) throw new Error('checkpoint note is required.');
    const nextSteps = normalizeList(input.nextSteps);
    const sourceIds = normalizeList(input.sourceIds);
    const finalStatus = input.status && input.status !== 'cancelled' && input.status !== 'completed' && input.status !== 'failed'
      ? input.status
      : undefined;
    assertRunContentSafe([note, ...nextSteps, ...sourceIds]);
    return this.update(id, (run) => {
      this.assertMutable(run, 'checkpoint');
      const timestamp = nowIso();
      const finalPhase = input.phase ?? run.phase;
      const progress = boundedProgress(input.progress, run.progress);
      const mergedSourceIds = normalizeList([...run.sourceIds, ...sourceIds]);
      const nextStatus = finalStatus ?? (run.status === 'planned' ? 'running' : run.status);
      const checkpoint: AgentResearchRunCheckpoint = {
        id: checkpointId(timestamp, run.checkpoints.length),
        at: timestamp,
        phase: finalPhase,
        status: nextStatus,
        progress,
        note,
        nextSteps,
        sourceIds,
      };
      return {
        ...run,
        status: nextStatus,
        phase: finalPhase,
        progress,
        nextSteps: nextSteps.length > 0 ? nextSteps : run.nextSteps,
        sourceIds: mergedSourceIds,
        checkpoints: [...run.checkpoints, checkpoint],
        note,
        startedAt: run.startedAt ?? timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public complete(id: string, input: AgentResearchRunCompletionInput = {}): AgentResearchRunRecord {
    const note = input.note?.trim();
    const reportArtifactId = input.reportArtifactId?.trim();
    const sourceIds = normalizeList(input.sourceIds);
    assertRunContentSafe([note ?? '', reportArtifactId ?? '', ...sourceIds]);
    return this.update(id, (run) => {
      this.assertMutable(run, 'complete');
      const timestamp = nowIso();
      return {
        ...run,
        status: 'completed',
        phase: 'reporting',
        progress: 100,
        sourceIds: normalizeList([...run.sourceIds, ...sourceIds]),
        ...(reportArtifactId ? { reportArtifactId } : {}),
        ...(note ? { note } : {}),
        completedAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public fail(id: string, error: string): AgentResearchRunRecord {
    const finalError = error.trim();
    if (!finalError) throw new Error('failure note is required.');
    assertRunContentSafe([finalError]);
    return this.update(id, (run) => {
      this.assertMutable(run, 'fail');
      const timestamp = nowIso();
      return {
        ...run,
        status: 'failed',
        error: finalError,
        failedAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public delete(id: string): AgentResearchRunRecord {
    const store = this.readStore();
    const run = this.find(store.runs, id);
    if (!run) throw new Error(`Research run ${id} not found.`);
    this.writeStore({ version: STORE_VERSION, runs: store.runs.filter((entry) => entry.id !== run.id) });
    return run;
  }

  private assertMutable(run: AgentResearchRunRecord, action: string): void {
    if (TERMINAL_STATUSES.has(run.status)) throw new Error(`Cannot ${action} ${run.status} research run ${run.id}.`);
  }

  private update(id: string, updater: (run: AgentResearchRunRecord) => AgentResearchRunRecord): AgentResearchRunRecord {
    const store = this.readStore();
    const existing = this.find(store.runs, id);
    if (!existing) throw new Error(`Research run ${id} not found.`);
    const updated = updater(existing);
    this.writeStore({
      version: STORE_VERSION,
      runs: store.runs.map((run) => run.id === existing.id ? updated : run),
    });
    return updated;
  }

  private find(runs: readonly AgentResearchRunRecord[], idOrTitle: string): AgentResearchRunRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return runs.find((run) => (
      run.id.toLowerCase() === lookup
      || run.title.toLowerCase() === lookup
    )) ?? null;
  }

  private uniqueId(runs: readonly AgentResearchRunRecord[], title: string): string {
    const base = slugify(title);
    const used = new Set(runs.map((run) => run.id));
    if (!used.has(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!used.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate id for research run ${title}.`);
  }

  private readStore(): ResearchRunStoreFile {
    if (!existsSync(this.storePath)) return { version: STORE_VERSION, runs: [] };
    try {
      return parseStore(readFileSync(this.storePath, 'utf8'));
    } catch {
      return { version: STORE_VERSION, runs: [] };
    }
  }

  private writeStore(store: ResearchRunStoreFile): void {
    writeStoreFile(this.storePath, formatStore(store));
  }
}
