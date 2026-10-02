import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { redactedPersonalOpsText } from './agent-harness-personal-ops-runner.ts';
import { personalOpsRecordCertification } from './agent-harness-personal-ops-certification.ts';
import type { PersonalOpsConnectorSignal, PersonalOpsConnectorTool, PersonalOpsLane, PersonalOpsLaneId, PersonalOpsLiveRecord, PersonalOpsRecordFreshness, PersonalOpsStatus, PersonalOpsWorkflow, PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';

type PersonalOpsEffectReceiptLaneId = Extract<PersonalOpsLaneId, 'inbox' | 'calendar' | 'tasks' | 'reminders'>;

export function laneStatusRank(status: PersonalOpsStatus): number {
  if (status === 'ready') return 4;
  if (status === 'partial') return 3;
  if (status === 'needs-setup') return 2;
  return 1;
}

export function searchText(lane: PersonalOpsLane): string {
  return [
    lane.id,
    lane.label,
    lane.status,
    lane.outcome,
    lane.current,
    lane.next,
    lane.userRoute,
    lane.modelRoute,
    lane.signals.join('\n'),
    lane.connectorSignals?.flatMap((signal) => [
      signal.id,
      signal.label,
      signal.status,
      signal.summary,
      signal.modelRoute,
      String(signal.toolCount),
      signal.capabilityTags.join('\n'),
      signal.readTools?.map((tool) => `${tool.name} ${tool.description ?? ''} ${tool.capability}`).join('\n') ?? '',
      signal.writeTools?.map((tool) => `${tool.name} ${tool.description ?? ''} ${tool.capability}`).join('\n') ?? '',
    ]).join('\n') ?? '',
    lane.workflows?.flatMap((workflow) => [
      workflow.id,
      workflow.label,
      workflow.status,
      workflow.summary,
      workflow.next,
      workflow.modelRoute,
      workflow.inspectRoutes.join('\n'),
      workflow.prerequisites.join('\n'),
      workflow.runBoundary,
    ]).join('\n') ?? '',
    lane.liveRecords?.flatMap((record) => [
      record.id,
      record.label,
      record.status,
      record.summary,
      record.userRoute,
      record.modelRoute,
      record.tags?.join('\n') ?? '',
      record.freshness ? [
        record.freshness.status,
        record.freshness.source,
        record.freshness.sourceTool ?? '',
        record.freshness.refreshRoute ?? '',
        record.freshness.policy,
      ].join('\n') : '',
      record.certification ? [
        record.certification.schemaStatus,
        record.certification.schemaVersion ?? '',
        record.certification.publicationGuarantee ?? '',
        record.certification.publisher ?? '',
        record.certification.provenance?.join('\n') ?? '',
        record.certification.receiptIds?.join('\n') ?? '',
        record.certification.missingSignals.join('\n'),
      ].join('\n') : '',
    ]).join('\n') ?? '',
  ].join('\n').toLowerCase();
}

export function describeLiveRecord(record: PersonalOpsLiveRecord, includeParameters: boolean): Record<string, unknown> {
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    summary: previewHarnessText(record.summary, includeParameters ? 240 : 96),
    userRoute: previewHarnessText(record.userRoute, includeParameters ? 140 : 96),
    modelRoute: previewHarnessText(record.modelRoute, includeParameters ? 140 : 96),
    ...(record.tags && record.tags.length > 0 ? { tags: record.tags.slice(0, includeParameters ? 12 : 4) } : {}),
    ...(includeParameters && record.effect ? { effect: record.effect } : {}),
    ...(includeParameters && record.capability ? { capability: record.capability } : {}),
    ...(includeParameters && record.qualifiedName ? { qualifiedName: record.qualifiedName } : {}),
    ...(includeParameters && record.requiredFields ? { requiredFields: record.requiredFields } : {}),
    ...(includeParameters && record.optionalFields ? { optionalFields: record.optionalFields.slice(0, 12) } : {}),
    ...(includeParameters && record.sampleInput ? { sampleInput: record.sampleInput } : {}),
    ...(includeParameters && typeof record.confirmationRequired === 'boolean' ? { confirmationRequired: record.confirmationRequired } : {}),
    ...(includeParameters && record.artifactId ? { artifactId: record.artifactId } : {}),
    ...(includeParameters && typeof record.reviewRecordCount === 'number' ? { reviewRecordCount: record.reviewRecordCount } : {}),
    ...(includeParameters && record.reviewLabels && record.reviewLabels.length > 0 ? { reviewLabels: record.reviewLabels } : {}),
    ...(includeParameters && record.sourceTool ? { sourceTool: record.sourceTool } : {}),
    ...(includeParameters && record.certification ? { certification: record.certification } : {}),
    ...(includeParameters && record.freshness ? { freshness: record.freshness } : {}),
    ...(includeParameters && record.followUpRoutes && record.followUpRoutes.length > 0 ? { followUpRoutes: record.followUpRoutes } : {}),
  };
}

