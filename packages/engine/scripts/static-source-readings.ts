import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalJson, choice, hashState, JudgmentError, noul, PINNED_MODEL, readChoice, readYesNo, STAKES_BANDS, toJson, validateContextBudget, type DecisionLog, type EntryType, type JudgmentPort, type Questions } from '@goodvibes-jev/judgment';
import { DEFERRED_WORK_INSTRUCTIONS, deferredWork, INTERNAL_IDENTIFIER_INSTRUCTIONS, internalIdentifier, STATIC_ANCHOR_FIT_INSTRUCTIONS, STATIC_ANCHOR_INSTRUCTIONS, staticOffendingAnchor } from './batteries/static-source.ts';
import { deferredBatteryPolicyStatements, internalSourceAnchors, markdownSourceContext, structuredSourceContext } from './static-source-anchors.ts';
import { STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS, STATIC_WEAK_ANCHOR_INSTRUCTIONS, staticWeakAnchor } from './batteries/static-weak-anchor.ts';

export type StaticRule = 'internal-identifier' | 'deferred-work';
export interface SourceAnchor {
  readonly id: string;
  readonly line: number;
  readonly col: number;
  readonly text: string;
}
export interface StaticSourceInput {
  readonly kind: StaticRule;
  readonly path: string;
  readonly sourceHash: string;
  readonly firstLine: number;
  readonly lastLine: number;
  readonly source: string;
  readonly anchors: readonly SourceAnchor[];
}
export interface StaticSourceReadings {
  readonly format: 1;
  readonly readingPlanVersion?: 1 | 2 | 3;
  readonly decisionSourceHash: string;
  readonly readings: Readonly<Record<string, unknown>>;
  /** Original source manifests prove which policy a retained wire capture used. */
  readonly captureSources?: Readonly<Record<string, unknown>>;
  readonly captureBatterySources?: Readonly<Record<string, unknown>>;
}

export const STATIC_READINGS_PATH = resolve(import.meta.dir, '../etc/static-source-readings.json.gz');
export const STATIC_SITE = 'engine.gates.static-source';
export const STATIC_SOURCE_READING_PLAN_VERSION = 3;
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Bind extraction, questions, model and reading bands to the actual source. */
export function staticDecisionSourceManifest(): ReadonlyArray<readonly [string, string]> {
  const files = [
    'batteries/static-source.ts', 'batteries/static-weak-anchor.ts', 'static-source-readings.ts', 'internal-identifier-rule.ts',
    'no-todo-marker-rules.ts', 'check-internal-identifiers.ts', 'no-todo-markers.ts', 'read-static-source.ts', 'static-source-anchors.ts',
    '../../judgment/src/batteries/battery.ts', '../../judgment/src/batteries/asking.ts',
    '../../judgment/src/patterns/select.ts', '../../judgment/src/readings/readings.ts',
    '../../judgment/src/readings/bands.ts', '../../judgment/src/port/answers.ts',
    '../../judgment/src/port/config.ts',
  ];
  return files.map(path => [path, sha256(readFileSync(resolve(import.meta.dir, path), 'utf8'))] as const);
}
export function staticDecisionSourceHash(): string {
  return sha256(JSON.stringify(staticDecisionSourceManifest()));
}

