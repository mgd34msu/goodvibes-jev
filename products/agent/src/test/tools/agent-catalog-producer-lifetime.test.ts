import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as nativeOs from 'node:os';
import { ConfigManager } from '../../config/index.ts';
import { capturePairingAdvertisement } from '../../tools/agent-harness-pairing-posture.ts';
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { MediaProviderRegistry, type MediaProvider } from '@goodvibes-jev/engine/sdk/platform/media';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import type { RuntimeTask } from '@/runtime/index.ts';
import { captureCatalogNativeFacts, captureCatalogProducerSources, withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { captureAsyncHarnessInput } from '../../tools/agent-harness-async-input.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { createTasksReadModel } from '../helpers/ui-read-models.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

const selected = 'context.platform.readModels.device';
const methods = ['getSnapshot', 'snapshot', 'toJSON', 'list'];
let previous: ReturnType<typeof installJudgmentPort>;
const roots: string[] = [];
beforeEach(() => {
  const fixture = fakePort((name, question) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) return choiceAnswer(question, 'other', 0.999);
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name) && question.type === 'noul') return noulAnswer(0.001);
    throw new Error('Unscripted native source privacy request');
  });
  previous = installJudgmentPort(fixture.port);
});
afterEach(async () => {
  await cleanupResearchScreeningFixtures(); installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function read(frame: ReturnType<typeof captureCatalogProducerSources>, path = selected): unknown {
  const view = frame.source(path);
  if (!view || typeof view !== 'object' || !('getSnapshot' in view) || typeof view.getSnapshot !== 'function') throw new Error('Missing selected snapshot');
  return view.getSnapshot();
}
function pairingHome() {
  const root = makeProjectTempDir('catalog-pairing-source'); roots.push(root);
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const file = connectedHostOperatorTokenPath(home); mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  return { root, home, file, context: { workspace: { shellPaths: { homeDirectory: home, workingDirectory: root } } } };
}

describe('complete catalog producer acquisition', () => {
  test('retains hidden wrapper and complete method tail before any bounded collector', async () => {
    const row = { id: 'native-device', description: `${'Ordinary '.repeat(1200)}complete-native-tail` };
    const wrapper = { getSnapshot(): { records: Array<typeof row> } { expect(this).toBe(wrapper); return { records: [row] }; } };
    Object.defineProperty(wrapper, 'hidden', { value: 'complete-wrapper-field', enumerable: false });
    const context = { platform: { readModels: { device: wrapper } } };
    const native = captureCatalogProducerSources(context, [selected], methods); const value = read(native);
    expect<unknown>(value).toEqual({ records: [row] });
    const screening = researchScreeningFixture();
    const safe = await withModelReadingSource(native.evidence(), { sourceOwner: screening.owner, assertCurrent: native.assertCurrent }, async captured => captured);
    const wire = JSON.stringify(screening.calls);
    expect(wire).toContain('complete-wrapper-field'); expect(wire).toContain('complete-native-tail'); expect(JSON.stringify(safe)).toContain('complete-native-tail');
    row.description = 'Changed private tail'; expect(native.assertCurrent).toThrow();
  });
  test('complete Map keys, wrapper data and native rows remain in evidence', () => {
    const row = { id: 'native-device', detail: 'Complete map row' }, source = new Map([['exact-device-key', row]]);
    const native = captureCatalogProducerSources({ platform: { readModels: { device: source } } }, [selected], methods);
    expect(JSON.stringify(native.evidence())).toContain('exact-device-key'); expect(JSON.stringify(native.evidence())).toContain('Complete map row');
    source.set('late-device-key', { id: 'late', detail: 'Late row' }); expect(native.assertCurrent).toThrow();
  });
  test('initial path and hidden result accessors are refused with zero getter calls', () => {
    let getters = 0, callbacks = 0;
    const readModels = Object.defineProperty({}, 'device', { get() { getters++; return {}; } });
    expect(() => captureCatalogProducerSources({ platform: { readModels } }, [selected], methods)).toThrow();
    expect(getters).toBe(0);
    const result = Object.defineProperty({ records: [] }, 'hidden', { get() { getters++; return 'Hidden source'; } });
    const native = captureCatalogProducerSources({ platform: { readModels: { device: { getSnapshot() { callbacks++; return result; } } } } }, [selected], methods);
    expect(() => read(native)).toThrow(); expect(getters).toBe(0); expect(callbacks).toBe(1);
  });
  test('all selected root descriptors are bound before the first snapshot callback', () => {
    let calls = 0, getters = 0;
    const first = { getSnapshot() { calls++; return { records: [] }; } };
    const readModels = Object.defineProperty({ device: first }, 'companion', { get() { getters++; return {}; } });
    expect(() => captureCatalogProducerSources({ platform: { readModels } }, [selected, 'context.platform.readModels.companion'], methods)).toThrow();
    expect(calls).toBe(0); expect(getters).toBe(0);
  });
  test('a complete hidden card floor refuses before any producer callback', () => {
    let calls = 0;
    const wrapper = { getSnapshot() { calls++; return { records: [] }; } };
    Object.defineProperty(wrapper, 'hidden', { value: '4111111111111111' });
    expect(() => captureCatalogProducerSources({ platform: { readModels: { device: wrapper } } }, [selected], methods)).toThrow();
    expect(calls).toBe(0);
  });
  test('proxy wrappers are refused without traps', () => {
    let traps = 0;
    const wrapper = new Proxy({}, { ownKeys() { traps++; return []; }, get() { traps++; return undefined; } });
    expect(() => captureCatalogProducerSources({ platform: { readModels: { device: wrapper } } }, [selected], methods)).toThrow();
    expect(traps).toBe(0);
  });
  test('original holder, callback and result retirement all refuse before a replacement getter', () => {
    let getters = 0;
    const source = { getSnapshot() { return { records: [{ id: 'native-device' }] }; } };
    const context = { platform: { readModels: { device: source } } };
    const native = captureCatalogProducerSources(context, [selected], methods); read(native);
    Object.defineProperty(source, 'getSnapshot', { get() { getters++; return () => ({ records: [] }); } });
    expect(native.assertCurrent).toThrow(); expect(getters).toBe(0);
    const other = captureCatalogProducerSources({ platform: { readModels: { device: { records: [] } } } }, [selected], methods);
    expect(() => other.source('context.platform.readModels.unselected')).toThrow();
  });
  test('native publication and restore cannot revive original snapshot custody', () => {
    const store = createRuntimeStore(), dispatch = createDomainDispatch(store), source = createTasksReadModel(store);
    const task: RuntimeTask = { id: 'native-task', kind: 'exec', title: 'Original task', status: 'queued', owner: 'fixture', cancellable: true, childTaskIds: [], queuedAt: 4001 };
    dispatch.syncRuntimeTask(task);
    const context = { platform: { readModels: { device: source } } };
    const first = captureCatalogProducerSources(context, [selected], methods); read(first);
    dispatch.syncRuntimeTask({ ...task, title: 'Changed task' }); dispatch.syncRuntimeTask(task);
    const second = captureCatalogProducerSources(context, [selected], methods); read(second);
    expect(second.assertCurrent).not.toThrow(); expect(first.assertCurrent).toThrow();
  });
  test('retained original custody cannot acquire a newer frame or a parent callback cycle', async () => {
    const row = { id: 'native-device', description: 'Original description' }, context = { platform: { readModels: { device: { records: [row] } } } };
    const native = captureCatalogProducerSources(context, [selected], methods), retained = new Set<() => void>();
    const caller = captureAsyncHarnessInput({ query: 'native-device' }, { retainCurrent(guard) { retained.add(guard); } });
    caller.options.retainCurrent(native.assertCurrent); caller.retainSourceCurrent();
    const screening = researchScreeningFixture();
    await withModelReadingSource(native.evidence(), { ...caller.options, sourceOwner: screening.owner }, async captured => captured);
    expect(() => { for (const guard of retained) guard(); }).not.toThrow();
    row.description = 'Changed description'; const later = captureCatalogProducerSources(context, [selected], methods); later.assertCurrent();
    expect(() => { for (const guard of retained) guard(); }).toThrow();
  });
  test('late source retirement during native screening holds publication', async () => {
    const context = { platform: { readModels: { device: { records: [{ id: 'native-device' }] } } } };
    const native = captureCatalogProducerSources(context, [selected], methods); let consumed = false;
    const screening = researchScreeningFixture({ beforeProposal: async () => { context.platform.readModels.device = { records: [{ id: 'replacement-device' }] }; } });
    await expect(withModelReadingSource(native.evidence(), { sourceOwner: screening.owner, assertCurrent: native.assertCurrent }, async () => { consumed = true; })).rejects.toThrow();
    expect(consumed).toBe(false);
  });
});

describe('model-reading strict native restrictions', () => {
  test('nonvoid original guard refuses before native capture and consume', async () => {
    const screening = researchScreeningFixture(); let consumed = false;
    await expect(withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner, assertCurrent: () => 1 }, async () => { consumed = true; })).rejects.toThrow(ToolInputProjectionError);
    expect(screening.calls).toHaveLength(0); expect(consumed).toBe(false);
  });
  test('rejected native Promise guard is observed and cannot become synchronous approval', async () => {
    const screening = researchScreeningFixture(); let consumed = false;
    await expect(withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner, async assertCurrent() { throw new Error('Native asynchronous refusal'); } }, async () => { consumed = true; })).rejects.toThrow(ToolInputProjectionError);
    await Promise.resolve(); expect(screening.calls).toHaveLength(0); expect(consumed).toBe(false);
  });
  test('borrowed signal method accessors refuse without invocation or native wire', async () => {
    const screening = researchScreeningFixture(), abort = new AbortController(); let getters = 0;
    Object.defineProperty(abort.signal, 'throwIfAborted', { get() { getters++; return () => {}; } });
    await expect(withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner, signal: abort.signal }, async captured => captured)).rejects.toThrow();
    expect(getters).toBe(0); expect(screening.calls).toHaveLength(0);
  });
  test('nonvoid guard-retention callback refuses before owner screening', async () => {
    const screening = researchScreeningFixture();
    await expect(withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner, retainCurrent: () => 1 }, async captured => captured)).rejects.toThrow(ToolInputProjectionError);
    expect(screening.calls).toHaveLength(0);
  });
  test('every distinct retained native guard survives and is checked before publication', async () => {
    const screening = researchScreeningFixture(); let first = 0, second = 0;
    await withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner }, async (captured, current) => {
      current.retainCurrent?.(() => { first++; }, 'same-name'); current.retainCurrent?.(() => { second++; }, 'same-name'); return captured;
    });
    expect(first).toBeGreaterThan(0); expect(second).toBeGreaterThan(0);
    await expect(withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner }, async (captured, current) => {
      current.retainCurrent?.(() => Promise.reject(new Error('Retained asynchronous refusal'))); return captured;
    })).rejects.toThrow(ToolInputProjectionError);
    await Promise.resolve();
  });
  test('late inherited JSON serializer cannot change screened native array meaning', async () => {
    const screening = researchScreeningFixture(); const old = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON'); let getters = 0;
    try {
      await expect(withModelReadingSource({ rows: ['Native source'] }, { sourceOwner: screening.owner, assertCurrent() {
        Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, get() { getters++; return () => ['Changed meaning']; } });
      } }, async captured => captured)).rejects.toThrow(ToolInputProjectionError);
      expect(getters).toBe(0); expect(screening.calls).toHaveLength(0);
    } finally { if (old) Object.defineProperty(Array.prototype, 'toJSON', old); else Reflect.deleteProperty(Array.prototype, 'toJSON'); }
  });
  test('cancellation in the native screening await prevents consumption and drains custody', async () => {
    const abort = new AbortController(); let consumed = false;
    const screening = researchScreeningFixture({ beforeProposal: async () => { abort.abort(); } });
    await expect(withModelReadingSource({ text: 'Native source' }, { sourceOwner: screening.owner, signal: abort.signal }, async () => { consumed = true; })).rejects.toThrow();
    expect(consumed).toBe(false); await screening.owner.close();
  });
});