export function describeConnectorSignal(signal: PersonalOpsConnectorSignal, includeParameters: boolean): Record<string, unknown> {
  return {
    id: signal.id,
    kind: signal.kind,
    label: signal.label,
    status: signal.status,
    summary: previewHarnessText(signal.summary, includeParameters ? 180 : 96),
    modelRoute: previewHarnessText(signal.modelRoute, includeParameters ? 140 : 96),
    toolCount: signal.toolCount,
    ...(signal.capabilityTags.length > 0 ? { capabilityTags: signal.capabilityTags } : {}),
    ...(includeParameters && signal.readTools && signal.readTools.length > 0 ? { readTools: signal.readTools } : {}),
    ...(includeParameters && signal.writeTools && signal.writeTools.length > 0 ? { writeTools: signal.writeTools } : {}),
  };
}

export function describeWorkflow(workflow: PersonalOpsWorkflow, includeParameters: boolean): Record<string, unknown> {
  return {
    id: workflow.id,
    label: workflow.label,
    status: workflow.status,
    summary: previewHarnessText(workflow.summary, includeParameters ? 180 : 96),
    next: previewHarnessText(workflow.next, includeParameters ? 180 : 96),
    modelRoute: previewHarnessText(workflow.modelRoute, 96),
    ...(includeParameters ? {
      inspectRoutes: workflow.inspectRoutes,
      prerequisites: workflow.prerequisites,
      runBoundary: workflow.runBoundary,
    } : {}),
  };
}

export function describeLane(lane: PersonalOpsLane, includeParameters: boolean): Record<string, unknown> {
  return {
    id: lane.id,
    label: lane.label,
    status: lane.status,
    outcome: lane.outcome,
    current: lane.current,
    next: lane.next,
    userRoute: previewHarnessText(lane.userRoute, 96),
    modelRoute: previewHarnessText(lane.modelRoute, 96),
    signals: lane.signals,
    ...(lane.connectorSignals && lane.connectorSignals.length > 0 ? { connectorSignals: lane.connectorSignals.slice(0, includeParameters ? 8 : 3).map((signal) => describeConnectorSignal(signal, includeParameters)) } : {}),
    ...(lane.workflows && lane.workflows.length > 0 ? { workflows: lane.workflows.slice(0, includeParameters ? 8 : 3).map((workflow) => describeWorkflow(workflow, includeParameters)) } : {}),
    ...(lane.liveRecords && lane.liveRecords.length > 0 ? { liveRecords: lane.liveRecords.slice(0, includeParameters ? 8 : 3).map((record) => describeLiveRecord(record, includeParameters)) } : {}),
    ...(includeParameters ? {
      routes: {
        user: lane.userRoute,
        model: lane.modelRoute,
      },
      methodIds: lane.methodIds ?? [],
      safety: 'Writes, sends, schedules, and operator calls require explicit user request and confirmation through the owning tool.',
    } : {}),
  };
}

export function localRecord(domain: 'note' | 'routine', item: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>['localNotes'][number]): PersonalOpsLiveRecord {
  return {
    id: item.id,
    label: item.name,
    status: item.reviewState,
    summary: item.description,
    userRoute: domain === 'note' ? 'Agent Workspace -> Notes' : 'Agent Workspace -> Routines',
    modelRoute: `agent_local_registry domain:"${domain}" action:"get" id:"${item.id}"`,
    tags: item.tags,
  };
}