/** Structural windows retain every offered line or AST anchor and context on both sides. */
export function captureStaticInputs(kind: StaticRule, path: string, text: string, offered?: readonly SourceAnchor[]): StaticSourceInput[] {
  const lines = text.split('\n');
  const anchors = offered ?? (kind === 'internal-identifier' ? internalSourceAnchors(path, text)
    : lines.flatMap((line, index) => line.trim().length === 0 ? [] : [{ id: `line_${index + 1}`, line: index + 1, col: 1, text: line }]));
  if (anchors.length === 0) return [];
  const structuredContext = structuredSourceContext(path, text);
  const sourceHash = sha256(text);
  const lineOffsets = [0];
  for (const line of lines) lineOffsets.push(lineOffsets.at(-1)! + line.length + 1);
  const groups: SourceAnchor[][] = [];
  let group: SourceAnchor[] = [];
  let chars = 0;
  for (const anchor of anchors) {
    const span = group.length === 0 ? 0 : lineOffsets[anchor.line - 1]! - lineOffsets[group[0]!.line - 1]! + anchor.text.length;
    if (group.length >= 180 || (group.length > 0 && (chars + anchor.text.length > 24_000 || span > 24_000))) {
      groups.push(group); group = []; chars = 0;
    }
    group.push(anchor); chars += anchor.text.length;
  }
  if (group.length) groups.push(group);
  const window = (current: readonly SourceAnchor[]): StaticSourceInput => {
    const firstLine = current[0]!.line;
    const lastLine = Math.max(...current.map(anchor => anchor.line + anchor.text.split('\n').length - 1));
    const start = Math.max(1, firstLine - 20);
    const end = Math.min(lines.length, lastLine + 20);
    const declarations = structuredContext.declarations.filter(range => (range.firstLine < start || range.lastLine > end)
      && current.some(anchor => anchor.line >= range.firstLine && anchor.line <= range.lastLine));
    const ranges = [{ firstLine: start, lastLine: end }, ...declarations,
      ...(declarations.length ? structuredContext.module : []),
      ...(path.endsWith('.md') ? markdownSourceContext(text, current) : [])]
      .sort((a, b) => a.firstLine - b.firstLine || a.lastLine - b.lastLine);
    const merged: { firstLine: number; lastLine: number }[] = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.firstLine <= previous.lastLine + 1) previous.lastLine = Math.max(previous.lastLine, range.lastLine);
      else merged.push({ ...range });
    }
    return { kind, path: path.split('\\').join('/'), sourceHash, firstLine, lastLine,
      source: merged.flatMap(range => lines.slice(range.firstLine - 1, range.lastLine)
        .map((line, index) => `${range.firstLine + index}| ${line}`)).join('\n'), anchors: current };
  };
  const bounded = (current: readonly SourceAnchor[]): StaticSourceInput[] => {
    const input = window(current);
    try {
      validateContextBudget(staticInputState(input), { violation: batteryFor(kind).items.violation.question });
      validateContextBudget({ context: staticSelectionContext(input), candidates: staticSelectionCandidates(input) }, selectionQuestions(input));
      if (current.length === 1) validateContextBudget({ context: staticSelectionContext(input), candidates: staticSelectionCandidates(input) }, selectionQuestions(input, true));
      return [input];
    } catch (error) {
      if (!(error instanceof JudgmentError) || error.kind !== 'invalid-request') throw error;
      if (current.length === 1) throw new Error(`${kind} ${path}:${input.firstLine}: complete source unit and context exceed the canonical request budget`, { cause: error });
      const middle = Math.ceil(current.length / 2);
      return [...bounded(current.slice(0, middle)), ...bounded(current.slice(middle))];
    }
  };
  return groups.flatMap(bounded);
}

