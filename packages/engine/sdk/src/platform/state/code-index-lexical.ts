/**
 * code-index-lexical.ts, the ranking half of the code index's lexical search.
 * CodeIndexStore.searchLexical recalls chunks whose symbol or path contains a
 * query token (SQL LIKE, code); the `engine.state.code-search` rerank orders
 * them here. The index stores no chunk text, so each chunk's code is read
 * back from its file for the reading; a file that cannot be read is judged on
 * its path and symbol alone.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { codeChunkView, codeSearchRerank } from './batteries/code-search-rerank.js';
import type { CodeChunk } from './code-index-chunking.js';
import type { CodeContextResult } from './code-index-types.js';

const CODE_SEARCH_SITE = 'state.code-index-search';

/** The chunk's lines (1-based, inclusive) from its file under `rootDir`, or undefined when the file cannot be read. */
async function readChunkCode(rootDir: string, chunk: CodeChunk): Promise<string | undefined> {
  try {
    const text = await readFile(join(rootDir, chunk.path), 'utf8');
    return text.split('\n').slice(Math.max(0, chunk.startLine - 1), chunk.endLine).join('\n');
  } catch {
    return undefined;
  }
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
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const candidates = await Promise.all(chunks.map(async (chunk) => ({
    id: chunk.chunkId,
    content: codeChunkView(chunk, await readChunkCode(rootDir, chunk)),
  })));
  const { ranked } = await codeSearchRerank.rerank(judgmentPort(CODE_SEARCH_SITE), query, candidates, { site: CODE_SEARCH_SITE });
  return ranked
    .filter((entry) => entry.reading.verdict !== 'no')
    .slice(0, limit)
    .map((entry) => ({
      chunk: byId.get(entry.id)!,
      distance: 2 * (1 - entry.probability),
      similarity: entry.probability,
      label: 'lexical' as const,
    }));
}
