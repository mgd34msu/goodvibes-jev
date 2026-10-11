import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { agentArtifactEffectGuard, captureAgentArtifactSource } from './agent-artifact-effect.ts';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import {
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryResult,
} from '../agent/channel-delivery.ts';

export interface AgentReviewPacketShareToolArgs {
  readonly archiveArtifactId?: unknown;
  readonly message?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly route?: unknown;
  readonly webhook?: unknown;
  readonly link?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type AgentReviewPacketShareArtifactStore = Pick<ArtifactStore, 'get' | 'list' | 'readContent'>;
type AgentReviewPacketShareChannelRouter = Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>;
type AgentReviewPacketShareArtifact = ArtifactDescriptor | ArtifactRecord;

interface ReviewPacketArchiveSummary {
  readonly artifactId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly comparisonId: string;
  readonly handoffArtifactId: string;
  readonly handoffId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: string;
  readonly relatedArtifactIds: readonly string[];
  readonly routeDecisionArtifactIds: readonly string[];
  readonly includedArtifactIds: readonly string[];
  readonly artifactCount: number;
  readonly archiveBytes: number;
  readonly revealIncludedInHandoff: boolean;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}


function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
  }
  const scalar = readString(value);
  if (!scalar) return [];
  return scalar.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

async function loadArchiveArtifact(
  artifactStore: AgentReviewPacketShareArtifactStore | undefined,
  artifactId: string,
): Promise<AgentReviewPacketShareArtifact> {
  if (!artifactStore?.get && !artifactStore?.list && !artifactStore?.readContent) {
    throw new Error('Review packet share is unavailable because this runtime cannot inspect artifacts.');
  }
  const direct = artifactStore.get?.(artifactId);
  if (direct) return direct;
  const listed = artifactStore.list?.(200).find((artifact) => artifact.id === artifactId);
  if (listed) return listed;
  if (artifactStore.readContent) return (await artifactStore.readContent(artifactId)).record;
  throw new Error(`Unknown review packet archive artifact: ${artifactId}`);
}

function summarizeArchiveArtifact(artifact: AgentReviewPacketShareArtifact): ReviewPacketArchiveSummary {
  const metadata = artifact.metadata ?? {};
  const purpose = readString(metadata.purpose);
  if (purpose !== 'agent-model-compare-handoff-archive') {
    throw new Error('Review packet share requires a saved reviewer handoff archive artifact.');
  }
  const comparisonId = readString(metadata.comparisonId);
  const handoffArtifactId = readString(metadata.handoffArtifactId);
  const sourceArtifactId = readString(metadata.sourceArtifactId);
  if (!comparisonId || !handoffArtifactId || !sourceArtifactId) {
    throw new Error('Review packet archive metadata is missing comparison, handoff, or source ids.');
  }
  return {
    artifactId: artifact.id,
    filename: artifact.filename ?? `${artifact.id}.zip`,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    comparisonId,
    handoffArtifactId,
    handoffId: readString(metadata.handoffId) ?? '(unknown)',
    sourceArtifactId,
    sourceKind: readString(metadata.sourceKind) ?? 'unknown',
    relatedArtifactIds: readStringArray(metadata.relatedArtifactIds),
    routeDecisionArtifactIds: readStringArray(metadata.routeDecisionArtifactIds),
    includedArtifactIds: readStringArray(metadata.includedArtifactIds),
    artifactCount: readNumber(metadata.artifactCount) ?? readStringArray(metadata.includedArtifactIds).length,
    archiveBytes: readNumber(metadata.archiveBytes) ?? artifact.sizeBytes,
    revealIncludedInHandoff: metadata.revealIncludedInHandoff === true,
  };
}

function formatIdList(ids: readonly string[], max = 6): string {
  if (ids.length === 0) return '(none)';
  const visible = ids.slice(0, max).join(', ');
  return ids.length > max ? `${visible}, +${ids.length - max} more` : visible;
}

function archiveExportRoute(summary: ReviewPacketArchiveSummary): string {
  return `agent_artifacts mode:"export" artifactId:"${summary.artifactId}" destinationPath:"exports/${summary.filename}"`;
}

function buildPacketEvidenceLines(summary: ReviewPacketArchiveSummary): readonly string[] {
  return [
    `Archive: ${summary.artifactId} (${summary.filename}, ${summary.archiveBytes} bytes)`,
    `Comparison: ${summary.comparisonId}`,
    `Handoff: ${summary.handoffArtifactId} (${summary.handoffId})`,
    `Source: ${summary.sourceArtifactId} (${summary.sourceKind})`,
    `Included artifacts: ${summary.artifactCount} (${formatIdList(summary.includedArtifactIds)})`,
    `Related artifacts: ${formatIdList(summary.relatedArtifactIds)}`,
    `Route-decision receipts: ${formatIdList(summary.routeDecisionArtifactIds)}`,
    `Reveal: ${summary.revealIncludedInHandoff ? 'included in handoff when available' : 'not included in handoff'}`,
    `Export route: ${archiveExportRoute(summary)}`,
  ];
}

function buildShareMessage(summary: ReviewPacketArchiveSummary, customMessage: string | undefined): string {
  return [
    customMessage ?? 'GoodVibes Agent reviewer packet is ready.',
    '',
    'Reviewer packet evidence:',
    ...buildPacketEvidenceLines(summary),
  ].join('\n');
}