export function staticInputState(input: StaticSourceInput): EntryType {
  return { path: input.path, source: input.source, anchors: input.anchors.map(anchor => ({ ...anchor })) };
}
export function staticInputKey(input: StaticSourceInput): string {
  return sha256(canonicalJson(toJson(input)));
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const ownValue = (values: Readonly<Record<string, unknown>> | undefined, key: string): unknown =>
  values && Object.hasOwn(values, key) ? values[key] : undefined;

/** Publish current active evidence; the separate checkpoint and journal retain history. */
export function projectCurrentStaticSourceReadings(inputs: readonly StaticSourceInput[], readings: StaticSourceReadings): StaticSourceReadings {
  const references = new Set([readings.decisionSourceHash]);
  const active = (value: unknown): unknown => {
    if (!object(value)) return value;
    const retained = { ...value };
    delete retained.previousCaptures;
    for (const key of ['decisionSourceHash', 'validatedDecisionSourceHash']) {
      if (Object.hasOwn(value, key) && typeof value[key] === 'string') references.add(value[key]);
    }
    for (const key of ['presence', 'selection']) {
      const evidence = ownValue(value, key);
      if (object(evidence) && Object.hasOwn(evidence, 'captureDecisionSourceHash')
        && typeof evidence.captureDecisionSourceHash === 'string') references.add(evidence.captureDecisionSourceHash);
    }
    if (Object.hasOwn(value, 'parts') && Array.isArray(value.parts)) retained.parts = value.parts.map(active);
    return retained;
  };
  const current = Object.fromEntries(inputs.flatMap(input => {
    const key = staticInputKey(input);
    return Object.hasOwn(readings.readings, key) ? [[key, active(readings.readings[key])] as const] : [];
  }));
  const referenced = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
    Object.fromEntries([...references].filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
  return { ...readings, readings: current,
    ...(readings.captureSources ? { captureSources: referenced(readings.captureSources) } : {}),
    ...(readings.captureBatterySources ? { captureBatterySources: referenced(readings.captureBatterySources) } : {}) };
}

export function parseStaticSourceReadings(value: unknown): StaticSourceReadings | null {
  if (!object(value) || value.format !== 1 || typeof value.decisionSourceHash !== 'string' || !object(value.readings)) return null;
  if (value.readingPlanVersion !== undefined && value.readingPlanVersion !== 1 && value.readingPlanVersion !== 2 && value.readingPlanVersion !== 3) return null;
  if ((value.captureSources !== undefined && !object(value.captureSources))
    || (value.captureBatterySources !== undefined && !object(value.captureBatterySources))) return null;
  return { format: 1, decisionSourceHash: value.decisionSourceHash, readings: value.readings,
    ...(value.readingPlanVersion !== undefined ? { readingPlanVersion: value.readingPlanVersion } : {}),
    ...(object(value.captureSources) ? { captureSources: value.captureSources } : {}),
    ...(object(value.captureBatterySources) ? { captureBatterySources: value.captureBatterySources } : {}) };
}
export function loadStaticSourceReadings(path = STATIC_READINGS_PATH): StaticSourceReadings | null {
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    const text = (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
    return parseStaticSourceReadings(JSON.parse(text));
  }
  catch { return null; }
}
export function saveStaticSourceReadings(readings: StaticSourceReadings, path = STATIC_READINGS_PATH): void {
  const ordered = Object.fromEntries(Object.entries(readings.readings).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify({ ...readings, readings: ordered })}\n`;
  // The standard gzip encoder writes an epoch timestamp, so identical complete
  // receipts produce identical bytes without dropping any capture lineage.
  writeFileSync(`${path}.next`, path.endsWith('.gz') ? gzipSync(text, { level: 9 }) : text);
  renameSync(`${path}.next`, path);
}

function* completeStaticJournalLines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const lines = (pending + decoder.write(buffer.subarray(0, count))).split('\n');
      pending = lines.pop()!;
      yield* lines;
    }
    // An unterminated final record remains audit history, including incomplete UTF-8.
  } finally { closeSync(fd); }
}

/** Replay only complete valid journal records; malformed bytes remain audit history. */
export function loadStaticSourceJournal(path: string, previous: StaticSourceReadings | null): StaticSourceReadings | null {
  if (!existsSync(path)) return previous;
  let decisionSourceHash = previous?.decisionSourceHash;
  let readingPlanVersion = previous?.readingPlanVersion;
  const readings: Record<string, unknown> = { ...previous?.readings };
  const captureSources: Record<string, unknown> = { ...previous?.captureSources };
  const captureBatterySources: Record<string, unknown> = { ...previous?.captureBatterySources };
  for (const line of completeStaticJournalLines(path)) {
    let record: StaticSourceReadings | null;
    try { record = parseStaticSourceReadings(JSON.parse(line)); } catch { continue; }
    if (!record) continue;
    decisionSourceHash = record.decisionSourceHash;
    readingPlanVersion = record.readingPlanVersion;
    Object.defineProperties(readings, Object.getOwnPropertyDescriptors(record.readings));
    Object.defineProperties(captureSources, Object.getOwnPropertyDescriptors(record.captureSources ?? {}));
    Object.defineProperties(captureBatterySources, Object.getOwnPropertyDescriptors(record.captureBatterySources ?? {}));
  }
  return decisionSourceHash === undefined ? null : { format: 1, decisionSourceHash, readings, captureSources, captureBatterySources,
    ...(readingPlanVersion !== undefined ? { readingPlanVersion } : {}) };
}

/** Each answered call reaches durable storage before another dependent call starts. */
export function openStaticSourceJournal(path: string) {
  let incompleteTail = false;
  if (existsSync(path)) {
    const tailFd = openSync(path, 'r');
    try {
      const size = fstatSync(tailFd).size;
      const byte = Buffer.alloc(1);
      incompleteTail = size === 0 || readSync(tailFd, byte, 0, 1, size - 1) !== 1 || byte[0] !== 10;
    } finally { closeSync(tailFd); }
  }
  const fd = openSync(path, 'a');
  const append = (text: string): void => {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written < 1) throw new Error('Static source journal write made no progress');
      offset += written;
    }
    fsyncSync(fd);
  };
  // Preserve a torn record's original bytes while ensuring later replays never
  // mistake its incomplete JSON for an admitted complete journal record.
  if (incompleteTail) append('\tINCOMPLETE_RECORD\n');
  return {
    append(record: StaticSourceReadings, capturedInput?: StaticSourceInput): void {
      append(`${JSON.stringify({ ...record, ...(capturedInput ? { capturedInput } : {}) })}\n`);
    },
    [Symbol.dispose](): void { closeSync(fd); },
  };
}

const batteryFor = (kind: StaticRule) => kind === 'internal-identifier' ? internalIdentifier : deferredWork;
const ruleFor = (kind: StaticRule): string => kind === 'internal-identifier' ? INTERNAL_IDENTIFIER_INSTRUCTIONS : DEFERRED_WORK_INSTRUCTIONS;
export const staticSelectionContext = (input: StaticSourceInput) => ({ rule: ruleFor(input.kind), source: input.source, path: input.path });
export const staticSelectionCandidates = (input: StaticSourceInput) => input.anchors.map(anchor => ({ id: anchor.id, content: { ...anchor } }));

/** These are the canonical selector's public configuration applied to the exact offered identities. */
function selectionQuestions(input: StaticSourceInput, weakSelection = false): Questions {
  const options = { ...Object.fromEntries(input.anchors.map(anchor => [anchor.id, null])), none: 'None of the candidates does what is needed.' };
  return { pick: choice(weakSelection ? STATIC_WEAK_ANCHOR_INSTRUCTIONS : STATIC_ANCHOR_INSTRUCTIONS, options), ...Object.fromEntries(input.anchors.map((anchor, index) => [`fits_${index}`, noul({ question: weakSelection ? STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS : STATIC_ANCHOR_FIT_INSTRUCTIONS, candidate: `\`candidates[${index}]\` (id ${JSON.stringify(anchor.id)})` })])) };
}

