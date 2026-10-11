import { withDevicePageRefresh } from './page-refresh-queue.js';
import { prepareObservedKnowledgeNodeInput } from '../store-node-observation.js';
import { GoodVibesSdkError } from '@goodvibes-jev/engine/errors';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import {
  materializeGeneratedKnowledgeProjection,
} from '../generated-projections.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  edgeIsActive,
  factSourceIds,
  homeGraphNodeId,
  homeGraphSourceId,
  isGeneratedPageSource,
  namespacedCanonicalUri,
  readStringArray,
  readHomeAssistantMetadataString,
  readRecord,
  uniqueStrings,
} from './helpers.js';
import {
  findHomeAssistantNode,
  missingDevicePassportFields,
  readHomeGraphServingState,
  safeHomeGraphFilename,
} from './state.js';
import {
  issuesForScope,
  renderDevicePassportPage,
  renderPacketPage,
  renderRoomPage,
} from './rendering.js';
import { semanticHash } from '../semantic/utils.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import { prepareSourceLinkedRepairProfileFacts } from '../semantic/self-improvement-promotion.js';
import { repairProfileNodeInput } from '../semantic/repair-profile-write-data.js';
import { buildDevicePageProfileFacts, devicePageProfileFactInput } from './page-profile-facts.js';
import { createHomeGraphPageSourceReader, type HomeGraphPageSourceReader, type HomeGraphPageFactReader, isHomeGraphPageFactCandidate, createHomeGraphPageFactReader } from './page-quality.js';
import type {
  HomeGraphDevicePassportResult,
  HomeGraphGeneratedPagesSummary,
  HomeGraphProjectionInput,
  HomeGraphProjectionResult,
  HomeGraphSnapshotInput,
} from './types.js';

export interface HomeGraphPageContext {
  readonly assertCurrent?: (() => void) | undefined;
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly signal?: AbortSignal | undefined;
}

export const HOME_GRAPH_PAGE_POLICY_VERSION = 'homegraph-pages-v8';
const DEFAULT_SYNC_DEVICE_PASSPORT_LIMIT = 32;
const DEFAULT_SYNC_ROOM_PAGE_LIMIT = 12;
const DEFAULT_SYNC_PAGE_RUN_MS = 15_000;
const MAX_FOREGROUND_SYNC_DEVICE_PASSPORTS = 32;
const MAX_FOREGROUND_SYNC_ROOM_PAGES = 12;
const MAX_FOREGROUND_SYNC_PAGE_RUN_MS = 30_000;

interface DevicePassportSourceLookup {
  readonly sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>;
  readonly sourceIdsByNodeId: ReadonlyMap<string, ReadonlySet<string>>;
}
type HomeGraphStateSnapshot = ReturnType<typeof readHomeGraphServingState>;
type ExtractionBySourceId = ReadonlyMap<string, ReturnType<KnowledgeStore['getExtractionBySourceId']>>;

export async function generateAutomaticHomeGraphPages(
  context: HomeGraphPageContext & { readonly input: HomeGraphSnapshotInput },
): Promise<HomeGraphGeneratedPagesSummary> {
  const requested = context.input.pageAutomation ?? {};
  return generateHomeGraphPagesForCurrentState(context, {
    ...requested,
    maxDevicePassports: clampForegroundLimit(
      requested.maxDevicePassports,
      DEFAULT_SYNC_DEVICE_PASSPORT_LIMIT,
      MAX_FOREGROUND_SYNC_DEVICE_PASSPORTS,
    ),
    maxRoomPages: clampForegroundLimit(
      requested.maxRoomPages,
      DEFAULT_SYNC_ROOM_PAGE_LIMIT,
      MAX_FOREGROUND_SYNC_ROOM_PAGES,
    ),
    maxRunMs: clampForegroundLimit(
      requested.maxRunMs,
      DEFAULT_SYNC_PAGE_RUN_MS,
      MAX_FOREGROUND_SYNC_PAGE_RUN_MS,
    ),
  });
}

export async function refreshAutomaticHomeGraphPages(
  context: HomeGraphPageContext,
): Promise<HomeGraphGeneratedPagesSummary> {
  return generateHomeGraphPagesForCurrentState(context, {});
}

