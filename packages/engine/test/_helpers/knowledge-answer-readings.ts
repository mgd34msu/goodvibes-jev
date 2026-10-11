import { repairSubjectFixtureReading } from './repair-subject-fixture-readings.js';
/** Explicit plumbing readings for synthetic answer fixtures, not a semantic evaluator. */
import { homeGraphDocumentKind, homeGraphDocumentSubject } from '../../sdk/src/platform/knowledge/home-graph/auto-link/battery.js';
import { answerObjectFixtureReading, type AnswerObjectFixtureReadings } from './answer-object-fixture-readings.js';
import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { repairProfileFixtureReading, repairUsefulFixtureReading, type RepairProfileFixtureValues, type RepairUsefulFixtureValues } from './repair-profile-fixture-readings.js';
export interface AnswerFixtureReadings {
  /** Exact authored offered query strings, in preference order. Unlisted queries select none. */
  webGapQueries?: readonly string[];
  /** Exact discovered URLs and their independent authored relevance/publisher readings. */
  webGapSources?: ReadonlyArray<readonly [string, number, 'official-vendor' | 'vendor' | 'secondary']>;
  /** Explicit source title, exact node title/kind and relation. Unlisted documents select none. */
  autoLinks?: ReadonlyArray<readonly [string, string, string, 'has_receipt' | 'has_warranty' | 'has_manual' | 'source_for']>;
  repairSubjects?: ReadonlyArray<readonly [string, number]>;
  gapSubject?: number;
  /** Exact authored new/previous question pairs; equality only covers literal repeated fixture requests. */
  gapEquivalence?: ReadonlyArray<readonly [string, string, number]>;
  /** Exact authored original span outcomes; absent spans receive a settled no. */
  excerpts?: ReadonlyArray<readonly [string, number]>;
  /** Authored exact category/value pairs; unlisted source spans are never selected. */
  repairProfile?: RepairProfileFixtureValues;
  /** Exact authored claim title, summary and source evidence for repair usefulness. */
  repairUseful?: RepairUsefulFixtureValues;
  objectAlignment?: readonly AnswerObjectFixtureReadings[];
  /** Exact candidate titles with authored activation readings. Unlisted candidates never receive an implicit yes. */
  activation?: ReadonlyArray<readonly [string, number]>;
  initialEvidence?: ReadonlyArray<readonly [string, number]>;
  /** Exact authored evidence kind/title outcomes; no title-substring classifier. */
  initialEvidenceCandidates?: ReadonlyArray<readonly ['source' | 'node', string, number]>;
  /** Exact extraction-readability samples; other synthetic documents retain the existing readable default. */
  readability?: ReadonlyArray<readonly [string, number]>;
  initialEvidenceDefault?: number;
  /** Authored fixture expectations keyed by exact device title, never a keyword classifier. */
  homeGraph?: ReadonlyArray<readonly [string, Readonly<Partial<Record<'batteryApplicable' | 'manualApplicable' | 'manufacturerPresent' | 'modelPresent' | 'batteryTypePresent', number>>>]>;
  fidelity?: 'supported' | 'contradicted' | 'unsupported';
  fidelityByCandidate?: ReadonlyArray<readonly [string, 'supported' | 'contradicted' | 'unsupported']>;
  fidelityProbability?: number;
  enough?: number;
  complete?: number;
  completeByCandidate?: ReadonlyArray<readonly [string, number]>;
  preferred?: 'generated' | 'rendered';
  sources?: ReadonlyArray<readonly [string, number]>;
  facts?: ReadonlyArray<readonly [string, number]>;
  features?: number;
  quality?: ReadonlyArray<readonly [string, number]>;
  authorities?: ReadonlyArray<readonly [string, 'official-vendor' | 'vendor' | 'secondary' | 'unverified']>;
}
export function useKnowledgeAnswerReadings(defaults: Pick<AnswerFixtureReadings, 'repairProfile' | 'repairUseful' | 'objectAlignment'> = {}) {
  let previous: JudgmentPort | undefined;
  let table: AnswerFixtureReadings = {};
  let activation: AnswerFixtureReadings['activation'] = [];
  let fake = makePort();
  function makePort() {
    return fakePort((name, question, state) => {
      const web = state as { context?: { purpose?: string }; candidates?: { id: string; content: string }[]; source?: { url?: string } };
      if (web.context?.purpose === 'knowledge-gap-repair') {
        if (web.candidates) {
          const selected = table.webGapQueries?.map(text => web.candidates!.find(candidate => candidate.content === text)).find(Boolean);
          if (name === 'pick') return choiceAnswer(question, selected?.id ?? 'none', 0.99);
          const index = Number(name.slice('fits_'.length));
          if (name.startsWith('fits_')) return noulAnswer(web.candidates[index]?.id === selected?.id ? 0.99 : 0.01);
        }
        const source = table.webGapSources?.find(([url]) => url === web.source?.url);
        if (name === 'relevant') return noulAnswer(source?.[1] ?? 0.01);
        if (name === 'authority') return choiceAnswer(question, source?.[2] ?? 'secondary', 0.99);
      }
      // Item names are shared by other batteries, including repair-profile selected.
      // Match the canonical questions so their exact authored fixtures remain independent.
      if (question === homeGraphDocumentKind.items.manual.question
        || question === homeGraphDocumentKind.items.integrationDocumentation.question
        || question === homeGraphDocumentKind.items.relation.question
        || question === homeGraphDocumentSubject.items.selected.question) {
        const input = state as { source?: { title?: string }; candidate?: { subject?: { title?: string; kind?: string } } };
        const link = table.autoLinks?.find(([source]) => source === input.source?.title);
        if (name === 'manual') return noulAnswer(link?.[3] === 'has_manual' ? 0.99 : 0.01);
        if (name === 'integrationDocumentation') return noulAnswer(0.01);
        if (name === 'relation') return choiceAnswer(question, link?.[3] ?? 'source_for', 0.99);
        return noulAnswer(link && input.candidate?.subject?.title === link[1] && input.candidate.subject.kind === link[2] ? 0.99 : 0.01);
      }
      if (name === 'repairSubjectSelected') return noulAnswer(repairSubjectFixtureReading(state, table.repairSubjects));
      if (name === 'gapSubject') return noulAnswer(table.gapSubject ?? 0.01);
      if (name === 'sameQuestion') {
        const input = state as { question: { query: string }; candidate: { query: string } };
        return noulAnswer(table.gapEquivalence?.find(([query, previous]) => query === input.question.query && previous === input.candidate.query)?.[2]
          ?? (input.question.query === input.candidate.query ? 0.99 : 0.01));
      }
      if (name === 'excerptUseful') {
        const text = (state as { candidate?: { text?: string } }).candidate?.text;
        return noulAnswer(table.excerpts?.find(([original]) => original === text)?.[1] ?? 0.01);
      }
      if (name === 'repairUseful') return noulAnswer(repairUsefulFixtureReading(state,
        table.repairProfile ?? defaults.repairProfile, table.repairUseful ?? defaults.repairUseful));
      const profile = repairProfileFixtureReading(name, state, table.repairProfile ?? defaults.repairProfile);
      if (profile !== undefined) return noulAnswer(profile);
      const alignment = answerObjectFixtureReading(name, state, table.objectAlignment ?? defaults.objectAlignment);
      if (alignment !== undefined) return noulAnswer(alignment);
      if (name === 'serve') {
        const title = (state as { candidate?: { title?: string } }).candidate?.title;
        const probability = (table.activation ?? activation)?.find(([candidateTitle]) => candidateTitle === title)?.[1];
        if (probability === undefined) throw new Error(`Unscripted activation fixture: ${title ?? '<missing title>'}`);
        return noulAnswer(probability);
      }
      if (['batteryApplicable', 'manualApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name)) {
        const subject = (state as { subject?: { title?: string } }).subject;
        const scripted = table.homeGraph?.find(([title]) => title === subject?.title)?.[1];
        const defaults: Record<string, number> = { batteryApplicable: 0.01, manualApplicable: 0.99, manufacturerPresent: 0.01, modelPresent: 0.01, batteryTypePresent: 0.01 };
        return noulAnswer((scripted as Record<string, number> | undefined)?.[name] ?? defaults[name]!);
      }
      if (name === 'fidelity') {
        const text = JSON.stringify((state as { candidate?: unknown }).candidate);
        return choiceAnswer(question, table.fidelityByCandidate?.find(([snippet]) => text.includes(snippet))?.[1] ?? table.fidelity ?? 'supported', table.fidelityProbability ?? 0.97);
      }
      if (name === 'preferred') return choiceAnswer(question, table.preferred ?? 'generated', 0.97);
      if (name === 'enough') return noulAnswer(table.enough ?? 0.97);
      if (name === 'complete') {
        const text = JSON.stringify((state as { candidate?: unknown }).candidate);
        return noulAnswer(table.completeByCandidate?.find(([snippet]) => text.includes(snippet))?.[1] ?? table.complete ?? 0.97);
      }
      if (name === 'authority') {
        const text = JSON.stringify(state);
        return choiceAnswer(question, table.authorities?.find(([snippet]) => text.includes(snippet))?.[1] ?? 'secondary', 0.97);
      }
      if (question.type !== 'noul') throw new Error(`Unexpected answer fixture question: ${name}`);
      if (name === 'useful') {
        const text = JSON.stringify(state);
        if (typeof (state as { candidate?: { reference?: unknown } }).candidate?.reference === 'string') {
          const candidate = (state as { candidate: { kind?: string; title?: string } }).candidate;
          return noulAnswer(table.initialEvidenceCandidates?.find(([kind, title]) => candidate.kind === kind && candidate.title === title)?.[2]
            ?? table.initialEvidence?.find(([snippet]) => text.includes(snippet))?.[1] ?? table.initialEvidenceDefault ?? 0.97);
        }
        return noulAnswer(table.quality?.find(([snippet]) => text.includes(snippet))?.[1] ?? 0.97);
      }
      if (name === 'supported' || name === 'attached') return noulAnswer(0.99); // Explicit synthetic support fixtures; not a semantic evaluator.
      if (name === 'readable') {
        const sample = (state as { readonly sample: string }).sample;
        return noulAnswer(table.readability?.find(([text]) => text === sample)?.[1] ?? 0.99);
      }
      if (name === 'features') return noulAnswer(table.features ?? 0.97);
      if (name !== 'match') throw new Error(`Unexpected answer fixture question: ${name}`);
      const candidate = (state as { candidate: Record<string, unknown> }).candidate;
      const readings = 'sourceType' in candidate ? table.sources : table.facts;
      const text = JSON.stringify(candidate);
      return noulAnswer(readings?.find(([snippet]) => text.includes(snippet))?.[1] ?? 0.97);
    });
  }
  beforeEach(() => { table = {}; activation = []; fake = makePort(); previous = installJudgmentPort(fake.port); });
  afterEach(() => { installJudgmentPort(previous); });
  return { set(readings: AnswerFixtureReadings) { table = readings; },
    setActivation(readings: NonNullable<AnswerFixtureReadings['activation']>) { activation = readings; },
    get requests() { return fake.requests; } };
}
