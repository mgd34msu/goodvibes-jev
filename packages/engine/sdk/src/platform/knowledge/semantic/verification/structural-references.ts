import { KnowledgeGeneratedFactSupportHeldError, type GeneratedFactSupportInput } from './types.js';

/** Internal producer capability. Never populated from JSON or a stored ID prefix. */
export interface EngineGeneratedSupportReferences {
  readonly claimId: string;
  readonly subjectIds?: ReadonlySet<string> | undefined;
}
interface RegisteredReferences {
  readonly claimId: string;
  readonly subjectIds: ReadonlySet<string>;
}
const references = new WeakMap<GeneratedFactSupportInput, RegisteredReferences>();

/**
 * The caller just constructed these IDs with the engine's ID generator. It must
 * not call this for arbitrary stored/caller IDs, external semantic identifiers or
 * an origin inferred from an ID's spelling. Not exported by a public entry point.
 */
export function withEngineGeneratedSupportReferences(
  input: GeneratedFactSupportInput, generated: EngineGeneratedSupportReferences,
): GeneratedFactSupportInput {
  if (input.claim.id !== generated.claimId) throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  const subjectIds = new Set(generated.subjectIds ?? []);
  if ([...subjectIds].some((id) => !input.subjects.some((subject) => subject.id === id))) {
    throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  }
  references.set(input, { claimId: generated.claimId, subjectIds });
  return input;
}

/** Local per-pass mapping; raw IDs never enter the projected request or log. */
export function createSupportReferenceLabels() {
  const claims = new Map<string, string>();
  const subjects = new Map<string, string>();
  function label(map: Map<string, string>, id: string, role: string): string {
    const existing = map.get(id);
    if (existing) return existing;
    const value = `${role}-${map.size + 1}`;
    map.set(id, value);
    return value;
  }
  return {
    forInput(input: GeneratedFactSupportInput) {
      const known = references.get(input);
      if (!known) return undefined;
      if (input.claim.id !== known.claimId || [...known.subjectIds].some((id) => !input.subjects.some((subject) => subject.id === id))) {
        throw new KnowledgeGeneratedFactSupportHeldError('stale');
      }
      return {
        claimId: label(claims, known.claimId, 'claim'),
        subjects: new Map([...known.subjectIds].map((id) => [id, label(subjects, id, 'subject')])),
      };
    },
  };
}
export type SupportReferenceLabels = ReturnType<typeof createSupportReferenceLabels>;
