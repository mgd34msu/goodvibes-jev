import type { ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  AgentDocumentRegistry,
  renderAgentDocumentMarkdown,
  type AgentDocumentRecord,
  type AgentDocumentStatus,
} from '../agent/document-registry.ts';

export type AgentDocumentsToolMode = 'list' | 'show' | 'create' | 'update' | 'review' | 'comment' | 'resolveComment' | 'suggest' | 'acceptSuggestion' | 'rejectSuggestion' | 'export' | 'insertArtifact' | 'attachArtifact';

export interface AgentDocumentsToolArgs {
  readonly mode?: unknown;
  readonly documentId?: unknown;
  readonly query?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly tags?: unknown;
  readonly status?: unknown;
  readonly artifactId?: unknown;
  readonly attachmentLabel?: unknown;
  readonly attachmentNote?: unknown;
  readonly commentId?: unknown;
  readonly comment?: unknown;
  readonly suggestionId?: unknown;
  readonly suggestionRationale?: unknown;
  readonly placement?: unknown;
  readonly sectionTitle?: unknown;
  readonly includeContent?: unknown;
  readonly changeSummary?: unknown;
  readonly includeVersions?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type AgentDocumentArtifactStore = Partial<Pick<ArtifactStore, 'create' | 'get' | 'readContent'>>;

const MODES: readonly AgentDocumentsToolMode[] = ['list', 'show', 'create', 'update', 'review', 'comment', 'resolveComment', 'suggest', 'acceptSuggestion', 'rejectSuggestion', 'export', 'insertArtifact', 'attachArtifact'];
const MAX_INSERT_TEXT_BYTES = 40_000;

function isMode(value: unknown): value is AgentDocumentsToolMode {
  return typeof value === 'string' && MODES.includes(value as AgentDocumentsToolMode);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function readBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || readString(value) === '') return fallback;
  return value === true || value === 'true' || value === 'yes';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function readStatus(value: unknown): AgentDocumentStatus | undefined {
  if (value === 'draft' || value === 'reviewed' || value === 'archived') return value;
  if (value === undefined || value === null || readString(value) === '') return undefined;
  throw new Error('status must be draft, reviewed, or archived.');
}

function readPlacement(value: unknown): 'append' | 'prepend' | 'replace' {
  const placement = readString(value).toLowerCase();
  if (!placement || placement === 'append') return 'append';
  if (placement === 'prepend' || placement === 'replace') return placement;
  throw new Error('placement must be append, prepend, or replace.');
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function requireDocumentId(args: AgentDocumentsToolArgs): string {
  const id = readString(args.documentId);
  if (!id) throw new Error('documentId is required.');
  return id;
}

function requireArtifactId(args: AgentDocumentsToolArgs): string {
  const id = readString(args.artifactId);
  if (!id) throw new Error('artifactId is required.');
  return id;
}

function requireCommentId(args: AgentDocumentsToolArgs): string {
  const id = readString(args.commentId);
  if (!id) throw new Error('commentId is required.');
  return id;
}

function requireSuggestionId(args: AgentDocumentsToolArgs): string {
  const id = readString(args.suggestionId);
  if (!id) throw new Error('suggestionId is required.');
  return id;
}

function requireConfirmed(args: AgentDocumentsToolArgs, action: string): void {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) throw new Error(`${action} requires explicitUserRequest with the user's exact request or a short faithful summary.`);
  if (args.confirm !== true) throw new Error(`${action} requires confirm:true after an explicit user request.`);
}

function formatDocumentSummary(document: AgentDocumentRecord): string {
  const tags = document.tags.length > 0 ? ` tags ${document.tags.join(', ')}` : '';
  const artifact = document.lastArtifactId ? ` artifact ${document.lastArtifactId}` : '';
  const openComments = document.comments.filter((comment) => comment.status === 'open').length;
  const comments = document.comments.length > 0 ? ` comments ${openComments}/${document.comments.length}` : '';
  const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
  const suggestions = document.suggestions.length > 0 ? ` suggestions ${proposedSuggestions}/${document.suggestions.length}` : '';
  const attachments = document.attachments.length > 0 ? ` attachments ${document.attachments.length}` : '';
  return `${document.id}  ${document.status}  versions ${document.versions.length}${comments}${suggestions}${attachments}  updated ${document.updatedAt}${tags}${artifact}  ${document.title}`;
}

function formatList(documents: readonly AgentDocumentRecord[], total: number, query: string): string {
  if (documents.length === 0) {
    return [
      'Agent documents',
      `  query ${query || '(all)'}`,
      'No Agent document drafts matched.',
    ].join('\n');
  }
  return [
    'Agent documents',
    `  returned ${documents.length}/${total}`,
    `  query ${query || '(all)'}`,
    ...documents.map((document) => `  - ${formatDocumentSummary(document)}`),
  ].join('\n');
}

function formatShow(document: AgentDocumentRecord, includeVersions: boolean): string {
  const openComments = document.comments.filter((comment) => comment.status === 'open').length;
  const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
  const lines = [
    'Agent document',
    `  id ${document.id}`,
    `  title ${document.title}`,
    `  status ${document.status}`,
    `  tags ${document.tags.join(', ') || '(none)'}`,
    `  versions ${document.versions.length}`,
    `  comments ${openComments}/${document.comments.length}`,
    `  suggestions ${proposedSuggestions}/${document.suggestions.length}`,
    `  attachments ${document.attachments.length}`,
    `  created ${document.createdAt}`,
    `  updated ${document.updatedAt}`,
    `  lastArtifact ${document.lastArtifactId ?? '(none)'}`,
    '',
    document.body,
  ];
  if (includeVersions) {
    lines.push(
      '',
      'Versions',
      ...document.versions.map((version) => `  - ${version.id}  ${version.createdAt}  ${version.summary}`),
    );
  }
  if (document.comments.length > 0) {
    lines.push(
      '',
      'Comments',
      ...document.comments.map((comment) => `  - ${comment.id}  ${comment.status}  ${comment.createdAt}  ${comment.body}`),
    );
  }
  if (document.suggestions.length > 0) {
    lines.push(
      '',
      'Suggestions',
      ...document.suggestions.map((suggestion) => `  - ${suggestion.id}  ${suggestion.status}  ${suggestion.createdAt}  ${suggestion.summary}  ${suggestion.rationale}`),
    );
  }
  if (document.attachments.length > 0) {
    lines.push(
      '',
      'Attachments',
      ...document.attachments.map((attachment) => {
        const details = [
          attachment.filename ?? '',
          attachment.mimeType ?? '',
          attachment.kind ?? '',
        ].filter(Boolean).join(' / ');
        const note = attachment.note ? `  ${attachment.note}` : '';
        return `  - ${attachment.id}  artifact ${attachment.artifactId}  ${attachment.label}${details ? `  ${details}` : ''}${note}`;
      }),
    );
  }
  return lines.join('\n');
}

function exportedVersionId(document: AgentDocumentRecord): string {
  return document.versions.at(-1)?.id ?? 'v1';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '(unknown)';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLike(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('yaml')
    || normalized.includes('csv')
    || normalized.includes('javascript')
    || normalized.includes('typescript');
}

function artifactSectionTitle(artifact: ArtifactDescriptor, explicitTitle: string): string {
  return explicitTitle || artifact.filename || artifact.id;
}

async function loadArtifactForInsert(
  artifactStore: AgentDocumentArtifactStore | undefined,
  artifactId: string,
  includeContent: boolean,
): Promise<{ readonly descriptor: ArtifactDescriptor; readonly buffer?: Buffer }> {
  if (!artifactStore?.get && !artifactStore?.readContent) {
    throw new Error('Artifact insertion requires an artifact store with get or readContent support.');
  }
  if (includeContent && artifactStore.readContent) {
    const { record, buffer } = await artifactStore.readContent(artifactId);
    return { descriptor: record, buffer };
  }
  const descriptor = artifactStore.get?.(artifactId) ?? null;
  if (descriptor) return { descriptor };
  if (artifactStore.readContent) {
    const { record, buffer } = await artifactStore.readContent(artifactId);
    return { descriptor: record, buffer: includeContent ? buffer : undefined };
  }
  throw new Error(`Unknown artifact ${artifactId}. Use agent_artifacts mode:"list" to inspect available artifacts.`);
}

function renderArtifactDocumentBlock(
  artifact: ArtifactDescriptor,
  buffer: Buffer | undefined,
  options: {
    readonly sectionTitle: string;
    readonly includeContent: boolean;
  },
): string {
  const heading = artifactSectionTitle(artifact, options.sectionTitle);
  const lines = [
    `## ${heading}`,
    '',
    `Artifact ID: ${artifact.id}`,
    `Filename: ${artifact.filename ?? '(none)'}`,
    `MIME: ${artifact.mimeType}`,
    `Size: ${formatBytes(artifact.sizeBytes)}`,
  ];

  if (!options.includeContent) {
    lines.push('', '_Content omitted by request; use the artifact id above to inspect or attach it._');
    return lines.join('\n');
  }

  if (!isTextLike(artifact.mimeType)) {
    lines.push('', `_Content omitted for non-text artifact ${artifact.mimeType}; binary/base64 bytes were not inserted._`);
    return lines.join('\n');
  }

  if (!buffer) {
    lines.push('', '_Text content could not be read in this runtime._');
    return lines.join('\n');
  }

  const sliced = buffer.subarray(0, Math.min(buffer.byteLength, MAX_INSERT_TEXT_BYTES));
  const text = sliced.toString('utf-8').replace(/\0/g, '').trim();
  lines.push('', text || '_Empty text artifact._');
  if (buffer.byteLength > sliced.byteLength) {
    lines.push('', `_Truncated ${formatBytes(buffer.byteLength - sliced.byteLength)} from the inserted artifact preview._`);
  }
  return lines.join('\n');
}

function insertBlock(body: string, block: string, placement: 'append' | 'prepend' | 'replace'): string {
  if (placement === 'replace') return block;
  if (placement === 'prepend') return `${block}\n\n${body}`;
  return `${body}\n\n${block}`;
}

function formatExport(document: AgentDocumentRecord, artifact: ArtifactDescriptor): string {
  const openComments = document.comments.filter((comment) => comment.status === 'open').length;
  const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
  return [
    'Exported Agent document',
    `  document ${document.id}`,
    `  version ${exportedVersionId(document)}`,
    `  attachments ${document.attachments.length}`,
    `  comments ${openComments}/${document.comments.length}`,
    `  suggestions ${proposedSuggestions}/${document.suggestions.length}`,
    `  artifact ${artifact.id}`,
    `  filename ${artifact.filename ?? '(none)'}`,
    `  route agent_artifacts mode:"show" artifactId:"${artifact.id}" includeContent:true`,
    '  policy markdown body plus reviewer appendix exported; artifact content not printed',
  ].join('\n');
}

async function exportDocument(
  registry: AgentDocumentRegistry,
  artifactStore: AgentDocumentArtifactStore | undefined,
  document: AgentDocumentRecord,
): Promise<string> {
  if (!artifactStore?.create) throw new Error('Agent document export requires an artifact store with create support.');
  const versionId = exportedVersionId(document);
  const openComments = document.comments.filter((comment) => comment.status === 'open').length;
  const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
  const acceptedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'accepted').length;
  const rejectedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'rejected').length;
  const artifact = await artifactStore.create({
    kind: 'document',
    mimeType: 'text/markdown',
    filename: `${document.id}-${versionId}.md`,
    text: renderAgentDocumentMarkdown(document),
    metadata: {
      purpose: 'agent-document-export',
      source: 'agent-documents',
      documentId: document.id,
      versionId,
      status: document.status,
      attachmentIds: document.attachments.map((attachment) => attachment.artifactId),
      commentCounts: {
        open: openComments,
        resolved: document.comments.length - openComments,
        total: document.comments.length,
      },
      suggestionCounts: {
        proposed: proposedSuggestions,
        accepted: acceptedSuggestions,
        rejected: rejectedSuggestions,
        total: document.suggestions.length,
      },
      reviewSummary: {
        hasOpenComments: openComments > 0,
        hasProposedSuggestions: proposedSuggestions > 0,
        exportedReviewAppendix: document.comments.length > 0 || document.suggestions.length > 0,
      },
    },
  });
  registry.updateArtifactId(document.id, artifact.id);
  return formatExport({ ...document, lastArtifactId: artifact.id }, artifact);
}

