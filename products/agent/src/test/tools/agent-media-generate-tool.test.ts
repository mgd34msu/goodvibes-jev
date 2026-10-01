import { describe, expect, test } from 'bun:test';
import type { ArtifactCreateInput, ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  createAgentMediaGenerateTool,
  registerAgentMediaGenerateTool,
} from '../../tools/agent-media-generate-tool.ts';

interface MediaToolFixture {
  readonly registry: MediaProviderRegistry;
  readonly storeCreates: ArtifactCreateInput[];
  readonly prompts: string[];
  readonly tool: ReturnType<typeof createAgentMediaGenerateTool>;
}

function descriptor(input: ArtifactCreateInput, index: number): ArtifactDescriptor {
  return {
    id: `media-artifact-${index}`,
    kind: input.mimeType?.startsWith('video/') ? 'video' : 'image',
    mimeType: input.mimeType ?? 'application/octet-stream',
    filename: input.filename,
    sizeBytes: input.dataBase64?.length ?? 256,
    sha256: `sha-${index}`,
    createdAt: Date.now(),
    acquisitionMode: input.acquisitionMode ?? 'unknown',
    fetchMode: input.fetchMode ?? 'unknown',
    ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
    metadata: input.metadata ?? {},
  };
}

function fixture(): MediaToolFixture {
  const registry = new MediaProviderRegistry();
  const prompts: string[] = [];
  const storeCreates: ArtifactCreateInput[] = [];
  registry.register({
    id: 'agent-media-test',
    label: 'Agent Media Test',
    capabilities: ['generate'],
    generate: async (request) => {
      prompts.push(request.prompt);
      return {
        providerId: 'agent-media-test',
        artifacts: [{
          mimeType: request.outputMimeType ?? 'image/png',
          dataBase64: 'ZmFrZS1pbWFnZS1kYXRh',
          filename: 'agent-media.png',
          metadata: {
            modelId: request.modelId,
          },
        }],
        metadata: {},
      };
    },
  });
  const artifactStore = {
    create: async (input: ArtifactCreateInput): Promise<ArtifactDescriptor> => {
      storeCreates.push(input);
      return descriptor(input, storeCreates.length);
    },
  };
  return {
    registry,
    storeCreates,
    prompts,
    tool: createAgentMediaGenerateTool(registry, artifactStore),
  };
}

describe('agent_media_generate tool', () => {
  test('previews without calling providers when confirmation is missing', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      prompt: 'Create a friendly home screen illustration',
      confirm: false,
      explicitUserRequest: 'Generate a home screen image.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent media generation preview');
    expect(result.error).toContain('confirmation required');
    expect(item.prompts).toEqual([]);
    expect(item.storeCreates).toEqual([]);
  });

  test('requires explicit user request before generation', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      prompt: 'Create a friendly home screen illustration',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('explicitUserRequest is required');
    expect(item.prompts).toEqual([]);
    expect(item.storeCreates).toEqual([]);
  });

  test('generates media artifacts after explicit confirmation', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      prompt: 'Create a friendly home screen illustration',
      modelId: 'fast-model',
      outputMimeType: 'image/png',
      confirm: true,
      explicitUserRequest: 'Generate a home screen image.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent media generated');
    expect(result.output).toContain('media-artifact-1');
    expect(result.output).not.toContain('ZmFrZS1pbWFnZS1kYXRh');
    expect(item.prompts).toEqual(['Create a friendly home screen illustration']);
    expect(item.storeCreates[0]?.metadata).toMatchObject({
      product: 'goodvibes-agent',
      source: 'agent-media-generation',
      providerId: 'agent-media-test',
    });
  });

  test('fails closed when no generation provider is available', async () => {
    const registry = new MediaProviderRegistry();
    registry.register({ id: 'understand-only', label: 'Understand Only', capabilities: ['understand'] });
    const storeCreates: ArtifactCreateInput[] = [];
    const tool = createAgentMediaGenerateTool(registry, {
      create: async (input: ArtifactCreateInput): Promise<ArtifactDescriptor> => {
        storeCreates.push(input);
        return descriptor(input, storeCreates.length);
      },
    });

    const result = await tool.execute({
      prompt: 'Create a thing',
      confirm: true,
      explicitUserRequest: 'Generate an image.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No media generation provider is available');
    expect(storeCreates).toEqual([]);
  });

  test('is registered in the model tool registry', () => {
    const item = fixture();
    const registry = new ToolRegistry();

    registerAgentMediaGenerateTool(registry, item.registry, {
      create: async (input: ArtifactCreateInput): Promise<ArtifactDescriptor> => descriptor(input, 1),
    });

    expect(registry.has('agent_media_generate')).toBe(true);
  });
});
