import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureCatalogPath, rankResearchRecords } from './agent-harness-research-catalog-source.ts';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
const nativeApply = Reflect.apply, nativeIsPromise = nodeTypes.isPromise;

import { previewHarnessText } from './agent-harness-text.ts';

export interface ResearchLiveRecordCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly cursor?: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface ResearchBrowserRunnerRecord {
  readonly id: string;
  readonly runId: string | null;
  readonly status: string;
  readonly phase: string | null;
  readonly progress: number | null;
  readonly question: string | null;
  readonly currentUrl: string | null;
  readonly sourceReceiptIds: readonly string[];
  readonly reportDraftId: string | null;
  readonly reportArtifactId: string | null;
  readonly logTail: readonly string[];
  readonly controlRoutes: Readonly<Record<string, string>>;
  readonly modelRoute: string;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly certification: ResearchLiveRecordCertification;
}

export interface ResearchVisualReportRecord {
  readonly id: string;
  readonly reportArtifactId: string | null;
  readonly status: string;
  readonly renderRoute: string;
  readonly renderUrl: string | null;
  readonly sections: readonly string[];
  readonly sourceMapCount: number;
  readonly citationCoverage: string | null;
  readonly modelRoute: string;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly certification: ResearchLiveRecordCertification;
}

export interface ResearchLiveReadModelSnapshot {
  readonly browserRunnerRecords: readonly ResearchBrowserRunnerRecord[];
  readonly visualReportRecords: readonly ResearchVisualReportRecord[];
  readonly sourceCounts: Readonly<Record<string, number>>;
}

interface SourceCandidate {
  readonly path: string;
  readonly source: unknown;
  readonly kind: 'daemon-read-model' | 'sdk-read-model';
}

interface CollectedRecord {
  readonly path: string;
  readonly kind: 'daemon-read-model' | 'sdk-read-model';
  readonly record: Record<string, unknown>;
}

const RUNNER_WRAPPER_KEYS = [
  'records',
  'items',
  'runs',
  'researchRuns',
  'browserRuns',
  'browserRunnerRuns',
  'runnerRecords',
  'pageReceipts',
  'sourceReceipts',
] as const;

const VISUAL_WRAPPER_KEYS = [
  'records',
  'items',
  'reports',
  'visualReports',
  'reportSurfaces',
  'reportViews',
  'renderedReports',
  'visualReportPackets',
] as const;

const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'toJSON'] as const;
const RUNNER_METHODS = ['listBrowserRuns', 'listResearchRuns', 'listRuns', 'listSourceReceipts', 'list'] as const;
const VISUAL_METHODS = ['listVisualReports', 'listReportSurfaces', 'listReports', 'listRenderedReports', 'list'] as const;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function readMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return readObject(record.metadata);
}

function nestedString(record: Record<string, unknown>, key: string): string {
  return readString(record[key])
    || readString(readMetadata(record)[key])
    || readString(readObject(record.run)[key])
    || readString(readObject(record.runner)[key])
    || readString(readObject(record.browser)[key])
    || readString(readObject(record.report)[key])
    || readString(readObject(record.visualReport)[key])
    || readString(readObject(record.render)[key])
    || readString(readObject(record.evidence)[key]);
}

function certificationRecords(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [
    record,
    readMetadata(record),
    readObject(record.schema),
    readObject(record.contract),
    readObject(record.publication),
    readObject(record.receipt),
    readObject(record.certification),
  ];
}

function firstAcross(records: readonly Record<string, unknown>[], keys: readonly string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return '';
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 12);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 12) : [];
}

function objectArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(readObject).filter((entry) => Object.keys(entry).length > 0) : [];
}

function redactText(value: string): string {
  return value
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^,\s;/]+/gi, '$1=<redacted>');
}

function safePreview(value: string, limit: number): string {
  return previewHarnessText(redactText(value), limit);
}

function safeNullablePreview(value: string, limit: number): string | null {
  return value ? safePreview(value, limit) : null;
}

function safeUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|authorization|credential|api[-_]?key/i.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return previewHarnessText(url.toString(), 180);
  } catch {
    return safeNullablePreview(value, 180);
  }
}

