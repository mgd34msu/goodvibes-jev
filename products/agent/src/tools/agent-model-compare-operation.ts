import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { captureOwnedJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { assertCurrentToolEffect, assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ArtifactStore, type ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { AgentModelCompareArtifactStore, AgentModelCompareToolDeps } from './agent-model-compare-types.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';

function captureNativeArtifactRoot(store: ArtifactStore) {
  const descriptor = Object.getOwnPropertyDescriptor(ArtifactStore.prototype, 'storagePath');
  const getter = descriptor?.get;
  if (!getter) throw new Error('Comparison artifact storage owner is unavailable.');
  const readRoot = () => {
    if (Object.getOwnPropertyDescriptor(ArtifactStore.prototype, 'storagePath')?.get !== getter) throw new Error('Comparison artifact storage owner changed.');
    const value: unknown = Reflect.apply(getter, store, []);
    if (typeof value !== 'string') throw new Error('Comparison artifact storage owner is unavailable.');
    return resolve(value);
  };
  const root = readRoot(), physicalRoot = realpathSync(root);
  const ancestry = [];
  for (let cursor = root; ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor, { bigint: true });
    ancestry.push({ path: cursor, dev: stat.dev, ino: stat.ino, mode: stat.mode });
    if (dirname(cursor) === cursor) break;
  }
  const assertCurrent = () => {
    if (readRoot() !== root || realpathSync(root) !== physicalRoot || !statSync(root).isDirectory()) throw new Error('Comparison artifact storage root changed.');
    for (const binding of ancestry) {
      const stat = lstatSync(binding.path, { bigint: true });
      if (stat.dev !== binding.dev || stat.ino !== binding.ino || stat.mode !== binding.mode) throw new Error('Comparison artifact storage ancestry changed.');
    }
  };
  assertCurrent();
  return { root, physicalRoot, assertCurrent };
}

function captureNativeArtifactSource(store: ArtifactStore, id: string): () => void {
  const record = store.getRecord(id);
  if (!record) throw new Error('Comparison source artifact is unavailable in its owning store.');
  const { physicalRoot, assertCurrent: assertRootCurrent } = captureNativeArtifactRoot(store);
  const contentPath = record.contentPath, metadataPath = record.metadataPath;
  const frames = [contentPath, metadataPath].map(path => {
    const physicalPath = realpathSync(path), withinRoot = relative(physicalRoot, physicalPath);
    if (isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) throw new Error('Comparison source artifact escaped its physical store.');
    const file = statSync(path, { bigint: true });
    if (!file.isFile()) throw new Error('Comparison source artifact is not a regular file.');
    const ancestry = [];
    for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
      const stat = lstatSync(cursor, { bigint: true });
      ancestry.push({ path: cursor, dev: stat.dev, ino: stat.ino, mode: stat.mode });
      if (dirname(cursor) === cursor) break;
    }
    return { path, physicalPath, file, ancestry };
  });
  return () => {
    const current = store.getRecord(id);
    if (!current || current !== record || current.contentPath !== contentPath || current.metadataPath !== metadataPath) throw new Error('Comparison source artifact physical owner changed.');
    assertRootCurrent();
    for (const frame of frames) {
      if (realpathSync(frame.path) !== frame.physicalPath) throw new Error('Comparison source artifact path changed.');
      for (const binding of frame.ancestry) {
        const stat = lstatSync(binding.path, { bigint: true });
        if (stat.dev !== binding.dev || stat.ino !== binding.ino || stat.mode !== binding.mode) throw new Error('Comparison source artifact path binding changed.');
      }
      const stat = statSync(frame.path, { bigint: true });
      if (!stat.isFile() || stat.dev !== frame.file.dev || stat.ino !== frame.file.ino || stat.size !== frame.file.size
        || stat.mtimeNs !== frame.file.mtimeNs || stat.ctimeNs !== frame.file.ctimeNs) throw new Error('Comparison source artifact file changed.');
    }
  };
}

