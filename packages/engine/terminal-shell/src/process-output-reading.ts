import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { processOutputError, processOutputEndpoint } from './batteries/process-output.js';

export const PROCESS_OUTPUT_READING_LIMITS = { questions: 64, concurrency: 4, endpointCandidates: 256 } as const;
export interface ProcessOutputEvidenceLine { readonly id: string; readonly text: string; readonly raw: string; readonly stream: 'stdout' | 'stderr'; }
export interface ProcessEndpointCandidate { readonly id: string; readonly lineId: string; readonly start: number; readonly end: number; readonly port: number; }
export interface ProcessOutputEvidence {
  readonly lines: readonly ProcessOutputEvidenceLine[];
  readonly partials: { readonly stdout: string; readonly stderr: string };
  readonly done: boolean;
}
export interface ProcessOutputReading {
  readonly errors: ReadonlyMap<string, boolean | undefined>;
  readonly port: number | undefined;
  readonly assertCurrent: () => void;
  /** Completed line observations remain valid only under this original authority. */
  readonly assertAuthorityCurrent: () => void;
  readonly recordPublication: () => void;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function captureEvidence(evidence: ProcessOutputEvidence, lineIds: readonly string[]): { readonly evidence: ProcessOutputEvidence; readonly lineIds: readonly string[] } {
  const captured = snapshotJudgmentInput({ evidence, lineIds });
  const invalid = (): never => { throw new Error('Invalid process output evidence'); };
  if (!record(captured) || !record(captured.evidence) || !Array.isArray(captured.lineIds)) return invalid();
  const source = captured.evidence;
  if (!Array.isArray(source.lines) || !record(source.partials) || typeof source.partials.stdout !== 'string' || typeof source.partials.stderr !== 'string' || typeof source.done !== 'boolean') return invalid();
  const lines = source.lines.map((line): ProcessOutputEvidenceLine => {
    if (!record(line) || typeof line.id !== 'string' || typeof line.text !== 'string' || typeof line.raw !== 'string' || (line.stream !== 'stdout' && line.stream !== 'stderr')) return invalid();
    return { id: line.id, text: line.text, raw: line.raw, stream: line.stream };
  });
  const ids = new Set(lines.map(line => line.id));
  if (ids.size !== lines.length || !captured.lineIds.every((id: unknown) => typeof id === 'string' && ids.has(id))) return invalid();
  const targets = captured.lineIds.filter((id: unknown): id is string => typeof id === 'string');
  if (new Set(targets).size !== targets.length) return invalid();
  return { evidence: { lines, partials: { stdout: source.partials.stdout, stderr: source.partials.stderr }, done: source.done }, lineIds: targets };
}

/** Literal integer spans are candidates, never semantic port announcements. */
export function processEndpointCandidates(lines: readonly ProcessOutputEvidenceLine[]): readonly ProcessEndpointCandidate[] | undefined {
  const candidates: ProcessEndpointCandidate[] = [];
  for (const line of lines) for (const match of line.text.matchAll(/(?<![\w.+-])\d{1,5}(?![\w.])/g)) {
    const port = Number(match[0]);
    if (port < 1 || port > 65535) continue;
    if (candidates.length >= PROCESS_OUTPUT_READING_LIMITS.endpointCandidates) return undefined;
    candidates.push({ id: `endpoint-${candidates.length}`, lineId: line.id, start: match.index, end: match.index + match[0].length, port });
  }
  return candidates;
}

export async function readProcessOutput(evidence: ProcessOutputEvidence, lineIds: readonly string[], options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> & { readonly authoritySignal: AbortSignal }): Promise<ProcessOutputReading> {
  // Screen complete retained raw evidence before stripping controls or capturing authority.
  const captured = captureEvidence(evidence, lineIds);
  const source = captured.evidence;
  const candidates = processEndpointCandidates(source.lines);
  const state = { lines: source.lines.map(({ id, text, stream }) => ({ id, text, stream })), partials: source.partials, done: source.done, candidates: candidates?.map(candidate => ({ ...candidate })) ?? [] };
  snapshotJudgmentInput(state);
  const batchLifetime = new AbortController();
  const authority = captureJudgmentPort('terminal-shell.process-output', { signal: options.authoritySignal });
  const owner = captureJudgmentPort('terminal-shell.process-output', { signal: options.signal ? AbortSignal.any([options.signal, batchLifetime.signal]) : batchLifetime.signal, assertCurrent: options.assertCurrent, prepareResultCapture: prepareJudgmentResult });
  authority.assertCurrent(); owner.assertCurrent();
  const jobs = [
    ...captured.lineIds.map(id => ({ id, kind: 'error' as const, key: `error:${id}` })),
    ...(source.done ? [] : (candidates ?? []).map(candidate => ({ id: candidate.id, kind: 'endpoint' as const, key: `endpoint:${candidate.id}` }))),
  ];
  type Job = typeof jobs[number];
  const pages: Job[][] = [];
  for (const kind of ['error', 'endpoint']) {
    const matching = jobs.filter(job => job.kind === kind);
    for (let start = 0; start < matching.length; start += PROCESS_OUTPUT_READING_LIMITS.questions) pages.push(matching.slice(start, start + PROCESS_OUTPUT_READING_LIMITS.questions));
  }
  const errors = new Map<string, boolean | undefined>();
  const endpoints = new Map<string, boolean | undefined>();
  const publications: Array<() => void> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PROCESS_OUTPUT_READING_LIMITS.concurrency, pages.length) }, async () => {
    while (cursor < pages.length) {
      owner.assertCurrent();
      const page = pages[cursor++];
      const first = page?.[0];
      if (!page || !first) continue;
      const battery = first.kind === 'error' ? processOutputError : processOutputEndpoint;
      const result = await battery.readPage(owner.port, state, page, { signal: owner.signal, site: battery.name, beforeAttempt: owner.assertCurrent });
      owner.assertCurrent();
      for (const [id, value] of result.observations) (first.kind === 'error' ? errors : endpoints).set(id, value);
      publications.push(() => { owner.assertCurrent(); result.recordPublication(); owner.assertCurrent(); });
    }
  });
  try { await Promise.all(workers); }
  catch (error) { batchLifetime.abort(); await Promise.allSettled(workers); throw error; }
  owner.assertCurrent(); authority.assertCurrent();
  const announced = new Set((candidates ?? []).filter(candidate => endpoints.get(candidate.id) === true).map(candidate => candidate.port));
  const complete = candidates !== undefined && candidates.every(candidate => endpoints.get(candidate.id) !== undefined);
  const port = !source.done && complete && announced.size === 1 ? announced.values().next().value : undefined;
  return { errors, port, assertCurrent: owner.assertCurrent, assertAuthorityCurrent: authority.assertCurrent,
    recordPublication() { owner.assertCurrent(); for (const publish of publications) publish(); owner.assertCurrent(); },
  };
}
