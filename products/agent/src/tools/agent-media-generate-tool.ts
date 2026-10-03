import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  formatAgentMediaGenerationResult,
  generateAgentMedia,
} from '../agent/media-generation.ts';

export interface AgentMediaGenerateToolArgs {
  readonly prompt?: unknown;
  readonly providerId?: unknown;
  readonly modelId?: unknown;
  readonly outputMimeType?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function preview(args: AgentMediaGenerateToolArgs, providerCount: number): string {
  const prompt = readString(args.prompt);
  return [
    'Agent media generation preview',
    `  prompt ${prompt || '(missing)'}`,
    `  provider ${readString(args.providerId) || '(auto)'}`,
    `  model ${readString(args.modelId) || '(provider default)'}`,
    `  output mime ${readString(args.outputMimeType) || '(provider default)'}`,
    `  generation providers ${providerCount}`,
    '  policy media generation requires an explicit user request and confirm:true',
  ].join('\n');
}

export function createAgentMediaGenerateTool(
  mediaProviderRegistry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
): Tool {
  return {
    definition: {
      name: 'agent_media_generate',
      description: 'Generate one confirmed image or video artifact.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Media generation prompt.',
          },
          providerId: {
            type: 'string',
            description: 'Optional media provider id.',
          },
          modelId: {
            type: 'string',
            description: 'Optional provider-specific media model id.',
          },
          outputMimeType: {
            type: 'string',
            description: 'Optional requested output MIME type, such as image/png or video/mp4.',
          },
          confirm: {
            type: 'boolean',
            description: 'Required true only when user requested this media.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing this media generation.',
          },
        },
        required: ['prompt', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = rawArgs as AgentMediaGenerateToolArgs;
      const prompt = readString(args.prompt);
      const explicitUserRequest = readString(args.explicitUserRequest);
      const generationProviderCount = mediaProviderRegistry.list()
        .filter((provider) => provider.capabilities.includes('generate')).length;
      if (!prompt) return failure('prompt is required.');
      if (!explicitUserRequest) {
        return failure('explicitUserRequest is required so media generation stays tied to a direct user request.');
      }
      if (!readBoolean(args.confirm)) {
        return failure([
          preview(args, generationProviderCount),
          '',
          'Model tool confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to generate this media.',
        ].join('\n'));
      }
      try {
        const result = await generateAgentMedia(mediaProviderRegistry, artifactStore, {
          prompt,
          ...(readString(args.providerId) ? { providerId: readString(args.providerId) } : {}),
          ...(readString(args.modelId) ? { modelId: readString(args.modelId) } : {}),
          ...(readString(args.outputMimeType) ? { outputMimeType: readString(args.outputMimeType) } : {}),
        });
        return output(formatAgentMediaGenerationResult(result));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentMediaGenerateTool(
  registry: ToolRegistry,
  mediaProviderRegistry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
): void {
  registry.register(createAgentMediaGenerateTool(mediaProviderRegistry, artifactStore));
}