async function schemaStatus(records: readonly Record<string, unknown>[], options: CatalogRankingOptions): Promise<ResearchLiveRecordCertification['schemaStatus']> {
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']);
  const presence = !!firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
    && !!firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'researchPublicationGuarantee'])
    && !!firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  if (!explicit) return presence ? 'certified' : 'legacy';
  const matches = await rankResearchRecords([{ records, explicit }], 'Explicit schema certification',
    entry => ({ id: 'schema', description: 'Explicit schema certification claim', evidence: entry }), options,
    'agent.research.schema-status', 'engine.tools.research-schema-status');
  // Preserve the original native metadata alternative; the prose reading
  // neither authenticates these fields nor grants any effect authority.
  return matches.length > 0 || presence ? 'certified' : 'legacy';
}

function certification(input: {
  readonly record: Record<string, unknown>;
  readonly sourcePath: string;
  readonly kind: 'browser-backed research run' | 'visual report render';
  readonly durableId: string;
  readonly status: string;
  readonly modelRoute: string;
  readonly hasVisibleControls?: boolean;
  readonly hasSourceReceipts?: boolean;
  readonly hasBoundedLogs?: boolean;
  readonly hasRenderRoute?: boolean;
  readonly hasSourceMap?: boolean;
  readonly hasReportEvidence?: boolean;
  readonly hasVisualSections?: boolean;
}, currentSchemaStatus: ResearchLiveRecordCertification['schemaStatus']): ResearchLiveRecordCertification {
  const records = certificationRecords(input.record);
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'researchPublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const receiptId = firstAcross(records, ['receiptId', 'runReceiptId', 'sourceReceiptId', 'renderReceiptId', 'reportRenderReceiptId']);
  const cursor = firstAcross(records, ['cursor', 'freshnessCursor', 'sequence', 'checkpoint']);
  const provenance = [...new Set([
    ...stringArray(input.record.provenance),
    input.sourcePath ? `source ${input.sourcePath}` : '',
    firstAcross(records, ['methodId']) ? `method ${firstAcross(records, ['methodId'])}` : '',
    firstAcross(records, ['sourceTool']) ? `sourceTool ${firstAcross(records, ['sourceTool'])}` : '',
  ].map((entry) => safePreview(entry, 180)).filter(Boolean))].slice(0, 8);
  const missingSignals = [
    ...(currentSchemaStatus === 'certified' ? [] : [`Certified ${input.kind} schema is not published.`]),
    ...(input.durableId ? [] : [`Durable ${input.kind} id is not published.`]),
    ...(input.status ? [] : [`${input.kind} status is not published.`]),
    ...(publicationGuarantee ? [] : [`${input.kind} publication guarantee is not published.`]),
    ...(publisher ? [] : [`${input.kind} publisher is not published.`]),
    ...(provenance.length > 0 ? [] : [`${input.kind} provenance is not published.`]),
    ...(cursor ? [] : [`${input.kind} freshness cursor is not published.`]),
    ...(input.modelRoute ? [] : [`${input.kind} inspect route is not published.`]),
    ...(input.hasVisibleControls === false ? ['Browser-backed research visible checkpoint/pause/resume/cancel controls are not published.'] : []),
    ...(input.hasSourceReceipts === false ? ['Browser-backed research source/page receipt ids are not published.'] : []),
    ...(input.hasBoundedLogs === false ? ['Browser-backed research bounded redacted log descriptors are not published.'] : []),
    ...(input.hasRenderRoute === false ? ['Visual report renderer inspect/open route is not published.'] : []),
    ...(input.hasSourceMap === false ? ['Visual report source map or citation coverage is not published.'] : []),
    ...(input.hasReportEvidence === false ? ['Visual report artifact/render evidence id is not published.'] : []),
    ...(input.hasVisualSections === false ? ['Visual report packet sections are not published.'] : []),
  ];
  return {
    schemaStatus: currentSchemaStatus,
    ...(schemaVersion ? { schemaVersion: safePreview(schemaVersion, 80) } : {}),
    ...(publicationGuarantee ? { publicationGuarantee: safePreview(publicationGuarantee, 220) } : {}),
    ...(publisher ? { publisher: safePreview(publisher, 80) } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(receiptId ? { receiptId: safePreview(receiptId, 96) } : {}),
    ...(cursor ? { cursor: safePreview(cursor, 96) } : {}),
    missingSignals,
    policy: 'Research live read models certify release readiness only when the SDK or daemon publishes schema, durable ids, publication guarantee, publisher/provenance, freshness cursor, exact inspect route, redacted source/render evidence, and user-visible controls without exposing page secrets.',
  };
}



async function collectFromSource(source: unknown, path: string, kind: SourceCandidate['kind'], wrapperKeys: readonly string[],
  methods: readonly string[], guards: (() => void)[], envelopes: unknown[], assertCurrent: () => void, visited = new WeakSet<object>()): Promise<readonly CollectedRecord[]> {
  assertCurrent();
  if (source == null || typeof source !== 'object') return [];
  if (nodeTypes.isProxy(source)) throw new ToolInputProjectionError('held');
  if (visited.has(source)) return [];
  visited.add(source);
  if (Array.isArray(source)) {
    const snapshot = captureCatalogSnapshot(source); envelopes.push(snapshot.captured); guards.push(() => snapshot.assertCurrent(source));
    const output: CollectedRecord[] = [];
    for (let index = 0; index < source.length; index++) output.push(...await collectFromSource(source[index], `${path}[${index}]`, kind, wrapperKeys, methods, guards, envelopes, assertCurrent, visited));
    assertCurrent(); return output;
  }
  if (source instanceof Map) {
    if (Reflect.ownKeys(source).length !== 0) throw new ToolInputProjectionError('held');
    const assertMethods = captureCatalogMethods(source, ['entries']); assertMethods();
    const originalEntries = source.entries, entries = [...originalEntries.call(source)];
    if (entries.some(([key]) => typeof key !== 'string' && typeof key !== 'number')) throw new ToolInputProjectionError('held');
    const snapshot = captureCatalogSnapshot(entries); envelopes.push(snapshot.captured);
    guards.push(() => { if (Reflect.ownKeys(source).length !== 0) throw new ToolInputProjectionError('held'); assertMethods(); snapshot.assertCurrent([...originalEntries.call(source)]); });
    const output: CollectedRecord[] = [];
    for (const [key, value] of entries) output.push(...await collectFromSource(value, `${path}.${String(key)}`, kind, wrapperKeys, methods, guards, envelopes, assertCurrent, visited));
    assertCurrent(); return output;
  }
  const keys = [...SNAPSHOT_METHODS, ...methods, ...wrapperKeys];
  const assertMethods = captureCatalogMethods(source, keys); assertMethods(); guards.push(assertMethods);
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.some(key => typeof key !== 'string')) throw new ToolInputProjectionError('held');
  const ownerKeys = ownKeys.filter((key): key is string => typeof key === 'string');
  const assertOwnSlots = captureCatalogMethods(source, ownerKeys);
  const ownData = (): Record<string, unknown> => {
    const currentKeys = Reflect.ownKeys(source);
    if (currentKeys.length !== ownKeys.length || currentKeys.some((key, index) => key !== ownKeys[index])) throw new ToolInputProjectionError('held');
    assertOwnSlots();
    const data: Record<string, unknown> = Object.create(null);
    for (const key of ownerKeys) {
      const value = modelReadingServicePath(source, [key]);
      if (typeof value !== 'function') Object.defineProperty(data, key, { value, enumerable: true, configurable: false, writable: false });
    }
    return data;
  };
  const backendData = captureCatalogSnapshot(ownData()); envelopes.push(backendData.captured);
  guards.push(() => backendData.assertCurrent(ownData()));
  const output: CollectedRecord[] = [];
  for (const method of [...SNAPSHOT_METHODS, ...methods]) {
    const original = modelReadingServicePath(source, [method]);
    if (original === undefined) continue;
    if (typeof original !== 'function') continue;
    if (nodeTypes.isProxy(original)) throw new ToolInputProjectionError('held');
    assertCurrent();
    let raw: unknown;
    try { const value: unknown = nativeApply(original, source, []); raw = nativeIsPromise(value) ? await value : value; } catch { assertCurrent(); throw new ToolInputProjectionError('held'); }
    assertCurrent();
    if (raw !== undefined) output.push(...await collectFromSource(raw, `${path}.${method}()`, kind, wrapperKeys, methods, guards, envelopes, assertCurrent, visited));
  }
  for (const key of wrapperKeys) {
    const value = modelReadingServicePath(source, [key]);
    if (value !== undefined) output.push(...await collectFromSource(value, `${path}.${key}`, kind, wrapperKeys, methods, guards, envelopes, assertCurrent, visited));
  }
  if (output.length > 0) { assertCurrent(); return output; }
  // Empty native snapshots retain the original envelope as a legacy record.
  // Native methods stay descriptor-bound; only complete original data is read.
  const record = backendData.captured;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new ToolInputProjectionError('held');
  return [{ path, kind, record: readObject(record) }];
}

