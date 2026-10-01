import { JudgmentError } from '@goodvibes-jev/judgment';
import type { JudgmentPort, JudgmentResult, Questions } from '@goodvibes-jev/judgment/decisions';
import {
  BrowserJudgmentError, BROWSER_JUDGMENT_LIMITS as LIMIT, parseBrowserJudgmentRequest, captureBrowserJudgmentJson, missingScopes,
  type AuthenticatedPrincipal, type BrowserJudgmentRequest,
} from '@goodvibes-jev/engine/daemon-sdk';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { BrowserJudgmentReferences } from './references.js';
import { BrowserJudgmentRegistry, type RegisteredBrowserJudgmentBattery } from './registry.js';
import { validateBrowserJudgmentProjection } from './projection.js';
import type { BrowserJudgmentAuthorization, BrowserJudgmentRoute, BrowserJudgmentProjection } from './types.js';
import { BrowserJudgmentCallLimit } from './call-limit.js';
import { consumeRejectedHook, granted, requireSynchronousAssertion } from './guards.js';

export interface BrowserJudgmentServiceOptions {
  readonly registry: BrowserJudgmentRegistry;
  readonly references: BrowserJudgmentReferences;
  /** Must acquire the exact configured recorded port and its authoritative route revision. */
  readonly currentRoute: () => BrowserJudgmentRoute | undefined;
  /** Server policy only. Read access/reference possession never implies outbound clearance. */
  readonly authorize: (input: BrowserJudgmentAuthorization) => boolean;
}
type Evidence = Pick<JudgmentResult<Questions>, 'decisionId' | 'model' | 'requestedModel' | 'usage' | 'latencyMs'>;

function normalizedError(error: unknown, signal: AbortSignal): BrowserJudgmentError {
  if (signal.aborted && signal.reason instanceof BrowserJudgmentError) return signal.reason;
  if (error instanceof BrowserJudgmentError) return error;
  if (error instanceof JudgmentError) {
    if (error.kind === 'unrecorded') return new BrowserJudgmentError('JUDGMENT_UNRECORDED');
    if (error.kind === 'invalid-response') return new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE');
    if (error.kind === 'aborted') return new BrowserJudgmentError('JUDGMENT_ABORTED');
  }
  // Missing key is currently an internal invalid-request: it is NOT a client input error.
  return new BrowserJudgmentError('JUDGMENT_UNAVAILABLE');
}

/** Owns admitted runs, references, cancellation, and drain; borrows the configured port/log. */
export class BrowserJudgmentService {
  readonly #active = new Map<Promise<unknown>, { readonly principal: string; readonly abort: AbortController }>();
  #closing = false;
  #close: Promise<void> | undefined;
  readonly #providerCalls = new BrowserJudgmentCallLimit(8, LIMIT.totalRuns * 4);
  constructor(private readonly options: BrowserJudgmentServiceOptions) {}

