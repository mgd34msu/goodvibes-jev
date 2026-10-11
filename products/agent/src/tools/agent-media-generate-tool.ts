import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { snapshotJudgmentInput, captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { CardMaterialRefusedError, screenOutboundForCardMaterial } from '../agent/payments-channel-guard.ts';
import { retainSurfaceMethods } from './agent-surface-effect.ts';
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
  readonly preview?: unknown;
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
    '  policy media generation requires current recorded effect admission',
  ].join('\n');
}

export function createAgentMediaGenerateTool(
  mediaProviderRegistry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
): Tool {
  return {
    definition: {
      name: 'agent_media_generate',
      description: 'Preview or generate one image or video artifact through current recorded effect admission.',
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
            description: 'Optional historical provenance; does not grant generation authority.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional request provenance; does not grant generation authority.',
          },
          preview: { type: 'boolean', description: 'Return a read-only preview without generation.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
    },
    execute: async (rawArgs, executionOptions) => {
      const args = captureStrictJudgmentJson(rawArgs); snapshotJudgmentInput(args);
      const prompt = readString(args.prompt);
      const generationProviderCount = mediaProviderRegistry.list()
        .filter((provider) => provider.capabilities.includes('generate')).length;
      if (!prompt) return failure('prompt is required.');
      if (readBoolean(args.preview)) return output(preview(args, generationProviderCount));
      try {
        const ledger = getSessionUntrustedContentLedger();
        const ledgerMethods = retainSurfaceMethods(ledger, ['getPublicationRevision', 'originsThisTurn', 'exposuresThisTurn', 'taintSourcesThisTurn']);
        const ledgerCurrent = () => JSON.stringify([ledger.getPublicationRevision(), ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
        const sources = ledgerCurrent();
        const assertCurrent = () => {
          executionOptions?.signal?.throwIfAborted();
          if (!assertCurrentToolEffect(rawArgs, executionOptions, 'send') || !assertCurrentToolEffect(rawArgs, executionOptions, 'write')) throw new ToolInputProjectionError('held');
          ledgerMethods();
          if (getSessionUntrustedContentLedger() !== ledger || ledgerCurrent() !== sources) throw new ToolInputProjectionError('stale');
        };
        assertCurrent();
        const outward = await evaluateOutwardEffect({ request: { toolName: 'agent_media_generate', action: 'media.generate', description: 'sending the media generation prompt' },
          ledger, content: { prompt }, taintOptions: { signal: executionOptions?.signal } });
        assertCurrent(); if (!outward.allowed) return failure(outward.reason ?? 'Media prompt content was refused.');
        const card = await screenOutboundForCardMaterial({ surface: 'media-provider', message: prompt }, { signal: executionOptions?.signal, assertCurrent });
        assertCurrent(); if (card) throw new CardMaterialRefusedError(card);
        const result = await generateAgentMedia(mediaProviderRegistry, artifactStore, {
          prompt,
          ...(readString(args.providerId) ? { providerId: readString(args.providerId) } : {}),
          ...(readString(args.modelId) ? { modelId: readString(args.modelId) } : {}),
          ...(readString(args.outputMimeType) ? { outputMimeType: readString(args.outputMimeType) } : {}),
        }, { signal: executionOptions?.signal, assertCurrent });
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