function sourceReceiptIds(record: Record<string, unknown>): readonly string[] {
  const receiptObjects = [
    ...objectArray(record.sourceReceipts),
    ...objectArray(record.pageReceipts),
    ...objectArray(readObject(record.evidence).sourceReceipts),
  ];
  return [...new Set([
    ...stringArray(record.sourceReceiptIds),
    ...stringArray(record.pageReceiptIds),
    ...stringArray(readObject(record.evidence).sourceReceiptIds),
    ...receiptObjects.map((entry) => readString(entry.receiptId) || readString(entry.id) || readString(entry.sourceReceiptId)),
  ].map((entry) => safePreview(entry, 96)).filter(Boolean))].slice(0, 12);
}

function routeMap(record: Record<string, unknown>): Readonly<Record<string, string>> {
  const routes = { ...readObject(record.routes), ...readObject(record.controls) };
  const output: Record<string, string> = {};
  for (const key of ['inspect', 'checkpoint', 'pause', 'resume', 'cancel', 'report', 'saveReport', 'open', 'view']) {
    const value = readString(routes[key]) || nestedString(record, `${key}Route`);
    if (value) output[key] = safePreview(value, 180);
  }
  return output;
}

function modelRoute(record: Record<string, unknown>, fallback: string): string {
  return nestedString(record, 'modelRoute')
    || nestedString(record, 'inspectRoute')
    || nestedString(record, 'reviewRoute')
    || nestedString(record, 'openRoute')
    || fallback;
}

