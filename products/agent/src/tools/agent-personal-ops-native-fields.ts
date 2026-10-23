import type { StructuredRedactionOptions } from '@goodvibes-jev/engine/sdk/platform/utils';
import { captureOwnedJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { LANE_IDS } from './agent-harness-personal-ops-types.ts';

export const PERSONAL_OPS_EFFECT_RECEIPT_PURPOSES = new Set([
  'personal-ops-provider-effect-receipt', 'personal-ops-effect-receipt', 'personal-ops-connector-effect-receipt',
  'agent-personal-ops-effect-receipt', 'connected-host-personal-ops-effect-receipt',
]);
export const PERSONAL_OPS_REVIEW_PURPOSE = 'personal-ops-review-cards';
const NATIVE_METADATA_PURPOSES = new Set([
  ...PERSONAL_OPS_EFFECT_RECEIPT_PURPOSES, PERSONAL_OPS_REVIEW_PURPOSE, 'watcher-run-receipt',
  'watcher-receipt', 'automation-watcher-receipt',
  'agent-watcher-receipt', 'agent-watcher-run-receipt', 'connected-host-watcher-receipt', 'connected-host-watcher-run-receipt',
  'automation-run-history-receipt', 'durable-run-history-receipt', 'connected-host-automation-run-history-receipt', 'provider-source-record-receipt',
  'agent-memory-provider-receipt', 'connected-host-memory-provider-receipt', 'external-memory-provider-receipt',
  'goodvibes-memory-provider-receipt', 'memory-provider-receipt', 'external-memory-receipt',
  'remote-runner-artifact-receipt', 'remote-runner-closeout-receipt', 'remote-runner-export-receipt',
  'agent-remote-runner-artifact-receipt', 'agent-remote-runner-closeout-receipt', 'connected-host-remote-runner-artifact-receipt',
  'connected-host-remote-runner-closeout-receipt',
]);

/** Fields declared by the native artifact, orchestration, publisher and queue
 * DTOs. This contract applies only to protectPersonalOpsData's native callers;
 * arbitrary provider results and artifact metadata do not inherit these roles.
 * Unknown names stay withheld. A declaration never exempts a string from
 * credential screening or overrides a canonical secret/profile role. */
const NATIVE_FIELDS = new Set([
  'header', 'record', 'recordKind', 'recordId', 'records', 'entries', 'evidence', 'originalSources', 'nativeSnapshot',
  'selectedStatusText', 'selectedOutcomeText', 'sourcePath', 'sourceCounts', 'sourceCount', 'sourceTool', 'sourceId',
  'schema', 'schemaStatus', 'schemaVersion', 'receiptSchemaVersion', 'receiptSchemaStatus', 'certificationStatus',
  'contract', 'contractVersion', 'publication', 'publicationGuarantee', 'publisher', 'publisherId', 'daemonId', 'hostId',
  'receiptId', 'receiptIds', 'operationReceiptId', 'captureReceiptId', 'exportReceiptId', 'closeoutReceiptId', 'workspaceReceiptId',
  'cursor', 'freshnessCursor', 'sequence', 'checkpoint', 'provenance', 'certification', 'missingSignals',
  'createdAt', 'updatedAt', 'expiresAt', 'startedAt', 'completedAt', 'lastReadAt', 'lastWriteAt', 'lastSyncAt',
  'mimeType', 'filename', 'sizeBytes', 'sha256', 'acquisitionMode', 'fetchMode', 'purpose', 'laneId',
  'contentPath', 'metadataPath', 'sourceUri', 'lane', 'category', 'capability', 'capabilityTags', 'tags',
  'agents', 'agent', 'agentId', 'template', 'task', 'goal', 'detail', 'fullOutput', 'errorMessage',
  'parentId', 'parentAgentId', 'cohortId', 'toolCallCount', 'usage', 'inputTokens', 'outputTokens', 'cost',
  'pools', 'contracts', 'artifacts', 'outcomes', 'workspaces', 'runnerId', 'workspaceId', 'branch',
  'worktreeRef', 'isolationKind', 'captureId', 'exportId', 'artifactId', 'closeoutId',
  'plan', 'plans', 'managedPlans', 'workItems', 'executionPlan', 'planId', 'unitId', 'groupId',
  'successCriteria', 'requiredEvidence', 'writeScope', 'dependsOn', 'dependencies', 'criteria', 'checks',
  'routes', 'modelRoute', 'userRoute', 'readRoute', 'writeRoute', 'inspectRoute', 'inspectRoutes', 'receiptRoute',
  'refreshRoute', 'setupRoute', 'nextRoute', 'nextRoutes', 'cancelRoute', 'followUpRoutes', 'followUpOperation',
  'method', 'methodId', 'methodIds', 'operation', 'route', 'routeKind', 'path', 'qualifiedName',
  'providerId', 'provider', 'connectorId', 'connectorStatus', 'connectorSignals', 'serverName', 'toolName',
  'current', 'next', 'currentState', 'freshness', 'configured', 'reachable', 'ready', 'fresh', 'appliesTo',
  'tasks', 'approvals', 'automation', 'automationRuns', 'watchers', 'watcherReceipts', 'researchRuns', 'schedules',
  'runs', 'runId', 'workflowId', 'workflows', 'outputChunks', 'cancellable', 'deterministic',
  'providers', 'vector', 'vectorStats', 'doctor', 'liveRecords', 'liveRecord', 'receiptEvidence', 'receiptHistory',
  'latestReceipt', 'recordCount', 'dimensions', 'readReady', 'writeReady', 'syncReady', 'forgetReady',
  'syncRoute', 'forgetRoute', 'credentialState', 'credentialPolicy', 'confirmationPolicy', 'requiredHostContracts',
  'requiredFields', 'optionalFields', 'missingFields', 'sampleInput', 'inputSchema', 'input', 'fields',
  'description', 'label', 'title', 'summary', 'reason', 'why', 'userOutcome', 'failureReason',
  'policy', 'safetyBoundary', 'runBoundary', 'prerequisites', 'nextSteps', 'setupGuide', 'safeFirstStep',
  'original', 'underlying', 'full', 'progress', 'tools', 'context', 'judgment', 'judgments', 'returned',
  'running', 'pending', 'completed', 'failed', 'cancelled', 'toolRegistered', 'serialDefault', 'managedPlanStatus',
  'managedExecutionPlan', 'managedPlanCard', 'decisionCards', 'modes', 'templates', 'modelAccess',
  'milestones', 'milestoneId', 'planItemId', 'workPlanLinks', 'remoteContract', 'artifactTrail', 'liveOutcomeTrail',
  'workspaceEvidence', 'closeout', 'reviewGate', 'modelRoutes', 'nextAction', 'cancellableRoutes',
  'readModelOutcomes', 'linkedWorkPlanItems', 'dispatchReceipts', 'autoAttachedRemoteArtifacts', 'liveRemoteOutcomes',
  'remoteEvidence', 'liveOutcomes', 'runnerIds', 'spawn', 'batchSpawn', 'listAgents', 'remoteContracts',
  'remoteArtifacts', 'remoteReadModelOutcomes', 'list', 'inspect', 'cancel', 'harness', 'chooseWhen',
  'doNotUseWhen', 'saferRoutes',
  'workPlanItemCount', 'dispatchReceiptCount', 'remoteArtifactCount', 'remoteOutcomeCount', 'remoteReceiptCount',
  'workspaceEvidenceCount', 'autoAttachReason', 'reviewRoutes', 'updateRoutes', 'workPlanItems',
  'probability', 'reading', 'confidence', 'verdict', 'outcome', 'score', 'rank',
  'poolId', 'sourceTransport', 'trustClass', 'transportState', 'allowedTools', 'capabilityCeilingTools',
  'executionProtocol', 'reviewMode', 'communicationLane', 'orchestrationDepth', 'capabilityCeiling',
  'budget', 'wait', 'linkedAgentId', 'runner', 'sourceArtifactId', 'remoteArtifactId', 'exportArtifactId',
  'messageCount', 'errorCount', 'hasKnowledgeInjections', 'receipt', 'redaction', 'redactionPolicy',
  'effect', 'requiresConfirmation', 'confirmationRequired', 'lastReviewedAt', 'latestDispatchReceipt',
  'itemId', 'owner', 'markDone', 'markBlocked', 'decisionId', 'probabilities', 'question', 'criterion',
  'candidates', 'workspace', 'workspacePath',
  'lastUpdatedAt', 'transport', 'connectedAt', 'runnerContract', 'knowledgeInjections',
  'linked', 'notes', 'activePlan', 'workPlan', 'updatedBy',
  'researchFile',
  'sourceRecordId', 'reviewRecordCount', 'reviewLabels', 'reviewKinds', 'reviewRecordIds', 'fullRawConnectorOutputStored', 'payloadRedacted', 'recordedAt',
  'threads', 'messages', 'events', 'items', 'results', 'effectReceiptIds', 'threadId', 'messageId', 'eventId',
  'calendarId', 'taskId', 'reminderId', 'subject', 'from', 'labels', 'receivedAt', 'snippet', 'preview',
  'start', 'end', 'startsAt', 'endsAt', 'conflicts', 'attendees', 'organizer', 'location',
  'threadRoute', 'messageRoute', 'getThreadRoute', 'replyRoute', 'sendReplyRoute', 'draftReplyRoute',
  'sendRoute', 'sendMessageRoute', 'archiveRoute', 'labelRoute', 'applyLabelRoute',
  'eventRoute', 'getEventRoute', 'editRoute', 'updateRoute', 'rsvpRoute', 'deleteRoute',
  'getTaskRoute', 'getReminderRoute', 'getScheduleRoute', 'completeRoute', 'doneRoute', 'dismissRoute',
  'deferRoute', 'snoozeRoute', 'rescheduleRoute', 'dueAt', 'dueDate', 'scheduledAt', 'priority',
  'respondRoute', 'patchRoute', 'finishRoute',
  'backend', 'available', 'indexedRecords', 'embeddingProviderId', 'embeddingProviderLabel', 'platformLimitReason',
  'checkedAt', 'embeddings', 'activeProviderId', 'asyncProviders', 'syncProviders', 'warnings', 'local', 'hasSyncEmbed',
  'promptEligible', 'correlationId', 'capabilities', 'read', 'write', 'sync', 'forget', 'receipts',
  'promptPolicy', 'eligible', 'receiptStreamStatus', 'supermemory', 'mem0', 'zep',
  'reminders', 'project', 'remindAt', 'cadence', 'deliveryTarget',
  'source', 'state', 'enabled', 'metadata', 'outputPreview', 'outputTruncated', 'reviewRecords', 'inputFieldKeys', 'rawKeys', 'followUpBoundary',
  'totalWatchers', 'activeWatcherIds', 'totalDegraded', 'totalLagged',
  'parentTaskId', 'childTaskIds', 'queuedAt', 'endedAt', 'retryPolicy', 'retryDelayMs', 'retryAt',
  'currentAttempt', 'maxAttempts', 'baseDelayMs', 'maxDelayMs', 'backoffMultiplier', 'result', 'message',
  'jobs', 'totalJobs', 'totalRuns', 'activeRunIds', 'totalFailed', 'deliveryTotals', 'succeeded', 'deadLettered',
  'connectionState', 'activeClientIds', 'requestCount', 'clients', 'sessions', 'recentEvents', 'host', 'port',
  'version', 'phase', 'sourceIds', 'checkpoints', 'at', 'note', 'reportArtifactId', 'pausedAt', 'cancelledAt', 'failedAt',
  // Native AutomationJob/Run/Delivery/Source and RuntimeTask DTO fields.
  'mutationRevision', 'name', 'schedule', 'execution', 'delivery', 'failure',
  'nextRunAt', 'lastRunAt', 'lastRunId', 'runCount', 'successCount', 'failureCount',
  'pausedReason', 'deleteAfterRun', 'archivedAt', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  'llmCallCount', 'turnCount', 'modelId', 'reasoningSummaryPresent', 'jobId', 'triggeredBy',
  'target', 'scheduleKind', 'durationMs', 'forceRun', 'dueRun', 'attempt',
  'sessionId', 'routeId', 'continuationMode', 'executionIntent', 'deliveryIds', 'deliveryAttempts',
  'telemetry', 'error', 'cancelledReason', 'surfaceKind', 'address', 'mode',
  'targets', 'fallbackTargets', 'includeSummary', 'includeTranscript', 'includeLinks', 'replyToRouteId',
  'responseId', 'intervalMs', 'anchorAt', 'expression', 'timezone', 'staggerMs',
  'delayMs', 'strategy', 'jitterMs', 'action', 'maxConsecutiveFailures', 'cooldownMs',
  'deadLetterRouteId', 'disableAfterFailures', 'notifyRouteId', 'occurredAt', 'consecutiveFailures', 'autoDisabled',
  'surfaceId', 'externalId', 'sessionPolicy', 'threadPolicy', 'deliveryGuarantee', 'channelId',
  'lastSeenAt', 'bindingId', 'pinnedSessionId', 'preserveThread', 'createIfMissing', 'url',
  'requiresSourceOwner', 'prompt', 'modelProvider', 'fallbackModels', 'routing', 'reasoningEffort',
  'thinking', 'wakeMode', 'timeoutMs', 'toolAllowlist', 'autoApprove', 'sandboxMode',
  'allowUnsafeExternalContent', 'externalContentSource', 'lightContext', 'routeBindingId', 'watcherId', 'lastEventAt',
  'providerSelection', 'providerFailurePolicy', 'targetKind', 'createdBy', 'model', 'webhookUrl',
  'onFailure', 'backoff', 'retryOn', 'exitCode', 'turnId', 'revision',
  'queuedIds', 'runningIds', 'blockedIds', 'totalCreated', 'totalCompleted', 'totalCancelled',
  'maxConcurrency',
  // Native approval requests, audit entries and watcher read-model fields.
  'callId', 'tool', 'args', 'analysis', 'workingDirectory', 'attribution',
  'rememberOptions', 'classification', 'riskLevel', 'reasons', 'surface', 'blastRadius',
  'sideEffects', 'riskFamily', 'actor', 'actorSurface', 'request', 'requiresOwnerDecision',
  'claimedBy', 'claimedAt', 'resolvedAt', 'resolvedBy', 'decision', 'fixSessionId',
  'fixSessionError', 'audit', 'cmd', 'runHistory', 'sources', 'sourceKind',
  'scope', 'filter', 'lastCheckpoint', 'lastEventPreview', 'outputRoute', 'retryRoute',
  'triggerKind',
  'servers', 'stack', 'serverVersion', 'loadedModels', 'contextWindowTokens', 'toolSupport', 'resourcePressure',
  'memoryUsagePercent', 'startReceiptId', 'repairReceiptId', 'receiptStatus', 'startRoute', 'repairRoute', 'lastCheckedAt',
]);

export function personalOpsNativeFields(value: unknown): NonNullable<StructuredRedactionOptions['declaredFields']> {
  const fields: Array<{ path: string[]; kind: 'content' }> = [];
  const declared = new Set<string>();
  const visit = (entry: unknown, path: readonly string[]): void => {
    if (Array.isArray(entry)) { for (const child of entry) visit(child, [...path, '*']); return; }
    if (entry === null || typeof entry !== 'object') return;
    // An arbitrary artifact's metadata cannot adopt native DTO declarations.
    // Receipt/review discriminants and the exact native embedding-provider
    // metadata path select these schemas.
    if (path.at(-1) === 'metadata') {
      const purpose = (entry as Record<string, unknown>).purpose;
      const embeddingProvider = path.slice(-4).join('.') === 'embeddings.providers.*.metadata';
      const nativeWatcher = path.join('.') === 'nativeSnapshot.watchers.*.metadata'
        || path.join('.') === 'nativeSnapshot.watchers.*.source.metadata';
      if (!embeddingProvider && !nativeWatcher && (typeof purpose !== 'string' || !NATIVE_METADATA_PURPOSES.has(purpose.trim()))) return;
    }
    for (const [key, child] of Object.entries(entry)) {
      const childPath = [...path, key], identity = JSON.stringify(childPath);
      // sourceCounts is the native publisher's Record<source-path, count>.
      // Its exact keys are provenance identities, never inferred field roles.
      const sourceCount = path.at(-1) === 'sourceCounts' && typeof child === 'number' && Number.isSafeInteger(child) && child >= 0;
      const nativeServerKey = path.at(-1) === 'servers' && child !== null && typeof child === 'object' && !Array.isArray(child);
      const validLane = key !== 'laneId' || path.at(-1) !== 'metadata'
        || typeof child === 'string' && LANE_IDS.some(lane => lane === child.trim());
      if ((NATIVE_FIELDS.has(key) || sourceCount || nativeServerKey) && validLane && !declared.has(identity)) {
        fields.push({ path: childPath, kind: 'content' }); declared.add(identity);
      }
      visit(child, childPath);
    }
  };
  visit(value, []);
  // Native declarations are detached, immutable schema data. Retaining them
  // must not repeatedly traverse the complete schema at each text boundary;
  // the caller's separate original-producer guard remains authoritative.
  return captureOwnedJson(fields) as NonNullable<StructuredRedactionOptions['declaredFields']>;
}

/** The MCP text/structured result envelope and the Personal Ops record DTOs
 * have explicit content fields. Extension fields and arbitrary metadata retain
 * the canonical withholding policy; credentials always override declarations. */
export function personalOpsResultFields(value: unknown): NonNullable<StructuredRedactionOptions['declaredFields']> {
  const names = new Set(['content', 'structuredContent', 'type', 'text', 'messages', 'threads', 'events',
    'items', 'results', 'id', 'threadId', 'messageId', 'eventId', 'subject', 'title', 'label', 'summary',
    'from', 'to', 'receivedAt', 'snippet', 'body', 'start', 'end', 'startsAt', 'endsAt', 'attendees',
    'organizer', 'location', 'status', 'kind', 'sourceTool', 'followUpBoundary', 'rawKeys']);
  const fields: Array<{ path: string[]; kind: 'content' }> = [];
  const seen = new Set<string>();
  const visit = (entry: unknown, path: string[]): void => {
    if (Array.isArray(entry)) { for (const child of entry) visit(child, [...path, '*']); return; }
    if (!entry || typeof entry !== 'object') return;
    for (const [name, child] of Object.entries(entry)) {
      if (!names.has(name)) continue;
      const childPath = [...path, name], key = JSON.stringify(childPath);
      if (!seen.has(key)) { seen.add(key); fields.push({ path: childPath, kind: 'content' }); }
      visit(child, childPath);
    }
  };
  visit(value, []);
  return captureOwnedJson(fields) as NonNullable<StructuredRedactionOptions['declaredFields']>;
}
