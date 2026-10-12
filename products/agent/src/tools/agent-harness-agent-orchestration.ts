import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { capturePersonalOpsData, capturePersonalOpsSnapshot, assertPersonalOpsDataCurrent, protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { judgmentInputCardProblem, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { captureRedactionSource, containsIssuerCredential } from '@goodvibes-jev/engine/sdk/platform/utils';
import { modelReadingServicePath, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { captureNativeReadModelObservation } from './agent-harness-autonomy-live-records.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { WorkPlanItem } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { AGENT_TEMPLATES, AGENT_TOOL_MODES, agentOrchestrationDecisionCards } from './agent-harness-agent-orchestration-policy.ts';
import { remoteReadModelSnapshot, captureNativeRemoteReadModelSnapshot, settleNativeRemotePublisherSemantics, currentNativeRemoteReadModelSnapshot, bindNativeRemoteWorkspaceDisplays, assertNativeRemoteWorkspaceDisplaysCurrent, projectNativeRemoteWorkspaceDisplayReferences, captureNativeRemoteWorkspacePathSource, projectNativeRemoteWorkspacePathSource, type RemoteCaptureOutcomeRecord, type RemoteWorkspaceEvidenceRecord } from './agent-harness-remote-read-models.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { projectSetupSmokeEvidenceFull } from './agent-harness-setup-smoke.ts';

interface AgentHarnessAgentOrchestrationArgs {
  readonly agentId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentLookupSource = 'agentId' | 'target' | 'query';
type AgentRecordView = Record<string, unknown>;
type ManagedPlanStatus = 'ready' | 'active' | 'attention' | 'needs-setup';

interface RemoteRuntimeSnapshot {
  readonly pools: readonly Record<string, unknown>[];
  readonly contracts: readonly Record<string, unknown>[];
  readonly artifacts: readonly Record<string, unknown>[];
  readonly outcomes: readonly RemoteCaptureOutcomeRecord[];
  readonly workspaces: readonly RemoteWorkspaceEvidenceRecord[];
  readonly sourceCounts: Readonly<Record<string, number>>;
}

export type AgentOrchestrationResolution =
  | { readonly status: 'found'; readonly agent: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const REMOTE_ARTIFACT_RECEIPT_PURPOSES = new Set([
  'remote-runner-artifact-receipt',
  'remote-runner-closeout-receipt',
  'remote-runner-export-receipt',
  'agent-remote-runner-artifact-receipt',
  'agent-remote-runner-closeout-receipt',
  'connected-host-remote-runner-artifact-receipt',
  'connected-host-remote-runner-closeout-receipt',
]);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function artifactMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return readObject(record.metadata);
}

function metadataString(record: Record<string, unknown>, key: string): string {
  return readString(artifactMetadata(record)[key]);
}

function recordOrMetadataString(record: Record<string, unknown>, key: string): string {
  return readString(record[key]) || metadataString(record, key);
}

function recordOrMetadataNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key] ?? artifactMetadata(record)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function artifactPurpose(record: Record<string, unknown>): string {
  return metadataString(record, 'purpose');
}

function isRemoteArtifactReceipt(record: Record<string, unknown>): boolean {
  return REMOTE_ARTIFACT_RECEIPT_PURPOSES.has(artifactPurpose(record));
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function lookupFromArgs(args: AgentHarnessAgentOrchestrationArgs): { readonly source: AgentLookupSource; readonly input: string } | null {
  const agentId = readString(args.agentId);
  if (agentId) return { source: 'agentId', input: agentId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function exportAgents(context: CommandContext): readonly AgentRecordView[] | null {
  const agentManager = context.ops.agentManager;
  if (!agentManager) return null;
  try {
    return agentManager.exportState().map((record) => record as unknown as AgentRecordView);
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function remoteContracts(context: CommandContext): readonly Record<string, unknown>[] {
  try {
    return context.ops.remoteRuntime?.listContracts().map((record) => record as unknown as Record<string, unknown>) ?? [];
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function remotePools(context: CommandContext): readonly Record<string, unknown>[] {
  try {
    return context.ops.remoteRuntime?.listPools().map((record) => record as unknown as Record<string, unknown>) ?? [];
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function remoteRuntimeArtifacts(context: CommandContext): readonly Record<string, unknown>[] {
  try {
    return context.ops.remoteRuntime?.listArtifacts().map((record) => record as unknown as Record<string, unknown>) ?? [];
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function artifactCreatedAt(artifact: ArtifactDescriptor): number {
  return typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt) ? artifact.createdAt : 0;
}

function remoteReceiptArtifacts(context: CommandContext): readonly Record<string, unknown>[] {
  const store = context.platform.artifactStore;
  if (!store?.list) return [];
  try {
    return store.list(100)
      .filter((artifact) => isRemoteArtifactReceipt(artifact as unknown as Record<string, unknown>))
      .filter((artifact) => remoteRunnerId(artifact as unknown as Record<string, unknown>))
      .sort((left, right) => artifactCreatedAt(right) - artifactCreatedAt(left))
      .slice(0, 20)
      .map((artifact) => artifact as unknown as Record<string, unknown>);
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function remoteArtifacts(context: CommandContext): readonly Record<string, unknown>[] {
  const runtimeArtifacts = remoteRuntimeArtifacts(context);
  const seen = new Set(runtimeArtifacts.map((artifact) => readString(artifact.id)).filter(Boolean));
  const receiptArtifacts = remoteReceiptArtifacts(context).filter((artifact) => {
    const id = readString(artifact.id);
    return !id || !seen.has(id);
  });
  return [...runtimeArtifacts, ...receiptArtifacts];
}

const orchestrationWorkspaceDisplays = new WeakMap<object, object>();

type OrchestrationRemoteSource =
  | { readonly kind: 'native'; readonly snapshot: ReturnType<typeof remoteReadModelSnapshot>; readonly token: object }
  | { readonly kind: 'current'; readonly token: object };

function remoteRuntimeSnapshot(context: CommandContext, source?: OrchestrationRemoteSource): RemoteRuntimeSnapshot {
  const readModels = source?.kind === 'native' ? source.snapshot
    : source?.kind === 'current' ? currentNativeRemoteReadModelSnapshot(context, source.token)
    : remoteReadModelSnapshot(context);
  const result: RemoteRuntimeSnapshot = {
    pools: remotePools(context),
    contracts: remoteContracts(context),
    artifacts: remoteArtifacts(context),
    outcomes: readModels.outcomes,
    workspaces: readModels.workspaces,
    sourceCounts: readModels.sourceCounts,
  };
  if (source?.kind === 'native') orchestrationWorkspaceDisplays.set(result, source.token);
  return result;
}

function agentToolRegistered(toolRegistry: ToolRegistry): boolean {
  return toolRegistry.getToolDefinitions().some((tool) => tool.name === 'agent');
}

function remoteToolRegistered(toolRegistry: ToolRegistry): boolean {
  return toolRegistry.getToolDefinitions().some((tool) => tool.name === 'remote');
}

function agentId(record: AgentRecordView): string {
  return readString(record.id);
}

function agentStatus(record: AgentRecordView): string {
  return readString(record.status) || 'unknown';
}

function agentSearchText(record: AgentRecordView): string {
  return [
    record.id,
    record.task,
    record.template,
    record.status,
    record.progress,
    record.model,
    record.provider,
    Array.isArray(record.tools) ? record.tools.join('\n') : '',
    record.context,
  ].map((value) => typeof value === 'string' ? value : String(value ?? '')).join('\n');
}

function statusCounts(records: readonly AgentRecordView[]): Record<string, number> {
  const counts: Record<string, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
  };
  for (const record of records) {
    const status = agentStatus(record);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function routeForAgent(mode: string, id: string): string {
  return `agent { mode: "${mode}", agentId: "${id}" }`;
}

function remoteRunnerId(record: Record<string, unknown>): string {
  return recordOrMetadataString(record, 'runnerId')
    || recordOrMetadataString(record, 'agentId')
    || recordOrMetadataString(record, 'linkedAgentId')
    || recordOrMetadataString(record, 'runner');
}

function transportState(contract: Record<string, unknown>): string {
  const transport = contract.transport;
  return transport && typeof transport === 'object' ? readString((transport as Record<string, unknown>).state) || 'unknown' : 'unknown';
}

function capabilityCeiling(contract: Record<string, unknown>): Record<string, unknown> {
  const ceiling = contract.capabilityCeiling;
  return ceiling && typeof ceiling === 'object' ? ceiling as Record<string, unknown> : {};
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function contractSummary(contract: Record<string, unknown>, includeParameters: boolean): Record<string, unknown> {
  const ceiling = capabilityCeiling(contract);
  return {
    id: readString(contract.id),
    runnerId: remoteRunnerId(contract),
    poolId: readString(contract.poolId) || null,
    label: previewHarnessText(readString(contract.label) || remoteRunnerId(contract), includeParameters ? 120 : 72),
    sourceTransport: readString(contract.sourceTransport) || 'unknown',
    trustClass: readString(contract.trustClass) || 'unknown',
    template: readString(contract.template) || 'general',
    transportState: transportState(contract),
    allowedTools: stringArray(ceiling.allowedTools).slice(0, includeParameters ? 20 : 8),
    capabilityCeilingTools: stringArray(ceiling.capabilityCeilingTools).slice(0, includeParameters ? 20 : 8),
    executionProtocol: readString(ceiling.executionProtocol) || 'unknown',
    reviewMode: readString(ceiling.reviewMode) || 'unknown',
    communicationLane: readString(ceiling.communicationLane) || 'unknown',
    orchestrationDepth: typeof ceiling.orchestrationDepth === 'number' ? ceiling.orchestrationDepth : null,
    requiredEvidence: stringArray(ceiling.requiredEvidence).slice(0, includeParameters ? 12 : 5),
    successCriteria: stringArray(ceiling.successCriteria).slice(0, includeParameters ? 12 : 5),
    writeScope: stringArray(ceiling.writeScope).slice(0, includeParameters ? 12 : 5),
  };
}

function artifactSummary(artifact: Record<string, unknown>, includeParameters: boolean): Record<string, unknown> {
  const metadata = artifactMetadata(artifact);
  const task = readObject(artifact.task);
  const evidence = readObject(artifact.evidence);
  const receipt = isRemoteArtifactReceipt(artifact);
  const id = readString(artifact.id);
  const status = readString(task.status)
    || metadataString(artifact, 'status')
    || metadataString(artifact, 'outcome')
    || 'unknown';
  const taskText = readString(task.task)
    || metadataString(artifact, 'task')
    || metadataString(artifact, 'title');
  const summary = readString(task.summary)
    || metadataString(artifact, 'summary')
    || metadataString(artifact, 'description');
  const sourceArtifactId = metadataString(artifact, 'sourceArtifactId')
    || metadataString(artifact, 'remoteArtifactId')
    || metadataString(artifact, 'exportArtifactId');
  return {
    id,
    runnerId: remoteRunnerId(artifact),
    status,
    task: previewHarnessText(taskText, includeParameters ? 160 : 72),
    summary: previewHarnessText(summary, includeParameters ? 220 : 96),
    toolCallCount: typeof evidence.toolCallCount === 'number' ? evidence.toolCallCount : recordOrMetadataNumber(artifact, 'toolCallCount'),
    messageCount: typeof evidence.messageCount === 'number' ? evidence.messageCount : recordOrMetadataNumber(artifact, 'messageCount'),
    errorCount: typeof evidence.errorCount === 'number' ? evidence.errorCount : recordOrMetadataNumber(artifact, 'errorCount'),
    hasKnowledgeInjections: Boolean(evidence.hasKnowledgeInjections ?? metadata.hasKnowledgeInjections),
    modelRoute: artifactReviewRoute(artifact),
    ...(receipt ? {
      receipt: true,
      purpose: artifactPurpose(artifact),
      sourceArtifactId: sourceArtifactId || null,
      redaction: metadataString(artifact, 'redaction') || metadataString(artifact, 'redactionPolicy') || 'metadata-only',
    } : {}),
  };
}

function artifactReviewRoute(artifact: Record<string, unknown>): string {
  const id = readString(artifact.id);
  return isRemoteArtifactReceipt(artifact)
    ? `agent_artifacts show artifactId:"${id}" includeContent:false`
    : `remote { mode: "review", artifactId: "${id}" }`;
}

function agentRoutes(id: string): Record<string, string> {
  return {
    inspect: routeForAgent('get', id),
    status: routeForAgent('status', id),
    budget: routeForAgent('budget', id),
    plan: routeForAgent('plan', id),
    wait: routeForAgent('wait', id),
    message: routeForAgent('message', id),
    cancel: routeForAgent('cancel', id),
  };
}

function contractByRunnerId(contracts: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const entries: Array<readonly [string, Record<string, unknown>]> = [];
  for (const contract of contracts) {
    const id = remoteRunnerId(contract);
    if (id) entries.push([id, contract]);
  }
  return new Map(entries);
}

function artifactsByRunnerId(artifacts: readonly Record<string, unknown>[]): Map<string, readonly Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const artifact of artifacts) {
    const id = remoteRunnerId(artifact);
    if (!id) continue;
    const entries = grouped.get(id) ?? [];
    entries.push(artifact);
    grouped.set(id, entries);
  }
  return grouped;
}

function outcomesByRunnerId(outcomes: readonly RemoteCaptureOutcomeRecord[]): Map<string, readonly RemoteCaptureOutcomeRecord[]> {
  const grouped = new Map<string, RemoteCaptureOutcomeRecord[]>();
  for (const outcome of outcomes) {
    const entries = grouped.get(outcome.runnerId) ?? [];
    entries.push(outcome);
    grouped.set(outcome.runnerId, entries);
  }
  return grouped;
}

function workspacesByRunnerId(workspaces: readonly RemoteWorkspaceEvidenceRecord[]): Map<string, readonly RemoteWorkspaceEvidenceRecord[]> {
  const grouped = new Map<string, RemoteWorkspaceEvidenceRecord[]>();
  for (const workspace of workspaces) {
    const entries = grouped.get(workspace.runnerId) ?? [];
    entries.push(workspace);
    grouped.set(workspace.runnerId, entries);
  }
  return grouped;
}

function workPlanItems(context: CommandContext): readonly WorkPlanItem[] {
  try {
    return context.workspace.workPlanStore?.listItems() ?? [];
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function workPlanItemsByAgentId(items: readonly WorkPlanItem[]): Map<string, readonly WorkPlanItem[]> {
  const grouped = new Map<string, WorkPlanItem[]>();
  for (const item of items) {
    const id = item.linked?.agentId;
    if (!id) continue;
    const entries = grouped.get(id) ?? [];
    entries.push(item);
    grouped.set(id, entries);
  }
  return grouped;
}

function dispatchReceiptLines(item: WorkPlanItem): readonly string[] {
  return readString(item.notes)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('Agent dispatch receipt'));
}

function workPlanCloseoutItem(item: WorkPlanItem, includeParameters: boolean): Record<string, unknown> {
  const receipts = dispatchReceiptLines(item);
  return {
    itemId: item.id,
    title: previewHarnessText(item.title, includeParameters ? 160 : 72),
    status: item.status,
    owner: item.owner ?? null,
    source: item.source ?? null,
    dispatchReceiptCount: receipts.length,
    latestDispatchReceipt: receipts.at(-1) ? previewHarnessText(receipts.at(-1)!, includeParameters ? 260 : 120) : null,
    routes: {
      inspect: `agent_work_plan action:"get" id:"${item.id}"`,
      markDone: `agent_work_plan action:"set_status" id:"${item.id}" status:"done"`,
      markBlocked: `agent_work_plan action:"set_status" id:"${item.id}" status:"blocked"`,
    },
  };
}

function closeoutReviewRoutes(id: string, items: readonly WorkPlanItem[], artifacts: readonly Record<string, unknown>[], outcomes: readonly RemoteCaptureOutcomeRecord[] = [], workspaces: readonly RemoteWorkspaceEvidenceRecord[] = []): readonly string[] {
  return [
    routeForAgent('get', id),
    ...items.map((item) => `agent_work_plan action:"get" id:"${item.id}"`),
    ...artifacts.map((artifact) => artifactReviewRoute(artifact)),
    ...outcomes.map((outcome) => outcome.modelRoute),
    ...workspaces.map((workspace) => workspace.modelRoute),
  ];
}

function closeoutStatus(status: string, items: readonly WorkPlanItem[], artifacts: readonly Record<string, unknown>[], outcomes: readonly RemoteCaptureOutcomeRecord[] = []): string {
  if (['pending', 'running'].includes(status)) return 'pending-work';
  if (status === 'failed') return 'attention';
  if (items.some((item) => item.status === 'blocked' || item.status === 'failed')) return 'attention';
  if (artifacts.length > 0 || outcomes.length > 0) return 'evidence-ready';
  if (items.length > 0) return 'needs-artifact-evidence';
  return 'unlinked';
}

function closeoutCard(id: string, status: string, items: readonly WorkPlanItem[], artifacts: readonly Record<string, unknown>[], outcomes: readonly RemoteCaptureOutcomeRecord[], workspaces: readonly RemoteWorkspaceEvidenceRecord[], includeParameters: boolean): Record<string, unknown> {
  const hasReadModelEvidence = outcomes.length > 0 || workspaces.length > 0;
  return {
    status: closeoutStatus(status, items, artifacts, outcomes),
    workPlanItemCount: items.length,
    dispatchReceiptCount: items.reduce((count, item) => count + dispatchReceiptLines(item).length, 0),
    remoteArtifactCount: artifacts.length,
    remoteReceiptCount: artifacts.filter((artifact) => isRemoteArtifactReceipt(artifact)).length,
    remoteOutcomeCount: outcomes.length,
    workspaceEvidenceCount: workspaces.length,
    autoAttachReason: artifacts.length > 0
      ? 'remote artifact or durable receipt runnerId matched the visible agent id'
      : hasReadModelEvidence
        ? 'daemon/SDK remote read-model runnerId matched the visible agent id'
        : null,
    workPlanItems: items.slice(0, includeParameters ? 8 : 3).map((item) => workPlanCloseoutItem(item, includeParameters)),
    autoAttachedRemoteArtifacts: artifacts.slice(0, includeParameters ? 8 : 3).map((artifact) => artifactSummary(artifact, includeParameters)),
    liveRemoteOutcomes: outcomes.slice(0, includeParameters ? 8 : 3),
    workspaceEvidence: workspaces.slice(0, includeParameters ? 8 : 3),
    reviewRoutes: closeoutReviewRoutes(id, items, artifacts, outcomes, workspaces).slice(0, includeParameters ? 24 : 8),
    updateRoutes: items.slice(0, includeParameters ? 8 : 3).flatMap((item) => [
      `agent_work_plan action:"set_status" id:"${item.id}" status:"done"`,
      `agent_work_plan action:"set_status" id:"${item.id}" status:"blocked"`,
    ]),
    policy: 'Closeout is read-only here; status changes stay on agent_work_plan and artifact review stays on first-class routes.',
  };
}

function managedPlanItem(
  record: AgentRecordView,
  contract: Record<string, unknown> | undefined,
  artifacts: readonly Record<string, unknown>[],
  outcomes: readonly RemoteCaptureOutcomeRecord[],
  workspaces: readonly RemoteWorkspaceEvidenceRecord[],
  linkedWorkItems: readonly WorkPlanItem[],
  includeParameters: boolean,
): Record<string, unknown> {
  const id = agentId(record);
  const status = agentStatus(record);
  const task = readString(record.task);
  const progress = readString(record.progress);
  const hasRemoteContract = Boolean(contract);
  const hasLiveRemoteEvidence = hasRemoteContract || outcomes.length > 0 || workspaces.length > 0;
  const running = ['pending', 'running'].includes(status);
  const failed = status === 'failed';
  const hasOutcomeEvidence = artifacts.length > 0 || outcomes.length > 0;
  return {
    planItemId: `agent:${id}`,
    agentId: id,
    lane: hasLiveRemoteEvidence ? 'remote-runner' : 'visible-agent',
    milestoneId: running ? 'visible-agent-work' : 'review-and-closeout',
    status,
    title: previewHarnessText(task || id, includeParameters ? 160 : 72),
    progress: progress ? previewHarnessText(progress, includeParameters ? 180 : 72) : null,
    template: readString(record.template) || 'general',
    toolCallCount: typeof record.toolCallCount === 'number' ? record.toolCallCount : 0,
    routes: agentRoutes(id),
    workPlanLinks: linkedWorkItems.slice(0, includeParameters ? 8 : 3).map((item) => workPlanCloseoutItem(item, includeParameters)),
    remoteContract: contract ? contractSummary(contract, includeParameters) : null,
    artifactTrail: artifacts.slice(0, includeParameters ? 8 : 3).map((artifact) => artifactSummary(artifact, includeParameters)),
    liveOutcomeTrail: outcomes.slice(0, includeParameters ? 8 : 3),
    workspaceEvidence: workspaces.slice(0, includeParameters ? 8 : 3),
    closeout: closeoutCard(id, status, linkedWorkItems, artifacts, outcomes, workspaces, includeParameters),
    reviewGate: {
      status: failed ? 'attention' : running ? 'pending-work' : hasOutcomeEvidence ? 'artifact-ready' : workspaces.length > 0 ? 'workspace-evidence-ready' : linkedWorkItems.length > 0 ? 'needs-artifact-evidence' : 'needs-link',
      requiredEvidence: [
        ...(contract ? stringArray(capabilityCeiling(contract).requiredEvidence).slice(0, includeParameters ? 12 : 5) : []),
        ...(workspaces.length > 0 ? ['workspace/worktree isolation evidence'] : []),
        ...(outcomes.length > 0 ? ['live remote capture/export outcome evidence'] : []),
      ],
      modelRoutes: closeoutReviewRoutes(id, linkedWorkItems, artifacts, outcomes, workspaces).slice(0, includeParameters ? 24 : 8),
    },
    nextAction: failed
      ? 'Inspect the failed agent, then decide whether to message, retry through a new visible task, or cancel related work.'
      : running
        ? 'Use wait/status for progress, message for guidance, or cancel if the work no longer helps the user.'
        : hasOutcomeEvidence
          ? 'Review the artifact trail before closing the plan.'
          : workspaces.length > 0
            ? 'Confirm the workspace isolation evidence, then attach outcome evidence before closing the plan.'
          : 'Capture or attach outcome evidence before treating this work as complete.',
  };
}

function managedPlanStatus(records: readonly AgentRecordView[], agentToolAvailable: boolean): ManagedPlanStatus {
  if (records.some((record) => agentStatus(record) === 'failed')) return 'attention';
  if (records.some((record) => ['pending', 'running'].includes(agentStatus(record)))) return 'active';
  if (records.length > 0 || agentToolAvailable) return 'ready';
  return 'needs-setup';
}

function managedExecutionPlan(
  records: readonly AgentRecordView[],
  context: CommandContext,
  toolRegistry: ToolRegistry,
  remoteSnapshot: RemoteRuntimeSnapshot,
  includeParameters: boolean,
  workItems: readonly WorkPlanItem[],
): Record<string, unknown> {
  const agentToolAvailable = agentToolRegistered(toolRegistry);
  const remoteToolAvailable = remoteToolRegistered(toolRegistry);
  const { pools, contracts, artifacts, outcomes, workspaces, sourceCounts } = remoteSnapshot;
  const contractsByRunner = contractByRunnerId(contracts);
  const artifactsByRunner = artifactsByRunnerId(artifacts);
  const outcomesByRunner = outcomesByRunnerId(outcomes);
  const workspacesByRunner = workspacesByRunnerId(workspaces);
  const workPlanByAgent = workPlanItemsByAgentId(workItems);
  const items = records.map((record) => {
    const id = agentId(record);
    return managedPlanItem(
      record,
      contractsByRunner.get(id),
      artifactsByRunner.get(id) ?? [],
      outcomesByRunner.get(id) ?? [],
      workspacesByRunner.get(id) ?? [],
      workPlanByAgent.get(id) ?? [],
      includeParameters,
    );
  });
  const status = managedPlanStatus(records, agentToolAvailable);
  const running = records.filter((record) => ['pending', 'running'].includes(agentStatus(record))).length;
  const failed = records.filter((record) => agentStatus(record) === 'failed').length;
  const completed = records.filter((record) => agentStatus(record) === 'completed').length;
  const remoteStatus = contracts.length > 0 || artifacts.length > 0 || outcomes.length > 0 || workspaces.length > 0 ? 'ready' : context.ops.remoteRuntime ? 'ready' : 'needs-setup';
  const linkedWorkPlanItemCount = Array.from(workPlanByAgent.values()).reduce((count, entries) => count + entries.length, 0);
  const dispatchReceiptCount = Array.from(workPlanByAgent.values()).reduce(
    (count, entries) => count + entries.reduce((entryCount, item) => entryCount + dispatchReceiptLines(item).length, 0),
    0,
  );
  return {
    planId: 'visible-managed-execution',
    status,
    summary: `${records.length} visible agent${records.length === 1 ? '' : 's'}, ${running} active, ${failed} attention, ${artifacts.length} remote artifact${artifacts.length === 1 ? '' : 's'}, ${outcomes.length} live remote outcome${outcomes.length === 1 ? '' : 's'}, ${workspaces.length} workspace evidence record${workspaces.length === 1 ? '' : 's'}, ${dispatchReceiptCount} dispatch receipt${dispatchReceiptCount === 1 ? '' : 's'}.`,
    milestones: [
      {
        id: 'intake-and-lane-selection',
        label: 'Intake and lane selection',
        status: 'ready',
        purpose: 'Choose serial chat, one visible agent, batch agents, delegated review, or remote inspection based on user outcome.',
        routes: ['delegation action:"status"', 'execution action:"status"', 'agent_harness mode:"agent_orchestration"', 'Owner: /work submit-file <JSON-path> (submission only; no execution)'],
      },
      {
        id: 'visible-agent-work',
        label: 'Visible agent work',
        status: running > 0 ? 'active' : failed > 0 ? 'attention' : agentToolAvailable ? 'ready' : 'needs-setup',
        count: records.length,
        active: running,
        completed,
        failed,
        cancellableRoutes: records.filter((record) => ['pending', 'running'].includes(agentStatus(record))).map((record) => routeForAgent('cancel', agentId(record))).slice(0, 12),
      },
      {
        id: 'remote-runner-evidence',
        label: 'Remote runner evidence',
        status: remoteStatus,
        pools: pools.length,
        contracts: contracts.length,
        artifacts: artifacts.length,
        readModelOutcomes: outcomes.length,
        workspaceEvidence: workspaces.length,
        routes: {
          pools: remoteToolAvailable ? 'remote { mode: "pools", view: "summary" }' : 'delegation action:"route" delegationRouteId:"remote-runner-inspection"',
          contracts: remoteToolAvailable ? 'remote { mode: "contracts", view: "summary" }' : 'delegation action:"route" delegationRouteId:"remote-runner-inspection"',
          artifacts: remoteToolAvailable ? 'remote { mode: "artifacts", view: "summary" }' : 'delegation action:"route" delegationRouteId:"remote-runner-inspection"',
        },
      },
      {
        id: 'review-and-closeout',
        label: 'Review and closeout',
        status: failed > 0 ? 'attention' : running > 0 ? 'active' : records.length > 0 ? 'ready' : 'needs-setup',
        linkedWorkPlanItems: linkedWorkPlanItemCount,
        dispatchReceipts: dispatchReceiptCount,
        autoAttachedRemoteArtifacts: artifacts.length,
        liveRemoteOutcomes: outcomes.length,
        workspaceEvidence: workspaces.length,
        requiredEvidence: ['changed files or artifact', 'test or verification output', 'agent status', 'workspace isolation evidence when remote runners are used', 'recovery route when writes happened'],
        routes: ['agent_harness mode:"agent_orchestration"', 'execution action:"history"', 'execution action:"recovery"', 'delegation action:"status"', 'agent_work_plan action:"list"'],
      },
    ],
    workItems: items,
    remoteEvidence: {
      status: remoteStatus,
      pools: pools.slice(0, includeParameters ? 8 : 3).map((pool) => ({
        id: readString(pool.id),
        label: readString(pool.label) || readString(pool.id),
        runnerIds: stringArray(pool.runnerIds).slice(0, includeParameters ? 12 : 5),
      })),
      contracts: contracts.slice(0, includeParameters ? 8 : 3).map((contract) => contractSummary(contract, includeParameters)),
      artifacts: artifacts.slice(0, includeParameters ? 8 : 3).map((artifact) => artifactSummary(artifact, includeParameters)),
      liveOutcomes: outcomes.slice(0, includeParameters ? 8 : 3),
      workspaceEvidence: workspaces.slice(0, includeParameters ? 8 : 3),
      sourceCounts,
      policy: 'Remote runner evidence is read-only here; creating pools, assigning runners, importing artifacts, accepting workspace isolation, or spawning agents stays on confirmed first-class routes.',
    },
    modelAccess: {
      spawn: 'agent { mode: "spawn" }',
      batchSpawn: 'agent { mode: "batch-spawn" }',
      listAgents: 'agent { mode: "list" }',
      remoteContracts: remoteToolAvailable ? 'remote { mode: "contracts", view: "summary" }' : 'delegation action:"route" delegationRouteId:"remote-runner-inspection"',
      remoteArtifacts: remoteToolAvailable ? 'remote { mode: "artifacts", view: "summary" }' : 'delegation action:"route" delegationRouteId:"remote-runner-inspection"',
      remoteReadModelOutcomes: 'agent_harness mode:"agent_orchestration" includeParameters:true',
    },
    policy: 'Managed execution plans are read-only summaries. Parallel work must remain visible, cancellable, attached to evidence, and justified by user outcome.',
  };
}

function describeAgent(
  record: AgentRecordView,
  includeParameters: boolean,
  contract?: Record<string, unknown>,
  artifacts: readonly Record<string, unknown>[] = [],
  outcomes: readonly RemoteCaptureOutcomeRecord[] = [],
  workspaces: readonly RemoteWorkspaceEvidenceRecord[] = [],
  linkedWorkItems: readonly WorkPlanItem[] = [],
): Record<string, unknown> {
  const id = agentId(record);
  const task = readString(record.task);
  const progress = readString(record.progress);
  const context = readString(record.context);
  return {
    agentId: id,
    status: agentStatus(record),
    template: readString(record.template) || 'general',
    task: previewHarnessText(task, includeParameters ? 240 : 96),
    progress: progress ? previewHarnessText(progress, includeParameters ? 180 : 72) : null,
    toolCallCount: typeof record.toolCallCount === 'number' ? record.toolCallCount : 0,
    modelRoute: 'agent { mode: "get" }',
    userRoute: 'Agent Workspace -> Work & Approvals -> Autonomy queue',
    routes: agentRoutes(id),
    managedPlanCard: managedPlanItem(record, contract, artifacts, outcomes, workspaces, linkedWorkItems, includeParameters),
    ...(readString(record.model) ? { model: readString(record.model) } : {}),
    ...(readString(record.provider) ? { provider: readString(record.provider) } : {}),
    ...(includeParameters ? {
      tools: Array.isArray(record.tools) ? record.tools.filter((tool): tool is string => typeof tool === 'string') : [],
      context: context ? previewHarnessText(context, 500) : null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      completedAt: typeof record.completedAt === 'number' ? record.completedAt : null,
      usage: record.usage && typeof record.usage === 'object' ? record.usage : null,
    } : {}),
  };
}

export function agentOrchestrationCatalogStatus(context: CommandContext, toolRegistry: ToolRegistry): Record<string, unknown> {
  const records = exportAgents(context);
  const counts = statusCounts(records ?? []);
  const toolRegistered = agentToolRegistered(toolRegistry);
  return {
    modes: ['agent_orchestration', 'agent_orchestration_agent'],
    status: !records ? 'unavailable' : counts.running > 0 || counts.pending > 0 ? 'attention' : toolRegistered ? 'ready' : 'needs-setup',
    toolRegistered,
    agents: records?.length ?? 0,
    running: counts.running,
    pending: counts.pending,
    failed: counts.failed,
    cancellable: (records ?? []).filter((record) => ['pending', 'running'].includes(agentStatus(record))).length,
    readOnly: true,
  };
}

function orchestrationSources(context: CommandContext, originalSources: readonly unknown[], toolRegistry?: ToolRegistry, remoteSource?: OrchestrationRemoteSource) {
  const records = exportAgents(context), remote = remoteRuntimeSnapshot(context, remoteSource);
  const sources = captureCatalogData({ originalSources, records, remote, workItems: workPlanItems(context), sessionId: context.session.runtime.sessionId,
    ...(toolRegistry ? { tools: toolRegistry.getToolDefinitions() } : {}) });
  const token = orchestrationWorkspaceDisplays.get(remote);
  if (token) { bindNativeRemoteWorkspaceDisplays(token, sources.remote.workspaces); orchestrationWorkspaceDisplays.set(sources, token); }
  return sources;
}

function captureOrchestrationBackend(context: CommandContext, toolRegistry?: ToolRegistry) {
  // Canonical evidence uses complete acquired DTOs; public remote cards remain bounded.
  const originalSources: unknown[] = [];
  const nativeWorkspaceSources: { readonly index: number; readonly token: object }[] = [];
  const pushOriginal = (entry: unknown, source: unknown, layout: 'snapshot' | 'map-entries', workspaceSource: boolean) => {
    const index = originalSources.length; originalSources.push(entry);
    if (workspaceSource) nativeWorkspaceSources.push({ index, token: captureNativeRemoteWorkspacePathSource(source, layout) });
  };
  const guards = [captureCatalogMethods(context, ['ops', 'platform', 'workspace', 'session', 'clients']),
    captureCatalogMethods(context.ops, ['agentManager', 'remoteRuntime']), captureCatalogMethods(context.platform, ['artifactStore', 'readModels']),
    captureCatalogMethods(context.workspace, ['workPlanStore']), captureCatalogMethods(context.session, ['runtime']),
    captureCatalogMethods(context.session.runtime, ['sessionId'])];
  if (context.ops.agentManager) guards.push(captureCatalogMethods(context.ops.agentManager, ['exportState']));
  if (context.ops.remoteRuntime) guards.push(captureCatalogMethods(context.ops.remoteRuntime, ['listContracts', 'listPools', 'listArtifacts']));
  if (context.platform.artifactStore) guards.push(captureCatalogMethods(context.platform.artifactStore, ['list']));
  if (context.workspace.workPlanStore) guards.push(captureCatalogMethods(context.workspace.workPlanStore, ['listItems']));
  const retainPublished = (subject: object, key: string, children?: readonly string[], workspaceSource = false, workspaceChildren: readonly string[] = []) => {
    guards.push(captureCatalogMethods(subject, [key]));
    const source = modelReadingServicePath(subject, [key]);
    if (children) {
      if (source !== undefined && source !== null) {
        if (typeof source !== 'object') throw new ToolInputProjectionError('invalid');
        for (const child of children) retainPublished(source, child, undefined, workspaceSource || workspaceChildren.includes(child));
      }
      return;
    }
    if (source instanceof Map) {
      const methods = captureCatalogMethods(source, ['entries']);
      const acquire = () => {
        methods();
        if (Object.getPrototypeOf(source) !== Map.prototype || Object.getOwnPropertyNames(source).length
          || Object.getOwnPropertySymbols(source).length) throw new ToolInputProjectionError('invalid');
        const entries = Array.from(Map.prototype.entries.call(source));
        if (entries.some(([key]) => typeof key !== 'string')) throw new ToolInputProjectionError('invalid');
        methods(); return entries;
      };
      const original = acquire(), snapshot = capturePersonalOpsSnapshot(original), complete = snapshot.captured;
      pushOriginal({ slot: key, original: complete }, complete, 'map-entries', workspaceSource);
      guards.push(() => { snapshot.assertCurrent(original); snapshot.assertCurrent(acquire()); });
      return;
    }
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      const names = ['getSnapshot', 'snapshot', 'toJSON', 'listCaptureOutcomes', 'listOutcomes', 'listCaptures', 'listExports', 'listCloseouts', 'listArtifacts', 'listWorkspaceEvidence', 'listWorkspaceIsolation', 'listWorkspaces', 'listWorktrees', 'list'];
      const methods = captureCatalogMethods(source, [...names, 'subscribe']); guards.push(methods);
      let materialized = false;
      for (const name of names) {
        const read = modelReadingServicePath(source, [name]);
        if (typeof read !== 'function') continue;
        materialized = true;
        if (name === 'getSnapshot' && typeof modelReadingServicePath(source, ['subscribe']) === 'function') guards.push(captureNativeReadModelObservation(source));
        const acquire = () => { methods(); let value: unknown;
          try { value = read.call(source); } catch { throw new ToolInputProjectionError('unavailable'); }
          methods(); return value;
        };
        const original = acquire(), snapshot = capturePersonalOpsSnapshot(original), complete = snapshot.captured;
        pushOriginal({ slot: key, method: name, original: complete }, complete, 'snapshot', workspaceSource);
        guards.push(() => { snapshot.assertCurrent(original); snapshot.assertCurrent(acquire()); methods(); });
      }
      if (materialized) return;
    }
    if (typeof source === 'function') {
      const acquire = () => { let value: unknown; try { value = source(); } catch { throw new ToolInputProjectionError('unavailable'); } return value; };
      const original = acquire(), snapshot = capturePersonalOpsSnapshot(original), complete = snapshot.captured;
      pushOriginal({ slot: key, original: complete }, complete, 'snapshot', workspaceSource);
      guards.push(() => { snapshot.assertCurrent(original); snapshot.assertCurrent(acquire()); });
      return;
    }
    const snapshot = capturePersonalOpsSnapshot(source), complete = snapshot.captured;
    if (source !== undefined && source !== null) pushOriginal({ slot: key, original: complete }, complete, 'snapshot', workspaceSource);
    guards.push(() => snapshot.assertCurrent(modelReadingServicePath(subject, [key])));
  };
  const readModels: unknown = Reflect.get(context.platform, 'readModels');
  if (readModels && typeof readModels === 'object') {
    retainPublished(readModels, 'remoteRuntime', ['captureOutcomes', 'outcomes', 'captures', 'exports', 'closeouts', 'workspaces', 'workspaceIsolation', 'worktrees'], false, ['workspaces', 'workspaceIsolation', 'worktrees']);
    retainPublished(readModels, 'remoteRunners', ['captureOutcomes', 'workspaces'], false, ['workspaces']);
    retainPublished(readModels, 'remote', ['captureOutcomes', 'workspaceIsolation'], false, ['workspaceIsolation']);
    retainPublished(readModels, 'worktrees', ['remote'], true);
    for (const key of ['remoteCaptureOutcomes', 'remoteRunnerOutcomes']) retainPublished(readModels, key);
    for (const key of ['remoteWorkspaces', 'remoteWorkspaceIsolation']) retainPublished(readModels, key, undefined, true);
  }
  if (context.ops.remoteRuntime) retainPublished(context.ops.remoteRuntime, 'readModels', ['captureOutcomes', 'workspaces'], false, ['workspaces']);
  if (context.clients) {
    guards.push(captureCatalogMethods(context.clients, ['operator']));
    const operator = context.clients.operator;
    if (operator) {
      guards.push(captureCatalogMethods(operator, ['remoteRuntime']));
      const remote: unknown = Reflect.get(operator, 'remoteRuntime');
      if (remote && typeof remote === 'object') { retainPublished(remote, 'captureOutcomes'); retainPublished(remote, 'workspaces', undefined, true); }
    }
  }
  if (toolRegistry) guards.push(captureCatalogMethods(toolRegistry, ['getToolDefinitions']));
  return { originalSources: captureCatalogData(originalSources), nativeWorkspaceSources, assertCurrent: () => { for (const guard of guards) guard(); } };
}

function retainOrchestrationSources(context: CommandContext, sources: ReturnType<typeof orchestrationSources>, options: CatalogRankingOptions, assertBackend: () => void, toolRegistry?: ToolRegistry) {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, sourceOwner = options.sourceOwner, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const revision = JSON.stringify(sources);
  const nativeDisplayToken = orchestrationWorkspaceDisplays.get(sources);
  const assertOptionsCurrent = () => {
    assertOptions();
    if (options.signal !== signal || options.sourceOwner !== sourceOwner || options.assertCurrent !== callerCurrent || options.retainCurrent !== retainCurrent) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted();
  };
  const assertSourceCurrent = () => {
    assertOptionsCurrent();
    assertBackend(); if (nativeDisplayToken) assertNativeRemoteWorkspaceDisplaysCurrent(nativeDisplayToken);
    if (JSON.stringify(orchestrationSources(context, sources.originalSources, toolRegistry, nativeDisplayToken ? { kind: 'current', token: nativeDisplayToken } : undefined)) !== revision) throw new ToolInputProjectionError('stale');
    if (nativeDisplayToken) assertNativeRemoteWorkspaceDisplaysCurrent(nativeDisplayToken);
    assertBackend(); assertOptionsCurrent();
  };
  retainCurrent?.call(options, assertSourceCurrent, 'agent.harness.agent-orchestration.sources');
  const assertCurrent = () => { assertOptionsCurrent(); callerCurrent?.call(options); assertOptionsCurrent(); assertSourceCurrent(); };
  assertCurrent(); return assertCurrent;
}

function orchestrationPublisherFacts(context: CommandContext, toolRegistry?: ToolRegistry) {
  return {
    records: exportAgents(context),
    remote: { pools: remotePools(context), contracts: remoteContracts(context), artifacts: remoteArtifacts(context) },
    workItems: workPlanItems(context), sessionId: context.session.runtime.sessionId,
    ...(toolRegistry ? { tools: toolRegistry.getToolDefinitions() } : {}),
  };
}

async function captureOrchestrationPublisher(context: CommandContext, backend: ReturnType<typeof captureOrchestrationBackend>,
  options: CatalogRankingOptions, toolRegistry?: ToolRegistry): Promise<Extract<OrchestrationRemoteSource, { readonly kind: 'native' }>> {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const { signal, sourceOwner, assertCurrent: callerCurrent, retainCurrent } = options;
  const facts = orchestrationPublisherFacts(context, toolRegistry), factsSnapshot = capturePersonalOpsSnapshot(facts);
  const assertSourceCurrent = () => {
    assertOptions(); signal?.throwIfAborted();
    if (options.signal !== signal || options.sourceOwner !== sourceOwner || options.assertCurrent !== callerCurrent || options.retainCurrent !== retainCurrent)
      throw new ToolInputProjectionError('held');
    backend.assertCurrent();
    factsSnapshot.assertCurrent(facts); factsSnapshot.assertCurrent(orchestrationPublisherFacts(context, toolRegistry));
    backend.assertCurrent(); assertOptions(); signal?.throwIfAborted();
  };
  const assertCurrent = () => {
    assertSourceCurrent();
    const result: unknown = callerCurrent?.call(options);
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
    assertSourceCurrent();
  };
  assertCurrent();
  // Full original-source and Agent/native-fact admission precedes every remote
  // publisher reading. The actual native path owners select workspace paths.
  const originalProjection = projectOrchestrationOriginalSources(backend.originalSources, backend, assertCurrent);
  const preflight = capturePersonalOpsData([{ evidence: { originalSources: backend.originalSources, ...facts } }]);
  const problem = judgmentInputCardProblem(preflight);
  if (problem) throw new ToolInputProjectionError(problem === 'card-material' ? 'held' : 'invalid');
  assertOrchestrationIssuerSafe(preflight);
  projectOrchestrationEvidence(preflight, originalProjection);
  assertCurrent();
  const owned = captureNativeRemoteReadModelSnapshot(context);
  assertCurrent();
  const snapshot = await settleNativeRemotePublisherSemantics(owned.token, { ...options, assertCurrent, assertSourceCurrent }, {
    projectPath: projectOwnedWorkspacePath,
    projectText: projectOrchestrationText,
    protectFields: async (value, current) => {
      const redactionSource = captureRedactionSource();
      const assertRedactionCurrent = () => { current.signal?.throwIfAborted(); current.assertCurrent?.(); redactionSource.assertCurrent(); };
      assertRedactionCurrent();
      current.retainCurrent?.(redactionSource.assertCurrent, 'agent.remote-publisher.redaction');
      const protectedValue = await protectPersonalOpsData(value, { ...current, assertCurrent: assertRedactionCurrent });
      assertRedactionCurrent(); return orchestrationProtectedFields(protectedValue);
    },
  });
  assertCurrent();
  return { kind: 'native', snapshot, token: owned.token };
}

function orchestrationEntries(sources: ReturnType<typeof orchestrationSources>) {
  const contracts = contractByRunnerId(sources.remote.contracts), artifacts = artifactsByRunnerId(sources.remote.artifacts);
  const outcomes = outcomesByRunnerId(sources.remote.outcomes), workspaces = workspacesByRunnerId(sources.remote.workspaces);
  const workItems = workPlanItemsByAgentId(sources.workItems);
  return (sources.records ?? []).map(record => {
    const id = agentId(record);
    return { record, originalSources: sources.originalSources, underlying: { contract: contracts.get(id), artifacts: artifacts.get(id) ?? [], outcomes: outcomes.get(id) ?? [], workspaces: workspaces.get(id) ?? [], workItems: workItems.get(id) ?? [] },
      full: describeAgent(record, true, contracts.get(id), artifacts.get(id) ?? [], outcomes.get(id) ?? [], workspaces.get(id) ?? [], workItems.get(id) ?? []),
      summary: describeAgent(record, false, contracts.get(id), artifacts.get(id) ?? [], outcomes.get(id) ?? [], workspaces.get(id) ?? [], workItems.get(id) ?? []) };
  });
}

type OrchestrationTextPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'display-marker'; readonly text: string };
type OrchestrationField = { readonly path: readonly string[] } & (
  { readonly kind: 'object' } | { readonly kind: 'array'; readonly length: number }
  | { readonly kind: 'null' } | { readonly kind: 'undefined' }
  | { readonly kind: 'number'; readonly value: number } | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly parts: readonly OrchestrationTextPart[] }
);

/** Native issuer containment includes complete JSON scalar encodings. */
function assertOrchestrationIssuerSafe(value: unknown): void {
  const inspectText = (text: string): void => {
    const pending = [text];
    while (pending.length) {
      const current = pending.pop();
      if (current === undefined) throw new ToolInputProjectionError('invalid');
      if (containsIssuerCredential(current)) throw new ToolInputProjectionError('held');
      for (const match of current.matchAll(/"(?:\\.|[^"\\])*"/g)) {
        let decoded: unknown;
        try { decoded = JSON.parse(match[0]); } catch { continue; }
        if (typeof decoded !== 'string' || decoded.length >= match[0].length) throw new ToolInputProjectionError('held');
        pending.push(decoded);
      }
    }
  };
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') inspectText(entry);
    else if (entry !== null && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) { inspectText(key); visit(child); }
  };
  visit(capturePersonalOpsData(value));
}

/** Slash syntax has meaning only for an already owned native filesystem
 * path. Generic text and queries cannot acquire that ownership by spelling. */
function assertNoUnownedPathMaterial(input: string): void {
  const pending = [input];
  while (pending.length) {
    const text = pending.pop();
    if (text === undefined) throw new ToolInputProjectionError('invalid');
    for (const component of text.split(/[\\/]/)) {
      if (projectSetupSmokeEvidenceFull(component).validationText !== component) throw new ToolInputProjectionError('held');
    }
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      let decoded: unknown;
      try { decoded = JSON.parse(match[0]); } catch { continue; }
      if (typeof decoded !== 'string' || decoded.length >= match[0].length) throw new ToolInputProjectionError('held');
      pending.push(decoded);
    }
  }
}

function projectOwnedWorkspacePath(value: string): { readonly displayText: string; readonly validationText: string } {
  // Quotes, URL/query syntax and multiline declarations do not describe the
  // producer's simple filesystem component grammar. Refuse before readers.
  if (/["'?&#\r\n]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) throw new ToolInputProjectionError('held');
  let displayText = '', validationText = '';
  for (const part of value.split(/([\\/])/)) {
    if (part === '/' || part === '\\') { displayText += part; validationText += part; continue; }
    const parsed = projectSetupSmokeEvidenceFull(part);
    displayText += parsed.displayText; validationText += parsed.validationText;
  }
  return { displayText, validationText };
}

interface OrchestrationOriginalSourceProjection {
  readonly original: readonly unknown[];
  readonly selected: ReadonlyMap<number, { readonly display: unknown; readonly validation: unknown }>;
}

function projectOrchestrationText(value: string): { readonly displayText: string; readonly validationText: string } {
  const parsed = projectSetupSmokeEvidenceFull(value);
  assertNoUnownedPathMaterial(parsed.validationText);
  return parsed;
}

function projectOrchestrationOriginalSources(
  sources: readonly unknown[],
  backend: ReturnType<typeof captureOrchestrationBackend>,
  assertCurrent: () => void,
): OrchestrationOriginalSourceProjection {
  assertCurrent(); assertPersonalOpsDataCurrent(sources, backend.originalSources); assertCurrent();
  const selected = new Map<number, { readonly display: unknown; readonly validation: unknown }>();
  for (const source of backend.nativeWorkspaceSources) {
    assertCurrent();
    selected.set(source.index, projectNativeRemoteWorkspacePathSource(source.token, projectOwnedWorkspacePath, projectOrchestrationText, assertCurrent));
    assertCurrent();
  }
  assertCurrent(); assertPersonalOpsDataCurrent(sources, backend.originalSources); assertCurrent();
  return { original: sources, selected };
}

/** Native prose spans are withheld while their entire surrounding structure
 * remains intact. Unsupported declared fields and key/value pairs must refuse
 * before a generic field or text reader can see their values. */
function projectOrchestrationEvidence(value: unknown, nativeSources?: OrchestrationOriginalSourceProjection,
  nativeDisplays: readonly { readonly path: readonly (string | number)[]; readonly displayText: string; readonly validationText: string }[] = []): unknown {
  const visit = (entry: unknown, path: readonly (string | number)[] = []): { readonly display: unknown; readonly validation: unknown } => {
    if (nativeSources && path.length === 3 && typeof path[0] === 'number' && path[1] === 'evidence' && path[2] === 'originalSources') {
      assertPersonalOpsDataCurrent(entry, nativeSources.original);
      if (!Array.isArray(entry)) throw new ToolInputProjectionError('held');
      const display: unknown[] = [], validation: unknown[] = [];
      for (const [index, source] of entry.entries()) {
        const native = nativeSources.selected.get(index);
        if (!native) { const parsed = visit(source, [...path, index]); display.push(parsed.display); validation.push(parsed.validation); continue; }
        if (source === null || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(source, 'original')) throw new ToolInputProjectionError('held');
        const displaySource: Record<string, unknown> = Object.create(null), validationSource: Record<string, unknown> = Object.create(null);
        for (const [key, child] of Object.entries(source)) {
          const parsed = key === 'original' ? native : visit(child, [...path, index, key]);
          Object.defineProperty(displaySource, key, { value: parsed.display, enumerable: true });
          Object.defineProperty(validationSource, key, { value: parsed.validation, enumerable: true });
        }
        display.push(displaySource); validation.push(validationSource);
      }
      return { display, validation };
    }
    if (typeof entry === 'string') {
      const native = nativeDisplays.find(reference => reference.path.length === path.length && reference.path.every((part, index) => part === path[index]));
      if (native) { if (native.displayText !== entry) throw new ToolInputProjectionError('held'); return { display: native.displayText, validation: native.validationText }; }
      const text = projectOrchestrationText(entry);
      return { display: text.displayText, validation: text.validationText };
    }
    if (Array.isArray(entry)) {
      const display: unknown[] = [], validation: unknown[] = [];
      for (const [index, child] of entry.entries()) {
        const projected = visit(child, [...path, index]);
        display.push(projected.display); validation.push(projected.validation);
      }
      return { display, validation };
    }
    if (entry === null || typeof entry !== 'object') return { display: entry, validation: entry };
    const display: Record<string, unknown> = Object.create(null), validation: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(entry)) {
      const projected = visit(child, [...path, key]);
      Object.defineProperty(display, key, { value: projected.display, enumerable: true });
      Object.defineProperty(validation, key, { value: projected.validation, enumerable: true });
    }
    return { display, validation };
  };
  const projected = visit(capturePersonalOpsData(value));
  // Original keys, scalars and object/array associations survive. Only the
  // parser's exact private prose spans become empty validation holes.
  snapshotJudgmentInput(projected.validation);
  return projected.display;
}

/** Only the actual canonical redactor's captured result enters this renderer.
 * Fixed display markers keep their exact spelling as separate parts. A marker
 * does not certify a slot or distinguish introduced from literal marker text. */
function orchestrationProtectedFields(protectedValue: unknown): unknown {
  const fields: OrchestrationField[] = [];
  const textParts = (text: string): readonly OrchestrationTextPart[] => {
    const parts: OrchestrationTextPart[] = [];
    let position = 0;
    const markers = /<redacted>|\[REDACTED(?:_(?:API_KEY|TOKEN|PROFILE|TEXT|GITHUB_TOKEN|GITLAB_TOKEN|SLACK_TOKEN|AWS_KEY))?\]/g;
    for (const marker of text.matchAll(markers)) {
      parts.push({ kind: 'text', text: text.slice(position, marker.index) }, { kind: 'display-marker', text: marker[0] });
      position = marker.index + marker[0].length;
    }
    parts.push({ kind: 'text', text: text.slice(position) });
    return parts;
  };
  const visit = (value: unknown, path: readonly string[]): void => {
    if (typeof value === 'string') { fields.push({ path, kind: 'text', parts: textParts(value) }); return; }
    if (value === undefined) { fields.push({ path, kind: 'undefined' }); return; }
    if (value === null) { fields.push({ path, kind: 'null' }); return; }
    if (typeof value === 'number') { fields.push({ path, kind: 'number', value }); return; }
    if (typeof value === 'boolean') { fields.push({ path, kind: 'boolean', value }); return; }
    if (typeof value !== 'object') throw new ToolInputProjectionError('invalid');
    if (Array.isArray(value)) {
      fields.push({ path, kind: 'array', length: value.length });
      for (const [index, child] of value.entries()) visit(child, [...path, String(index)]);
    } else {
      fields.push({ path, kind: 'object' });
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  };
  visit(capturePersonalOpsData(protectedValue), []);
  // This unchanged floor checks every safe segment, path, value and encoded
  // body. Unsupported or credential-bearing remnants remain held.
  return snapshotJudgmentInput(fields);
}

type OrchestrationOutputPath = readonly (string | number)[];
type OrchestrationOutputPattern = readonly (string | null)[];
const AGENT_OUTPUT_ROOTS: readonly OrchestrationOutputPattern[] = [['agents', null], ['agent'], ['candidates', null]];
const PLAN_ITEM_OUTPUT_ROOTS: readonly OrchestrationOutputPattern[] = [
  ['agents', null, 'managedPlanCard'], ['agent', 'managedPlanCard'], ['candidates', null, 'managedPlanCard'], ['managedExecutionPlan', 'workItems', null],
];

/** Explicit native prose locations, independent of any semantic field role.
 * Authored policies, action guidance, evidence requirements and all identities,
 * statuses, routes and other control text retain their original exact values. */
function orchestrationOutputProse(path: OrchestrationOutputPath): boolean {
  const matches = (root: OrchestrationOutputPattern, suffix: OrchestrationOutputPattern): boolean => {
    const pattern = [...root, ...suffix];
    return pattern.length === path.length && pattern.every((part, index) => part === null ? typeof path[index] === 'number' : part === path[index]);
  };
  for (const root of AGENT_OUTPUT_ROOTS) {
    if (['task', 'progress', 'context'].some(field => matches(root, [field]))) return true;
  }
  const remoteProse = (root: OrchestrationOutputPattern, kind: 'artifact' | 'outcome' | 'workspace'): boolean => {
    if (kind === 'artifact') return ['task', 'summary'].some(field => matches(root, [field]));
    if (kind === 'outcome' && ['task', 'summary'].some(field => matches(root, [field]))) return true;
    if (kind === 'workspace' && matches(root, ['label'])) return true;
    return matches(root, ['certification', 'publicationGuarantee']);
  };
  for (const root of PLAN_ITEM_OUTPUT_ROOTS) {
    if (['title', 'progress'].some(field => matches(root, [field]))) return true;
    if (matches(root, ['remoteContract', 'label'])) return true;
    for (const workPlan of [['workPlanLinks', null], ['closeout', 'workPlanItems', null]] as const) {
      if (['title', 'latestDispatchReceipt'].some(field => matches(root, [...workPlan, field]))) return true;
    }
    if (remoteProse([...root, 'artifactTrail', null], 'artifact') || remoteProse([...root, 'closeout', 'autoAttachedRemoteArtifacts', null], 'artifact')
      || remoteProse([...root, 'liveOutcomeTrail', null], 'outcome') || remoteProse([...root, 'closeout', 'liveRemoteOutcomes', null], 'outcome')
      || remoteProse([...root, 'workspaceEvidence', null], 'workspace') || remoteProse([...root, 'closeout', 'workspaceEvidence', null], 'workspace')) return true;
  }
  const remoteRoot: OrchestrationOutputPattern = ['managedExecutionPlan', 'remoteEvidence'];
  if (matches(remoteRoot, ['pools', null, 'label']) || matches(remoteRoot, ['contracts', null, 'label'])) return true;
  return remoteProse([...remoteRoot, 'artifacts', null], 'artifact') || remoteProse([...remoteRoot, 'liveOutcomes', null], 'outcome')
    || remoteProse([...remoteRoot, 'workspaceEvidence', null], 'workspace');
}

/** Native result facts retain their exact ordered schema and all non-prose
 * values. Protected prose still crosses the complete ordinary floor/owner. */
function assertOrchestrationOutputFacts(original: unknown, protectedValue: unknown, path: OrchestrationOutputPath = []): void {
  if (typeof original === 'string') {
    if (typeof protectedValue !== 'string' || (!orchestrationOutputProse(path) && original !== protectedValue)) throw new ToolInputProjectionError('held');
    return;
  }
  if (original === null || typeof original !== 'object') {
    if (original !== protectedValue) throw new ToolInputProjectionError('held');
    return;
  }
  if (protectedValue === null || typeof protectedValue !== 'object' || Array.isArray(original) !== Array.isArray(protectedValue)) throw new ToolInputProjectionError('held');
  const originalFields = Object.entries(original), protectedFields = Object.entries(protectedValue);
  if (Array.isArray(original) && (!Array.isArray(protectedValue) || original.length !== protectedValue.length)) throw new ToolInputProjectionError('held');
  if (originalFields.length !== protectedFields.length) throw new ToolInputProjectionError('held');
  for (const [index, [key, child]] of originalFields.entries()) {
    const field = protectedFields[index];
    if (!field || field[0] !== key) throw new ToolInputProjectionError('held');
    assertOrchestrationOutputFacts(child, field[1], [...path, Array.isArray(original) ? index : key]);
  }
}

function orchestrationDisplayRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputProjectionError('held');
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value)) Object.defineProperty(record, key, { value: child, enumerable: true });
  return record;
}

async function protectOrchestrationOutput(value: Record<string, unknown>, options: CatalogRankingOptions, nativeDisplayToken?: object): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const original = capturePersonalOpsData(value), problem = judgmentInputCardProblem(original);
  if (problem) throw new ToolInputProjectionError(problem === 'card-material' ? 'held' : 'invalid');
  assertOrchestrationIssuerSafe(original);
  const nativeDisplays = nativeDisplayToken ? projectNativeRemoteWorkspaceDisplayReferences(nativeDisplayToken, value, projectOwnedWorkspacePath,
    () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); }) : [];
  const projected = projectOrchestrationEvidence(original, undefined, nativeDisplays);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const redactionSource = captureRedactionSource();
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); redactionSource.assertCurrent(); };
  assertCurrent(); options.retainCurrent?.(redactionSource.assertCurrent, 'agent.harness.agent-orchestration.output-redaction'); assertCurrent();
  const display = orchestrationDisplayRecord(capturePersonalOpsData(await protectPersonalOpsData(projected, { ...options, assertCurrent })));
  assertCurrent(); assertOrchestrationOutputFacts(original, display); assertCurrent();
  const displaySnapshot = capturePersonalOpsSnapshot(display);
  const assertDisplay = () => displaySnapshot.assertCurrent(display);
  options.retainCurrent?.(assertDisplay, 'agent.harness.agent-orchestration.output');
  const assertPublication = () => { assertCurrent(); assertDisplay(); };
  assertPublication();
  // Screen every returned field, including supplemental plan evidence, while
  // retaining its exact native association with the separately held display.
  const result = await withModelReadingSource({ fields: orchestrationProtectedFields(display) }, { ...options, assertCurrent: assertPublication }, async () => display);
  assertPublication(); return result;
}

/** Complete retained originals use the same refusal floor before every output branch. */
function assertOrchestrationOriginalFloor(entries: ReturnType<typeof orchestrationEntries>, backend: ReturnType<typeof captureOrchestrationBackend>, query = ''): void {
  const originals = { originalSources: backend.originalSources, entries, descriptions: entries.map(entry => agentSearchText(entry.record)) };
  const rawProblem = judgmentInputCardProblem(originals);
  if (rawProblem) throw new ToolInputProjectionError(rawProblem === 'card-material' ? 'held' : 'invalid');
  assertOrchestrationIssuerSafe({ query, ...originals });
}

async function matchingAgents(entries: ReturnType<typeof orchestrationEntries>, query: string, options: CatalogRankingOptions, backend: ReturnType<typeof captureOrchestrationBackend>, nativeDisplayToken?: object) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!query) {
    assertOrchestrationOriginalFloor(entries, backend);
    if (!options.sourceOwner) throw new ToolInputProjectionError('held');
    return { matches: entries.map(entry => ({ entry, judgment: undefined })), judgments: [], assertProtectedCurrent: undefined };
  }
  const producerClock = (value: unknown) => {
    if (typeof value !== 'number') return value;
    const date = new Date(value);
    if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) throw new ToolInputProjectionError('invalid');
    return date.toISOString();
  };
  // Raw input cannot borrow a native display projection. Refuse it before
  // acquiring a redaction reader, including caller-supplied marker text.
  snapshotJudgmentInput(query); assertNoUnownedPathMaterial(query);
  if (!options.sourceOwner) throw new ToolInputProjectionError('held');
  assertOrchestrationOriginalFloor(entries, backend, query);
  const nativeSources = projectOrchestrationOriginalSources(entries[0]?.originalSources ?? backend.originalSources, backend, () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); });
  const nativeEvidence = entries.map(entry => ({ description: agentSearchText(entry.record), evidence: {
    ...entry,
    record: { ...entry.record, startedAt: producerClock(entry.record.startedAt), completedAt: producerClock(entry.record.completedAt) },
    full: { ...entry.full, startedAt: producerClock(entry.full.startedAt), completedAt: producerClock(entry.full.completedAt) },
    underlying: { ...entry.underlying,
      contract: entry.underlying.contract ? { ...entry.underlying.contract, createdAt: producerClock(entry.underlying.contract.createdAt) } : undefined,
      artifacts: entry.underlying.artifacts.map(artifact => ({ ...artifact, createdAt: producerClock(artifact.createdAt), ...(artifact.task && typeof artifact.task === 'object' ? {
        task: { ...readObject(artifact.task), startedAt: producerClock(readObject(artifact.task).startedAt), completedAt: producerClock(readObject(artifact.task).completedAt) },
      } : {}) })),
      workItems: entry.underlying.workItems.map(item => ({ ...item, createdAt: producerClock(item.createdAt), updatedAt: producerClock(item.updatedAt), completedAt: producerClock(item.completedAt) })),
    },
  } }));
  const cardProblem = judgmentInputCardProblem(nativeEvidence);
  if (cardProblem) throw new ToolInputProjectionError(cardProblem === 'card-material' ? 'held' : 'invalid');
  const nativeDisplays = nativeDisplayToken ? projectNativeRemoteWorkspaceDisplayReferences(nativeDisplayToken, nativeEvidence, projectOwnedWorkspacePath,
    () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); }) : [];
  const safeEvidence = projectOrchestrationEvidence(nativeEvidence, nativeSources, nativeDisplays);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const redactionSource = captureRedactionSource();
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); redactionSource.assertCurrent(); };
  assertCurrent();
  options.retainCurrent?.(redactionSource.assertCurrent, 'agent.harness.agent-orchestration.redaction');
  assertCurrent();
  const protectedEvidence = await protectPersonalOpsData(safeEvidence, { ...options, assertCurrent });
  assertCurrent();
  if (!Array.isArray(protectedEvidence) || protectedEvidence.length !== entries.length) throw new ToolInputProjectionError('held');
  assertOrchestrationIssuerSafe(protectedEvidence);
  const fields = protectedEvidence.map(orchestrationProtectedFields);
  assertCurrent();
  // Association remains exact native order and identity. Complete protected
  // descriptions and source records are retained as ordered field evidence.
  return rankHarnessCatalog(entries.map((entry, index) => ({ index, entry, fields: fields[index] })), query,
    candidate => ({ id: agentId(candidate.entry.record), description: 'Visible Agent orchestration record', evidence: { fields: candidate.fields } }),
    'agent.harness.agent-orchestration', { ...options, assertCurrent, requirePreservedSource: true })
    .then(result => {
      assertCurrent();
      // Ranking preserves this code-owned ordinal through its exact candidate
      // capture. Return the retained native entry, whose workspace occurrences
      // remain bound to their producer; equal captured copies have no ownership.
      const matches = result.matches.map(match => {
        const index = match.entry.index, entry = entries[index];
        if (!Number.isSafeInteger(index) || index < 0 || !entry) throw new ToolInputProjectionError('held');
        return { ...match, entry };
      });
      return { ...result, assertProtectedCurrent: assertCurrent, matches };
    });
}