async function generateHomeGraphPagesForCurrentState(
  context: HomeGraphPageContext,
  options: HomeGraphSnapshotInput['pageAutomation'],
): Promise<HomeGraphGeneratedPagesSummary> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (context.signal?.aborted) abort();
  else context.signal?.addEventListener('abort', abort, { once: true });
  const maxRunMs = options?.maxRunMs;
  const budget = typeof maxRunMs === 'number' && Number.isFinite(maxRunMs)
    ? Math.max(1_000, Math.trunc(maxRunMs)) : DEFAULT_SYNC_PAGE_RUN_MS;
  const timer = setTimeout(abort, budget);
  try {
    return await generateHomeGraphPagesWithinBudget({ ...context, signal: controller.signal }, options);
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', abort);
  }
}

async function generateHomeGraphPagesWithinBudget(
  context: HomeGraphPageContext,
  options: HomeGraphSnapshotInput['pageAutomation'],
): Promise<HomeGraphGeneratedPagesSummary> {
  const effectiveOptions = options ?? {};
  const summary = createGeneratedPagesSummary();
  if (effectiveOptions.enabled === false) return summary;
  const deadlineAt = typeof effectiveOptions.maxRunMs === 'number' && Number.isFinite(effectiveOptions.maxRunMs)
    ? Date.now() + Math.max(1_000, Math.trunc(effectiveOptions.maxRunMs))
    : undefined;

  const state = readHomeGraphServingState(context.store, context.spaceId);
  if (effectiveOptions.devicePassports !== false) {
    const allDevices = prioritizeNodesForGeneratedPages(
      state.nodes.filter((node) => node.kind === 'ha_device' && node.status !== 'stale'),
    );
    const devices = limitRecords(allDevices, effectiveOptions.maxDevicePassports);
    summary.deferredDevicePassports += Math.max(0, allDevices.length - devices.length);
    for (const [index, device] of devices.entries()) {
      if (context.signal?.aborted || deadlineReached(deadlineAt)) {
        summary.deferredDevicePassports += devices.length - index;
        break;
      }
      await yieldEvery(index, 2);
      const deviceId = readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id;
      try {
        const page = await refreshHomeGraphDevicePassport({
          ...context,
          input: {
            knowledgeSpaceId: context.spaceId,
            deviceId,
            metadata: { automation: 'snapshot-sync' },
          },
        });
        summary.devicePassports += 1;
        if (page.artifactCreated) summary.artifacts += 1;
        if (page.source) summary.sources += 1;
      } catch (error) {
        summary.errors.push({
          kind: 'device-passport',
          targetId: deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await yieldToEventLoop();
    }
  }

  if (effectiveOptions.roomPages !== false) {
    const allRooms = prioritizeNodesForGeneratedPages(
      state.nodes.filter((node) => (node.kind === 'ha_area' || node.kind === 'ha_room') && node.status !== 'stale'),
    );
    const rooms = limitRecords(allRooms, effectiveOptions.maxRoomPages);
    summary.deferredRoomPages += Math.max(0, allRooms.length - rooms.length);
    for (const [index, room] of rooms.entries()) {
      if (context.signal?.aborted || deadlineReached(deadlineAt)) {
        summary.deferredRoomPages += rooms.length - index;
        break;
      }
      await yieldEvery(index, 2);
      const areaId = readHomeAssistantMetadataString(room, 'objectId', 'areaId') ?? room.id;
      try {
        const page = await generateHomeGraphRoomPage({
          ...context,
          input: {
            knowledgeSpaceId: context.spaceId,
            areaId,
            title: room.title,
            metadata: { automation: 'snapshot-sync' },
          },
        });
        summary.roomPages += 1;
        if (page.artifactCreated) summary.artifacts += 1;
        if (page.source) summary.sources += 1;
      } catch (error) {
        summary.errors.push({
          kind: 'room-page',
          targetId: areaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await yieldToEventLoop();
    }
  }

  summary.truncated = summary.deferredDevicePassports > 0 || summary.deferredRoomPages > 0;
  return summary;
}

function deadlineReached(deadlineAt: number | undefined): boolean {
  return typeof deadlineAt === 'number' && Date.now() >= deadlineAt;
}

export async function refreshHomeGraphDevicePassport(
  context: HomeGraphPageContext & {
    readonly input: HomeGraphProjectionInput;
    readonly state?: HomeGraphStateSnapshot | undefined;
    readonly sourceLookup?: DevicePassportSourceLookup | undefined;
    readonly extractionsBySourceId?: ExtractionBySourceId | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<HomeGraphDevicePassportResult & { readonly artifactCreated: boolean }> {
  throwIfAborted(context.signal);
  const store = context.store, artifactStore = context.artifactStore, signal = context.signal, requestInput = context.input, requestData = context.state, requestAuthority = context.assertCurrent;
  const requestState = () => JSON.stringify({ input: context.input, spaceId: context.spaceId, installationId: context.installationId,
    sameAuthority: context.assertCurrent === requestAuthority, sameInput: context.input === requestInput, sameData: context.state === requestData, sameStore: context.store === store, sameArtifacts: context.artifactStore === artifactStore, sameSignal: context.signal === signal });
  return withDevicePageRefresh(store, JSON.stringify([context.spaceId, context.input.deviceId]), signal, requestState,
    (assertQueueCurrent) => refreshHomeGraphDevicePassportNow({ ...context, assertCurrent: () => { assertQueueCurrent(); requestAuthority?.(); } }));
}

async function refreshHomeGraphDevicePassportNow(
  context: HomeGraphPageContext & {
    readonly input: HomeGraphProjectionInput;
    readonly state?: HomeGraphStateSnapshot | undefined;
    readonly sourceLookup?: DevicePassportSourceLookup | undefined;
    readonly extractionsBySourceId?: ExtractionBySourceId | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<HomeGraphDevicePassportResult & { readonly artifactCreated: boolean }> {
  const { store, artifactStore, spaceId, installationId, input } = context;
  const assertCallerCurrent = context.assertCurrent;
  assertCallerCurrent?.();
  throwIfAborted(context.signal);
  if (!input.deviceId) {
    throw new GoodVibesSdkError('refreshDevicePassport requires deviceId.', {
      category: 'bad_request',
      source: 'runtime',
      operation: 'homegraph.refreshDevicePassport',
    });
  }
  const state = context.state ?? readHomeGraphServingState(store, spaceId);
  const writeGuard = createSemanticWriteGuard(store, context.signal);
  writeGuard.watch('page-state', () => readHomeGraphServingState(store, spaceId), state);
  for (const source of state.sources) writeGuard.extraction(source.id);
  throwIfAborted(context.signal);
  const device = findHomeAssistantNode(state.nodes, 'ha_device', input.deviceId);
  if (!device) {
    throw new GoodVibesSdkError(`Unknown Home Assistant device: ${input.deviceId}`, {
      category: 'not_found',
      source: 'runtime',
      operation: 'homegraph.refreshDevicePassport',
    });
  }
  const entities = state.nodes.filter((node) => (
    node.kind === 'ha_entity' && state.edges.some((edge) => (
      edgeIsActive(edge)
      && edge.fromKind === 'node'
      && edge.fromId === node.id
      && edge.toKind === 'node'
      && edge.toId === device.id
      && edge.relation === 'belongs_to_device'
    ))
  ));
  const sourceLookup = context.sourceLookup ?? buildDevicePassportSourceLookup(state.sources, state.nodes, state.edges);
  const sourceReader = createHomeGraphPageSourceReader(context.signal);
  const sources = await sourcesForDevicePassport(device.id, sourceLookup, sourceReader);
  const pageProfileFacts = await buildDevicePageProfileFacts({
    store,
    spaceId,
    installationId,
    device,
    sources,
    sourceReader,
    extractionsBySourceId: context.extractionsBySourceId,
    signal: context.signal,
  });
  let assertFactQualityCurrent = () => {};
  const initialPreparedProfileFacts = await prepareSourceLinkedRepairProfileFacts(
    pageProfileFacts.map((fact) => devicePageProfileFactInput(store, spaceId, installationId, device, fact)),
    { signal: context.signal, assertCurrent: () => assertFactQualityCurrent() },
  );
  throwIfAborted(context.signal);
  // Judge the final prepared source set and claim, including merged support.
  // Intermediate writes for the same claim are acknowledged against this plan.
  const proposedFacts = uniqueNodesById(initialPreparedProfileFacts.plans.map((plan) => {
    const original = pageProfileFacts.find((fact) => fact.node.id === plan.factId)!.node;
    return { ...original, ...repairProfileNodeInput(plan), id: plan.factId } as KnowledgeNodeRecord;
  }));
  const candidateFacts = uniqueNodesById([
    ...semanticFactsForNode(device.id, sources, state.nodes, state.edges),
    ...proposedFacts,
  ]);
  const factReader = createHomeGraphPageFactReader(store, {
    spaceId, query: `Verified device passport facts for ${device.title}`,
    subjects: [device, ...entities], signal: context.signal,
    proposedFacts: new Set(proposedFacts),
  });
  const factPlan = await factReader.prepare(candidateFacts);
  const assertPageCurrent = () => {
    assertCallerCurrent?.();
    factPlan.assertCurrent();
    sourceReader.assertCurrent((id) => store.getSource(id));
  };
  assertFactQualityCurrent = assertPageCurrent;
  const semanticFacts = candidateFacts.filter((fact) => factPlan.accepts(fact));
  const acceptedIds = new Set(semanticFacts.map((fact) => fact.id));
  const acceptedProfiles = pageProfileFacts.filter((fact) => acceptedIds.has(fact.node.id));
  const preparedProfileFacts = acceptedProfiles.length === pageProfileFacts.length
    ? initialPreparedProfileFacts
    : await prepareSourceLinkedRepairProfileFacts(
      acceptedProfiles.map((fact) => devicePageProfileFactInput(store, spaceId, installationId, device, fact)),
      { signal: context.signal, assertCurrent: () => assertFactQualityCurrent() },
    );
  const scopedNodeIds = new Set([device.id, ...entities.map((node) => node.id)]);
  const issues = filterDevicePassportIssues(issuesForScope(state.issues, state.edges, scopedNodeIds, sources), sources);
  const missingFields = await missingDevicePassportFields(device, sources, semanticFacts, { entities, signal: context.signal });
  const markdown = renderDevicePassportPage({ spaceId, device, entities, sources, issues, missingFields, semanticFacts, factPlan });
  const pageContentHash = semanticHash(markdown);
  const passportId = homeGraphNodeId(spaceId, 'ha_device_passport', input.deviceId);
  const existingPassport = store.getNode(passportId);
  const existingPassportMetadata = readRecord(existingPassport?.metadata);
  const previousRefreshedAt = typeof existingPassportMetadata.refreshedAt === 'number'
    ? existingPassportMetadata.refreshedAt
    : undefined;
  const { passport, generated } = await store.batch(async () => {
    throwIfAborted(context.signal);
    sourceReader.assertCurrent((id) => store.getSource(id));
    writeGuard.assertCurrent();
    preparedProfileFacts.assertCurrent();
    factPlan.assertCurrent();
    // Quality is rechecked at each retained write boundary. A late hold cannot
    // authorize compensating writes over a concurrent replacement.
    const passportInput = prepareObservedKnowledgeNodeInput(store, {
      id: passportId,
      kind: 'ha_device_passport',
      slug: `${device.slug}-passport`,
      title: `${device.title} passport`,
      summary: `Living device profile for ${device.title}.`,
      aliases: [`${device.title} passport`],
      status: 'active',
      confidence: 80,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeAssistant: { installationId, objectKind: 'device_passport', objectId: input.deviceId },
        deviceId: input.deviceId,
        missingFields,
        pageContentHash,
        refreshedAt: existingPassportMetadata.pageContentHash === pageContentHash && previousRefreshedAt !== undefined
          ? previousRefreshedAt
          : Date.now(),
      }),
    }, 'generated-page-index', device, () => store.getNode(device.id));
    const passportWrites = await store.prepareNodeWrites([passportInput], { signal: context.signal, assertCurrent: assertPageCurrent });
    const passport = await store.upsertPreparedNode(passportWrites, 0);
    await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
      nodes: [], issues: [], assertCurrent: assertPageCurrent, edges: [{
        fromKind: 'node',
        fromId: passport.id,
        toKind: 'node',
        toId: device.id,
        relation: 'source_for',
        metadata: buildHomeGraphMetadata(spaceId, installationId),
      }],
    }), { signal: context.signal });
    throwIfAborted(context.signal);
    preparedProfileFacts.assertCurrent();
    await preparedProfileFacts.write({
      nodeWritten: (node) => { factPlan.acknowledgeWritten(node); },
      edgeWritten: (edge) => { factPlan.acknowledgeEdgeWritten(edge); },
    });
    throwIfAborted(context.signal);
    const generated = await materializeGeneratedMarkdown({
      store,
      artifactStore,
      spaceId,
      installationId,
      filename: `${safeHomeGraphFilename(device.title)}-passport.md`,
      markdown,
      projectionKind: 'device-passport',
      assertCurrent: assertPageCurrent,
      canonicalValue: `device-passport:${input.deviceId}`,
      title: `${device.title} passport`,
      summary: `Living device profile for ${device.title}.`,
      tags: ['homeassistant', 'home-graph', 'generated-page', 'device-passport'],
      targetNodeId: passport.id,
      signal: context.signal,
      metadata: {
        ...(input.metadata ?? {}),
        deviceId: input.deviceId,
      },
    });
    return { passport, generated };
  });
  return {
    ok: true,
    spaceId,
    title: `${device.title} passport`,
    markdown,
    artifact: generated.artifact,
    source: generated.source,
    ...(generated.linked ? { linked: generated.linked } : {}),
    device,
    passport,
    missingFields,
    artifactCreated: generated.artifactCreated,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new GoodVibesSdkError('Home Graph device passport refresh was cancelled.', {
    category: 'timeout',
    source: 'runtime',
    operation: 'homegraph.refreshDevicePassport',
  });
}

export async function generateHomeGraphRoomPage(
  context: HomeGraphPageContext & { readonly input: HomeGraphProjectionInput; readonly signal?: AbortSignal | undefined },
): Promise<HomeGraphProjectionResult & { readonly artifactCreated: boolean }> {
  const { store, artifactStore, spaceId, installationId, input } = context;
  const state = readHomeGraphServingState(store, spaceId);
  const writeGuard = createSemanticWriteGuard(store, context.signal);
  writeGuard.watch('page-state', () => readHomeGraphServingState(store, spaceId), state);
  const areaId = input.areaId ?? input.roomId;
  const title = input.title ?? resolveRoomTitle(state.nodes, areaId) ?? 'Home Graph Room';
  const sourceReader = createHomeGraphPageSourceReader(context.signal);
  let factReader: HomeGraphPageFactReader | undefined;
  const markdown = await renderRoomPage({ ...state, title }, areaId, sourceReader, (subjects) => {
    factReader = createHomeGraphPageFactReader(store, {
      spaceId, query: `Useful room reference facts for ${title}`, subjects, signal: context.signal,
    });
    return factReader;
  });
  const assertFactsCurrent = () => {
    if (!factReader) throw new Error('Room fact quality reader was not prepared.');
    factReader.assertCurrent();
  };
  assertFactsCurrent();
  sourceReader.assertCurrent((id) => store.getSource(id));
  writeGuard.assertCurrent();
  const filename = `${safeHomeGraphFilename(title)}.md`;
  const targetNode = areaId
    ? findHomeAssistantNode(state.nodes, 'ha_area', areaId) ?? findHomeAssistantNode(state.nodes, 'ha_room', areaId)
    : undefined;
  const generated = await materializeGeneratedMarkdown({
    store,
    artifactStore,
    spaceId,
    installationId,
    filename,
    markdown,
    projectionKind: 'room-page',
    assertCurrent: () => { assertFactsCurrent(); sourceReader.assertCurrent((id) => store.getSource(id)); },
    signal: context.signal,
    canonicalValue: `room-page:${areaId ?? 'home'}`,
    title,
    summary: `Living Home Graph room page for ${title}.`,
    tags: ['homeassistant', 'home-graph', 'generated-page', 'room-page'],
    ...(targetNode ? { targetNodeId: targetNode.id } : {}),
    metadata: {
      ...(input.metadata ?? {}),
      ...(areaId ? { areaId } : {}),
    },
  });
  return {
    ok: true,
    spaceId,
    title,
    markdown,
    artifact: generated.artifact,
    source: generated.source,
    ...(generated.linked ? { linked: generated.linked } : {}),
    artifactCreated: generated.artifactCreated,
  };
}

export async function generateHomeGraphPacket(
  context: HomeGraphPageContext & { readonly input: HomeGraphProjectionInput },
): Promise<HomeGraphProjectionResult & { readonly artifactCreated: boolean }> {
  const { store, artifactStore, spaceId, installationId, input } = context;
  const title = input.title ?? `${input.packetKind ?? 'home'} packet`;
  const markdown = renderPacketPage({ ...readHomeGraphServingState(store, spaceId), title }, input);
  const generated = await materializeGeneratedMarkdown({
    store,
    artifactStore,
    spaceId,
    installationId,
    filename: `${safeHomeGraphFilename(title)}.md`,
    markdown,
    projectionKind: 'packet',
    canonicalValue: `packet:${input.packetKind ?? 'home'}:${input.sharingProfile ?? 'default'}`,
    title,
    summary: `Generated ${title} packet for ${input.sharingProfile ?? 'default'} sharing.`,
    tags: ['homeassistant', 'home-graph', 'generated-page', 'packet'],
    metadata: {
      ...(input.metadata ?? {}),
      packetKind: input.packetKind ?? 'home',
      sharingProfile: input.sharingProfile ?? 'default',
      includeFields: input.includeFields ? [...input.includeFields] : [],
      excludeFields: input.excludeFields ? [...input.excludeFields] : [],
    },
  });
  return { ok: true, spaceId, title, markdown, artifact: generated.artifact, source: generated.source, artifactCreated: generated.artifactCreated };
}

async function materializeGeneratedMarkdown(input: HomeGraphPageContext & {
  readonly filename: string;
  readonly markdown: string;
  readonly projectionKind: 'device-passport' | 'room-page' | 'packet';
  readonly assertCurrent?: (() => void) | undefined;
  readonly canonicalValue: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly metadata?: Record<string, unknown> | undefined;
  readonly targetNodeId?: string | undefined;
  readonly relation?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<{
  readonly artifact: HomeGraphProjectionResult['artifact'];
  readonly source: KnowledgeSourceRecord;
  readonly linked?: KnowledgeEdgeRecord | undefined;
  readonly artifactCreated: boolean;
}> {
  const contentHash = semanticHash(input.markdown);
  const existingSource = input.store.getSource(homeGraphSourceId(input.spaceId, 'generated-page', input.canonicalValue));
  const existingMetadata = readRecord(existingSource?.metadata);
  const existingGeneratedAt = typeof existingMetadata.generatedAt === 'number' ? existingMetadata.generatedAt : undefined;
  const generatedAt = existingMetadata.generatedContentHash === contentHash && existingGeneratedAt !== undefined
    ? existingGeneratedAt
    : Date.now();
  const regeneration = readRecord(input.metadata).automation === 'snapshot-sync' ? 'automatic' : 'manual';
  const metadata = {
    ...(input.metadata ?? {}),
    homeGraphSourceKind: 'generated-page',
    homeGraphGeneratedPage: true,
    projectionKind: input.projectionKind,
    generatedAt,
    generatedContentHash: contentHash,
    pagePolicyVersion: HOME_GRAPH_PAGE_POLICY_VERSION,
    pageEditable: true,
    regeneration,
    ...(input.targetNodeId ? { generatedTargetNodeId: input.targetNodeId } : {}),
  };
  const homeGraphMetadata = buildHomeGraphMetadata(input.spaceId, input.installationId, metadata);
  throwIfAborted(input.signal);
  const generated = await materializeGeneratedKnowledgeProjection({
    store: input.store,
    artifactStore: input.artifactStore,
    connectorId: HOME_GRAPH_CONNECTOR_ID,
    sourceId: homeGraphSourceId(input.spaceId, 'generated-page', input.canonicalValue),
    sourceType: 'document',
    canonicalUri: namespacedCanonicalUri(input.spaceId, 'generated-page', input.canonicalValue),
    title: input.title,
    summary: input.summary,
    tags: uniqueStrings(input.tags),
    filename: input.filename,
    markdown: input.markdown,
    projectionKind: input.projectionKind,
    metadata: homeGraphMetadata,
    sourceMetadata: homeGraphMetadata,
    artifactMetadata: homeGraphMetadata,
    signal: input.signal,
    assertCurrent: input.assertCurrent,
    edgeMetadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      homeGraphGeneratedPage: true,
      projectionKind: input.projectionKind,
    }),
    ...(input.targetNodeId
      ? { target: { kind: 'node' as const, id: input.targetNodeId, relation: input.relation ?? 'source_for' } }
      : {}),
  });
  return {
    artifact: projectionArtifact(generated.artifact),
    source: generated.source,
    ...(generated.linked ? { linked: generated.linked } : {}),
    artifactCreated: generated.artifactCreated,
  };
}

function projectionArtifact(artifact: ArtifactDescriptor): HomeGraphProjectionResult['artifact'] {
  return {
    id: artifact.id,
    mimeType: artifact.mimeType,
    filename: artifact.filename,
    createdAt: artifact.createdAt,
    metadata: artifact.metadata,
  };
}

function createGeneratedPagesSummary(): {
  devicePassports: number;
  roomPages: number;
  artifacts: number;
  sources: number;
  deferredDevicePassports: number;
  deferredRoomPages: number;
  truncated: boolean;
  errors: {
    kind: 'device-passport' | 'room-page';
    targetId: string;
    error: string;
  }[];
} {
  return {
    devicePassports: 0,
    roomPages: 0,
    artifacts: 0,
    sources: 0,
    deferredDevicePassports: 0,
    deferredRoomPages: 0,
    truncated: false,
    errors: [],
  };
}

function compareByTitle(left: KnowledgeNodeRecord, right: KnowledgeNodeRecord): number {
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function prioritizeNodesForGeneratedPages(nodes: readonly KnowledgeNodeRecord[]): readonly KnowledgeNodeRecord[] {
  return [...nodes].sort((left, right) => (
    generatedPagePriority(right) - generatedPagePriority(left)
    || compareByTitle(left, right)
  ));
}

function generatedPagePriority(node: KnowledgeNodeRecord): number {
  const metadata = readRecord(node.metadata.homeAssistant);
  const objectKind = String(metadata.objectKind ?? '').toLowerCase();
  const domain = String(metadata.domain ?? node.metadata.domain ?? '').toLowerCase();
  const title = `${node.title} ${node.summary ?? ''}`.toLowerCase();
  let score = 0;
  if (objectKind === 'device') score += 8;
  if (domain === 'media_player' || domain === 'climate' || domain === 'lock' || domain === 'cover') score += 8;
  if (domain === 'sensor' || domain === 'binary_sensor') score += 2;
  if (/(tv|receiver|speaker|thermostat|lock|garage|camera|printer|router|iphone|espresso|appliance)/.test(title)) score += 6;
  if (/(home assistant|plugin|add-on|addon|conversation|tts|stt|task|backup|hacs|theme|card)/.test(title)) score -= 8;
  return score;
}

function semanticFactsForNode(
  nodeId: string,
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
): KnowledgeNodeRecord[] {
  const sourceIds = new Set(sources.map((source) => source.id));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const subjectFactIds = factIdsDescribingNode(edges, nodeId);
  const edgeSupportedFactIds = sourceSupportedFactIds(edges, sourceIds);
  const supportedFactIds = new Set<string>();
  for (const fact of nodesById.values()) {
    if (fact.kind !== 'fact') continue;
    if (!factHasSubjectLink(fact, nodeId, subjectFactIds)) continue;
    const hasSource = edgeSupportedFactIds.has(fact.id)
      || factSourceIds(fact).some((sourceId) => sourceIds.has(sourceId));
    if (hasSource) supportedFactIds.add(fact.id);
  }
  return nodes.filter((node) => supportedFactIds.has(node.id) && isHomeGraphPageFactCandidate(node));
}

function sourceSupportedFactIds(
  edges: readonly KnowledgeEdgeRecord[],
  sourceIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'source'
    && sourceIds.has(edge.fromId)
    && edge.toKind === 'node'
    && edge.relation === 'supports_fact'
  )).map((edge) => edge.toId));
}

function factIdsDescribingNode(
  edges: readonly KnowledgeEdgeRecord[],
  nodeId: string,
): ReadonlySet<string> {
  return new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.toKind === 'node'
    && edge.toId === nodeId
    && edge.relation === 'describes'
  )).map((edge) => edge.fromId));
}

function factHasSubjectLink(
  fact: KnowledgeNodeRecord,
  nodeId: string,
  describedFactIds: ReadonlySet<string>,
): boolean {
  if (describedFactIds.has(fact.id)) return true;
  return readStringArray(fact.metadata.subjectIds).includes(nodeId)
    || readStringArray(fact.metadata.linkedObjectIds).includes(nodeId);
}

function buildDevicePassportSourceLookup(
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
): DevicePassportSourceLookup {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sourceIdsByNodeId = new Map<string, Set<string>>();
  const describingFactIdsByNodeId = new Map<string, Set<string>>();
  const sourceIdsByFactId = new Map<string, Set<string>>();
  const addSourceForNode = (nodeId: string, sourceId: string): void => {
    const existing = sourceIdsByNodeId.get(nodeId);
    if (existing) {
      existing.add(sourceId);
      return;
    }
    sourceIdsByNodeId.set(nodeId, new Set([sourceId]));
  };
  const addDescribingFact = (nodeId: string, factId: string): void => {
    const existing = describingFactIdsByNodeId.get(nodeId);
    if (existing) {
      existing.add(factId);
      return;
    }
    describingFactIdsByNodeId.set(nodeId, new Set([factId]));
  };
  const addSourceForFact = (factId: string, sourceId: string): void => {
    const existing = sourceIdsByFactId.get(factId);
    if (existing) {
      existing.add(sourceId);
      return;
    }
    sourceIdsByFactId.set(factId, new Set([sourceId]));
  };
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node') {
      if (edge.relation === 'supports_fact') addSourceForFact(edge.toId, edge.fromId);
      else addSourceForNode(edge.toId, edge.fromId);
      continue;
    }
    if (edge.fromKind === 'node' && edge.toKind === 'source') {
      addSourceForNode(edge.fromId, edge.toId);
      continue;
    }
    if (edge.fromKind === 'node'
      && edge.toKind === 'node'
      && edge.relation === 'describes') {
      addDescribingFact(edge.toId, edge.fromId);
    }
  }
  for (const [nodeId, factIds] of describingFactIdsByNodeId) {
    for (const factId of factIds) {
      const fact = nodesById.get(factId);
      if (!fact || fact.status === 'stale') continue;
      for (const sourceId of factSourceIds(fact)) addSourceForNode(nodeId, sourceId);
      for (const sourceId of sourceIdsByFactId.get(factId) ?? []) {
        addSourceForNode(nodeId, sourceId);
      }
    }
  }
  for (const source of sources) {
    const discovery = readRecord(source.metadata.sourceDiscovery);
    for (const linkedObjectId of readStringArray(discovery.linkedObjectIds)) {
      addSourceForNode(linkedObjectId, source.id);
    }
  }
  return { sourcesById, sourceIdsByNodeId };
}

