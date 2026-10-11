import { credentialKey } from '../../config/batteries/credential-key.js';
import type { BatteryRun, Outcome, Reading, YesNoReading } from '@goodvibes-jev/judgment/decisions';
import { BrowserJudgmentError, type BrowserJudgmentInputMap } from '@goodvibes-jev/engine/daemon-sdk';
import { requireSynchronousAssertion } from '../guards.js';
import type { BrowserJudgmentBattery, BrowserJudgmentProjection, BrowserJudgmentResolveContext, BrowserJudgmentResolvedInput } from '../types.js';
import { catalogProviderMatchBattery, cardMaterialKeyBattery, daemonRefusalBattery, statusToneBattery, commandRankBattery, mailReplySubjectBattery, installPlatformBattery, credentialProviderBattery, codeLanguageBattery, WEBUI_BATTERY_QUESTIONS } from './webui-specs.js';
import { readStructuredDaemonRefusal, snapshotWebuiCommandRank, snapshotWebuiDaemonRefusal, snapshotWebuiStatus, snapshotWebuiMailSubject, snapshotWebuiInstallPlatform, snapshotWebuiCredentialNames, snapshotWebuiCode, snapshotWebuiConfigKeys } from './webui-readers.js';
import { REFUSAL_ITEMS, WEBUI_READER_LIMITS, type CommandRankValue, type DaemonRefusalValue, type ResolvedCommandRank, type ResolvedDaemonRefusal, type ResolvedStatus, type StatusValue } from './webui-types.js';

const ERRORS = 'webui.errors.daemon-refusal';
const STATUS = 'webui.status.badge-tone';
const PALETTE = 'webui.palette.command-rank';
const MAIL = 'webui.mail.reply-subject';
const inputHeld = (): never => { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); };
const referenceHeld = (): never => { throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); };
const invalid = (): never => { throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE'); };
const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) throw new BrowserJudgmentError('JUDGMENT_ABORTED'); };
function preflight<T>(capture: () => T): T {
  try { return capture(); } catch { return inputHeld(); }
}
function held(readings: Readonly<Record<string, Reading>>, compoundOutcome?: Exclude<Outcome, 'act'>): Extract<BrowserJudgmentProjection<never>, { status: 'held' }> {
  return { status: 'held', reason: 'uncertain', readings, ...(compoundOutcome === undefined ? {} : { compoundOutcome }) };
}
const unsettled = (readings: Readonly<Record<string, Reading>>): boolean => Object.values(readings).some((reading) => reading.outcome !== 'act');
const hasHttpStatus = (source: ResolvedDaemonRefusal): source is ResolvedDaemonRefusal & { readonly status: number } => source.status !== undefined && Number.isInteger(source.status) && source.status >= 100 && source.status <= 599;

export function createWebuiCodeLanguageAdapter(resolve: BrowserJudgmentBattery<'webui.code.language', { readonly code: string; readonly tag: string }, BatteryRun<typeof codeLanguageBattery.items>>['resolve']): BrowserJudgmentBattery<'webui.code.language', { readonly code: string; readonly tag: string }, BatteryRun<typeof codeLanguageBattery.items>> {
  return {
    id: 'webui.code.language', version: 1, maxCalls: 1, questions: WEBUI_BATTERY_QUESTIONS['webui.code.language']!, resolve,
    async run(port, input, { signal }) {
      checkAbort(signal); const state = preflight(() => snapshotWebuiCode(input));
      const run = await codeLanguageBattery.run(port, state, { signal, site: 'webui.code.language' });
      checkAbort(signal); return run;
    },
    project(run) {
      const readings = { language: run.readings.language };
      if (unsettled(readings)) { run.recordAction('unsettled'); return held(readings); }
      run.recordAction('ready'); return { status: 'settled', value: { language: readings.language.choice }, readings };
    },
  };
}