export interface StaticCallEvidence {
  readonly id: string;
  readonly at: string;
  readonly battery: string;
  readonly version: number;
  readonly site: string;
  readonly stateHash: string;
  readonly questionsHash: string;
  readonly requestedModel: string;
  readonly observedModel: string;
  readonly requestId: string | null;
  readonly answers: unknown;
  /** Legacy evidence inherits its containing receipt's original capture hash. */
  readonly captureDecisionSourceHash?: string;
}
export interface StaticSourceReceipt {
  readonly readingPlanVersion?: 1 | 2 | 3;
  readonly inputHash: string;
  readonly sourceHash: string;
  readonly decisionSourceHash: string;
  readonly presence: StaticCallEvidence;
  readonly selection: StaticCallEvidence | null;
  readonly parts: readonly StaticSourceReceipt[];
  /** Revalidation does not change the original capture hash or wire evidence. */
  readonly validatedDecisionSourceHash?: string;
  /** Current composition applied to unchanged original plan-2 question answers. */
  readonly validatedReadingPlanVersion?: 3;
  readonly previousCaptures?: readonly unknown[];
}

function evidence(log: DecisionLog, id: string | undefined, captureDecisionSourceHash: string): StaticCallEvidence {
  const entry = id === undefined ? undefined : log.get(id);
  if (entry?.status !== 'answered' || !entry.context.battery || entry.context.batteryVersion === undefined || !entry.context.site) throw new Error('A genuine answered decision-log entry is required');
  return { id: entry.id, at: entry.at, battery: entry.context.battery, version: entry.context.batteryVersion, site: entry.context.site,
    stateHash: entry.stateHash, questionsHash: sha256(canonicalJson(entry.questions)), requestedModel: entry.requestedModel,
    observedModel: entry.model, requestId: entry.requestId ?? null, answers: entry.answers, captureDecisionSourceHash };
}

export interface StaticSourceProgress {
  readonly previous: StaticSourceReadings;
  readonly original?: StaticSourceReadings;
  readonly decisionSourceHash?: string;
  readonly onReceipt: (input: StaticSourceInput, receipt: StaticSourceReceipt) => void;
}

