import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { sourceReadsFromTurns, type ContractTurnRecord, type SourceReadEvidence } from '../contract/evidence.js';
import type { OwnerEvidenceReader } from '../contract/owner-evidence.js';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reuses actual owner read results only after each numbered line matches
 * the contract's immutable input. Session text cannot certify source or work. */
export function createOwnerReadEvidenceReader(surfaceDirectory: string): OwnerEvidenceReader {
  const cache = new Map<string, { scope: SourceReadEvidence[]; calls: string[];
    rows: Map<string, [number, string][]>; citations: RegExp }>();
  return (contract, citationText) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(contract.sessionId) || !contract.inputSnapshot
      || !/^[a-f0-9]{40,64}$/.test(contract.inputSnapshot.inputTree)) return undefined;
    const within = relative(contract.projectRoot, surfaceDirectory);
    if (isAbsolute(within) || within.split('/').includes('..') || !within.startsWith('.goodvibes/')) return undefined;
    let directory = contract.projectRoot;
    for (const part of within.split('/')) {
      directory = join(directory, part);
      if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) return undefined;
    }
    const sessionFiles = [join(surfaceDirectory, 'sessions', `${contract.sessionId}.jsonl`),
      join(surfaceDirectory, 'recovery', `recovery-${contract.sessionId}.jsonl`)];
    const sources: { path: string; sha256: string; bytes: number; contents: string }[] = [];
    for (const path of sessionFiles) {
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || lstatSync(join(path, '..')).isSymbolicLink()) return undefined;
      const bytes = readFileSync(path);
      sources.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, contents: bytes.toString('utf8') });
    }
    if (!sources.length) return undefined;
    const key = JSON.stringify([contract.projectRoot, contract.inputSnapshot.inputTree, sources.map(source => [source.path, source.sha256])]);
    let saved = cache.get(key);
    if (!saved) {
      const turns: ContractTurnRecord[] = [], calls: string[] = [];
      const originals = new Map<string, string[] | null>();
      const seen = new Set<string>();
      const messages: Record<string, unknown>[] = [];
      for (const source of sources) {
        for (const line of source.contents.split('\n').filter(Boolean)) {
          try { const parsed: unknown = JSON.parse(line); if (object(parsed)) messages.push(parsed); } catch { return undefined; }
        }
      }
      const requests = new Map<string, Record<string, unknown>>();
      for (const message of messages) if (message['role'] === 'assistant' && Array.isArray(message['toolCalls'])) {
        for (const call of message['toolCalls']) if (object(call) && call['name'] === 'read' && typeof call['id'] === 'string') requests.set(call['id'], call);
      }
      const pending: { callId: string; arguments: Record<string, unknown>; files: { path: string; content: string }[] }[] = [];
      for (const message of messages) {
        if (message['role'] !== 'tool' || typeof message['callId'] !== 'string' || typeof message['content'] !== 'string') continue;
        const call = requests.get(message['callId']);
        if (!call) continue;
        const identity = JSON.stringify([message['callId'], message['content']]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        let parsed: unknown;
        try { parsed = JSON.parse(message['content']); } catch { continue; }
        if (!object(parsed)) continue;
        const result = parsed;
        if (result['success'] !== true || !Array.isArray(result['files'])) continue;
        const files: { path: string; content: string }[] = [];
        for (const file of result['files']) {
          if (!object(file) || typeof file['path'] !== 'string' || typeof file['content'] !== 'string' || file['error'] || file['binary']
            || (file['extract'] !== 'content' && file['extract'] !== 'lines')) continue;
          const path = isAbsolute(file.path) ? relative(contract.projectRoot, file.path) : file.path;
          if (isAbsolute(path) || /[\r\n\0]/.test(path) || path.split('/').includes('..') || path.startsWith('.goodvibes/') || path.startsWith('.git/')) continue;
          if (typeof file.resolvedPath === 'string' && file.resolvedPath !== join(contract.projectRoot, path)) continue;
          files.push({ path, content: file.content });
        }
        if (files.length) pending.push({ callId: message['callId'], arguments: object(call['arguments']) ? call['arguments'] : {}, files });
      }
      const sourcePaths = [...new Set(pending.flatMap(record => record.files.map(file => file.path)))];
      for (let offset = 0; offset < sourcePaths.length; offset += 64) {
        const batch = sourcePaths.slice(offset, offset + 64);
        const blobs = spawnSync('git', ['-C', contract.projectRoot, 'cat-file', '--batch'], {
          input: batch.map(path => `${contract.inputSnapshot!.inputTree}:${path}\n`).join(''), maxBuffer: 32 * 1024 * 1024,
        });
        if (blobs.status !== 0) return undefined;
        let position = 0;
        for (const path of batch) {
          const end = blobs.stdout.indexOf(10, position);
          if (end < 0) return undefined;
          const header = blobs.stdout.subarray(position, end).toString('utf8');
          const match = /^[a-f0-9]{40,64} (\w+) (\d+)$/.exec(header);
          if (!match) {
            if (!header.endsWith(' missing')) return undefined;
            originals.set(path, null); position = end + 1; continue;
          }
          const size = Number(match[2]);
          if (!Number.isSafeInteger(size) || end + 1 + size >= blobs.stdout.length) return undefined;
          originals.set(path, match[1] === 'blob' ? blobs.stdout.subarray(end + 1, end + 1 + size).toString('utf8').split(/\r?\n/) : null);
          position = end + 1 + size + 1;
        }
      }
      const returned = new Map<string, Map<number, string>>();
      for (const record of pending) {
        const files: { path: string; extract: 'lines'; content: string }[] = [];
        for (const file of record.files) {
          const path = file.path;
          const original = originals.get(path);
          if (!original) continue;
          const rows = file.content.split('\n').filter((row: string) => {
            const match = /^[ \t]*(\d+) \| ?(.*)$/.exec(row);
            return match !== null && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 && original[Number(match[1]) - 1] === match[2];
          });
          if (rows.length) {
            files.push({ path, extract: 'lines', content: rows.join('\n') });
            const numbered = returned.get(path) ?? new Map<number, string>();
            for (const row of rows) numbered.set(Number(/^[ \t]*(\d+) \|/.exec(row)![1]), row);
            returned.set(path, numbered);
          }
        }
        if (!files.length) continue;
        calls.push(record.callId);
        turns.push({ turn: turns.length + 1, assistantText: '', toolCalls: [{ name: 'read', arguments: record.arguments }],
          results: [{ callId: record.callId, success: true, output: JSON.stringify({ success: true, files }) }] });
      }
      const scope = sourceReadsFromTurns(turns);
      const names = scope.map(read => read.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
      saved = { scope, calls, rows: new Map([...returned].map(([path, rows]) => [path, [...rows].sort(([a], [b]) => a - b)])),
        citations: new RegExp('(?<![\\w./-])(' + (names.join('|') || '(?!)') + ')(?::|#L)(\\d+)(?:[-–]L?(\\d+))?', 'g') };
      if (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(key, saved);
    }
    saved.citations.lastIndex = 0;
    const cited = new Map<string, [number, number][]>();
    for (const match of citationText.matchAll(saved.citations)) {
      const ranges = cited.get(match[1]!) ?? []; ranges.push([Number(match[2]), Number(match[3] ?? match[2])]); cited.set(match[1]!, ranges);
    }
    const reads = saved.scope.map(read => {
      const ranges = cited.get(read.path);
      if (!ranges) return read;
      const content = saved.rows.get(read.path)?.filter(([line]) => ranges.some(([start, end]) => line >= start && line <= end)).map(([, row]) => row).join('\n');
      return content ? { ...read, returnedContent: content, contentKind: 'cited-source' as const } : read;
    });
    return { kind: 'original-owner-read-observations', ownerSessionId: contract.sessionId,
      inputTree: contract.inputSnapshot.inputTree, callIds: [...new Set(saved.calls)],
      hostValidation: { operation: 'verify-recorded-owner-reads', source: 'native-host', success: true,
        ownerSessionId: contract.sessionId, inputTree: contract.inputSnapshot.inputTree,
        qualifiedFiles: reads.length, returnedLines: reads.reduce((total, read) => total + read.returnedLines, 0),
        meaning: 'Actual original-owner tool returns matched the immutable source line by line. This establishes returned scope and cited text, not semantic review quality, tests or native acceptance.' },
      sources: sources.map(({ path, sha256, bytes }) => ({ operation: 'read-owner-session', success: true, path, sha256, bytes })),
      sourceReads: reads.map(read => ({ ...read, returnedRanges: [...read.returnedRanges] })),
      meaning: 'Actual recorded original-owner successful read results, qualified line by line against this immutable contract input. Only matching numbered returned lines count; requests, declared totals, searches and previews do not. Quoted contents are limited to cited source ranges. These are earlier owner observations, not worker actions, executed tests, semantic review approval or acceptance of this answer.',
    };
  };
}
