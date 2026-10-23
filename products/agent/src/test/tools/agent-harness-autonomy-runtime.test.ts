import { setupPostureSummary } from '../../tools/agent-harness-setup-posture.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerAgentBrowserTool } from '../../tools/agent-browser-tool.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import { makeFixture, registerStubTool, expectRowsHaveCompactModelRoutes, executeHarnessJson, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


afterAll(cleanupResearchScreeningFixtures);

describe('agent_harness tool', () => {
let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
    resetAgentMcpCallRouteForTests();
    fixtureLog = new SqliteDecisionLog(':memory:');
    previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
  });
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });


  test.each(['summary', 'queue', 'item', 'researchItem', 'action'] as const)('exposes a visible autonomy queue with owners and cancel routes: %s', async surface => {
    setSystemTime(new Date('2026-10-13T15:00:01.000Z'));
    const fixture = makeFixture();
    const artifacts = new ArtifactStore({ rootDir: join(fixture.root, 'native-autonomy-artifacts') });
    Object.assign(fixture.context.platform, { artifactStore: artifacts });
    try {
      const now = 1_700_000_100_000;
      const watcherReceipt = await artifacts.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'watcher-run-receipt.json',
        text: JSON.stringify({ receipt: 'Gmail watcher event was captured with metadata-only redaction.' }),
        metadata: {
          purpose: 'connected-host-watcher-run-receipt',
          operation: 'gmail-message-trigger',
          status: 'succeeded',
          watcherId: 'watcher-gmail-inbox',
          runId: 'auto-run-receipt-1',
          providerId: 'gmail',
          triggerKind: 'gmail-message',
          correlationId: 'corr-watcher-1',
          redaction: 'metadata-only',
          payloadRedacted: true,
          sourceTool: 'mcp:gmail.watch',
          recordedAt: '2023-11-14T22:15:00.000Z',
        },
      });
      const researchRunRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const run = researchRunRegistry.create({
        title: 'Market map research',
        question: 'Which competitor research features need parity?',
        nextSteps: ['Read source queue'],
      });
      researchRunRegistry.start(run.id, 'Starting competitor map.');
      researchRunRegistry.checkpoint(run.id, {
        phase: 'reading',
        status: 'blocked',
        progress: 35,
        note: 'Waiting on source review before synthesis.',
        sourceIds: ['source-a'],
        nextSteps: ['Review source-a'],
      });
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      const automationSource = {
        id: 'schedule-source-live',
        kind: 'schedule',
        label: 'Daily operator brief',
        enabled: true,
        createdAt: now - 600_000,
        updatedAt: now - 60_000,
        metadata: {},
      };
      const automationExecution = {
        prompt: 'Summarize overnight operator posture.',
        target: { kind: 'background' },
      };
      const automationDelivery = {
        mode: 'surface',
        targets: [],
        fallbackTargets: [],
        includeSummary: true,
        includeTranscript: false,
        includeLinks: true,
      };
      const automationFailure = {
        action: 'retry',
        maxConsecutiveFailures: 3,
        cooldownMs: 60_000,
        retryPolicy: {
          maxAttempts: 2,
          delayMs: 30_000,
          strategy: 'fixed',
        },
      };
      const liveReadModels = {
        tasks: {
          getSnapshot: () => ({
            tasks: [
              {
                id: 'host-task-live',
                kind: 'scheduler',
                title: 'Deliver scheduled brief',
                status: 'running',
                owner: 'scheduler',
                cancellable: true,
                childTaskIds: [],
                queuedAt: now - 120_000,
                startedAt: now - 60_000,
                correlationId: 'corr-live',
              },
              {
                id: 'host-task-failed',
                kind: 'daemon',
                title: 'Retry failed sync',
                status: 'failed',
                owner: 'daemon',
                cancellable: false,
                childTaskIds: [],
                queuedAt: now - 300_000,
                startedAt: now - 240_000,
                endedAt: now - 180_000,
                error: 'network timeout token=host-secret-token',
                retryPolicy: {
                  maxAttempts: 3,
                  currentAttempt: 1,
                  delayMs: 60_000,
                  backoff: 'exponential',
                  retryOn: ['network'],
                },
                retryAt: now + 60_000,
              },
            ],
          }),
          subscribe: () => () => {},
        },
        automation: {
          getSnapshot: () => ({
            jobs: [{
              id: 'sched-live-1',
              labels: ['operator-brief'],
              createdAt: now - 600_000,
              updatedAt: now - 30_000,
              name: 'Daily operator brief',
              status: 'enabled',
              enabled: true,
              schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
              execution: automationExecution,
              delivery: automationDelivery,
              failure: automationFailure,
              source: automationSource,
              nextRunAt: now + 3_600_000,
              lastRunAt: now - 86_400_000,
              lastRunId: 'auto-run-1',
              runCount: 2,
              successCount: 1,
              failureCount: 1,
              deleteAfterRun: false,
            }],
            runs: [{
              id: 'auto-run-1',
              labels: ['operator-brief'],
              createdAt: now - 90_000,
              updatedAt: now - 15_000,
              jobId: 'sched-live-1',
              status: 'running',
              agentId: 'agent-live-1',
              triggeredBy: automationSource,
              target: { kind: 'background' },
              execution: automationExecution,
              scheduleKind: 'cron',
              queuedAt: now - 90_000,
              startedAt: now - 75_000,
              forceRun: false,
              dueRun: true,
              attempt: 2,
              sessionId: 'session-alpha',
              routeId: 'route-live-1',
              route: {
                id: 'route-live-1',
                kind: 'thread',
                surfaceKind: 'slack',
                surfaceId: 'surface-live-1',
                externalId: 'C0123',
                threadId: '1700000000.000100',
                channelId: 'C0123',
                sessionId: 'session-alpha',
                jobId: 'sched-live-1',
                runId: 'auto-run-1',
                title: 'Ops daily brief',
                lastSeenAt: now - 15_000,
                createdAt: now - 90_000,
                updatedAt: now - 15_000,
                metadata: {},
              },
              continuationMode: 'background',
              executionIntent: { mode: 'background', targetKind: 'background' },
              deliveryIds: ['delivery-live-1'],
              deliveryAttempts: [{
                id: 'delivery-live-1',
                runId: 'auto-run-1',
                jobId: 'sched-live-1',
                target: { kind: 'surface', surfaceKind: 'slack', routeId: 'route-live-1' },
                status: 'sent',
                startedAt: now - 20_000,
                endedAt: now - 18_000,
                responseId: 'message-live-1',
              }],
              modelId: 'gpt-4.1',
              providerId: 'openai',
              telemetry: {
                usage: {
                  inputTokens: 1200,
                  outputTokens: 300,
                  cacheReadTokens: 100,
                  cacheWriteTokens: 20,
                  reasoningTokens: 40,
                },
                llmCallCount: 2,
                toolCallCount: 5,
                turnCount: 3,
                modelId: 'gpt-4.1',
                providerId: 'openai',
                reasoningSummaryPresent: true,
                source: 'local-agent',
              },
            }],
            totalJobs: 1,
            totalRuns: 1,
            activeRunIds: ['auto-run-1'],
            totalFailed: 0,
            sourceCount: 1,
            deliveryTotals: { succeeded: 1, failed: 0, deadLettered: 0 },
          }),
          subscribe: () => () => {},
        },
        watchers: {
          runHistory: {
            getSnapshot: () => ({
              records: [{
                id: 'watcher-run-live-1',
                runId: 'watcher-run-live-1',
                watcherId: 'watcher-gmail-inbox',
                sourceId: 'gmail-source-live',
                providerId: 'gmail',
                triggerKind: 'gmail-message',
                status: 'running',
                correlationId: 'corr-watcher-live',
                lastCheckpoint: 'history-id-123',
                outputChunks: [
                  'Gmail watcher captured metadata token=watcher-secret-token',
                  { summary: 'Queued visible automation run for new support thread.' },
                ],
                outputRoute: 'watchers action:"output" runId:"watcher-run-live-1"',
                inspectRoute: 'watchers action:"show-run" runId:"watcher-run-live-1"',
                cancelRoute: 'watchers action:"cancel-run" runId:"watcher-run-live-1" confirm:true explicitUserRequest:"..."',
                retryRoute: 'watchers action:"retry-run" runId:"watcher-run-live-1" confirm:true explicitUserRequest:"..."',
                updatedAt: now - 12_000,
              }],
            }),
          },
        },
        gmail: {
          sources: {
            getSnapshot: () => ({
              sources: [{
                id: 'gmail-source-live',
                sourceId: 'gmail-source-live',
                watcherId: 'watcher-gmail-inbox',
                providerId: 'gmail',
                sourceKind: 'gmail',
                enabled: true,
                scope: 'inbox.metadata',
                filter: 'label:urgent token=source-secret-token',
                lastCheckpoint: 'history-id-123',
                lastEventPreview: 'New urgent message token=source-secret-token',
                inspectRoute: 'gmail_source action:"show" sourceId:"gmail-source-live"',
                refreshRoute: 'gmail_source action:"refresh" sourceId:"gmail-source-live"',
                updatedAt: now - 11_000,
              }],
            }),
          },
        },
        controlPlane: {
          getSnapshot: () => ({
            connectionState: 'connected',
            activeClientIds: ['operator-client'],
            requestCount: 1,
            errorCount: 0,
            host: '127.0.0.1',
            port: 3421,
            clients: [],
            approvals: [{
              id: 'approval-live-1',
              callId: 'call-live-1',
              sessionId: 'session-alpha',
              routeId: 'route-live-1',
              status: 'pending',
              request: {
                callId: 'call-live-1',
                tool: 'shell.exec',
                args: { cmd: 'git status --short' },
                category: 'execute',
                analysis: {
                  classification: 'shell-command',
                  riskLevel: 'high',
                  summary: 'Run git status for the workspace.',
                  reasons: ['The action runs a shell command through the connected host.'],
                  target: 'git status --short',
                  targetKind: 'command',
                  surface: 'shell',
                  blastRadius: 'project',
                },
              },
              createdAt: now - 45_000,
              updatedAt: now - 30_000,
              metadata: { source: 'test' },
              audit: [{
                id: 'audit-live-1',
                action: 'created',
                actor: 'agent',
                actorSurface: 'tui',
                createdAt: now - 45_000,
                note: 'approval requested',
              }],
            }],
            sessions: [],
            recentEvents: [],
          }),
          subscribe: () => () => {},
        },
      };
      Object.assign(readModels, {
        tasks: createStaticUiReadModel(liveReadModels.tasks.getSnapshot()),
        automation: createStaticUiReadModel(liveReadModels.automation.getSnapshot()),
        watchers: { runHistory: createStaticUiReadModel(liveReadModels.watchers.runHistory.getSnapshot()) },
        gmail: { sources: createStaticUiReadModel(liveReadModels.gmail.sources.getSnapshot()) },
        controlPlane: createStaticUiReadModel(liveReadModels.controlPlane.getSnapshot()),
      });

      if (surface === 'summary') {
        const summary = await executeHarnessJson<{
          readonly autonomyQueue?: { readonly items: number; readonly cancellable: number; readonly readOnly: boolean };
        }>(fixture, { mode: 'summary' });
        expect(summary.autonomyQueue?.items).toBeGreaterThanOrEqual(8);
        expect(summary.autonomyQueue?.cancellable).toBeGreaterThan(0);
        expect(summary.autonomyQueue?.readOnly).toBe(true);
        return;
      }

      if (surface === 'queue') {
        const queue = await executeHarnessJson<{
          readonly summary: { readonly items: number; readonly cancellable: number; readonly needsSetup: number };
          readonly queue: readonly {
            readonly queueItemId: string;
            readonly status: string;
            readonly owner: string;
            readonly cancellable: boolean;
            readonly current: string;
            readonly modelRoute: string;
            readonly inspectRoute: string;
            readonly cancelRoute?: string;
            readonly createRoute?: string;
            readonly liveRecords?: readonly {
              readonly id: string;
              readonly label: string;
              readonly status: string;
              readonly phase?: string;
              readonly summary: string;
              readonly progress?: number;
              readonly inspectRoute: string;
              readonly cancelRoute?: string;
              readonly checkpointRoute?: string;
              readonly pauseRoute?: string;
              readonly resumeRoute?: string;
              readonly logTail?: readonly string[];
              readonly output?: {
                readonly status: string;
                readonly route: string;
                readonly source: string;
                readonly preview?: string;
                readonly policy: string;
              };
              readonly diagnostics?: readonly string[];
              readonly sourceIds?: readonly string[];
              readonly nextSteps?: readonly string[];
              readonly availableControls?: readonly string[];
              readonly controls?: readonly {
                readonly id: string;
                readonly state: string;
                readonly effect: string;
                readonly confirmationRequired: boolean;
                readonly modelRoute?: string;
                readonly reason?: string;
              }[];
            }[];
          }[];
          readonly policy: string;
        }>(fixture, { mode: 'autonomy_queue', includeParameters: true });
        expect(queue.summary.items).toBeGreaterThanOrEqual(8);
        expect(queue.summary.cancellable).toBeGreaterThan(0);
        expect(queue.policy).toContain('Visible autonomy queue is read-only');
        expectRowsHaveCompactModelRoutes(queue.queue);

        const workPlan = queue.queue.find((item) => item.queueItemId === 'visible-work-plan');
        const researchRuns = queue.queue.find((item) => item.queueItemId === 'research-runs');
        const hostTasks = queue.queue.find((item) => item.queueItemId === 'connected-host-tasks');
        const approvals = queue.queue.find((item) => item.queueItemId === 'pending-approvals');
        const automation = queue.queue.find((item) => item.queueItemId === 'automation-runs');
        const autonomousScheduleRequests = queue.queue.find((item) => item.queueItemId === 'autonomous-schedule-requests');
        const schedules = queue.queue.find((item) => item.queueItemId === 'connected-schedules');
        const routines = queue.queue.find((item) => item.queueItemId === 'routine-schedule-promotions');
        expect(workPlan?.owner).toBe('agent');
        expect(workPlan?.cancellable).toBe(true);
        expect(workPlan?.cancelRoute).toContain('workplan-status');
        expect(researchRuns?.status).toBe('attention');
        expect(researchRuns?.liveRecords?.[0]?.id).toBe('market-map-research');
        expect(researchRuns?.liveRecords?.[0]?.status).toBe('blocked');
        expect(researchRuns?.liveRecords?.[0]?.progress).toBe(35);
        expect(researchRuns?.liveRecords?.[0]?.inspectRoute).toContain('research action:"run"');
        expect(researchRuns?.liveRecords?.[0]?.cancelRoute).toContain('research action:"cancel"');
        expect(researchRuns?.liveRecords?.[0]?.checkpointRoute).toContain('research action:"checkpoint"');
        expect(researchRuns?.liveRecords?.[0]?.pauseRoute).toContain('research action:"pause"');
        expect(researchRuns?.liveRecords?.[0]?.resumeRoute).toContain('research action:"resume"');
        expect(researchRuns?.liveRecords?.[0]?.availableControls).toContain('checkpoint');
        expect(researchRuns?.liveRecords?.[0]?.availableControls).toContain('pause');
        expect(researchRuns?.liveRecords?.[0]?.availableControls).toContain('resume');
        expect(researchRuns?.liveRecords?.[0]?.controls?.find((control) => control.id === 'cancel')?.modelRoute).toContain('research action:"cancel"');
        expect(researchRuns?.liveRecords?.[0]?.controls?.find((control) => control.id === 'pause')?.modelRoute).toContain('research action:"pause"');
        expect(researchRuns?.liveRecords?.[0]?.controls?.find((control) => control.id === 'resume')?.modelRoute).toContain('research action:"resume"');
        expect(researchRuns?.liveRecords?.[0]?.logTail?.join('\n')).toContain('Waiting on source review before synthesis.');
        expect(researchRuns?.liveRecords?.[0]?.sourceIds).toContain('source-a');
        expect(researchRuns?.liveRecords?.[0]?.nextSteps).toContain('Review source-a');
        expect(hostTasks?.status).toBe('attention');
        expect(hostTasks?.cancellable).toBe(true);
        expect(hostTasks?.cancelRoute).toContain('tasks.cancel');
        expect(hostTasks?.liveRecords?.[0]?.id).toBe('host-task-live');
        expect(hostTasks?.liveRecords?.[0]?.inspectRoute).toBe('/tasks show host-task-live');
        expect(hostTasks?.liveRecords?.[0]?.cancelRoute).toContain('tasks.cancel');
        expect(hostTasks?.liveRecords?.[0]?.availableControls).toContain('cancel');
        expect(hostTasks?.liveRecords?.[0]?.output?.status).toBe('route-only');
        expect(hostTasks?.liveRecords?.[0]?.output?.route).toBe('/tasks output host-task-live');
        expect(hostTasks?.liveRecords?.[0]?.output?.source).toBe('not-published');
        expect(hostTasks?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('output route /tasks output host-task-live');
        expect(hostTasks?.liveRecords?.[0]?.controls?.find((control) => control.id === 'cancel')?.confirmationRequired).toBe(true);
        expect(hostTasks?.liveRecords?.[0]?.controls?.find((control) => control.id === 'cancel')?.modelRoute).toContain('tasks.cancel');
        const failedHostTask = hostTasks?.liveRecords?.find((record) => record.id === 'host-task-failed');
        expect(failedHostTask?.status).toBe('failed');
        expect(failedHostTask?.availableControls).toContain('retry');
        expect(failedHostTask?.controls?.find((control) => control.id === 'retry')?.modelRoute).toContain('tasks.retry');
        expect(failedHostTask?.logTail?.join('\n')).toContain('network timeout');
        expect(failedHostTask?.logTail?.join('\n')).not.toContain('host-secret-token');
        expect(failedHostTask?.output?.status).toBe('preview');
        expect(failedHostTask?.output?.route).toBe('/tasks output host-task-failed');
        expect(failedHostTask?.output?.source).toBe('runtime-task-error');
        expect(failedHostTask?.output?.preview).toContain('token=[REDACTED]');
        expect(failedHostTask?.output?.preview).not.toContain('host-secret-token');
        expect(failedHostTask?.diagnostics?.join('\n')).toContain('retry attempt 1/3');
        expect(failedHostTask?.diagnostics?.join('\n')).not.toContain('host-secret-token');
        expect(approvals?.owner).toBe('connected-host');
        expect(approvals?.status).toBe('attention');
        expect(approvals?.cancelRoute).toContain('approval-cancel');
        expect(approvals?.liveRecords?.[0]?.id).toBe('approval-live-1');
        expect(approvals?.liveRecords?.[0]?.status).toBe('pending');
        expect(approvals?.liveRecords?.[0]?.cancelRoute).toContain('approvals.cancel');
        expect(approvals?.liveRecords?.[0]?.availableControls).toContain('approve');
        expect(approvals?.liveRecords?.[0]?.controls?.find((control) => control.id === 'deny')?.modelRoute).toContain('approvals.deny');
        expect(approvals?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('approvals.approve');
        expect(approvals?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('approvals.deny');
        expect(automation?.status).toBe('active');
        expect(automation?.current).toContain('2 live watcher run/source record');
        expect(automation?.current).toContain('1 durable watcher/run receipt');
        expect(automation?.liveRecords?.[0]?.id).toBe('auto-run-1');
        expect(automation?.liveRecords?.[0]?.cancelRoute).toContain('automation.runs.cancel');
        expect(automation?.liveRecords?.[0]?.availableControls).toContain('cancel');
        expect(automation?.liveRecords?.[0]?.controls?.find((control) => control.id === 'retry')?.state).toBe('unavailable');
        expect(automation?.liveRecords?.[0]?.sourceIds).toContain('sched-live-1');
        expect(automation?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('telemetry usage input 1200 output 300');
        expect(automation?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('telemetry calls llm 2 tool 5 turns 3');
        expect(automation?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('delivery delivery-live-1 sent');
        const liveWatcherRun = automation?.liveRecords?.find((record) => record.id.includes('watcher-run-live-1'));
        expect(liveWatcherRun?.status).toBe('running');
        expect(liveWatcherRun?.phase).toBe('gmail-message');
        expect(liveWatcherRun?.inspectRoute).toContain('watchers action:"show-run"');
        expect(liveWatcherRun?.cancelRoute).toContain('watchers action:"cancel-run"');
        expect(liveWatcherRun?.availableControls).toContain('output');
        expect(liveWatcherRun?.availableControls).toContain('cancel');
        expect(liveWatcherRun?.controls?.find((control) => control.id === 'cancel')?.confirmationRequired).toBe(true);
        expect(liveWatcherRun?.controls?.find((control) => control.id === 'retry')?.state).toBe('unavailable');
        expect(liveWatcherRun?.output?.source).toBe('host-output-chunk');
        expect(liveWatcherRun?.output?.route).toContain('watchers action:"output"');
        expect(liveWatcherRun?.output?.preview).toContain('token=[REDACTED]');
        expect(liveWatcherRun?.output?.preview).not.toContain('watcher-secret-token');
        expect(liveWatcherRun?.sourceIds).toContain('watcher-gmail-inbox');
        expect(liveWatcherRun?.sourceIds).toContain('watcher-run-live-1');
        expect(liveWatcherRun?.diagnostics?.join('\n')).toContain('context.platform.readModels.watchers.runHistory');
        expect(liveWatcherRun?.diagnostics?.join('\n')).toContain('cancel route published');
        const liveSource = automation?.liveRecords?.find((record) => record.id.includes('watcher-source') && record.sourceIds?.includes('gmail-source-live'));
        expect(liveSource?.status).toBe('ready');
        expect(liveSource?.phase).toBe('gmail');
        expect(liveSource?.inspectRoute).toContain('gmail_source action:"show"');
        expect(liveSource?.availableControls).toEqual(['inspect', 'refresh']);
        expect(liveSource?.controls?.every((control) => control.effect === 'read-only')).toBe(true);
        expect(liveSource?.diagnostics?.join('\n')).toContain('filter label:urgent token=[REDACTED]');
        expect(liveSource?.diagnostics?.join('\n')).not.toContain('source-secret-token');
        expect(liveSource?.output?.source).toBe('provider-source-preview');
        expect(liveSource?.output?.preview).toContain('token=[REDACTED]');
        expect(liveSource?.output?.preview).not.toContain('source-secret-token');
        expect(liveSource?.diagnostics?.join('\n')).toContain('context.platform.readModels.gmail.sources');
        const watcherRecord = automation?.liveRecords?.find((record) => record.id === `watcher-receipt:${watcherReceipt.id}`);
        expect(watcherRecord?.status).toBe('succeeded');
        expect(watcherRecord?.phase).toBe('gmail-message');
        expect(watcherRecord?.summary).toContain('Redaction metadata-only');
        expect(watcherRecord?.summary).toContain('Payload redacted');
        expect(watcherRecord?.inspectRoute).toBe(`agent_artifacts show artifactId:"${watcherReceipt.id}" includeContent:false`);
        expect(watcherRecord?.availableControls).toEqual(['inspect', 'queue']);
        expect(watcherRecord?.controls?.every((control) => control.effect === 'read-only')).toBe(true);
        expect(watcherRecord?.sourceIds).toContain('watcher-gmail-inbox');
        expect(watcherRecord?.sourceIds).toContain('auto-run-receipt-1');
        expect(watcherRecord?.diagnostics?.join('\n')).toContain('purpose connected-host-watcher-run-receipt');
        expect(autonomousScheduleRequests?.modelRoute).toBe('schedule action:"create"');
        expect(autonomousScheduleRequests?.createRoute).toContain('successCriteria');
        expect(schedules?.status).toBe('active');
        expect(schedules?.cancellable).toBe(true);
        expect(schedules?.cancelRoute).toContain('schedule action:"pause"');
        expect(schedules?.liveRecords?.[0]?.id).toBe('sched-live-1');
        expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"run"');
        expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"edit"');
        expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"pause"');
        expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"delete"');
        expect(schedules?.liveRecords?.[0]?.cancelRoute).toContain('schedule action:"pause"');
        expect(schedules?.liveRecords?.[0]?.pauseRoute).toContain('schedule action:"pause"');
        expect(schedules?.liveRecords?.[0]?.availableControls).toContain('run');
        expect(schedules?.liveRecords?.[0]?.availableControls).toContain('pause');
        expect(schedules?.liveRecords?.[0]?.controls?.find((control) => control.id === 'pause')?.modelRoute).toContain('schedule action:"pause"');
        expect(schedules?.liveRecords?.[0]?.controls?.find((control) => control.id === 'delete')?.confirmationRequired).toBe(true);
        expect(schedules?.modelRoute).toContain('schedule action:"list|edit|run|pause|resume|delete"');
        expect(schedules?.createRoute).toContain('schedule action:"create"');
        expect(routines?.inspectRoute).toContain('schedule-receipts');
        return;
      }

      if (surface === 'item') {
        const item = await executeHarnessJson<{
          readonly queueItemId: string;
          readonly routes?: { readonly inspect: string; readonly cancel: string | null };
          readonly liveRecords?: readonly { readonly id: string; readonly cancelRoute?: string; readonly inspectRoute: string }[];
        }>(fixture, { mode: 'autonomy_queue_item', queueItemId: 'automation-runs' });
        expect(item.queueItemId).toBe('automation-runs');
        expect(item.routes?.cancel).toContain('automation-run-cancel');
        expect(item.liveRecords?.[0]?.id).toBe('auto-run-1');
        expect(item.liveRecords?.[0]?.cancelRoute).toContain('automation.runs.cancel');
        expect(item.liveRecords?.find((record) => record.id === `watcher-receipt:${watcherReceipt.id}`)?.inspectRoute).toContain('agent_artifacts show');
        return;
      }

      if (surface === 'researchItem') {
        const researchItem = await executeHarnessJson<{
          readonly queueItemId: string;
          readonly liveRecords?: readonly { readonly id: string; readonly logTail?: readonly string[] }[];
        }>(fixture, { mode: 'autonomy_queue_item', queueItemId: 'research-runs' });
        expect(researchItem.queueItemId).toBe('research-runs');
        expect(researchItem.liveRecords?.[0]?.id).toBe('market-map-research');
        expect(researchItem.liveRecords?.[0]?.logTail?.join('\n')).toContain('Waiting on source review before synthesis.');
        return;
      }

      if (surface === 'action') {
        const action = await executeHarnessJson<{
          readonly id: string;
          readonly modelRoute?: string;
        }>(fixture, { mode: 'workspace_action', actionId: 'personal-ops-autonomy-queue' });
        expect(action.id).toBe('personal-ops-autonomy-queue');
        expect(action.modelRoute).toBe('autonomy action:"queue"');
        return;
      }

    } finally {
      setSystemTime();
      fixture.cleanup();
    }
  });


  test('routes ongoing-work requests through a conservative autonomy intake selector', async () => {
    const fixture = makeFixture();
    try {
      const missing = await executeHarnessJson<{
        readonly status: string;
        readonly usage?: string;
        readonly queueRoute?: string;
      }>(fixture, { mode: 'autonomy_intake' });
      expect(missing.status).toBe('missing_request');
      expect(missing.usage).toContain('query');
      expect(missing.queueRoute).toBe('autonomy action:"queue"');

      const reminder = await executeHarnessJson<{
        readonly status: string;
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
          readonly missingFields?: readonly string[];
        };
        readonly policy: string;
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Remind me every 2 hours to check the deploy.',
        includeParameters: true,
      });
      expect(reminder.status).toBe('ready');
      expect(reminder.preferred.id).toBe('one-reminder-or-simple-recurring-reminder');
      expect(reminder.preferred.modelRoute).toContain('schedule action:"remind"');
      expect(reminder.preferred.modelRoute).toContain('scheduleKind:"every"');
      expect(reminder.preferred.modelRoute).toContain('scheduleValue:"2h"');
      expect(reminder.preferred.requiresConfirmation).toBe(true);
      expect(reminder.preferred.missingFields).toBeUndefined();
      expect(reminder.policy).toContain('Autonomy intake is read-only');

      const autonomousSchedule = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
          readonly userQuestion?: string;
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Run a daily operator report.',
        includeParameters: true,
      });
      expect(autonomousSchedule.preferred.id).toBe('confirmed-autonomous-schedule');
      expect(autonomousSchedule.preferred.modelRoute).toContain('schedule action:"create"');
      expect(autonomousSchedule.preferred.modelRoute).toContain('successCriteria');
      expect(autonomousSchedule.preferred.missingFields).toContain('scheduleValue');
      expect(autonomousSchedule.preferred.missingFields).toContain('successCriteria');
      expect(autonomousSchedule.preferred.userQuestion).toContain('success criteria');

      const routine = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
          readonly userQuestion?: string;
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Run the weekly operator report as a reviewed routine.',
        includeParameters: true,
      });
      expect(routine.preferred.id).toBe('reviewed-routine-schedule');
      expect(routine.preferred.modelRoute).toContain('promote routine');
      expect(routine.preferred.missingFields).toContain('routineId');
      expect(routine.preferred.missingFields).toContain('scheduleValue');
      expect(routine.preferred.userQuestion).toContain('reviewed routine');

      const control = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Cancel the running automation run.',
      });
      expect(control.preferred.id).toBe('automation-control');
      expect(control.preferred.modelRoute).toContain('queueItemId:"automation-runs"');
      expect(control.preferred.missingFields?.join('\n')).toContain('runId');

      const trigger = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
          readonly missingFields?: readonly string[];
          readonly userQuestion?: string;
          readonly setupRoutes?: readonly string[];
          readonly triggerWorkflowId?: string;
        };
        readonly triggerWorkflowSummary: {
          readonly ready: number;
          readonly attention: number;
          readonly watcherEvidenceContractStatus: string | null;
          readonly watcherEvidenceMissing: readonly string[];
        };
        readonly triggerWorkflows: readonly {
          readonly id: string;
          readonly status: string;
          readonly requiredFields: readonly string[];
          readonly evidence: Record<string, unknown>;
          readonly outcome?: {
            readonly target: string;
            readonly successCriteria: readonly string[];
            readonly evidenceFields: readonly string[];
            readonly verificationRoute: string;
          };
          readonly evidenceContract?: {
            readonly status: string;
            readonly owner: string;
            readonly contractChecklist: readonly {
              readonly id: string;
              readonly status: string;
            }[];
            readonly receiptContract: {
              readonly appliesTo: readonly string[];
              readonly requiredFields: readonly string[];
            };
            readonly providerSourceContract: {
              readonly supportedSourceKinds: readonly string[];
              readonly requiredFields: readonly string[];
              readonly policy: string;
            };
          };
          readonly policy: string;
        }[];
        readonly watcherEvidenceContract: {
          readonly status: string;
          readonly owner: string;
          readonly contractChecklist: readonly {
            readonly id: string;
            readonly status: string;
          }[];
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'When a webhook arrives from billing, run a triage brief.',
        includeParameters: true,
      });
      expect(trigger.preferred.id).toBe('visible-event-trigger-intake');
      expect(trigger.preferred.modelRoute).toContain('watchers.create');
      expect(trigger.preferred.requiresConfirmation).toBe(true);
      expect(trigger.preferred.missingFields?.join('\n')).toContain('trusted trigger source');
      expect(trigger.preferred.userQuestion).toContain('trusted event source');
      expect(trigger.preferred.setupRoutes?.join('\n')).toContain('watchers');
      expect(trigger.preferred.triggerWorkflowId).toBe('incoming-webhook-or-watcher');
      expect(trigger.triggerWorkflowSummary.ready).toBeGreaterThanOrEqual(2);
      expect(trigger.triggerWorkflowSummary.attention).toBeGreaterThanOrEqual(1);
      expect(trigger.triggerWorkflowSummary.watcherEvidenceContractStatus).toBe('contract-needed');
      expect(trigger.triggerWorkflowSummary.watcherEvidenceMissing).toContain('durable-run-history-records');
      expect(trigger.triggerWorkflowSummary.watcherEvidenceMissing).toContain('provider-source-records');
      expect(trigger.watcherEvidenceContract.status).toBe('contract-needed');
      expect(trigger.watcherEvidenceContract.owner).toBe('goodvibes-sdk-or-daemon');
      const watcher = trigger.triggerWorkflows.find((workflow) => workflow.id === 'incoming-webhook-or-watcher');
      expect(watcher?.status).toBe('ready');
      expect(watcher?.evidence.watcherCreatePublished).toBe(true);
      expect(watcher?.requiredFields.join('\n')).toContain('trusted trigger source');
      expect(watcher?.outcome?.target).toBe('created-visible-watcher');
      expect(watcher?.outcome?.successCriteria.join('\n')).toContain('watchers.create receipt');
      expect(watcher?.outcome?.evidenceFields).toContain('lastError');
      expect(watcher?.outcome?.verificationRoute).toContain('watchers.list');
      const watcherContract = watcher?.evidenceContract;
      expect(watcherContract?.status).toBe('contract-needed');
      expect(watcherContract?.owner).toBe('goodvibes-sdk-or-daemon');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'watcher-list-route')?.status).toBe('published-route');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'durable-run-history-records')?.status).toBe('missing');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'provider-source-records')?.status).toBe('missing');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'redacted-event-payloads')?.status).toBe('missing');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'queue-correlation-records')?.status).toBe('missing');
      expect(watcherContract?.receiptContract.appliesTo).toContain('watchers.create');
      expect(watcherContract?.receiptContract.requiredFields).toContain('runId');
      expect(watcherContract?.receiptContract.requiredFields).toContain('sourceId');
      expect(watcherContract?.receiptContract.requiredFields).toContain('sourceScope');
      expect(watcherContract?.receiptContract.requiredFields).toContain('lastCheckpoint');
      expect(watcherContract?.receiptContract.requiredFields).toContain('lastError');
      expect(watcherContract?.receiptContract.requiredFields).toContain('recoveryRoute');
      expect(watcherContract?.providerSourceContract.supportedSourceKinds).toContain('gmail');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('scope');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('filter');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('nextRoute');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('lastError');
      expect(watcherContract?.providerSourceContract.policy).toContain('never polls personal providers silently');
      expect(watcher?.policy).toContain('Incoming triggers are admin connected-host mutations');
      const gmail = trigger.triggerWorkflows.find((workflow) => workflow.id === 'gmail-or-email-trigger');
      expect(gmail?.status).toBe('attention');
      expect(gmail?.evidenceContract?.providerSourceContract.supportedSourceKinds).toContain('gmail');
      expect(gmail?.policy).toContain('does not poll or read mail silently');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes a local-first execution posture before delegation', async () => {
    const fixture = makeFixture();
    try {
      for (const name of ['read', 'edit', 'exec', 'fetch', 'web_search']) registerStubTool(fixture.toolRegistry, name);

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly localFirstPolicy: string;
          readonly delegationPolicy: string;
          readonly browserControl: string;
          readonly executionHistory: string;
          readonly backgroundProcesses: string;
          readonly browserControlSetup: {
            readonly status: string;
            readonly setupRoute: string;
            readonly recommendedRoute: string;
            readonly toolMatches: readonly string[];
            readonly needsReview: boolean;
            readonly workflows: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string; readonly safety: string }[];
            readonly setupChecklist: readonly string[];
            readonly fallbackRoutes: readonly string[];
          };
          readonly sudoPosture: {
            readonly status: string;
            readonly setupRoute: string;
            readonly credentialSignal: {
              readonly checked: string;
              readonly rawValueReturned: boolean;
              readonly valueUsableForBackgroundProcess: boolean;
            };
            readonly blockedRoutes: readonly { readonly id: string }[];
          };
          readonly supervision: {
            readonly processMonitorAvailable: boolean;
            readonly liveTailAvailable: boolean;
            readonly toolInspectorAvailable: boolean;
          };
          readonly delegationDecisionCards: readonly { readonly lane: string }[];
          readonly registeredExecutionTools: readonly string[];
        };
        readonly decisionRules: readonly string[];
        readonly routes: readonly {
          readonly executionRouteId: string;
          readonly availability: string;
          readonly modelRoute: string;
          readonly nextStep?: string;
          readonly recoveryRoute?: string;
          readonly supervisionRoutes?: readonly {
            readonly id: string;
            readonly available: boolean;
            readonly modelRoute: string;
          }[];
        }[];
      }>(fixture, {
        mode: 'execution_posture',
        includeParameters: true,
      });
      expect(posture.summary.localFirstPolicy).toContain('Use local read/edit/exec');
      expect(posture.summary.delegationPolicy).toContain('isolation');
      expect(posture.summary.backgroundProcesses).toContain('execution action:"processes"');
      expect(posture.summary.browserControl).toBe('setup-needed');
      expect(posture.summary.executionHistory).toContain('execution action:"history"');
      expect(posture.summary.browserControlSetup.setupRoute).toContain('browser-desktop-control');
      expect(posture.summary.browserControlSetup.recommendedRoute).toContain('mcp_servers');
      expect(posture.summary.browserControlSetup.needsReview).toBe(false);
      expect(posture.summary.browserControlSetup.workflows[0]?.id).toBe('browser-navigation');
      expect(posture.summary.browserControlSetup.workflows[0]?.status).toBe('setup-needed');
      expect(posture.summary.browserControlSetup.workflows[0]?.inspectRoute).toContain('setup action:"item"');
      expect(posture.summary.browserControlSetup.setupChecklist.join('\n')).toContain('constrained trust');
      expect(posture.summary.browserControlSetup.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(posture.summary.sudoPosture.status).toContain('foreground');
      expect(posture.summary.sudoPosture.setupRoute).toContain('sudo-execution-posture');
      expect(posture.summary.sudoPosture.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(posture.summary.sudoPosture.credentialSignal.rawValueReturned).toBe(false);
      expect(posture.summary.sudoPosture.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(posture.summary.sudoPosture.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');
      expect(posture.summary.supervision.processMonitorAvailable).toBe(true);
      expect(posture.summary.supervision.liveTailAvailable).toBe(true);
      expect(posture.summary.registeredExecutionTools).toEqual(expect.arrayContaining(['read', 'edit', 'exec', 'fetch', 'web_search']));
      expect(posture.decisionRules.join('\n')).toContain('Do not delegate ordinary local implementation');

      const shell = posture.routes.find((route) => route.executionRouteId === 'local-shell-command');
      expect(shell?.availability).toBe('ready');
      expect(shell?.modelRoute).toBe('exec');
      expect(shell?.supervisionRoutes?.map((route) => route.id)).toEqual(expect.arrayContaining(['process-monitor', 'live-tail']));
      expect(shell?.supervisionRoutes?.find((route) => route.id === 'process-monitor')?.available).toBe(true);
      expect(shell?.supervisionRoutes?.find((route) => route.id === 'live-tail')?.modelRoute).toContain('workspace action:"open"');

      const edit = posture.routes.find((route) => route.executionRouteId === 'local-edit-write');
      expect(edit?.availability).toBe('ready');
      expect(edit?.modelRoute).toBe('edit/write');
      expect(edit?.recoveryRoute).toContain('execution action:"recovery"');

      const browser = posture.routes.find((route) => route.executionRouteId === 'browser-or-desktop-control');
      expect(browser?.availability).toBe('setup-needed');

      const inspectedBrowser = await executeHarnessJson<{
        readonly executionRouteId: string;
        readonly availability: string;
        readonly browserControl?: {
          readonly status: string;
          readonly workflows: readonly { readonly id: string; readonly status: string; readonly setupRoute: string }[];
          readonly policy: string;
        };
      }>(fixture, {
        mode: 'execution_route',
        executionRouteId: 'browser-or-desktop-control',
      });
      expect(inspectedBrowser.executionRouteId).toBe('browser-or-desktop-control');
      expect(inspectedBrowser.availability).toBe('setup-needed');
      expect(inspectedBrowser.browserControl?.workflows[0]?.status).toBe('setup-needed');
      expect(inspectedBrowser.browserControl?.workflows[0]?.setupRoute).toContain('browser-desktop-control');
      expect(inspectedBrowser.browserControl?.policy).toContain('no live UI control is assumed');

      const setupNeededPlan = await executeHarnessJson<{
        readonly mode: string;
        readonly status: string;
        readonly workflow: { readonly id: string; readonly status: string };
        readonly decision: { readonly status: string; readonly modelRoute: string };
        readonly fallbackRoutes: readonly string[];
        readonly policy: { readonly boundary: string };
      }>(fixture, {
        mode: 'browser_control_route',
        query: 'take a screenshot of the dashboard',
        includeParameters: true,
      });
      expect(setupNeededPlan.mode).toBe('browser_control_route');
      expect(setupNeededPlan.status).toBe('setup-needed');
      expect(setupNeededPlan.workflow.id).toBe('screenshot-observation');
      expect(setupNeededPlan.workflow.status).toBe('setup-needed');
      expect(setupNeededPlan.decision.status).toBe('setup-needed');
      expect(setupNeededPlan.decision.modelRoute).toContain('browser-desktop-control');
      expect(setupNeededPlan.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(setupNeededPlan.policy.boundary).toContain('never opens');

      const mcpApi = fixture.context.clients?.mcpApi as {
        listServerSecurity: () => readonly unknown[];
      };
      mcpApi.listServerSecurity = () => [{
        name: 'browser-stale',
        connected: true,
        trustMode: 'blocked',
        role: 'browser',
        schemaFreshness: 'stale',
        quarantineReason: null,
        quarantineDetail: null,
        allowedPaths: [],
        allowedHosts: ['browser.example.test'],
      }];
      const attentionPosture = await executeHarnessJson<{
        readonly summary: {
          readonly browserControl: string;
          readonly browserControlSetup: {
            readonly configured: boolean;
            readonly needsReview: boolean;
            readonly mcpServers: readonly { readonly name: string; readonly readiness: string }[];
            readonly workflows: readonly { readonly status: string; readonly inspectRoute: string }[];
          };
        };
      }>(fixture, { mode: 'execution_posture' });
      expect(attentionPosture.summary.browserControl).toBe('attention');
      expect(attentionPosture.summary.browserControlSetup.configured).toBe(false);
      expect(attentionPosture.summary.browserControlSetup.needsReview).toBe(true);
      expect(attentionPosture.summary.browserControlSetup.mcpServers[0]?.readiness).toBe('attention');
      expect(attentionPosture.summary.browserControlSetup.workflows[0]?.status).toBe('attention');

      const attentionPlan = await executeHarnessJson<{
        readonly status: string;
        readonly workflow: { readonly id: string; readonly status: string };
        readonly decision: { readonly id: string; readonly status: string; readonly modelRoute: string };
        readonly mcpCandidates: readonly { readonly serverName: string; readonly readiness: string; readonly inspectRoute: string }[];
      }>(fixture, { mode: 'browser_control_route', query: 'navigate browser to a logged-in page' });
      expect(attentionPlan.status).toBe('attention');
      expect(attentionPlan.workflow.id).toBe('browser-navigation');
      expect(attentionPlan.workflow.status).toBe('attention');
      expect(attentionPlan.decision.id).toBe('review-browser-control-connector');
      expect(attentionPlan.decision.status).toBe('review-connector-first');
      expect(attentionPlan.decision.modelRoute).toContain('mcp_server');
      expect(attentionPlan.mcpCandidates[0]?.serverName).toBe('browser-stale');
      expect(attentionPlan.mcpCandidates[0]?.readiness).toBe('attention');

      const attentionBrowserSetup = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(attentionBrowserSetup.setupItemId).toBe('browser-desktop-control');
      expect(attentionBrowserSetup.status).toBe('check');
      expect(attentionBrowserSetup.signals?.join('\n')).toContain('attention');

      // A tool merely NAMED like a browser tool must not change the posture:
      // capability comes from what a tool declares and what can be invoked,
      // never from what its name or description happens to say.
      registerStubTool(fixture.toolRegistry, 'browser_screenshot');
      const namedOnlyPosture = await executeHarnessJson<{
        readonly summary: { readonly browserControl: string };
      }>(fixture, { mode: 'execution_posture' });
      expect(namedOnlyPosture.summary.browserControl).not.toBe('ready');

      const browserRoot = makeProjectTempDir('goodvibes-harness-browser');
      registerAgentBrowserTool(fixture.toolRegistry, {
        screenshotDirectory: join(browserRoot, 'shots'),
        profileRoot: join(browserRoot, 'profiles'),
        homeDirectory: join(browserRoot, 'home'),
      });
      const configuredPosture = await executeHarnessJson<{
        readonly summary: {
          readonly browserControl: string;
          readonly browserControlSetup: {
            readonly declaredControlTools: readonly string[];
            readonly recommendedRoute: string;
            readonly workflows: readonly { readonly status: string; readonly inspectRoute: string }[];
          };
        };
        readonly routes: readonly {
          readonly executionRouteId: string;
          readonly availability: string;
        }[];
      }>(fixture, { mode: 'execution_posture' });
      expect(configuredPosture.summary.browserControl).toBe('ready');
      expect(configuredPosture.summary.browserControlSetup.declaredControlTools).toEqual(['browser']);
      expect(configuredPosture.summary.browserControlSetup.recommendedRoute).toContain('browser action:');
      expect(configuredPosture.summary.browserControlSetup.workflows[0]?.status).toBe('ready');
      expect(configuredPosture.summary.browserControlSetup.workflows[0]?.inspectRoute).toContain('browser action:');
      expect(configuredPosture.routes.find((route) => route.executionRouteId === 'browser-or-desktop-control')?.availability).toBe('ready');

      const configuredPlan = await executeHarnessJson<{
        readonly status: string;
        readonly workflow: { readonly id: string; readonly status: string };
        readonly decision: { readonly id: string; readonly status: string; readonly modelRoute: string; readonly nextStep: string };
        readonly toolCandidates: readonly { readonly toolName: string; readonly inspectRoute: string }[];
        readonly policy: { readonly confirmation: string };
      }>(fixture, { mode: 'browser_control_route', query: 'take screenshot of the browser page' });
      expect(configuredPlan.status).toBe('ready');
      expect(configuredPlan.workflow.id).toBe('screenshot-observation');
      expect(configuredPlan.workflow.status).toBe('ready');
      expect(configuredPlan.decision.id).toBe('inspect-configured-browser-control');
      expect(configuredPlan.decision.status).toBe('ready-to-inspect-tool');
      expect(configuredPlan.decision.modelRoute).toContain('browser action:');
      expect(configuredPlan.decision.nextStep).toContain('Call browser action:');
      expect(configuredPlan.toolCandidates[0]?.toolName).toBe('browser');
      expect(configuredPlan.toolCandidates[0]?.inspectRoute).toContain('mode:"tool"');
      expect(configuredPlan.policy.confirmation).toContain('tool-specific confirmation');

      const configuredBrowserSetup = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly modelRoute: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(configuredBrowserSetup.setupItemId).toBe('browser-desktop-control');
      expect(configuredBrowserSetup.status).toBe('ready');
      expect(configuredBrowserSetup.modelRoute).toContain('browser action:');
      expect(configuredBrowserSetup.signals?.join('\n')).toContain('browser');

      const delegated = posture.routes.find((route) => route.executionRouteId === 'delegation-isolation-parallel-remote');
      expect(delegated?.availability).toBe('ready');
      expect(delegated?.nextStep).toContain('delegation action:"status"');
      expect(posture.summary.delegationDecisionCards.map((card) => card.lane)).toEqual(expect.arrayContaining([
        'local-first',
        'tui-shared-session',
        'delegated-review',
        'remote-runner',
        'hidden-fanout-blocked',
      ]));

      const inspectedShell = await executeHarnessJson<{
        readonly executionRouteId: string;
        readonly availability: string;
        readonly safety: string;
        readonly useInsteadWhen?: string;
      }>(fixture, {
        mode: 'execution_route',
        executionRouteId: 'local-shell-command',
      });
      expect(inspectedShell.executionRouteId).toBe('local-shell-command');
      expect(inspectedShell.availability).toBe('ready');
      expect(inspectedShell.safety).toContain('foreground serial');
      expect(inspectedShell.safety).toContain('sudo');
      expect(inspectedShell.useInsteadWhen).toContain('execution action:"processes"');

      const inspectedDelegation = await executeHarnessJson<{
        readonly executionRouteId: string;
        readonly preferredWhen: string;
        readonly useInsteadWhen?: string;
        readonly delegationDecisionCards?: readonly {
          readonly id: string;
          readonly lane: string;
          readonly requiredFields: readonly string[];
          readonly confirmationBoundary: string;
        }[];
      }>(fixture, {
        mode: 'execution_route',
        executionRouteId: 'delegation-isolation-parallel-remote',
      });
      expect(inspectedDelegation.preferredWhen).toContain('remote host');
      expect(inspectedDelegation.useInsteadWhen).toContain('Use local read/edit/exec');
      expect(inspectedDelegation.delegationDecisionCards?.find((card) => card.lane === 'tui-shared-session')?.requiredFields.join('\n')).toContain('delegation reason');
      expect(inspectedDelegation.delegationDecisionCards?.find((card) => card.lane === 'hidden-fanout-blocked')?.confirmationBoundary).toContain('never confirmed');
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['posture', 'plan', 'capabilities', 'setupItem'] as const)('consumes certified daemon interactive runtime records for process PTY sudo and browser control posture: %s', async surface => {
    const fixture = makeFixture();
    try {
      for (const name of ['read', 'edit', 'exec']) registerStubTool(fixture.toolRegistry, name);
      const readModels = (fixture.context.platform as unknown as { readModels: Record<string, unknown> }).readModels;
      readModels.execution = {
        interactiveRuntime: {
          getSnapshot: () => ({
            processes: [{
              kind: 'process-output',
              id: 'runtime-process-1',
              processId: 'host-proc-1',
              pid: 4321,
              status: 'running',
              command: 'npm run dev --token=[REDACTED]',
              outputChunks: [{
                chunkId: 'chunk-1',
                stream: 'stdout',
                text: 'server ready token=[REDACTED]',
                bytes: 31,
                truncated: false,
                createdAt: '2026-06-08T12:00:00.000Z',
              }],
              routes: {
                inspect: 'execution action:"process" processId:"host-proc-1" includeParameters:true',
                log: 'process action:"log" processId:"host-proc-1"',
                write: 'process action:"write" processId:"host-proc-1" data:"..." confirm:true explicitUserRequest:"..."',
                kill: 'process action:"kill" processId:"host-proc-1" confirm:true explicitUserRequest:"..."',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.execution.process.v1',
              publicationGuarantee: 'daemon publishes live process chunks token=[REDACTED]',
              publisher: 'goodvibes-daemon',
              provenance: ['method processes.list', 'sourceTool execution.processRuntime'],
              updatedAt: '2026-06-08T12:00:00.000Z',
            }],
            ptySessions: [{
              kind: 'pty-session',
              id: 'pty-session-1',
              sessionId: 'pty-session-1',
              status: 'ready',
              command: 'python',
              outputChunks: [{ chunkId: 'pty-chunk-1', stream: 'stdout', text: '>>>', truncated: false }],
              routes: {
                inspect: 'agent_operator_method methodId:"terminal.sessions.get" sessionId:"pty-session-1"',
                input: 'agent_operator_method methodId:"terminal.sessions.input" sessionId:"pty-session-1" confirm:true explicitUserRequest:"..."',
                output: 'agent_operator_method methodId:"terminal.sessions.output" sessionId:"pty-session-1"',
                close: 'agent_operator_method methodId:"terminal.sessions.close" sessionId:"pty-session-1" confirm:true explicitUserRequest:"..."',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.execution.pty-session.v1',
              publicationGuarantee: 'daemon publishes typed PTY sessions secret=[REDACTED]',
              publisher: 'goodvibes-daemon',
              provenance: ['method terminal.sessions.list', 'sourceTool terminal.sessions'],
              updatedAt: '2026-06-08T12:00:01.000Z',
            }],
            sudoMediation: [{
              kind: 'sudo-mediation',
              id: 'sudo-contract-1',
              status: 'ready',
              rawSecretReturned: false,
              routes: {
                inspect: 'agent_operator_method methodId:"credentials.sudo.status"',
                credential: 'agent_operator_method methodId:"credentials.sudo.prompt" confirm:true explicitUserRequest:"..."',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.execution.sudo-mediation.v1',
              publicationGuarantee: 'daemon mediates sudo prompts password=[REDACTED]',
              publisher: 'goodvibes-daemon',
              provenance: ['method credentials.sudo.status', 'sourceTool credential-mediation'],
              updatedAt: '2026-06-08T12:00:02.000Z',
            }],
          }),
        },
      };
      readModels.computer = {
        browserDesktopReceipts: {
          getSnapshot: () => ({
            receipts: [{
              kind: 'browser-desktop-receipt',
              id: 'browser-receipt-1',
              receiptId: 'browser-command-1',
              action: 'screenshot',
              surface: 'browser',
              status: 'succeeded',
              summary: 'Captured browser page secret=[REDACTED]',
              routes: {
                inspect: 'computer action:"control" includeParameters:true',
                execute: 'agent_operator_method methodId:"browser.control.execute" confirm:true explicitUserRequest:"..."',
                receipt: 'agent_operator_method methodId:"browser.control.receipts"',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.computer.browser-control-receipt.v1',
              publicationGuarantee: 'daemon publishes browser control receipts token=[REDACTED]',
              publisher: 'goodvibes-daemon',
              provenance: ['method browser.control.receipts', 'sourceTool browser.control'],
              updatedAt: '2026-06-08T12:00:03.000Z',
            }],
          }),
        },
      };

      if (surface === 'posture') {
        const posture = await executeHarnessJson<{
          readonly summary: {
            readonly browserControl: string;
            readonly browserControlSetup: {
              readonly status: string;
              readonly recommendedRoute: string;
              readonly certifiedRuntimeRecords: readonly {
                readonly receiptId?: string;
                readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] };
              }[];
            };
            readonly interactiveRuntime: {
              readonly status: string;
              readonly certifiedRecordCount: number;
              readonly liveProcessOutput: { readonly status: string; readonly latest?: { readonly outputChunks?: readonly { readonly text: string }[]; readonly certification: { readonly missingSignals: readonly string[] } } };
              readonly ptySessions: { readonly status: string };
              readonly sudoMediation: { readonly status: string };
              readonly browserDesktopControl: { readonly status: string };
            };
          };
          readonly routes: readonly { readonly executionRouteId: string; readonly availability: string }[];
          readonly decisionRules: readonly string[];
        }>(fixture, { mode: 'execution_posture', includeParameters: true });
        expect(posture.summary.interactiveRuntime.status).toBe('certified-live-runtime');
        expect(posture.summary.interactiveRuntime.certifiedRecordCount).toBe(4);
        expect(posture.summary.interactiveRuntime.liveProcessOutput.status).toBe('certified');
        expect(posture.summary.interactiveRuntime.liveProcessOutput.latest?.outputChunks?.[0]?.text).toContain('token=<redacted>');
        expect(posture.summary.interactiveRuntime.liveProcessOutput.latest?.certification.missingSignals).toEqual([]);
        expect(posture.summary.interactiveRuntime.ptySessions.status).toBe('certified');
        expect(posture.summary.interactiveRuntime.sudoMediation.status).toBe('certified');
        expect(posture.summary.interactiveRuntime.browserDesktopControl.status).toBe('certified');
        expect(posture.summary.browserControl).toBe('ready');
        expect(posture.summary.browserControlSetup.recommendedRoute).toContain('browser.control.execute');
        expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.receiptId).toBe('browser-command-1');
        expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.certification.schemaStatus).toBe('certified');
        expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
        expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.certification.missingSignals).toEqual([]);
        expect(posture.routes.find((route) => route.executionRouteId === 'browser-or-desktop-control')?.availability).toBe('ready');
        expect(posture.decisionRules.join('\n')).toContain('certified SDK/daemon runtime records');
        expect(JSON.stringify(posture)).not.toContain('host-secret');
        expect(JSON.stringify(posture)).not.toContain('chunk-secret');
        expect(JSON.stringify(posture)).not.toContain('sudo-secret');
        expect(JSON.stringify(posture)).not.toContain('browser-token');
        return;
      }

      if (surface === 'plan') {
        const plan = await executeHarnessJson<{
          readonly status: string;
          readonly decision: { readonly status: string; readonly modelRoute: string };
          readonly posture: { readonly certifiedRuntimeRecords: readonly { readonly id: string }[] };
        }>(fixture, { mode: 'browser_control_route', query: 'take a browser screenshot', includeParameters: true });
        expect(plan.status).toBe('ready');
        expect(plan.decision.status).toBe('ready-to-inspect-tool');
        expect(plan.decision.modelRoute).toContain('browser.control.execute');
        expect(plan.posture.certifiedRuntimeRecords[0]?.id).toBe('browser-receipt-1');
        expect(JSON.stringify(plan)).not.toContain('host-secret');
        expect(JSON.stringify(plan)).not.toContain('chunk-secret');
        expect(JSON.stringify(plan)).not.toContain('sudo-secret');
        expect(JSON.stringify(plan)).not.toContain('browser-token');
        return;
      }

      if (surface === 'capabilities') {
        const capabilities = await executeHarnessJson<{
          readonly capabilities: {
            readonly parity: readonly { readonly capability: string; readonly status: string }[];
            readonly interactiveRuntime: { readonly status: string; readonly certifiedRecordCount: number };
          };
        }>(fixture, { mode: 'run_background_process', processAction: 'capabilities' });
        expect(capabilities.capabilities.interactiveRuntime.status).toBe('certified-live-runtime');
        expect(capabilities.capabilities.interactiveRuntime.certifiedRecordCount).toBe(4);
        expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'process(write)')?.status).toBe('supported');
        expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'pty')?.status).toBe('contract-discovered');
        expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'sudo')?.status).toBe('contract-discovered');
        expect(JSON.stringify(capabilities)).not.toContain('host-secret');
        expect(JSON.stringify(capabilities)).not.toContain('chunk-secret');
        expect(JSON.stringify(capabilities)).not.toContain('sudo-secret');
        expect(JSON.stringify(capabilities)).not.toContain('browser-token');
        return;
      }

      if (surface === 'setupItem') {
        const setupItem = await executeHarnessJson<{
          readonly status: string;
          readonly signals?: readonly string[];
        }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
        expect(setupItem.status).toBe('ready');
        expect(setupItem.signals?.join('\n')).toContain('certified runtime receipts');
        expect(JSON.stringify(setupItem)).not.toContain('host-secret');
        expect(JSON.stringify(setupItem)).not.toContain('chunk-secret');
        expect(JSON.stringify(setupItem)).not.toContain('sudo-secret');
        expect(JSON.stringify(setupItem)).not.toContain('browser-token');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  test('manages tracked background processes through confirmed harness routes', async () => {
    const fixture = makeFixture();
    try {
      const empty = await executeHarnessJson<{
        readonly status: string;
        readonly summary: { readonly tracked: number; readonly running: number };
        readonly capabilities: {
          readonly start: string;
          readonly parity: readonly { readonly capability: string; readonly status: string; readonly modelRoute: string }[];
          readonly substrate: {
            readonly localProcessManager: {
              readonly supports: readonly string[];
              readonly stdinWrite: { readonly status: string; readonly missingAnyOf?: readonly string[] };
            };
            readonly daemonOperatorContract: {
              readonly status: string;
              readonly sessionInputRoutes: readonly { readonly methodId: string; readonly modelRoute: string }[];
            };
            readonly auditedTerms: readonly string[];
          };
          readonly pty: { readonly status: string };
          readonly stdinWrite: { readonly status: string; readonly modelRoute: string };
          readonly sudo: {
            readonly status: string;
            readonly setupRoute: string;
            readonly credentialSignal: {
              readonly checked: string;
              readonly rawValueReturned: boolean;
              readonly valueUsableForBackgroundProcess: boolean;
            };
            readonly blockedRoutes: readonly { readonly id: string }[];
          };
        };
      }>(fixture, { mode: 'background_processes', includeParameters: true });
      expect(empty.status).toBe('available');
      expect(empty.summary.tracked).toBe(0);
      expect(empty.capabilities.start).toContain('terminal command');
      expect(empty.capabilities.parity.find((entry) => entry.capability === 'process(wait)')?.status).toBe('supported');
      expect(empty.capabilities.parity.find((entry) => entry.capability === 'process(write)')?.status).toBe('supported');
      expect(empty.capabilities.substrate.localProcessManager.supports).toContain('spawn');
      expect(empty.capabilities.substrate.localProcessManager.stdinWrite.status).toBe('contract-discovered');
      expect(empty.capabilities.substrate.localProcessManager.stdinWrite.missingAnyOf ?? []).toEqual([]);
      expect(empty.capabilities.substrate.daemonOperatorContract.status).toContain('no-published-terminal');
      expect(empty.capabilities.substrate.daemonOperatorContract.sessionInputRoutes.map((route) => route.methodId)).toContain('sessions.inputs.list');
      expect(empty.capabilities.substrate.auditedTerms).toContain('sessions.inputs');
      expect(empty.capabilities.pty.status).toContain('not-yet-supported');
      expect(empty.capabilities.stdinWrite.status).toBe('supported');
      expect(empty.capabilities.stdinWrite.modelRoute).toContain('process action:"write"');
      expect(empty.capabilities.sudo.status).toContain('foreground');
      expect(empty.capabilities.sudo.setupRoute).toContain('sudo-execution-posture');
      expect(empty.capabilities.sudo.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(empty.capabilities.sudo.credentialSignal.rawValueReturned).toBe(false);
      expect(empty.capabilities.sudo.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(empty.capabilities.sudo.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');

      const nativeSpawn = spyOn(fixture.processManager, 'spawn');
      try {
        await expect(fixture.tool.execute({
        mode: 'run_background_process',
        processAction: 'start',
        command: 'printf ready',
        explicitUserRequest: 'Run a quick tracked command.',
        })).rejects.toBeInstanceOf(ToolInputProjectionError);
        expect(nativeSpawn).not.toHaveBeenCalled();
        expect(fixture.processManager.list()).toEqual([]);
      } finally { nativeSpawn.mockRestore(); }

      const started = await executeHarnessJson<{
        readonly status: string;
        readonly processId: string;
        readonly processSessionId: string;
        readonly sessionId: string;
        readonly session_id: string;
        readonly pid: number;
        readonly command: string;
        readonly routes: { readonly inspect: string; readonly poll: string; readonly log: string; readonly stop: string; readonly visibleMonitor: string };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'printf "hello"; printf "secret=abc123456" >&2',
        confirm: true,
        explicitUserRequest: 'Start a tracked background smoke command.',
      });
      expect(started.status).toBe('started');
      expect(started.processId).toMatch(/^bg_/);
      expect(started.processSessionId).toBe(started.processId);
      expect(started.sessionId).toBe(started.processId);
      expect(started.session_id).toBe(started.processId);
      expect(started.pid).toBeGreaterThan(0);
      expect(started.command).toContain('printf');
      expect(started.routes.inspect).toContain(started.processId);
      expect(started.routes.poll).toContain('process action:"poll"');
      expect(started.routes.log).toContain('process action:"log"');
      expect(started.routes.visibleMonitor).toContain('process-monitor');

      const waited = await executeHarnessJson<{
        readonly status: string;
        readonly process?: {
          readonly processId: string;
          readonly output?: {
            readonly stdoutTail: string;
            readonly stderrTail: string;
            readonly stdoutTruncated: boolean;
            readonly stderrTruncated: boolean;
            readonly fullOutputIncluded: boolean;
          };
        };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'wait',
        processId: started.processId,
        timeoutMs: 5000,
        confirm: true,
        explicitUserRequest: 'Wait for the tracked smoke command to finish.',
      });
      expect(waited.status).toBe('completed');
      expect(waited.process?.processId).toBe(started.processId);
      expect(waited.process?.output?.stdoutTail).toContain('hello');
      expect(waited.process?.output?.stderrTail).toContain('secret=[REDACTED]');
      expect(waited.process?.output?.stderrTail).not.toContain('abc123456');
      expect(waited.process?.output?.stdoutTruncated).toBe(false);
      expect(waited.process?.output?.stderrTruncated).toBe(false);
      expect(waited.process?.output?.fullOutputIncluded).toBe(true);

      const inspected = await executeHarnessJson<{
        readonly processId: string;
        readonly sessionId: string;
        readonly session_id: string;
        readonly status: string;
        readonly routes: { readonly log: string };
        readonly output?: { readonly stdoutTail: string; readonly stderrTail: string; readonly stdoutBytes: number; readonly stderrBytes: number; readonly maxOutputChars: number; readonly policy: string };
      }>(fixture, {
        mode: 'background_process',
        session_id: started.session_id,
      });
      expect(inspected.processId).toBe(started.processId);
      expect(inspected.sessionId).toBe(started.processId);
      expect(inspected.session_id).toBe(started.processId);
      expect(inspected.status).toBe('succeeded');
      expect(inspected.routes.log).toContain('process action:"log"');
      expect(inspected.output?.policy).toContain('redacted');
      expect(inspected.output?.stdoutBytes).toBeGreaterThan(0);
      expect(inspected.output?.stderrBytes).toBeGreaterThan(0);
      expect(inspected.output?.maxOutputChars).toBeGreaterThan(0);

      const polled = await executeHarnessJson<{
        readonly processId: string;
        readonly status: string;
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'poll',
        sessionId: started.sessionId,
      });
      expect(polled.processId).toBe(started.processId);
      expect(polled.status).toBe('succeeded');

      const logged = await executeHarnessJson<{
        readonly processId: string;
        readonly output?: { readonly stdoutTail: string; readonly stdoutTruncated: boolean; readonly fullOutputIncluded: boolean };
      }>(fixture, {
        mode: 'run_background_process',
        action: 'log',
        processSessionId: started.processSessionId,
      });
      expect(logged.processId).toBe(started.processId);
      expect(logged.output?.stdoutTail).toContain('hello');
      expect(logged.output?.stdoutTruncated).toBe(false);
      expect(logged.output?.fullOutputIncluded).toBe(true);

      const longStarted = await executeHarnessJson<{ readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'printf "%05000d" 0',
        confirm: true,
        explicitUserRequest: 'Start a tracked long-output smoke command.',
      });
      await executeHarnessJson(fixture, {
        mode: 'run_background_process',
        processAction: 'wait',
        processId: longStarted.processId,
        timeoutMs: 5000,
        confirm: true,
        explicitUserRequest: 'Wait for the tracked long-output smoke command.',
      });
      const longLogged = await executeHarnessJson<{
        readonly output?: {
          readonly stdoutTail: string;
          readonly stdoutChars: number;
          readonly stdoutTruncated: boolean;
          readonly omittedStdoutChars: number;
          readonly maxOutputChars: number;
          readonly fullOutputIncluded: boolean;
        };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'log',
        processId: longStarted.processId,
      });
      expect(longLogged.output?.stdoutChars).toBe(5000);
      expect(longLogged.output?.stdoutTail.length).toBeLessThanOrEqual(longLogged.output?.maxOutputChars ?? 0);
      expect(longLogged.output?.stdoutTruncated).toBe(true);
      expect(longLogged.output?.omittedStdoutChars).toBeGreaterThan(0);
      expect(longLogged.output?.fullOutputIncluded).toBe(false);

      const longStopped = await executeHarnessJson<{ readonly status: string; readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'kill',
        processId: longStarted.processId,
        confirm: true,
        explicitUserRequest: 'Remove the tracked long-output smoke command.',
      });
      expect(longStopped.status).toBe('stopped');
      expect(longStopped.processId).toBe(longStarted.processId);

      const stopped = await executeHarnessJson<{ readonly status: string; readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'kill',
        sessionId: started.sessionId,
        confirm: true,
        explicitUserRequest: 'Remove the tracked completed smoke command.',
      });
      expect(stopped.status).toBe('stopped');
      expect(stopped.processId).toBe(started.processId);
    } finally {
      fixture.cleanup();
    }
  });


  test('generated handles at a PAN-shaped epoch support registered terminal and process adapters', async () => {
    const fixture = makeFixture();
    try {
      const foreground = await fixture.toolRegistry.execute('terminal-foreground', 'terminal', {
        command: 'printf "foreground"',
      });
      expect(foreground.success).toBe(false);
      expect(foreground.error).toContain('background:true');

      // This epoch matches the PAN shape when written as decimal.
      // The ordinary producer must make an opaque handle that remains usable.
      const started = await (async () => {
        const clock = spyOn(Date, 'now').mockReturnValue(1_700_000_000_004);
        try {
          return await fixture.executeAdmittedCall('terminal-start', 'terminal', {
            command: 'printf "adapter-output"',
            background: true,
            confirm: true,
            explicitUserRequest: 'Start a tracked adapter smoke command.',
          });
        } finally { clock.mockRestore(); }
      })();
      expect(started.success).toBe(true);
      if (!started.success) throw new Error(started.error);
      const startedJson = JSON.parse(started.output ?? '{}') as {
        readonly status: string;
        readonly processId: string;
        readonly session_id: string;
        readonly routes: { readonly log: string; readonly poll: string; readonly stop: string };
      };
      expect(startedJson.status).toBe('started');
      expect(startedJson.processId).toBe('bg_b_bhaaaaaaaaaae');
      const polled = await fixture.executeAdmittedCall('process-poll', 'process', {
        action: 'poll', processId: startedJson.processId,
      });
      expect(polled.success).toBe(true);
      if (!polled.success) throw new Error(polled.error);
      expect(polled.output).toContain(startedJson.processId);
      expect(startedJson.routes.log).toContain('process action:"log"');
      expect(startedJson.routes.poll).toContain('process action:"poll"');

      const waited = await fixture.executeAdmittedCall('process-wait', 'process', {
        action: 'wait',
        session_id: startedJson.session_id,
        timeoutMs: 5000,
        confirm: true,
        explicitUserRequest: 'Wait for the tracked adapter smoke command.',
      });
      expect(waited.success).toBe(true);
      if (!waited.success) throw new Error(waited.error);
      const waitedJson = JSON.parse(waited.output ?? '{}') as { readonly status: string };
      expect(waitedJson.status).toBe('completed');

      const logged = await fixture.executeAdmittedCall('process-log', 'process', {
        action: 'log',
        sessionId: startedJson.processId,
      });
      expect(logged.success).toBe(true);
      if (!logged.success) throw new Error(logged.error);
      const loggedJson = JSON.parse(logged.output ?? '{}') as {
        readonly processId: string;
        readonly output?: { readonly stdoutTail: string; readonly stdoutTruncated: boolean; readonly fullOutputIncluded: boolean };
      };
      expect(loggedJson.processId).toBe(startedJson.processId);
      expect(loggedJson.output?.stdoutTail).toContain('adapter-output');
      expect(loggedJson.output?.stdoutTruncated).toBe(false);
      expect(loggedJson.output?.fullOutputIncluded).toBe(true);

      const listed = await fixture.executeAdmittedCall('process-list', 'process', { action: 'list' });
      expect(listed.success).toBe(true);
      if (!listed.success) throw new Error(listed.error);
      expect(listed.output).toContain(startedJson.processId);

      const terminalTool = await fixture.tool.execute({ mode: 'tool', toolName: 'terminal' });
      expect(terminalTool.success).toBe(true);
      if (!terminalTool.success) throw new Error(terminalTool.error);
      expect(terminalTool.output).toContain('"name": "terminal"');
      expect(terminalTool.output).toContain('"background"');

      const processTool = await fixture.tool.execute({ mode: 'tool', toolName: 'process' });
      expect(processTool.success).toBe(true);
      if (!processTool.success) throw new Error(processTool.error);
      expect(processTool.output).toContain('"name": "process"');
      expect(processTool.output).toContain('"action"');

      const stopped = await fixture.executeAdmittedCall('process-kill', 'process', {
        action: 'kill',
        processId: startedJson.processId,
        confirm: true,
        explicitUserRequest: 'Remove the tracked adapter smoke command.',
      });
      expect(stopped.success).toBe(true);
      if (!stopped.success) throw new Error(stopped.error);
      const stoppedJson = JSON.parse(stopped.output ?? '{}') as { readonly status: string; readonly processId: string };
      expect(stoppedJson.status).toBe('stopped');
      expect(stoppedJson.processId).toBe(startedJson.processId);
    } finally {
      fixture.cleanup();
    }
  });


  test('a literal legacy PAN-shaped process ID remains held at registered process ingress', async () => {
    const fixture = makeFixture();
    try {
      // Previously allocated handles are opaque inputs, never decoded or exempted.
      const processId = 'bg_1_1700000000004';
      let held: unknown;
      try { await fixture.toolRegistry.execute('process-pan-id', 'process', { action: 'poll', processId }); }
      catch (error) { held = error; }
      expect(held).toBeInstanceOf(ToolInputProjectionError);
      if (!(held instanceof ToolInputProjectionError)) throw new Error('Expected native process input projection refusal.');
      expect(held.problem).toBe('unavailable');
      expect(fixture.processManager.list()).toEqual([]);
      expect(String(held)).not.toContain(processId);
      expect(String(held)).not.toContain('1700000000004');
    } finally { fixture.cleanup(); }
  });


  test('reports unsupported PTY/stdin and blocks background sudo prompts', async () => {
    const fixture = makeFixture();
    try {
      const pty = await executeHarnessJson<{ readonly status: string; readonly capability: string; readonly guidance: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'python',
        pty: true,
      });
      expect(pty.status).toBe('unsupported');
      expect(pty.capability).toBe('pty');
      expect(pty.guidance).toContain('Interactive PTY');

      const write = await executeHarnessJson<{ readonly status: string; readonly usage: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'status',
        processId: 'bg_missing',
        data: 'y\n',
      });
      expect(write.status).toBe('missing_lookup');
      expect(write.usage).toContain('Unknown background process bg_missing');

      const stdin = spyOn(fixture.processManager, 'writeInput');
      try {
        await expect(fixture.admittedTool.execute({
        mode: 'run_background_process',
        processAction: 'write',
        sessionId: 'bg_missing',
        data: 'y\n',
        confirm: true,
        explicitUserRequest: 'Send y to the process.',
        })).rejects.toBeInstanceOf(ToolInputProjectionError);
        await expect(fixture.tool.execute({
        mode: 'run_background_process',
        processAction: 'write',
        sessionId: 'bg_missing',
        data: 'y\n',
        explicitUserRequest: 'Send y to the process.',
        })).rejects.toBeInstanceOf(ToolInputProjectionError);
        expect(stdin).not.toHaveBeenCalled();
        expect(fixture.processManager.list()).toEqual([]);
      } finally { stdin.mockRestore(); }

      const sudo = await executeHarnessJson<{
        readonly status: string;
        readonly capability: string;
        readonly reason: string;
        readonly guidance: {
          readonly setupRoute: string;
          readonly credentialSignal: { readonly rawValueReturned: boolean };
          readonly blockedRoutes: readonly { readonly id: string }[];
        };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'sudo true',
        confirm: true,
        explicitUserRequest: 'Try a sudo background command.',
      });
      expect(sudo.status).toBe('blocked');
      expect(sudo.capability).toBe('sudo');
      expect(sudo.reason).toContain('Background sudo prompts');
      expect(sudo.guidance.setupRoute).toContain('sudo-execution-posture');
      expect(sudo.guidance.credentialSignal.rawValueReturned).toBe(false);
      expect(sudo.guidance.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');

      const capabilities = await executeHarnessJson<{
        readonly status: string;
        readonly capabilities: {
          readonly parity: readonly { readonly capability: string; readonly status: string }[];
          readonly sudo: { readonly setupRoute: string; readonly credentialSignal: { readonly rawValueReturned: boolean } };
        };
        readonly policy: string;
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'capabilities',
      });
      expect(capabilities.status).toBe('available');
      expect(capabilities.capabilities.parity.map((entry) => entry.capability)).toContain('terminal(background=true)');
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'pty')?.status).toBe('blocked-contract-gap');
      expect(capabilities.capabilities.sudo.setupRoute).toContain('sudo-execution-posture');
      expect(capabilities.capabilities.sudo.credentialSignal.rawValueReturned).toBe(false);
      expect(capabilities.policy).toContain('read-only');
    } finally {
      fixture.cleanup();
    }
  });


  test('uses a discovered ProcessManager stdin method only after confirmation', async () => {
    const fixture = makeFixture();
    const writes: Array<{ readonly processId: string; readonly data: string }> = [];
    const nativeWriteInput = fixture.processManager.writeInput;
    const writeSpy = spyOn(fixture.processManager, 'writeInput').mockImplementation((processId, data, options) => {
      writes.push({ processId, data });
      return nativeWriteInput.call(fixture.processManager, processId, data, options);
    });
    try {
      const started = await executeHarnessJson<{ readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'sleep 5',
        confirm: true,
        explicitUserRequest: 'Start a process that can receive input.',
      });
      expect(fixture.processManager.getStatus(started.processId)?.done).toBe(false);

      const capabilities = await executeHarnessJson<{
        readonly capabilities: {
          readonly parity: readonly { readonly capability: string; readonly status: string }[];
          readonly stdinWrite: { readonly status: string; readonly guidance: string };
          readonly substrate: { readonly localProcessManager: { readonly stdinWrite: { readonly method: string; readonly executableByHarness: boolean } } };
        };
      }>(fixture, { mode: 'run_background_process', processAction: 'capabilities' });
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'process(write)')?.status).toBe('supported');
      expect(capabilities.capabilities.stdinWrite.status).toBe('supported');
      expect(capabilities.capabilities.stdinWrite.guidance).toContain('current recorded admission');
      expect(capabilities.capabilities.substrate.localProcessManager.stdinWrite.method).toBe('writeInput');
      expect(capabilities.capabilities.substrate.localProcessManager.stdinWrite.executableByHarness).toBe(true);

      const wrote = await executeHarnessJson<{
        readonly status: string;
        readonly processId: string;
        readonly bytesWritten: number;
        readonly policy: string;
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'write',
        processId: started.processId,
        data: 'yes\n',
        confirm: true,
        explicitUserRequest: 'Send yes to the running process.',
      });
      expect(wrote.status).toBe('written');
      expect(wrote.processId).toBe(started.processId);
      expect(wrote.bytesWritten).toBe(4);
      expect(writes).toEqual([{ processId: started.processId, data: 'yes\n' }]);
      expect(JSON.stringify(wrote)).not.toContain('yes');
      expect(wrote).not.toHaveProperty('data');
      expect(wrote).not.toHaveProperty('result');
      expect(fixture.processManager.getOutput(started.processId)?.stdout).not.toContain('yes');
      expect(wrote.policy).toContain('captured native stdin pipe');

      const stopped = await executeHarnessJson<{ readonly status: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'kill',
        processId: started.processId,
        confirm: true,
        explicitUserRequest: 'Stop the stdin-capable test process.',
      });
      expect(stopped.status).toBe('stopped');
    } finally {
      writeSpy.mockRestore();
      fixture.cleanup();
    }
  });

  test('exposes local execution history records with supervision and recovery routes', async () => {
    const fixture = makeFixture();
    try {
      const now = Date.now();
      const target = join(fixture.root, 'history-edit.txt');
      writeFileSync(target, 'after', 'utf-8');
      fixture.context.workspace.fileUndoManager?.snapshot({
        path: target,
        beforeContent: 'before',
        afterContent: 'after',
        tool: 'edit',
      });
      fixture.executionRecords.push(
        {
          id: 'call-shell',
          callId: 'call-shell',
          turnId: 'turn-1',
          tool: 'exec',
          routeKind: 'shell',
          status: 'succeeded',
          phase: 'TOOL_SUCCEEDED',
          receivedAt: now - 2000,
          updatedAt: now - 1000,
          completedAt: now - 1000,
          durationMs: 1000,
          permissionApproved: true,
          argsPreview: '{"command":"bun test","pat":"[redacted]"}',
          argsKeys: ['command'],
          commandPreview: 'bun test src/test/tools/agent-harness-tool.test.ts',
          resultSummary: { kind: 'text', byteSize: 42, preview: '84 pass, 0 fail' },
        },
        {
          id: 'call-edit',
          callId: 'call-edit',
          turnId: 'turn-1',
          tool: 'edit',
          routeKind: 'write',
          status: 'succeeded',
          phase: 'TOOL_SUCCEEDED',
          receivedAt: now - 4000,
          updatedAt: now - 3000,
          completedAt: now - 3000,
          durationMs: 1000,
          argsPreview: '{"path":"history-edit.txt","content":"after"}',
          argsKeys: ['content', 'path'],
          targetPreview: 'history-edit.txt',
          resultSummary: { kind: 'json', byteSize: 18, preview: '{"ok":true}' },
        },
      );

      const summary = await executeHarnessJson<{
        readonly summary: {
          readonly records: number;
          readonly activityCards: number;
          readonly succeeded: number;
          readonly routeKinds: { readonly shell: number; readonly write: number };
        };
        readonly returnedActivityCards: number;
        readonly activityCards: readonly {
          readonly activityCardId: string;
          readonly title: string;
          readonly status: string;
          readonly outcome: string;
          readonly recordIds: readonly string[];
          readonly verification: {
            readonly status: string;
            readonly evidence: readonly { readonly executionRecordId: string; readonly outputPreview?: string }[];
          };
          readonly processOutput?: {
            readonly status: string;
            readonly evidence: readonly { readonly executionRecordId: string; readonly outputPreview?: string }[];
            readonly liveRoutes: readonly { readonly id: string }[];
          };
          readonly routes: {
            readonly fileRecovery?: string;
            readonly inspectLatest: string;
            readonly supervision: readonly { readonly id: string }[];
          };
          readonly nextAction: string;
        }[];
        readonly records: readonly {
          readonly executionRecordId: string;
          readonly tool: string;
          readonly routeKind: string;
          readonly commandPreview?: string;
          readonly argsPreview: string;
          readonly resultSummary?: { readonly preview?: string };
          readonly userCard?: {
            readonly activityCardId: string;
            readonly title: string;
            readonly verification: { readonly status: string };
          };
          readonly supervisionRoutes?: readonly { readonly id: string; readonly modelRoute: string }[];
          readonly recoveryRoute?: string;
        }[];
      }>(fixture, { mode: 'execution_history', includeParameters: true });
      expect(summary.summary.records).toBe(2);
      expect(summary.summary.activityCards).toBe(1);
      expect(summary.returnedActivityCards).toBe(1);
      expect(summary.summary.succeeded).toBe(2);
      expect(summary.summary.routeKinds.shell).toBe(1);
      expect(summary.summary.routeKinds.write).toBe(1);
      const card = summary.activityCards[0]!;
      expect(card.activityCardId).toBe('turn:turn-1');
      expect(card.title).toContain('bun test');
      expect(card.status).toBe('succeeded');
      expect(card.outcome).toContain('verification evidence');
      expect(card.recordIds).toEqual(['call-edit', 'call-shell']);
      expect(card.verification.status).toBe('passed');
      expect(card.verification.evidence.map((entry) => entry.executionRecordId)).toEqual(['call-shell']);
      expect(card.verification.evidence[0]?.outputPreview).toContain('84 pass');
      expect(card.processOutput?.status).toBe('bounded-summary-attached');
      expect(card.processOutput?.evidence[0]?.executionRecordId).toBe('call-shell');
      expect(card.processOutput?.liveRoutes.map((route) => route.id)).toEqual(['process-monitor', 'live-tail']);
      expect(card.routes.fileRecovery).toContain('execution action:"recovery"');
      expect(card.routes.inspectLatest).toContain('call-shell');
      expect(card.routes.supervision.map((route) => route.id)).toEqual(['process-monitor', 'live-tail']);
      expect(card.nextAction).toContain('No recovery action');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.commandPreview).toContain('bun test');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.argsPreview).toContain('[redacted]');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.resultSummary?.preview).toContain('84 pass');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.userCard?.activityCardId).toBe('record:call-shell');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.userCard?.verification.status).toBe('passed');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.supervisionRoutes?.map((route) => route.id)).toEqual(expect.arrayContaining(['process-monitor', 'live-tail']));
      expect(summary.records.find((record) => record.executionRecordId === 'call-edit')?.recoveryRoute).toContain('execution action:"recovery"');

      const searched = await executeHarnessJson<{
        readonly returnedActivityCards: number;
        readonly activityCards: readonly { readonly recordIds: readonly string[]; readonly verification: { readonly status: string } }[];
        readonly records: readonly { readonly executionRecordId: string }[];
      }>(fixture, { mode: 'execution_history', query: 'bun test' });
      expect(searched.records.map((record) => record.executionRecordId)).toEqual(['call-shell']);
      expect(searched.returnedActivityCards).toBe(1);
      expect(searched.activityCards[0]?.recordIds).toEqual(['call-shell']);
      expect(searched.activityCards[0]?.verification.status).toBe('passed');

      const inspected = await executeHarnessJson<{
        readonly executionRecordId: string;
        readonly userCard?: { readonly activityCardId: string; readonly title: string };
        readonly policy?: { readonly effect: string; readonly values: string };
        readonly modelAccess?: { readonly toolInspector: string; readonly fileRecovery: string };
        readonly lookup?: { readonly resolvedBy?: string };
      }>(fixture, { mode: 'execution_history_item', executionRecordId: 'call-edit' });
      expect(inspected.executionRecordId).toBe('call-edit');
      expect(inspected.userCard?.activityCardId).toBe('record:call-edit');
      expect(inspected.userCard?.title).toContain('history-edit.txt');
      expect(inspected.lookup?.resolvedBy).toBe('id');
      expect(inspected.policy?.effect).toBe('read-only');
      expect(inspected.policy?.values).toContain('redacted args');
      expect(inspected.modelAccess?.fileRecovery).toContain('execution action:"recovery"');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes confirmed local file edit recovery from FileUndoManager snapshots', async () => {
    const fixture = makeFixture();
    try {
      const target = join(fixture.root, 'recoverable.txt');
      writeFileSync(target, 'after content', 'utf-8');
      fixture.context.workspace.fileUndoManager?.snapshot({
        path: target,
        beforeContent: 'before content',
        afterContent: 'after content',
        tool: 'edit',
      });

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly fileRecovery?: { readonly undoDepth: number; readonly redoDepth: number };
        };
      }>(fixture, { mode: 'execution_posture' });
      expect(posture.summary.fileRecovery?.undoDepth).toBe(1);
      expect(posture.summary.fileRecovery?.redoDepth).toBe(0);

      const recovery = await executeHarnessJson<{
        readonly status: string;
        readonly summary: {
          readonly undoDepth: number;
          readonly redoDepth: number;
          readonly nextUndo?: { readonly path: string; readonly tool: string };
        };
        readonly actions: readonly { readonly recoveryAction: string; readonly available: boolean; readonly modelRoute: string }[];
      }>(fixture, { mode: 'file_recovery', includeParameters: true });
      expect(recovery.status).toBe('available');
      expect(recovery.summary.undoDepth).toBe(1);
      expect(recovery.summary.redoDepth).toBe(0);
      expect(recovery.summary.nextUndo).toMatchObject({ path: 'recoverable.txt', tool: 'edit' });
      expect(recovery.actions.find((action) => action.recoveryAction === 'undo')?.available).toBe(true);
      expect(recovery.actions.find((action) => action.recoveryAction === 'undo')?.modelRoute).toBe('agent_harness mode:"run_file_recovery"');

      const denied = await fixture.tool.execute({ mode: 'run_file_recovery', recoveryAction: 'undo' });
      expect(denied.success).toBe(false);
      if (denied.success) throw new Error('run_file_recovery unexpectedly succeeded without confirmation');
      expect(denied.error).toContain('recorded effect admission');

      const undo = await executeHarnessJson<{
        readonly status: string;
        readonly recoveryAction: string;
        readonly path: string;
        readonly tool: string;
        readonly summary: { readonly undoDepth: number; readonly redoDepth: number };
      }>(fixture, {
        mode: 'run_file_recovery',
        recoveryAction: 'undo',
        confirm: true,
        explicitUserRequest: 'Undo the last local file edit.',
      });
      expect(undo).toMatchObject({
        status: 'applied',
        recoveryAction: 'undo',
        path: 'recoverable.txt',
        tool: 'edit',
      });
      expect(readFileSync(target, 'utf-8')).toBe('before content');
      expect(undo.summary.undoDepth).toBe(0);
      expect(undo.summary.redoDepth).toBe(1);

      const redo = await executeHarnessJson<{
        readonly status: string;
        readonly recoveryAction: string;
        readonly path: string;
      }>(fixture, {
        mode: 'run_file_recovery',
        recoveryAction: 'redo',
        confirm: true,
        explicitUserRequest: 'Redo the last local file edit.',
      });
      expect(redo).toMatchObject({ status: 'applied', recoveryAction: 'redo', path: 'recoverable.txt' });
      expect(readFileSync(target, 'utf-8')).toBe('after content');
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['pairing_posture', 'media_posture'] as const)('retains native catalog state changed by an independent device producer: %s', async mode => {
    const fixture = makeFixture();
    let reached = false;
    fixture.configManager.setDynamic('ui.voiceEnabled', false);
    const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
    platform.readModels.device = { capabilities: { getSnapshot() {
      reached = true;
      fixture.configManager.setDynamic('ui.voiceEnabled', true);
      return { records: [] };
    } } };
    try {
      await expect(fixture.tool.execute({ mode })).rejects.toMatchObject({ problem: 'held' });
      expect(reached).toBe(true);
      expect(fixture.openedSurfaces).toEqual([]);
    } finally { fixture.cleanup(); }
  });


  test('setup retains native state changed while an independently owned child source is acquired', async () => {
    const fixture = makeFixture(), key = 'OPENAI_API_KEY', previous = process.env[key];
    process.env[key] = '';
    let reached = false;
    const api = fixture.context.clients!.mcpApi!;
    const list = api.listServerSecurity;
    api.listServerSecurity = (...args) => {
      reached = true; process.env[key] = 'synthetic-changed-during-child';
      return list.apply(api, args);
    };
    try {
      await expect(setupPostureSummary(fixture.context, {}, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
      expect(reached).toBe(true); expect(fixture.openedSurfaces).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      fixture.cleanup();
    }
  });
});
