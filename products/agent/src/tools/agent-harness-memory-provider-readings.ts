import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { routingRegistry, atRestCredential, memoryCredentialState, memoryLiveStatus, memoryProviderSelect, memoryReceiptMember, memoryRouteRole, memorySchemaCertified } from '@goodvibes-jev/engine/sdk/platform/routing';
import { findCredentialCandidates } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, personalOpsEntry, personalOpsJson } from './agent-harness-personal-ops-source.ts';

/** The invocation's native callbacks and source owner remain the same through producer reads and final publication. */
export function retainMemoryReadingOptions(original: CatalogRankingOptions): CatalogRankingOptions {
  const fieldsCurrent = captureCatalogMethods(original, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  const signal = original.signal, sourceOwner = original.sourceOwner, caller = original.assertCurrent, retain = original.retainCurrent;
  const callerCurrent = caller ? captureCatalogMethods(caller, ['call']) : undefined;
  const retainCurrent = retain ? captureCatalogMethods(retain, ['call']) : undefined;
  const assertSource = () => { fieldsCurrent(); callerCurrent?.(); retainCurrent?.(); signal?.throwIfAborted(); };
  const assertCurrent = () => {
    assertSource(); const result: unknown = caller?.call(original); assertSource();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
  };
  const retainGuard = (guard: () => void, key?: string) => {
    assertSource(); const result: unknown = retain?.call(original, guard, key); assertSource();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
  };
  assertCurrent(); retainGuard(assertSource, 'agent.memory.reading-options');
  return { signal, sourceOwner, assertCurrent, retainCurrent: retainGuard,
    ...(original.requirePreservedSource === undefined ? {} : { requirePreservedSource: original.requirePreservedSource }) };
}

export function assertMemoryCurrent(options: CatalogRankingOptions): void {
  options.signal?.throwIfAborted();
  const result: unknown = options.assertCurrent?.();
  if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
  options.signal?.throwIfAborted();
}

function captureMemoryAuthority(decision: object & { readonly name: string }, current: CatalogRankingOptions) {
  const site = decision.name;
  const registryCurrent = captureCatalogMethods(routingRegistry, ['get']);
  const decisionCurrent = captureCatalogMethods(decision, ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'run', 'select', 'instructions', 'fitInstructions']);
  const semanticFields = () => ({ items: modelReadingServicePath(decision, ['items']), instructions: modelReadingServicePath(decision, ['instructions']), fitInstructions: modelReadingServicePath(decision, ['fitInstructions']) });
  const definition = capturePersonalOpsSnapshot(semanticFields());
  const assertDefinition = () => {
    registryCurrent(); decisionCurrent(); definition.assertCurrent(semanticFields());
    if (routingRegistry.get(site) !== decision) throw new ToolInputProjectionError('held');
  };
  assertDefinition(); current.retainCurrent?.(assertDefinition, `agent.memory.definition:${site}`);
  return captureJudgmentPort(site, { signal: current.signal, assertCurrent: () => { assertMemoryCurrent(current); assertDefinition(); }, prepareResultCapture: prepareJudgmentResult });
}

export async function readMemoryRouteRole(source: unknown, options: CatalogRankingOptions) {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource(source, retained, async (captured, current) => {
    const site = memoryRouteRole.name;
    const authority = captureMemoryAuthority(memoryRouteRole, current);
    try {
      const run = await memoryRouteRole.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only published external-memory operation role');
      const role = run.readings.role, form = run.readings.form;
      if (role.outcome !== 'act' || form.outcome !== 'act' || (role.choice === 'none') !== (form.choice === 'none')) throw new ToolInputProjectionError('held');
      return { role: role.choice, form: form.choice };
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}

export async function readMemoryCredentialState(source: unknown, options: CatalogRankingOptions) {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource(source, retained, async (captured, current) => {
    const site = memoryCredentialState.name;
    const authority = captureMemoryAuthority(memoryCredentialState, current);
    try {
      const run = await memoryCredentialState.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only published external-memory authentication posture');
      if (run.readings.state.outcome !== 'act') throw new ToolInputProjectionError('held');
      return run.readings.state.choice === 'unknown' ? null : run.readings.state.choice;
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}

export async function readMemoryLiveStatus(source: unknown, options: CatalogRankingOptions) {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource(source, retained, async (captured, current) => {
    const site = memoryLiveStatus.name;
    const authority = captureMemoryAuthority(memoryLiveStatus, current);
    try {
      const run = await memoryLiveStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only published external-memory provider status');
      if (run.readings.status.outcome !== 'act') throw new ToolInputProjectionError('held');
      return run.readings.status.choice;
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}

export async function readMemoryReceiptMember(source: unknown, options: CatalogRankingOptions): Promise<boolean> {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource(source, retained, async (captured, current) => {
    const site = memoryReceiptMember.name;
    const authority = captureMemoryAuthority(memoryReceiptMember, current);
    try {
      const run = await memoryReceiptMember.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only external-memory receipt membership');
      const reading = run.readings.member;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
      return reading.verdict === 'yes';
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}

export async function readMemorySchemaCertified(source: unknown, options: CatalogRankingOptions): Promise<boolean> {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource(source, retained, async (captured, current) => {
    const site = memorySchemaCertified.name;
    const authority = captureMemoryAuthority(memorySchemaCertified, current);
    try {
      const run = await memorySchemaCertified.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only untyped external-memory schema publication claim');
      const reading = run.readings.certified;
      if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new ToolInputProjectionError('held');
      return reading.verdict === 'yes';
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}

/** The complete source is already locally protected; only admitted candidate spans may enter this reader. */
export async function readMemoryPublicText(source: string, options: CatalogRankingOptions): Promise<string> {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource({ text: source }, retained, async (captured, current) => {
    const candidates = findCredentialCandidates(captured.text);
    if (candidates.length === 0) return captured.text;
    const site = atRestCredential.name;
    const authority = captureMemoryAuthority(atRestCredential, current);
    try {
      let output = '', offset = 0;
      for (const candidate of candidates) {
        const run = await atRestCredential.run(authority.port, { span: candidate.value, context: captured.text }, { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
        authority.assertCurrent();
        const clear = run.readings.credential.verdict === 'no';
        run.recordAction(clear ? 'keep public external-memory metadata span' : 'mask external-memory metadata span');
        output += captured.text.slice(offset, candidate.start) + (clear ? candidate.value : candidate.marker); offset = candidate.end;
      }
      authority.assertCurrent(); return output + captured.text.slice(offset);
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}

export async function selectMemoryProvider<T>(providers: readonly T[], query: string, options: CatalogRankingOptions): Promise<T | undefined> {
  const retained = retainMemoryReadingOptions(options);
  return withModelReadingSource({ providers, query }, retained, async (captured, current) => {
    if (captured.providers.length === 0) return undefined;
    const site = memoryProviderSelect.name;
    const authority = captureMemoryAuthority(memoryProviderSelect, current);
    try {
      const run = await memoryProviderSelect.select(authority.port, { query: captured.query }, captured.providers.map((provider, index) => ({ id: String(index), content: personalOpsJson(provider) })), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
      authority.assertCurrent(); run.recordAction('read-only external-memory provider selection');
      if (run.outcome !== 'act') throw new ToolInputProjectionError('held');
      if (run.chosen === undefined) return undefined;
      const index = Number(run.chosen);
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== run.chosen || providers[index] === undefined) throw new ToolInputProjectionError('held');
      return providers[index];
    } finally { const observation = authority.consumeObservation(); current.retainCurrent?.(observation.assertCurrent, site); observation.assertCurrent(); }
  });
}
