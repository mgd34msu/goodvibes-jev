import { deflateRawSync } from 'node:zlib';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';

export interface ArtifactPackageEntry {
  readonly path: string;
  readonly buffer: Buffer;
}

const SENSITIVE_METADATA_KEY = /token|secret|password|authorization|credential|api[-_]?key/i;

export function sanitizeArtifactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArtifactMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_METADATA_KEY.test(key) ? '<redacted>' : sanitizeArtifactMetadata(entry),
  ]));
}

export function sanitizeArtifactSourceUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_METADATA_KEY.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return url.toString();
  } catch {
    return value.replace(/([?&\s](?:token|secret|password|authorization|credential|api[-_]?key)=)[^\s&]+/gi, '$1<redacted>');
  }
}

export function safeArtifactExportFilename(artifact: ArtifactDescriptor): string {
  const filename = (artifact.filename || artifact.id).trim() || artifact.id;
  return filename.replace(/[\\/]+/g, '-').replace(/^\.+$/, artifact.id);
}

function safePackagePathSegment(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');
  const normalized = sanitized || fallback;
  return normalized.length > 128 ? normalized.slice(0, 128).trimEnd() : normalized;
}

export function packageArtifactFilename(
  artifact: ArtifactDescriptor,
  index: number,
  used: Set<string>,
): string {
  const ordinal = String(index + 1).padStart(2, '0');
  const id = safePackagePathSegment(artifact.id, `artifact-${ordinal}`);
  const filename = safePackagePathSegment(safeArtifactExportFilename(artifact), id);
  const base = `${ordinal}-${id}-${filename}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZipArchive(entries: readonly ArtifactPackageEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error('Artifact archive has too many files for ZIP output.');
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const timestamp = dosTimestamp();
  let offset = 0;

  for (const entry of entries) {
    const safePath = entry.path.replace(/\\/g, '/');
    const name = Buffer.from(safePath, 'utf-8');
    const compressed = deflateRawSync(entry.buffer);
    if (name.byteLength > 0xffff) throw new Error(`Artifact archive entry path is too long: ${safePath}`);
    if (entry.buffer.byteLength > 0xffffffff || compressed.byteLength > 0xffffffff) {
      throw new Error(`Artifact archive entry is too large for ZIP output: ${safePath}`);
    }
    const checksum = crc32(entry.buffer);
    const method = 8;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(entry.buffer.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(entry.buffer.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.byteLength + name.byteLength + compressed.byteLength;
    if (offset > 0xffffffff) throw new Error('Artifact archive is too large for ZIP output.');
  }

  const centralOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.byteLength > 0xffffffff) throw new Error('Artifact archive central directory is too large for ZIP output.');

  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.byteLength, 12);
  endOfCentralDirectory.writeUInt32LE(centralOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}
