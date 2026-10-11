import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { KnowledgeNodeRecord, KnowledgeEdgeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { projectRepairProfileInput, repairProfileSourceText, repairProfileSubject } from './repair-profile.js';
import { createSemanticWriteGuard, type SemanticWriteGuard } from './primary-source-plan.js';
import { createRepairFactUsefulnessReader, createKnowledgePageFactUsefulnessReader,
  KnowledgeRepairFactUsefulnessHeldError as Held, type RepairFactUsefulnessInput } from './repair-usefulness/reader.js';
import { readString, readStringArray } from './utils.js';

const USEFUL_PAGE_FACT_KINDS = new Set([
  'feature',
  'capability',
  'specification',
  'identity',
  'maintenance',
  'compatibility',
  'configuration',
  'troubleshooting',
]);

export interface KnowledgePageFactQualityOptions {
  readonly allowedFactKinds?: ReadonlySet<string> | undefined;
  readonly rejectRemoteAccessoryDetails?: boolean | undefined;
}

export function isSemanticAnswerLinkedObject(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  const semanticKind = readString(node.metadata.semanticKind);
  if (semanticKind) return false;
  return node.kind !== 'fact' && node.kind !== 'wiki_page' && node.kind !== 'knowledge_gap';
}

export function semanticFactText(fact: KnowledgeNodeRecord): string {
  return semanticFactTextFromParts([
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    readString(fact.metadata.evidence),
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ]);
}

export function semanticPageFactText(fact: KnowledgeNodeRecord): string {
  return semanticFactTextFromParts([
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ]);
}

function semanticFactTextFromParts(parts: readonly (string | undefined)[]): string {
  const uniqueParts: string[] = [];
  for (const part of parts.filter(Boolean) as string[]) {
    const normalized = normalizeComparableFactPart(part);
    if (!normalized) continue;
    if (uniqueParts.some((existing) => {
      const existingNormalized = normalizeComparableFactPart(existing);
      return existingNormalized === normalized
        || normalized.startsWith(`${existingNormalized} `)
        || existingNormalized.startsWith(`${normalized} `);
    })) continue;
    uniqueParts.push(part);
  }
  return uniqueParts.join(' ').toLowerCase();
}

function normalizeComparableFactPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|this|these|a|an)\s+/, '');
}

const FEATURE_KINDS = new Set(['feature', 'capability', 'specification', 'compatibility', 'configuration']);

/** Schema/provenance eligibility only. This never authorizes a semantic fact. */
export function isKnowledgePageFactCandidate(fact: KnowledgeNodeRecord, options: KnowledgePageFactQualityOptions = {}): boolean {
  if (fact.status !== 'active' || fact.metadata.semanticKind !== 'fact') return false;
  const kind = readString(fact.metadata.factKind) ?? 'note';
  if (!(options.allowedFactKinds ?? USEFUL_PAGE_FACT_KINDS).has(kind)) return false;
  return true; // Actual provenance includes graph edges and is resolved by prepare().
}

export interface KnowledgeFactQualityOptions extends KnowledgePageFactQualityOptions {
  readonly spaceId: string;
  readonly purpose?: 'knowledge-page' | 'repair' | undefined;
  readonly query: string;
  readonly subjects: readonly KnowledgeNodeRecord[];
  readonly signal?: AbortSignal | undefined;
  readonly guard?: SemanticWriteGuard | undefined;
  /** Exact prepared proposals. Their current target rows, including absence, remain guarded. */
  readonly proposedFacts?: ReadonlySet<KnowledgeNodeRecord> | undefined;
}
export interface KnowledgeFactQualityPlan {
  readonly facts: readonly KnowledgeNodeRecord[];
  accepts(fact: KnowledgeNodeRecord): boolean;
  assertCurrent(): void;
  /** Advance only a successfully persisted, semantically identical prepared proposal. */
  acknowledgeWritten(fact: KnowledgeNodeRecord): void;
  acknowledgeEdgeWritten(edge: KnowledgeEdgeRecord): void;
}

/** Only a changed candidate fact or its support edges can issue this recovery signal. */
export class KnowledgeFactReadSetStaleError extends Held {
  constructor(readonly factId: string) { super('stale'); }
}

function claimFor(fact: KnowledgeNodeRecord): RepairFactUsefulnessInput['fact'] {
  const labels = fact.metadata.labels;
  if (labels !== undefined && (!Array.isArray(labels) || !labels.every((item) => typeof item === 'string'))) throw new Held('malformed');
  return { title: fact.title, kind: readString(fact.metadata.factKind) ?? fact.kind,
    summary: fact.summary, value: fact.metadata.value, evidence: fact.metadata.evidence,
    subject: fact.metadata.subject, labels: labels as readonly string[] | undefined, aliases: fact.aliases };
}

