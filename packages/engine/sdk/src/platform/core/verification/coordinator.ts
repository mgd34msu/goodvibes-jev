import { JudgmentError, mapLimit } from '@goodvibes-jev/judgment';
import { snapshotJudgmentEvidence } from '../../gate/judgment-input.js';
import { captureStrictJudgmentJson } from '../../gate/judgment-result.js';
import { verificationEvidence, verificationIntegration, verificationRequirement, verificationScope, verificationSource, verificationRepairs, verificationNoIssue, verificationAudit } from './batteries.js';
import { VERIFICATION_FRAME_CHARACTERS, VERIFICATION_OVERVIEW_CHARACTERS, verificationFrames, verificationHash, verificationSources, verificationWireSource } from './source.js';
import { VerificationStore } from './store.js';
import { VerificationHeldError, VerificationSubdivisionError, type VerificationAccess, type VerificationReceipt, type VerificationRequirement, type VerificationSource, type VerificationSummary, type VerificationWriter } from './types.js';
import type { CompletionFinding } from '../response-completion-findings.js';
import { bindVerificationTargets } from './targets.js';

const clean = (readings: Readonly<Record<string, { verdict: string; outcome: string }>>) => Object.values(readings).every(reading => reading.verdict === 'no' && reading.outcome === 'act');
const bounded = (value: unknown, limit: number) => JSON.stringify(value).length <= limit;
const MAX_EXACT_CASE_CHARACTERS = 192_000;
const readingEvidence = (readings: Readonly<Record<string, { verdict: string; outcome: string }>>) =>
  Object.fromEntries(Object.entries(readings).map(([aspect, reading]) => [aspect, { verdict: reading.verdict, outcome: reading.outcome }]));
class VerificationDeferredError extends Error {}
class VerificationScopeFallback extends Error {}
const attemptOwner = Symbol('verification attempt owner');
type AttemptAccess = VerificationAccess & { [attemptOwner]?: { pending: Set<Promise<unknown>> } };
type InspectionCursor = {
  frontier: VerificationReceipt[];
  opened: { sources: readonly VerificationSource[]; earlier: readonly { id: string; summary: VerificationSummary }[] };
  seen: Set<string>;
  localized: boolean;
  audited: Set<string>;
  accounted: Set<string>;
};
type RepairAssessment = {
  findings: readonly CompletionFinding[];
  noIssues: readonly { check: string; reason: string; passage: { reference: string; quote: string } }[];
};
async function ownedMapLimit<T, R>(access: VerificationAccess, values: readonly T[], limit: number, read: (value: T) => Promise<R>): Promise<R[]> {
  return mapLimit(values, limit, value => {
    const pending = (access as AttemptAccess)[attemptOwner]?.pending;
    const work = Promise.resolve().then(() => { access.assertCurrent(); return read(value); });
    pending?.add(work);
    void work.finally(() => pending?.delete(work)).catch(() => {});
    return work;
  });
}
const parse = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected one JSON object');
  return snapshotJudgmentEvidence(value) as Record<string, unknown>;
};
function summary(value: Record<string, unknown>, ids: Set<string>, limit: number): VerificationSummary {
  if (!bounded(value, limit)) throw new Error('Evidence proposal exceeds maxCharacters');
  const facts = (input: unknown) => {
    if (!Array.isArray(input)) throw new Error('Expected facts and concerns arrays');
    return input.map((fact: unknown) => {
      if (!fact || typeof fact !== 'object') throw new Error('Expected a cited fact');
      const entry = fact as { text?: unknown; sources?: unknown };
      if (typeof entry.text !== 'string' || !entry.text.trim() || !Array.isArray(entry.sources) || !entry.sources.length
        || !entry.sources.every(id => typeof id === 'string' && ids.has(id))) throw new Error('Fact needs known supporting citations');
      return { text: entry.text, sources: entry.sources as string[] };
    });
  };
  return { facts: facts(value.facts), concerns: facts(value.concerns) };
}
function requirements(value: Record<string, unknown>, ids: Set<string>): VerificationRequirement[] {
  if (!bounded(value, 8_000) || !Array.isArray(value.requirements) || !value.requirements.length) throw new Error('Expected a bounded nonempty requirement ledger');
  return value.requirements.map((raw: unknown) => {
    const item = raw as { text?: unknown; sources?: unknown } | null;
    if (!item || typeof item.text !== 'string' || !item.text.trim() || !Array.isArray(item.sources) || !item.sources.length
      || !item.sources.every(id => typeof id === 'string' && ids.has(id))) throw new Error('Requirement needs original instruction citations');
    return { id: `requirement-${verificationHash(item).slice(0, 16)}`, text: item.text, sources: item.sources as string[] };
  });
}

/** Source reduction is a checked intermediate operation, never a completion
 * permit. Only this process's current Jev identity can qualify cached records. */
export class CompletionVerification {
  private readonly qualified = new WeakMap<object, Map<string, unknown>>();
  private readonly nodes = new Map<string, VerificationReceipt>();
  private readonly originals = new Map<string, VerificationSource>();
  private readonly sourceOrder = new Map<string, number>();
  private previousSources: { identity: object; request: string; ids: Set<string> } | undefined;
  private finalEvidence: { key: string; identity: object; frontier: VerificationReceipt[]; seen: Set<string>; opened: readonly VerificationSource[]; earlier: VerificationReceipt[] } | undefined;
  constructor(private readonly writer: VerificationWriter, readonly store = new VerificationStore()) {}

