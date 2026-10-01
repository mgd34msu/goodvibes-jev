/**
 * wake-models.ts, how a browser tab gets the pinned wake-word models.
 *
 * NOT FROM THE INTERNET. The pinned release assets answer without an
 * `access-control-allow-origin` header, so a tab's `fetch` of the model URL is
 * refused by the browser before it ever reaches the bytes. The daemon already has
 * the files (it provisions and checksum-verifies them), so it serves them:
 * `voice.wake.model` reads one component in 512 kB chunks and returns base64 plus
 * the PINNED sha256 of the whole file.
 *
 * SO THE CHECKSUM IS VERIFIED HERE, ON THE ASSEMBLED BYTES, before a session is
 * created from them. A chunked read has three ways to go wrong quietly, a
 * dropped chunk, a duplicated offset, a mid-read provision that swaps the file,
 * and none of them produces an error. What they produce is a model that loads and
 * then never detects anything, which is indistinguishable from a microphone that
 * is not working. A mismatch therefore fails loudly and creates no session.
 *
 * Verified bytes are cached in the Cache API under a key that carries the model
 * version AND the sha256, so a reload does not re-download 3.7 MB and a pin
 * change cannot be served a stale hit, a different pin is a different key.
 */

import type { OperatorMethodInput } from '../goodvibes';

/**
 * Every component `voice.wake.model.get` serves, DERIVED from the generated
 * contract rather than copied.
 *
 * The daemon's set grows, the tflite twin, the speech gate and its notice, an
 * embedding notice, and a hand-written copy here would refuse a valid component
 * client-side the moment one was added, which is a failure the consumer causes and
 * the daemon cannot see. A tab only ever FETCHES what it needs (classifier,
 * embedding, and the gate when a voice-activity floor is configured); this type is
 * about what it must not reject.
 */
export type WakeModelComponent = OperatorMethodInput<'voice.wake.model.get'>['component'];

/** One chunk of a component, exactly as `voice.wake.model` answers. */
export interface WakeModelChunk {
  readonly component: WakeModelComponent;
  readonly offset: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly dataBase64: string;
  readonly complete: boolean;
}

/** Why a component could not be loaded, as a named state rather than a message. */
export type WakeModelFailure =
  /** The assembled bytes did not match the pinned sha256. */
  | 'checksum-mismatch'
  /** The chunked read did not progress, or answered inconsistent totals. */
  | 'truncated-download'
  /** The daemon refused or failed the read. */
  | 'read-failed';

export class WakeModelError extends Error {
  readonly failure: WakeModelFailure;
  readonly component: WakeModelComponent;
  constructor(failure: WakeModelFailure, component: WakeModelComponent, message: string) {
    super(message);
    this.name = 'WakeModelError';
    this.failure = failure;
    this.component = component;
  }
}

/** A verified component, ready to become an inference session. */
export interface LoadedWakeModel {
  readonly component: WakeModelComponent;
  readonly bytes: Uint8Array;
  /** The pinned digest the bytes were verified against, lower-case hex. */
  readonly sha256: string;
  /** True when the bytes came from the tab's cache rather than the daemon. */
  readonly fromCache: boolean;
}

/** Reads one chunk. The web UI passes `sdk.operator.voice.wake.model`. */
export type WakeModelChunkReader = (input: {
  component: WakeModelComponent;
  offset: number;
}) => Promise<WakeModelChunk>;

/** SHA-256 of some bytes, lower-case hex. Injected so a test needs no WebCrypto. */
export type WakeModelDigest = (bytes: Uint8Array) => Promise<string>;

