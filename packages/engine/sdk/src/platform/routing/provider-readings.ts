import { retainStrictJudgmentJson, prepareJudgmentResult } from '../gate/judgment-result.js';
/**
 * The provider protocol readings as the adapters call them. Each reads the
 * wording or label Jev judges (batteries/provider.ts) and remembers what it
 * read, so a label, a stop reason or a model id is read once per process.
 * Status codes, well-known ports and documented wire values stay with the
 * callers as code.
 */
import { requireActingReading } from '../types/judgment-held.js';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { captureJudgmentPort, JudgmentAuthorityRetiredError, judgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { captureNormalizationSource } from '../utils/error-display.js';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import {
  alternateApi,
  contentPartKind,
  localServerIdentity,
  reasoningFamily,
  reasoningRejection,
  stopReason,
  type ReasoningFamily,
} from './batteries/provider.js';

const holds = (reading: YesNoReading): boolean => requireActingReading(reading).verdict === 'yes';

/** A bounded memo of settled readings; a failed reading is forgotten and asked again. */
export class ReadingMemo<V> {
  readonly #limit: number;
  readonly #values = new Map<string, Promise<V>>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: string, read: () => Promise<V>): Promise<V> {
    const known = this.#values.get(key);
    if (known) return known;
    if (this.#values.size >= this.#limit) this.#values.delete(this.#values.keys().next().value!);
    const pending = read();
    this.#values.set(key, pending);
    pending.catch(() => { if (this.#values.get(key) === pending) this.#values.delete(key); });
    return pending;
  }

  clear(): void {
    this.#values.clear();
  }
}

/** Evidence from a local server discovery probe. */
export interface ServerProbeEvidence {
  readonly port: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly modelIds: readonly string[];
}

export type LocalServerSoftware = 'lm-studio' | 'vllm' | 'llamacpp' | 'localai' | 'tgi' | 'ollama' | 'unknown';

/** Which server software answered a probe; 'unknown' unless the reading is strong enough to act on. */
export async function readLocalServerIdentity(evidence: ServerProbeEvidence, site: string,
  options: JudgmentReadingOptions = {}): Promise<LocalServerSoftware> {
  const original = retainStrictJudgmentJson(evidence);
  assertJudgmentInput(original.snapshot);
  const owner = captureJudgmentPort(site, { ...options, prepareResultCapture: prepareJudgmentResult,
    assertCurrent: () => { original.assertCurrent(); options.assertCurrent?.(); } });
  owner.assertCurrent();
  const state = {
    evidence_kind: 'probe',
    port: original.snapshot.port,
    headers: { ...original.snapshot.headers },
    model_ids: [...original.snapshot.modelIds],
  };
  assertJudgmentInput(state);
  const dispatched = await localServerIdentity.route(owner.port, state, { site, signal: owner.signal, beforeAttempt: owner.assertCurrent });
  owner.assertCurrent();
  requireActingReading(dispatched.reading);
  const route = dispatched.route;
  const software: LocalServerSoftware = route === 'lm-studio' || route === 'vllm' || route === 'llamacpp'
    || route === 'localai' || route === 'tgi' || route === 'ollama' ? route : 'unknown';
  dispatched.recordAction(`server:${software}`);
  owner.assertCurrent();
  return software;
}

let alternateApiMemos = new WeakMap<object, ReadingMemo<boolean>>();

/**
 * Whether a local server's error (one the status alone did not settle) means
 * the request should go through the server's other API.
 */
export async function readsAsAlternateApi(error: { readonly status?: number | undefined; readonly message: string }, site: string,
  options: JudgmentReadingOptions = {}): Promise<boolean> {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const prototype: unknown = Object.getPrototypeOf(options);
  if (typeof site !== 'string' || !site.trim() || (prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(options).length || Object.values(descriptors).some((field) => !('value' in field)))
    throw new JudgmentInputError('unsupported-input');
  const sourceCurrent = captureNormalizationSource(error, options);
  sourceCurrent();
  const owner = captureJudgmentPort(site, { ...options, assertCurrent: sourceCurrent, prepareResultCapture: prepareJudgmentResult });
  owner.assertCurrent();
  const state = { ...(error.status === undefined ? {} : { status: error.status }), error: error.message };
  assertJudgmentInput(state);
  owner.assertCurrent();
  let memo = alternateApiMemos.get(owner.identity);
  if (!memo) { memo = new ReadingMemo<boolean>(256); alternateApiMemos.set(owner.identity, memo); }
  const pending = memo.get(JSON.stringify(state), async () => {
    const run = await alternateApi.run(owner.port, state, { site, signal: owner.signal, beforeAttempt: owner.assertCurrent });
    owner.assertCurrent();
    const unsupported = holds(run.readings.unsupported);
    run.recordAction(unsupported ? 'use-other-api' : 'rethrow');
    owner.assertCurrent();
    return unsupported;
  });
  owner.assertCurrent();
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new JudgmentAuthorityRetiredError());
    owner.signal.addEventListener('abort', abort, { once: true });
    if (owner.signal.aborted) abort();
  });
  try {
    const result = await Promise.race([pending, stopped]);
    owner.assertCurrent();
    return result;
  } finally { owner.signal.removeEventListener('abort', abort); }
}

interface ProtocolCache {
  readonly reasoningRejection: ReadingMemo<boolean>;
  readonly partMemo: ReadingMemo<boolean>;
  readonly partKinds: Map<string, boolean>;
  readonly stopMemo: ReadingMemo<ReadStopReason>;
  readonly familyMemo: ReadingMemo<ReasoningFamily | null>;
  readonly families: Map<string, ReasoningFamily | null>;
}
let protocolCaches = new WeakMap<object, ProtocolCache>();
function configured(site: string) {
  const owner = captureJudgmentPort(site, { prepareResultCapture: prepareJudgmentResult });
  owner.assertCurrent();
  let cache = protocolCaches.get(owner.identity);
  if (!cache) {
    cache = { reasoningRejection: new ReadingMemo(256), partMemo: new ReadingMemo(128), partKinds: new Map(),
      stopMemo: new ReadingMemo(64), familyMemo: new ReadingMemo(512), families: new Map() };
    protocolCaches.set(owner.identity, cache);
  }
  return { owner, cache, call: { site, signal: owner.signal, beforeAttempt: owner.assertCurrent } };
}
function rememberSettled<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

/** A rejection about a reasoning setting must be settled in either direction. */
export async function readsAsReasoningRejection(providerText: string, site: string): Promise<boolean> {
  const state = { error: providerText };
  assertJudgmentInput(state);
  const { owner, cache, call } = configured(site);
  const result = await cache.reasoningRejection.get(providerText, async () => {
    const run = await reasoningRejection.run(owner.port, state, call);
    owner.assertCurrent();
    const reasoning = holds(run.readings.reasoning);
    run.recordAction(reasoning ? 'name-reasoning-setting' : 'leave-message');
    owner.assertCurrent(); return reasoning;
  });
  owner.assertCurrent(); return result;
}

/** Peeks only at settled evidence from the current installation/model. */
export function knownContentPartIsReasoning(label: string): boolean | undefined {
  try { return configured('routing.content-part-kind.peek').cache.partKinds.get(label); } catch { return undefined; }
}
export async function readContentPartIsReasoning(label: string, site: string): Promise<boolean> {
  assertJudgmentInput({ type: label });
  const { owner, cache, call } = configured(site);
  const result = await cache.partMemo.get(label, async () => {
    const run = await contentPartKind.run(owner.port, { type: label }, call);
    owner.assertCurrent();
    const reasoning = holds(run.readings.reasoning);
    run.recordAction(reasoning ? 'reasoning' : 'content');
    owner.assertCurrent(); rememberSettled(cache.partKinds, label, reasoning, 128);
    return reasoning;
  });
  owner.assertCurrent(); return result;
}

export type ReadStopReason = 'completed' | 'tool_call' | 'max_tokens';
/** Uncertain stop reasons never report completion. */
export async function readStopReason(rawReason: string, site: string): Promise<ReadStopReason> {
  assertJudgmentInput({ raw_reason: rawReason });
  const { owner, cache, call } = configured(site);
  const result = await cache.stopMemo.get(rawReason, async () => {
    const run = await stopReason.run(owner.port, { raw_reason: rawReason }, call);
    owner.assertCurrent();
    const stop = requireActingReading(run.readings.stop).choice;
    run.recordAction(`stop:${stop}`); owner.assertCurrent(); return stop;
  });
  owner.assertCurrent(); return result;
}

export function knownReasoningFamily(modelId: string): ReasoningFamily | null | undefined {
  try { return configured('routing.reasoning-family.peek').cache.families.get(modelId); } catch { return undefined; }
}
/** Null means a settled none, never an unavailable or uncertain reading. */
export async function readReasoningFamily(modelId: string, site: string): Promise<ReasoningFamily | null> {
  assertJudgmentInput({ model_id: modelId });
  const { owner, cache, call } = configured(site);
  const result = await cache.familyMemo.get(modelId, async () => {
    const dispatched = await reasoningFamily.route(owner.port, { model_id: modelId }, call);
    owner.assertCurrent(); requireActingReading(dispatched.reading);
    const family = dispatched.route !== 'none' ? dispatched.route : null;
    dispatched.recordAction(`family:${family ?? 'none'}`);
    owner.assertCurrent(); rememberSettled(cache.families, modelId, family, 512); return family;
  });
  owner.assertCurrent(); return result;
}

export function forgetProviderReadings(): void {
  alternateApiMemos = new WeakMap();
  protocolCaches = new WeakMap();
}