  private options(access: VerificationAccess) { return { ...(access.signal ? { signal: access.signal } : {}), beforeAttempt: access.assertCurrent, ...(access.onRetry ? { onRetry: access.onRetry } : {}) }; }
  private cache(access: VerificationAccess): Map<string, unknown> {
    let cache = this.qualified.get(access.identity);
    if (!cache) { cache = new Map(); this.qualified.set(access.identity, cache); }
    return cache;
  }
  private async ownedAttempt<T>(access: VerificationAccess, work: (local: VerificationAccess) => Promise<T>): Promise<T> {
    const controller = new AbortController(), pending = new Set<Promise<unknown>>();
    const local: AttemptAccess = { ...access, [attemptOwner]: { pending },
      signal: access.signal ? AbortSignal.any([access.signal, controller.signal]) : controller.signal,
      assertCurrent: () => { access.assertCurrent(); controller.signal.throwIfAborted(); } };
    try { return await work(local); }
    finally {
      controller.abort(new VerificationDeferredError());
      // A failed parallel reading must not leave old writers or readers alive
      // while the held draft starts its next recovery attempt.
      while (pending.size) await Promise.allSettled([...pending]);
    }
  }
  private async proposal<T>(operation: Parameters<VerificationWriter>[0]['operation'], context: unknown, key: string,
    access: VerificationAccess, admit: (value: Record<string, unknown>) => T,
    qualify: (proposed: T) => Promise<unknown | null>, originalScopeAvailable = false): Promise<T> {
    access.assertCurrent();
    const cache = this.cache(access);
    if (cache.has(key)) return cache.get(key) as T;
    let candidate = this.store.proposals.get(key), repair: unknown = null, attempts = 0;
    for (;;) {
      access.signal?.throwIfAborted(); access.assertCurrent();
      if (candidate === undefined) {
        if (originalScopeAvailable && attempts >= 2) throw new VerificationScopeFallback();
        if ((operation === 'evidence' || operation === 'merge') && attempts >= 2) throw new VerificationSubdivisionError();
        try { candidate = await this.writer({ operation, context, repair, signal: access.signal, assertCurrent: access.assertCurrent }); }
        catch (error) { access.assertCurrent(); throw new VerificationHeldError('private proposal provider', { cause: error }); }
      }
      attempts++;
      let proposed: T;
      try { proposed = admit(parse(candidate)); }
      catch (error) {
        candidate = undefined;
        repair = { problem: error instanceof Error ? error.message : 'The proposal is not admissible JSON with the required bounded schema and known citations.',
          instruction: 'Correct this specific proposal defect. Respect maxCharacters and cite only the immediate input source/node IDs.' };
        continue;
      }
      // Checkpoint only a schema/privacy-admitted proposal. Disk never grants
      // authority: a resumed attempt still has to qualify it with current Jev.
      this.store.rememberProposal(key, candidate);
      const defects = await qualify(proposed);
      access.assertCurrent();
      if (defects === null) {
        const captured = snapshotJudgmentEvidence(proposed) as T;
        this.store.rememberProposal(key, candidate); cache.set(key, captured); return captured;
      }
      repair = { previous: proposed, defects, instruction: 'Repair this evidence proposal against the same sources. Do not redo the underlying user task or invent new requirements.' };
      candidate = undefined;
      // Yield even for synchronous embedded providers; cancellation and the UI
      // must remain responsive while a verifier proposal is being repaired.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  private async ledger(instructions: readonly VerificationSource[], access: VerificationAccess): Promise<VerificationRequirement[]> {
    // Rewriting is an optimization, never the source of user authority. When
    // the exact instruction roots fit, unsettled extraction falls back to those
    // originals instead of generating an endless series of paraphrases.
    const userTexts = new Set(instructions.filter(source => source.messageRole === 'user' && source.completeMessage).flatMap(source => {
      try { const value = JSON.parse(source.text); return typeof value.content === 'string' ? [value.content] : []; } catch { return []; }
    }));
    const originals = instructions.filter(source => !((source.reference.startsWith('current user request') || source.reference.startsWith('original request at turn entry')) && userTexts.has(source.text)));
    const exactScopeFits = bounded(originals, VERIFICATION_OVERVIEW_CHARACTERS);
    // Large instruction histories are reduced with the same source qualification
    // as observations, then the ledger is audited against EVERY original page.
    const pages = verificationFrames(instructions, VERIFICATION_FRAME_CHARACTERS, source => JSON.stringify(verificationWireSource(source)).length);
    const source = pages.length <= 1 ? instructions.map(verificationWireSource) : (await this.evidenceTree(instructions, [], access)).map(node => this.compactNode(node));
    const context = { sources: source, currentRequest: instructions.filter(entry => entry.reference.startsWith('current user request')),
      granularity: 'Use independently checkable obligations: performed work and delivery of its artifact are separate requirements. Preserve explicit scope and constraints; do not turn a full-codebase request into only representative subsystem sampling or add exhaustive runtime testing unless requested.' };
    const key = verificationHash(['scope-v1', context]);
    try { return await this.proposal('requirements', context, key, access, value => requirements(value, new Set([...instructions.map(entry => entry.id), ...source.map(entry => entry.id)])), async proposed => {
      const runs = await ownedMapLimit(access, pages, 3, async sources => {
        const run = await verificationScope.run(access.port, { sources: sources.map(verificationWireSource), instructionOverview: source, proposed, instruction: 'Check omissions against this original page; assess invented scope against the COMPLETE instruction overview. Other original pages may support other ledger items. Do not require one page to prove all work.' } as never,
          { ...this.options(access), site: verificationScope.name });
        run.recordAction(clean(run.readings) ? 'Qualify this scope page only; no completion authority.' : 'Repair the private requirement proposal against this original page.');
        return clean(run.readings) ? null : { sources, readings: readingEvidence(run.readings) };
      });
      return runs.every(run => run === null) ? null : runs.filter(Boolean);
    }, exactScopeFits); }
    catch (error) {
      if (!(error instanceof VerificationScopeFallback)) throw error;
      access.assertCurrent();
      return originals.map(source => ({ id: `original-${source.id}`, text: source.text, sources: [source.id] }));
    }
  }

  private async node(sources: readonly (VerificationSource | VerificationReceipt)[], scope: readonly VerificationRequirement[], access: VerificationAccess, focusedRequirement?: VerificationRequirement): Promise<VerificationReceipt> {
    const children = sources.map(source => source.id), wireSources = sources.map(source => 'text' in source ? verificationWireSource(source) : source);
    // Facts describe these sources, not whether the CURRENT task is complete.
    // Changing a request must rerun its requirement checks, without rewriting
    // unchanged source records to fit a different task interpretation.
    const context = { requirements: [] as readonly VerificationRequirement[], sources: wireSources, citationIds: children, ...(focusedRequirement ? { focusedRequirement } : {}),
      maxCharacters: focusedRequirement ? 6_000 : Math.min(8_000, Math.max(2_400, Math.floor(JSON.stringify(wireSources).length * .4))) };
    const key = verificationHash(['evidence-v1', context]);
    const previousKey = verificationHash(['evidence-v1', { ...context, requirements: scope }]);
    const { citationIds: _citationIds, ...legacyContext } = context;
    const previous = this.store.proposals.get(previousKey)
      ?? this.store.proposals.get(verificationHash(['evidence-v1', legacyContext]))
      ?? this.store.proposals.get(verificationHash(['evidence-v1', { ...legacyContext, requirements: scope }]));
    if (!this.store.proposals.has(key) && previous !== undefined) this.store.rememberProposal(key, previous);
    const operation = sources.some(source => 'summary' in source) ? 'merge' : 'evidence';
    const proposed = await this.proposal(operation, context, key, access, value => summary(value, new Set(children), context.maxCharacters), async proposed => {
      const run = await verificationEvidence.run(access.port, { ...context, proposed } as never, { ...this.options(access), site: verificationEvidence.name });
      const accepted = clean(run.readings);
      run.recordAction(accepted ? 'Qualify only this evidence reduction against its complete identified children; retain originals for retrieval.' : 'Repair this private evidence reduction without asking the working model to repeat its task.');
      if (accepted) return null;
      // Broad uncertainty is not a defect and should not trigger another draft.
      // Resolve it with smaller semantic questions over the SAME proposal:
      // completeness per source; support and provenance per cited assertion.
      const jobs: { aspect: keyof typeof verificationEvidence.items; target: string; state: unknown }[] = [];
      if (run.readings.omission.verdict !== 'no' || run.readings.omission.outcome !== 'act') {
        for (const source of context.sources) jobs.push({ aspect: 'omission', target: source.id, state: { requirements: [], ...(focusedRequirement ? { focusedRequirement } : {}), sources: [source], proposed,
          focus: 'Judge preservation of material facts in THIS source only. Other proposal facts may cite other source pages. Do not require the source to independently finish the task.' } });
      }
      for (const aspect of ['unsupported', 'provenance'] as const) {
        if (run.readings[aspect].verdict === 'no' && run.readings[aspect].outcome === 'act') continue;
        for (const [kind, facts] of [['facts', proposed.facts], ['concerns', proposed.concerns]] as const) for (const [index, fact] of facts.entries()) jobs.push({ aspect, target: `${kind}[${index}]`,
          state: { requirements: [], sources: context.sources.filter(source => fact.sources.includes(source.id)),
            proposed: { facts: kind === 'facts' ? [fact] : [], concerns: kind === 'concerns' ? [fact] : [] },
            focus: 'Judge ONLY this single cited assertion against its cited original sources, including its expressed uncertainty. Native citations preserve original identity and boundaries.' } });
      }
      const defects = await ownedMapLimit(access, jobs, 3, async job => {
        const key = verificationHash(['atomic-evidence-v1', job]);
        const cache = this.cache(access);
        if (cache.has(key)) return null;
        const check = await verificationEvidence.run(access.port, job.state as never, { ...this.options(access), only: [job.aspect], site: verificationEvidence.name });
        const reading = check.readings[job.aspect];
        const accepted = reading.verdict === 'no' && reading.outcome === 'act';
        check.recordAction(accepted ? `Qualify this source/assertion ${job.aspect} only; no completion authority.` : `Retain this specific ${job.aspect} source/assertion for private proposal repair.`);
        access.assertCurrent();
        if (accepted) { cache.set(key, true); return null; }
        // Original context and previous proposal are already supplied once.
        // Do not duplicate whole source/proposal bodies for every failed item.
        return { aspect: job.aspect, target: job.target, reading: { verdict: reading.verdict, outcome: reading.outcome } };
      });
      return defects.every(defect => defect === null) ? null : defects.filter(Boolean);
    });
    const receipt: VerificationReceipt = { id: `e-${key.slice(0, 24)}`, summary: proposed, children, representation: 'jev-qualified',
      sourceIds: sources.flatMap(source => 'sourceIds' in source ? source.sourceIds : [source.id]) };
    this.nodes.set(receipt.id, receipt); return receipt;
  }

  private async page(sources: readonly VerificationSource[], scope: readonly VerificationRequirement[], access: VerificationAccess): Promise<VerificationReceipt[]> {
    if (sources.length === 1 && sources[0]!.text.length <= 1024) {
      // This is the exact original, not a semantic reduction or an approval.
      // Native equality preserves every code unit; Jev still must evaluate the
      // requirement, solution quality, integration and final response.
      const source = sources[0]!, receipt: VerificationReceipt = { id: `e-original-${source.id}`, representation: 'exact-original',
        summary: { facts: [{ text: `Exact quoted ${source.kind} source (${source.reference}):\n${source.text}`, sources: [source.id] }], concerns: [] },
        children: [source.id], sourceIds: [source.id] };
      this.nodes.set(receipt.id, receipt); return [receipt];
    }
    try { return [await this.node(sources, scope, access)]; }
    catch (error) {
      access.assertCurrent();
      if (error instanceof VerificationSubdivisionError) {
        // A hard-to-reduce observation does not need an exponential tree of
        // new drafts. Keep its exact text in bounded children instead. Later
        // Jev requirement/quality checks still have to inspect and accept it.
        const retained: VerificationReceipt[] = [];
        for (const source of sources) for (let offset = 0; offset < source.text.length; offset += 5_000) {
          const text = source.text.slice(offset, offset + 5_000);
          const original = { ...source, completeMessage: !!source.completeMessage && offset === 0 && text.length === source.text.length,
            id: `s-${verificationHash([source.id, offset, text]).slice(0, 24)}`, reference: `${source.reference}; exact retained interval ${offset}..${offset + text.length}`, text };
          this.originals.set(original.id, original); this.store.rememberSource(original);
          const receipt: VerificationReceipt = { id: `e-original-${original.id}`, representation: 'exact-original',
            summary: { facts: [{ text: `Exact quoted ${original.kind} source (${original.reference}):\n${text}`, sources: [original.id] }], concerns: [] }, children: [original.id], sourceIds: [original.id] };
          this.nodes.set(receipt.id, receipt); retained.push(receipt);
        }
        return retained;
      }
      if (!(error instanceof VerificationSubdivisionError) && (!(error instanceof JudgmentError) || (error.kind !== 'rejected' && error.kind !== 'invalid-request'))) throw error;
      // Native request recovery: split the SAME source, keeping every interval.
      // No rejected transport request becomes a finding against the user's work.
      if (sources.length > 1) {
        const middle = Math.ceil(sources.length / 2);
        return [...await this.page(sources.slice(0, middle), scope, access), ...await this.page(sources.slice(middle), scope, access)];
      }
      const original = sources[0];
      if (!original || original.text.length < 1024) throw new VerificationHeldError('minimum source frame', { cause: error });
      const middle = Math.ceil(original.text.length / 2);
      const parts = [original.text.slice(0, middle), original.text.slice(middle)].map((text, index) => ({ ...original,
        reference: `${original.reference}; native subdivision ${index + 1}/2`, completeMessage: false, text,
        id: `s-${verificationHash([original.id, index, text]).slice(0, 24)}` }));
      parts.forEach(part => { this.originals.set(part.id, part); this.store.rememberSource(part); });
      return [...await this.page(parts.slice(0, 1), scope, access), ...await this.page(parts.slice(1), scope, access)];
    }
  }

  private compactNode(node: VerificationReceipt) { return { id: node.id, summary: node.summary, ...(node.representation ? { representation: node.representation } : {}) }; }
  private async merge(children: readonly VerificationReceipt[], scope: readonly VerificationRequirement[], access: VerificationAccess): Promise<VerificationReceipt[]> {
    if (children.length === 1) return [...children];
    const wire = children.map(child => ({ ...this.compactNode(child), children: [], sourceIds: [] }));
    try {
      const parent = await this.node(wire, scope, access);
      const retained = { ...parent, children: children.map(child => child.id), sourceIds: children.flatMap(child => child.sourceIds) };
      this.nodes.set(retained.id, retained); return [retained];
    } catch (error) {
      access.assertCurrent();
      // An irreducible summary has already used its two private proposals.
      // Route back to original retrieval instead of recursively drafting every
      // possible grouping of the same child summaries.
      if (error instanceof VerificationSubdivisionError) throw error;
      if (!(error instanceof JudgmentError) || (error.kind !== 'rejected' && error.kind !== 'invalid-request')) throw error;
      const middle = Math.ceil(children.length / 2);
      return [...await this.merge(children.slice(0, middle), scope, access), ...await this.merge(children.slice(middle), scope, access)];
    }
  }
  private async evidenceTree(sources: readonly VerificationSource[], scope: readonly VerificationRequirement[], access: VerificationAccess): Promise<VerificationReceipt[]> {
    const pages = verificationFrames(sources, VERIFICATION_FRAME_CHARACTERS, source => JSON.stringify(verificationWireSource(source)).length);
    let nodes = (await ownedMapLimit(access, pages, 3, page => this.page(page, scope, access))).flat();
    while (!bounded(nodes.map(node => this.compactNode(node)), VERIFICATION_OVERVIEW_CHARACTERS)) {
      // Only bounded summaries go over the wire. Full child/source ID sets stay
      // local, avoiding a growing duplicate index in every parent request.
      const groups = verificationFrames(nodes.map(node => this.compactNode(node)), 18_000);
      const next = (await ownedMapLimit(access, groups, 3, async group => {
        const children = group.map(item => this.nodes.get(item.id)!);
        return this.merge(children, scope, access);
      })).flat();
      if (JSON.stringify(next.map(node => this.compactNode(node))).length >= JSON.stringify(nodes.map(node => this.compactNode(node))).length)
        throw new VerificationSubdivisionError();
      nodes = next;
    }
    return nodes;
  }

  /** A deterministic retrieval index never asserts that work was performed.
   * Large sessions open relevant originals first, rather than writing hundreds
   * of private summaries before they can inspect the requested deliverable. */
  private sourceIndex(sources: readonly VerificationSource[]): VerificationReceipt[] {
    const describe = (source: VerificationSource) => ({ referencePreviewOnly: source.reference.slice(0, 240),
      executionPreviewOnly: source.execution ? JSON.stringify(source.execution).slice(0, 320) : null,
      previewOnly: { beginning: source.text.slice(0, 100), end: source.text.length > 100 ? source.text.slice(-100) : '' } });
    let nodes = verificationFrames(sources, VERIFICATION_FRAME_CHARACTERS, source => JSON.stringify(verificationWireSource(source)).length).map(page => {
      const id = `index-${verificationHash(page.map(source => source.id)).slice(0, 24)}`;
      const receipt: VerificationReceipt = { id, representation: 'source-index', children: [], sourceIds: page.map(source => source.id),
        summary: { facts: [{ text: JSON.stringify({ meaning: 'RETRIEVAL INDEX ONLY. Previews cannot prove completion or source contents. Open exact originals before judging.',
          locationPreviewsOnly: [...new Set(page.flatMap(source => source.text.match(/[\w./-]+/g) ?? []).filter(path => /\.(?:md|zip|tsx?|jsonl?)$/.test(path)))].slice(0, 8).map(path => path.slice(0, 96)),
          first: describe(page[0]!), last: describe(page.at(-1)!) }), sources: [] }], concerns: [] } };
      this.nodes.set(id, receipt); return receipt;
    }).reverse();
    while (!bounded(nodes.map(node => this.compactNode(node)), VERIFICATION_OVERVIEW_CHARACTERS)) {
      nodes = verificationFrames(nodes, 8_000, node => JSON.stringify(this.compactNode(node)).length).map(group => {
        const id = `index-${verificationHash(group.map(node => node.id)).slice(0, 24)}`;
        const receipt: VerificationReceipt = { id, representation: 'source-index', children: group.map(node => node.id), sourceIds: group.flatMap(node => node.sourceIds),
          summary: { facts: [{ text: `RETRIEVAL INDEX ONLY; ordered most recent first. First indexed interval: ${group[0]!.summary.facts[0]!.text.slice(0, 900)} Last indexed interval: ${group.at(-1)!.summary.facts[0]!.text.slice(0, 900)}`, sources: [] }], concerns: [] } };
        this.nodes.set(id, receipt); return receipt;
      });
    }
    return nodes;
  }

  private async audit(requirement: VerificationRequirement, caseEvidence: unknown, sources: readonly VerificationSource[], access: VerificationAccess,
    response: unknown, ledger: readonly VerificationRequirement[], audited: Set<string>, accounted: Set<string>): Promise<VerificationSource[][]> {
    const pages = verificationFrames(sources, VERIFICATION_FRAME_CHARACTERS, source => JSON.stringify(verificationWireSource(source)).length);
    const checks = await ownedMapLimit(access, pages, 3, async page => {
      // These sets belong to ONE exact source/requirement/answer/authority
      // cursor. Opening another immutable original does not undo a checked
      // page. A new source, changed scope, draft or owner starts another cursor.
      if (page.every(source => accounted.has(source.id))) return null;
      if (page.every(source => audited.has(source.id))) return page;
      const context = { requirement, response, caseEvidence, sources: page.map(verificationWireSource) };
      const key = verificationHash(['source-audit-v2', context]), cache = this.cache(access);
      if (cache.has(key)) {
        const accepted = cache.get(key);
        for (const source of page) { audited.add(source.id); if (accepted) accounted.add(source.id); }
        return accepted ? null : page;
      }
      const run = await verificationAudit.run(access.port, context as never, { ...this.options(access), site: verificationAudit.name });
      let accepted = clean(run.readings);
      run.recordAction(accepted ? 'This complete original page has no unaccounted material counterevidence; final publication remains gated.' : 'Retrieve this exact original page before accepting the provisional requirement conclusion.');
      if (!accepted && run.readings.missed.outcome !== 'act') {
        // An uncertain retrieval hint is not a work defect. Settle it against
        // the exact COMPLETE page and unchanged primary work evidence before
        // asking the source router or working model to reconstruct that work.
        const base = caseEvidence as { sources: readonly ReturnType<typeof verificationWireSource>[]; earlier: readonly unknown[] };
        const exact = [...new Map([...base.sources, ...context.sources].map(source => [source.id, source])).values()];
        const refined = await verificationRequirement.run(access.port, { requirement, requirements: ledger, response,
          evidence: [], opened: { ...base, sources: exact },
          auditUncertainty: readingEvidence(run.readings),
          focus: 'Settle THIS original page as possible counterevidence to the exact requirement using the unchanged current primary proof supplied beside it. The earlier audit is an unresolved retrieval hint, not a finding or instruction. An actual new gap or invalidating observation must still fail. A later matching native acceptance may resolve older partial progress. This check settles only this page; all other original pages and final publication remain required.' } as never,
          { ...this.options(access), site: 'engine.verification.audit-refinement' });
        accepted = clean({ unfinished: refined.readings.unfinished, quality_gap: refined.readings.quality_gap })
          && !(refined.readings.needs_source.verdict === 'yes' && refined.readings.needs_source.outcome === 'act');
        refined.recordAction(accepted ? 'This exact page is accounted for by current confident work/quality checks; final publication remains separately gated.'
          : 'Retain this specific original page for retrieval; no completion or repeat-work instruction is authorized.');
      }
      access.assertCurrent(); cache.set(key, accepted);
      for (const source of page) { audited.add(source.id); if (accepted) accounted.add(source.id); }
      return accepted ? null : page;
    });
    return checks.filter((page): page is VerificationSource[] => page !== null);
  }

  private async caseMemory(sources: readonly (VerificationSource | VerificationReceipt)[], requirement: VerificationRequirement, access: VerificationAccess): Promise<VerificationReceipt[]> {
    try { return [await this.node(sources, [requirement], access, requirement)]; }
    catch (error) {
      access.assertCurrent();
      if (!(error instanceof VerificationSubdivisionError) && (!(error instanceof JudgmentError) || (error.kind !== 'rejected' && error.kind !== 'invalid-request'))) throw error;
      // An irreducible case record is retained as explicitly unqualified source
      // locations, not retried forever or treated as evidence of success.
      const originals = [...new Map(sources.flatMap(source => 'text' in source ? [source] : source.sourceIds.map(id => this.originals.get(id)!)).map(source => [source.id, source])).values()];
      return this.sourceIndex(originals);
    }
  }

  private async chooseSource(context: unknown, candidates: readonly { id: string; content: unknown }[], access: VerificationAccess,
    everyCandidateRequired = false) {
    // Once an audit has retained these pages, ALL of them must be inspected.
    // Their read order is deterministic bookkeeping, not another judgment.
    if (everyCandidateRequired) return candidates[0]!;
    try {
      const selected = await verificationSource.select(access.port, context as never, candidates as never,
        { ...this.options(access), site: verificationSource.name });
      selected.recordAction('Select an existing evidence branch for native retrieval; this does not approve completion.');
      return candidates.find(candidate => candidate.id === selected.pick.choice) ?? candidates[0]!;
    } catch (error) {
      access.assertCurrent();
      if (!(error instanceof JudgmentError) || error.kind !== 'invalid-response') throw error;
      // A malformed routing response cannot approve anything. Opening an
      // already-admitted original is harmless and lets the real work/quality
      // questions settle it, without restarting the entire verification pass.
      return candidates[0]!;
    }
  }

  private async inspect(requirement: VerificationRequirement, ledger: readonly VerificationRequirement[], overview: readonly VerificationReceipt[], response: unknown, access: VerificationAccess, auditSources?: readonly VerificationSource[], defer = () => false, recent: readonly VerificationSource[] = [], previousReview: unknown = null, assessment?: RepairAssessment) {
    const key = verificationHash(['retrieval-v1', requirement, ledger, overview.map(node => this.compactNode(node)), response,
      auditSources?.map(source => source.id), recent.map(source => source.id), previousReview]);
    const cache = this.cache(access), retained = cache.get(key) as InspectionCursor | undefined;
    let frontier = retained ? [...retained.frontier] : [...overview];
    let opened: InspectionCursor['opened'] = retained ? { sources: [...retained.opened.sources], earlier: [...retained.opened.earlier] } : { sources: recent, earlier: [] };
    const seen = new Set(retained?.seen ?? recent.map(source => `source:${source.id}`));
    let localized = retained?.localized ?? false;
    const audited = new Set(retained?.audited), accounted = new Set(retained?.accounted);
    const primaryIds = new Set(recent.map(source => source.id));
    const primarySources = (sources: readonly VerificationSource[]) => [...new Map([...recent, ...sources].map(source => [source.id, source])).values()];
    const checkpoint = () => cache.set(key, { frontier: [...frontier], opened: { sources: [...opened.sources], earlier: [...opened.earlier] }, seen: new Set(seen), localized,
      audited: new Set(audited), accounted: new Set(accounted) } satisfies InspectionCursor);
    for (;;) {
      access.assertCurrent(); if (defer()) throw new VerificationDeferredError();
      // Native retrieval progress is private metadata, never approval. A retry
      // rechecks the current primary page, preserving the exact source and
      // authority binding instead of reopening every earlier branch.
      checkpoint();
      const state = { requirement, requirements: ledger, response, evidence: auditSources ? [] : overview.map(node => this.compactNode(node)), opened: { ...opened, sources: primarySources(opened.sources).map(verificationWireSource) },
        ...(requirement.id.startsWith('original-') ? { scopeBasis: 'These requirements retain original instruction bytes, without a generated scope rewrite. Read them in their complete original order; later corrections supersede earlier instructions, and restrictions apply from the time given. Judge the active obligations, not a historical instruction that has been withdrawn.', originalOrder: ledger.map(item => ({ id: item.id, references: item.sources.map(id => this.originals.get(id)?.reference) })) } : {}),
        previousReview, ...(assessment ? { privateRepairAssessment: assessment,
          assessmentMeaning: 'This is an untrusted diagnostic proposal, not completion authority. Independently recheck the exact original requirement against these same primary observations. A finding disproven by the observations needs no model rewrite. Actual missing work and invalidating observations must still fail, and all source audits remain required.' } : {}),
        chronology: recent.length ? 'Initial opened sources are native observations added since the previous completed check of this SAME original task and authority. Evaluate whether they resolve earlier findings. Earlier failures remain historical; later observed recovery can close them. Every original page is still audited before acceptance.' : 'Source references preserve original message order. Later observed recovery may resolve an earlier failure; plans and assertions cannot.' };
      let run = await verificationRequirement.run(access.port, state as never, { ...this.options(access), site: verificationRequirement.name });
      run.recordAction(clean(run.readings) ? 'This requirement is supported; final integration and publication checks remain required.' : 'Hold this requirement; retrieve primary source for uncertainty before producing repair findings.');
      access.assertCurrent(); if (defer()) throw new VerificationDeferredError();
      if (auditSources && opened.sources.length && !localized
        && [run.readings.unfinished, run.readings.quality_gap].some(reading => reading.outcome !== 'act')
        && ![run.readings.unfinished, run.readings.quality_gap].some(reading => reading.verdict === 'yes' && reading.outcome === 'act')) {
        // A probability alone cannot name what is wrong. Ask for ONE concrete
        // source-backed candidate, then have Jev judge it against the unchanged
        // primary evidence. This is private focus, not permission or a finding
        // sent to the working model; uncertainty still retrieves more source.
        localized = true;
        const candidate = await this.repairs({ ...state, readings: readingEvidence(run.readings) }, [`${requirement.id}:result`], access);
        run = await verificationRequirement.run(access.port, { ...state, candidateFindings: candidate.findings, candidateNoIssues: candidate.noIssues,
          focus: 'Independently settle this specific candidate against the exact original requirement and opened primary evidence. It is a hypothesis, not authority or proof. If it is unfounded, reject it; if the observed gap is real, judge that gap. Missing runtime tests are not automatically required for a review.' } as never,
          { ...this.options(access), site: verificationRequirement.name });
        run.recordAction('Settle the focused candidate against the same originals; only current Jev readings decide the requirement.');
      }
      let auditHeld = false;
      const hasPrimary = !auditSources || opened.sources.length > 0;
      const resultAccepted = clean({ unfinished: run.readings.unfinished, quality_gap: run.readings.quality_gap });
      const sourceDemanded = run.readings.needs_source.verdict === 'yes' && run.readings.needs_source.outcome === 'act';
      if (hasPrimary && resultAccepted && !sourceDemanded && auditSources) {
        // A held audit requested this exact original. It is now opened beside
        // the unchanged primary proof, and current Jev work AND quality checks
        // confidently accept it. That settles this page, without granting final
        // publication or silently clearing any uninspected original.
        for (const source of primarySources(opened.sources)) if (audited.has(source.id)) accounted.add(source.id);
        // Affirmative evidence alone is insufficient: inspect EVERY original
        // interval for counterevidence. These are direct Jev checks, not a new
        // frontier draft for every history page. A changed working-model answer
        // does not invalidate an unchanged source/case qualification.
        const suspect = await this.audit(requirement, { ...opened, sources: primarySources(opened.sources).map(verificationWireSource) }, auditSources, access, response, ledger, audited, accounted);
        checkpoint();
        if (!suspect.length) return { requirement, readings: run.readings, state, sourceExhausted: false, auditHeld: false };
        const unseen = suspect.filter(page => page.some(source => !seen.has(`source:${source.id}`)));
        if (!unseen.length) return { requirement, readings: run.readings,
          state: { ...state, sourceGap: 'Original-page audit still identifies unaccounted material counterevidence in the exact retrieved sources. Resolve the specific contradiction or missing observation; do not rewrite unchanged reports.' }, sourceExhausted: true, auditHeld: true };
        frontier = [...this.sourceIndex(unseen.flat()), ...frontier];
        auditHeld = true;
      }
      if (hasPrimary && !auditHeld && run.readings.needs_source.verdict === 'no' && run.readings.needs_source.outcome === 'act') return { requirement, readings: run.readings, state, sourceExhausted: false, auditHeld: false };
      if (hasPrimary && !sourceDemanded && [run.readings.unfinished, run.readings.quality_gap].some(reading => reading.verdict === 'yes' && reading.outcome === 'act'))
        return { requirement, readings: run.readings, state, sourceExhausted: false, auditHeld: false };
      for (;;) {
        access.assertCurrent(); if (defer()) throw new VerificationDeferredError();
        const candidates = [...new Map(frontier.filter(node => !seen.has(node.id)).map(node => [node.id, node])).values()].map(node => ({ id: node.id, content: this.compactNode(node) }));
        // Retrieval is a routing decision, not another acceptance criterion.
        // Once all originals have been inspected, an uncertain desire for more
        // source cannot send a Jev-accepted result back for pointless repairs.
        if (!candidates.length && resultAccepted && !sourceDemanded && !auditHeld && !auditSources)
          return { requirement, readings: run.readings, state, sourceExhausted: false, auditHeld: false };
        if (!candidates.length) return { requirement, readings: run.readings, state: { ...state,
          sourceGap: 'All retained source branches were inspected. Name the specific missing admissible observation needed for this requirement; obtain that evidence with tools instead of rewriting the same report.' }, sourceExhausted: true, auditHeld };
        const selected = await this.chooseSource({ requirement, readings: readingEvidence(run.readings), opened: { ...opened, sources: opened.sources.map(verificationWireSource) } }, candidates, access, auditHeld);
        // Choosing which already-admitted local evidence to inspect is harmless.
        // An uncertain fit can never approve completion, but must not prevent us
        // from opening that candidate and obtaining a decisive primary reading.
        seen.add(selected.id);
        const node = this.nodes.get(selected.id)!;
        const children = node.children.map(id => this.nodes.get(id)).filter((entry): entry is VerificationReceipt => !!entry);
        if (children.length) { frontier = [...children, ...frontier.filter(entry => entry.id !== node.id)]; continue; }
        else {
          const sources = node.sourceIds.map(id => this.originals.get(id)!);
          sources.forEach(source => seen.add(`source:${source.id}`));
          // The leaf was built from a bounded frame; inspect its ORIGINAL middle,
          // not just its summary. Retain prior retrieval as a checked case record
          // so a later opening cannot forget evidence needed for this requirement.
          // The bounded current tool results and host acceptance are permanent
          // primaries for this case. Retrieving old counterevidence must never
          // replace them with a lossy summary and resurrect a resolved gap.
          const previous = opened.sources.filter(source => !primaryIds.has(source.id));
          const combined = [...new Map([...previous, ...sources].map(source => [source.id, source])).values()];
          // Keep a useful exact case window. Jev supports long-context input;
          // forcing a new frontier summary for every 32k page both loses
          // cross-page proof and spends far more time rewriting old evidence
          // than judging the user's result. The wire still checks its budget.
          if (bounded(primarySources(combined).map(verificationWireSource), MAX_EXACT_CASE_CHARACTERS)) {
            opened = { sources: combined, earlier: opened.earlier };
            checkpoint();
            break;
          }
          const prior = previous.length ? await this.caseMemory(previous, requirement, access) : [];
          let earlier = [...opened.earlier, ...prior.map(node => this.compactNode(node))];
          if (!bounded(earlier, 8_000)) {
            const merged = await this.caseMemory(earlier.map(item => this.nodes.get(item.id)!), requirement, access);
            earlier = merged.map(node => this.compactNode(node));
          }
          opened = { sources, earlier };
          checkpoint();
          break;
        }
      }
    }
  }

  private async repairs(evidence: unknown, checks: readonly string[], access: VerificationAccess): Promise<RepairAssessment> {
    const context = { evidence, checks, maxCharacters: 8_000 };
    const admit = (value: Record<string, unknown>): RepairAssessment => {
      const noIssues = value.noIssues ?? [];
      if (!bounded(value, 8_000) || !Array.isArray(value.findings) || !Array.isArray(noIssues)
        || value.findings.length + noIssues.length !== checks.length) throw new Error('Account for each held check with a concrete finding or a cited no-issue assessment');
      const seen = new Set<string>();
      const findings = value.findings.map((raw: unknown) => {
        const finding = raw as CompletionFinding | null;
        if (!finding || !checks.includes(finding.check) || seen.has(finding.check)
          || ![finding.issue, finding.repair, finding.resolvedWhen, finding.passage?.reference, finding.passage?.quote].every(text => typeof text === 'string' && !!text.trim())) throw new Error('Invalid repair findings');
        seen.add(finding.check);
        for (const field of [finding.preserve, finding.remaining]) if (field !== undefined && (!Array.isArray(field) || !field.every(text => typeof text === 'string' && !!text.trim()))) throw new Error('Preserved and remaining work must be concrete text items');
        return { check: finding.check, issue: finding.issue, repair: finding.repair, resolvedWhen: finding.resolvedWhen, passage: finding.passage!,
          ...(finding.preserve ? { preserve: finding.preserve } : {}), ...(finding.remaining ? { remaining: finding.remaining } : {}) };
      });
      const cleared = noIssues.map((raw: unknown) => {
        const item = raw as RepairAssessment['noIssues'][number] | null;
        if (!item || !checks.includes(item.check) || seen.has(item.check)
          || ![item.reason, item.passage?.reference, item.passage?.quote].every(text => typeof text === 'string' && !!text.trim()))
          throw new Error('A no-issue assessment needs its unique held check and exact source basis');
        seen.add(item.check);
        return { check: item.check, reason: item.reason, passage: item.passage };
      });
      return { findings, noIssues: cleared };
    };
    const key = verificationHash(['repairs-v2', context]);
    let candidate = this.store.proposals.get(key), repair: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      access.assertCurrent();
      if (candidate === undefined) {
        try { candidate = await this.writer({ operation: 'findings', context, repair, signal: access.signal, assertCurrent: access.assertCurrent }); }
        catch (error) { access.assertCurrent(); throw new VerificationHeldError('private finding provider', { cause: error }); }
      }
      let proposed: RepairAssessment;
      try { proposed = admit(parse(candidate)); }
      catch { candidate = undefined; repair = { problem: 'Account for each supplied check ID exactly once, either with a concrete cited finding or a cited noIssues assessment. Do not invent work when no defect is supported.' }; continue; }
      const runs = await Promise.all([
        ...(proposed.findings.length ? [verificationRepairs.run(access.port, { ...context, proposed: proposed.findings } as never,
          { ...this.options(access), site: verificationRepairs.name })] : []),
        ...proposed.noIssues.map(diagnosis => verificationNoIssue.run(access.port, { evidence, diagnosis } as never,
          { ...this.options(access), site: verificationNoIssue.name })),
      ]);
      for (const run of runs) run.recordAction(clean(run.readings) ? 'Admit this private diagnosis; no-issue assessments require fresh native checks and never become working-model repairs.' : 'Repair the private diagnosis against the same scope, evidence and readings.');
      if (runs.every(run => clean(run.readings))) { this.store.rememberProposal(key, candidate); return proposed; }
      if (runs.every(run => Object.values(run.readings).every(reading => !(reading.verdict === 'yes' && reading.outcome === 'act')))) {
        // This is private diagnostic guidance, not execution authority or a new
        // acceptance requirement. An unsettled localization should prompt one
        // precise investigation, not endless rewrites of the same fix list.
        return { noIssues: proposed.noIssues, findings: proposed.findings.map(finding => ({ ...finding, localization: 'candidate-to-investigate', issue: `Unresolved candidate: ${finding.issue}`,
          repair: `First establish whether this specific concern is real from its primary sources. If supported: ${finding.repair} Discard it when disproven; do not add requirements.`,
          resolvedWhen: `The original requirement is fulfilled and the cited concern is resolved or disproven. ${finding.resolvedWhen}` })) };
      }
      repair = { proposed, readings: runs.map(run => readingEvidence(run.readings)), instruction: 'Remove invented or ineffective repairs. Give only the specific correction justified by the original requirement and primary evidence.' };
      candidate = undefined;
    }
    const original = evidence as { requirement?: VerificationRequirement; requirements?: unknown };
    const requirement = original.requirement?.text ?? JSON.stringify(original.requirements);
    return { noIssues: [], findings: checks.map(check => ({ check, issue: `Unresolved ${check} reading for original requirement: ${requirement}`,
      repair: `Inspect the primary implementation or artifact implicated by this exact requirement and settle the reading: ${requirement}. Do not repeat unchanged report/hash/log checks, add work, or treat an uncertain reading as a proven defect.`,
      resolvedWhen: 'Relevant primary observations establish the original requested result; disproven or irrelevant concerns are closed.',
      passage: { reference: original.requirement?.sources.join(', ') ?? 'original requirements', quote: requirement }, localization: 'unavailable' })) };
  }

