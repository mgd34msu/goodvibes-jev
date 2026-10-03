import { existsSync, readFileSync } from 'node:fs';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreFile } from '@/utils/store-file.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from './persona-registry.ts';
import type {
  AgentDocumentAttachment,
  AgentDocumentAttachmentInput,
  AgentDocumentComment,
  AgentDocumentCommentInput,
  AgentDocumentCommentStatus,
  AgentDocumentCreateInput,
  AgentDocumentRecord,
  AgentDocumentSnapshot,
  AgentDocumentStatus,
  AgentDocumentSuggestion,
  AgentDocumentSuggestionInput,
  AgentDocumentSuggestionStatus,
  AgentDocumentUpdateInput,
  AgentDocumentVersion,
} from './document-registry-types.ts';
export type {
  AgentDocumentAttachment,
  AgentDocumentAttachmentInput,
  AgentDocumentComment,
  AgentDocumentCommentInput,
  AgentDocumentCommentStatus,
  AgentDocumentCreateInput,
  AgentDocumentRecord,
  AgentDocumentSnapshot,
  AgentDocumentStatus,
  AgentDocumentSuggestion,
  AgentDocumentSuggestionInput,
  AgentDocumentSuggestionStatus,
  AgentDocumentUpdateInput,
  AgentDocumentVersion,
} from './document-registry-types.ts';

interface DocumentStoreFile {
  readonly version: 1;
  readonly documents: readonly AgentDocumentRecord[];
}

type AgentDocumentStorePaths = Pick<ShellPathService, 'resolveProjectPath'>;

const STORE_VERSION = 1;
const MAX_VERSIONS = 50;

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

function normalizeTitle(value: string): string {
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
  return slug || 'document';
}

function nowIso(): string {
  return new Date().toISOString();
}

function documentStatus(value: unknown): AgentDocumentStatus {
  if (value === 'reviewed' || value === 'archived') return value;
  return 'draft';
}

function commentStatus(value: unknown): AgentDocumentCommentStatus {
  return value === 'resolved' ? 'resolved' : 'open';
}

function suggestionStatus(value: unknown): AgentDocumentSuggestionStatus {
  if (value === 'accepted' || value === 'rejected') return value;
  return 'proposed';
}

function assertDocumentContentSafe(fields: readonly string[]): void {
  try {
    assertNoSecretLikeText(fields);
  } catch {
    throw new Error('Documents cannot store secret-looking values. Store a secret reference or remove the sensitive text.');
  }
}

function parseVersion(value: unknown): AgentDocumentVersion | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  const summary = readString(value.summary).trim();
  if (!id || !title || !body) return null;
  return {
    id,
    title,
    body,
    summary,
    createdAt: readString(value.createdAt, nowIso()),
  };
}

function parseComment(value: unknown): AgentDocumentComment | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const body = readString(value.body).trim();
  if (!id || !body) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const resolvedAt = readString(value.resolvedAt).trim();
  return {
    id,
    body,
    status: commentStatus(value.status),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    resolvedAt: resolvedAt || undefined,
  };
}

function parseSuggestion(value: unknown): AgentDocumentSuggestion | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  const summary = readString(value.summary).trim();
  if (!id || !title || !body || !summary) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const resolvedAt = readString(value.resolvedAt).trim();
  return {
    id,
    title,
    body,
    tags: readStringArray(value.tags),
    ...(value.documentStatus === undefined ? {} : { documentStatus: documentStatus(value.documentStatus) }),
    summary,
    rationale: readString(value.rationale).trim(),
    status: suggestionStatus(value.status),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    resolvedAt: resolvedAt || undefined,
  };
}

function parseAttachment(value: unknown): AgentDocumentAttachment | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const artifactId = readString(value.artifactId).trim();
  const label = readString(value.label).trim();
  if (!id || !artifactId || !label) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const sizeBytes = typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes)
    ? Math.max(0, Math.trunc(value.sizeBytes))
    : undefined;
  const note = readString(value.note).trim();
  const filename = readString(value.filename).trim();
  const mimeType = readString(value.mimeType).trim();
  const kind = readString(value.kind).trim();
  return {
    id,
    artifactId,
    label,
    ...(note ? { note } : {}),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(kind ? { kind } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
  };
}

