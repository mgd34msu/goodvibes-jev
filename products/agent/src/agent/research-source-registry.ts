import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreFile } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';

export type AgentResearchSourceStatus = 'candidate' | 'reviewed' | 'rejected' | 'used';
export type AgentResearchSourceCredibility = 'unreviewed' | 'low' | 'medium' | 'high' | 'mixed';

export interface AgentResearchSourceRecord {
  readonly id: string;
  readonly question: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly publishedAt?: string;
  readonly accessedAt?: string;
  readonly summary: string;
  readonly evidence?: string;
  readonly credibility: AgentResearchSourceCredibility;
  readonly score: number;
  readonly status: AgentResearchSourceStatus;
  readonly tags: readonly string[];
  readonly note?: string;
  readonly usedInReportArtifactId?: string;
  readonly provenance: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
  readonly rejectedAt?: string;
  readonly usedAt?: string;
}

export interface AgentResearchSourceCreateInput {
  readonly question: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly publishedAt?: string;
  readonly accessedAt?: string;
  readonly summary: string;
  readonly evidence?: string;
  readonly credibility?: AgentResearchSourceCredibility;
  readonly score?: number;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly provenance?: string;
}

export interface AgentResearchSourceReviewInput {
  readonly credibility?: AgentResearchSourceCredibility;
  readonly score?: number;
  readonly note?: string;
  readonly summary?: string;
  readonly evidence?: string;
  readonly tags?: readonly string[];
}

export interface AgentResearchSourceUseInput {
  readonly reportArtifactId?: string;
  readonly note?: string;
}

export interface AgentResearchSourceSnapshot {
  readonly path: string;
  readonly sources: readonly AgentResearchSourceRecord[];
  readonly candidates: readonly AgentResearchSourceRecord[];
  readonly reviewed: readonly AgentResearchSourceRecord[];
  readonly rejected: readonly AgentResearchSourceRecord[];
  readonly used: readonly AgentResearchSourceRecord[];
}

interface ResearchSourceStoreFile {
  readonly version: 1;
  readonly sources: readonly AgentResearchSourceRecord[];
}

type AgentResearchSourceStorePaths = Pick<ShellPathService, 'resolveProjectPath'>;

const STORE_VERSION = 1;
const SECRETISH = /token|secret|password|authorization|credential|api[-_]?key/i;

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
  return slug || 'source';
}

function nowIso(): string {
  return new Date().toISOString();
}

function credibility(value: unknown): AgentResearchSourceCredibility {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'mixed') return value;
  return 'unreviewed';
}

function status(value: unknown): AgentResearchSourceStatus {
  if (value === 'reviewed' || value === 'rejected' || value === 'used') return value;
  return 'candidate';
}

function boundedScore(value: unknown, fallback = 50): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

export function sanitizeResearchSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRETISH.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return url.toString();
  } catch {
    return value.replace(/([?&\s](?:token|secret|password|authorization|credential|api[-_]?key)=)[^\s&]+/gi, '$1<redacted>');
  }
}

function parseSource(value: unknown): AgentResearchSourceRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const question = normalizeText(readString(value.question));
  const title = normalizeText(readString(value.title));
  const summary = readString(value.summary).trim();
  if (!id || !question || !title || !summary) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const url = readString(value.url).trim();
  const publisher = readString(value.publisher).trim();
  const publishedAt = readString(value.publishedAt).trim();
  const accessedAt = readString(value.accessedAt).trim();
  const evidence = readString(value.evidence).trim();
  const note = readString(value.note).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  const rejectedAt = readString(value.rejectedAt).trim();
  const usedAt = readString(value.usedAt).trim();
  const usedInReportArtifactId = readString(value.usedInReportArtifactId).trim();
  return {
    id,
    question,
    title,
    ...(url ? { url: sanitizeResearchSourceUrl(url) } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(accessedAt ? { accessedAt } : {}),
    summary,
    ...(evidence ? { evidence } : {}),
    credibility: credibility(value.credibility),
    score: boundedScore(value.score),
    status: status(value.status),
    tags: readStringArray(value.tags),
    ...(note ? { note } : {}),
    ...(usedInReportArtifactId ? { usedInReportArtifactId } : {}),
    provenance: readString(value.provenance, 'agent-research-sources').trim() || 'agent-research-sources',
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    ...(reviewedAt ? { reviewedAt } : {}),
    ...(rejectedAt ? { rejectedAt } : {}),
    ...(usedAt ? { usedAt } : {}),
  };
}

