export type AgentDocumentStatus = 'draft' | 'reviewed' | 'archived';
export type AgentDocumentCommentStatus = 'open' | 'resolved';
export type AgentDocumentSuggestionStatus = 'proposed' | 'accepted' | 'rejected';

export interface AgentDocumentVersion {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface AgentDocumentComment {
  readonly id: string;
  readonly body: string;
  readonly status: AgentDocumentCommentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

export interface AgentDocumentSuggestion {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly documentStatus?: AgentDocumentStatus;
  readonly summary: string;
  readonly rationale: string;
  readonly status: AgentDocumentSuggestionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

export interface AgentDocumentAttachment {
  readonly id: string;
  readonly artifactId: string;
  readonly label: string;
  readonly note?: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly kind?: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentDocumentRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly status: AgentDocumentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versions: readonly AgentDocumentVersion[];
  readonly comments: readonly AgentDocumentComment[];
  readonly suggestions: readonly AgentDocumentSuggestion[];
  readonly attachments: readonly AgentDocumentAttachment[];
  readonly lastArtifactId?: string;
}

export interface AgentDocumentCreateInput {
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly summary?: string;
}

export interface AgentDocumentUpdateInput {
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly status?: AgentDocumentStatus;
  readonly lastArtifactId?: string;
}

export interface AgentDocumentCommentInput {
  readonly body: string;
}

export interface AgentDocumentSuggestionInput {
  readonly title?: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly status?: AgentDocumentStatus;
  readonly summary?: string;
  readonly rationale?: string;
}

export interface AgentDocumentAttachmentInput {
  readonly artifactId: string;
  readonly label?: string;
  readonly note?: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly kind?: string;
  readonly sizeBytes?: number;
}

export interface AgentDocumentSnapshot {
  readonly path: string;
  readonly documents: readonly AgentDocumentRecord[];
}
