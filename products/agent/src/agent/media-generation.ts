import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type {
  MediaArtifact,
  MediaGenerationRequest,
  MediaProvider,
  MediaProviderRegistry,
} from '@goodvibes-jev/engine/sdk/platform/media';
import { retainSurfaceMethods, retainSurfaceRead } from '../tools/agent-surface-effect.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { assertDeliveryCurrent, type DeliveryLifetime } from '@goodvibes-jev/engine/sdk/platform/utils';

export interface AgentMediaGenerationInput {
  readonly prompt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly outputMimeType?: string;
  readonly options?: Record<string, unknown>;
}

export interface AgentGeneratedMediaArtifact {
  readonly artifactId: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly sizeBytes: number;
  readonly sourceUri?: string;
}

export interface AgentMediaGenerationResult {
  readonly providerId: string;
  readonly artifacts: readonly AgentGeneratedMediaArtifact[];
  readonly metadata: Record<string, unknown>;
}

function readText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function ensurePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Media generation prompt is required.');
  return trimmed;
}

function findGenerationProvider(registry: MediaProviderRegistry, providerId: string | undefined): MediaProvider {
  const provider = registry.findProvider('generate', readText(providerId));
  if (!provider?.generate) {
    const available = registry
      .list()
      .filter((entry) => entry.capabilities.includes('generate'))
      .map((entry) => entry.id)
      .join(', ');
    throw new Error(providerId
      ? `Media generation provider is unavailable or not configured for generation: ${providerId}.`
      : `No media generation provider is available${available ? `. Available providers: ${available}` : '.'}`);
  }
  return provider;
}

function filenameForArtifact(artifact: MediaArtifact, index: number): string {
  if (readText(artifact.filename)) return artifact.filename as string;
  if (artifact.mimeType.includes('video')) return `agent-generated-${index + 1}.mp4`;
  if (artifact.mimeType.includes('image')) return `agent-generated-${index + 1}.png`;
  return `agent-generated-${index + 1}`;
}

function artifactCreateInput(
  providerId: string,
  artifact: MediaArtifact,
  index: number,
): ArtifactCreateInput {
  const filename = filenameForArtifact(artifact, index);
  const metadata = {
    ...artifact.metadata,
    product: 'goodvibes-agent',
    source: 'agent-media-generation',
    providerId,
  };
  const common = {
    mimeType: artifact.mimeType,
    filename,
    metadata,
  };
  if (readText(artifact.dataBase64)) {
    return {
      ...common,
      dataBase64: artifact.dataBase64,
      sourceUri: artifact.uri,
      acquisitionMode: 'inline-data',
    };
  }
  if (readText(artifact.uri)) {
    return {
      ...common,
      uri: artifact.uri,
      sourceUri: artifact.uri,
      acquisitionMode: 'remote-fetch',
      fetchMode: 'public-only',
    };
  }
  throw new Error(`Generated media artifact ${index + 1} did not include inline data or a fetchable URI.`);
}

function toGeneratedArtifact(descriptor: ArtifactDescriptor): AgentGeneratedMediaArtifact {
  return {
    artifactId: descriptor.id,
    mimeType: descriptor.mimeType,
    ...(descriptor.filename ? { filename: descriptor.filename } : {}),
    sizeBytes: descriptor.sizeBytes,
    ...(descriptor.sourceUri ? { sourceUri: descriptor.sourceUri } : {}),
  };
}

function buildProviderRequest(input: AgentMediaGenerationInput): MediaGenerationRequest {
  return {
    prompt: ensurePrompt(input.prompt),
    ...(readText(input.outputMimeType) ? { outputMimeType: readText(input.outputMimeType) } : {}),
    ...(readText(input.modelId) ? { modelId: readText(input.modelId) } : {}),
    ...(input.options ? { options: input.options } : {}),
    metadata: {
      product: 'goodvibes-agent',
      source: 'agent-media-generation',
    },
  };
}

export async function generateAgentMedia(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
  input: AgentMediaGenerationInput,
  lifetime: DeliveryLifetime = {},
): Promise<AgentMediaGenerationResult> {
  assertDeliveryCurrent(lifetime);
  const provider = findGenerationProvider(registry, input.providerId);
  const generate = provider.generate;
  if (!generate) throw new Error(`Media generation provider is unavailable or not configured for generation: ${provider.id}.`);
  const incarnation = registry.getIncarnation();
  const registryCurrent = retainSurfaceMethods(registry, ['getIncarnation', 'findProvider', 'get']);
  const providerCurrent = retainSurfaceRead(provider, ['generate'], () => ({ id: provider.id, label: provider.label, capabilities: provider.capabilities }));
  const storeCurrent = retainSurfaceMethods(artifactStore, ['create']);
  const assertCurrent = () => {
    assertDeliveryCurrent(lifetime);
    registryCurrent(); providerCurrent(); storeCurrent();
    if (registry.getIncarnation() !== incarnation || registry.get(provider.id) !== provider) throw new ToolInputProjectionError('stale');
  };
  assertCurrent();
  const ownership = { signal: lifetime.signal, assertCurrent };
  const generated = await generate.call(provider, buildProviderRequest(input), ownership);
  assertCurrent();
  if (generated.providerId !== provider.id) throw new Error('The generation response belongs to a different provider.');
  const artifacts: AgentGeneratedMediaArtifact[] = [];
  try {
    for (const [index, artifact] of generated.artifacts.entries()) {
      assertCurrent();
      const descriptor = await artifactStore.create(artifactCreateInput(generated.providerId, artifact, index), ownership);
      artifacts.push(toGeneratedArtifact(descriptor));
      assertCurrent();
    }
  } catch {
    throw new Error(`Media generation stopped after ${artifacts.length} confirmed artifact writes. The provider request completed; any interrupted write may also have completed. Inspect stored artifacts before retrying.`);
  }
  if (artifacts.length === 0) throw new Error(`Media provider ${generated.providerId} did not return artifacts.`);
  return {
    providerId: generated.providerId,
    artifacts,
    metadata: generated.metadata,
  };
}

export function formatAgentMediaGenerationResult(result: AgentMediaGenerationResult): string {
  return [
    'Agent media generated',
    `  provider ${result.providerId}`,
    `  artifacts ${result.artifacts.length}`,
    ...result.artifacts.map((artifact, index) => [
      `  ${index + 1}. ${artifact.artifactId}`,
      `     type ${artifact.mimeType}`,
      `     size ${artifact.sizeBytes} bytes`,
      ...(artifact.filename ? [`     filename ${artifact.filename}`] : []),
      ...(artifact.sourceUri ? [`     source ${artifact.sourceUri}`] : []),
    ].join('\n')),
  ].join('\n');
}