describe('native readiness and pairing custody', () => {
  test('media native register-delete ABA retires original readiness without status calls', () => {
    const registry = new MediaProviderRegistry(); let statuses = 0;
    registry.register({ id: 'native-media', label: 'Native media', capabilities: ['understand'], status() {
      statuses++; return { id: 'native-media', label: 'Native media', state: 'healthy', configured: true, capabilities: ['understand'], metadata: {} };
    } });
    const native = captureCatalogNativeFacts({ platform: { mediaProviderRegistry: registry } }, 'media');
    expect(JSON.stringify(native.providerEvidence)).toContain('native-media'); expect(statuses).toBe(0);
    registry.register({ id: 'temporary-media', label: 'Temporary media', capabilities: ['transform'] }); registry.unregister('temporary-media');
    expect(native.assertCurrent).toThrow(); expect(statuses).toBe(0);
  });
  test('complete unconsumed provider metadata participates in the original privacy floor', () => {
    const registry = new MediaProviderRegistry();
    const provider: MediaProvider = { id: 'native-media', label: 'Native media', capabilities: ['understand'] };
    Object.defineProperty(provider, 'hidden', { value: '4111111111111111' }); registry.register(provider);
    expect(() => captureCatalogNativeFacts({ platform: { mediaProviderRegistry: registry } }, 'media')).toThrow();
  });
  test('complete private pairing token bytes stay out of semantic evidence and detect rewrite', () => {
    const f = pairingHome(); writeFileSync(f.file, JSON.stringify({ token: 'synthetic-original-token', extra: 'Private original file field' }));
    const native = captureCatalogNativeFacts(f.context, 'pairing');
    expect(JSON.stringify(native.providerEvidence)).not.toContain('synthetic-original-token'); expect(JSON.stringify(native.providerEvidence)).not.toContain('Private original file field');
    writeFileSync(f.file, JSON.stringify({ token: 'synthetic-original-token', extra: 'Changed private file field' })); expect(native.assertCurrent).toThrow();
  });
  test('create-delete of an originally absent token file retires the original path owner', () => {
    const f = pairingHome(), native = captureCatalogNativeFacts(f.context, 'pairing');
    writeFileSync(f.file, JSON.stringify({ token: 'synthetic-token' })); unlinkSync(f.file); expect(native.assertCurrent).toThrow();
  });
  test('a token symlink never supplies original pairing custody', () => {
    const f = pairingHome(), peer = join(f.root, 'peer.json'); writeFileSync(peer, JSON.stringify({ token: 'synthetic-peer-token' })); symlinkSync(peer, f.file);
    expect(() => captureCatalogNativeFacts(f.context, 'pairing')).toThrow();
  });
});