  /** Final-gate ambiguity is resolved by opening primary evidence natively,
   * before asking the working model to change its draft or redo any work. */
  async openFinal(state: unknown, readings: unknown, access: VerificationAccess): Promise<boolean> {
    return this.ownedAttempt(access, local => this.openFinalAttempt(state, readings, local));
  }
  private async openFinalAttempt(state: unknown, readings: unknown, access: VerificationAccess): Promise<boolean> {
    const evidence = this.finalEvidence;
    if (!evidence) return false;
    for (;;) {
      access.assertCurrent();
      const candidates = [...new Map(evidence.frontier.filter(node => !evidence.seen.has(node.id)).map(node => [node.id, node])).values()].map(node => ({ id: node.id, content: this.compactNode(node) }));
      if (!candidates.length) return false;
      const labels = Object.fromEntries(Object.entries(readings as Record<string, Record<string, { verdict: string; outcome: string }> | null>).map(([aspect, values]) => [aspect, values ? readingEvidence(values) : null]));
      const choice = await this.chooseSource({ requirement: 'Settle these held FINAL publication readings against the exact current draft and original request.', readings: labels, evidence: state }, candidates, access);
      evidence.seen.add(choice.id);
      const node = this.nodes.get(choice.id)!;
      const children = node.children.map(id => this.nodes.get(id)).filter((entry): entry is VerificationReceipt => !!entry);
      if (children.length) { evidence.frontier = [...children, ...evidence.frontier.filter(entry => entry.id !== node.id)]; continue; }
      if (evidence.opened.length) {
        const requirement: VerificationRequirement = { id: 'final-publication', text: 'Settle the exact current draft against the original request, required result, and held final publication readings.', sources: [] };
        evidence.earlier.push(...await this.caseMemory(evidence.opened, requirement, access));
        if (!bounded(evidence.earlier.map(node => this.compactNode(node)), 8_000)) evidence.earlier = await this.caseMemory(evidence.earlier, requirement, access);
      }
      evidence.opened = node.sourceIds.map(id => this.originals.get(id)!);
      return true;
    }
  }

