import { JudgmentError, type JudgmentPort, type Outcome, type YesNoReading } from '@goodvibes-jev/judgment';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { commandRankBattery, daemonRefusalBattery, statusToneBattery } from './webui-specs.js';
import {
  BADGE_TONES, LIBRARY_DOT_TONES, REFUSAL_ITEMS, STATUS_DOMAINS, WEBUI_READER_LIMITS as LIMITS,
  type CommandRankValue, type DaemonRefusalItem, type DaemonRefusalValue,
  type ResolvedCommandRank, type ResolvedDaemonRefusal, type ResolvedStatus,
  type StatusValue, type WebuiReaderOptions, type WebuiReadResult,
} from './webui-types.js';

type NotReady = Exclude<WebuiReadResult<never>, { status: 'ready' }>;
class Hold extends Error {
  constructor(readonly reason: 'budget' | 'unsupported-input') { super('WebUI reading held.'); }
}
const unsupported = (): never => { throw new Hold('unsupported-input'); };
const budget = (): never => { throw new Hold('budget'); };
const aborted = (): NotReady => ({ status: 'unavailable', reason: 'aborted' });

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unsupported();
  if (Object.keys(value).some((key) => !keys.includes(key))) return unsupported();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) return unsupported();
  if (value.length > limit) return budget();
  return value;
}
function member<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) return unsupported();
  return value as T;
}

function failure(error: unknown, options: WebuiReaderOptions): NotReady {
  if (options.signal?.aborted) return aborted();
  if (error instanceof JudgmentInputError) return { status: 'held', reason: error.problem === 'unsupported-input' ? 'unsupported-input' : 'unsafe-input' };
  if (error instanceof Hold) return { status: 'held', reason: error.reason };
  if (error instanceof JudgmentError) {
    if (error.kind === 'aborted') return aborted();
    if (error.kind === 'invalid-response' || error.kind === 'invalid-request') return { status: 'unavailable', reason: 'invalid-response' };
  }
  return { status: 'unavailable', reason: 'offline' };
}
function unresolved(outcomes: readonly Outcome[]): NotReady | undefined {
  if (outcomes.includes('escalate')) return { status: 'uncertain', reason: 'unsettled', outcome: 'escalate' };
  if (outcomes.includes('confirm')) return { status: 'uncertain', reason: 'unsettled', outcome: 'confirm' };
  return undefined;
}
function decisionIds(ids: readonly (string | undefined)[]): { readonly decisionIds?: readonly string[] } {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? {} : { decisionIds: present };
}

function refusalInput(input: ResolvedDaemonRefusal): ResolvedDaemonRefusal {
  // Inspect the COMPLETE source before caps, projection, any hash, or port use.
  const source = object(snapshotJudgmentInput(input), ['methodId', 'status', 'code', 'category', 'message']);
  const methodId = text(source['methodId'], 256);
  const message = text(source['message'], LIMITS.errorBytes, true);
  if (new TextEncoder().encode(message).byteLength > LIMITS.errorBytes) return budget();
  const status = source['status'];
  if (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || (status !== 0 && (status < 100 || status > 599)))) return unsupported();
  const code = source['code'] === undefined ? undefined : text(source['code'], 128, true);
  const category = source['category'] === undefined ? undefined : member(source['category'], ['network', 'authentication'] as const);
  return { methodId, message, ...(status === undefined ? {} : { status: status as number }),
    ...(code === undefined ? {} : { code }), ...(category === undefined ? {} : { category }) };
}

const REFUSAL_CODES: Readonly<Record<string, DaemonRefusalItem>> = {
  SESSION_NOT_FOUND: 'session_not_found', SESSION_CLOSED: 'session_closed',
  SESSION_ACTIVE: 'session_active', SESSION_NOT_LOCAL: 'session_not_local', METHOD_NOT_FOUND: 'method_unknown',
};
// Exact existing wire categories, not substring guesses or HTTP 412/501 inference.
const OTHER_CODES = new Set([
  'NO_ACTIVE_TURN', 'CONFLICT', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'PERMISSION_DENIED',
  'NETWORK_UNREACHABLE', 'TIMEOUT', 'CANCELLED', 'NOT_INVOKABLE',
  'CALENDAR_NOT_CONFIGURED', 'CALENDAR_CREDENTIALS_MISSING', 'CALENDAR_AUTH_FAILED',
  'EMAIL_NOT_CONFIGURED', 'EMAIL_CREDENTIALS_MISSING', 'EMAIL_AUTH_FAILED',
  'IMAP_NOT_CONFIGURED', 'SMTP_NOT_CONFIGURED', 'IMAP_AUTH_FAILED', 'SMTP_AUTH_FAILED',
  'step-up-required', 'step-up-verifier-unavailable',
]);
const emptyRefusal = (): Record<DaemonRefusalItem, boolean> => ({
  session_not_found: false, session_closed: false, session_active: false, session_not_local: false, method_unknown: false,
});
function structuredRefusal(source: ResolvedDaemonRefusal): DaemonRefusalValue | undefined {
  const item = source.code !== undefined && Object.hasOwn(REFUSAL_CODES, source.code) ? REFUSAL_CODES[source.code] : undefined;
  if (item !== undefined) return { ...emptyRefusal(), [item]: item !== 'method_unknown' || source.status === 404 };
  if (OTHER_CODES.has(source.code ?? '') || source.status === 0 || source.status === 401 || source.category !== undefined) return emptyRefusal();
  return undefined;
}