async function attachArtifactToDocument(
  registry: AgentDocumentRegistry,
  artifactStore: AgentDocumentArtifactStore | undefined,
  args: AgentDocumentsToolArgs,
): Promise<string> {
  const documentId = requireDocumentId(args);
  const artifactId = requireArtifactId(args);
  const document = registry.get(documentId);
  if (!document) throw new Error(`Unknown Agent document ${documentId}.`);
  const loaded = await loadArtifactForInsert(artifactStore, artifactId, false);
  const updated = registry.attachArtifact(document.id, {
    artifactId: loaded.descriptor.id,
    label: readString(args.attachmentLabel) || loaded.descriptor.filename || loaded.descriptor.id,
    note: readString(args.attachmentNote),
    filename: loaded.descriptor.filename,
    mimeType: loaded.descriptor.mimeType,
    kind: loaded.descriptor.kind,
    sizeBytes: loaded.descriptor.sizeBytes,
  });
  const attachment = updated.attachments.find((entry) => entry.artifactId === loaded.descriptor.id);
  return [
    'Attached artifact to Agent document',
    `  document ${updated.id}`,
    `  attachment ${attachment?.id ?? '(unknown)'}`,
    `  artifact ${loaded.descriptor.id}`,
    `  attachments ${updated.attachments.length}`,
    `  versions ${updated.versions.length}`,
    '  body unchanged',
  ].join('\n');
}