function parseDocument(value: unknown): AgentDocumentRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = normalizeTitle(readString(value.title));
  const body = readString(value.body).trim();
  if (!id || !title || !body) return null;
  const createdAt = readString(value.createdAt, nowIso());
  const versions = Array.isArray(value.versions)
    ? value.versions.map(parseVersion).filter((entry): entry is AgentDocumentVersion => entry !== null)
    : [];
  const comments = Array.isArray(value.comments)
    ? value.comments.map(parseComment).filter((entry): entry is AgentDocumentComment => entry !== null)
    : [];
  const suggestions = Array.isArray(value.suggestions)
    ? value.suggestions.map(parseSuggestion).filter((entry): entry is AgentDocumentSuggestion => entry !== null)
    : [];
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(parseAttachment).filter((entry): entry is AgentDocumentAttachment => entry !== null)
    : [];
  const lastArtifactId = readString(value.lastArtifactId).trim();
  return {
    id,
    title,
    body,
    tags: readStringArray(value.tags),
    status: documentStatus(value.status),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    versions,
    comments,
    suggestions,
    attachments,
    lastArtifactId: lastArtifactId || undefined,
  };
}

function parseStore(raw: string): DocumentStoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { version: STORE_VERSION, documents: [] };
  return {
    version: STORE_VERSION,
    documents: Array.isArray(parsed.documents)
      ? parsed.documents.map(parseDocument).filter((entry): entry is AgentDocumentRecord => entry !== null)
      : [],
  };
}