/** Revise an unsettled union through exact subsets, retaining the complete original context. */
export async function readStaticInput(port: JudgmentPort, log: DecisionLog, input: StaticSourceInput, signal?: AbortSignal, progress?: StaticSourceProgress): Promise<StaticSourceReceipt> {
  const sourceHash = progress?.decisionSourceHash ?? staticDecisionSourceHash();
  const read = async (current: StaticSourceInput, inherited?: unknown): Promise<StaticSourceReceipt> => {
    signal?.throwIfAborted();
    if (staticDecisionSourceHash() !== sourceHash) throw new Error('Static decision source changed during reading');
    const prior = progress ? revalidateStaticInput(current, progress.previous)
      ?? revalidateReceipt(current, inherited, progress.previous) : null;
    const original = ownValue(progress?.original?.readings, staticInputKey(current)) ?? ownValue(progress?.previous.readings, staticInputKey(current)) ?? inherited;
    const options = { site: `${STATIC_SITE}.${current.kind}`, ...(signal ? { signal } : {}) };
    let presence = prior && object(prior) ? receiptEvidence(current, prior, false, sourceHash, progress?.previous.captureSources ?? {}, progress?.previous.captureBatterySources ?? {}) : null;
    const reusedPresence = presence !== null;
    let previousCaptures: readonly unknown[] | undefined = object(prior) && Array.isArray(prior.previousCaptures) ? prior.previousCaptures : undefined;
    if (object(original) && original.readingPlanVersion === 2) previousCaptures = [original];
    if (!presence) {
      const run = await batteryFor(current.kind).run(port, staticInputState(current), options);
      run.recordAction(`prepared static source observation:${run.readings.violation.verdict}`);
      presence = evidence(log, run.result.decisionId, sourceHash);
      if (original !== undefined) previousCaptures = [original];
    }
    const answer = object(presence.answers) ? presence.answers.violation : undefined;
    if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) throw new Error('Invalid captured static presence');
    const reading = readYesNo({ type: 'noul', noul: answer.noul }, STAKES_BANDS.high.yesNo);
    let selection = prior && object(prior) ? receiptEvidence(current, prior, true, sourceHash, progress?.previous.captureSources ?? {}, progress?.previous.captureBatterySources ?? {}) : null;
    const parts: StaticSourceReceipt[] = [];
    const receipt = (): StaticSourceReceipt => ({
      ...(object(prior) ? prior : {}), inputHash: staticInputKey(current), sourceHash: current.sourceHash,
      decisionSourceHash: object(prior) && typeof prior.decisionSourceHash === 'string' ? prior.decisionSourceHash : sourceHash,
      readingPlanVersion: STATIC_SOURCE_READING_PLAN_VERSION, presence, selection, parts: [...parts],
      ...(previousCaptures ? { previousCaptures } : {}),
    });
    if (!reusedPresence) progress?.onReceipt(current, receipt());
    if ((reading.verdict === 'yes' && reading.outcome === 'act') || (reading.outcome !== 'act' && current.anchors.length === 1)) {
      if (!selection) {
        if (object(prior) && prior.selection !== null && prior.selection !== undefined) previousCaptures = [original ?? prior];
        const selector = reading.outcome === 'act' ? staticOffendingAnchor : staticWeakAnchor;
        const selected = await selector.select(port, staticSelectionContext(current), staticSelectionCandidates(current), options);
        selected.recordAction('prepared exact offending source anchor; offline gate preserves held outcomes');
        selection = evidence(log, selected.decisionId, sourceHash);
        progress?.onReceipt(current, receipt());
      }
    } else if (reading.outcome !== 'act' && current.anchors.length > 1) {
      const middle = Math.ceil(current.anchors.length / 2);
      for (const [index, anchors] of [current.anchors.slice(0, middle), current.anchors.slice(middle)].entries()) {
        const inheritedPart = object(original) && Array.isArray(original.parts) ? original.parts[index] : undefined;
        parts.push(await read({ ...current, anchors }, inheritedPart));
      }
    }
    const result = receipt();
    progress?.onReceipt(current, result);
    signal?.throwIfAborted();
    if (staticDecisionSourceHash() !== sourceHash) throw new Error('Static decision source changed during reading');
    return result;
  };
  return read(input);
}

export type StaticInputStanding = { readonly kind: 'clear' }
  | { readonly kind: 'violation'; readonly anchor: SourceAnchor }
  | { readonly kind: 'held'; readonly reason: string };

/** Capture completeness and gate admission share the full canonical answer boundary. */
function selectionAnswer(value: unknown, input: StaticSourceInput) {
  if (!object(value)) return null;
  const pick = value.pick;
  if (!object(pick) || pick.type !== 'choice' || typeof pick.choice !== 'string' || !probability(pick.confidence) || !object(pick.probabilities)) return null;
  const fits: number[] = [];
  for (let index = 0; index < input.anchors.length; index++) {
    const fit = value[`fits_${index}`];
    if (!object(fit) || fit.type !== 'noul' || !probability(fit.noul)) return null;
    fits.push(fit.noul);
  }
  const expectedKeys = [...input.anchors.map(anchor => anchor.id), 'none'];
  if (Object.keys(pick.probabilities).length !== expectedKeys.length) return null;
  const probabilities: Record<string, number> = {};
  for (const key of expectedKeys) {
    const value = pick.probabilities[key];
    if (!probability(value)) return null;
    probabilities[key] = value;
  }
  try {
    return { choice: readChoice({ type: 'choice', choice: pick.choice, confidence: pick.confidence, probabilities }, STAKES_BANDS.high.confidence), fits };
  } catch { return null; }
}

