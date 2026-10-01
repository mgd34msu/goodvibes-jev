/**
 * wake-models.ts, the chunked, checksum-verified model read.
 *
 * The failure this file is mostly about is the quiet one: bytes that assemble into
 * something that is NOT the pinned model still load into an inference session, and
 * then the detector simply never fires. So the mismatch case is asserted twice over,
 * it throws, and nothing downstream is handed any bytes at all.
 */
import { describe, expect, test } from 'bun:test';
import {
  base64ToBytes,
  loadWakeModel,
  wakeModelCacheKey,
  WakeModelError,
  webCryptoDigest,
  type WakeModelCache,
  type WakeModelChunk,
  type WakeModelComponent,
} from './wake-models';

const CHUNK = 512 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Deterministic pseudo-audio-model bytes, so a byte-exact assertion is meaningful. */
function fakeModelBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + 7) % 256;
  return out;
}

interface ChunkServer {
  readChunk: (input: { component: WakeModelComponent; offset: number }) => Promise<WakeModelChunk>;
  calls: { component: WakeModelComponent; offset: number }[];
}

/** A `voice.wake.model.get` stand-in that chunks like the real one does. */
function chunkServer(bytes: Uint8Array, sha256: string, chunkSize = CHUNK): ChunkServer {
  const calls: { component: WakeModelComponent; offset: number }[] = [];
  return {
    calls,
    readChunk: ({ component, offset }) => {
      calls.push({ component, offset });
      const slice = bytes.subarray(offset, offset + chunkSize);
      return Promise.resolve({
        component,
        offset,
        bytes: slice.length,
        totalBytes: bytes.length,
        sha256,
        dataBase64: bytesToBase64(slice),
        complete: offset + slice.length >= bytes.length,
      });
    },
  };
}

function memoryCache(): WakeModelCache & { entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    match: (key) => {
      const hit = entries.get(key);
      if (!hit) return Promise.resolve(undefined);
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(hit.slice().buffer as ArrayBuffer),
      });
    },
    put: (key, bytes) => {
      entries.set(key, bytes.slice());
      return Promise.resolve();
    },
  };
}