function formatStore(store: DocumentStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function compactExportLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function renderCommentSummary(comment: AgentDocumentComment): string {
  const resolved = comment.resolvedAt ? ` resolved ${comment.resolvedAt}` : '';
  return `- ${comment.id} [${comment.status}] ${compactExportLine(comment.body)} (created ${comment.createdAt}${resolved})`;
}

function renderSuggestionSummary(suggestion: AgentDocumentSuggestion): string {
  const parts = [
    `- ${suggestion.id} [${suggestion.status}] ${compactExportLine(suggestion.summary)}`,
    suggestion.rationale ? `Rationale: ${compactExportLine(suggestion.rationale)}` : '',
    `Title: ${suggestion.title}`,
    suggestion.tags.length > 0 ? `Tags: ${suggestion.tags.join(', ')}` : '',
    suggestion.documentStatus ? `Status after accept: ${suggestion.documentStatus}` : '',
    suggestion.resolvedAt ? `Resolved: ${suggestion.resolvedAt}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

export function documentStorePath(shellPaths: AgentDocumentStorePaths): string {
  return shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'documents', 'documents.json');
}

export function renderAgentDocumentMarkdown(document: AgentDocumentRecord): string {
  const tags = document.tags.length > 0 ? `\nTags: ${document.tags.join(', ')}` : '';
  const openComments = document.comments.filter((comment) => comment.status === 'open').length;
  const comments = document.comments.length > 0 ? `\nComments: ${openComments} open / ${document.comments.length} total` : '';
  const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
  const suggestions = document.suggestions.length > 0 ? `\nSuggestions: ${proposedSuggestions} proposed / ${document.suggestions.length} total` : '';
  const attachments = document.attachments.length > 0 ? `\nAttachments: ${document.attachments.length}` : '';
  const lines = [
    `# ${document.title}`,
    '',
    `Document ID: ${document.id}`,
    `Version: ${document.versions.at(-1)?.id ?? 'v1'}`,
    `Status: ${document.status}`,
    `Updated: ${document.updatedAt}${tags}${comments}${suggestions}${attachments}`,
    '',
    document.body,
    '',
  ];
  if (document.attachments.length > 0) {
    lines.push(
      '## Attached Artifacts',
      '',
      ...document.attachments.map((attachment) => {
        const details = [
          attachment.filename ?? '',
          attachment.mimeType ?? '',
          attachment.kind ?? '',
        ].filter(Boolean).join(' / ');
        const note = attachment.note ? ` - ${attachment.note}` : '';
        return `- ${attachment.id}: ${attachment.label} (${attachment.artifactId}${details ? `, ${details}` : ''})${note}`;
      }),
      '',
    );
  }
  if (document.comments.length > 0) {
    lines.push(
      '## Review Comments',
      '',
      ...document.comments.map(renderCommentSummary),
      '',
    );
  }
  if (document.suggestions.length > 0) {
    lines.push(
      '## AI Suggestions',
      '',
      ...document.suggestions.map(renderSuggestionSummary),
      '',
    );
  }
  return lines.join('\n');
}

export class AgentDocumentRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentDocumentStorePaths): AgentDocumentRegistry {
    return new AgentDocumentRegistry(documentStorePath(shellPaths));
  }

  public snapshot(): AgentDocumentSnapshot {
    const store = this.readStore();
    return {
      path: this.storePath,
      documents: [...store.documents].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  public list(): readonly AgentDocumentRecord[] {
    return this.snapshot().documents;
  }

  public search(query: string): readonly AgentDocumentRecord[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.list();
    return this.list().filter((document) => [
      document.id,
      document.title,
      document.body,
      document.status,
      document.lastArtifactId ?? '',
      ...document.tags,
      ...document.attachments.map((attachment) => [
        attachment.id,
        attachment.artifactId,
        attachment.label,
        attachment.note ?? '',
        attachment.filename ?? '',
        attachment.mimeType ?? '',
        attachment.kind ?? '',
      ].join(' ')),
      ...document.comments.map((comment) => `${comment.id} ${comment.status} ${comment.body}`),
      ...document.suggestions.map((suggestion) => `${suggestion.id} ${suggestion.status} ${suggestion.summary} ${suggestion.rationale} ${suggestion.body}`),
    ].some((field) => field.toLowerCase().includes(normalized)));
  }

  public get(idOrTitle: string): AgentDocumentRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((document) => (
      document.id.toLowerCase() === lookup
      || document.title.toLowerCase() === lookup
    )) ?? null;
  }

  public create(input: AgentDocumentCreateInput): AgentDocumentRecord {
    const store = this.readStore();
    const title = normalizeTitle(input.title);
    const body = input.body.trim();
    this.validateRequired(title, body);
    const tags = normalizeList(input.tags);
    const summary = input.summary?.trim() || 'Initial draft.';
    assertDocumentContentSafe([title, body, summary, ...tags]);
    const duplicate = store.documents.find((document) => document.title.toLowerCase() === title.toLowerCase());
    if (duplicate) throw new Error(`Document already exists ${duplicate.id}`);
    const timestamp = nowIso();
    const version: AgentDocumentVersion = {
      id: 'v1',
      title,
      body,
      summary,
      createdAt: timestamp,
    };
    const document: AgentDocumentRecord = {
      id: this.nextId(title, store.documents),
      title,
      body,
      tags,
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
      versions: [version],
      comments: [],
      suggestions: [],
      attachments: [],
    };
    this.writeStore({ ...store, documents: [...store.documents, document] });
    return document;
  }

  public update(idOrTitle: string, input: AgentDocumentUpdateInput): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
    const body = input.body === undefined ? existing.body : input.body.trim();
    this.validateRequired(title, body);
    const tags = input.tags === undefined ? existing.tags : normalizeList(input.tags);
    const summary = input.summary?.trim() || 'Updated draft.';
    assertDocumentContentSafe([title, body, summary, ...tags]);
    const duplicate = store.documents.find((document) => document.id !== existing.id && document.title.toLowerCase() === title.toLowerCase());
    if (duplicate) throw new Error(`Document already exists ${duplicate.id}`);
    const timestamp = nowIso();
    const version: AgentDocumentVersion = {
      id: `v${existing.versions.length + 1}`,
      title,
      body,
      summary,
      createdAt: timestamp,
    };
    const versions = [...existing.versions, version].slice(-MAX_VERSIONS);
    const updated: AgentDocumentRecord = {
      ...existing,
      title,
      body,
      tags,
      status: input.status ?? existing.status,
      updatedAt: timestamp,
      versions,
      lastArtifactId: input.lastArtifactId === undefined ? existing.lastArtifactId : input.lastArtifactId || undefined,
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public updateArtifactId(idOrTitle: string, artifactId: string): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const updated: AgentDocumentRecord = {
      ...existing,
      lastArtifactId: artifactId,
      updatedAt: nowIso(),
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public addComment(idOrTitle: string, input: AgentDocumentCommentInput): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const body = input.body.trim();
    if (!body) throw new Error('Comment body is required.');
    assertDocumentContentSafe([body]);
    const timestamp = nowIso();
    const comment: AgentDocumentComment = {
      id: this.nextCommentId(existing.comments),
      body,
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const updated: AgentDocumentRecord = {
      ...existing,
      comments: [...existing.comments, comment],
      updatedAt: timestamp,
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public resolveComment(idOrTitle: string, commentId: string): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const lookup = commentId.trim().toLowerCase();
    if (!lookup) throw new Error('commentId is required.');
    const target = existing.comments.find((comment) => comment.id.toLowerCase() === lookup);
    if (!target) throw new Error(`Unknown document comment ${commentId}`);
    const timestamp = nowIso();
    const updated: AgentDocumentRecord = {
      ...existing,
      updatedAt: timestamp,
      comments: existing.comments.map((comment) => comment.id === target.id
        ? { ...comment, status: 'resolved', updatedAt: timestamp, resolvedAt: timestamp }
        : comment),
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public suggestUpdate(idOrTitle: string, input: AgentDocumentSuggestionInput): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
    const body = input.body.trim();
    this.validateRequired(title, body);
    const tags = input.tags === undefined ? existing.tags : normalizeList(input.tags);
    const summary = input.summary?.trim() || 'AI suggested revision.';
    const rationale = input.rationale?.trim() || 'No rationale provided.';
    assertDocumentContentSafe([title, body, summary, rationale, ...tags]);
    const timestamp = nowIso();
    const suggestion: AgentDocumentSuggestion = {
      id: this.nextSuggestionId(existing.suggestions),
      title,
      body,
      tags,
      ...(input.status === undefined ? {} : { documentStatus: input.status }),
      summary,
      rationale,
      status: 'proposed',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const updated: AgentDocumentRecord = {
      ...existing,
      suggestions: [...existing.suggestions, suggestion],
      updatedAt: timestamp,
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public acceptSuggestion(idOrTitle: string, suggestionId: string): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const target = this.findSuggestion(existing, suggestionId);
    if (!target) throw new Error(`Unknown document suggestion ${suggestionId}`);
    if (target.status === 'accepted') return existing;
    if (target.status === 'rejected') throw new Error(`Document suggestion ${target.id} is already rejected.`);
    const timestamp = nowIso();
    const version: AgentDocumentVersion = {
      id: `v${existing.versions.length + 1}`,
      title: target.title,
      body: target.body,
      summary: target.summary,
      createdAt: timestamp,
    };
    const updated: AgentDocumentRecord = {
      ...existing,
      title: target.title,
      body: target.body,
      tags: [...target.tags],
      status: target.documentStatus ?? existing.status,
      updatedAt: timestamp,
      versions: [...existing.versions, version].slice(-MAX_VERSIONS),
      suggestions: existing.suggestions.map((suggestion) => suggestion.id === target.id
        ? { ...suggestion, status: 'accepted', updatedAt: timestamp, resolvedAt: timestamp }
        : suggestion),
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public rejectSuggestion(idOrTitle: string, suggestionId: string): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const target = this.findSuggestion(existing, suggestionId);
    if (!target) throw new Error(`Unknown document suggestion ${suggestionId}`);
    if (target.status === 'accepted') throw new Error(`Document suggestion ${target.id} is already accepted.`);
    if (target.status === 'rejected') return existing;
    const timestamp = nowIso();
    const updated: AgentDocumentRecord = {
      ...existing,
      updatedAt: timestamp,
      suggestions: existing.suggestions.map((suggestion) => suggestion.id === target.id
        ? { ...suggestion, status: 'rejected', updatedAt: timestamp, resolvedAt: timestamp }
        : suggestion),
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public attachArtifact(idOrTitle: string, input: AgentDocumentAttachmentInput): AgentDocumentRecord {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) throw new Error(`Unknown document ${idOrTitle}`);
    const artifactId = input.artifactId.trim();
    if (!artifactId) throw new Error('artifactId is required.');
    const label = normalizeTitle(input.label?.trim() || input.filename?.trim() || artifactId);
    const note = input.note?.trim() || undefined;
    assertDocumentContentSafe([label, note ?? '']);
    const timestamp = nowIso();
    const duplicate = existing.attachments.find((attachment) => attachment.artifactId.toLowerCase() === artifactId.toLowerCase());
    const snapshot = {
      artifactId,
      label,
      ...(note ? { note } : {}),
      ...(input.filename?.trim() ? { filename: input.filename.trim() } : {}),
      ...(input.mimeType?.trim() ? { mimeType: input.mimeType.trim() } : {}),
      ...(input.kind?.trim() ? { kind: input.kind.trim() } : {}),
      ...(typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes)
        ? { sizeBytes: Math.max(0, Math.trunc(input.sizeBytes)) }
        : {}),
    };
    const attachment: AgentDocumentAttachment = duplicate
      ? { ...duplicate, ...snapshot, updatedAt: timestamp }
      : { id: this.nextAttachmentId(existing.attachments), ...snapshot, createdAt: timestamp, updatedAt: timestamp };
    const attachments = duplicate
      ? existing.attachments.map((entry) => entry.id === duplicate.id ? attachment : entry)
      : [...existing.attachments, attachment];
    const updated: AgentDocumentRecord = {
      ...existing,
      attachments,
      updatedAt: timestamp,
    };
    this.writeStore({
      ...store,
      documents: store.documents.map((document) => document.id === existing.id ? updated : document),
    });
    return updated;
  }

  public markReviewed(idOrTitle: string): AgentDocumentRecord {
    return this.update(idOrTitle, { status: 'reviewed', summary: 'Marked reviewed.' });
  }

  public delete(idOrTitle: string): boolean {
    const store = this.readStore();
    const existing = this.findInStore(store, idOrTitle);
    if (!existing) return false;
    this.writeStore({
      ...store,
      documents: store.documents.filter((document) => document.id !== existing.id),
    });
    return true;
  }

  private readStore(): DocumentStoreFile {
    if (!existsSync(this.storePath)) return { version: STORE_VERSION, documents: [] };
    try {
      return parseStore(readFileSync(this.storePath, 'utf-8'));
    } catch (error) {
      throw new Error(`Could not read Agent document store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeStore(store: DocumentStoreFile): void {
    writeStoreFile(this.storePath, formatStore(store));
  }

  private validateRequired(title: string, body: string): void {
    if (!title) throw new Error('Document title is required.');
    if (!body) throw new Error('Document body is required.');
  }

  private nextId(title: string, documents: readonly AgentDocumentRecord[]): string {
    const base = slugify(title);
    const existing = new Set(documents.map((document) => document.id));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document id.');
  }

  private nextCommentId(comments: readonly AgentDocumentComment[]): string {
    const existing = new Set(comments.map((comment) => comment.id));
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `c${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document comment id.');
  }

  private nextSuggestionId(suggestions: readonly AgentDocumentSuggestion[]): string {
    const existing = new Set(suggestions.map((suggestion) => suggestion.id));
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `s${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document suggestion id.');
  }

  private nextAttachmentId(attachments: readonly AgentDocumentAttachment[]): string {
    const existing = new Set(attachments.map((attachment) => attachment.id));
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `a${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique document attachment id.');
  }

  private findSuggestion(document: AgentDocumentRecord, suggestionId: string): AgentDocumentSuggestion | null {
    const lookup = suggestionId.trim().toLowerCase();
    if (!lookup) throw new Error('suggestionId is required.');
    return document.suggestions.find((suggestion) => suggestion.id.toLowerCase() === lookup) ?? null;
  }

  private findInStore(store: DocumentStoreFile, idOrTitle: string): AgentDocumentRecord | null {
    const lookup = idOrTitle.trim().toLowerCase();
    if (!lookup) return null;
    return store.documents.find((document) => (
      document.id.toLowerCase() === lookup
      || document.title.toLowerCase() === lookup
    )) ?? null;
  }
}
