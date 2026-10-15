/**
 * code-index-lexical.ts, the ranking half of the code index's lexical search.
 * CodeIndexStore.searchLexical recalls chunks whose symbol or path contains a
 * query token (SQL LIKE, code); the `engine.state.code-search` rerank orders
 * them here. The index stores no chunk text, so each chunk's code is read
 * back from its file for the reading; a file that cannot be read is judged on
 * its path and symbol alone.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { retainStrictJudgmentJson, prepareJudgmentResult } from '../gate/judgment-result.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { codeChunkView, rerankCodeParts } from './batteries/code-search-rerank.js';
import type { CodeChunk } from './code-index-chunking.js';
import type { CodeContextResult } from './code-index-types.js';

const CODE_SEARCH_SITE = 'state.code-index-search';

/** Retain the complete native source, including text outside the indexed chunk. */
function readLexicalSource(root: string, path: string): { code?: string; version: string } {
  const candidate = join(root, path), rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Code search source is outside its root');
  let actual: string;
  try { actual = realpathSync(candidate); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return { version: `unavailable:${code}` };
    throw error;
  }
  const actualRelative = relative(root, actual);
  if (!actualRelative || actualRelative === '..' || actualRelative.startsWith('..' + sep) || isAbsolute(actualRelative)) throw new Error('Code search source is outside its root');
  const identity = (value: Stats) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  const before = lstatSync(actual);
  if (!before.isFile()) throw new Error('Code search source is not a regular file');
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(fstatSync(fd)) !== identity(before)) throw new Error('Code search source changed');
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== before.size || identity(fstatSync(fd)) !== identity(before) || identity(lstatSync(actual)) !== identity(before)
      || realpathSync(candidate) !== actual) throw new Error('Code search source changed');
    return { code: buffer.subarray(0, offset).toString('utf8'), version: `${actual}:${identity(before)}` };
  } finally { closeSync(fd); }
}

/**
 * Reranks recalled chunks against the query and returns the best `limit`,
 * best first, leaving out chunks the rerank reads as not matching.
 * `similarity` is the rerank's probability; `distance` is its complement on
 * the vector path's 0 to 2 scale.
 */
export async function rankLexicalChunks(
  rootDir: string,
  query: string,
  chunks: readonly CodeChunk[],
  limit: number,
): Promise<CodeContextResult[]> {
  if (chunks.length === 0) return [];
  const original = retainStrictJudgmentJson({ rootDir, query, chunks, limit });
  const snapshot = original.snapshot;
  const root = realpathSync(snapshot.rootDir);
  const sources = new Map(snapshot.chunks.map(chunk => [chunk.path, readLexicalSource(root, chunk.path)]));
  // Admit every complete source before projecting any chunk or dispatching any pair.
  assertJudgmentInput({ query: snapshot.query, sources: [...sources].map(([path, source]) => ({ path, code: source.code })),
    chunks: snapshot.chunks.map(chunk => ({ path: chunk.path, symbol: chunk.symbol, kind: chunk.kind, startLine: chunk.startLine, endLine: chunk.endLine })) });
  const candidates = snapshot.chunks.map(chunk => ({ id: chunk.chunkId,
    content: codeChunkView(chunk, sources.get(chunk.path)?.code?.split('\n').slice(Math.max(0, chunk.startLine - 1), chunk.endLine).join('\n')) }));
  const current = () => {
    original.assertCurrent();
    if (realpathSync(snapshot.rootDir) !== root) throw new Error('Code search root changed');
    for (const [path, source] of sources) {
      const next = readLexicalSource(root, path);
      if (next.version !== source.version || next.code !== source.code) throw new Error('Code search source changed during ranking');
    }
  };
  const owner = captureJudgmentPort(CODE_SEARCH_SITE, { assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
  const { ranked } = await rerankCodeParts(owner.port, snapshot.query, candidates,
    { site: CODE_SEARCH_SITE, signal: owner.signal, beforeAttempt: owner.assertCurrent });
  owner.assertCurrent();
  const byId = new Map(snapshot.chunks.map(chunk => [chunk.chunkId, chunk]));
  return ranked
    .filter((entry) => entry.reading.outcome !== 'act' || entry.reading.verdict !== 'no')
    .slice(0, snapshot.limit)
    .map((entry) => ({
      chunk: byId.get(entry.id)!,
      distance: 2 * (1 - entry.probability),
      similarity: entry.probability,
      label: 'lexical' as const,
    }));
}
