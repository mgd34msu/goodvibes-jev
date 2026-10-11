import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';
import { JudgmentPortMissingError, judgmentPortInstallation } from './judgment-port.js';

/** A composition-owned observation. It is never execution permission. */
export interface JudgmentAuthorityFrame {
  readonly identity: object;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}
export interface JudgmentReadingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export interface JudgmentEffectRestriction {
  /** A restriction only. The caller must independently authorize the exact effect. */
  readonly assertCurrent: () => void;
}
export interface JudgmentPortCapture {
  /** Opaque cache identity; never a hash of configuration or credential values. */
  readonly identity: object;
  /** Consume this observation forever; retain installation/function restrictions only. */
  readonly consumeObservation: () => JudgmentEffectRestriction;
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
interface OwnerBinding {
  readonly capture: (() => JudgmentAuthorityFrame) | undefined;
  readonly controller: AbortController;
  readonly identities: WeakMap<object, object>;
}
const owners = new WeakMap<JudgmentPort, OwnerBinding>();
function ownerBinding(port: JudgmentPort): OwnerBinding {
  let binding = owners.get(port);
  if (!binding) {
    binding = { capture: undefined, controller: new AbortController(), identities: new WeakMap() };
    owners.set(port, binding);
  }
  return binding;
}
const ordinaryOwners = new WeakMap<JudgmentPort, { readonly model: string; readonly identity: object }>();
function ordinaryIdentity(port: JudgmentPort, model: string): object {
  let owner = ordinaryOwners.get(port);
  if (!owner || owner.model !== model) {
    owner = { model, identity: Object.freeze({}) }; ordinaryOwners.set(port, owner);
  }
  return owner.identity;
}

export class JudgmentAuthorityRetiredError extends Error {
  constructor() { super('The judgment reading owner is no longer current.'); this.name = 'JudgmentAuthorityRetiredError'; }
}

/** Bind an actual composition's source lifetime before exposing its port. */
export function bindJudgmentPortAuthority(port: JudgmentPort, capture: () => JudgmentAuthorityFrame): void {
  const previous = owners.get(port);
  if (previous?.capture === capture) return;
  owners.set(port, { capture, controller: new AbortController(), identities: new WeakMap() });
  // Publish first so cancellation listeners cannot recapture the retired owner.
  previous?.controller.abort();
}

function synchronous(check: (() => void) | undefined): void {
  const value: unknown = check?.();
  if (value === undefined) return;
  try { void Promise.resolve(value).catch(() => {}); } catch { /* Refuse borrowed accessors. */ }
  throw new JudgmentAuthorityRetiredError();
}

/** Interrupt non-cooperating readers and consume either late settlement. */
async function interrupt<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new JudgmentAuthorityRetiredError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Capture one installed/source authority, fencing requests, retention, battery
 * attachments and publication. A caller signal owns only this scoped reader.
 */
export function captureJudgmentPort(site: string, options: JudgmentReadingOptions = {}): JudgmentPortCapture {
  try { return capture(site, options); }
  catch (error) {
    if (error instanceof JudgmentPortMissingError) throw error;
    throw new JudgmentAuthorityRetiredError();
  }
}

function capture(site: string, options: JudgmentReadingOptions): JudgmentPortCapture {
  const installation = judgmentPortInstallation(site);
  const base = installation.port;
  const binding = ownerBinding(base);
  const owner = binding.capture?.();
  const ownerIdentity = owner?.identity, ownerSignal = owner?.signal, sourceCurrent = owner?.assertCurrent;
  const signal = AbortSignal.any([installation.signal, binding.controller.signal, ...(ownerSignal ? [ownerSignal] : []),
    ...(options.signal ? [options.signal] : [])]);
  const model = base.model;
  const ask = base.ask, health = base.health, recorder = base.recorder;
  const ownedAsk = ask.bind(base);
  const recordReadings = recorder?.recordReadings, recordAction = recorder?.recordAction;
  const callerCurrent = options.assertCurrent;
  let consumed = false;
  const installationCurrent = () => {
    if (installation.signal.aborted || binding.controller.signal.aborted || owners.get(base) !== binding
      || owner?.identity !== ownerIdentity || owner?.signal !== ownerSignal || owner?.assertCurrent !== sourceCurrent
      || base.model !== model || base.ask !== ask || base.health !== health || base.recorder !== recorder
      || recorder?.recordReadings !== recordReadings || recorder?.recordAction !== recordAction) throw new JudgmentAuthorityRetiredError();
  };
  const current = () => {
    try {
      installationCurrent();
      if (consumed || signal.aborted || owners.get(base) !== binding || owner?.identity !== ownerIdentity
        || owner?.signal !== ownerSignal || owner?.assertCurrent !== sourceCurrent) throw new JudgmentAuthorityRetiredError();
      synchronous(sourceCurrent);
      synchronous(callerCurrent);
      installationCurrent();
      if (consumed) throw new JudgmentAuthorityRetiredError();
      if (base.model !== model || base.ask !== ask || base.health !== health || base.recorder !== recorder
        || recorder?.recordReadings !== recordReadings || recorder?.recordAction !== recordAction || signal.aborted) throw new JudgmentAuthorityRetiredError();
    } catch { throw new JudgmentAuthorityRetiredError(); }
  };
  current();
  const decisionChecks = new Map<string, () => void>();
  const checkDecision = (id: string) => { current(); decisionChecks.get(id)?.(); current(); };
  current();
  const port: JudgmentPort = {
    get model() { current(); return model; },
    ...(recorder ? { recorder: {
      recordReadings(id, readings) { checkDecision(id); recordReadings!.call(recorder, id, readings); checkDecision(id); },
      recordAction(id, action) { checkDecision(id); recordAction!.call(recorder, id, action); checkDecision(id); },
    } satisfies NonNullable<JudgmentPort['recorder']> } : {}),
    ...(health ? { health: () => { current(); const result = health.call(base); current(); return result; } } : {}),
    async ask(request) {
      current();
      const requestSignal = request.signal;
      const active = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const check = () => { if (active.aborted) throw new JudgmentAuthorityRetiredError(); current(); };
      const beforeAttempt = request.beforeAttempt;
      const beforeAsyncAttempt = request.beforeAsyncAttempt;
      const assertLogCurrent = request.assertLogCurrent;
      const onRetry = request.onRetry;
      check();
      const result = await interrupt(Promise.resolve().then(() => {
        check();
        const ownedRequest = { ...request, signal: active,
          beforeAttempt: () => { check(); synchronous(beforeAttempt); check(); },
          beforeAsyncAttempt: async () => { check(); await beforeAsyncAttempt?.(); check(); },
          assertLogCurrent: () => { check(); synchronous(assertLogCurrent); check(); },
          onRetry: (progress: Parameters<NonNullable<typeof onRetry>>[0]) => { check(); onRetry?.(progress); check(); },
        };
        check();
        return ownedAsk(ownedRequest);
      }), active);
      check();
      const decisionId = result.decisionId;
      check();
      if (decisionId !== undefined) decisionChecks.set(decisionId, check);
      return result;
    },
  };
  current();
  const sourceIdentity = ownerIdentity ?? ordinaryIdentity(base, model);
  let identity = binding.identities.get(sourceIdentity);
  if (!identity) { identity = Object.freeze({}); binding.identities.set(sourceIdentity, identity); }
  current();
  return Object.freeze({ identity: installation.identityFor(identity), port, signal, assertCurrent: current, consumeObservation: () => {
    current(); consumed = true;
    return Object.freeze({ assertCurrent: installationCurrent });
  } });
}