export function routineReceiptRecord(receipt: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>['latestRoutineScheduleReceipt']): PersonalOpsLiveRecord | null {
  if (!receipt) return null;
  return {
    id: receipt.id,
    label: receipt.scheduleName,
    status: receipt.status,
    summary: `${receipt.routineName} -> ${receipt.scheduleKind} ${receipt.scheduleValue}`,
    userRoute: 'Agent Workspace -> Personal Ops -> Routine library',
    modelRoute: 'autonomy action:"item" queueItemId:"routine-schedule-promotions"',
  };
}

export function channelRecords(snapshot: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>): readonly PersonalOpsLiveRecord[] {
  return snapshot.channels.map((channel) => ({
    id: channel.id,
    label: channel.label,
    status: channel.setupState,
    summary: `${channel.delivery}; ${channel.riskLabel}. ${channel.nextStep}`,
    userRoute: 'Agent Workspace -> Messaging',
    modelRoute: `channels action:"channel" channelId:"${channel.id}"`,
    tags: [channel.risk, channel.delivery],
  }));
}

export function personalOpsReadRunRoute(laneId: PersonalOpsLaneId, recordId: string): string {
  return `personal_ops action:"read" laneId:"${laneId}" recordId:"${recordId}" fields:{...} confirm:true explicitUserRequest:"..."`;
}

export function connectorReadFreshness(signal: PersonalOpsConnectorSignal, tool: PersonalOpsConnectorTool, laneId: PersonalOpsLaneId): PersonalOpsRecordFreshness | undefined {
  if (tool.effect !== 'read-only') return undefined;
  const recordId = tool.qualifiedName ?? `${signal.id}:${tool.name}`;
  return {
    status: signal.status === 'ready' ? 'fresh-provider-route-ready' : 'connector-attention',
    source: 'connector-read',
    ...(tool.qualifiedName ? { sourceTool: tool.qualifiedName } : {}),
    ...(signal.status === 'ready' ? { refreshRoute: personalOpsReadRunRoute(laneId, recordId) } : {}),
    ...(tool.requiredFields ? { requiredFields: tool.requiredFields } : {}),
    ...(tool.sampleInput ? { sampleInput: tool.sampleInput } : {}),
    policy: signal.status === 'ready'
      ? 'Reads fresh provider data only through the confirmed Personal Ops read route; provider mutations stay on separate confirmed-effect routes.'
      : 'Repair connector connection, trust, or schema freshness before reading provider data.',
  };
}

export function connectorRecords(signals: readonly PersonalOpsConnectorSignal[], laneLabel: string, laneId: PersonalOpsLaneId): readonly PersonalOpsLiveRecord[] {
  return signals.flatMap((signal) => {
    const summaryRecord: PersonalOpsLiveRecord = {
      id: signal.id,
      label: `${laneLabel} connector: ${signal.label}`,
      status: signal.status,
      summary: [
        signal.summary,
        signal.capabilityTags.length > 0 ? `capabilities ${signal.capabilityTags.join(', ')}` : '',
      ].filter(Boolean).join('; '),
      userRoute: 'Agent Workspace -> Tools & MCP',
      modelRoute: signal.modelRoute,
      tags: ['connector', signal.kind, ...signal.capabilityTags],
    };
    const operationTools = [...(signal.readTools ?? []), ...(signal.writeTools ?? [])];
    const operationRecords: PersonalOpsLiveRecord[] = operationTools
      .slice(0, 8)
      .map((tool) => {
        const freshness = connectorReadFreshness(signal, tool, laneId);
        return {
          id: tool.qualifiedName ?? `${signal.id}:${tool.name}`,
          label: `${laneLabel} ${tool.effect === 'read-only' ? 'read' : 'confirmed action'}: ${tool.name}`,
          status: signal.status,
          summary: [
            `${tool.effect === 'read-only' ? 'Read-only' : 'Write-like'} ${tool.capability} MCP route.`,
            tool.requiredFields && tool.requiredFields.length > 0 ? `required fields ${tool.requiredFields.join(', ')}` : 'schema fields unknown until inspected',
            tool.description ?? '',
          ].filter(Boolean).join(' '),
          userRoute: 'Agent Workspace -> Tools & MCP -> Server tool inventory',
          modelRoute: tool.schemaRoute ?? signal.modelRoute,
          tags: ['connector-operation', signal.kind, tool.capability, tool.effect],
          effect: tool.effect,
          capability: tool.capability,
          ...(tool.qualifiedName ? { qualifiedName: tool.qualifiedName } : {}),
          ...(tool.requiredFields ? { requiredFields: tool.requiredFields } : {}),
          ...(tool.optionalFields ? { optionalFields: tool.optionalFields } : {}),
          ...(tool.sampleInput ? { sampleInput: tool.sampleInput } : {}),
          confirmationRequired: tool.effect === 'confirmed-effect',
          ...(freshness ? { freshness } : {}),
        };
      });
    return [summaryRecord, ...operationRecords];
  });
}