  async execute(raw: unknown, principal: AuthenticatedPrincipal, signal: AbortSignal, currentPrincipal: () => AuthenticatedPrincipal): Promise<object> {
    if (this.#closing) throw new BrowserJudgmentError('JUDGMENT_SHUTTING_DOWN');
    const request = parseBrowserJudgmentRequest(raw);
    const battery = this.options.registry.get(request.battery);
    if (!battery) throw new BrowserJudgmentError('JUDGMENT_UNAVAILABLE');
    if (this.#active.size >= LIMIT.totalRuns || [...this.#active.values()].filter((run) => run.principal === principal.principalId).length >= LIMIT.principalRuns) {
      throw new BrowserJudgmentError('JUDGMENT_BUSY');
    }
    const abort = new AbortController();
    const cancelled = () => abort.abort(new BrowserJudgmentError('JUDGMENT_ABORTED'));
    if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
    const timer = setTimeout(() => abort.abort(new BrowserJudgmentError('JUDGMENT_DEADLINE')), LIMIT.runMs);
    // Defer the resolver until after the run is owned, including synchronous throws.
    const work = Promise.resolve().then(() => this.run(request, battery, principal, abort, currentPrincipal));
    this.#active.set(work, { principal: principal.principalId, abort });
    const release = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); this.#active.delete(work); };
    void work.then(release, release);
    let stop = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', stop, { once: true });
      if (abort.signal.aborted) stop();
    });
    try { return await Promise.race([work, interrupted]); }
    catch (error) { throw normalizedError(error, abort.signal); }
    finally { abort.signal.removeEventListener('abort', stop); }
  }

  private async run(request: BrowserJudgmentRequest, battery: RegisteredBrowserJudgmentBattery, principal: AuthenticatedPrincipal, abort: AbortController, currentPrincipal: () => AuthenticatedPrincipal): Promise<object> {
    const signal = abort.signal;
    const checkAbort = () => { if (signal.aborted) throw signal.reason; };
    const authenticate = (): AuthenticatedPrincipal => {
      checkAbort();
      const actor = currentPrincipal();
      if (!actor || 'then' in actor || actor.principalId !== principal.principalId
        || (actor.admin !== true && (!Array.isArray(actor.scopes) || missingScopes(actor.scopes, ['write:judgment']).length > 0))) {
        consumeRejectedHook(actor); throw new BrowserJudgmentError('JUDGMENT_AUTH_REQUIRED');
      }
      return actor;
    };
    const resolved = await battery.resolve(request.input, { principal: authenticate(), currentPrincipal: authenticate, signal, references: this.options.references });
    authenticate(); requireSynchronousAssertion(() => resolved.assertCurrent(), 'JUDGMENT_REFERENCE_HELD');
    let state: unknown;
    try { state = captureBrowserJudgmentJson(snapshotJudgmentInput(resolved.state)); }
    catch { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); }
    const route = this.options.currentRoute();
    if (!route || 'then' in route) { consumeRejectedHook(route); throw new BrowserJudgmentError('JUDGMENT_UNAVAILABLE'); }
    const authorized = () => {
      const actor = authenticate();
      requireSynchronousAssertion(() => resolved.assertCurrent(), 'JUDGMENT_REFERENCE_HELD');
      requireSynchronousAssertion(() => route.assertCurrent(), 'JUDGMENT_PERMISSION_HELD');
      if (!granted(this.options.authorize({ principal: actor, battery: request.battery, batteryVersion: 1, sourceBinding: resolved.sourceBinding,
        route: { revision: route.revision, kind: route.kind } }))) throw new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD');
    };
    authorized();
    if (!route.port.recorder) throw new BrowserJudgmentError('JUDGMENT_UNRECORDED');
    const evidence: Evidence[] = [];
    let calls = 0; let pending = 0; let open = true;
    const perRun = new BrowserJudgmentCallLimit(4, battery.maxCalls);
    const ownedCalls = new Set<Promise<unknown>>();
    const port: JudgmentPort = {
      model: route.port.model,
      recorder: route.port.recorder,
      ask: (questionRequest) => {
        if (!open) return Promise.reject(new BrowserJudgmentError('JUDGMENT_ABORTED'));
        if (++calls > battery.maxCalls) return Promise.reject(new BrowserJudgmentError('JUDGMENT_INPUT_TOO_LARGE'));
        pending++;
        const work = perRun.run(signal, () => this.#providerCalls.run(signal, async () => {
          authorized();
          if (questionRequest.model !== undefined && questionRequest.model !== route.port.model) throw new BrowserJudgmentError('JUDGMENT_UNAVAILABLE');
          const names = Object.keys(questionRequest.questions);
          if (!names.length || names.some((name) => !Object.hasOwn(battery.questions, name)
            || JSON.stringify(questionRequest.questions[name]) !== JSON.stringify(battery.questions[name]))) throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE');
          let safeState: unknown;
          try { safeState = snapshotJudgmentInput(questionRequest.state); }
          catch { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); }
          const result = await route.port.ask({ ...questionRequest, state: safeState as typeof questionRequest.state, signal,
            context: { battery: request.battery, batteryVersion: 1, site: 'browser.judgment' }, totalTimeoutMs: LIMIT.runMs });
          authorized();
          if (!result.decisionId) throw new BrowserJudgmentError('JUDGMENT_UNRECORDED');
          evidence.push({ decisionId: result.decisionId, model: result.model, requestedModel: result.requestedModel, usage: result.usage, latencyMs: result.latencyMs });
          return result;
        }));
        ownedCalls.add(work);
        const release = () => { pending--; ownedCalls.delete(work); };
        void work.then(release, release);
        return work;
      },
    };
    let result: unknown;
    try {
      result = await battery.run(port, state, { signal });
      if (pending) throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE');
    } catch (error) {
      abort.abort(normalizedError(error, signal)); throw error;
    } finally { open = false; await Promise.allSettled([...ownedCalls]); } // Drain siblings before closing the log.
    authorized();
    if (!evidence.length) throw new BrowserJudgmentError('JUDGMENT_UNRECORDED');
    let projected: BrowserJudgmentProjection<unknown>;
    try { projected = captureBrowserJudgmentJson(battery.project(result)) as BrowserJudgmentProjection<unknown>; }
    catch { throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE'); }
    validateBrowserJudgmentProjection(request, projected, state);
    const outcomes = Object.values(projected.readings).map((reading) => reading.outcome);
    if (projected.status === 'held' && projected.compoundOutcome !== undefined) outcomes.push(projected.compoundOutcome);
    const outcome = outcomes.includes('escalate') ? 'escalate' : outcomes.includes('confirm') ? 'confirm' : 'act';
    // The minimum compound outcome is an adapter instruction, not a second wire
    // outcome. Structural facts stay visible and never masquerade as readings.
    const wireProjection = projected.status === 'held'
      ? { status: projected.status, reason: projected.reason, readings: projected.readings,
          ...(projected.structuralBasis === undefined ? {} : { structuralBasis: projected.structuralBasis }) }
      : projected;
    const response = { protocolVersion: 1, requestId: request.requestId, battery: request.battery, batteryVersion: 1, ...wireProjection, outcome, evidence };
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength > LIMIT.bodyBytes) throw new BrowserJudgmentError('JUDGMENT_INVALID_RESPONSE');
    return response;
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    for (const run of this.#active.values()) run.abort.abort(new BrowserJudgmentError('JUDGMENT_SHUTTING_DOWN'));
    this.options.references.close();
    this.#close = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserJudgmentError('JUDGMENT_DEADLINE')), LIMIT.closeMs);
      void Promise.allSettled([...this.#active.keys()]).then(() => { clearTimeout(timer); resolve(); });
    });
    return this.#close;
  }
}
