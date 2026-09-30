import type { KnowledgeNodeRecord } from '../types.js';
import type { AnswerFactRecord } from './answer-common.js';
import { readRecord, readString, readStringArray, uniqueStrings } from './utils.js';

/** Shared semantic claim fields for retrieval preflight and final answer verification. */
export function projectAnswerFactClaim(fact: AnswerFactRecord, claimSubjects: readonly KnowledgeNodeRecord[]) {
  return { title: fact.title, summary: fact.summary,
    value: fact.metadata.value, evidence: fact.metadata.evidence, subject: fact.metadata.subject,
    aliases: fact.aliases, labels: readStringArray(fact.metadata.labels), factKind: readString(fact.metadata.factKind),
    targetHints: (Array.isArray(fact.metadata.targetHints) ? fact.metadata.targetHints : []).map((hint) => typeof hint === 'string' ? hint : {
      title: readString(readRecord(hint).title), summary: readString(readRecord(hint).summary), kind: readString(readRecord(hint).kind),
      name: readString(readRecord(hint).name), description: readString(readRecord(hint).description),
      // Only resolved local node references can omit their store key. External
      // identifiers retain their meaning and the ordinary protected-input gate.
      externalReference: claimSubjects.some((subject) => subject.id === readString(readRecord(hint).id)) ? undefined : readString(readRecord(hint).id),
      model: readString(readRecord(hint).model), manufacturer: readString(readRecord(hint).manufacturer),
    }),
    subjects: uniqueStrings([...(fact.subjectIds ?? []), ...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds)])
      .map((id) => claimSubjects.find((node) => node.id === id))
      .filter((node): node is KnowledgeNodeRecord => Boolean(node)).map((node) => ({ title: node.title, summary: node.summary, kind: node.kind })),
  };
}