export async function agentOrchestrationSummary(context: CommandContext, toolRegistry: ToolRegistry, args: AgentHarnessAgentOrchestrationArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const backend = captureOrchestrationBackend(context, toolRegistry);
  const remoteSource = await captureOrchestrationPublisher(context, backend, options, toolRegistry);
  const sources = orchestrationSources(context, backend.originalSources, toolRegistry, remoteSource);
  const assertCurrent = retainOrchestrationSources(context, sources, options, backend.assertCurrent, toolRegistry);
  const records = sources.records;
  const toolRegistered = agentToolRegistered(toolRegistry);
  if (!records) {
    return {
      status: 'unavailable',
      reason: 'Visible Agent orchestration requires an Agent manager in the runtime.',
      modes: ['agent_orchestration', 'agent_orchestration_agent'],
      toolRegistered,
      policy: 'Read-only orchestration posture. Actual spawn/message/wait/cancel remains on the first-class agent tool.',
    };
  }
  const counts = statusCounts(records);
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  const selected = await matchingAgents(orchestrationEntries(sources), query, { ...options, assertCurrent }, backend, orchestrationWorkspaceDisplays.get(sources));
  const assertQueryCurrent = selected.assertProtectedCurrent ?? assertCurrent;
  assertQueryCurrent();
  const filtered = selected.matches.slice(0, readLimit(args.limit, 100));
  const result: Record<string, unknown> = {
    status: counts.running > 0 || counts.pending > 0 ? 'attention' : toolRegistered ? 'ready' : 'needs-setup',
    summary: {
      agents: records.length,
      running: counts.running,
      pending: counts.pending,
      completed: counts.completed,
      failed: counts.failed,
      cancelled: counts.cancelled,
      cancellable: records.filter((record) => ['pending', 'running'].includes(agentStatus(record))).length,
      toolRegistered,
      serialDefault: true,
      managedPlanStatus: managedPlanStatus(records, toolRegistered),
    },
    managedExecutionPlan: managedExecutionPlan(records, context, toolRegistry, sources.remote, includeParameters, sources.workItems),
    agents: filtered.map(({ entry, judgment }) => ({ ...(includeParameters ? entry.full : entry.summary), ...(judgment ? { judgment } : {}) })),
    judgments: selected.judgments,
    returned: filtered.length,
    total: records.length,
    decisionCards: agentOrchestrationDecisionCards(toolRegistered),
    modes: [...AGENT_TOOL_MODES],
    templates: [...AGENT_TEMPLATES],
    modelAccess: {
      list: 'agent { mode: "list" }',
      templates: 'agent { mode: "templates" }',
      spawn: 'agent { mode: "spawn" }',
      batchSpawn: 'agent { mode: "batch-spawn" }',
      inspect: 'agent { mode: "get" }',
      cancel: 'agent { mode: "cancel" }',
      harness: 'agent_harness mode:"agent_orchestration"',
    },
    policy: 'Read-only orchestration posture. Agent work must be visible, statused, cancellable, and tied to the user request; hidden fanout is blocked.',
  };
  const protectedResult = await protectOrchestrationOutput(result, { ...options, assertCurrent: assertQueryCurrent }, orchestrationWorkspaceDisplays.get(sources));
  assertQueryCurrent(); return protectedResult;
}