function normalizeRunner(entry: CollectedRecord, index: number, currentSchemaStatus: ResearchLiveRecordCertification['schemaStatus']): ResearchBrowserRunnerRecord | null {
  const runId = nestedString(entry.record, 'runId') || nestedString(entry.record, 'researchRunId');
  const question = nestedString(entry.record, 'question') || nestedString(entry.record, 'task') || nestedString(entry.record, 'title');
  const status = nestedString(entry.record, 'status') || nestedString(entry.record, 'state') || 'unknown';
  const id = nestedString(entry.record, 'id') || nestedString(entry.record, 'receiptId') || (runId ? `research-runner:${runId}` : `research-runner:${index}`);
  const routes = routeMap(entry.record);
  const receipts = sourceReceiptIds(entry.record);
  const logs = [
    ...stringArray(entry.record.logTail),
    ...stringArray(entry.record.boundedLogs),
    ...stringArray(entry.record.outputChunks),
  ].map((line) => safePreview(line, 180)).slice(0, 5);
  const route = modelRoute(entry.record, runId ? `research action:"runner" runId:"${runId}" includeParameters:true` : 'research action:"runner" includeParameters:true');
  return {
    id,
    runId: runId || null,
    status,
    phase: safeNullablePreview(nestedString(entry.record, 'phase'), 80),
    progress: readNumber(entry.record.progress ?? readObject(entry.record.run).progress),
    question: safeNullablePreview(question, 180),
    currentUrl: safeUrl(nestedString(entry.record, 'currentUrl') || nestedString(entry.record, 'url')),
    sourceReceiptIds: receipts,
    reportDraftId: safeNullablePreview(nestedString(entry.record, 'reportDraftId'), 96),
    reportArtifactId: safeNullablePreview(nestedString(entry.record, 'reportArtifactId'), 96),
    logTail: logs,
    controlRoutes: routes,
    modelRoute: route,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      kind: 'browser-backed research run',
      durableId: id,
      status,
      modelRoute: route,
      hasVisibleControls: ['checkpoint', 'pause', 'resume', 'cancel'].some((key) => Boolean(routes[key])),
      hasSourceReceipts: receipts.length > 0,
      hasBoundedLogs: logs.length > 0 || Boolean(nestedString(entry.record, 'boundedLogDescriptor') || nestedString(entry.record, 'redaction')),
    }, currentSchemaStatus),
  };
}