function currentEvidence(value: unknown, input: StaticSourceInput, selection: boolean, weakSelection = false): StaticCallEvidence | null {
  if (!object(value) || !nonempty(value.id) || !nonempty(value.at) || !Number.isFinite(Date.parse(value.at))
    || value.requestedModel !== PINNED_MODEL || value.observedModel !== PINNED_MODEL
    || !(value.requestId === null || nonempty(value.requestId)) || !object(value.answers)
    || (value.captureDecisionSourceHash !== undefined && !nonempty(value.captureDecisionSourceHash))) return null;
  const decision = selection ? (weakSelection ? staticWeakAnchor : staticOffendingAnchor) : batteryFor(input.kind);
  const state = selection ? { context: staticSelectionContext(input), candidates: staticSelectionCandidates(input) } : staticInputState(input);
  const questions = selection ? selectionQuestions(input, weakSelection) : { violation: batteryFor(input.kind).items.violation.question };
  if (value.battery !== decision.name || value.version !== decision.version || value.site !== `${STATIC_SITE}.${input.kind}`
    || value.stateHash !== hashState(state) || value.questionsHash !== sha256(canonicalJson(toJson(questions)))) return null;
  if (selection && selectionAnswer(value.answers, input) === null) return null;
  return { id: value.id, at: value.at, battery: decision.name, version: decision.version, site: `${STATIC_SITE}.${input.kind}`,
    stateHash: hashState(state), questionsHash: sha256(canonicalJson(toJson(questions))), requestedModel: PINNED_MODEL,
    observedModel: PINNED_MODEL, requestId: value.requestId, answers: value.answers,
    ...(typeof value.captureDecisionSourceHash === 'string' ? { captureDecisionSourceHash: value.captureDecisionSourceHash } : {}) };
}

/** Recompute outcomes from unrounded raw answers; stale or malformed evidence cannot pass. */
export function staticInputStanding(input: StaticSourceInput, readings: StaticSourceReadings | null): StaticInputStanding {
  const held = (reason: string): StaticInputStanding => ({ kind: 'held', reason });
  const sourceHash = staticDecisionSourceHash();
  if (!readings || readings.decisionSourceHash !== sourceHash) return held('missing or stale decision source');
  const receipt = ownValue(readings.readings, staticInputKey(input));
  return receiptStanding(input, receipt, sourceHash, readings.captureSources ?? {}, readings.captureBatterySources ?? {});
}