/**
 * Pure caller-side path before the interpretation endpoint. A structural result
 * has no probabilities or decision IDs; `undefined` means a reading is needed.
 */
export function readStructuredDaemonRefusal(input: ResolvedDaemonRefusal): WebuiReadResult<DaemonRefusalValue> | undefined {
  try {
    const value = structuredRefusal(refusalInput(input));
    return value === undefined ? undefined : { status: 'ready', value, basis: 'structured' };
  } catch (error) { return failure(error, {}); }
}

/**
 * Server-only interpretation of an admitted, unresolved projection. Known
 * structural cases belong to readStructuredDaemonRefusal before the endpoint;
 * they hold here rather than manufacture recorded readings. The caller must
 * independently authorize source access, processing route and log retention.
 * The injected port must validate answers/failures BEFORE decision logging.
 */
export async function readDaemonRefusal(port: JudgmentPort | undefined, input: ResolvedDaemonRefusal, options: WebuiReaderOptions = {}): Promise<WebuiReadResult<DaemonRefusalValue>> {
  try {
    if (options.signal?.aborted) return aborted();
    const source = refusalInput(input);
    if (structuredRefusal(source) !== undefined) return { status: 'held', reason: 'unsupported-input' };
    if (!source.message.trim()) return { status: 'held', reason: 'unsupported-input' };
    if (!port) return { status: 'unavailable', reason: 'unconfigured' };
    const only = REFUSAL_ITEMS.filter((item) => item !== 'method_unknown' || source.status === 404);
    const run = await daemonRefusalBattery.run(port, { ...source }, { ...options, only, site: 'webui.errors.daemon-refusal' });
    if (options.signal?.aborted) { run.recordAction('aborted'); return aborted(); }
    const waiting = unresolved(only.map((item) => run.readings[item].outcome));
    if (waiting) { run.recordAction(waiting.status === 'uncertain' ? waiting.outcome : 'unavailable'); return waiting; }
    const value = emptyRefusal();
    for (const item of only) value[item] = run.readings[item].verdict === 'yes';
    // Missing resource conflicts with claims it exists. Closed and active are
    // mutually exclusive. Locality can coexist with a known active/closed state.
    const conflict = (value.session_not_found && (value.session_closed || value.session_active || value.session_not_local))
      || (value.session_closed && value.session_active)
      || (value.method_unknown && (value.session_not_found || value.session_closed || value.session_active || value.session_not_local));
    if (conflict) { run.recordAction('conflicting-evidence'); return { status: 'uncertain', reason: 'conflicting-evidence', outcome: 'escalate' }; }
    run.recordAction('ready');
    return { status: 'ready', value, basis: 'judgment', ...decisionIds([run.result.decisionId]) };
  } catch (error) { return failure(error, options); }
}

function statusInput(input: ResolvedStatus): ResolvedStatus {
  const source = object(snapshotJudgmentInput(input), ['kind', 'vocabulary', 'tone', 'status', 'domain']);
  const vocabulary = member(source['vocabulary'], ['badge', 'library-dot'] as const);
  if (source['kind'] === 'structured') {
    if (Object.hasOwn(source, 'status') || Object.hasOwn(source, 'domain')) return unsupported();
    return vocabulary === 'badge'
      ? { kind: 'structured', vocabulary, tone: member(source['tone'], BADGE_TONES) }
      : { kind: 'structured', vocabulary, tone: member(source['tone'], LIBRARY_DOT_TONES) };
  }
  if (source['kind'] !== 'text' || Object.hasOwn(source, 'tone')) return unsupported();
  return { kind: 'text', vocabulary, status: text(source['status'], LIMITS.statusChars), domain: member(source['domain'], STATUS_DOMAINS) };
}

/** One fixed server-selected item; known authoritative tones require no port. */
export async function readStatusTone(port: JudgmentPort | undefined, input: ResolvedStatus, options: WebuiReaderOptions = {}): Promise<WebuiReadResult<StatusValue>> {
  try {
    if (options.signal?.aborted) return aborted();
    const source = statusInput(input);
    if (source.kind === 'structured') return { status: 'ready', value: { vocabulary: source.vocabulary, tone: source.tone } as StatusValue, basis: 'structured' };
    if (!port) return { status: 'unavailable', reason: 'unconfigured' };
    const item = source.vocabulary === 'badge' ? 'badge' : 'library_dot';
    const run = await statusToneBattery.run(port, { status: source.status, domain: source.domain }, { ...options, only: [item], site: 'webui.status.badge-tone' });
    if (options.signal?.aborted) { run.recordAction('aborted'); return aborted(); }
    const waiting = unresolved([run.readings[item].outcome]);
    if (waiting) { run.recordAction(waiting.status === 'uncertain' ? waiting.outcome : 'unavailable'); return waiting; }
    const value: StatusValue = source.vocabulary === 'badge'
      ? { vocabulary: 'badge', tone: run.readings.badge.choice }
      : { vocabulary: 'library-dot', tone: run.readings.library_dot.choice };
    run.recordAction('ready');
    return { status: 'ready', value, basis: 'judgment', ...decisionIds([run.result.decisionId]) };
  } catch (error) { return failure(error, options); }
}

