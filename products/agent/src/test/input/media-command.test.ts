import { describe, expect, test } from 'bun:test';
import type { ArtifactCreateInput, ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';

interface MediaCommandContext {
  readonly out: string[];
  readonly prompts: string[];
  readonly creates: ArtifactCreateInput[];
  readonly ctx: CommandContext;
}

function descriptor(input: ArtifactCreateInput, index: number): ArtifactDescriptor {
  return {
    id: `slash-media-${index}`,
    kind: input.mimeType?.startsWith('video/') ? 'video' : 'image',
    mimeType: input.mimeType ?? 'application/octet-stream',
    filename: input.filename,
    sizeBytes: input.dataBase64?.length ?? 256,
    sha256: `slash-sha-${index}`,
    createdAt: Date.now(),
    acquisitionMode: input.acquisitionMode ?? 'unknown',
    fetchMode: input.fetchMode ?? 'unknown',
    ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
    metadata: input.metadata ?? {},
  };
}

function makeContext(): MediaCommandContext {
  const registry = new MediaProviderRegistry();
  const out: string[] = [];
  const prompts: string[] = [];
  const creates: ArtifactCreateInput[] = [];
  registry.register({
    id: 'slash-media-test',
    label: 'Slash Media Test',
    capabilities: ['generate'],
    status: () => ({
      id: 'slash-media-test',
      label: 'Slash Media Test',
      state: 'healthy',
      capabilities: ['generate'],
      configured: true,
      metadata: {},
    }),
    generate: async (request) => {
      prompts.push(request.prompt);
      return {
        providerId: 'slash-media-test',
        artifacts: [{
          mimeType: request.outputMimeType ?? 'image/png',
          dataBase64: 'c2xhc2gtbWVkaWEtZGF0YQ==',
          filename: 'slash-media.png',
          metadata: { modelId: request.modelId },
        }],
        metadata: {},
      };
    },
  });

  const ctx = {
    session: {},
    provider: {},
    workspace: {},
    platform: {
      mediaProviderRegistry: registry,
      artifactStore: {
        create: async (input: ArtifactCreateInput): Promise<ArtifactDescriptor> => {
          creates.push(input);
          return descriptor(input, creates.length);
        },
      },
    },
    ops: {},
    extensions: {},
    renderRequest: () => undefined,
    print: (text: string) => out.push(text),
    exit: () => undefined,
  } as unknown as CommandContext;

  return { out, prompts, creates, ctx };
}

describe('/media command', () => {
  test('lists configured media providers', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const item = makeContext();

    await registry.execute('media', ['providers'], item.ctx);

    expect(item.out.join('\n')).toContain('[media] Providers:');
    expect(item.out.join('\n')).toContain('slash-media-test: healthy');
  });

  test('requires --yes before media generation', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const item = makeContext();

    await registry.execute('media', ['generate', '--provider', 'slash-media-test', 'Create', 'an', 'image'], item.ctx);

    expect(item.prompts).toEqual([]);
    expect(item.creates).toEqual([]);
    expect(item.out.join('\n')).toContain('without --yes');
  });

  test('generates artifacts through configured media providers after confirmation', async () => {
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const item = makeContext();

    await registry.execute('media', [
      'generate',
      '--provider',
      'slash-media-test',
      '--model',
      'fast',
      '--mime',
      'image/png',
      'Create a calm operator workspace image',
      '--yes',
    ], item.ctx);

    expect(item.prompts).toEqual(['Create a calm operator workspace image']);
    expect(item.creates[0]?.metadata).toMatchObject({
      product: 'goodvibes-agent',
      source: 'agent-media-generation',
      providerId: 'slash-media-test',
    });
    expect(item.out.join('\n')).toContain('Agent media generated');
    expect(item.out.join('\n')).toContain('slash-media-1');
    expect(item.out.join('\n')).not.toContain('c2xhc2gtbWVkaWEtZGF0YQ==');
  });
});