async function sourcesForDevicePassport(nodeId: string, lookup: DevicePassportSourceLookup, reader: HomeGraphPageSourceReader): Promise<KnowledgeSourceRecord[]> {
  const candidates = [...(lookup.sourceIdsByNodeId.get(nodeId) ?? [])]
    .map((sourceId) => lookup.sourcesById.get(sourceId))
    .filter((source): source is KnowledgeSourceRecord => Boolean(source));
  return (await reader.rank(candidates)).map((item) => item.source);
}

function filterDevicePassportIssues(
  issues: readonly KnowledgeIssueRecord[],
  sources: readonly KnowledgeSourceRecord[],
): readonly KnowledgeIssueRecord[] {
  if (sources.length === 0) return issues;
  return issues.filter((issue) => issue.code !== 'homegraph.device.missing_manual');
}

function uniqueNodesById(nodes: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const byId = new Map<string, KnowledgeNodeRecord>();
  for (const node of nodes) byId.set(node.id, node);
  return [...byId.values()];
}

function limitRecords<T>(records: readonly T[], limit: number | undefined): readonly T[] {
  if (typeof limit !== 'number') return records;
  if (!Number.isFinite(limit)) return records;
  return records.slice(0, Math.max(0, Math.trunc(limit)));
}

function clampForegroundLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

function resolveRoomTitle(nodes: readonly KnowledgeNodeRecord[], areaId: string | undefined): string | undefined {
  if (!areaId) return undefined;
  return (
    findHomeAssistantNode(nodes, 'ha_area', areaId)
    ?? findHomeAssistantNode(nodes, 'ha_room', areaId)
  )?.title;
}