export async function describeAgentOrchestrationAgent(context: CommandContext, args: AgentHarnessAgentOrchestrationArgs, options: CatalogRankingOptions = {}): Promise<AgentOrchestrationResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const backend = captureOrchestrationBackend(context);
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'agent_orchestration_agent requires agentId, target, or query. Use mode:"agent_orchestration" to inspect visible agents.',
    };
  }
  const remoteSource = await captureOrchestrationPublisher(context, backend, options);
  const sources = orchestrationSources(context, backend.originalSources, undefined, remoteSource);
  const assertCurrent = retainOrchestrationSources(context, sources, options, backend.assertCurrent);
  const records = sources.records;
  if (!records) {
    return {
      status: 'missing_lookup',
      usage: 'Visible Agent orchestration requires an Agent manager in the runtime.',
    };
  }
  const entries = orchestrationEntries(sources);
  const exact = entries.find(({ record }) => agentId(record) === lookup.input);
  if (exact) {
    assertCurrent(); assertOrchestrationOriginalFloor(entries, backend); assertCurrent();
    if (!options.sourceOwner) throw new ToolInputProjectionError('held');
    const result = await protectOrchestrationOutput({ status: 'found', agent: args.includeParameters !== false ? exact.full : exact.summary },
      { ...options, assertCurrent }, orchestrationWorkspaceDisplays.get(sources));
    assertCurrent();
    if (result.status !== 'found') throw new ToolInputProjectionError('held');
    return { status: 'found', agent: orchestrationDisplayRecord(result.agent) };
  }
  const selected = lookup.source === 'agentId' ? { matches: [], judgments: [], assertProtectedCurrent: undefined }
    : await matchingAgents(entries, lookup.input, { ...options, assertCurrent }, backend, orchestrationWorkspaceDisplays.get(sources));
  const assertQueryCurrent = selected.assertProtectedCurrent ?? assertCurrent;
  assertQueryCurrent();
  const matches = selected.matches;
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment.reading.outcome === 'act') {
    const result = await protectOrchestrationOutput({ status: 'found', agent: { ...(args.includeParameters !== false ? matches[0]!.entry.full : matches[0]!.entry.summary), judgment: matches[0]!.judgment } }, { ...options, assertCurrent: assertQueryCurrent }, orchestrationWorkspaceDisplays.get(sources));
    assertQueryCurrent();
    if (result.status !== 'found') throw new ToolInputProjectionError('held');
    return { status: 'found', agent: orchestrationDisplayRecord(result.agent) };
  }
  if (matches.length > 0) {
    const result = await protectOrchestrationOutput({ status: 'ambiguous', input: lookup.input, candidates: matches.slice(0, 8).map(({ entry, judgment }) => ({ ...entry.summary, judgment })) }, { ...options, assertCurrent: assertQueryCurrent }, orchestrationWorkspaceDisplays.get(sources));
    assertQueryCurrent();
    if (result.status !== 'ambiguous' || result.input !== lookup.input || !Array.isArray(result.candidates)) throw new ToolInputProjectionError('held');
    return { status: 'ambiguous', input: lookup.input, candidates: result.candidates.map(orchestrationDisplayRecord) };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown visible agent ${lookup.input}. Use mode:"agent_orchestration" to inspect visible agents.`,
  };
}