type ConfigKeyRun = readonly BatteryRun<typeof credentialKey.items>[];
export function createWebuiConfigKeyAdapter(resolve: BrowserJudgmentBattery<'webui.config.credential-key', { readonly keys: readonly { readonly key: string; readonly description: string }[] }, ConfigKeyRun>['resolve']): BrowserJudgmentBattery<'webui.config.credential-key', { readonly keys: readonly { readonly key: string; readonly description: string }[] }, ConfigKeyRun> {
  return {
    id: 'webui.config.credential-key', version: 1, maxCalls: 64, questions: Object.fromEntries(Object.entries(credentialKey.items).map(([name, item]) => [name, item.question])), resolve,
    async run(port, input, { signal }) {
      checkAbort(signal); const source = preflight(() => snapshotWebuiConfigKeys(input));
      const runs: BatteryRun<typeof credentialKey.items>[] = [];
      // One browser request, bounded server fan-out. The service owns shared budgets and retries.
      let next = 0; let failure: unknown;
      await Promise.all(Array.from({ length: Math.min(4, source.keys.length) }, async () => {
        while (next < source.keys.length && !signal.aborted && failure === undefined) {
          const index = next++;
          try { runs[index] = await credentialKey.run(port, { ...source.keys[index]! }, { signal, site: 'webui.config.credential-key' }); }
          catch (error) { failure = error; }
        }
      }));
      checkAbort(signal); if (failure !== undefined) throw failure; return runs;
    },
    project(runs) {
      const readings = Object.fromEntries(runs.map((run, index) => [`key_${index}`, run.readings.credential]));
      if (unsettled(readings)) { runs.forEach(run => run.recordAction('unsettled')); return held(readings); }
      runs.forEach(run => run.recordAction('ready'));
      return { status: 'settled', value: { matches: runs.map(run => run.readings.credential.verdict === 'yes') }, readings };
    },
  };
}

type CardMaterialKeyRun = readonly BatteryRun<typeof cardMaterialKeyBattery.items>[];
export function createWebuiCardMaterialKeyAdapter(resolve: BrowserJudgmentBattery<'webui.settings.card-material-key', { readonly keys: readonly { readonly key: string; readonly description: string }[] }, CardMaterialKeyRun>['resolve']): BrowserJudgmentBattery<'webui.settings.card-material-key', { readonly keys: readonly { readonly key: string; readonly description: string }[] }, CardMaterialKeyRun> {
  return {
    id: 'webui.settings.card-material-key', version: 1, maxCalls: 64, questions: Object.fromEntries(Object.entries(cardMaterialKeyBattery.items).map(([name, item]) => [name, item.question])), resolve,
    async run(port, input, { signal }) {
      checkAbort(signal); const source = preflight(() => snapshotWebuiConfigKeys(input));
      const runs: BatteryRun<typeof cardMaterialKeyBattery.items>[] = [];
      // One browser request, bounded server fan-out. The service owns shared budgets and retries.
      let next = 0; let failure: unknown;
      await Promise.all(Array.from({ length: Math.min(4, source.keys.length) }, async () => {
        while (next < source.keys.length && !signal.aborted && failure === undefined) {
          const index = next++;
          try { runs[index] = await cardMaterialKeyBattery.run(port, { ...source.keys[index]! }, { signal, site: 'webui.settings.card-material-key' }); }
          catch (error) { failure = error; }
        }
      }));
      checkAbort(signal); if (failure !== undefined) throw failure; return runs;
    },
    project(runs) {
      const readings = Object.fromEntries(runs.map((run, index) => [`key_${index}`, run.readings.material]));
      if (unsettled(readings)) { runs.forEach(run => run.recordAction('unsettled')); return held(readings); }
      runs.forEach(run => run.recordAction('ready'));
      return { status: 'settled', value: { matches: runs.map(run => run.readings.material.verdict === 'yes') }, readings };
    },
  };
}