async function insertArtifactIntoDocument(
  registry: AgentDocumentRegistry,
  artifactStore: AgentDocumentArtifactStore | undefined,
  args: AgentDocumentsToolArgs,
): Promise<string> {
  const documentId = requireDocumentId(args);
  const artifactId = requireArtifactId(args);
  const document = registry.get(documentId);
  if (!document) throw new Error(`Unknown Agent document ${documentId}.`);
  const includeContent = readBoolean(args.includeContent, true);
  const placement = readPlacement(args.placement);
  const loaded = await loadArtifactForInsert(artifactStore, artifactId, includeContent);
  const block = renderArtifactDocumentBlock(loaded.descriptor, loaded.buffer, {
    sectionTitle: readString(args.sectionTitle),
    includeContent,
  });
  const updated = registry.update(document.id, {
    body: insertBlock(document.body, block, placement),
    summary: readString(args.changeSummary) || `Inserted artifact ${artifactId}.`,
  });
  return [
    'Inserted artifact into Agent document',
    `  document ${updated.id}`,
    `  artifact ${loaded.descriptor.id}`,
    `  placement ${placement}`,
    `  versions ${updated.versions.length}`,
    `  inserted ${isTextLike(loaded.descriptor.mimeType) && includeContent ? 'bounded text content' : 'safe artifact reference'}`,
  ].join('\n');
}