/** Operation-scoped shared factuality + page usefulness. No record is changed by this reader. */
export function createKnowledgeFactQualityReader(store: KnowledgeStore, options: KnowledgeFactQualityOptions) {
  const signal = options.signal;
  const guard = options.guard ?? createSemanticWriteGuard(store, options.signal);
  const repair = createRepairFactUsefulnessReader({ signal: options.signal });
  const page = createKnowledgePageFactUsefulnessReader({ signal: options.signal });
  const ownership: (() => void)[] = [];
  const policy = () => JSON.stringify({ spaceId: options.spaceId, query: options.query,
    purpose: options.purpose, allowed: [...(options.allowedFactKinds ?? USEFUL_PAGE_FACT_KINDS)].sort(),
    rejectRemoteAccessoryDetails: options.rejectRemoteAccessoryDetails === true,
    subjects: options.subjects, proposed: [...(options.proposedFacts ?? [])] });
  const originalPolicy = policy();
  let ports: { site: string; port: ReturnType<typeof judgmentPort>; model: string }[] | undefined;
  function capture<T>(read: () => T, expected: T = read()): () => void {
    const identity = read(), version = JSON.stringify(expected);
    if (JSON.stringify(identity) !== version) throw new Held('stale');
    const check = () => { if (read() !== identity || JSON.stringify(read()) !== version) throw new Held('stale'); };
    ownership.push(check); return check;
  }
  for (const subject of options.subjects) {
    if (getKnowledgeSpaceId(subject) !== options.spaceId || subject.status === 'stale') throw new Held('stale');
    capture(() => store.getNode(subject.id), subject);
  }
  function assertCurrent() {
    if (options.signal !== signal) throw new Held('stale');
    if (signal?.aborted) throw new Held('aborted');
    if (policy() !== originalPolicy) throw new Held('stale');
    guard.assertCurrent(); repair.assertCurrent(); page.assertCurrent();
    for (const check of ownership) check();
    for (const { site, port, model } of ports ?? []) {
      try { if (judgmentPort(site) !== port || port.model !== model) throw new Held('stale'); }
      catch { throw new Held('stale'); }
    }
  }
  function sourceIdsFor(fact: KnowledgeNodeRecord): readonly string[] {
    return [...new Set([fact.sourceId, readString(fact.metadata.sourceId), ...readStringArray(fact.metadata.sourceIds),
      ...store.listEdges().filter((edge) => isActiveKnowledgeEdge(edge) && edge.fromKind === 'source'
        && edge.toKind === 'node' && edge.toId === fact.id && edge.relation === 'supports_fact').map((edge) => edge.fromId)]
      .filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
  }
  function factEdges(id: string) {
    return store.listEdges().filter((edge) => (edge.toKind === 'node' && edge.toId === id && edge.fromKind === 'source' && edge.relation === 'supports_fact')
      || (edge.fromKind === 'node' && edge.fromId === id && edge.toKind === 'node' && edge.relation === 'describes')).sort((a, b) => a.id.localeCompare(b.id));
  }
  async function prepare(candidates: readonly KnowledgeNodeRecord[]): Promise<KnowledgeFactQualityPlan> {
    assertCurrent();
    const rows = candidates.map((fact) => {
      const proposed = options.proposedFacts?.has(fact) === true;
      const expected = store.getNode(fact.id);
      let identity = expected;
      const snapshot = JSON.stringify(fact);
      if (!proposed && JSON.stringify(expected) !== snapshot) throw new Held('stale');
      let version = JSON.stringify(expected);
      let sourceIds = sourceIdsFor(fact);
      let edges = factEdges(fact.id), edgeVersion = JSON.stringify(edges);
      const check = () => {
        const currentEdges = factEdges(fact.id);
        if (currentEdges.length !== edges.length || currentEdges.some((edge, index) => edge !== edges[index]) || JSON.stringify(currentEdges) !== edgeVersion) throw new KnowledgeFactReadSetStaleError(fact.id);
        if (JSON.stringify(fact) !== snapshot || store.getNode(fact.id) !== identity || JSON.stringify(store.getNode(fact.id)) !== version
          || JSON.stringify(sourceIdsFor(fact)) !== JSON.stringify(sourceIds)) throw new KnowledgeFactReadSetStaleError(fact.id);
      };
      ownership.push(check);
      return { fact, proposed, snapshot, sourceIds, check,
        adoptEdge(edge: KnowledgeEdgeRecord) {
          const currentEdges = factEdges(fact.id);
          if (!currentEdges.includes(edge) || !isActiveKnowledgeEdge(edge)
            || !(edge.relation === 'supports_fact' && edge.toId === fact.id && sourceIds.includes(edge.fromId)
              || edge.relation === 'describes' && edge.fromId === fact.id && options.subjects.some((subject) => subject.id === edge.toId))) throw new Held('stale');
          const unaffected = currentEdges.filter((current) => current.id !== edge.id);
          const expected = edges.filter((current) => current.id !== edge.id);
          if (unaffected.length !== expected.length || unaffected.some((current, index) => current !== expected[index])) throw new Held('stale');
          edges = currentEdges; edgeVersion = JSON.stringify(edges);
        },
        adopt(written: KnowledgeNodeRecord) {
          if (!proposed || store.getNode(written.id) !== written || written.id !== fact.id
            || JSON.stringify(claimFor(written)) !== JSON.stringify(claimFor(fact))
            || getKnowledgeSpaceId(written) !== options.spaceId || written.status !== 'active'
            || written.metadata.semanticKind !== 'fact'
            || sourceIdsFor(written).some((id) => !sourceIds.includes(id))) throw new Held('stale');
          identity = written; version = JSON.stringify(written);
          sourceIds = sourceIdsFor(fact);
        } };
    });
    const selected = rows.filter(({ fact }) => getKnowledgeSpaceId(fact) === options.spaceId && isKnowledgePageFactCandidate(fact, options));
    const subjects = options.subjects.map(repairProfileSubject);
    const inputs: RepairFactUsefulnessInput[] = selected.map(({ fact, sourceIds }, index) => {
      const evidence = sourceIds.flatMap((id) => {
        const source = store.getSource(id), extraction = store.getExtractionBySourceId(id);
        capture(() => store.getSource(id)); capture(() => store.getExtractionBySourceId(id));
        if (!source || !extraction || getKnowledgeSpaceId(source) !== options.spaceId || getKnowledgeSpaceId(extraction) !== options.spaceId
          || (source.status !== 'indexed' && source.status !== 'pending') || isGeneratedKnowledgeSource(source)) return [];
        const projected = projectRepairProfileInput({ query: options.query, source, extraction, subjects,
          text: repairProfileSourceText(extraction), structuralReferences: captureKnowledgeSourceReferences(store, source, extraction) });
        return [{ source: projected.source, extraction: projected.extraction, text: projected.text }];
      });
      return { reference: `fact-${index + 1}`, query: options.query, subjects, fact: claimFor(fact), evidence,
        pagePolicy: { rejectRemoteAccessoryDetails: options.rejectRemoteAccessoryDetails === true } };
    });
    // Whole candidate/source batch precedes missing-data checks, caps and the first request.
    assertJudgmentInput(inputs);
    if (inputs.some((input) => !input.evidence.length || !input.evidence.some((evidence) => evidence.text.trim()))) throw new Held('unavailable');
    if (inputs.length) {
      const sites = [...(options.purpose === 'repair' ? [] : ['engine.knowledge.page-fact-quality']), ...(inputs.some((input) => FEATURE_KINDS.has(input.fact.kind)) || options.purpose === 'repair' ? ['engine.knowledge.repair-fact-usefulness'] : [])];
      if (!ports) {
        try { ports = sites.map((site) => { const port = judgmentPort(site); return { site, port, model: port.model }; }); }
        catch { throw new Held('unconfigured'); }
      } else for (const site of sites) if (!ports.some((entry) => entry.site === site)) {
        try { const port = judgmentPort(site); ports.push({ site, port, model: port.model }); } catch { throw new Held('unconfigured'); }
      }
    }
    const featureInputs = inputs.filter((input) => options.purpose === 'repair' || FEATURE_KINDS.has(input.fact.kind)).map(({ pagePolicy: _policy, ...input }) => input);
    repair.preflight(featureInputs);
    if (options.purpose !== 'repair') page.preflight(inputs);
    const featureReadings = await repair.read(featureInputs);
    assertCurrent();
    const pageReadings = options.purpose === 'repair' ? featureReadings : await page.read(inputs);
    assertCurrent();
    const usefulFeatures = new Set(featureReadings.filter((reading) => reading.useful).map((reading) => reading.reference));
    const usefulPages = new Set(pageReadings.filter((reading) => reading.useful).map((reading) => reading.reference));
    const accepted = new Set(selected.filter((_row, index) => {
      const input = inputs[index]!;
      return usefulPages.has(input.reference) && (options.purpose !== 'repair' && !FEATURE_KINDS.has(input.fact.kind) || usefulFeatures.has(input.reference));
    }).map(({ fact }) => fact));
    return Object.freeze({ facts: Object.freeze([...accepted]), assertCurrent,
      accepts(fact: KnowledgeNodeRecord) { assertCurrent(); return accepted.has(fact); },
      acknowledgeEdgeWritten(edge: KnowledgeEdgeRecord) {
        const row = rows.find((candidate) => accepted.has(candidate.fact) && (edge.relation === 'supports_fact' ? edge.toId : edge.fromId) === candidate.fact.id);
        if (!row) throw new Held('stale');
        row.adoptEdge(edge); assertCurrent();
      },
      acknowledgeWritten(fact: KnowledgeNodeRecord) {
        // Check every other lifetime before advancing this one authorized proposal.
        const row = rows.find((candidate) => candidate.fact.id === fact.id);
        if (!row || !accepted.has(row.fact)) throw new Held('stale');
        row.adopt(fact); assertCurrent();
      } });
  }
  return Object.freeze({ prepare, assertCurrent });
}
