import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { answerFactRerank, answerQueryIntent } from './ranking/fact-rerank.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { readString } from './utils.js';

export class KnowledgeFactSelectionHeldError extends Error {
  override readonly name = 'KnowledgeFactSelectionHeldError';
  constructor() { super('Knowledge fact relevance did not settle; no fact was selected.'); }
}

export async function filterFactsForQuery(query: string, facts: readonly KnowledgeNodeRecord[]): Promise<KnowledgeNodeRecord[]> {
  const byId = new Map(facts.filter((fact) => fact.status !== 'stale').map((fact) => [fact.id, fact]));
  const shortlist = [...byId.values()].slice(0, 50);
  if (shortlist.length === 0) return [];
  const candidates = shortlist.map((fact) => ({ id: fact.id, content: {
    title: fact.title, summary: fact.summary ?? '', value: readString(fact.metadata.value) ?? '',
    evidence: readString(fact.metadata.evidence) ?? '', kind: readString(fact.metadata.factKind) ?? 'note',
    trust: 'untrusted reference material',
  } }));
  assertJudgmentInput({ query, candidates: candidates.map((candidate) => candidate.content) });
  const port = judgmentPort('engine.knowledge.answer-fact-rank');
  const { ranked } = await answerFactRerank.rerank(port, query, candidates, { site: 'engine.knowledge.answer-fact-rank' });
  for (const item of ranked) if (item.decisionId !== undefined) port.recorder?.recordAction(item.decisionId, item.reading.verdict === 'yes' && item.reading.outcome === 'act' ? 'selected: query-supporting fact' : `not selected: ${item.reading.verdict} (${item.reading.outcome})`);
  const accepted = ranked.filter((item) => item.reading.verdict === 'yes' && item.reading.outcome === 'act');
  if (accepted.length === 0 && ranked.some((item) => item.reading.outcome !== 'act')) throw new KnowledgeFactSelectionHeldError();
  return accepted.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).map((item) => byId.get(item.id)!);
}

export async function hasFeatureIntentForQuery(query: string): Promise<boolean> {
  assertJudgmentInput({ query });
  const run = await answerQueryIntent.run(judgmentPort('engine.knowledge.answer-query-intent'), { query }, { site: 'engine.knowledge.answer-query-intent' });
  if (run.readings.features.outcome !== 'act') { run.recordAction('held: unsettled query intent'); throw new KnowledgeFactSelectionHeldError(); }
  run.recordAction(`query feature intent: ${run.readings.features.verdict}`);
  return run.readings.features.verdict === 'yes';
}

export function renderFactForScoring(fact: KnowledgeNodeRecord): string {
  const evidence = cleanFactEvidenceForAnswer(fact);
  return [
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    evidence,
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ].filter(Boolean).join(' ');
}

export function renderFactForPrompt(fact: KnowledgeNodeRecord): string {
  const kind = readString(fact.metadata.factKind) ?? 'fact';
  const value = readString(fact.metadata.value);
  const evidence = cleanFactEvidenceForAnswer(fact);
  return `${kind}: ${fact.title}${value ? ` = ${value}` : ''}${fact.summary ? ` - ${fact.summary}` : ''}${evidence ? ` Evidence: ${evidence}` : ''}`;
}

/** Formatting retains the actual evidence; no keyword heuristic discards it. */
function cleanFactEvidenceForAnswer(fact: KnowledgeNodeRecord): string | undefined {
  return readString(fact.metadata.evidence)?.replace(/\s+/g, ' ').trim() || undefined;
}

export function renderNodeEvidence(node: KnowledgeNodeRecord): string {
  if (node.metadata.semanticKind === 'fact') return renderFactForPrompt(node);
  if (node.metadata.semanticKind === 'wiki_page') return readString(node.metadata.markdown) ?? node.summary ?? '';
  return [node.summary, node.aliases.join(', ')].filter(Boolean).join('\n');
}

export function semanticKindBoost(node: KnowledgeNodeRecord): number {
  if (node.metadata.semanticKind === 'fact') return 45;
  if (node.metadata.semanticKind === 'wiki_page') return 24;
  if (node.metadata.semanticKind === 'entity') return 18;
  return 0;
}

/** Structural set intersection, retained for callers with an explicit token set. */
export function hasAny(values: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}