/** The subset of the Cache API this module uses. */
export interface WakeModelCache {
  match(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface WakeModelLoaderDeps {
  readonly readChunk: WakeModelChunkReader;
  readonly digest?: WakeModelDigest | undefined;
  readonly cache?: WakeModelCache | undefined;
  /** Model version from `voice.wake.status`, part of the cache key. */
  readonly modelVersion?: string | null | undefined;
  readonly warn?: ((message: string, meta?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** Cap on chunk iterations, so a daemon that never sets `complete` cannot spin. */
const MAX_CHUNKS = 256;

/** Bump when the stored representation changes, never for a new model version. */
const CACHE_NAME = 'goodvibes-wake-models-v1';

export function wakeModelCacheKey(
  component: WakeModelComponent,
  modelVersion: string | null | undefined,
  sha256: string,
): string {
  // A synthetic same-origin URL: the Cache API keys on request URLs, and these
  // are never fetched, the version and the digest are both in the path so a pin
  // change is a different entry rather than a stale hit.
  return `/__goodvibes-wake-model/${modelVersion ?? 'unversioned'}/${component}/${sha256}`;
}

/** Lower-case hex of a digest computed with WebCrypto. */
export async function webCryptoDigest(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as {
    crypto?: { subtle?: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } };
  }).crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is unavailable, so model bytes cannot be verified.');
  // A fresh copy: subtle.digest takes a BufferSource and a subarray view of a
  // larger buffer would hash the wrong span.
  const digest = await subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Decode base64 without Buffer (this runs in a tab). */
export function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  const maybeBuffer = (globalThis as {
    Buffer?: { from(data: string, encoding: string): Uint8Array };
  }).Buffer;
  if (maybeBuffer) return maybeBuffer.from(value, 'base64');
  throw new Error('No base64 decoder is available in this environment.');
}

/** The tab's Cache API, or undefined where it is not available (or blocked). */
export async function openWakeModelCache(): Promise<WakeModelCache | undefined> {
  const caches = (globalThis as { caches?: { open(name: string): Promise<CacheLike> } }).caches;
  if (!caches) return undefined;
  try {
    const cache = await caches.open(CACHE_NAME);
    return {
      match: async (key) => await cache.match(key),
      put: async (key, bytes) => {
        // A copy, because `put` may hold the buffer past this call.
        await cache.put(key, new Response(bytes.slice(), { headers: { 'content-type': 'application/octet-stream' } }));
      },
    };
  } catch {
    return undefined;
  }
}

interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/**
 * Download one component in chunks, assemble it, and verify it against the pinned
 * sha256 the daemon returned. Serves a cache hit when one matches that same pin.
 *
 * Throws {@link WakeModelError} rather than returning a partial result: there is
 * no useful degraded state between "these are the pinned bytes" and "these are
 * not", and the whole point of the verification is to refuse the second.
 */
export async function loadWakeModel(
  component: WakeModelComponent,
  deps: WakeModelLoaderDeps,
): Promise<LoadedWakeModel> {
  const digest = deps.digest ?? webCryptoDigest;

  // The first chunk carries the pinned sha256 and the total size, which is what
  // makes a cache lookup possible at all, the key includes the digest, so it
  // cannot be built before the daemon has stated it.
  let first: WakeModelChunk;
  try {
    first = await deps.readChunk({ component, offset: 0 });
  } catch (error) {
    throw new WakeModelError(
      'read-failed',
      component,
      `The daemon could not read the ${component} model: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const cacheKey = wakeModelCacheKey(component, deps.modelVersion, first.sha256);
  if (deps.cache) {
    try {
      const hit = await deps.cache.match(cacheKey);
      if (hit) {
        const cached = new Uint8Array(await hit.arrayBuffer());
        // Re-verified on read, not trusted for having been written once: a cache
        // is storage like any other and a torn entry must not become a model
        // that loads and never fires.
        const cachedDigest = await digest(cached);
        if (cachedDigest === first.sha256 && cached.length === first.totalBytes) {
          return { component, bytes: cached, sha256: first.sha256, fromCache: true };
        }
        deps.warn?.('cached wake model failed verification and was ignored', { component, cacheKey });
      }
    } catch (error) {
      deps.warn?.('wake model cache read failed', { component, error: String(error) });
    }
  }

  const parts: Uint8Array[] = [];
  let chunk = first;
  let received = 0;
  for (let iteration = 0; iteration < MAX_CHUNKS; iteration += 1) {
    if (chunk.offset !== received) {
      throw new WakeModelError(
        'truncated-download',
        component,
        `The ${component} model read jumped to offset ${chunk.offset} with ${received} bytes assembled.`,
      );
    }
    const bytes = base64ToBytes(chunk.dataBase64);
    parts.push(bytes);
    received += bytes.length;
    if (chunk.complete) break;
    if (bytes.length === 0) {
      throw new WakeModelError(
        'truncated-download',
        component,
        `The ${component} model read returned no bytes at offset ${chunk.offset} without completing.`,
      );
    }
    try {
      chunk = await deps.readChunk({ component, offset: received });
    } catch (error) {
      throw new WakeModelError(
        'read-failed',
        component,
        `The ${component} model read failed at offset ${received}: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  if (!chunk.complete) {
    throw new WakeModelError(
      'truncated-download',
      component,
      `The ${component} model did not finish within ${MAX_CHUNKS} reads.`,
    );
  }
  if (chunk.totalBytes !== received) {
    throw new WakeModelError(
      'truncated-download',
      component,
      `The ${component} model assembled ${received} bytes, but the daemon reported ${chunk.totalBytes}.`,
    );
  }

  const assembled = concatBytes(parts, received);
  const actual = await digest(assembled);
  if (actual !== chunk.sha256) {
    throw new WakeModelError(
      'checksum-mismatch',
      component,
      `The ${component} model failed verification: expected sha256 ${chunk.sha256}, assembled ${actual}. `
      + 'No session was created from it. A model that loads but never matches the pin would look exactly like a '
      + 'microphone that is not working.',
    );
  }

  if (deps.cache) {
    try {
      await deps.cache.put(cacheKey, assembled);
    } catch (error) {
      deps.warn?.('wake model cache write failed', { component, error: String(error) });
    }
  }

  return { component, bytes: assembled, sha256: chunk.sha256, fromCache: false };
}

function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
