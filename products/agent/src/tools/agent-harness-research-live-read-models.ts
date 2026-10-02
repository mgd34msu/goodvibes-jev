import type { CommandContext } from '../input/command-registry.ts';
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

function schemaStatus(records: readonly Record<string, unknown>[]): ResearchLiveRecordCertification['schemaStatus'] {
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  return firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
    && firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'researchPublicationGuarantee'])
    && firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId'])
    ? 'certified'
    : 'legacy';
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
}): ResearchLiveRecordCertification {
  const records = certificationRecords(input.record);
  const currentSchemaStatus = schemaStatus(records);
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

function callMethod(source: Record<string, unknown>, method: string): unknown {
  const fn = source[method];
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as () => unknown).call(source);
  } catch {
    return undefined;
  }
}

function collectFromSource(
  source: unknown,
  path: string,
  kind: 'daemon-read-model' | 'sdk-read-model',
  wrapperKeys: readonly string[],
  methods: readonly string[],
  visited = new WeakSet<object>(),
): readonly CollectedRecord[] {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, wrapperKeys, methods, visited));
  }
  if (source instanceof Map) {
    return Array.from(source.entries()).flatMap(([key, value]) => collectFromSource(value, `${path}.${String(key)}`, kind, wrapperKeys, methods, visited));
  }
  if (typeof source !== 'object') return [];
  if (visited.has(source)) return [];
  visited.add(source);
  const record = source as Record<string, unknown>;
  const fromSnapshots = SNAPSHOT_METHODS.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, wrapperKeys, methods, visited);
  });
  const fromMethods = methods.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, wrapperKeys, methods, visited);
  });
  const fromWrappers = wrapperKeys.flatMap((key) => {
    if (!(key in record)) return [];
    return collectFromSource(record[key], `${path}.${key}`, kind, wrapperKeys, methods, visited);
  });
  if (fromSnapshots.length > 0 || fromMethods.length > 0 || fromWrappers.length > 0) {
    return [...fromSnapshots, ...fromMethods, ...fromWrappers];
  }
  return [{ path, kind, record }];
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

function normalizeRunner(entry: CollectedRecord, index: number): ResearchBrowserRunnerRecord | null {
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
    }),
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

function normalizeVisualReport(entry: CollectedRecord, index: number): ResearchVisualReportRecord | null {
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
    }),
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

function runnerSources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const research = readObject(readModels.research);
  const deepResearch = readObject(readModels.deepResearch);
  const opsResearch = readObject(readObject(context.ops).research);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorSdk = readObject(clients.operatorSdk);
  return [
    { path: 'context.platform.readModels.research.browserRuns', source: research.browserRuns, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.research.browserRunner', source: research.browserRunner, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.research.runs', source: research.runs, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.deepResearch.browserRuns', source: deepResearch.browserRuns, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.researchBrowserRuns', source: readModels.researchBrowserRuns, kind: 'daemon-read-model' },
    { path: 'context.ops.research.browserRuns', source: opsResearch.browserRuns, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.research.browserRuns', source: readObject(operator.research).browserRuns, kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.research.browserRuns', source: readObject(operatorSdk.research).browserRuns, kind: 'sdk-read-model' },
  ];
}

function visualSources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const research = readObject(readModels.research);
  const deepResearch = readObject(readModels.deepResearch);
  const opsResearch = readObject(readObject(context.ops).research);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorSdk = readObject(clients.operatorSdk);
  return [
    { path: 'context.platform.readModels.research.visualReports', source: research.visualReports, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.research.reportSurfaces', source: research.reportSurfaces, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.deepResearch.visualReports', source: deepResearch.visualReports, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.researchVisualReports', source: readModels.researchVisualReports, kind: 'daemon-read-model' },
    { path: 'context.ops.research.visualReports', source: opsResearch.visualReports, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.research.visualReports', source: readObject(operator.research).visualReports, kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.research.visualReports', source: readObject(operatorSdk.research).visualReports, kind: 'sdk-read-model' },
  ];
}

export function isCertifiedResearchLiveRecord(record: { readonly certification: ResearchLiveRecordCertification }): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export function researchLiveReadModelSnapshot(context: CommandContext): ResearchLiveReadModelSnapshot {
  const runnerEntries = runnerSources(context).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, RUNNER_WRAPPER_KEYS, RUNNER_METHODS)
  );
  const visualEntries = visualSources(context).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, VISUAL_WRAPPER_KEYS, VISUAL_METHODS)
  );
  return {
    browserRunnerRecords: dedupeById(runnerEntries.map(normalizeRunner).filter((entry): entry is ResearchBrowserRunnerRecord => entry !== null)),
    visualReportRecords: dedupeById(visualEntries.map(normalizeVisualReport).filter((entry): entry is ResearchVisualReportRecord => entry !== null)),
    sourceCounts: {
      ...sourceCounts(runnerEntries),
      ...sourceCounts(visualEntries),
    },
  };
}