/** Every asynchronous comparison dependency stays inside its original owner frame. */
export function createComparisonOperation(source: AgentModelCompareToolDeps, args: Record<string, unknown>, options?: ToolExecuteOptions) {
  const observed = new Map<string, { readonly descriptor: ArtifactDescriptor; readonly captured: string }>();
  const descriptorBytes = (descriptor: ArtifactDescriptor) => {
    const captured = captureOwnedJson(descriptor);
    if (!captured || typeof captured !== 'object' || Array.isArray(captured)) throw new Error('Invalid comparison artifact descriptor.');
    return JSON.stringify(Object.fromEntries(Object.entries(captured).filter(([key]) => key !== 'contentPath' && key !== 'metadataPath')));
  };
  const observeDescriptor = (descriptor: ArtifactDescriptor) => {
    const captured = descriptorBytes(descriptor);
    const prior = observed.get(descriptor.id);
    if (prior && prior.captured !== captured) throw new Error('Comparison source artifact changed during this operation.');
    observed.set(descriptor.id, { descriptor, captured });
  };
  const store = source.artifactStore;
  const nativeStore = store instanceof ArtifactStore ? store : undefined;
  const nativeRoot = nativeStore && captureNativeArtifactRoot(nativeStore);
  const nativeGetRecord = nativeStore?.getRecord;
  const physicalSources = new Map<string, () => void>();
  const registry = source.toolRegistry;
  const sourceOwner = agentResearchSourceOwner(registry);
  const get = store?.get; const list = store?.list; const readContent = store?.readContent; const create = store?.create;
  const catalog = source.modelCatalog; const listModels = catalog.listModels; const getCurrentModel = catalog.getCurrentModel; const recordModelUsage = catalog.recordModelUsage;
  const providers = source.providerRegistry; const getForModel = providers.getForModel; const applyModelRoute = source.applyModelRoute;
  const readDescriptor = (id: string) => get ? get.call(store, id) : list ? list.call(store, Number.MAX_SAFE_INTEGER).find(item => item.id === id) : observed.get(id)?.descriptor;
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    assertCurrentToolExecution(args, options);
    if (source.toolRegistry !== registry || agentResearchSourceOwner(registry) !== sourceOwner || source.artifactStore !== store || store?.get !== get || store?.list !== list || store?.readContent !== readContent || store?.create !== create
      || nativeStore?.getRecord !== nativeGetRecord
      || source.modelCatalog !== catalog || catalog.listModels !== listModels || catalog.getCurrentModel !== getCurrentModel || catalog.recordModelUsage !== recordModelUsage
      || source.providerRegistry !== providers || providers.getForModel !== getForModel || source.applyModelRoute !== applyModelRoute) throw new Error('Comparison dependency owner changed.');
    for (const [id, observation] of observed) {
      const current = readDescriptor(id);
      if (!current || descriptorBytes(current) !== observation.captured) throw new Error('Comparison source artifact changed during this operation.');
    }
    nativeRoot?.assertCurrent();
    for (const assertPhysicalCurrent of physicalSources.values()) assertPhysicalCurrent();
  };
  const assertEffect = (effect: 'write' | 'send') => {
    assertCurrent();
    if (!assertCurrentToolEffect(args, options, effect)) throw new Error('Comparison effects require current recorded effect admission.');
  };
  const assertWrite = () => assertEffect('write');
  const assertSend = () => assertEffect('send');
  const artifactStore: AgentModelCompareArtifactStore | undefined = store && create && {
    async create(input, ownership) {
      assertWrite();
      ownership?.signal?.throwIfAborted(); ownership?.assertCurrent?.();
      const result = await create.call(store, input, { signal: options?.signal, assertCurrent: () => { assertWrite(); ownership?.assertCurrent?.(); } });
      assertCurrent();
      return result;
    },
    ...(list ? { list(limit?: number) { assertCurrent(); const result = list.call(store, limit); for (const descriptor of result) observeDescriptor(descriptor); assertCurrent(); return result; } } : {}),
    ...(get ? { get(id: string) { assertCurrent(); const result = get.call(store, id); if (result) observeDescriptor(result); assertCurrent(); return result; } } : {}),
    ...(readContent ? { async readContent(id: string) {
      assertCurrent();
      const before = readDescriptor(id);
      const beforeBytes = before && descriptorBytes(before);
      const assertPhysicalCurrent = nativeStore ? captureNativeArtifactSource(nativeStore, id) : undefined;
      const result = await readContent.call(store, id);
      assertPhysicalCurrent?.();
      assertCurrent();
      if (result.record.id !== id) throw new Error('Comparison source artifact does not match the requested owner record.');
      if (createHash('sha256').update(result.buffer).digest('hex') !== result.record.sha256) throw new Error('Comparison source artifact content does not match its recorded hash.');
      if (beforeBytes && descriptorBytes(result.record) !== beforeBytes) throw new Error('Comparison source artifact changed during acquisition.');
      observeDescriptor(result.record);
      if (assertPhysicalCurrent) physicalSources.set(id, assertPhysicalCurrent);
      assertCurrent();
      return { record: result.record, buffer: Buffer.from(result.buffer) };
    } } : {}),
  };
  const deps: AgentModelCompareToolDeps = {
    ...source,
    modelCatalog: {
      async listModels(query) { assertCurrent(); const result = await listModels.call(catalog, query); assertCurrent(); return result; },
      ...(getCurrentModel ? { async getCurrentModel() { assertCurrent(); const result = await getCurrentModel.call(catalog); assertCurrent(); return result; } } : {}),
      ...(recordModelUsage ? { async recordModelUsage(key: string) { assertWrite(); const result = await recordModelUsage.call(catalog, key, { signal: options?.signal, assertCurrent: assertWrite }); assertCurrent(); return result; } } : {}),
    },
    ...(artifactStore ? { artifactStore } : {}),
    ...(applyModelRoute ? { async applyModelRoute(key: string) { assertWrite(); const result = await applyModelRoute.call(source, key, options, { signal: options?.signal, assertCurrent }); return result; } } : {}),
  };
  return { deps, sourceOwner, assertCurrent, assertWrite, assertSend };
}