function formatShareResult(input: {
  readonly summary: ReviewPacketArchiveSummary;
  readonly delivery: Awaited<ReturnType<typeof deliverAgentChannelMessage>>;
}): string {
  return [
    'Agent review packet shared',
    `archive ${input.summary.artifactId} ${input.summary.filename}`,
    `comparison ${input.summary.comparisonId}`,
    `included artifacts ${input.summary.artifactCount}`,
    `export ${archiveExportRoute(input.summary)}`,
    '',
    formatAgentChannelDeliveryResult(input.delivery),
    'policy delivered only a plain-text archive reference; original artifact bytes remain local',
  ].join('\n');
}

export function createAgentReviewPacketShareTool(
  artifactStore: AgentReviewPacketShareArtifactStore | undefined,
  channelDeliveryRouter: AgentReviewPacketShareChannelRouter,
): Tool {
  return {
    definition: {
      name: 'agent_review_packet_share',
      description: 'Share one reviewer archive reference after recorded effect admission.',
      parameters: {
        type: 'object',
        properties: {
          archiveArtifactId: {
            type: 'string',
            description: 'Saved handoff archive artifact id.',
          },
          message: {
            type: 'string',
            description: 'Optional note prepended to packet evidence.',
          },
          title: {
            type: 'string',
            description: 'Optional delivery title.',
          },
          channel: {
            type: 'string',
            description: 'Optional channel target. Use exactly one target field.',
          },
          route: {
            type: 'string',
            description: 'Optional route id or route:label. Use one target.',
          },
          webhook: {
            type: 'string',
            description: 'Optional http(s) webhook URL. Use one target.',
          },
          link: {
            type: 'string',
            description: 'Optional link delivery target. Use one target.',
          },
          confirm: {
            type: 'boolean',
            description: 'Optional request provenance. Recorded engine admission authorizes delivery.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'Optional user request provenance.',
          },
        },
        required: ['archiveArtifactId'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions) => {
      const args = rawArgs;
      const effect = agentArtifactEffectGuard(rawArgs, executionOptions, 'send');
      try { effect(); } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
      const artifactId = readString(args.archiveArtifactId);
      if (!artifactId) return failure('archiveArtifactId is required.');
      let summary: ReviewPacketArchiveSummary;
      let assertSource: () => void;
      try {
        const archive = await loadArchiveArtifact(artifactStore, artifactId);
        effect();
        assertSource = captureAgentArtifactSource(artifactStore ?? {}, archive);
        assertSource();
        summary = summarizeArchiveArtifact(archive);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      const title = readString(args.title) ?? 'GoodVibes Agent review packet';
      const message = buildShareMessage(summary, readString(args.message));
      try {
        const ledger = getSessionUntrustedContentLedger();
        const ledgerSnapshot = () => JSON.stringify([ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
        const sources = ledgerSnapshot();
        const deliver = channelDeliveryRouter.deliver, listStrategies = channelDeliveryRouter.listStrategies;
        const strategies = listStrategies.call(channelDeliveryRouter).map(strategy => ({ strategy, canHandle: strategy.canHandle, deliver: strategy.deliver }));
        const assertCurrent = () => {
          effect(); assertSource();
          const current = listStrategies.call(channelDeliveryRouter);
          if (channelDeliveryRouter.deliver !== deliver || channelDeliveryRouter.listStrategies !== listStrategies
            || getSessionUntrustedContentLedger() !== ledger || ledgerSnapshot() !== sources
            || current.length !== strategies.length || strategies.some((source, index) => current[index] !== source.strategy
              || source.strategy.canHandle !== source.canHandle || source.strategy.deliver !== source.deliver)) throw new ToolInputProjectionError('stale');
        };
        assertCurrent();
        const decision = await evaluateOutwardEffect({
          request: { toolName: 'agent_review_packet_share', action: 'review-packet.share', description: 'sharing the saved reviewer archive reference' },
          ledger,
          content: { message, title, channel: readString(args.channel), route: readString(args.route), webhook: readString(args.webhook), link: readString(args.link) },
          taintOptions: { signal: executionOptions?.signal, exactMatchFields: ['channel', 'route', 'webhook', 'link'] },
        });
        assertCurrent();
        if (!decision.allowed) return failure(decision.reason ?? 'Outward effect held.');
        const delivery = await deliverAgentChannelMessage(channelDeliveryRouter, {
          message,
          title,
          ...(readString(args.channel) ? { channel: readString(args.channel) } : {}),
          ...(readString(args.route) ? { route: readString(args.route) } : {}),
          ...(readString(args.webhook) ? { webhook: readString(args.webhook) } : {}),
          ...(readString(args.link) ? { link: readString(args.link) } : {}),
        }, { signal: executionOptions?.signal, assertCurrent });
        assertCurrent();
        return output(formatShareResult({ summary, delivery }));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentReviewPacketShareTool(
  registry: ToolRegistry,
  artifactStore: AgentReviewPacketShareArtifactStore | undefined,
  channelDeliveryRouter: AgentReviewPacketShareChannelRouter,
): void {
  registry.register(createAgentReviewPacketShareTool(artifactStore, channelDeliveryRouter));
}