export function createAgentDocumentsTool(
  shellPaths: ShellPathService,
  artifactStore?: AgentDocumentArtifactStore,
): Tool {
  return {
    definition: {
      name: 'agent_documents',
      description: 'Create drafts, review suggestions, attach artifacts, and export.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [...MODES],
            description: 'Document action. Defaults to list.',
          },
          documentId: {
            type: 'string',
            description: 'Document id or exact title for show, update, review, or export.',
          },
          query: {
            type: 'string',
            description: 'Search query for list mode.',
          },
          title: {
            type: 'string',
            description: 'Document title for create or update.',
          },
          body: {
            type: 'string',
            description: 'Markdown body for create or update.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional document tags.',
          },
          status: {
            type: 'string',
            enum: ['draft', 'reviewed', 'archived'],
            description: 'Optional document status for update.',
          },
          commentId: {
            type: 'string',
            description: 'Comment id for mode:"resolveComment".',
          },
          comment: {
            type: 'string',
            description: 'Review comment body for mode:"comment".',
          },
          suggestionId: {
            type: 'string',
            description: 'Suggestion id for acceptSuggestion or rejectSuggestion.',
          },
          suggestionRationale: {
            type: 'string',
            description: 'Why the suggested replacement helps the user.',
          },
          artifactId: {
            type: 'string',
            description: 'Saved artifact id for insertArtifact or attachArtifact.',
          },
          attachmentLabel: {
            type: 'string',
            description: 'Optional user-facing label for mode:"attachArtifact".',
          },
          attachmentNote: {
            type: 'string',
            description: 'Optional attachment note for mode:"attachArtifact".',
          },
          placement: {
            type: 'string',
            enum: ['append', 'prepend', 'replace'],
            description: 'Where to place inserted artifact content in the document body.',
          },
          sectionTitle: {
            type: 'string',
            description: 'Optional markdown heading for inserted artifact content.',
          },
          includeContent: {
            type: 'boolean',
            description: 'Insert bounded text for text artifacts; reference non-text artifacts.',
          },
          changeSummary: {
            type: 'string',
            description: 'Short version note for create or update.',
          },
          includeVersions: {
            type: 'boolean',
            description: 'Include version history in show mode.',
          },
          limit: {
            type: 'number',
            description: 'Maximum list rows.',
          },
          confirm: {
            type: 'boolean',
            description: 'Required true for document writes and export.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing the document mutation.',
          },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs: unknown) => {
      const args = rawArgs as AgentDocumentsToolArgs;
      const mode = args.mode === undefined || readString(args.mode) === ''
        ? 'list'
        : isMode(args.mode)
          ? args.mode
          : null;
      if (mode === null) return failure(`mode must be one of ${MODES.join(', ')}.`);

      const registry = AgentDocumentRegistry.fromShellPaths(shellPaths);
      try {
        if (mode === 'list') {
          const query = readString(args.query);
          const matches = query ? registry.search(query) : registry.list();
          const limit = readLimit(args.limit, 20);
          return output(formatList(matches.slice(0, limit), matches.length, query));
        }
        if (mode === 'show') {
          const document = registry.get(requireDocumentId(args));
          if (!document) return failure(`Unknown Agent document ${readString(args.documentId)}.`);
          return output(formatShow(document, readBoolean(args.includeVersions, true)));
        }
        if (mode === 'create') {
          requireConfirmed(args, 'Agent document creation');
          const title = readString(args.title);
          const body = readString(args.body);
          const document = registry.create({
            title,
            body,
            tags: readStringList(args.tags),
            summary: readString(args.changeSummary) || 'Initial draft.',
          });
          return output([
            'Created Agent document',
            `  id ${document.id}`,
            `  title ${document.title}`,
            `  versions ${document.versions.length}`,
          ].join('\n'));
        }
        if (mode === 'update') {
          requireConfirmed(args, 'Agent document update');
          const id = requireDocumentId(args);
          const document = registry.update(id, {
            title: args.title === undefined ? undefined : readString(args.title),
            body: args.body === undefined ? undefined : readString(args.body),
            tags: args.tags === undefined ? undefined : readStringList(args.tags),
            status: readStatus(args.status),
            summary: readString(args.changeSummary) || 'Updated draft.',
          });
          return output([
            'Updated Agent document',
            `  id ${document.id}`,
            `  title ${document.title}`,
            `  versions ${document.versions.length}`,
          ].join('\n'));
        }
        if (mode === 'review') {
          requireConfirmed(args, 'Agent document review');
          const document = registry.markReviewed(requireDocumentId(args));
          return output([
            'Reviewed Agent document',
            `  id ${document.id}`,
            `  status ${document.status}`,
            `  versions ${document.versions.length}`,
          ].join('\n'));
        }
        if (mode === 'comment') {
          requireConfirmed(args, 'Agent document comment');
          const document = registry.addComment(requireDocumentId(args), { body: readString(args.comment) });
          const latest = document.comments.at(-1);
          return output([
            'Added Agent document comment',
            `  document ${document.id}`,
            `  comment ${latest?.id ?? '(unknown)'}`,
            `  open ${document.comments.filter((comment) => comment.status === 'open').length}/${document.comments.length}`,
          ].join('\n'));
        }
        if (mode === 'resolveComment') {
          requireConfirmed(args, 'Agent document comment resolution');
          const document = registry.resolveComment(requireDocumentId(args), requireCommentId(args));
          return output([
            'Resolved Agent document comment',
            `  document ${document.id}`,
            `  comment ${readString(args.commentId)}`,
            `  open ${document.comments.filter((comment) => comment.status === 'open').length}/${document.comments.length}`,
          ].join('\n'));
        }
        if (mode === 'suggest') {
          requireConfirmed(args, 'Agent document suggestion');
          const document = registry.suggestUpdate(requireDocumentId(args), {
            title: args.title === undefined ? undefined : readString(args.title),
            body: readString(args.body),
            tags: args.tags === undefined ? undefined : readStringList(args.tags),
            status: readStatus(args.status),
            summary: readString(args.changeSummary) || 'AI suggested revision.',
            rationale: readString(args.suggestionRationale) || 'No rationale provided.',
          });
          const latest = document.suggestions.at(-1);
          return output([
            'Added Agent document suggestion',
            `  document ${document.id}`,
            `  suggestion ${latest?.id ?? '(unknown)'}`,
            `  proposed ${document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length}/${document.suggestions.length}`,
            `  versions ${document.versions.length}`,
          ].join('\n'));
        }
        if (mode === 'acceptSuggestion') {
          requireConfirmed(args, 'Agent document suggestion acceptance');
          const document = registry.acceptSuggestion(requireDocumentId(args), requireSuggestionId(args));
          return output([
            'Accepted Agent document suggestion',
            `  document ${document.id}`,
            `  suggestion ${readString(args.suggestionId)}`,
            `  versions ${document.versions.length}`,
            `  proposed ${document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length}/${document.suggestions.length}`,
          ].join('\n'));
        }
        if (mode === 'rejectSuggestion') {
          requireConfirmed(args, 'Agent document suggestion rejection');
          const document = registry.rejectSuggestion(requireDocumentId(args), requireSuggestionId(args));
          return output([
            'Rejected Agent document suggestion',
            `  document ${document.id}`,
            `  suggestion ${readString(args.suggestionId)}`,
            `  versions ${document.versions.length}`,
            `  proposed ${document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length}/${document.suggestions.length}`,
          ].join('\n'));
        }
        if (mode === 'insertArtifact') {
          requireConfirmed(args, 'Agent document artifact insertion');
          return output(await insertArtifactIntoDocument(registry, artifactStore, args));
        }
        if (mode === 'attachArtifact') {
          requireConfirmed(args, 'Agent document artifact attachment');
          return output(await attachArtifactToDocument(registry, artifactStore, args));
        }
        requireConfirmed(args, 'Agent document export');
        const document = registry.get(requireDocumentId(args));
        if (!document) return failure(`Unknown Agent document ${readString(args.documentId)}.`);
        return output(await exportDocument(registry, artifactStore, document));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentDocumentsTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  artifactStore?: AgentDocumentArtifactStore,
): void {
  registry.register(createAgentDocumentsTool(shellPaths, artifactStore));
}
