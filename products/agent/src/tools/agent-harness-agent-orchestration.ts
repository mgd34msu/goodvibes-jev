import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import type { WorkPlanItem } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { AGENT_TEMPLATES, AGENT_TOOL_MODES, agentOrchestrationDecisionCards } from './agent-harness-agent-orchestration-policy.ts';
import { remoteReadModelSnapshot, type RemoteCaptureOutcomeRecord, type RemoteWorkspaceEvidenceRecord } from './agent-harness-remote-read-models.ts';
import { previewHarnessText } from './agent-harness-text.ts';

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
    return [];
  }
}

function remoteContracts(context: CommandContext): readonly Record<string, unknown>[] {
  try {
    return context.ops.remoteRuntime?.listContracts().map((record) => record as unknown as Record<string, unknown>) ?? [];
  } catch {
    return [];
  }
}

function remotePools(context: CommandContext): readonly Record<string, unknown>[] {
  try {
    return context.ops.remoteRuntime?.listPools().map((record) => record as unknown as Record<string, unknown>) ?? [];
  } catch {
    return [];
  }
}

function remoteRuntimeArtifacts(context: CommandContext): readonly Record<string, unknown>[] {
  try {
    return context.ops.remoteRuntime?.listArtifacts().map((record) => record as unknown as Record<string, unknown>) ?? [];
  } catch {
    return [];
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
    return [];
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

function remoteRuntimeSnapshot(context: CommandContext): RemoteRuntimeSnapshot {
  const readModels = remoteReadModelSnapshot(context);
  return {
    pools: remotePools(context),
    contracts: remoteContracts(context),
    artifacts: remoteArtifacts(context),
    outcomes: readModels.outcomes,
    workspaces: readModels.workspaces,
    sourceCounts: readModels.sourceCounts,
  };
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
  ].map((value) => typeof value === 'string' ? value : String(value ?? '')).join('\n').toLowerCase();
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
    return [];
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
): Record<string, unknown> {
  const agentToolAvailable = agentToolRegistered(toolRegistry);
  const remoteToolAvailable = remoteToolRegistered(toolRegistry);
  const { pools, contracts, artifacts, outcomes, workspaces, sourceCounts } = remoteSnapshot;
  const contractsByRunner = contractByRunnerId(contracts);
  const artifactsByRunner = artifactsByRunnerId(artifacts);
  const outcomesByRunner = outcomesByRunnerId(outcomes);
  const workspacesByRunner = workspacesByRunnerId(workspaces);
  const workPlanByAgent = workPlanItemsByAgentId(workPlanItems(context));
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
        routes: ['delegation action:"status"', 'execution action:"status"', 'agent_harness mode:"agent_orchestration"', 'agent_work_plan action:"dispatch_agents" ids:["..."] confirm:true explicitUserRequest:"..."'],
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

export function agentOrchestrationSummary(context: CommandContext, toolRegistry: ToolRegistry, args: AgentHarnessAgentOrchestrationArgs): Record<string, unknown> {
  const records = exportAgents(context);
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
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const filtered = records
    .filter((record) => !query || agentSearchText(record).includes(query))
    .slice(0, readLimit(args.limit, 100));
  const remoteSnapshot = remoteRuntimeSnapshot(context);
  const contracts = contractByRunnerId(remoteSnapshot.contracts);
  const artifacts = artifactsByRunnerId(remoteSnapshot.artifacts);
  const outcomes = outcomesByRunnerId(remoteSnapshot.outcomes);
  const workspaces = workspacesByRunnerId(remoteSnapshot.workspaces);
  const workPlanByAgent = workPlanItemsByAgentId(workPlanItems(context));
  return {
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
    managedExecutionPlan: managedExecutionPlan(records, context, toolRegistry, remoteSnapshot, includeParameters),
    agents: filtered.map((record) => {
      const id = agentId(record);
      return describeAgent(record, includeParameters, contracts.get(id), artifacts.get(id) ?? [], outcomes.get(id) ?? [], workspaces.get(id) ?? [], workPlanByAgent.get(id) ?? []);
    }),
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
}

export function describeAgentOrchestrationAgent(context: CommandContext, args: AgentHarnessAgentOrchestrationArgs): AgentOrchestrationResolution {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'agent_orchestration_agent requires agentId, target, or query. Use mode:"agent_orchestration" to inspect visible agents.',
    };
  }
  const records = exportAgents(context);
  if (!records) {
    return {
      status: 'missing_lookup',
      usage: 'Visible Agent orchestration requires an Agent manager in the runtime.',
    };
  }
  const exact = records.find((record) => agentId(record) === lookup.input);
  const remoteSnapshot = remoteRuntimeSnapshot(context);
  const contracts = contractByRunnerId(remoteSnapshot.contracts);
  const artifacts = artifactsByRunnerId(remoteSnapshot.artifacts);
  const outcomes = outcomesByRunnerId(remoteSnapshot.outcomes);
  const workspaces = workspacesByRunnerId(remoteSnapshot.workspaces);
  const workPlanByAgent = workPlanItemsByAgentId(workPlanItems(context));
  if (exact) {
    const id = agentId(exact);
    return { status: 'found', agent: describeAgent(exact, args.includeParameters !== false, contracts.get(id), artifacts.get(id) ?? [], outcomes.get(id) ?? [], workspaces.get(id) ?? [], workPlanByAgent.get(id) ?? []) };
  }
  const normalized = lookup.input.toLowerCase();
  const matches = records.filter((record) => agentSearchText(record).includes(normalized));
  if (matches.length === 1) {
    const record = matches[0]!;
    const id = agentId(record);
    return { status: 'found', agent: describeAgent(record, args.includeParameters !== false, contracts.get(id), artifacts.get(id) ?? [], outcomes.get(id) ?? [], workspaces.get(id) ?? [], workPlanByAgent.get(id) ?? []) };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: matches.slice(0, 8).map((record) => {
        const id = agentId(record);
        return describeAgent(record, false, contracts.get(id), artifacts.get(id) ?? [], outcomes.get(id) ?? [], workspaces.get(id) ?? [], workPlanByAgent.get(id) ?? []);
      }),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown visible agent ${lookup.input}. Use mode:"agent_orchestration" to inspect visible agents.`,
  };
}