type CredentialRun = readonly BatteryRun<typeof credentialProviderBattery.items>[];
export function createWebuiCredentialProviderAdapter(resolve: BrowserJudgmentBattery<'webui.credentials.provider-key', BrowserJudgmentInputMap['webui.credentials.provider-key'], CredentialRun>['resolve']): BrowserJudgmentBattery<'webui.credentials.provider-key', BrowserJudgmentInputMap['webui.credentials.provider-key'], CredentialRun> {
  return {
    id: 'webui.credentials.provider-key', version: 1, maxCalls: 64, questions: WEBUI_BATTERY_QUESTIONS['webui.credentials.provider-key']!, resolve,
    async run(port, input, { signal }) {
      checkAbort(signal); const source = preflight(() => snapshotWebuiCredentialNames(input));
      const runs: BatteryRun<typeof credentialProviderBattery.items>[] = [];
      // One browser request, bounded server fan-out. The service owns shared budgets and retries.
      let next = 0; let failure: unknown;
      await Promise.all(Array.from({ length: Math.min(4, source.keys.length) }, async () => {
        while (next < source.keys.length && !signal.aborted && failure === undefined) {
          const index = next++;
          try { runs[index] = await credentialProviderBattery.run(port, { providerId: source.providerId, key: source.keys[index]! }, { signal, site: 'webui.credentials.provider-key' }); }
          catch (error) { failure = error; }
        }
      }));
      checkAbort(signal); if (failure !== undefined) throw failure; return runs;
    },
    project(runs) {
      const readings = Object.fromEntries(runs.map((run, index) => [`key_${index}`, run.readings.matches]));
      if (unsettled(readings)) { runs.forEach(run => run.recordAction('unsettled')); return held(readings); }
      runs.forEach(run => run.recordAction('ready'));
      return { status: 'settled', value: { matches: runs.map(run => run.readings.matches.verdict === 'yes') }, readings };
    },
  };
}

type CatalogProviderRun = readonly BatteryRun<typeof catalogProviderMatchBattery.items>[];
export function createWebuiCatalogProviderAdapter(resolve: BrowserJudgmentBattery<'webui.models.catalog-provider-match', BrowserJudgmentInputMap['webui.models.catalog-provider-match'], CatalogProviderRun>['resolve']): BrowserJudgmentBattery<'webui.models.catalog-provider-match', BrowserJudgmentInputMap['webui.models.catalog-provider-match'], CatalogProviderRun> {
  return {
    id: 'webui.models.catalog-provider-match', version: 1, maxCalls: 64, questions: WEBUI_BATTERY_QUESTIONS['webui.models.catalog-provider-match']!, resolve,
    async run(port, input, { signal }) {
      checkAbort(signal); const source = preflight(() => snapshotWebuiCredentialNames(input));
      const runs: BatteryRun<typeof catalogProviderMatchBattery.items>[] = [];
      // One browser request, bounded server fan-out. The service owns shared budgets and retries.
      let next = 0; let failure: unknown;
      await Promise.all(Array.from({ length: Math.min(4, source.keys.length) }, async () => {
        while (next < source.keys.length && !signal.aborted && failure === undefined) {
          const index = next++;
          try { runs[index] = await catalogProviderMatchBattery.run(port, { providerId: source.providerId, key: source.keys[index]! }, { signal, site: 'webui.models.catalog-provider-match' }); }
          catch (error) { failure = error; }
        }
      }));
      checkAbort(signal); if (failure !== undefined) throw failure; return runs;
    },
    project(runs) {
      const readings = Object.fromEntries(runs.map((run, index) => [`key_${index}`, run.readings.matches]));
      if (unsettled(readings)) { runs.forEach(run => run.recordAction('unsettled')); return held(readings); }
      runs.forEach(run => run.recordAction('ready'));
      return { status: 'settled', value: { matches: runs.map(run => run.readings.matches.verdict === 'yes') }, readings };
    },
  };
}

