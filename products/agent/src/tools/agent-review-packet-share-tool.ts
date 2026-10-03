import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryPreview,
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

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
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
  return `agent_artifacts mode:"export" artifactId:"${summary.artifactId}" destinationPath:"exports/${summary.filename}" confirm:true explicitUserRequest:"..."`;
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

function formatSharePreview(input: {
  readonly summary: ReviewPacketArchiveSummary;
  readonly message: string;
  readonly title: string;
  readonly args: AgentReviewPacketShareToolArgs;
  readonly router: AgentReviewPacketShareChannelRouter;
}): string {
  const preview = buildAgentChannelDeliveryPreview({
    message: input.message,
    title: input.title,
    ...(readString(input.args.channel) ? { channel: readString(input.args.channel) } : {}),
    ...(readString(input.args.route) ? { route: readString(input.args.route) } : {}),
    ...(readString(input.args.webhook) ? { webhook: readString(input.args.webhook) } : {}),
    ...(readString(input.args.link) ? { link: readString(input.args.link) } : {}),
  });
  return [
    'Agent review packet share preview',
    `  archive ${input.summary.artifactId} ${input.summary.filename}`,
    `  comparison ${input.summary.comparisonId}`,
    `  included artifacts ${input.summary.artifactCount}`,
    `  related artifacts ${formatIdList(input.summary.relatedArtifactIds)}`,
    `  route-decision receipts ${formatIdList(input.summary.routeDecisionArtifactIds)}`,
    `  export route ${archiveExportRoute(input.summary)}`,
    '',
    formatAgentChannelDeliveryPreview(preview, input.router.listStrategies().length),
    '',
    'policy sends a plain-text archive reference only; ZIP bytes stay in the Agent artifact store until an explicit export route is run',
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
      description: 'Share one confirmed reviewer archive reference.',
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
            description: 'Required true for confirmed delivery.',
          },
          explicitUserRequest: {
            type: 'string',
            description: 'User request authorizing this delivery.',
          },
        },
        required: ['archiveArtifactId', 'confirm', 'explicitUserRequest'],
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      const args = rawArgs as AgentReviewPacketShareToolArgs;
      const explicitUserRequest = readString(args.explicitUserRequest);
      if (!explicitUserRequest) {
        return failure('explicitUserRequest is required so review packet delivery stays tied to a direct user request.');
      }
      const artifactId = readString(args.archiveArtifactId);
      if (!artifactId) return failure('archiveArtifactId is required.');
      let summary: ReviewPacketArchiveSummary;
      try {
        summary = summarizeArchiveArtifact(await loadArchiveArtifact(artifactStore, artifactId));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      const title = readString(args.title) ?? 'GoodVibes Agent review packet';
      const message = buildShareMessage(summary, readString(args.message));
      try {
        const preview = formatSharePreview({ summary, message, title, args, router: channelDeliveryRouter });
        if (!readBoolean(args.confirm)) {
          return failure([
            preview,
            '',
            'Model tool confirmation required. Call this tool with confirm:true only when the user explicitly asked GoodVibes Agent to share this reviewer packet.',
          ].join('\n'));
        }
        const delivery = await deliverAgentChannelMessage(channelDeliveryRouter, {
          message,
          title,
          ...(readString(args.channel) ? { channel: readString(args.channel) } : {}),
          ...(readString(args.route) ? { route: readString(args.route) } : {}),
          ...(readString(args.webhook) ? { webhook: readString(args.webhook) } : {}),
          ...(readString(args.link) ? { link: readString(args.link) } : {}),
        });
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