export function artifactMetadata(artifact: ArtifactDescriptor): Readonly<Record<string, unknown>> {
  return artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
    ? artifact.metadata
    : {};
}

export function artifactMetadataString(artifact: ArtifactDescriptor, key: string): string {
  const value = artifactMetadata(artifact)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function artifactMetadataNumber(artifact: ArtifactDescriptor, key: string): number | null {
  const value = artifactMetadata(artifact)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function artifactMetadataStringArray(artifact: ArtifactDescriptor, key: string): readonly string[] {
  const value = artifactMetadata(artifact)[key];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => previewHarnessText(redactedPersonalOpsText(entry.trim()), 120));
  }
  if (typeof value === 'string' && value.trim()) return [previewHarnessText(redactedPersonalOpsText(value.trim()), 120)];
  return [];
}

const PERSONAL_OPS_EFFECT_RECEIPT_PURPOSES = new Set([
  'personal-ops-provider-effect-receipt',
  'personal-ops-effect-receipt',
  'personal-ops-connector-effect-receipt',
  'agent-personal-ops-effect-receipt',
  'connected-host-personal-ops-effect-receipt',
]);

export function safeRecordIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function artifactCreatedAtIso(artifact: ArtifactDescriptor): string {
  return typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt)
    ? new Date(artifact.createdAt).toISOString()
    : '';
}

function metadataCreatedAtIso(artifact: ArtifactDescriptor): string {
  const explicit = artifactMetadataString(artifact, 'createdAt')
    || artifactMetadataString(artifact, 'recordedAt')
    || artifactMetadataString(artifact, 'completedAt')
    || artifactMetadataString(artifact, 'timestamp');
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return artifactCreatedAtIso(artifact);
}