export function createWebuiInstallPlatformAdapter(resolve: BrowserJudgmentBattery<'webui.pwa.install-platform', BrowserJudgmentInputMap['webui.pwa.install-platform'], BatteryRun<typeof installPlatformBattery.items>>['resolve']): BrowserJudgmentBattery<'webui.pwa.install-platform', BrowserJudgmentInputMap['webui.pwa.install-platform'], BatteryRun<typeof installPlatformBattery.items>> {
  return {
    id: 'webui.pwa.install-platform', version: 1, maxCalls: 1, questions: WEBUI_BATTERY_QUESTIONS['webui.pwa.install-platform']!, resolve,
    async run(port, input, { signal }) {
      checkAbort(signal);
      const source = preflight(() => snapshotWebuiInstallPlatform(input));
      const run = await installPlatformBattery.run(port, source, { signal, site: 'webui.pwa.install-platform' });
      checkAbort(signal); return run;
    },
    project(run) {
      const readings = { platform: run.readings.platform };
      if (unsettled(readings)) { run.recordAction('unsettled'); return held(readings); }
      run.recordAction('ready');
      return { status: 'settled', value: { platform: readings.platform.choice }, readings };
    },
  };
}

/** Only an authenticated canonical read can issue the referenced subject. */
export const webuiMailReplySubjectAdapter: BrowserJudgmentBattery<typeof MAIL, { readonly subject: string }, BatteryRun<typeof mailReplySubjectBattery.items>> = {
  id: MAIL, version: 1, maxCalls: 1, questions: WEBUI_BATTERY_QUESTIONS[MAIL]!,
  async resolve(input, context) {
    checkAbort(context.signal);
    return context.references.resolve(input.subjectRef, context.currentPrincipal, MAIL, snapshotWebuiMailSubject);
  },
  async run(port, raw, { signal }) {
    checkAbort(signal);
    const source = preflight(() => snapshotWebuiMailSubject(raw));
    const run = await mailReplySubjectBattery.run(port, source, { signal, site: MAIL });
    checkAbort(signal);
    return run;
  },
  project(run) {
    const readings = { already_reply: run.readings.already_reply };
    if (unsettled(readings)) { run.recordAction('unsettled'); return held(readings); }
    run.recordAction('ready');
    return { status: 'settled', value: { alreadyReply: readings.already_reply.verdict === 'yes' }, readings };
  },
};

/** Server-only intermediate evidence consumed by the refusal descriptor. */
export interface WebuiDaemonRefusalRun {
  readonly source: ResolvedDaemonRefusal & { readonly status: number };
  readonly run: BatteryRun<typeof daemonRefusalBattery.items>;
}

/** Genuine unresolved failure refs only; machine codes are handled before the endpoint. */
export const webuiDaemonRefusalAdapter: BrowserJudgmentBattery<'webui.errors.daemon-refusal', ResolvedDaemonRefusal, WebuiDaemonRefusalRun> = {
  id: ERRORS, version: 1, maxCalls: 1, questions: WEBUI_BATTERY_QUESTIONS[ERRORS]!,
  async resolve(input, context) {
    checkAbort(context.signal);
    const resolved = context.references.resolve(input.errorRef, context.currentPrincipal, ERRORS, snapshotWebuiDaemonRefusal);
    if (readStructuredDaemonRefusal(resolved.state) !== undefined || !resolved.state.message.trim()) return inputHeld();
    if (!hasHttpStatus(resolved.state)) return referenceHeld();
    return resolved;
  },
  async run(port, raw, { signal }) {
    checkAbort(signal);
    const source = preflight(() => snapshotWebuiDaemonRefusal(raw));
    if (readStructuredDaemonRefusal(source) !== undefined || !source.message.trim()) return inputHeld();
    if (!hasHttpStatus(source)) return inputHeld();
    const only = REFUSAL_ITEMS.filter((item) => item !== 'method_unknown' || source.status === 404);
    const run = await daemonRefusalBattery.run(port, { ...source }, { signal, only, site: ERRORS });
    checkAbort(signal);
    return { source, run };
  },
  project({ source, run }) {
    const names = REFUSAL_ITEMS.filter((item) => item !== 'method_unknown' || source.status === 404);
    const readings: Record<string, YesNoReading> = Object.fromEntries(names.map((name) => [name, run.readings[name]]));
    if (names.some((name) => !readings[name])) return invalid();
    const basis = source.status === 404 ? {} : { structuralBasis: { method_unknown: 'http-status-not-404' as const } };
    if (unsettled(readings)) { run.recordAction('unsettled'); return { ...held(readings), ...basis }; }
    const value: DaemonRefusalValue = {
      session_not_found: run.readings.session_not_found.verdict === 'yes',
      session_closed: run.readings.session_closed.verdict === 'yes',
      session_active: run.readings.session_active.verdict === 'yes',
      session_not_local: run.readings.session_not_local.verdict === 'yes',
      method_unknown: source.status === 404 && run.readings.method_unknown.verdict === 'yes',
    };
    const conflict = (value.session_not_found && (value.session_closed || value.session_active || value.session_not_local))
      || (value.session_closed && value.session_active)
      || (value.method_unknown && (value.session_not_found || value.session_closed || value.session_active || value.session_not_local));
    if (conflict) { run.recordAction('conflicting-evidence'); return { ...held(readings, 'escalate'), ...basis }; }
    run.recordAction('ready');
    return { status: 'settled', value, readings, ...basis };
  },
};