/** A changed extractor may reuse the same exact request only under the same canonical reading policy. */
function capturePolicyMatches(captureHash: unknown, kind: StaticRule, manifests: Readonly<Record<string, unknown>>, batterySources: Readonly<Record<string, unknown>>): boolean {
  if (typeof captureHash !== 'string') return false;
  const manifest = ownValue(manifests, captureHash);
  if (!Array.isArray(manifest) || manifest.some(entry => !Array.isArray(entry) || entry.length !== 2
    || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') || sha256(JSON.stringify(manifest)) !== captureHash) return false;
  const current = staticDecisionSourceManifest();
  const captured = new Map<string, string>();
  for (const entry of manifest) {
    if (captured.has(entry[0])) return false;
    captured.set(entry[0], entry[1]);
  }
  // Questions, model and battery version are independently matched to the exact wire request.
  // Canonical decoding, distribution admission and threshold configuration must be unchanged.
  if (!current.every(([path, hash]) => !path.startsWith('../../judgment/') || captured.get(path) === hash)) return false;
  const currentBatterySource = readFileSync(resolve(import.meta.dir, 'batteries/static-source.ts'), 'utf8');
  if (captured.get('batteries/static-source.ts') === sha256(currentBatterySource)) return true;
  if (kind !== 'deferred-work') return false;
  const capturedBatterySource = ownValue(batterySources, captureHash);
  if (typeof capturedBatterySource !== 'string' || sha256(capturedBatterySource) !== captured.get('batteries/static-source.ts')) return false;
  const previousPolicy = deferredBatteryPolicyStatements(capturedBatterySource);
  const currentPolicy = deferredBatteryPolicyStatements(currentBatterySource);
  return previousPolicy !== null && currentPolicy !== null && JSON.stringify(previousPolicy) === JSON.stringify(currentPolicy);
}

/** Produce explicit revalidation provenance, retaining original captures and any held observations. */
export function revalidateStaticInput(input: StaticSourceInput, readings: StaticSourceReadings | null): unknown | null {
  return revalidateReceipt(input, ownValue(readings?.readings, staticInputKey(input)), readings);
}

function revalidateReceipt(input: StaticSourceInput, receipt: unknown, readings: StaticSourceReadings | null): unknown | null {
  if (!readings) return null;
  const sourceHash = staticDecisionSourceHash();
  const clone = (partInput: StaticSourceInput, value: unknown): unknown => {
    if (!object(value)) return value;
    const middle = Math.ceil(partInput.anchors.length / 2);
    const subsets = [partInput.anchors.slice(0, middle), partInput.anchors.slice(middle)];
    const parts = Array.isArray(value.parts) ? value.parts.map((part, index) => {
      const anchors = subsets[index];
      return anchors ? clone({ ...partInput, anchors }, part) : part;
    }) : value.parts;
    return { ...value, parts, validatedDecisionSourceHash: sourceHash, validatedReadingPlanVersion: STATIC_SOURCE_READING_PLAN_VERSION };
  };
  const value = clone(input, receipt);
  const manifests = readings.captureSources ?? {};
  if (!object(value) || value.inputHash !== staticInputKey(input) || value.sourceHash !== input.sourceHash
    || (value.decisionSourceHash !== sourceHash && !capturePolicyMatches(value.decisionSourceHash, input.kind, manifests, readings.captureBatterySources ?? {}))) return null;
  const presence = receiptEvidence(input, value, false, sourceHash, manifests, readings.captureBatterySources ?? {});
  const answer = object(presence?.answers) ? presence.answers.violation : undefined;
  if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) return null;
  // A valid unknown is reusable evidence too. Retaining it prevents an
  // incremental preparation pass from resampling unchanged input until green.
  return value;
}

function receiptEvidence(input: StaticSourceInput, receipt: Record<string, unknown>, selection: boolean, sourceHash: string,
  manifests: Readonly<Record<string, unknown>>, batterySources: Readonly<Record<string, unknown>>): StaticCallEvidence | null {
  if (receipt.readingPlanVersion !== undefined && receipt.readingPlanVersion !== 1 && receipt.readingPlanVersion !== 2 && receipt.readingPlanVersion !== 3) return null;
  if (receipt.decisionSourceHash !== sourceHash && (receipt.validatedDecisionSourceHash !== sourceHash
    || !capturePolicyMatches(receipt.decisionSourceHash, input.kind, manifests, batterySources))) return null;
  const presenceAnswer = object(receipt.presence) && object(receipt.presence.answers) ? receipt.presence.answers.violation : undefined;
  const weakSelection = selection && input.anchors.length === 1 && object(presenceAnswer) && presenceAnswer.type === 'noul'
    && probability(presenceAnswer.noul) && readYesNo({ type: 'noul', noul: presenceAnswer.noul }, STAKES_BANDS.high.yesNo).outcome !== 'act';
  if (weakSelection && receipt.readingPlanVersion !== STATIC_SOURCE_READING_PLAN_VERSION
    && !(receipt.readingPlanVersion === 2 && receipt.validatedReadingPlanVersion === STATIC_SOURCE_READING_PLAN_VERSION
      && receipt.validatedDecisionSourceHash === sourceHash)) return null;
  const value = currentEvidence(selection ? receipt.selection : receipt.presence, input, selection, weakSelection);
  if (!value) return null;
  if (value.captureDecisionSourceHash !== undefined && value.captureDecisionSourceHash !== sourceHash
    && !capturePolicyMatches(value.captureDecisionSourceHash, input.kind, manifests, batterySources)) return null;
  if (weakSelection) {
    // This decision did not exist in older manifests. Its genuine per-call
    // capture must bind the exact new battery, even when presence is retained.
    const captureHash = value.captureDecisionSourceHash;
    if (!captureHash) return null;
    if (captureHash !== sourceHash) {
      const manifest = ownValue(manifests, captureHash);
      const batteryHash = sha256(readFileSync(resolve(import.meta.dir, 'batteries/static-weak-anchor.ts'), 'utf8'));
      if (!Array.isArray(manifest) || !manifest.some(entry => Array.isArray(entry)
        && entry[0] === 'batteries/static-weak-anchor.ts' && entry[1] === batteryHash)) return null;
    }
  }
  return value;
}

/** Complete capture means every planned call exists, including genuinely held answers. */
export function staticInputCaptureComplete(input: StaticSourceInput, readings: StaticSourceReadings): boolean {
  const receipt = revalidateStaticInput(input, readings);
  const sourceHash = staticDecisionSourceHash();
  const complete = (current: StaticSourceInput, value: unknown): boolean => {
    if (!object(value) || value.inputHash !== staticInputKey(current) || value.sourceHash !== current.sourceHash) return false;
    const presence = receiptEvidence(current, value, false, sourceHash, readings.captureSources ?? {}, readings.captureBatterySources ?? {});
    const answer = object(presence?.answers) ? presence.answers.violation : undefined;
    if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) return false;
    const reading = readYesNo({ type: 'noul', noul: answer.noul }, STAKES_BANDS.high.yesNo);
    if (reading.outcome === 'act') return reading.verdict === 'no'
      || receiptEvidence(current, value, true, sourceHash, readings.captureSources ?? {}, readings.captureBatterySources ?? {}) !== null;
    if (current.anchors.length < 2) return receiptEvidence(current, value, true, sourceHash, readings.captureSources ?? {}, readings.captureBatterySources ?? {}) !== null;
    if (!Array.isArray(value.parts) || value.parts.length !== 2) return false;
    const parts = value.parts;
    const middle = Math.ceil(current.anchors.length / 2);
    return [current.anchors.slice(0, middle), current.anchors.slice(middle)]
      .every((anchors, index) => complete({ ...current, anchors }, parts[index]));
  };
  return complete(input, receipt);
}