describe('retained producer operation boundaries', () => {
  test('a producer cannot substitute its returned private row through the copy table', () => {
    const raw = Object.defineProperty({ records: [] }, 'privateCard', { value: '4111111111111111', enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get');
    if (!descriptor || !('value' in descriptor)) throw new Error('Missing native copy lookup');
    const original = WeakMap.prototype.get;
    const source = { getSnapshot() {
      Object.defineProperty(WeakMap.prototype, 'get', { ...descriptor, value: function(this: WeakMap<object, unknown>, key: object) {
        if (key === raw) return { view: { records: [] }, data: { records: [] } };
        return Reflect.apply(original, this, [key]);
      } });
      return raw;
    } };
    const frame = captureCatalogProducerSources({ platform: { readModels: { device: source } } }, [selected], methods);
    try { expect(() => { read(frame); frame.evidence(); }).toThrow(ToolInputProjectionError); }
    finally { Object.defineProperty(WeakMap.prototype, 'get', descriptor); }
  });
  test('complete captured results retain hidden private data through evidence normalization', () => {
    const raw = Object.defineProperty({ records: [] }, 'privateCard', { value: '4111111111111111', enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get');
    if (!descriptor || !('value' in descriptor)) throw new Error('Missing native copy lookup');
    const original = WeakMap.prototype.get;
    let substituted = 0;
    const safe = Object.freeze({ records: Object.freeze([]) });
    const source = { getSnapshot() {
      Object.defineProperty(WeakMap.prototype, 'get', { ...descriptor, value: function(this: WeakMap<object, unknown>, key: object) {
        if (Object.getOwnPropertyDescriptor(key, 'privateCard')?.value === '4111111111111111') { substituted++; return safe; }
        return Reflect.apply(original, this, [key]);
      } });
      return raw;
    } };
    const frame = captureCatalogProducerSources({ platform: { readModels: { device: source } } }, [selected], methods);
    try {
      expect(() => { read(frame); frame.evidence(); }).toThrow(ToolInputProjectionError);
      expect(substituted).toBe(0);
    } finally { Object.defineProperty(WeakMap.prototype, 'get', descriptor); }
  });
  test('late binding substitution cannot mask complete captured result evidence', () => {
    const raw = Object.defineProperty({ records: [] }, 'privateCard', { value: '4111111111111111', enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'bind');
    if (!descriptor || !('value' in descriptor)) throw new Error('Missing native function binding');
    const originalBind = Function.prototype.bind, originalGet = WeakMap.prototype.get;
    const apply = Reflect.apply, safe = Object.freeze({ records: Object.freeze([]) });
    let substituted = 0;
    const source = { getSnapshot() {
      Object.defineProperty(Function.prototype, 'bind', { ...descriptor, value: function(this: Function, ...args: unknown[]) {
        if (this === originalGet) return (key: object): unknown => {
          if (Object.getOwnPropertyDescriptor(key, 'privateCard')?.value === '4111111111111111') { substituted++; return safe; }
          return apply(originalGet, args[0], [key]);
        };
        return apply(originalBind, this, args);
      } });
      return raw;
    } };
    const frame = captureCatalogProducerSources({ platform: { readModels: { device: source } } }, [selected], methods);
    try {
      const captured = read(frame);
      expect(Object.getOwnPropertyDescriptor(captured, 'privateCard')?.value).toBe('4111111111111111');
      let problem: unknown;
      try { frame.evidence(); } catch (error) { problem = error; }
      expect(problem).toBeInstanceOf(Error);
      if (!(problem instanceof Error) || problem.name !== 'JudgmentInputError' || !('problem' in problem)) throw new Error('Missing native card floor refusal');
      expect(problem.problem).toBe('card-material');
      expect(substituted).toBe(0);
    } finally { Object.defineProperty(Function.prototype, 'bind', descriptor); }
  });
  test('unsupported native Promise observation never invokes a replacement getter', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, 'then');
    if (!descriptor || !('value' in descriptor)) throw new Error('Missing native Promise observation');
    let getters = 0;
    const source = { getSnapshot() {
      Object.defineProperty(Promise.prototype, 'then', { configurable: true, get() { getters++; return descriptor.value; } });
      return Promise.reject(new Error('Owned native source refusal'));
    } };
    const frame = captureCatalogProducerSources({ platform: { readModels: { device: source } } }, [selected], methods);
    try { expect(() => read(frame)).toThrow(); expect(getters).toBe(0); }
    finally { Object.defineProperty(Promise.prototype, 'then', descriptor); }
  });
  test('the original wildcard observation is acquired once and retained through a native await', async () => {
    const root = makeProjectTempDir('catalog-pairing-advertisement'); roots.push(root);
    const config = new ConfigManager({ configDir: join(root, 'config') });
    config.set('controlPlane.hostMode', 'network'); config.set('web.hostMode', 'network');
    const incarnation = config.getConfigurationIncarnation();
    const current = (): void => { if (config.getConfigurationIncarnation() !== incarnation) throw new ToolInputProjectionError('held'); };
    const raw: ReturnType<typeof nativeOs.networkInterfaces> = { owned: [{ address: '192.0.2.7', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.7/24' }] };
    const probe = spyOn(nativeOs, 'networkInterfaces').mockReturnValue(raw);
    try {
      const source = capturePairingAdvertisement(config, current);
      expect(source.address).toBe('192.0.2.7'); expect(probe).toHaveBeenCalledTimes(1);
      await Promise.resolve(); source.assertCurrent(); expect(probe).toHaveBeenCalledTimes(1);
      const row = raw.owned?.[0]; if (!row) throw new Error('Missing original native interface');
      row.address = '192.0.2.8'; expect(source.assertCurrent).toThrow(); expect(source.address).toBe('192.0.2.7');
      expect(probe).toHaveBeenCalledTimes(1);
    } finally { probe.mockRestore(); }
  });
  test('a local-only binding performs no interface probe and original config retirement holds', () => {
    const root = makeProjectTempDir('catalog-pairing-local'); roots.push(root);
    const config = new ConfigManager({ configDir: join(root, 'config') });
    const incarnation = config.getConfigurationIncarnation();
    const current = (): void => { if (config.getConfigurationIncarnation() !== incarnation) throw new ToolInputProjectionError('held'); };
    const probe = spyOn(nativeOs, 'networkInterfaces');
    try {
      const source = capturePairingAdvertisement(config, current);
      expect(source.address).toBe('127.0.0.1'); expect(probe).toHaveBeenCalledTimes(0);
      config.set('controlPlane.hostMode', 'network'); expect(source.assertCurrent).toThrow(); expect(probe).toHaveBeenCalledTimes(0);
    } finally { probe.mockRestore(); }
  });
});
