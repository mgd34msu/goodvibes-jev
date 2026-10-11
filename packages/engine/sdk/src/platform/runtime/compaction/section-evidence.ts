/** Bounded dependency-qualified evidence closure for histories larger than one
 * canonical request. Every retained item is an exact original source message.
 * This is not a claim of formal equivalence to an unbounded full-source read. */
import {
  estimateTokens, LIMITS, mapLimit, noul, readYesNo, recordAction, recordReadings, toJson,
  type NoulQuestion, type NoulResponse, type YesNoReading,
} from '@goodvibes-jev/judgment';
import { OwnedJudgmentWork } from '../owned-judgment-work.js';
import { checkedCompactionPort, CompactionReadingError } from './section-judgment.js';
import { compactionEvidenceDependency, conversationSubstance } from './batteries/section-selection.js';

export interface CompactionEvidenceCase {
  readonly id: string;
  readonly sourceIndex: number;
  readonly battery: typeof conversationSubstance;
}
interface Case extends CompactionEvidenceCase { readonly evidence: Set<number> }
interface Job { readonly caseId: string; readonly sourceIndex: number }
interface Batch {
  readonly state: { readonly conversation: string; readonly chunkSourcePositions: readonly number[]; readonly cases: readonly { readonly id: string; readonly candidateSourcePosition: number; readonly evidenceSourcePositions: readonly number[] }[] };
  readonly questions: Record<string, NoulQuestion>;
  readonly jobs: ReadonlyMap<string, Job>;
}
/** Operation budgets, not user-adjustable fallback switches. */
export const COMPACTION_EVIDENCE_LIMITS = Object.freeze({ sourceMessages: 512, cases: 768, calls: 256, sweeps: 6, deadlineMs: 120_000, chunkTokens: 8_000 });