function visualSections(record: Record<string, unknown>): readonly string[] {
  return [...new Set([
    ...stringArray(record.sections),
    ...stringArray(readObject(record.visualReport).sections),
    ...objectArray(record.packetSections).map((entry) => readString(entry.id) || readString(entry.title)),
  ].map((entry) => safePreview(entry, 80)).filter(Boolean))].slice(0, 16);
}

function sourceMapCount(record: Record<string, unknown>): number {
  const explicit = readNumber(record.sourceMapCount ?? readObject(record.visualReport).sourceMapCount);
  if (explicit !== null) return Math.max(0, Math.trunc(explicit));
  const arrays: readonly unknown[] = [record.sourceMap, record.sourceIds, record.citations, readObject(record.visualReport).sourceMap];
  return arrays.reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
}

function normalizeVisualReport(entry: CollectedRecord, index: number, currentSchemaStatus: ResearchLiveRecordCertification['schemaStatus']): ResearchVisualReportRecord | null {
  const reportArtifactId = nestedString(entry.record, 'reportArtifactId') || nestedString(entry.record, 'artifactId');
  const status = nestedString(entry.record, 'status') || nestedString(entry.record, 'state') || 'unknown';
  const id = nestedString(entry.record, 'id') || nestedString(entry.record, 'renderReceiptId') || (reportArtifactId ? `visual-report:${reportArtifactId}` : `visual-report:${index}`);
  const route = modelRoute(entry.record, reportArtifactId ? `research action:"report_artifact" artifactId:"${reportArtifactId}"` : 'research action:"reports" includeParameters:true');
  const renderRoute = nestedString(entry.record, 'renderRoute') || nestedString(entry.record, 'openRoute') || route;
  const sections = visualSections(entry.record);
  const mapCount = sourceMapCount(entry.record);
  return {
    id,
    reportArtifactId: safeNullablePreview(reportArtifactId, 96),
    status,
    renderRoute: safePreview(renderRoute, 180),
    renderUrl: safeUrl(nestedString(entry.record, 'renderUrl') || nestedString(entry.record, 'viewUrl')),
    sections,
    sourceMapCount: mapCount,
    citationCoverage: safeNullablePreview(nestedString(entry.record, 'citationCoverage') || nestedString(entry.record, 'coverage'), 120),
    modelRoute: route,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      kind: 'visual report render',
      durableId: id,
      status,
      modelRoute: route,
      hasRenderRoute: Boolean(renderRoute),
      hasSourceMap: mapCount > 0 || Boolean(nestedString(entry.record, 'citationCoverage') || nestedString(entry.record, 'coverage')),
      hasReportEvidence: Boolean(reportArtifactId || nestedString(entry.record, 'renderArtifactId')),
      hasVisualSections: sections.length > 0,
    }, currentSchemaStatus),
  };
}

function dedupeById<T extends { readonly id: string }>(records: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    output.push(record);
  }
  return output;
}

function sourceCounts(entries: readonly CollectedRecord[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.path] = (counts[entry.path] ?? 0) + 1;
  return counts;
}

