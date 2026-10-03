import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreFile } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';

export type AgentNoteSource = 'user' | 'agent' | 'imported' | 'system';
export type AgentNoteReviewState = 'fresh' | 'reviewed' | 'stale';

export interface AgentNoteRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly sourceUrl?: string;
  readonly source: AgentNoteSource;
  readonly provenance: string;
  readonly reviewState: AgentNoteReviewState;
  readonly staleReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
}

export interface AgentNoteCreateInput {
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly sourceUrl?: string;
  readonly source?: AgentNoteSource;
  readonly provenance?: string;
}

export interface AgentNoteUpdateInput {
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly sourceUrl?: string;
  readonly provenance?: string;
}

export interface AgentNoteSnapshot {
  readonly path: string;
  readonly notes: readonly AgentNoteRecord[];
  readonly reviewQueue: readonly AgentNoteRecord[];
}

interface NoteStoreFile {
  readonly version: 1;
  readonly notes: readonly AgentNoteRecord[];
}

const STORE_VERSION = 1;

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

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
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
  return slug || 'note';
}

function nowIso(): string {
  return new Date().toISOString();
}



function parseNote(value: unknown): AgentNoteRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  if (!id || !title || !body) return null;
  const reviewState = value.reviewState === 'reviewed' || value.reviewState === 'stale' ? value.reviewState : 'fresh';
  const source = value.source === 'agent' || value.source === 'imported' || value.source === 'system' ? value.source : 'user';
  const sourceUrl = readString(value.sourceUrl).trim();
  const staleReason = readString(value.staleReason).trim();
  const reviewedAt = readString(value.reviewedAt).trim();
  return {
    id,
    title,
    body,
    tags: readStringArray(value.tags),
    sourceUrl: sourceUrl || undefined,
    source,
    provenance: readString(value.provenance, source).trim() || source,
    reviewState,
    staleReason: staleReason || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
    reviewedAt: reviewedAt || undefined,
  };
}

function parseStore(raw: string): NoteStoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { version: STORE_VERSION, notes: [] };
  return {
    version: STORE_VERSION,
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.map(parseNote).filter((entry): entry is AgentNoteRecord => entry !== null)
      : [],
  };
}

function formatStore(store: NoteStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function noteStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'notes', 'notes.json');
}

export class AgentNoteRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths): AgentNoteRegistry {
    return new AgentNoteRegistry(noteStorePath(shellPaths));
  }

  public snapshot(): AgentNoteSnapshot {
    const store = this.readStore();
    const notes = [...store.notes].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      path: this.storePath,
      notes,
      reviewQueue: notes.filter((note) => note.reviewState !== 'reviewed'),
    };
  }

  public list(): readonly AgentNoteRecord[] {
    return this.snapshot().notes;
  }

  public search(query: string): readonly AgentNoteRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((note) => [
      note.id,
      note.title,
      note.body,
      note.sourceUrl ?? '',
      ...note.tags,
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrTitle: string): AgentNoteRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((note) => note.id.toLowerCase() === lookup || note.title.toLowerCase() === lookup) ?? null;
  }

  public create(input: AgentNoteCreateInput): AgentNoteRecord {
    const store = this.readStore();
    const title = normalizeTitle(input.title);
    const body = input.body.trim();
    this.validateRequired(title, body);
    const sourceUrl = input.sourceUrl?.trim() || undefined;
    assertNoSecretLikeText([title, body, sourceUrl ?? '', ...(input.tags ?? [])], 'Notes');
    const duplicate = store.notes.find((note) => note.title.toLowerCase() === title.toLowerCase());
    if (duplicate) throw new Error(`Note already exists ${duplicate.id}`);
    const timestamp = nowIso();
    const note: AgentNoteRecord = {
      id: this.nextId(title, store.notes),
      title,
      body,
      tags: normalizeList(input.tags),
      sourceUrl,
      source: input.source ?? 'user',
      provenance: input.provenance?.trim() || input.source || 'user',
      reviewState: 'fresh',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeStore({ ...store, notes: [...store.notes, note] });
    return note;
  }

  public update(idOrTitle: string, input: AgentNoteUpdateInput): AgentNoteRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown note ${idOrTitle}`);
    const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
    const body = input.body === undefined ? existing.body : input.body.trim();
    this.validateRequired(title, body);
    const sourceUrl = input.sourceUrl === undefined ? existing.sourceUrl : input.sourceUrl.trim() || undefined;
    assertNoSecretLikeText([title, body, sourceUrl ?? '', ...(input.tags ?? [])], 'Notes');
    const duplicate = store.notes.find((note) => note.id !== existing.id && note.title.toLowerCase() === title.toLowerCase());
    if (duplicate) throw new Error(`Note already exists ${duplicate.id}`);
    const updated: AgentNoteRecord = {
      ...existing,
      title,
      body,
      tags: input.tags === undefined ? existing.tags : normalizeList(input.tags),
      sourceUrl,
      provenance: input.provenance === undefined ? existing.provenance : input.provenance.trim() || existing.provenance,
      reviewState: 'fresh',
      staleReason: undefined,
      reviewedAt: undefined,
      updatedAt: nowIso(),
    };
    this.writeStore({
      ...store,
      notes: store.notes.map((note) => note.id === existing.id ? updated : note),
    });
    return updated;
  }

  public markReviewed(idOrTitle: string): AgentNoteRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown note ${idOrTitle}`);
    const updated: AgentNoteRecord = {
      ...existing,
      reviewState: 'reviewed',
      staleReason: undefined,
      reviewedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.writeStore({
      ...store,
      notes: store.notes.map((note) => note.id === existing.id ? updated : note),
    });
    return updated;
  }

  public markStale(idOrTitle: string, reason: string): AgentNoteRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown note ${idOrTitle}`);
    const updated: AgentNoteRecord = {
      ...existing,
      reviewState: 'stale',
      staleReason: reason.trim() || 'Marked stale by user.',
      updatedAt: nowIso(),
    };
    this.writeStore({
      ...store,
      notes: store.notes.map((note) => note.id === existing.id ? updated : note),
    });
    return updated;
  }

  public deleteNote(idOrTitle: string): AgentNoteRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown note ${idOrTitle}`);
    this.writeStore({
      ...store,
      notes: store.notes.filter((note) => note.id !== existing.id),
    });
    return existing;
  }

  private validateRequired(title: string, body: string): void {
    if (!title) throw new Error('Note title is required.');
    if (!body) throw new Error('Note body is required.');
  }

  private nextId(title: string, notes: readonly AgentNoteRecord[]): string {
    const base = slugify(title);
    const ids = new Set(notes.map((note) => note.id));
    if (!ids.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate note id for ${title}.`);
  }

  private findInStore(store: NoteStoreFile, idOrTitle: string): AgentNoteRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return store.notes.find((note) => note.id.toLowerCase() === lookup || note.title.toLowerCase() === lookup) ?? null;
  }

  private readStore(): NoteStoreFile {
    if (!existsSync(this.storePath)) return { version: STORE_VERSION, notes: [] };
    try {
      return parseStore(readFileSync(this.storePath, 'utf-8'));
    } catch (error) {
      throw new Error(`Could not read Agent note store ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeStore(store: NoteStoreFile): void {
    writeStoreFile(this.storePath, formatStore(store));
  }
}
