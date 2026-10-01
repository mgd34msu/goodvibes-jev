import { randomUUID } from 'node:crypto';
import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { gapRecordField as field, snapshotGapRecord as snapshotNodeInput } from './snapshot.js';
import { isActiveKnowledgeEdge } from '../../projection-utils.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../../spaces.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../../types.js';
import { captureKnowledgeSourceReferences, projectKnowledgeSourceReferences } from '../../source-structural-references.js';
import { sourceRankingContent } from '../answer-source-ranking.js';
import { createSemanticWriteGuard } from '../primary-source-plan.js';
import { exactReferences as references, exactReference as reference, exactIds, originalText } from './references.js';
import { freezeSupport } from '../verification/projection.js';
import { prepareAnswerGapReadings, snapshotAnswerGapInput } from './reader.js';
import { ANSWER_GAP_LIMITS as LIMITS, KnowledgeAnswerGapHeldError as Held, type AnswerGapCandidate, type AnswerGapMeaning } from './types.js';
import { persistPreparedAnswerGap } from './write.js';

export interface AnswerGapContext {
  readonly spaceId: string;
  readonly sources?: readonly KnowledgeSourceRecord[] | undefined;
  readonly linkedObjects?: readonly KnowledgeNodeRecord[] | undefined;
  readonly noMatch?: boolean | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
function jsonRecord(value: object): Readonly<Record<string, JsonValue>> {
  assertJudgmentInput(value);
  const json = toJson(value);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Held('malformed');
  return freezeSupport(json);
}
function subjectContent(node: KnowledgeNodeRecord): Readonly<Record<string, JsonValue>> {
  const identity = Object.fromEntries(['manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'entityKind', 'homeAssistant',
    'subject', 'value', 'evidence', 'text', 'markdown', 'searchText', 'attributes', 'labels'].filter((key) => node.metadata[key] !== undefined)
    .map((key) => [key, node.metadata[key]]));
  return jsonRecord({ kind: node.kind, title: node.title, summary: node.summary, aliases: node.aliases, identity });
}
function answerGap(node: KnowledgeNodeRecord): boolean { return node.kind === 'knowledge_gap' && node.metadata.gapKind === 'answer'; }

/** Capture the full structural universe before any answer/evidence request. IDs,
 * dates and lifecycle authority stay local; complete question/identity text does not.
 */
export function prepareAnswerGapUniverse(store: KnowledgeStore, requestedSpace: string, query: string, options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
} = {}) {
  const signal = options.signal;
  const space = normalizeKnowledgeSpaceId(requestedSpace);
  const guard = createSemanticWriteGuard(store, signal);
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  const deadlineAt = Date.now() + timeoutMs;
  const assertCurrent = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (Date.now() >= deadlineAt) throw new Held('budget');
    try { guard.assertCurrent(); } catch { throw new Held('stale'); }
  };
  const inScope = (record: { readonly metadata: Record<string, unknown> }) => {
    const metadata = field(record, 'metadata');
    let recordSpace = DEFAULT_KNOWLEDGE_SPACE_ID;
    for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const value = field(metadata, key);
      if (typeof value === 'string' && value.trim()) { recordSpace = normalizeKnowledgeSpaceId(value); break; }
    }
    return recordSpace === space || (space === 'homeassistant' && isHomeAssistantKnowledgeSpace(recordSpace));
  };
  const readNodes = () => store.listNodes(Number.MAX_SAFE_INTEGER).filter(inScope).map((node) => snapshotNodeInput(node));
  const readSources = () => store.listSources(Number.MAX_SAFE_INTEGER).filter(inScope).map((source) => snapshotNodeInput(source));
  const nodes = readNodes(), sources = readSources();
  guard.watch('gap-node-universe', readNodes, nodes);
  guard.watch('gap-source-universe', readSources, sources);
  guard.watch('gap-extraction-universe', () => store.listExtractions(Number.MAX_SAFE_INTEGER).filter(inScope).map((row) => snapshotNodeInput(row)));
  const sourceProofs = new Map(sources.map((source) => {
    const current = store.getSource(source.id), extraction = store.getExtractionBySourceId(source.id);
    return [source.id, { proof: captureKnowledgeSourceReferences(store, current, extraction), extraction: snapshotNodeInput(extraction) }] as const;
  }));
  const sourceContent = (source: KnowledgeSourceRecord) => {
    const captured = sourceProofs.get(source.id);
    const structural = projectKnowledgeSourceReferences(source, captured?.extraction, captured?.proof);
    return { ...sourceRankingContent(source), uri: source.url ?? (structural?.omitSourceUri ? undefined : source.sourceUri)
      ?? (structural?.omitCanonicalUri ? undefined : source.canonicalUri) ?? '' };
  };
  const gaps = nodes.filter(answerGap), gapIds = new Set(gaps.map((node) => node.id));
  const nodeIds = new Set(nodes.map((node) => node.id)), sourceIds = new Set(sources.map((source) => source.id));
  const includes = (ids: ReadonlySet<string>, value: unknown) => typeof value === 'string' && ids.has(value);
  const pertinent = (edge: ReturnType<KnowledgeStore['listEdges']>[number]) => inScope(edge)
    || (field(edge, 'fromKind') === 'node' && includes(nodeIds, field(edge, 'fromId'))) || (field(edge, 'toKind') === 'node' && includes(nodeIds, field(edge, 'toId')))
    || (field(edge, 'fromKind') === 'source' && includes(sourceIds, field(edge, 'fromId'))) || (field(edge, 'toKind') === 'source' && includes(sourceIds, field(edge, 'toId')));
  const readEdges = () => store.listEdges().filter(pertinent).map((edge) => snapshotNodeInput(edge));
  const edges = readEdges();
  guard.watch('gap-edge-universe', readEdges, edges);
  const readIssues = () => store.listIssues(Number.MAX_SAFE_INTEGER)
    .filter((issue) => inScope(issue) || includes(gapIds, field(issue, 'nodeId'))).map((issue) => snapshotNodeInput(issue));
  const issues = readIssues();
  guard.watch('gap-issue-universe', readIssues, issues);
  const readTasks = () => store.listRefinementTasks(Number.MAX_SAFE_INTEGER)
    .filter((task) => field(task, 'spaceId') === space || includes(gapIds, field(task, 'gapId'))).map((task) => snapshotNodeInput(task));
  const tasks = readTasks();
  guard.watch('gap-lifecycle-universe', readTasks, tasks);
  const fingerprint = randomUUID();
  const nodeId = `sem-answer-gap-${fingerprint}`, issueId = `sem-answer-gap-issue-${fingerprint}`;
  guard.node(nodeId); guard.watch('absent-gap-issue', () => store.getIssue(issueId));
  guard.watch('absent-gap-slug', () => store.getNodeByKindAndSlug('knowledge_gap', `answer-gap-${fingerprint}`));
  const subjectReferences = new Map(nodes.map((node, index) => [node.id, `subject-${index + 1}`]));
  const sourceReferences = new Map(sources.map((source, index) => [source.id, `source-${index + 1}`]));
  const subjectsFor = (gap: KnowledgeNodeRecord) => exactIds([
    ...references(gap.subjectIds), ...references(gap.linkedObjectIds), reference(gap.metadata.subjectId),
    ...references(gap.metadata.subjectIds), ...references(gap.metadata.linkedObjectIds),
    ...issues.filter((issue) => issue.nodeId === gap.id && issue.code === 'knowledge.answer_gap').flatMap((issue) =>
      exactIds([reference(issue.metadata.subjectId), ...references(issue.metadata.subjectIds), ...references(issue.metadata.linkedObjectIds)])),
    ...edges.filter((edge) => isActiveKnowledgeEdge(edge) && getKnowledgeSpaceId(edge) === getKnowledgeSpaceId(gap)
      && edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id && edge.relation === 'has_gap').map((edge) => edge.fromId),
  ]);
  const sourcesFor = (gap: KnowledgeNodeRecord) => exactIds([gap.sourceId, reference(gap.metadata.sourceId), ...references(gap.metadata.sourceIds),
    ...edges.filter((edge) => isActiveKnowledgeEdge(edge) && getKnowledgeSpaceId(edge) === getKnowledgeSpaceId(gap)
      && edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === gap.id && edge.relation === 'has_gap').map((edge) => edge.fromId)]);
  const meaning = (question: string, subject: unknown, ids: readonly string[], provenance: readonly string[], exactSpace: string): AnswerGapMeaning => {
    // Unknown/foreign references retain privacy preflight; they cannot acquire a
    // local opaque alias or disappear from the subject's meaning.
    const subjectRows = ids.map((id) => nodes.find((node) => node.id === id && getKnowledgeSpaceId(node) === exactSpace));
    const sourceRows = provenance.map((id) => sources.find((source) => source.id === id && getKnowledgeSpaceId(source) === exactSpace));
    assertJudgmentInput({ query: question, subject,
      subjects: subjectRows.map((node, index) => node ? subjectContent(node) : { unresolvedReference: ids[index] }),
      sources: sourceRows.map((source, index) => source ? sourceContent(source) : { unresolvedReference: provenance[index] }) });
    if ((subject !== undefined && typeof subject !== 'string') || subjectRows.some((node) => !node) || sourceRows.some((source) => !source)) throw new Held('malformed');
    return { query: question, ...(typeof subject === 'string' ? { subject } : {}),
      subjects: subjectRows.map((node) => ({ reference: subjectReferences.get(node!.id)!, content: subjectContent(node!) })),
      sources: sourceRows.map((source) => ({ reference: sourceReferences.get(source!.id)!, content: jsonRecord(sourceContent(source!)) })) };
  };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  assertCurrent();
  return {
    assertCurrent,
    prepare(context: AnswerGapContext) {
      assertCurrent();
      const callerCurrent = context.assertCurrent;
      const noMatch = context.noMatch === true;
      const exactSpace = normalizeKnowledgeSpaceId(context.spaceId);
      const linkedObjects = snapshotNodeInput(context.linkedObjects ?? []), selectedSources = snapshotNodeInput(context.sources ?? []);
      for (const node of linkedObjects) {
        guard.watch(`gap-context-node:${node.id}`, () => snapshotNodeInput(store.getNode(node.id)), node);
      }
      for (const source of selectedSources) {
        guard.watch(`gap-context-source:${source.id}`, () => snapshotNodeInput(store.getSource(source.id)), source);
        guard.extraction(source.id);
      }
      const noAdmission = noMatch && !linkedObjects.length && exactSpace === DEFAULT_KNOWLEDGE_SPACE_ID;
      let reader: ReturnType<typeof prepareAnswerGapReadings> | undefined;
      const check = () => { assertCurrent(); callerCurrent?.(); reader?.assertCurrent(); };
      let resultPromise: ReturnType<typeof resolve> | undefined;
      async function resolve() {
        check();
        if (exactSpace !== space && !(space === 'homeassistant' && isHomeAssistantKnowledgeSpace(exactSpace))
          || linkedObjects.some((node) => getKnowledgeSpaceId(node) !== exactSpace || node.status !== 'active')
          || selectedSources.some((source) => getKnowledgeSpaceId(source) !== exactSpace)) throw new Held('malformed');
        if (noAdmission) return Object.freeze({ assertCurrent: check, async persist(_reason: string): Promise<KnowledgeNodeRecord | null> { check(); return null; } });
        const localGaps = gaps.filter((gap) => getKnowledgeSpaceId(gap) === exactSpace);
        const candidates: AnswerGapCandidate[] = localGaps.map((gap, index) => ({ reference: `gap-${index + 1}`, title: gap.title,
          summary: gap.summary, reason: gap.metadata.reason as string | undefined, ...meaning(gap.metadata.query === undefined ? gap.title : gap.metadata.query as string,
            gap.metadata.subject, subjectsFor(gap), sourcesFor(gap), getKnowledgeSpaceId(gap)),
          issues: issues.filter((issue) => issue.nodeId === gap.id && issue.code === 'knowledge.answer_gap').map((issue, issueIndex) => ({
            reference: `issue-${issueIndex + 1}`, message: issue.message, reason: issue.metadata.reason as string | undefined,
            ...meaning(issue.metadata.query === undefined ? gap.title : issue.metadata.query as string, issue.metadata.subject,
              exactIds([reference(issue.metadata.subjectId), ...references(issue.metadata.subjectIds), ...references(issue.metadata.linkedObjectIds)]),
              exactIds([issue.sourceId, reference(issue.metadata.sourceId), ...references(issue.metadata.sourceIds)]), exactSpace),
          })),
        }));
        const question = meaning(query, undefined, linkedObjects.map((node) => node.id), selectedSources.map((source) => source.id), exactSpace);
        // Complete selected universe preflight before candidate/byte bounds and ports.
        snapshotAnswerGapInput({ question, candidates, needsSubject: false });
        const currentSubjects = new Set(linkedObjects.map((node) => node.id));
        const eligible = candidates.filter((_, index) => {
          const gap = localGaps[index]!, previousSubjects = subjectsFor(gap);
          return getKnowledgeSpaceId(gap) === exactSpace && (!currentSubjects.size || !previousSubjects.length
            || (previousSubjects.length === currentSubjects.size && previousSubjects.every((id) => currentSubjects.has(id))));
        });
        reader = prepareAnswerGapReadings({ question, candidates: eligible,
          needsSubject: noMatch && !linkedObjects.length && exactSpace === 'homeassistant' },
        { signal, deadlineAt, assertCurrent: () => { assertCurrent(); callerCurrent?.(); } });
        const result = await reader.read();
        check();
        const selected = result?.reference ? localGaps[candidates.findIndex((candidate) => candidate.reference === result.reference)] : undefined;
        const selectedIssues = selected ? issues.filter((issue) => issue.nodeId === selected.id && issue.code === 'knowledge.answer_gap') : [];
        if (selectedIssues.length > 1) throw new Held('uncertain');
        // Preserve exact IDs and the existing lifecycle fingerprint. The new
        // UUID is only allocation, never a semantic equivalence decision.
        const target = freezeSupport({ nodeId: selected?.id ?? nodeId, issueId: selectedIssues[0]?.id ?? issueId,
          fingerprint: originalText(selected?.metadata.subjectFingerprint) ?? originalText(selectedIssues[0]?.metadata.subjectFingerprint) ?? fingerprint });
        guard.node(target.nodeId); guard.watch(`gap-selected-issue:${target.issueId}`, () => store.getIssue(target.issueId));
        return Object.freeze({ assertCurrent: check,
          async persist(reason: string): Promise<KnowledgeNodeRecord | null> {
            check(); assertJudgmentInput({ reason });
            if (!result?.admitted) return null;
            return persistPreparedAnswerGap(store, { spaceId: exactSpace, query, reason, target, existing: selected,
              issue: selectedIssues[0], issues: selected ? issues.filter((issue) => issue.nodeId === selected.id) : [],
              tasks: selected ? tasks.filter((task) => task.gapId === selected.id) : [],
              sources: selectedSources, linkedObjects, reading: result }, check, signal);
          },
        });
      }
      return { assertCurrent: check, read() { return resultPromise ??= resolve(); } };
    },
  };
}
export type PreparedAnswerGapUniverse = ReturnType<typeof prepareAnswerGapUniverse>;