function fits(batch: Batch): boolean {
  const state = estimateTokens(batch.state);
  const questions = Object.values(batch.questions).map(estimateTokens);
  return questions.length > 0 && state + Math.max(...questions) <= LIMITS.maxStateWithQuestionTokens
    && state + questions.reduce((sum, value) => sum + value, 0) <= LIMITS.maxRequestTokens;
}
function stateFor(sources: readonly string[], cases: readonly Case[], extra: readonly number[] = []): Batch['state'] {
  const indexes = new Set(extra);
  for (const entry of cases) for (const index of entry.evidence) indexes.add(index);
  return Object.freeze({
    chunkSourcePositions: extra.map(index => index + 1),
    conversation: [...indexes].sort((a, b) => a - b).map(index => `#${index + 1} ${sources[index]!}`).join('\n\n'),
    cases: cases.map(entry => Object.freeze({ id: entry.id, candidateSourcePosition: entry.sourceIndex + 1,
      evidenceSourcePositions: [...entry.evidence].sort((a, b) => a - b).map(index => index + 1) })),
  });
}
function chunksFor(sources: readonly string[]): number[][] {
  const chunks: number[][] = []; let chunk: number[] = []; let tokens = 0;
  sources.forEach((source, index) => {
    const cost = estimateTokens(JSON.stringify(source)) + 20;
    if (chunk.length && tokens + cost > COMPACTION_EVIDENCE_LIMITS.chunkTokens) { chunks.push(chunk); chunk = []; tokens = 0; }
    chunk.push(index); tokens += cost;
  });
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
function dependencyBatch(sources: readonly string[], cases: readonly Case[], chunk: readonly number[]): Batch {
  const jobs = new Map<string, Job>(); const questions: Record<string, NoulQuestion> = {};
  for (const entry of cases) for (const sourceIndex of chunk) {
    if (entry.evidence.has(sourceIndex)) continue;
    const key = `dependency_${entry.id}_${sourceIndex}`;
    jobs.set(key, { caseId: entry.id, sourceIndex });
    questions[key] = noul({ instructions: compactionEvidenceDependency.items.selected.question.instructions!,
      evidenceScope: 'Use only this case evidenceSourcePositions plus chunkSourcePositions. Other cases may contribute source text to the transport batch, but that text is outside this case scope unless its source position is listed in this case or the current chunk.',
      caseId: entry.id, targetSourcePosition: sourceIndex + 1 });
  }
  return { state: stateFor(sources, cases, chunk), questions, jobs };
}
function planDependencies(sources: readonly string[], cases: readonly Case[], chunks: readonly number[][]): Batch[] {
  const batches: Batch[] = [];
  const push = (batch: Batch) => {
    if (batches.length >= COMPACTION_EVIDENCE_LIMITS.calls) throw new CompactionReadingError('budget');
    batches.push(batch);
  };
  const pack = (chunk: readonly number[], candidates: readonly Case[]): void => {
    let group: Case[] = [];
    for (let index = 0; index < candidates.length; index++) {
      const entry = candidates[index]!;
      if (chunk.every(sourceIndex => entry.evidence.has(sourceIndex))) continue;
      const trial = dependencyBatch(sources, [...group, entry], chunk);
      if (fits(trial)) { group.push(entry); continue; }
      if (group.length) { push(dependencyBatch(sources, group, chunk)); group = []; }
      const single = dependencyBatch(sources, [entry], chunk);
      if (fits(single)) { group.push(entry); continue; }
      if (chunk.length < 2) throw new CompactionReadingError('budget');
      // Whole-message splitting, never clipped text or omitted evidence.
      const middle = Math.ceil(chunk.length / 2);
      pack(chunk.slice(0, middle), candidates.slice(index));
      pack(chunk.slice(middle), candidates.slice(index));
      return;
    }
    if (group.length) push(dependencyBatch(sources, group, chunk));
  };
  for (const chunk of chunks) pack(chunk, cases);
  return batches;
}
function membershipBatch(sources: readonly string[], cases: readonly Case[]): Batch {
  const questions: Record<string, NoulQuestion> = {}; const jobs = new Map<string, Job>();
  for (const entry of cases) {
    const key = `selected_${entry.id}`;
    questions[key] = noul({ instructions: entry.battery.items.selected.question.instructions!,
      candidateSourcePosition: entry.sourceIndex + 1, caseId: entry.id });
    jobs.set(key, { caseId: entry.id, sourceIndex: entry.sourceIndex });
  }
  return { state: stateFor(sources, cases), questions, jobs };
}
function planMembership(sources: readonly string[], cases: readonly Case[]): { batch: Batch; battery: typeof conversationSubstance }[] {
  const batches: { batch: Batch; battery: typeof conversationSubstance }[] = [];
  for (const battery of new Set(cases.map(entry => entry.battery))) {
    // Only identical audited evidence sets share a final request. No other
    // case can introduce a new alias or correction after the stable sweep.
    const sameEvidence = new Map<string, Case[]>();
    for (const entry of cases.filter(item => item.battery === battery)) {
      const key = [...entry.evidence].sort((a, b) => a - b).join(',');
      const found = sameEvidence.get(key) ?? []; found.push(entry); sameEvidence.set(key, found);
    }
    for (const equivalent of sameEvidence.values()) {
      let group: Case[] = [];
      for (const entry of equivalent) {
        const trial = membershipBatch(sources, [...group, entry]);
        if (fits(trial)) { group.push(entry); continue; }
        if (group.length) batches.push({ batch: membershipBatch(sources, group), battery });
        group = [entry];
        if (!fits(membershipBatch(sources, group))) throw new CompactionReadingError('budget');
      }
      if (group.length) batches.push({ batch: membershipBatch(sources, group), battery });
    }
  }
  return batches;
}

/** Only a stable all-source sweep may authorize the final semantic reads.
 * Weak dependency readings add evidence; they never authorize omission or a
 * final membership answer. Every addition causes all omitted source to be
 * reconsidered, including chunks visited before a late alias was discovered. */
export async function readDependencyQualifiedMembership(
  sources: readonly string[], inputs: readonly CompactionEvidenceCase[],
  partners: (index: number) => readonly number[], owner: OwnedJudgmentWork,
): Promise<ReadonlyMap<string, boolean>> {
  if (sources.length > COMPACTION_EVIDENCE_LIMITS.sourceMessages || inputs.length > COMPACTION_EVIDENCE_LIMITS.cases) throw new CompactionReadingError('budget');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CompactionReadingError('budget')), COMPACTION_EVIDENCE_LIMITS.deadlineMs);
  const work = new OwnedJudgmentWork({ signal: AbortSignal.any([owner.signal, controller.signal]), assertCurrent: owner.assertCurrent });
  const cases: Case[] = inputs.map(input => ({ ...input, evidence: new Set([input.sourceIndex, ...partners(input.sourceIndex)]) }));
  const byId = new Map(cases.map(entry => [entry.id, entry]));
  let calls = 0;
  const reserve = (count: number) => {
    work.assertCurrent(); calls += count;
    if (calls > COMPACTION_EVIDENCE_LIMITS.calls) throw new CompactionReadingError('budget');
  };
  const run = async (batch: Batch, battery: typeof conversationSubstance): Promise<ReadonlyMap<string, YesNoReading>> => {
    work.assertCurrent();
    const port = checkedCompactionPort(owner.options(battery.name).port!, work);
    const state = toJson(batch.state);
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new CompactionReadingError('malformed');
    const result = await work.wait(() => battery.askBatch(port, state, batch.questions, {
      site: battery.name, signal: work.signal, beforeAttempt: work.assertCurrent,
    }));
    work.assertCurrent();
    const readings = new Map(Object.keys(batch.questions).map(key => [key, readYesNo(result.answers[key] as NoulResponse, battery.items.selected.band)]));
    recordReadings(port, result, Object.fromEntries(readings));
    recordAction(port, result.decisionId, battery === compactionEvidenceDependency ? 'qualify-source-dependencies' : 'qualify-section-membership');
    return readings;
  };
  try {
    const chunks = chunksFor(sources);
    let stable = false;
    for (let sweep = 0; sweep < COMPACTION_EVIDENCE_LIMITS.sweeps; sweep++) {
      work.assertCurrent();
      const batches = planDependencies(sources, cases, chunks);
      reserve(batches.length);
      const results = await mapLimit(batches, 4, async batch => ({ batch, readings: await run(batch, compactionEvidenceDependency) }));
      work.assertCurrent();
      let added = false;
      for (const { batch, readings } of results) for (const [key, reading] of readings) {
        if (reading.outcome === 'act' && reading.verdict === 'no') continue;
        const job = batch.jobs.get(key)!; const entry = byId.get(job.caseId)!;
        for (const index of [job.sourceIndex, ...partners(job.sourceIndex)]) {
          if (!entry.evidence.has(index)) { entry.evidence.add(index); added = true; }
        }
      }
      if (!added) { stable = true; break; }
    }
    if (!stable) throw new CompactionReadingError('unqualified');
    const batches = planMembership(sources, cases);
    reserve(batches.length);
    const results = await mapLimit(batches, 4, async ({ batch, battery }) => ({ batch, readings: await run(batch, battery) }));
    const membership = new Map<string, boolean>();
    for (const { batch, readings } of results) for (const [key, reading] of readings) {
      if (reading.outcome !== 'act') throw new CompactionReadingError('unqualified');
      membership.set(batch.jobs.get(key)!.caseId, reading.verdict === 'yes');
    }
    work.assertCurrent();
    return membership;
  } finally { clearTimeout(timer); work.retire(); }
}
