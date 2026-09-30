import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { entityAlias } from './batteries/entity-alias.js';

// Transport/work budgets, never semantic acceptance or word-frequency thresholds.
export const MAX_ENTITY_ALIAS_REQUESTS = 128;
export const MAX_ENTITY_ALIAS_CANDIDATES = 16;
export const MAX_ENTITY_ALIAS_EVIDENCE_CHARS = 4_096;
export const MAX_ENTITY_ALIAS_NAME_CHARS = 512;
export const MAX_ENTITY_ALIAS_WORD_CHARS = 128;
const MAX_ALIASES_PER_ENTITY = 4;

interface EntityIdentity {
  readonly kind: string;
  readonly title: string;
}
interface AliasEvidence {
  readonly title: string;
  readonly summary: string;
  readonly extractionSummary: string;
  readonly sections: readonly string[];
}

export class KnowledgeEntityAliasHoldError extends Error {
  constructor() {
    super('Knowledge entity aliases are on hold: the required alias readings did not settle within the request budget.');
    this.name = 'KnowledgeEntityAliasHoldError';
  }
}

/**
 * Complete prospective input is checked before clipping or the first request.
 * Only entity identity and lexical candidates with title/summary/section evidence
 * leave; unrelated metadata, provenance, artifact bytes and tags are not sent.
 * No alias or graph mutation is returned until the whole reading batch settles.
 */
export async function readKnowledgeEntityAliases(
  entities: readonly EntityIdentity[],
  input: AliasEvidence,
): Promise<readonly (readonly string[])[]> {
  if (entities.length === 0) return [];
  assertJudgmentInput({ entities, evidence: input });
  const identities = entities.map(({ kind, title }) => ({ kind, title }));
  if (identities.length > MAX_ENTITY_ALIAS_REQUESTS || identities.some((entity) => entity.title.length > MAX_ENTITY_ALIAS_NAME_CHARS)) {
    throw new KnowledgeEntityAliasHoldError();
  }
  const complete = [input.title, input.summary, input.extractionSummary, ...input.sections].join('\n');
  assertJudgmentInput(complete);
  // Do not fabricate a candidate by cutting through a word at the sample boundary.
  const evidence = complete.slice(0, MAX_ENTITY_ALIAS_EVIDENCE_CHARS);
  const candidateLimit = Math.min(MAX_ENTITY_ALIAS_CANDIDATES, Math.floor(MAX_ENTITY_ALIAS_REQUESTS / identities.length));
  const candidates: string[] = [];
  for (const match of complete.matchAll(/[\p{L}\p{N}\p{M}]+(?:[-_.'’][\p{L}\p{N}\p{M}]+)*/gu)) {
    if (match.index + match[0].length > evidence.length) break;
    const word = match[0];
    if (word.length > MAX_ENTITY_ALIAS_WORD_CHARS || candidates.includes(word)) continue;
    candidates.push(word);
    if (candidates.length === candidateLimit) break;
  }
  const aliases: string[][] = identities.map(() => []);
  const requests = identities.flatMap((entity, index) => candidates
    .filter((candidate) => candidate !== entity.title) // The exact identifier is already the node title.
    .map((candidate) => ({ index, state: { entity, candidate, evidence } })));
  // Check every complete prospective request before any request, including joined text.
  for (const request of requests) assertJudgmentInput(request.state);
  if (requests.length === 0) return aliases;
  const actions: Array<{ readonly record: (action: string) => void; readonly action: string }> = [];
  try {
    const port = judgmentPort('knowledge.ingest.entity-alias');
    // Sequential, at most 128 calls total, and every retained alias has its own reading.
    for (const { index, state } of requests) {
      const run = await entityAlias.run(port, state, { site: 'knowledge.ingest.entity-alias' });
      const reading = run.readings.alias;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') {
        run.recordAction('held: unresolved alias identity');
        throw new KnowledgeEntityAliasHoldError();
      }
      const selected = reading.verdict === 'yes' && aliases[index]!.length < MAX_ALIASES_PER_ENTITY;
      if (selected) aliases[index]!.push(state.candidate);
      actions.push({ record: run.recordAction, action: selected ? 'selected: entity alias' : reading.verdict === 'yes' ? 'not selected: alias count budget' : 'not an alias' });
    }
    for (const { record, action } of actions) record(action);
    return aliases;
  } catch {
    for (const { record } of actions) {
      try { record('held: alias batch incomplete'); } catch { /* Keep the hold value-free if recording also fails. */ }
    }
    // No heuristic retry, logging of input/error text, or partial alias set on outages.
    throw new KnowledgeEntityAliasHoldError();
  }
}
