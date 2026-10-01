import { describe, expect, test } from 'bun:test';
import type { ArtifactCreateInput, ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import {
  formatAgentMediaGenerationResult,
  generateAgentMedia,
} from '../../agent/media-generation.ts';

interface CapturedArtifactStore {
  readonly creates: ArtifactCreateInput[];
  readonly create: (input: ArtifactCreateInput) => Promise<ArtifactDescriptor>;
}

function artifactStore(): CapturedArtifactStore {
  const creates: ArtifactCreateInput[] = [];
  return {
    creates,
    create: async (input: ArtifactCreateInput): Promise<ArtifactDescriptor> => {
      creates.push(input);
      return {
        id: `artifact-${creates.length}`,
        kind: input.mimeType?.startsWith('video/') ? 'video' : 'image',
        mimeType: input.mimeType ?? 'application/octet-stream',
        filename: input.filename,
        sizeBytes: input.dataBase64?.length ?? 128,
        sha256: `sha-${creates.length}`,
        createdAt: Date.now(),
        acquisitionMode: input.acquisitionMode ?? 'unknown',
        fetchMode: input.fetchMode ?? 'unknown',
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
        metadata: input.metadata ?? {},
      };
    },
  };
}

describe('Agent media generation', () => {
  test('stores generated inline media as artifacts and does not format base64 output', async () => {
    const registry = new MediaProviderRegistry();
    registry.register({
      id: 'test-generate',
      label: 'Test Generator',
      capabilities: ['generate'],
      generate: async (request) => ({
        providerId: 'test-generate',
        artifacts: [{
          mimeType: request.outputMimeType ?? 'image/png',
          dataBase64: 'VGhpcyBpcyBhIHRlc3QgaW1hZ2U=',
          filename: 'hero.png',
          metadata: { prompt: request.prompt },
        }],
        metadata: { modelId: request.modelId ?? 'default' },
      }),
    });
    const store = artifactStore();

    const result = await generateAgentMedia(registry, store, {
      prompt: 'Create a dashboard hero',
      providerId: 'test-generate',
      modelId: 'test-model',
      outputMimeType: 'image/png',
    });
    const formatted = formatAgentMediaGenerationResult(result);

    expect(result.providerId).toBe('test-generate');
    expect(result.artifacts[0]?.artifactId).toBe('artifact-1');
    expect(store.creates[0]?.dataBase64).toBe('VGhpcyBpcyBhIHRlc3QgaW1hZ2U=');
    expect(store.creates[0]?.metadata).toMatchObject({
      product: 'goodvibes-agent',
      source: 'agent-media-generation',
      providerId: 'test-generate',
    });
    expect(formatted).toContain('Agent media generated');
    expect(formatted).toContain('artifact-1');
    expect(formatted).not.toContain('VGhpcyBpcyBhIHRlc3QgaW1hZ2U=');
  });

  test('stores generated remote media with public-only fetch mode', async () => {
    const registry = new MediaProviderRegistry();
    registry.register({
      id: 'remote-generate',
      label: 'Remote Generator',
      capabilities: ['generate'],
      generate: async () => ({
        providerId: 'remote-generate',
        artifacts: [{
          mimeType: 'video/mp4',
          uri: 'https://media.example.test/generated.mp4',
          filename: 'generated.mp4',
          metadata: {},
        }],
        metadata: {},
      }),
    });
    const store = artifactStore();

    const result = await generateAgentMedia(registry, store, {
      prompt: 'Create a short clip',
      outputMimeType: 'video/mp4',
    });

    expect(result.artifacts[0]?.sourceUri).toBe('https://media.example.test/generated.mp4');
    expect(store.creates[0]?.uri).toBe('https://media.example.test/generated.mp4');
    expect(store.creates[0]?.fetchMode).toBe('public-only');
    expect(store.creates[0]?.acquisitionMode).toBe('remote-fetch');
  });

  test('fails when no generation provider is available', async () => {
    const registry = new MediaProviderRegistry();
    registry.register({
      id: 'understand-only',
      label: 'Understand Only',
      capabilities: ['understand'],
    });

    await expect(generateAgentMedia(registry, artifactStore(), {
      prompt: 'Create an image',
    })).rejects.toThrow('No media generation provider is available');
  });
});
