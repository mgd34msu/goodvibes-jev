import type { JudgmentPort, Questions } from '@goodvibes-jev/judgment/decisions';
import { JudgmentPortMissingError, judgmentPortInstallation } from './judgment-port.js';

/** A composition-owned observation. It is never execution permission. */
export interface JudgmentAuthorityFrame {
  readonly identity: object;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}
export interface JudgmentReadingOptions {
  /** Bind complete response admission to the original requested schema before asking. */
  readonly prepareResultCapture?: ((questions: Questions) => {
    readonly questions: Questions;
    readonly capture: <T extends Awaited<ReturnType<JudgmentPort['ask']>>>(result: T) => T;
    readonly assertCurrent: () => void;
  }) | undefined;
  /** Admit the complete original and return a detached, immutable response for consumers. */
  readonly captureResult?: (<T extends Awaited<ReturnType<JudgmentPort['ask']>>>(result: T) => T) | undefined;
  /** Site-owned complete ORIGINAL response admission before decision-id access or retention. */
  readonly assertResult?: ((result: unknown) => void) | undefined;
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
  const callerCurrent = options.assertCurrent, assertResult = options.assertResult, captureResult = options.captureResult, prepareResultCapture = options.prepareResultCapture;
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
      // Scoped strict consumers bind the ORIGINAL data property before any
      // property read or deferred dispatch. Materialize descriptors, not a
      // spread of a borrowed request that may grow accessors while awaiting.
      const descriptors = prepareResultCapture ? Object.getOwnPropertyDescriptors(request) : undefined;
      if (descriptors && (!descriptors.questions || !('value' in descriptors.questions)
        || !descriptors.questions.enumerable || Object.values(descriptors).some(d => !('value' in d)))) throw new JudgmentAuthorityRetiredError();
      const input = descriptors ? Object.fromEntries(Object.entries(descriptors).filter(([, d]) => d.enumerable).map(([key, d]) => [key, d.value])) as typeof request : request;
      const originalQuestions = input.questions;
      const resultFrame = prepareResultCapture?.(originalQuestions);
      const dispatchedQuestions = (resultFrame?.questions ?? originalQuestions) as typeof request.questions;
      let ownedRequest: typeof request | undefined;
      const questionsCurrent = (value: typeof request, expected: Questions) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'questions');
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || descriptor.value !== expected) throw new JudgmentAuthorityRetiredError();
      };
      const requestSignal = input.signal;
      const active = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const check = () => {
        if (active.aborted) throw new JudgmentAuthorityRetiredError();
        if (resultFrame) { questionsCurrent(request, originalQuestions); if (ownedRequest) questionsCurrent(ownedRequest, dispatchedQuestions); }
        current(); synchronous(resultFrame?.assertCurrent);
        // Caller/source checks are arbitrary callbacks; validate again afterward.
        if (resultFrame) { questionsCurrent(request, originalQuestions); if (ownedRequest) questionsCurrent(ownedRequest, dispatchedQuestions); }
      };
      const beforeAttempt = input.beforeAttempt;
      const beforeAsyncAttempt = input.beforeAsyncAttempt;
      const assertLogCurrent = input.assertLogCurrent;
      const onRetry = input.onRetry;
      check();
      const result = await interrupt(Promise.resolve().then(() => {
        check();
        ownedRequest = { ...input, questions: dispatchedQuestions, signal: active,
          beforeAttempt: () => { check(); synchronous(beforeAttempt); check(); },
          beforeAsyncAttempt: async () => { check(); await beforeAsyncAttempt?.(); check(); },
          assertLogCurrent: () => { check(); synchronous(assertLogCurrent); check(); },
          onRetry: (progress: Parameters<NonNullable<typeof onRetry>>[0]) => { check(); onRetry?.(progress); check(); },
        };
        check();
        return ownedAsk(ownedRequest);
      }), active);
      check();
      // Admission runs on the untouched provider object. Never evaluate an
      // accessor or retain a site-rejected decision identifier first.
      assertResult?.(result);
      check();
      const admitted = resultFrame ? resultFrame.capture(result) : captureResult ? captureResult(result) : result;
      check();
      const decision = Object.getOwnPropertyDescriptor(admitted, 'decisionId');
      if (decision?.get || decision?.set || (decision?.value !== undefined && typeof decision.value !== 'string')) throw new JudgmentAuthorityRetiredError();
      const decisionId = decision?.value as string | undefined;
      check();
      if (decisionId !== undefined) decisionChecks.set(decisionId, check);
      return admitted;
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
