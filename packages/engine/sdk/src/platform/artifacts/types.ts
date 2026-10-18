/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export type ArtifactKind = 'file' | 'image' | 'audio' | 'video' | 'document' | 'archive' | 'data';
export const ARTIFACT_ACQUISITION_MODES = ['inline-data', 'local-path', 'remote-fetch', 'unknown'] as const;
export const ARTIFACT_FETCH_MODES = ['not-applicable', 'public-only', 'allow-private-hosts', 'unknown'] as const;

export type ArtifactAcquisitionMode = typeof ARTIFACT_ACQUISITION_MODES[number];
export type ArtifactFetchMode = typeof ARTIFACT_FETCH_MODES[number];

export interface ArtifactDescriptor {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly mimeType: string;
  readonly filename?: string | undefined;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt?: number | undefined;
  readonly sourceUri?: string | undefined;
  readonly acquisitionMode: ArtifactAcquisitionMode;
  readonly fetchMode: ArtifactFetchMode;
  readonly metadata: Record<string, unknown>;
}

export interface ArtifactRecord extends ArtifactDescriptor {
  readonly contentPath: string;
  readonly metadataPath: string;
}

export interface ArtifactReference {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ArtifactAttachment extends ArtifactDescriptor {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly contentPath: string;
  readonly contentUrl?: string | undefined;
  readonly dataBase64?: string | undefined;
}

export interface ArtifactCreateInput {
  readonly kind?: ArtifactKind | undefined;
  readonly mimeType?: string | undefined;
  readonly filename?: string | undefined;
  readonly dataBase64?: string | undefined;
  readonly text?: string | undefined;
  readonly path?: string | undefined;
  readonly uri?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly retentionMs?: number | undefined;
  readonly acquisitionMode?: ArtifactAcquisitionMode | undefined;
  readonly fetchMode?: ArtifactFetchMode | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ArtifactStreamCreateInput {
  readonly stream:
    | ReadableStream<Uint8Array>
    | AsyncIterable<Uint8Array | Buffer | string>
    | Iterable<Uint8Array | Buffer | string>;
  readonly kind?: ArtifactKind | undefined;
  readonly mimeType?: string | undefined;
  readonly filename?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly retentionMs?: number | undefined;
  readonly acquisitionMode?: ArtifactAcquisitionMode | undefined;
  readonly fetchMode?: ArtifactFetchMode | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

export function guessMimeType(filename?: string): string {
  if (!filename) return 'application/octet-stream';
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  return EXTENSION_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Artifact kind operation identifier. */
export const ARTIFACT_KIND_SITE = 'artifacts.kind';

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.presentation',
  'application/rtf', 'text/rtf',
]);
const DATA_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'text/xml',
  'application/yaml', 'application/x-yaml', 'text/yaml', 'text/csv', 'text/tab-separated-values',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.apache.parquet',
  'application/vnd.sqlite3', 'application/x-sqlite3',
]);
const ARCHIVE_MIME_TYPES = new Set([
  'application/zip', 'application/gzip', 'application/x-gzip', 'application/x-tar',
  'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed',
  'application/x-bzip2', 'application/x-xz',
]);

/** Resolve registered media types locally. Unknown types remain ordinary files. */
export async function inferArtifactKind(mimeType: string, filename?: string): Promise<ArtifactKind> {
  const declared = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  const type = !declared || declared === 'application/octet-stream' ? guessMimeType(filename) : declared;
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (ARCHIVE_MIME_TYPES.has(type)) return 'archive';
  if (DATA_MIME_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return 'data';
  if (DOCUMENT_MIME_TYPES.has(type) || type.startsWith('text/')) return 'document';
  return 'file';
}

export function sanitizeArtifactFilename(filename: string | undefined, fallback = 'artifact'): string {
  const trimmed = (filename ?? fallback).trim().replace(/[\\/:*?"<>|]+/g, '-');
  return trimmed.length > 0 ? trimmed : fallback;
}