function runnerSources(context: object, guards: (() => void)[]): readonly SourceCandidate[] {
  const definitions = [
    { path: 'context.platform.readModels.research.browserRuns', keys: ["platform", "readModels", "research", "browserRuns"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.research.browserRunner', keys: ["platform", "readModels", "research", "browserRunner"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.research.runs', keys: ["platform", "readModels", "research", "runs"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.deepResearch.browserRuns', keys: ["platform", "readModels", "deepResearch", "browserRuns"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.researchBrowserRuns', keys: ["platform", "readModels", "researchBrowserRuns"], kind: 'daemon-read-model' },
    { path: 'context.ops.research.browserRuns', keys: ["ops", "research", "browserRuns"], kind: 'sdk-read-model' },
    { path: 'context.clients.operator.research.browserRuns', keys: ["clients", "operator", "research", "browserRuns"], kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.research.browserRuns', keys: ["clients", "operatorSdk", "research", "browserRuns"], kind: 'sdk-read-model' },
  ] satisfies readonly { path: string; keys: readonly string[]; kind: SourceCandidate['kind'] }[];
  return definitions.map(definition => {
    const captured = captureCatalogPath(context, definition.keys); guards.push(captured.assertCurrent);
    return { path: definition.path, source: captured.value, kind: definition.kind };
  });
}

function visualSources(context: object, guards: (() => void)[]): readonly SourceCandidate[] {
  const definitions = [
    { path: 'context.platform.readModels.research.visualReports', keys: ["platform", "readModels", "research", "visualReports"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.research.reportSurfaces', keys: ["platform", "readModels", "research", "reportSurfaces"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.deepResearch.visualReports', keys: ["platform", "readModels", "deepResearch", "visualReports"], kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.researchVisualReports', keys: ["platform", "readModels", "researchVisualReports"], kind: 'daemon-read-model' },
    { path: 'context.ops.research.visualReports', keys: ["ops", "research", "visualReports"], kind: 'sdk-read-model' },
    { path: 'context.clients.operator.research.visualReports', keys: ["clients", "operator", "research", "visualReports"], kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.research.visualReports', keys: ["clients", "operatorSdk", "research", "visualReports"], kind: 'sdk-read-model' },
  ] satisfies readonly { path: string; keys: readonly string[]; kind: SourceCandidate['kind'] }[];
  return definitions.map(definition => {
    const captured = captureCatalogPath(context, definition.keys); guards.push(captured.assertCurrent);
    return { path: definition.path, source: captured.value, kind: definition.kind };
  });
}

export function isCertifiedResearchLiveRecord(record: { readonly certification: ResearchLiveRecordCertification }): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export async function researchLiveReadModelSnapshot(context: object, options: CatalogRankingOptions = {}): Promise<ResearchLiveReadModelSnapshot> {
  const caller = captureAsyncHarnessInput({}, options), guards: (() => void)[] = [], envelopes: unknown[] = [];
  caller.retainSourceCurrent();
  const assertNative = (): void => { for (const guard of guards) guard(); };
  const assertCurrent = (): void => { caller.assertCurrent(); assertNative(); caller.assertCurrent(); };
  const runners = runnerSources(context, guards), visuals = visualSources(context, guards);
  const runnerEntries: CollectedRecord[] = [], visualEntries: CollectedRecord[] = [];
  for (const candidate of runners) runnerEntries.push(...await collectFromSource(candidate.source, candidate.path, candidate.kind, RUNNER_WRAPPER_KEYS, RUNNER_METHODS, guards, envelopes, assertCurrent));
  for (const candidate of visuals) visualEntries.push(...await collectFromSource(candidate.source, candidate.path, candidate.kind, VISUAL_WRAPPER_KEYS, VISUAL_METHODS, guards, envelopes, assertCurrent));
  assertCurrent(); caller.options.retainCurrent?.(assertNative);
  return withModelReadingSource({ envelopes, runnerEntries, visualEntries }, { ...caller.options, assertCurrent }, async (captured, scoped) => {
    const browserRunnerRecords: ResearchBrowserRunnerRecord[] = [], visualReportRecords: ResearchVisualReportRecord[] = [];
    for (const [index, entry] of captured.runnerEntries.entries()) {
      const status = await schemaStatus(certificationRecords(entry.record), scoped); scoped.assertCurrent?.();
      const normalized = normalizeRunner(entry, index, status); if (normalized) browserRunnerRecords.push(normalized);
    }
    for (const [index, entry] of captured.visualEntries.entries()) {
      const status = await schemaStatus(certificationRecords(entry.record), scoped); scoped.assertCurrent?.();
      const normalized = normalizeVisualReport(entry, index, status); if (normalized) visualReportRecords.push(normalized);
    }
    scoped.assertCurrent?.();
    return { browserRunnerRecords: dedupeById(browserRunnerRecords), visualReportRecords: dedupeById(visualReportRecords),
      sourceCounts: { ...sourceCounts(captured.runnerEntries), ...sourceCounts(captured.visualEntries) } };
  });
}