function rankInput(input: ResolvedCommandRank): ResolvedCommandRank {
  const source = object(snapshotJudgmentInput(input), ['query', 'registryVersion', 'candidates']);
  const query = text(source['query'], LIMITS.queryChars);
  const registryVersion = text(source['registryVersion'], 256);
  const entries = source['candidates'];
  if (!Array.isArray(entries)) return unsupported();
  if (entries.length > LIMITS.candidateCount) return budget();
  if (Object.keys(entries).length !== entries.length || Array.from({ length: entries.length }, (_, index) => !Object.hasOwn(entries, index)).some(Boolean)) return unsupported();
  const candidates = entries.map((entry: unknown) => {
    const candidate = object(entry, ['title', 'group', 'keywords']);
    const title = text(candidate['title'], LIMITS.titleChars);
    const group = candidate['group'] === undefined ? undefined : text(candidate['group'], LIMITS.groupChars, true);
    const rawKeywords = candidate['keywords'];
    if (rawKeywords !== undefined && !Array.isArray(rawKeywords)) return unsupported();
    if (rawKeywords && rawKeywords.length > LIMITS.keywordCount) return budget();
    if (rawKeywords && (Object.keys(rawKeywords).length !== rawKeywords.length || Array.from({ length: rawKeywords.length }, (_, index) => !Object.hasOwn(rawKeywords, index)).some(Boolean))) return unsupported();
    const keywords = rawKeywords?.map((keyword: unknown) => text(keyword, LIMITS.keywordChars));
    return { title, ...(group === undefined ? {} : { group }), ...(keywords === undefined ? {} : { keywords }) };
  });
  return { query, registryVersion, candidates };
}

/**
 * Every candidate is scored, at most four concurrently. The index is the only
 * candidate identity recorded; session IDs never enter this reader's schema.
 * The service also owns the aggregate outbound-attempt and deadline budgets.
 */
export async function readCommandRank(port: JudgmentPort | undefined, input: ResolvedCommandRank, options: WebuiReaderOptions = {}): Promise<WebuiReadResult<CommandRankValue>> {
  try {
    if (options.signal?.aborted) return aborted();
    const source = rankInput(input);
    if (source.candidates.length === 0) return { status: 'ready', basis: 'structured', value: { registryVersion: source.registryVersion, accepted: [], rejected: [] } };
    if (!port) return { status: 'unavailable', reason: 'unconfigured' };
    const runs: { reading: YesNoReading; decisionId: string | undefined; recordAction: (action: string) => void }[] = [];
    let next = 0;
    let failed: NotReady | undefined;
    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted && !failed && next < source.candidates.length) {
        const candidateIndex = next++;
        try {
          const candidate = source.candidates[candidateIndex]!;
          const state = { query: source.query, candidate: { title: candidate.title,
            ...(candidate.group === undefined ? {} : { group: candidate.group }),
            ...(candidate.keywords === undefined ? {} : { keywords: [...candidate.keywords] }) } };
          const run = await commandRankBattery.run(port, state, { ...options, site: 'webui.palette.command-rank', pattern: 'rerank' });
          const reading = run.readings.match;
          if (run.result.decisionId !== undefined) port.recorder?.recordReadings(run.result.decisionId, { candidateIndex, match: { ...reading } });
          runs[candidateIndex] = { reading, decisionId: run.result.decisionId, recordAction: run.recordAction };
        } catch (error) { failed ??= failure(error, options); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, source.candidates.length) }, worker));
    if (options.signal?.aborted || failed) {
      for (const run of runs) run?.recordAction(options.signal?.aborted ? 'aborted' : 'unavailable');
      return options.signal?.aborted ? aborted() : failed!;
    }
    const waiting = unresolved(runs.map((run) => run.reading.outcome));
    if (waiting) {
      for (const run of runs) run.recordAction(waiting.status === 'uncertain' ? waiting.outcome : 'unavailable');
      return waiting;
    }
    const accepted: { candidateIndex: number; probability: number }[] = [];
    const rejected: number[] = [];
    runs.forEach(({ reading }, candidateIndex) => {
      if (reading.verdict === 'yes') accepted.push({ candidateIndex, probability: reading.probability });
      else rejected.push(candidateIndex);
    });
    accepted.sort((a, b) => b.probability - a.probability || a.candidateIndex - b.candidateIndex);
    for (const run of runs) run.recordAction('ready');
    return { status: 'ready', basis: 'judgment', value: { registryVersion: source.registryVersion, accepted, rejected }, ...decisionIds(runs.map((run) => run.decisionId)) };
  } catch (error) { return failure(error, options); }
}