function parseStore(raw: string): ResearchSourceStoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { version: STORE_VERSION, sources: [] };
  return {
    version: STORE_VERSION,
    sources: Array.isArray(parsed.sources)
      ? parsed.sources.map(parseSource).filter((entry): entry is AgentResearchSourceRecord => entry !== null)
      : [],
  };
}

function formatStore(store: ResearchSourceStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function assertSourceContentSafe(fields: readonly string[]): void {
  assertNoSecretLikeText(fields, 'Research source queue');
}

export function researchSourceStorePath(shellPaths: AgentResearchSourceStorePaths): string {
  return shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'research', 'sources.json');
}

export function researchSourceReportLine(source: AgentResearchSourceRecord): string {
  const url = source.url ?? '';
  const note = [source.publisher, source.note, source.summary].filter(Boolean).join(' ');
  return [source.title, url, source.credibility, note].filter(Boolean).join(' | ');
}

export class AgentResearchSourceRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentResearchSourceStorePaths): AgentResearchSourceRegistry {
    return new AgentResearchSourceRegistry(researchSourceStorePath(shellPaths));
  }

  public snapshot(): AgentResearchSourceSnapshot {
    const sources = [...this.readStore().sources].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      path: this.storePath,
      sources,
      candidates: sources.filter((source) => source.status === 'candidate'),
      reviewed: sources.filter((source) => source.status === 'reviewed'),
      rejected: sources.filter((source) => source.status === 'rejected'),
      used: sources.filter((source) => source.status === 'used'),
    };
  }

  public list(statusFilter?: AgentResearchSourceStatus): readonly AgentResearchSourceRecord[] {
    const sources = this.snapshot().sources;
    return statusFilter ? sources.filter((source) => source.status === statusFilter) : sources;
  }

  public search(query: string): readonly AgentResearchSourceRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((source) => [
      source.id,
      source.question,
      source.title,
      source.url ?? '',
      source.publisher ?? '',
      source.summary,
      source.evidence ?? '',
      source.credibility,
      source.status,
      source.note ?? '',
      ...source.tags,
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrTitle: string): AgentResearchSourceRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((source) => (
      source.id.toLowerCase() === lookup
      || source.title.toLowerCase() === lookup
      || source.url?.toLowerCase() === lookup
    )) ?? null;
  }

  public create(input: AgentResearchSourceCreateInput): AgentResearchSourceRecord {
    const store = this.readStore();
    const question = normalizeText(input.question);
    const title = normalizeText(input.title);
    const summary = input.summary.trim();
    if (!question) throw new Error('question is required.');
    if (!title) throw new Error('title is required.');
    if (!summary) throw new Error('summary is required.');
    const url = input.url?.trim() ? sanitizeResearchSourceUrl(input.url.trim()) : undefined;
    const publisher = input.publisher?.trim() || undefined;
    const publishedAt = input.publishedAt?.trim() || undefined;
    const accessedAt = input.accessedAt?.trim() || nowIso();
    const evidence = input.evidence?.trim() || undefined;
    const note = input.note?.trim() || undefined;
    const tags = normalizeList(input.tags);
    assertSourceContentSafe([question, title, publisher ?? '', summary, evidence ?? '', note ?? '', ...tags]);
    const duplicate = store.sources.find((source) => (
      (url && source.url?.toLowerCase() === url.toLowerCase())
      || (!url && source.title.toLowerCase() === title.toLowerCase() && source.question.toLowerCase() === question.toLowerCase())
    ));
    if (duplicate) throw new Error(`Research source already exists ${duplicate.id}.`);
    const timestamp = nowIso();
    const source: AgentResearchSourceRecord = {
      id: this.nextId(title, store.sources),
      question,
      title,
      ...(url ? { url } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      accessedAt,
      summary,
      ...(evidence ? { evidence } : {}),
      credibility: input.credibility ?? 'unreviewed',
      score: boundedScore(input.score, input.credibility === 'high' ? 80 : input.credibility === 'medium' ? 60 : 50),
      status: input.credibility && input.credibility !== 'unreviewed' ? 'reviewed' : 'candidate',
      tags,
      ...(note ? { note } : {}),
      provenance: input.provenance?.trim() || 'agent-research-sources',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.credibility && input.credibility !== 'unreviewed' ? { reviewedAt: timestamp } : {}),
    };
    this.writeStore({ ...store, sources: [...store.sources, source] });
    return source;
  }

  public review(idOrTitle: string, input: AgentResearchSourceReviewInput): AgentResearchSourceRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown research source ${idOrTitle}.`);
    const tags = input.tags === undefined ? existing.tags : normalizeList(input.tags);
    const note = input.note === undefined ? existing.note : input.note.trim() || undefined;
    const summary = input.summary === undefined ? existing.summary : input.summary.trim();
    if (!summary) throw new Error('summary is required.');
    const evidence = input.evidence === undefined ? existing.evidence : input.evidence.trim() || undefined;
    assertSourceContentSafe([summary, evidence ?? '', note ?? '', ...tags]);
    const credibilityValue = input.credibility ?? (existing.credibility === 'unreviewed' ? 'medium' : existing.credibility);
    const timestamp = nowIso();
    const { evidence: _oldEvidence, note: _oldNote, rejectedAt: _oldRejectedAt, ...base } = existing;
    const reviewed: AgentResearchSourceRecord = {
      ...base,
      summary,
      ...(evidence ? { evidence } : {}),
      credibility: credibilityValue,
      score: boundedScore(input.score, existing.score),
      status: 'reviewed',
      tags,
      ...(note ? { note } : {}),
      reviewedAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeStore({
      ...store,
      sources: store.sources.map((source) => source.id === existing.id ? reviewed : source),
    });
    return reviewed;
  }

  public reject(idOrTitle: string, reason: string): AgentResearchSourceRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown research source ${idOrTitle}.`);
    const note = reason.trim() || 'Rejected during source review.';
    assertSourceContentSafe([note]);
    const timestamp = nowIso();
    const rejected: AgentResearchSourceRecord = {
      ...existing,
      note,
      status: 'rejected',
      rejectedAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeStore({
      ...store,
      sources: store.sources.map((source) => source.id === existing.id ? rejected : source),
    });
    return rejected;
  }

  public markUsed(idOrTitle: string, input: AgentResearchSourceUseInput = {}): AgentResearchSourceRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown research source ${idOrTitle}.`);
    const reportArtifactId = input.reportArtifactId?.trim() || existing.usedInReportArtifactId;
    const note = input.note === undefined ? existing.note : input.note.trim() || undefined;
    assertSourceContentSafe([reportArtifactId ?? '', note ?? '']);
    const timestamp = nowIso();
    const { note: _oldNote, usedInReportArtifactId: _oldArtifactId, ...base } = existing;
    const used: AgentResearchSourceRecord = {
      ...base,
      ...(note ? { note } : {}),
      ...(reportArtifactId ? { usedInReportArtifactId: reportArtifactId } : {}),
      status: 'used',
      usedAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeStore({
      ...store,
      sources: store.sources.map((source) => source.id === existing.id ? used : source),
    });
    return used;
  }

  public delete(idOrTitle: string): AgentResearchSourceRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown research source ${idOrTitle}.`);
    this.writeStore({
      ...store,
      sources: store.sources.filter((source) => source.id !== existing.id),
    });
    return existing;
  }

  private readStore(): ResearchSourceStoreFile {
    if (!existsSync(this.storePath)) return { version: STORE_VERSION, sources: [] };
    try {
      return parseStore(readFileSync(this.storePath, 'utf-8'));
    } catch (error) {
      throw new Error(`Could not read Agent research source store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeStore(store: ResearchSourceStoreFile): void {
    writeStoreFile(this.storePath, formatStore(store));
  }

  private nextId(title: string, sources: readonly AgentResearchSourceRecord[]): string {
    const base = slugify(title);
    const existing = new Set(sources.map((source) => source.id));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique research source id.');
  }

  private findInStore(store: ResearchSourceStoreFile, idOrTitle: string): AgentResearchSourceRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return store.sources.find((source) => (
      source.id.toLowerCase() === lookup
      || source.title.toLowerCase() === lookup
      || source.url?.toLowerCase() === lookup
    )) ?? null;
  }
}
