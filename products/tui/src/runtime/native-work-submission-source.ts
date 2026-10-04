import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_SUBMISSION_MAX_BYTES = 262_144;
export interface NativeWorkSource { readonly goal: string; readonly criteria: readonly string[]; }
export class NativeWorkSourceError extends Error {}

/** Validate completeness without normalizing, trimming, sorting or deduplicating source. */
export function validateNativeWorkSource(value: unknown): NativeWorkSource {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'goal') || !Object.hasOwn(value, 'criteria')) throw new NativeWorkSourceError('Source must contain exactly goal and criteria.');
  const { goal, criteria } = value as { goal: unknown; criteria: unknown };
  const complete = (text: unknown): text is string => typeof text === 'string' && text.length <= 20_000 && /\S/u.test(text);
  if (!complete(goal)) throw new NativeWorkSourceError('Goal must contain non-whitespace text and be at most 20,000 characters.');
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 100 || !criteria.every(complete)) {
    throw new NativeWorkSourceError('Criteria must be an ordered array of 1–100 non-whitespace strings, each at most 20,000 characters.');
  }
  return Object.freeze({ goal, criteria: Object.freeze([...criteria]) });
}

export function parseNativeWorkSourceJson(text: string): NativeWorkSource {
  if (new TextEncoder().encode(text).byteLength > NATIVE_SUBMISSION_MAX_BYTES) throw new NativeWorkSourceError('Source file exceeds 262,144 UTF-8 bytes.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new NativeWorkSourceError('Source must be valid UTF-8 JSON with exactly goal and criteria.'); }
  return validateNativeWorkSource(value);
}

/** A file keeps slash-command tokenizers away from the user's exact source strings. */
export async function readNativeWorkSourceFile(path: string, workspace: string, signal?: AbortSignal): Promise<NativeWorkSource> {
  if (!path) throw new NativeWorkSourceError('Provide a source JSON file path.');
  signal?.throwIfAborted();
  const target = path.startsWith('file:') ? fileURLToPath(path) : resolve(workspace, path);
  // O_NONBLOCK prevents a named pipe from hanging the command before fstat.
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > NATIVE_SUBMISSION_MAX_BYTES) throw new NativeWorkSourceError('Source must be a regular file of at most 262,144 bytes.');
    const bytes = new Uint8Array(NATIVE_SUBMISSION_MAX_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    signal?.throwIfAborted();
    if (length > NATIVE_SUBMISSION_MAX_BYTES) throw new NativeWorkSourceError('Source file exceeds 262,144 UTF-8 bytes.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new NativeWorkSourceError('Source file must use valid UTF-8.'); }
    return parseNativeWorkSourceJson(text);
  } finally { await handle.close(); }
}