export function savedReviewArtifacts(context: CommandContext, laneId: 'inbox' | 'calendar'): readonly ArtifactDescriptor[] {
  const store = context.platform.artifactStore;
  if (!store?.list) return [];
  try {
    return store.list(100)
      .filter((artifact) => artifactMetadataString(artifact, 'purpose') === 'personal-ops-review-cards')
      .filter((artifact) => artifactMetadataString(artifact, 'laneId') === laneId)
      .sort((left, right) => {
        const leftCreated = typeof left.createdAt === 'number' ? left.createdAt : 0;
        const rightCreated = typeof right.createdAt === 'number' ? right.createdAt : 0;
        return rightCreated - leftCreated;
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}

function savedProviderEffectReceiptArtifacts(context: CommandContext, laneId: PersonalOpsEffectReceiptLaneId): readonly ArtifactDescriptor[] {
  const store = context.platform.artifactStore;
  if (!store?.list) return [];
  try {
    return store.list(100)
      .filter((artifact) => PERSONAL_OPS_EFFECT_RECEIPT_PURPOSES.has(artifactMetadataString(artifact, 'purpose')))
      .filter((artifact) => artifactMetadataString(artifact, 'laneId') === laneId)
      .sort((left, right) => {
        const leftCreated = typeof left.createdAt === 'number' ? left.createdAt : 0;
        const rightCreated = typeof right.createdAt === 'number' ? right.createdAt : 0;
        return rightCreated - leftCreated;
      })
      .slice(0, 10);
  } catch {
    return [];
  }
}

function normalizedEffectReceiptStatus(artifact: ArtifactDescriptor): string {
  const raw = (artifactMetadataString(artifact, 'status')
    || artifactMetadataString(artifact, 'outcome')
    || artifactMetadataString(artifact, 'result')).toLowerCase();
  if (!raw) return 'unknown';
  if (['ok', 'ready', 'success', 'succeeded', 'complete', 'completed', 'sent', 'archived', 'labeled', 'updated', 'accepted', 'declined'].includes(raw)) return 'succeeded';
  if (['blocked', 'needs-review', 'needs_setup', 'needs-setup'].includes(raw)) return 'blocked';
  if (['fail', 'failed', 'error', 'errored'].includes(raw)) return 'failed';
  if (['running', 'pending', 'in-progress', 'in_progress'].includes(raw)) return 'running';
  return raw;
}

function providerEffectSubjectId(artifact: ArtifactDescriptor): string {
  return artifactMetadataString(artifact, 'subjectId')
    || artifactMetadataString(artifact, 'threadId')
    || artifactMetadataString(artifact, 'messageId')
    || artifactMetadataString(artifact, 'eventId')
    || artifactMetadataString(artifact, 'taskId')
    || artifactMetadataString(artifact, 'reminderId')
    || artifactMetadataString(artifact, 'scheduleId')
    || artifactMetadataString(artifact, 'providerRecordId')
    || artifactMetadataString(artifact, 'targetId');
}

function effectReceiptLaneLabel(laneId: PersonalOpsEffectReceiptLaneId): string {
  if (laneId === 'inbox') return 'Inbox';
  if (laneId === 'calendar') return 'Calendar';
  if (laneId === 'tasks') return 'Task';
  return 'Reminder';
}

function effectReceiptCapability(laneId: PersonalOpsEffectReceiptLaneId): string {
  if (laneId === 'inbox') return 'inbox-effect-receipt';
  if (laneId === 'calendar') return 'calendar-effect-receipt';
  if (laneId === 'tasks') return 'task-effect-receipt';
  return 'reminder-effect-receipt';
}

export function savedProviderEffectReceiptRecords(
  context: CommandContext,
  laneId: PersonalOpsEffectReceiptLaneId,
): readonly PersonalOpsLiveRecord[] {
  return savedProviderEffectReceiptArtifacts(context, laneId).map((artifact) => {
    const laneLabel = effectReceiptLaneLabel(laneId);
    const lowerLaneLabel = laneLabel.toLowerCase();
    const providerId = artifactMetadataString(artifact, 'providerId') || artifactMetadataString(artifact, 'provider') || 'provider';
    const operation = artifactMetadataString(artifact, 'operation') || artifactMetadataString(artifact, 'action') || `${laneId}-effect`;
    const status = normalizedEffectReceiptStatus(artifact);
    const sourceTool = artifactMetadataString(artifact, 'sourceTool') || artifactMetadataString(artifact, 'qualifiedName');
    const subjectId = providerEffectSubjectId(artifact);
    const receiptId = artifactMetadataString(artifact, 'receiptId') || artifact.id;
    const createdAt = metadataCreatedAtIso(artifact);
    const failureReason = artifactMetadataString(artifact, 'failureReason') || artifactMetadataString(artifact, 'error');
    const redaction = artifactMetadataString(artifact, 'redaction') || artifactMetadataString(artifact, 'redactionPolicy') || 'metadata-only';
    const nextRoute = artifactMetadataString(artifact, 'nextRoute')
      || `personal_ops action:"lane" laneId:"${laneId}" includeParameters:true`;
    const artifactRoute = `agent_artifacts show artifactId:"${artifact.id}" includeContent:false`;
    const operationLabel = operation.replace(/[-_]+/g, ' ');
    const certification = personalOpsRecordCertification({
      record: artifactMetadata(artifact),
      sourcePath: sourceTool || artifactRoute,
      durableId: subjectId || receiptId,
      recordKind: `${lowerLaneLabel} provider-effect receipt`,
      hasConfirmedEffectRoute: true,
      requireReceipt: true,
    });
    return {
      id: `provider-effect-receipt:${artifact.id}`,
      label: `${laneLabel} effect receipt: ${operationLabel}`,
      status,
      summary: [
        `Confirmed ${lowerLaneLabel} provider-effect receipt ${receiptId} reports ${operation} ${status}.`,
        providerId ? `Provider ${providerId}.` : '',
        subjectId ? `Subject ${previewHarnessText(redactedPersonalOpsText(subjectId), 96)}.` : '',
        `Redaction ${redaction}.`,
        failureReason ? `Failure ${previewHarnessText(redactedPersonalOpsText(failureReason), 140)}.` : '',
        sourceTool ? `Source ${sourceTool}.` : '',
        createdAt ? `Recorded ${createdAt}.` : '',
      ].filter(Boolean).join(' '),
      userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
      modelRoute: artifactRoute,
      tags: [
        'provider-effect-receipt',
        'artifact',
        `${laneId}-effect`,
        operation,
        status,
        providerId,
      ].filter(Boolean),
      effect: 'read-only',
      capability: effectReceiptCapability(laneId),
      confirmationRequired: false,
      artifactId: artifact.id,
      ...(sourceTool ? { sourceTool } : {}),
      certification,
      followUpRoutes: [
        {
          id: 'inspect-effect-receipt',
          label: 'Inspect provider-effect receipt',
          effect: 'read-only',
          modelRoute: artifactRoute,
          requiresConfirmation: false,
          policy: 'Receipt inspection is read-only and uses redacted artifact metadata/content boundaries.',
        },
        {
          id: 'continue-provider-lane',
          label: `Continue ${lowerLaneLabel} lane review`,
          effect: 'read-only',
          modelRoute: nextRoute,
          requiresConfirmation: false,
          policy: 'Use the lane posture to decide whether a fresh connector read or separate confirmed provider effect is appropriate.',
        },
      ],
    };
  });
}

export function matchingReadTool(
  connectors: readonly PersonalOpsConnectorSignal[],
  sourceTool: string,
): { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool } | null {
  if (!sourceTool) return null;
  for (const signal of connectors) {
    const tool = (signal.readTools ?? []).find((entry) => entry.qualifiedName === sourceTool || entry.name === sourceTool);
    if (tool) return { signal, tool };
  }
  return null;
}

export function savedReviewFreshness(options: {
  readonly laneId: 'inbox' | 'calendar';
  readonly createdAt: string;
  readonly sourceTool: string;
  readonly connectors: readonly PersonalOpsConnectorSignal[];
}): PersonalOpsRecordFreshness {
  const match = matchingReadTool(options.connectors, options.sourceTool);
  if (!options.sourceTool) {
    return {
      status: 'source-tool-missing',
      source: 'saved-review-artifact',
      ...(options.createdAt ? { lastReviewedAt: options.createdAt } : {}),
      policy: 'This saved review artifact did not preserve a connector source tool, so Agent can only reopen the redacted artifact and cannot offer a precise refresh route.',
    };
  }
  if (!match) {
    return {
      status: 'provider-contract-missing',
      source: 'saved-review-artifact',
      sourceTool: options.sourceTool,
      ...(options.createdAt ? { lastReviewedAt: options.createdAt } : {}),
      policy: 'The saved review names a source tool, but the current runtime does not expose a matching read-only connector route. Reconnect or repair the provider before refreshing.',
    };
  }
  return {
    status: match.signal.status === 'ready' ? 'saved-review-refreshable' : 'connector-attention',
    source: 'saved-review-artifact',
    sourceTool: options.sourceTool,
    ...(options.createdAt ? { lastReviewedAt: options.createdAt } : {}),
    ...(match.signal.status === 'ready' ? { refreshRoute: personalOpsReadRunRoute(options.laneId, options.sourceTool) } : {}),
    ...(match.tool.requiredFields ? { requiredFields: match.tool.requiredFields } : {}),
    ...(match.tool.sampleInput ? { sampleInput: match.tool.sampleInput } : {}),
    policy: match.signal.status === 'ready'
      ? 'Saved review data is stale by default. Refresh requires the user to supply current connector fields and confirm the read; saved artifacts do not store raw prior input values.'
      : 'A matching connector route exists, but it needs connection, trust, or schema freshness repair before refreshing saved review data.',
  };
}

export function refreshableSavedRecordCount(records: readonly PersonalOpsLiveRecord[]): number {
  return records.filter((record) => record.freshness?.status === 'saved-review-refreshable').length;
}

export function savedReviewQueueRecords(
  context: CommandContext,
  laneId: 'inbox' | 'calendar',
  connectors: readonly PersonalOpsConnectorSignal[],
): readonly PersonalOpsLiveRecord[] {
  return savedReviewArtifacts(context, laneId)
    .flatMap((artifact) => {
      const reviewLabels = artifactMetadataStringArray(artifact, 'reviewLabels').slice(0, 5);
      const reviewRecordIds = artifactMetadataStringArray(artifact, 'reviewRecordIds').slice(0, reviewLabels.length);
      const sourceTool = artifactMetadataString(artifact, 'sourceTool') || artifactMetadataString(artifact, 'sourceRecordId');
      const createdAt = typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt)
        ? new Date(artifact.createdAt).toISOString()
        : '';
      const freshness = savedReviewFreshness({ laneId, createdAt, sourceTool, connectors });
      return reviewLabels.map((label, index): PersonalOpsLiveRecord => {
        const recordId = reviewRecordIds[index] || label || `${index + 1}`;
        const artifactRoute = `agent_artifacts show artifactId:"${artifact.id}" includeContent:true`;
        const calendar = laneId === 'calendar';
        return {
          id: `${calendar ? 'review-event' : 'review-thread'}:${artifact.id}:${safeRecordIdPart(recordId)}`,
          label: `${calendar ? 'Saved event' : 'Saved thread'}: ${label}`,
          status: calendar ? 'ready-for-reminder' : 'ready-for-draft',
          summary: [
            `Derived from saved redacted ${calendar ? 'calendar' : 'inbox'} review artifact ${artifact.id}.`,
            sourceTool ? `Source ${sourceTool}.` : '',
            createdAt ? `Saved ${createdAt}.` : '',
            calendar
              ? 'Inspect the artifact before creating reminders or proposing calendar edits.'
              : 'Inspect the artifact before drafting; sending remains a separate confirmed connector action.',
          ].filter(Boolean).join(' '),
          userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
          modelRoute: artifactRoute,
          tags: [
            'saved-review',
            'artifact',
            calendar ? 'calendar-event' : 'inbox-thread',
            calendar ? 'reminder-ready' : 'draft-ready',
          ],
          effect: 'read-only',
          capability: calendar ? 'calendar-event-review' : 'inbox-thread-review',
          confirmationRequired: false,
          artifactId: artifact.id,
          reviewRecordCount: 1,
          reviewLabels: [label],
          ...(sourceTool ? { sourceTool } : {}),
          freshness,
          followUpRoutes: calendar
            ? [
              ...(freshness.refreshRoute ? [{
                id: 'refresh-saved-event',
                label: 'Refresh saved event from provider',
                effect: 'read-only' as const,
                modelRoute: freshness.refreshRoute,
                requiresConfirmation: true,
                policy: 'Refresh reads current provider data only after the user supplies required fields and confirms the bounded read.',
              }] : []),
              {
                id: 'create-reminder-from-event',
                label: 'Create reminder from saved event',
                effect: 'confirmed-effect',
                modelRoute: 'schedule action:"remind" message:"..." at:"..." confirm:true explicitUserRequest:"..."',
                requiresConfirmation: true,
                policy: 'Create one reminder only after the user reviews the saved event and confirms exact timing.',
              },
              {
                id: 'calendar-edit-boundary',
                label: 'Inspect calendar edit route',
                effect: 'confirmed-effect',
                modelRoute: 'personal_ops action:"intake" query:"edit saved calendar event" includeParameters:true',
                requiresConfirmation: true,
                policy: 'Calendar edits, RSVP, reschedule, and deletes require a separate inspected connector route and explicit confirmation.',
              },
            ]
            : [
              ...(freshness.refreshRoute ? [{
                id: 'refresh-saved-thread',
                label: 'Refresh saved thread from provider',
                effect: 'read-only' as const,
                modelRoute: freshness.refreshRoute,
                requiresConfirmation: true,
                policy: 'Refresh reads current provider data only after the user supplies required fields and confirms the bounded read.',
              }] : []),
              {
                id: 'draft-local-reply',
                label: 'Draft local reply from saved thread',
                effect: 'read-only',
                modelRoute: artifactRoute,
                requiresConfirmation: false,
                policy: 'Drafting stays local in the Agent transcript and does not send, label, archive, move, or delete provider records.',
              },
              {
                id: 'send-reviewed-reply-boundary',
                label: 'Inspect send route for reviewed reply',
                effect: 'confirmed-effect',
                modelRoute: 'personal_ops action:"intake" query:"send reviewed reply from saved inbox review" includeParameters:true',
                requiresConfirmation: true,
                policy: 'Send only after a write-like inbox connector route is inspected and the user confirms exact recipients and body.',
              },
            ],
        };
      });
    })
    .slice(0, 10);
}

export function savedReviewArtifactRecords(
  context: CommandContext,
  laneId: 'inbox' | 'calendar',
  connectors: readonly PersonalOpsConnectorSignal[],
): readonly PersonalOpsLiveRecord[] {
  return savedReviewArtifacts(context, laneId).map((artifact) => {
    const reviewRecordCount = artifactMetadataNumber(artifact, 'reviewRecordCount') ?? 0;
    const reviewLabels = artifactMetadataStringArray(artifact, 'reviewLabels').slice(0, 5);
    const sourceTool = artifactMetadataString(artifact, 'sourceTool') || artifactMetadataString(artifact, 'sourceRecordId');
    const createdAt = typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt)
      ? new Date(artifact.createdAt).toISOString()
      : '';
    const freshness = savedReviewFreshness({ laneId, createdAt, sourceTool, connectors });
    const countText = reviewRecordCount > 0
      ? `${reviewRecordCount} normalized review card${reviewRecordCount === 1 ? '' : 's'}`
      : 'normalized review cards';
    return {
      id: `review-artifact:${artifact.id}`,
      label: `${laneId === 'calendar' ? 'Saved agenda review' : 'Saved inbox review'}: ${artifact.filename ?? artifact.id}`,
      status: 'ready',
      summary: [
        `${countText} saved for later review.`,
        reviewLabels.length > 0 ? `Items ${reviewLabels.slice(0, 3).join('; ')}.` : '',
        sourceTool ? `Source ${sourceTool}.` : '',
        createdAt ? `Saved ${createdAt}.` : '',
        'Use the artifact route to reopen redacted cards before summary, draft, or promotion work.',
      ].filter(Boolean).join(' '),
      userRoute: 'Agent Workspace -> Documents & Files -> Browse artifacts',
      modelRoute: `agent_artifacts show artifactId:"${artifact.id}" includeContent:true`,
      tags: ['saved-review', 'artifact', laneId === 'calendar' ? 'calendar-read' : 'inbox-read'],
      effect: 'read-only',
      capability: laneId === 'calendar' ? 'calendar-review-artifact' : 'inbox-review-artifact',
      confirmationRequired: false,
      artifactId: artifact.id,
      reviewRecordCount,
      ...(reviewLabels.length > 0 ? { reviewLabels } : {}),
      ...(sourceTool ? { sourceTool } : {}),
      freshness,
    };
  });
}

export { reminderOperationRecords, taskOperationRecords } from './agent-harness-personal-ops-operations.ts';