/** Server-only intermediate evidence consumed by the status descriptor. */
export interface WebuiStatusToneRun {
  readonly source: Extract<ResolvedStatus, { kind: 'text' }>;
  readonly run: BatteryRun<typeof statusToneBattery.items>;
}

/** Catalog enums resolve in code before the endpoint. No dynamic issuer is assumed. */
export const webuiStatusToneAdapter: BrowserJudgmentBattery<'webui.status.badge-tone', Extract<ResolvedStatus, { kind: 'text' }>, WebuiStatusToneRun> = {
  id: STATUS, version: 1, maxCalls: 1, questions: WEBUI_BATTERY_QUESTIONS[STATUS]!,
  async resolve(input, context) {
    checkAbort(context.signal);
    if (input.source.kind === 'catalog') return inputHeld();
    return context.references.resolve(input.source.statusRef, context.currentPrincipal, STATUS, (snapshot) => {
      const source = snapshotWebuiStatus(snapshot);
      if (source.kind !== 'text' || source.vocabulary !== input.vocabulary) return referenceHeld();
      return source;
    });
  },
  async run(port, raw, { signal }) {
    checkAbort(signal);
    const source = preflight(() => snapshotWebuiStatus(raw));
    if (source.kind !== 'text') return inputHeld();
    const item = source.vocabulary === 'badge' ? 'badge' : 'library_dot';
    const run = await statusToneBattery.run(port, { status: source.status, domain: source.domain }, { signal, only: [item], site: STATUS });
    checkAbort(signal);
    return { source, run };
  },
  project({ source, run }) {
    const item = source.vocabulary === 'badge' ? 'badge' : 'library_dot';
    const reading = run.readings[item];
    if (!reading) return invalid();
    const readings = { [item]: reading };
    if (reading.outcome !== 'act') { run.recordAction('unsettled'); return held(readings); }
    const value: StatusValue = source.vocabulary === 'badge'
      ? { vocabulary: 'badge', tone: run.readings.badge.choice }
      : { vocabulary: 'library-dot', tone: run.readings.library_dot.choice };
    run.recordAction('ready');
    return { status: 'settled', value, readings };
  },
};

/**
 * Server source authority supplied by daemon composition, not HTTP input.
 * Resolve the query and every requested command/chat in index order. Retain
 * identities locally. Bind query provenance AND the candidate snapshot to the
 * sourceBinding; read access is not route/retention permission. assertCurrent
 * must recheck currentPrincipal, access, lifetime and revisions after async work.
 */
export interface WebuiPaletteSources {
  resolve(input: BrowserJudgmentInputMap['webui.palette.command-rank'], context: BrowserJudgmentResolveContext): Promise<BrowserJudgmentResolvedInput<ResolvedCommandRank>>;
}
/** Server-only evidence for every candidate in original request order. */
export interface WebuiCommandRankRun {
  readonly registryVersion: string;
  readonly pairs: readonly BatteryRun<typeof commandRankBattery.items>[];
}