  private originalMessages(sources: readonly VerificationSource[]) {
    return sources.map(source => {
      if (source.messageRole && source.completeMessage && typeof verificationWireSource(source).text === 'string') {
        try {
          const message = JSON.parse(source.text) as Record<string, unknown>;
          if (message && message.role === source.messageRole) return { ...message, evidenceOrigin: 'exact retrieved original message', sourceReference: source.reference, sourceId: source.id };
        } catch { /* Plain source text remains an exact identified source. */ }
      }
      return { role: 'system', content: { retrievedOriginalSource: verificationWireSource(source) } };
    });
  }

  async prepare(full: Record<string, unknown>, access: VerificationAccess): Promise<{ state: Record<string, unknown>; findings: readonly CompletionFinding[] }> {
    return this.ownedAttempt({ ...access, port: bindVerificationTargets(access.port) }, local => this.prepareAttempt(full, local));
  }
  private async prepareAttempt(full: Record<string, unknown>, access: VerificationAccess): Promise<{ state: Record<string, unknown>; findings: readonly CompletionFinding[] }> {
    access.assertCurrent();
    const sources = verificationSources(full);
    for (const [position, source] of sources.entries()) { this.originals.set(source.id, source); this.sourceOrder.set(source.id, position); this.store.rememberSource(source); }
    const ledger = await this.ledger(sources.filter(source => source.kind === 'instruction'), access);
    const observations = sources.filter(source => source.kind !== 'answer');
    let indexed = observations.reduce((total, source) => total + source.text.length, 0) > 250_000;
    let overview: VerificationReceipt[];
    if (indexed) overview = this.sourceIndex(observations);
    else {
      try { overview = await this.ownedAttempt(access, local => this.evidenceTree(observations, ledger, local)); }
      catch (error) {
        access.assertCurrent();
        if (!(error instanceof VerificationSubdivisionError)) throw error;
        // A checked summary tree which cannot shrink is a retrieval problem,
        // not a reason to regenerate the same proposals indefinitely. Retain
        // all originals and use the same mandatory primary/history audits as
        // the large-history path; an index never becomes completion evidence.
        indexed = true; overview = this.sourceIndex(observations);
      }
    }
    const requestKey = verificationHash(full.request), previous = this.previousSources;
    const added = indexed && previous?.identity === access.identity && previous.request === requestKey ? observations.filter(source => !previous.ids.has(source.id) && source.kind === 'observation') : [];
    const acceptance = new Map<string, VerificationSource[]>();
    for (const source of observations) {
      if (!source.reference.startsWith('host completed contract ')) continue;
      const boundary = source.reference.indexOf('; acceptance and publication;');
      if (boundary < 0) continue;
      const contract = source.reference.slice(0, boundary);
      const pages = acceptance.get(contract) ?? []; pages.push(source); acceptance.set(contract, pages);
    }
    // Begin with bounded actual host acceptance evidence instead of an empty
    // packet or an obsolete partial-progress page. This changes retrieval
    // order only: every original remains available and the complete-history
    // counterevidence audit and final-response checks are still mandatory.
    // Keep one contract's scope/check/publication pages together. Packing an
    // earlier failed contract ahead of the current one can otherwise leave
    // only the tail of the current receipt in the last frame.
    const preferred = [...acceptance.values()].at(-1);
    const hostPrimary = preferred
      ? verificationFrames(preferred, VERIFICATION_FRAME_CHARACTERS, source => JSON.stringify(verificationWireSource(source)).length)[0] ?? []
      : [];
    const hostReference = hostPrimary[0]?.reference.split('; acceptance and publication;')[0];
    const savedAnswer = hostReference ? observations.filter(source => source.reference.startsWith(`${hostReference}; exact saved answer;`)) : [];
    const answerFrames = verificationFrames(savedAnswer, VERIFICATION_FRAME_CHARACTERS, source => JSON.stringify(verificationWireSource(source)).length);
    // The approval digest alone does not tell a reader WHICH result was
    // approved. Keep a bounded saved answer intact beside its exact receipt;
    // otherwise older partial work displaces the accepted result itself.
    const checkedAnswer = answerFrames.length <= 2 ? answerFrames.flat() : [...answerFrames[0]!, ...answerFrames.at(-1)!];
    const initial = full.initial as { transcript?: readonly Record<string, unknown>[] } | null;
    const earlierCalls = new Set((initial?.transcript ?? []).filter(message => message.role === 'tool').map(message => message.callId));
    const currentCalls = new Set((initial?.transcript ? (full.transcript ?? []) as readonly Record<string, unknown>[] : [])
      .filter(message => message.role === 'tool' && typeof message.callId === 'string' && !earlierCalls.has(message.callId)).map(message => message.callId));
    const currentResults = observations.filter(source => source.execution && currentCalls.has(source.execution.callId));
    const executions = new Map<unknown, VerificationSource[]>();
    for (const source of currentResults) {
      const id = source.execution!.callId, pages = executions.get(id) ?? [];
      pages.push(source); executions.set(id, pages);
    }
    const latestExecution = [...executions.values()].at(-1);
    const resultFrames = verificationFrames(latestExecution ?? added, VERIFICATION_FRAME_CHARACTERS,
      source => JSON.stringify(verificationWireSource(source)).length);
    // Keep a bounded latest execution intact, including its result header and
    // trailer. Taking only its last frame can hide counts/status at the start
    // and make the verifier request the exact same successful inspection again.
    // Larger executions retain explicitly partial first/last frames; every
    // intervening original remains available to native retrieval.
    const latestResults = latestExecution
      ? resultFrames.length <= 2 ? resultFrames.flat() : [...resultFrames[0]!, ...resultFrames.at(-1)!]
      : resultFrames.at(-1) ?? [];
    // Bounded exact upstream acceptance/result and current tool observations.
    // None of them is a permit to publish this turn's proposed response.
    const recent = [...new Map([...hostPrimary, ...checkedAnswer, ...latestResults].map(source => [source.id, source])).values()];
    const rememberSources = () => { this.previousSources = { identity: access.identity, request: requestKey, ids: new Set(sources.map(source => source.id)) }; };
    const key = verificationHash([sources.map(source => source.id), ledger, full.response, overview.map(node => this.compactNode(node))]);
    if (this.finalEvidence?.key !== key || this.finalEvidence.identity !== access.identity)
      this.finalEvidence = { key, identity: access.identity, frontier: [...overview], seen: new Set(), opened: [], earlier: [] };
    const answer = bounded(full.response, 12_000) ? full.response : { proposedAnswer: (await this.evidenceTree(sources.filter(source => source.kind === 'answer'), ledger, access)).map(node => this.compactNode(node)),
      meaning: 'Exact proposed answer checked in identified original answer pages. These are proposed claims, not evidence of performed work.' };
    const casesKey = verificationHash(['requirement-checks-v2', ledger, overview.map(node => this.compactNode(node)), answer, recent.map(source => source.id), full.previousReview ?? null]);
    const cache = this.cache(access);
    let cases = cache.get(casesKey) as Awaited<ReturnType<CompletionVerification['inspect']>>[] | undefined;
    if (!cases) {
      let confirmedGap = false;
      const pending = new Set<AbortController>();
      const checked = await ownedMapLimit(access, ledger, 3, async requirement => {
        if (indexed && confirmedGap) return null;
        const resultKey = verificationHash([casesKey, requirement.id]);
        const retained = cache.get(resultKey) as Awaited<ReturnType<CompletionVerification['inspect']>> | undefined;
        const controller = new AbortController(); pending.add(controller);
        const local = indexed ? { ...access, signal: access.signal ? AbortSignal.any([access.signal, controller.signal]) : controller.signal,
          assertCurrent: () => { access.signal?.throwIfAborted(); access.assertCurrent(); if (controller.signal.aborted) throw new VerificationDeferredError(); } } : access;
        try {
          const entry = retained ?? await this.inspect(requirement, ledger, overview, answer, local, indexed ? observations : undefined, () => indexed && confirmedGap, recent, full.previousReview ?? null);
          local.assertCurrent(); cache.set(resultKey, captureStrictJudgmentJson(entry));
          if ([entry.readings.unfinished, entry.readings.quality_gap].some(reading => reading.verdict === 'yes' && reading.outcome === 'act')) {
            confirmedGap = true;
            if (indexed) for (const other of pending) if (other !== controller) other.abort(new VerificationDeferredError());
          }
          return entry;
        } catch (error) {
          access.signal?.throwIfAborted(); access.assertCurrent();
          if (error instanceof VerificationDeferredError || indexed && confirmedGap && controller.signal.aborted) return null;
          throw error;
        } finally { pending.delete(controller); }
      });
      cases = checked.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      access.assertCurrent(); cache.set(casesKey, captureStrictJudgmentJson(cases));
    }
    const findings: CompletionFinding[] = [];
    const caseFindings = await ownedMapLimit(access, cases.map((entry, index) => ({ entry, index })), 3, async ({ entry, index }) => {
      const failed = Object.entries(entry.readings).filter(([name, reading]) => (name !== 'needs_source' || entry.sourceExhausted) && (reading.verdict !== 'no' || reading.outcome !== 'act'));
      if (!failed.length && !entry.auditHeld) return [];
      const assessment = await this.repairs({ ...entry.state, readings: readingEvidence(entry.readings) }, [`${entry.requirement.id}:result`], access);
      if (!assessment.noIssues.length) return assessment.findings;
      // A diagnosis of "no defect" is not a repair instruction and cannot
      // settle a held gate. Reuse the exact retrieval cursor and independently
      // recheck the requirement, quality and every remaining original audit.
      const rechecked = await this.inspect(entry.requirement, ledger, overview, answer, access,
        indexed ? observations : undefined, () => false, recent, full.previousReview ?? null, assessment);
      const stillHeld = rechecked.auditHeld || Object.entries(rechecked.readings).some(([name, reading]) =>
        (name !== 'needs_source' || rechecked.sourceExhausted) && (reading.verdict !== 'no' || reading.outcome !== 'act'));
      if (stillHeld) throw new VerificationHeldError('native requirement remains unsettled without an actionable repair');
      cases![index] = rechecked;
      cache.set(verificationHash([casesKey, entry.requirement.id]), captureStrictJudgmentJson(rechecked));
      return [];
    });
    cache.set(casesKey, captureStrictJudgmentJson(cases));
    findings.push(...caseFindings.flat());
    if (findings.length) {
      access.assertCurrent();
      rememberSources();
      return { state: { requirements: ledger, response: answer, verification: { heldRequirements: findings.map(finding => finding.check), publicationAllowed: false } }, findings };
    }
    const primary = indexed ? [...new Map(cases.flatMap(entry => entry.state.opened.sources.map(source => source.id)).map(id => [id, this.originals.get(id)!])).values()] : [];
    // Earlier case records were already qualified against their originals.
    // Re-expanding their source IDs and summarizing all of them again at the
    // publication boundary repeats the entire retrieval/reduction workload.
    // Preserve the existing records and their explicit provenance instead.
    const earlierEvidence = indexed ? [...new Map(cases.flatMap(entry => entry.state.opened.earlier)
      .map(node => [node.id, this.nodes.get(node.id)!])).values()] : [];
    // Already bounded exact primaries need no additional summary proposal.
    // Requirement/quality checks and the complete-history audit qualified the
    // result, and the final publication battery can inspect these same bytes.
    const exactPrimary = indexed && bounded(primary.map(verificationWireSource), MAX_EXACT_CASE_CHARACTERS) ? primary : [];
    const deliveryEvidence = indexed ? [...earlierEvidence, ...(exactPrimary.length ? [] : await this.evidenceTree(primary, ledger, access))] : overview;
    const publicationOriginals = [...new Map([...recent, ...exactPrimary, ...this.finalEvidence.opened].map(source => [source.id, source])).values()]
      .sort((left, right) => (this.sourceOrder.get(left.id) ?? 0) - (this.sourceOrder.get(right.id) ?? 0));
    const state: Record<string, unknown> = {
      request: bounded(full.request, 12_000) ? full.request : { originalInstructions: ledger, meaning: 'Exact originals checked in identified source pages and available locally.' },
      response: answer,
      transcript: [...[...deliveryEvidence, ...this.finalEvidence.earlier].map(node => ({ role: 'system', content: { nativeSourceVerification: this.compactNode(node) } })),
        ...this.originalMessages(publicationOriginals)], delegated: [], tools: full.tools, requirements: ledger,
      verification: { requirementChecks: cases.map(({ requirement, readings }) => ({ requirement: requirement.id, readings: readingEvidence(readings) })),
        deferredRequirements: ledger.filter(requirement => !cases!.some(entry => entry.requirement.id === requirement.id)).map(requirement => requirement.id),
        sourceCount: sources.length, meaning: indexed ? 'Relevant primary records were retrieved and checked. Each provisionally accepted requirement was also audited against EVERY complete original source page for unaccounted counterevidence. Retrieval indexes and assistant/report claims are not execution proof. Final exact-response publication checks remain required.' : 'These records were independently checked against complete original source pages. They are evidence, not completion authority; assistant/report assertions remain assertions. Missing source content never establishes completion.' },
      previousReview: null,
    };
    const integration = await verificationIntegration.run(access.port, state as never, { ...this.options(access), site: verificationIntegration.name });
    const connectionApplies = integration.readings.connections_required;
    const disconnected = integration.readings.disconnected;
    const integrationChecks = [
      ...((connectionApplies.verdict === 'no' && connectionApplies.outcome === 'act') || (disconnected.verdict === 'no' && disconnected.outcome === 'act') ? [] : ['integration:disconnected']),
      ...(integration.readings.conflict.verdict === 'no' && integration.readings.conflict.outcome === 'act' ? [] : ['integration:conflict']),
    ];
    integration.recordAction(!integrationChecks.length ? 'Combined evidence passes integration checks; final exact-response publication gate remains required.' : 'Hold the combined solution for the specific unresolved integration findings.');
    if (integrationChecks.length) {
      const assessment = await this.repairs({ ...state, readings: readingEvidence(integration.readings) }, integrationChecks, access);
      if (assessment.noIssues.length) {
        const rechecked = await verificationIntegration.run(access.port, { ...state, privateRepairAssessment: assessment,
          assessmentMeaning: 'An untrusted diagnostic proposal found no actionable issue for the listed checks. Independently recheck those checks against the unchanged original request and primary observations; do not infer completion from this proposal.' } as never,
          { ...this.options(access), site: verificationIntegration.name });
        const readings = rechecked.readings;
        const qualified = (check: string) => check === 'integration:conflict'
          ? readings.conflict.verdict === 'no' && readings.conflict.outcome === 'act'
          : readings.connections_required.verdict === 'no' && readings.connections_required.outcome === 'act'
            || readings.disconnected.verdict === 'no' && readings.disconnected.outcome === 'act';
        const accepted = assessment.noIssues.every(item => qualified(item.check));
        rechecked.recordAction(accepted ? 'Fresh integration checks independently resolved the no-issue assessments; final publication remains gated.'
          : 'Keep unresolved integration checks native; do not send a no-defect diagnosis as a model repair.');
        if (!accepted) throw new VerificationHeldError('native integration remains unsettled without an actionable repair');
      }
      findings.push(...assessment.findings);
    }
    access.assertCurrent();
    rememberSources();
    return { state, findings };
  }
}