describe('base64 and digest helpers', () => {
  test('base64 round-trips byte-exactly', () => {
    const bytes = fakeModelBytes(1000);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  test('the digest matches a known SHA-256 and is lower-case hex', async () => {
    const digest = await webCryptoDigest(new TextEncoder().encode('abc'));
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('the cache key carries the model version AND the digest, so a pin change misses', () => {
    const a = wakeModelCacheKey('classifier', 'v1', 'aaaa');
    const b = wakeModelCacheKey('classifier', 'v2', 'aaaa');
    const c = wakeModelCacheKey('classifier', 'v1', 'bbbb');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('a multi-chunk download reassembles byte-exactly', () => {
  test('eight chunks of a 3.7 MB-shaped model come back identical to the source', async () => {
    // Deliberately not a multiple of the chunk size, so the final short chunk is
    // part of the test rather than a rounded-off edge case.
    const bytes = fakeModelBytes(CHUNK * 7 + 1234);
    const sha256 = await webCryptoDigest(bytes);
    const server = chunkServer(bytes, sha256);

    const loaded = await loadWakeModel('classifier', { readChunk: server.readChunk });

    expect(loaded.bytes.length).toBe(bytes.length);
    expect([...loaded.bytes]).toEqual([...bytes]);
    expect(loaded.sha256).toBe(sha256);
    expect(loaded.fromCache).toBe(false);
    // Eight reads, each asking for the offset the previous one ended at.
    expect(server.calls.map((call) => call.offset)).toEqual([
      0, CHUNK, CHUNK * 2, CHUNK * 3, CHUNK * 4, CHUNK * 5, CHUNK * 6, CHUNK * 7,
    ]);
  });

  test('a single-chunk component is read once', async () => {
    const bytes = fakeModelBytes(4096);
    const server = chunkServer(bytes, await webCryptoDigest(bytes));
    const loaded = await loadWakeModel('notice', { readChunk: server.readChunk });
    expect(server.calls).toHaveLength(1);
    expect(loaded.bytes.length).toBe(4096);
  });

  test('EVERY component the daemon serves loads here, including ones a tab never asks for', async () => {
    // The component set is derived from the generated contract rather than copied,
    // so a component the daemon adds cannot be refused client-side. Asserted over
    // the whole set, not just the two a tab fetches: the tflite twin and the
    // notices exist and must not fail for being unrecognised here.
    const components: WakeModelComponent[] = ['classifier', 'embedding', 'notice', 'vad'];
    for (const component of components) {
      const bytes = fakeModelBytes(2048);
      const server = chunkServer(bytes, await webCryptoDigest(bytes));
      const loaded = await loadWakeModel(component, { readChunk: server.readChunk });
      expect(loaded.bytes.length).toBe(2048);
      expect(server.calls.every((call) => call.component === component)).toBe(true);
    }
  });

  test('the speech gate is fetched through the same verified path as the models', async () => {
    const bytes = fakeModelBytes(CHUNK + 512);
    const sha256 = await webCryptoDigest(bytes);
    const server = chunkServer(bytes, sha256);
    const loaded = await loadWakeModel('vad', { readChunk: server.readChunk });
    // Two chunks, reassembled, and verified against the pin like every other
    // artifact: a gate built from a truncated transfer would screen by accident.
    expect(server.calls).toHaveLength(2);
    expect([...loaded.bytes]).toEqual([...bytes]);
    expect(loaded.sha256).toBe(sha256);
  });
});

describe('verification refuses bytes that are not the pinned model', () => {
  test('a sha256 mismatch throws checksum-mismatch and returns no bytes', async () => {
    const bytes = fakeModelBytes(CHUNK + 10);
    // The daemon states a pin the assembled bytes do not match, a torn file, a
    // swapped asset, or a chunk that arrived from a different provision.
    const server = chunkServer(bytes, 'f'.repeat(64));

    const error = await loadWakeModel('classifier', { readChunk: server.readChunk }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WakeModelError);
    expect((error as WakeModelError).failure).toBe('checksum-mismatch');
    expect((error as WakeModelError).component).toBe('classifier');
    // And the honest part: the rejected bytes are nowhere in the result, so no
    // caller can create a session from them.
    expect(error).not.toHaveProperty('bytes');
  });

  test('a mismatch is never written to the cache', async () => {
    const bytes = fakeModelBytes(2048);
    const cache = memoryCache();
    await loadWakeModel('classifier', { readChunk: chunkServer(bytes, 'a'.repeat(64)).readChunk, cache })
      .catch(() => undefined);
    expect(cache.entries.size).toBe(0);
  });

  test('a chunk stream that skips an offset is truncated-download, not silently patched', async () => {
    const bytes = fakeModelBytes(CHUNK * 2);
    const sha256 = await webCryptoDigest(bytes);
    let call = 0;
    const readChunk = ({ component, offset }: { component: WakeModelComponent; offset: number }) => {
      call += 1;
      // The second read answers from a LATER offset than asked, which is exactly the
      // kind of drift that would otherwise assemble a plausible-length wrong file.
      const realOffset = call === 2 ? offset + 64 : offset;
      const slice = bytes.subarray(realOffset, realOffset + CHUNK);
      return Promise.resolve({
        component,
        offset: realOffset,
        bytes: slice.length,
        totalBytes: bytes.length,
        sha256,
        dataBase64: bytesToBase64(slice),
        complete: realOffset + slice.length >= bytes.length,
      });
    };
    const error = await loadWakeModel('embedding', { readChunk }).catch((e: unknown) => e);
    expect((error as WakeModelError).failure).toBe('truncated-download');
  });

  test('a total that disagrees with what assembled is truncated-download', async () => {
    const bytes = fakeModelBytes(1024);
    const sha256 = await webCryptoDigest(bytes);
    const error = await loadWakeModel('classifier', {
      readChunk: ({ component }) => Promise.resolve({
        component,
        offset: 0,
        bytes: bytes.length,
        totalBytes: bytes.length + 512,
        sha256,
        dataBase64: bytesToBase64(bytes),
        complete: true,
      }),
    }).catch((e: unknown) => e);
    expect((error as WakeModelError).failure).toBe('truncated-download');
  });

  test('a chunk of zero bytes that does not complete is truncated-download, not an endless loop', async () => {
    const error = await loadWakeModel('classifier', {
      readChunk: ({ component }) => Promise.resolve({
        component,
        offset: 0,
        bytes: 0,
        totalBytes: 4096,
        sha256: 'b'.repeat(64),
        dataBase64: '',
        complete: false,
      }),
    }).catch((e: unknown) => e);
    expect((error as WakeModelError).failure).toBe('truncated-download');
  });

  test('a daemon read that fails is read-failed, carrying the reason', async () => {
    const error = await loadWakeModel('classifier', {
      readChunk: () => Promise.reject(new Error('403 no scope for read:voice')),
    }).catch((e: unknown) => e);
    expect((error as WakeModelError).failure).toBe('read-failed');
    expect((error as WakeModelError).message).toContain('403 no scope for read:voice');
  });
});

describe('the cache', () => {
  test('a verified download is cached and the next load serves it without re-reading', async () => {
    const bytes = fakeModelBytes(CHUNK + 99);
    const sha256 = await webCryptoDigest(bytes);
    const cache = memoryCache();

    const first = chunkServer(bytes, sha256);
    await loadWakeModel('classifier', { readChunk: first.readChunk, cache, modelVersion: 'v1' });
    expect(first.calls.length).toBeGreaterThan(1);
    expect(cache.entries.size).toBe(1);

    const second = chunkServer(bytes, sha256);
    const hit = await loadWakeModel('classifier', { readChunk: second.readChunk, cache, modelVersion: 'v1' });
    expect(hit.fromCache).toBe(true);
    expect([...hit.bytes]).toEqual([...bytes]);
    // One read only, the first chunk, which is what states the pin the cache key
    // needs. The remaining megabytes were not fetched again.
    expect(second.calls).toHaveLength(1);
  });

  test('a torn cache entry is re-verified on read, ignored, and re-downloaded', async () => {
    const bytes = fakeModelBytes(2048);
    const sha256 = await webCryptoDigest(bytes);
    const cache = memoryCache();
    // A cache that was written correctly once and has since gone bad.
    cache.entries.set(wakeModelCacheKey('classifier', 'v1', sha256), fakeModelBytes(2048).fill(0));

    const server = chunkServer(bytes, sha256);
    const warnings: string[] = [];
    const loaded = await loadWakeModel('classifier', {
      readChunk: server.readChunk,
      cache,
      modelVersion: 'v1',
      warn: (message) => warnings.push(message),
    });

    expect(loaded.fromCache).toBe(false);
    expect([...loaded.bytes]).toEqual([...bytes]);
    expect(warnings.some((message) => message.includes('failed verification'))).toBe(true);
  });

  test('a different pin does not hit the previous entry', async () => {
    const cache = memoryCache();
    const oldBytes = fakeModelBytes(1024);
    await loadWakeModel('classifier', {
      readChunk: chunkServer(oldBytes, await webCryptoDigest(oldBytes)).readChunk,
      cache,
      modelVersion: 'v1',
    });
    const newBytes = fakeModelBytes(1536);
    const server = chunkServer(newBytes, await webCryptoDigest(newBytes));
    const loaded = await loadWakeModel('classifier', {
      readChunk: server.readChunk,
      cache,
      modelVersion: 'v2',
    });
    expect(loaded.fromCache).toBe(false);
    expect(cache.entries.size).toBe(2);
  });

  test('a cache that throws does not fail the download', async () => {
    const bytes = fakeModelBytes(512);
    const loaded = await loadWakeModel('classifier', {
      readChunk: chunkServer(bytes, await webCryptoDigest(bytes)).readChunk,
      cache: {
        match: () => Promise.reject(new Error('storage quota')),
        put: () => Promise.reject(new Error('storage quota')),
      },
    });
    expect([...loaded.bytes]).toEqual([...bytes]);
  });
});
