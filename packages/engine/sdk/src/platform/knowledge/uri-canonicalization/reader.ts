import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { prepareJudgmentResult, retainStrictJudgmentJson } from '../../gate/judgment-result.js';
import { knowledgeUriRef } from './battery.js';
import { KNOWLEDGE_URI_LIMITS as LIMITS, KnowledgeUriCanonicalizationHeldError as Held,
  type KnowledgeUriCanonicalizer, type KnowledgeUriOptions } from './types.js';
export * from './types.js';

interface UriInput { readonly input: string; readonly parameters: readonly (readonly [string, string])[]; }
interface RefInput { readonly uri: UriInput; readonly position: number; readonly value: string; }
const failure = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
  : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
const admission = (reason: 'malformed' | 'stale') => new Held(reason);
function normalized(uri: UriInput, referralPositions: ReadonlySet<number>): string {
  const url = new URL(uri.input);
  url.hash = ''; url.protocol = url.protocol.toLowerCase(); url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  const parameters = uri.parameters.filter(([key], position) => !/^utm_/i.test(key) && key !== 'gclid' && key !== 'fbclid'
    && !(key === 'ref' && referralPositions.has(position))).sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of parameters) url.searchParams.append(key, value);
  if (url.pathname !== '/' && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
/** Only exact ref occurrences need a reading. Their complete originals and decoded fields precede caps, removal and cache lookup. */
function captureInputs(inputs: readonly string[]) {
  const owned = retainStrictJudgmentJson(inputs, admission), originals = owned.snapshot;
  if (!Array.isArray(originals) || !originals.every((input) => typeof input === 'string')) throw new Held('malformed');
  const uris = originals.map((input): UriInput | null => {
    let url: URL; try { url = new URL(input); } catch { return null; }
    const parameters = [...url.searchParams.entries()];
    // A URI without ref has only the original mechanical contract and makes no outward request.
    if (!parameters.some(([key]) => key === 'ref')) return { input, parameters };
    if (url.username || url.password) throw new JudgmentInputError('credential-material');
    const fields: Record<string, string[]> = Object.create(null);
    for (const [key, value] of parameters) (fields[key] ??= []).push(value);
    let decoded = input; try { decoded = decodeURIComponent(input); } catch { /* URL parsing retains malformed escape spelling. */ }
    assertJudgmentInput({ uri: input, decodedUri: decoded, query: fields });
    return { input, parameters };
  });
  const selected = uris.filter((uri): uri is UriInput => uri !== null && uri.parameters.some(([key]) => key === 'ref'));
  if (selected.length > LIMITS.inputs || selected.reduce((sum, uri) => sum + uri.input.length, 0) > LIMITS.characters) throw new Held('budget');
  owned.assertCurrent(); return { uris, assertCurrent: owned.assertCurrent };
}
/** One actual operation owns the settled URI cache, source/caller restriction and installed judgment lifetime. */
export function createKnowledgeUriCanonicalizer(options: KnowledgeUriOptions = {}): KnowledgeUriCanonicalizer {
  if (nodeTypes.isProxy(options)) throw new Held('malformed');
  const prototype = Object.getPrototypeOf(options), descriptors = Object.getOwnPropertyDescriptors(options);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(options).length
    || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new Held('malformed');
  const { signal, assertCurrent: ownerCurrent, timeoutMs: configuredTimeout } = options;
  if ((signal !== undefined && !(signal instanceof AbortSignal)) || (ownerCurrent !== undefined
    && (typeof ownerCurrent !== 'function' || nodeTypes.isProxy(ownerCurrent) || nodeTypes.isAsyncFunction(ownerCurrent)))) throw new Held('malformed');
  const timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  let authority: JudgmentPortCapture | undefined, resultModel: string | undefined, failed: Error | undefined;
  let requests = 0, bytes = 0, queue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, string>(), retained: (() => void)[] = [];
  const assertOptions = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (Object.getPrototypeOf(options) !== prototype) throw new Held('stale');
    for (const key of ['signal', 'assertCurrent', 'timeoutMs']) {
      const current = Object.getOwnPropertyDescriptor(options, key), original = descriptors[key];
      if ((original === undefined) !== (current === undefined) || current?.get || current?.set || current?.value !== original?.value
        || current?.enumerable !== original?.enumerable || current?.configurable !== original?.configurable || current?.writable !== original?.writable) throw new Held('stale');
    }
  };
  const assertOwnerCurrent = () => {
    assertOptions();
    let result: unknown;
    try { result = ownerCurrent?.(); } catch (error) { throw error instanceof Held ? error : new Held('stale'); }
    if (result !== undefined) { try { void Promise.resolve(result).catch(() => {}); } catch {} throw new Held('stale'); }
    assertOptions();
    for (const check of retained) check();
  };
  const assertCurrent = () => {
    if (failed) throw failed;
    try { assertOwnerCurrent(); authority?.assertCurrent(); }
    catch (error) { failed ??= failure(error); throw failed; }
  };
  async function run(batch: ReturnType<typeof captureInputs>): Promise<readonly (string | null)[]> {
    batch.assertCurrent(); assertCurrent();
    const pending = [...new Map(batch.uris.filter((uri): uri is UriInput => uri !== null && !cache.has(uri.input)).map((uri) => [uri.input, uri])).values()];
    const refs: RefInput[] = pending.flatMap((uri) => uri.parameters.flatMap(([key, value], position) => key === 'ref' ? [{ uri, position, value }] : []));
    const states = refs.map(({ uri, position, value }) => ({ url: uri.input, parameters: uri.parameters.map(([key, entry]) => ({ key, value: entry })),
      target: { position, key: 'ref', value } }));
    assertJudgmentInput(states);
    const pendingBytes = states.reduce((sum, state) => sum + new TextEncoder().encode(JSON.stringify({ state, questions: knowledgeUriRef.items })).byteLength + 1_024, 0);
    if (requests + refs.length > LIMITS.requests || bytes + pendingBytes > LIMITS.bytes) throw new Held('budget');
    if (refs.length && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > LIMITS.timeoutMs)) throw new Held('budget');
    const removals = new Map<string, Set<number>>();
    if (refs.length) {
      authority ??= captureJudgmentPort(knowledgeUriRef.name, { signal, assertCurrent: assertOwnerCurrent,
        prepareResultCapture: (questions) => prepareJudgmentResult(questions, admission) });
      const captured = authority.port, configuredModel = captured.model;
      if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw new Held('malformed');
      requests += refs.length; bytes += pendingBytes;
      const controller = new AbortController(), active = AbortSignal.any([controller.signal, authority.signal, ...(signal ? [signal] : [])]);
      let stoppedError: Error | undefined, rejectStopped: (error: Error) => void = () => {};
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const stop = (error: Error) => { stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
      const abort = () => { if (!stoppedError) stop(new Held(signal?.aborted ? 'aborted' : 'stale')); };
      active.addEventListener('abort', abort, { once: true });
      const timer = timeoutMs > 0 ? setTimeout(() => stop(new Held('budget')), timeoutMs) : undefined;
      const check = () => { if (stoppedError) throw stoppedError; batch.assertCurrent(); assertCurrent(); };
      const port: JudgmentPort = { model: configuredModel, ...(captured.recorder ? { recorder: captured.recorder } : {}), async ask(request) {
        check(); const result = await captured.ask({ ...request, model: configuredModel }); check();
        if (typeof result.model !== 'string' || !result.model.trim() || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()) throw new Held('malformed');
        if (result.requestedModel !== configuredModel || (resultModel !== undefined && result.model !== resultModel)) throw new Held('stale');
        resultModel = result.model; return result;
      } };
      let next = 0;
      const work = async () => {
        await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, refs.length) }, async () => {
          while (next < refs.length) {
            try {
              check(); const index = next++, ref = refs[index]!, state = states[index]!;
              const result = await knowledgeUriRef.run(port, state, { signal: active, site: knowledgeUriRef.name });
              check(); const reading = result.readings.referral;
              if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
              if (reading.verdict === 'yes') { const positions = removals.get(ref.uri.input) ?? new Set<number>(); positions.add(ref.position); removals.set(ref.uri.input, positions); }
              result.recordAction(reading.verdict === 'yes' ? 'referral occurrence omitted from URI identity; no fetch or write permission'
                : 'page-address ref occurrence retained in URI identity; no fetch or write permission');
              check();
            } catch (error) { const held = failure(error); stop(held); throw held; }
          }
        }));
      };
      try { await Promise.race([work(), stopped]); check(); }
      finally { clearTimeout(timer); active.removeEventListener('abort', abort); controller.abort(); }
    }
    batch.assertCurrent(); assertCurrent();
    const settled = pending.map((uri) => [uri.input, normalized(uri, removals.get(uri.input) ?? new Set<number>())] as const);
    batch.assertCurrent(); assertCurrent();
    for (const [input, result] of settled) cache.set(input, result);
    retained.push(batch.assertCurrent);
    return Object.freeze(batch.uris.map((uri) => uri === null ? null : cache.get(uri.input)!));
  }
  const canonicalizeAll = async (inputs: readonly string[]) => {
    let batch: ReturnType<typeof captureInputs>;
    try { batch = captureInputs(inputs); assertCurrent(); }
    catch (error) { failed ??= failure(error); throw failed; }
    const result = queue.then(() => run(batch)).catch((error: unknown) => { failed ??= failure(error); throw failed; });
    queue = result.catch(() => {}); return result;
  };
  assertCurrent();
  return Object.freeze({ assertCurrent, canonicalizeAll, async canonicalize(input: string) { return (await canonicalizeAll([input]))[0] ?? null; } });
}