function receiptStanding(input: StaticSourceInput, receipt: unknown, sourceHash: string, manifests: Readonly<Record<string, unknown>>, batterySources: Readonly<Record<string, unknown>>): StaticInputStanding {
  const held = (reason: string): StaticInputStanding => ({ kind: 'held', reason });
  if (!object(receipt) || receipt.inputHash !== staticInputKey(input) || receipt.sourceHash !== input.sourceHash) return held('missing or stale complete input');
  if (receipt.decisionSourceHash !== sourceHash && (receipt.validatedDecisionSourceHash !== sourceHash
    || !capturePolicyMatches(receipt.decisionSourceHash, input.kind, manifests, batterySources))) return held('stale capture without current policy revalidation');
  const presence = receiptEvidence(input, receipt, false, sourceHash, manifests, batterySources);
  const answer = object(presence?.answers) ? presence.answers.violation : undefined;
  if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) return held('invalid or mismatched presence evidence');
  const reading = readYesNo({ type: 'noul', noul: answer.noul }, STAKES_BANDS.high.yesNo);
  const weakSelection = reading.outcome !== 'act' && input.anchors.length === 1;
  if (reading.outcome !== 'act' && !weakSelection) {
    const parts = receipt.parts;
    if (input.anchors.length < 2 || !Array.isArray(parts) || parts.length !== 2) return held('unsettled presence observation');
    const middle = Math.ceil(input.anchors.length / 2);
    const subsets = [input.anchors.slice(0, middle), input.anchors.slice(middle)];
    const standings = subsets.map((anchors, index) => receiptStanding({ ...input, anchors }, parts[index], sourceHash, manifests, batterySources));
    const violation = standings.find(standing => standing.kind === 'violation');
    if (violation) return violation;
    if (standings.every(standing => standing.kind === 'clear')) return { kind: 'clear' };
    return held('unsettled or incomplete exact subset observations');
  }
  if (reading.verdict === 'no' && reading.outcome === 'act') return { kind: 'clear' };
  const selectedEvidence = receiptEvidence(input, receipt, true, sourceHash, manifests, batterySources);
  const selected = selectionAnswer(selectedEvidence?.answers, input);
  if (!selected) return held('missing or invalid exact anchor evidence');
  const chosen = selected.choice;
  if (weakSelection && selected.fits.every(fit => {
    const fitting = readYesNo({ type: 'noul', noul: fit }, STAKES_BANDS.high.yesNo);
    return fitting.verdict === 'no' && fitting.outcome === 'act';
  })) {
    return chosen.outcome === 'act' && chosen.choice !== 'none'
      ? held('settled offending identity contradicts negative candidate fits') : { kind: 'clear' };
  }
  if (weakSelection && chosen.choice === 'none' && chosen.outcome === 'act') {
    const allNo = selected.fits.every(fit => {
      const fitting = readYesNo({ type: 'noul', noul: fit }, STAKES_BANDS.high.yesNo);
      return fitting.verdict === 'no' && fitting.outcome === 'act';
    });
    return allNo ? { kind: 'clear' } : held('none selection has unsettled or contradictory candidate fits');
  }
  const index = input.anchors.findIndex(anchor => anchor.id === chosen.choice);
  const fit = selected.fits[index];
  if (chosen.outcome !== 'act' || index < 0 || fit === undefined) return held('unsettled or absent offending anchor');
  const fitting = readYesNo({ type: 'noul', noul: fit }, STAKES_BANDS.high.yesNo);
  if (fitting.verdict !== 'yes' || fitting.outcome !== 'act') return held('unsettled offending-anchor fit');
  return { kind: 'violation', anchor: input.anchors[index]! };
}
