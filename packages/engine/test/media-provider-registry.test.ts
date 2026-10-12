import { describe, expect, test } from 'bun:test';
import { MediaProviderRegistry, captureMediaProviderReadSource, type MediaProvider } from '@goodvibes-jev/engine/sdk/platform/media';

describe('MediaProviderRegistry', () => {
  test('registers media providers and dispatches capability lookups', async () => {
    const registry = new MediaProviderRegistry();
    registry.register({
      id: 'media-test',
      label: 'Media Test',
      capabilities: ['understand'],
      async analyze(request) {
        return {
          providerId: 'media-test',
          description: `saw ${request.artifact.mimeType}`,
          metadata: {},
        };
      },
    });

    expect(registry.list().map((entry) => entry.id)).toEqual(['media-test']);
    const provider = registry.findProvider('understand');
    expect(provider?.id).toBe('media-test');
    await expect(provider!.analyze!({
      artifact: { mimeType: 'image/png', dataBase64: 'x', metadata: {} },
    })).resolves.toEqual({
      providerId: 'media-test',
      description: 'saw image/png',
      metadata: {},
    });
  });
});


describe('native media catalog source', () => {
  test('retains an unchanged constructor-owned catalog without status probes', () => {
    const registry = new MediaProviderRegistry(); let probes = 0;
    registry.register({ id: 'source-media', label: 'Source media', capabilities: ['understand'], status() {
      probes++; return { id: 'source-media', label: 'Source media', capabilities: ['understand'], state: 'healthy', configured: true, metadata: {} };
    } });
    const current = captureMediaProviderReadSource(registry);
    expect(registry.list()[0]?.id).toBe('source-media');
    current(); current(); expect(probes).toBe(0);
  });
  test('initial native label accessors refuse before list invokes them', () => {
    const registry = new MediaProviderRegistry(); let reads = 0;
    const provider: MediaProvider = { id: 'source-media', label: 'Source media', capabilities: ['understand'] };
    registry.register(provider);
    Object.defineProperty(provider, 'label', { get() { reads++; return 'Source media'; } });
    expect(() => captureMediaProviderReadSource(registry)).toThrow(); expect(reads).toBe(0);
  });
  test('a late capability accessor refuses before a fresh native list read', () => {
    const registry = new MediaProviderRegistry(); let reads = 0;
    const provider: MediaProvider = { id: 'source-media', label: 'Source media', capabilities: ['understand'] };
    registry.register(provider); const current = captureMediaProviderReadSource(registry);
    Object.defineProperty(provider, 'capabilities', { get() { reads++; return ['understand']; } });
    expect(current).toThrow(); expect(reads).toBe(0);
  });
  test('a retained provider proxy is refused without reflection traps', () => {
    const registry = new MediaProviderRegistry(); let traps = 0;
    const provider = new Proxy<MediaProvider>({ id: 'source-media', label: 'Source media', capabilities: ['understand'] }, {
      ownKeys(target) { traps++; return Reflect.ownKeys(target); },
    });
    registry.register(provider); expect(() => captureMediaProviderReadSource(registry)).toThrow(); expect(traps).toBe(0);
  });
  test('native register and delete retires the original identical catalog', () => {
    const registry = new MediaProviderRegistry(); registry.register({ id: 'source-media', label: 'Source media', capabilities: ['understand'] });
    const before = registry.list(), current = captureMediaProviderReadSource(registry);
    registry.register({ id: 'temporary-media', label: 'Temporary media', capabilities: ['transform'] }); registry.unregister('temporary-media');
    expect(registry.list()).toEqual(before); expect(current).toThrow();
  });
  test('native replace and restore retains incarnation retirement', () => {
    const registry = new MediaProviderRegistry();
    const provider: MediaProvider = { id: 'source-media', label: 'Source media', capabilities: ['understand'] };
    registry.register(provider); const before = registry.list(), current = captureMediaProviderReadSource(registry);
    registry.register({ ...provider, label: 'Changed media' }, { replace: true }); registry.register(provider, { replace: true });
    expect(registry.list()).toEqual(before); expect(current).toThrow();
  });
  test('copied API and replaced issuer lookup cannot acquire an original source', () => {
    const registry = new MediaProviderRegistry(), copy = { ...registry };
    const descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get');
    if (!descriptor || !('value' in descriptor)) throw new Error('Missing native lookup');
    const get = WeakMap.prototype.get;
    try {
      Object.defineProperty(WeakMap.prototype, 'get', { ...descriptor, value: function(this: WeakMap<object, unknown>, key: object) {
        return get.call(this, key === copy ? registry : key);
      } });
      expect(() => Reflect.apply(captureMediaProviderReadSource, undefined, [copy])).toThrow();
      expect(() => captureMediaProviderReadSource(registry)()).not.toThrow();
    } finally { Object.defineProperty(WeakMap.prototype, 'get', descriptor); }
  });
});