export function createWebuiCommandRankAdapter(sources: WebuiPaletteSources): BrowserJudgmentBattery<'webui.palette.command-rank', ResolvedCommandRank, WebuiCommandRankRun> {
  return {
    id: PALETTE, version: 1, maxCalls: WEBUI_READER_LIMITS.candidateCount, questions: WEBUI_BATTERY_QUESTIONS[PALETTE]!,
    async resolve(input, context) {
      checkAbort(context.signal);
      const resolved = await sources.resolve(input, context);
      try {
        checkAbort(context.signal);
        requireSynchronousAssertion(() => resolved.assertCurrent(), 'JUDGMENT_REFERENCE_HELD');
        const state = preflight(() => snapshotWebuiCommandRank(resolved.state));
        if (state.registryVersion !== input.registryVersion || state.candidates.length !== input.candidates.length
          || (input.query.kind === 'inline' && state.query !== input.query.text)) return referenceHeld();
        return { state, sourceBinding: resolved.sourceBinding, assertCurrent: () => resolved.assertCurrent(),
          ...(resolved.dispose === undefined ? {} : { dispose: () => resolved.dispose!() }),
          ...(resolved.signal === undefined ? {} : { signal: resolved.signal }) };
      } catch (error) {
        // Until this return transfers ownership, the adapter owns cleanup.
        // Cancellation in the await gap must not retain a private query or
        // consume one of the host's bounded reference slots for five minutes.
        resolved.dispose?.();
        throw error;
      }
    },
    async run(port, raw, { signal }) {
      checkAbort(signal);
      const state = preflight(() => snapshotWebuiCommandRank(raw));
      if (!state.candidates.length) return inputHeld();
      const pairs: BatteryRun<typeof commandRankBattery.items>[] = [];
      let next = 0;
      let failed = false;
      let firstError: unknown;
      const worker = async (): Promise<void> => {
        while (!failed && !signal.aborted && next < state.candidates.length) {
          const index = next++;
          const candidate = state.candidates[index]!;
          try {
            const run = await commandRankBattery.run(port, { query: state.query, candidate: { title: candidate.title,
              ...(candidate.group === undefined ? {} : { group: candidate.group }),
              ...(candidate.keywords === undefined ? {} : { keywords: [...candidate.keywords] }) } }, { signal, site: PALETTE, pattern: 'rerank' });
            pairs[index] = run;
            if (run.result.decisionId !== undefined) port.recorder?.recordReadings(run.result.decisionId, { candidateIndex: index, match: { ...run.readings.match } });
          } catch (error) { if (!failed) { failed = true; firstError = error; } }
        }
      };
      await Promise.all(Array.from({ length: Math.min(WEBUI_READER_LIMITS.concurrency, state.candidates.length) }, worker));
      checkAbort(signal);
      if (failed) throw firstError;
      return { registryVersion: state.registryVersion, pairs };
    },
    project({ registryVersion, pairs }) {
      const readings = Object.fromEntries(pairs.map((pair, index) => [`candidate_${index}`, pair.readings.match]));
      if (!pairs.length || pairs.length > WEBUI_READER_LIMITS.candidateCount || Object.values(readings).some((reading) => !reading)) return invalid();
      if (unsettled(readings)) { pairs.forEach((pair) => pair.recordAction('unsettled')); return held(readings); }
      const accepted: { candidateIndex: number; probability: number }[] = [];
      const rejected: number[] = [];
      pairs.forEach((pair, candidateIndex) => {
        const reading = pair.readings.match;
        if (reading.verdict === 'yes') accepted.push({ candidateIndex, probability: reading.probability });
        else if (reading.verdict === 'no') rejected.push(candidateIndex);
        else return invalid();
      });
      accepted.sort((a, b) => b.probability - a.probability || a.candidateIndex - b.candidateIndex);
      pairs.forEach((pair) => pair.recordAction('ready'));
      const value: CommandRankValue = { registryVersion, accepted, rejected };
      return { status: 'settled', value, readings };
    },
  };
}
