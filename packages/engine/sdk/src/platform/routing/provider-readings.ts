/**
 * The provider protocol readings as the adapters call them. Each reads the
 * wording or label Jev judges (batteries/provider.ts) and remembers what it
 * read, so a label, a stop reason or a model id is read once per process.
 * Status codes, well-known ports and documented wire values stay with the
 * callers as code.
 */
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import {
  alternateApi,
  contentPartKind,
  localServerIdentity,
  reasoningFamily,
  reasoningRejection,
  stopReason,
  type ReasoningFamily,
} from './batteries/provider.js';

const holds = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';

/** A bounded memo of settled readings; a failed reading is forgotten and asked again. */
class ReadingMemo<V> {
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
    pending.catch(() => this.#values.delete(key));
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

/** How many model ids the server identity reading sees. */
const PROBE_MODEL_IDS = 20;

export type LocalServerSoftware = typeof localServerIdentity.routes[number];

/** Which server software answered a probe; 'unknown' unless the reading is strong enough to act on. */
export async function readLocalServerIdentity(evidence: ServerProbeEvidence, site: string): Promise<LocalServerSoftware> {
  const dispatched = await localServerIdentity.route(judgmentPort(site), {
    port: evidence.port,
    headers: { ...evidence.headers },
    model_ids: evidence.modelIds.slice(0, PROBE_MODEL_IDS),
  }, { site });
  const software = dispatched.reading.outcome === 'act' ? dispatched.route : 'unknown';
  dispatched.recordAction(`server:${software}`);
  return software;
}

/** Long error bodies say what they mean in their opening. */
const MAX_ERROR_CHARS = 1_500;
const alternateApiMemo = new ReadingMemo<boolean>(256);

/**
 * Whether a local server's error (one the status alone did not settle) means
 * the request should go through the server's other API.
 */
export function readsAsAlternateApi(error: { readonly status?: number | undefined; readonly message: string }, site: string): Promise<boolean> {
  const state = { ...(error.status === undefined ? {} : { status: error.status }), error: error.message.slice(0, MAX_ERROR_CHARS) };
  return alternateApiMemo.get(JSON.stringify(state), async () => {
    const run = await alternateApi.run(judgmentPort(site), state, { site });
    const unsupported = holds(run.readings.unsupported);
    run.recordAction(unsupported ? 'use-other-api' : 'rethrow');
    return unsupported;
  });
}

const reasoningRejectionMemo = new ReadingMemo<boolean>(256);

/** Whether a provider rejection names the request's reasoning setting as the cause. */
export function readsAsReasoningRejection(providerText: string, site: string): Promise<boolean> {
  const state = { error: providerText.slice(0, MAX_ERROR_CHARS) };
  return reasoningRejectionMemo.get(state.error, async () => {
    const run = await reasoningRejection.run(judgmentPort(site), state, { site });
    const reasoning = holds(run.readings.reasoning);
    run.recordAction(reasoning ? 'name-reasoning-setting' : 'leave-message');
    return reasoning;
  });
}

const partKinds = new Map<string, boolean>();
const partKindMemo = new ReadingMemo<boolean>(128);

/** The remembered reading for a content-part type label, or undefined when it has not been read. */
export function knownContentPartIsReasoning(label: string): boolean | undefined {
  return partKinds.get(label);
}

/** Reads whether content parts with this unfamiliar type label carry reasoning. */
export function readContentPartIsReasoning(label: string, site: string): Promise<boolean> {
  return partKindMemo.get(label, async () => {
    const run = await contentPartKind.run(judgmentPort(site), { type: label }, { site });
    const reasoning = holds(run.readings.reasoning);
    run.recordAction(reasoning ? 'reasoning' : 'content');
    partKinds.set(label, reasoning);
    return reasoning;
  });
}

export type ReadStopReason = 'completed' | 'tool_call' | 'max_tokens';
const stopReasonMemo = new ReadingMemo<ReadStopReason>(64);

/** What an unfamiliar raw stop reason reports; 'completed' when the reading is too weak to say otherwise. */
export function readStopReason(rawReason: string, site: string): Promise<ReadStopReason> {
  return stopReasonMemo.get(rawReason, async () => {
    const run = await stopReason.run(judgmentPort(site), { raw_reason: rawReason }, { site });
    const reading = run.readings.stop;
    const stop = reading.outcome === 'escalate' ? 'completed' : reading.choice;
    run.recordAction(`stop:${stop}`);
    return stop;
  });
}

const families = new Map<string, ReasoningFamily | null>();
const familyMemo = new ReadingMemo<ReasoningFamily | null>(512);

/** The remembered reasoning family of a model id: a family, null for none, undefined when not read. */
export function knownReasoningFamily(modelId: string): ReasoningFamily | null | undefined {
  return families.get(modelId);
}

/** Reads which documented reasoning-control family a model id belongs to; null when none, or when the reading is too weak to act on. */
export function readReasoningFamily(modelId: string, site: string): Promise<ReasoningFamily | null> {
  const known = families.get(modelId);
  if (known !== undefined) return Promise.resolve(known);
  return familyMemo.get(modelId, async () => {
    const dispatched = await reasoningFamily.route(judgmentPort(site), { model_id: modelId }, { site });
    const family = dispatched.reading.outcome === 'act' && dispatched.route !== 'none' ? dispatched.route : null;
    dispatched.recordAction(`family:${family ?? 'none'}`);
    families.set(modelId, family);
    return family;
  });
}

/** Forgets every remembered protocol reading; for tests that swap the judgment port. */
export function forgetProviderReadings(): void {
  alternateApiMemo.clear();
  reasoningRejectionMemo.clear();
  partKinds.clear();
  partKindMemo.clear();
  stopReasonMemo.clear();
  families.clear();
  familyMemo.clear();
}
