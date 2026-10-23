import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { makeFixture, attachMemoryApi, executeHarnessJson, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


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


  test.each(['posture', 'workspace-actions'] as const)('surfaces Agent memory, vector recall, and external memory-provider posture: %s', async surface => {
    const fixture = makeFixture();
    try {
      attachMemoryApi(fixture);
      if (surface === 'workspace-actions') {
        const actions = await executeHarnessJson<{
          readonly actions: readonly { readonly id: string; readonly modelRoute?: string }[];
        }>(fixture, { mode: 'workspace_actions', categoryId: 'memory', query: 'memory posture' });
        expect(actions.actions.find((entry) => entry.id === 'memory-posture')?.modelRoute).toBe('memory action:"status"');
        return;
      }
      const summary = await executeHarnessJson<{
        readonly memoryPosture?: {
          readonly status?: string;
          readonly localMemories?: number;
          readonly promptActive?: number;
          readonly vector?: string;
          readonly embeddingProviders?: number;
          readonly externalProviderRecordsPublished?: boolean;
          readonly externalProviderSetupGuideStatus?: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryPosture?.status).toBe('ready');
      expect(summary.memoryPosture?.localMemories).toBe(1);
      expect(summary.memoryPosture?.promptActive).toBe(1);
      expect(summary.memoryPosture?.vector).toBe('ready');
      expect(summary.memoryPosture?.embeddingProviders).toBe(1);
      expect(summary.memoryPosture?.externalProviderRecordsPublished).toBe(false);
      expect(summary.memoryPosture?.externalProviderSetupGuideStatus).toBe('contract-needed');

      const posture = await executeHarnessJson<{
        readonly status: string;
        readonly localMemory: {
          readonly total: number;
          readonly promptActive: number;
          readonly routes: { readonly curator: string };
        };
        readonly vector: {
          readonly status: string;
          readonly indexedRecords: number;
          readonly rebuildRoute: string;
        };
        readonly embeddings: { readonly activeProviderId: string; readonly syncProviders: readonly string[] };
        readonly providers: readonly {
          readonly id: string;
          readonly kind: string;
          readonly status: string;
          readonly active?: boolean;
          readonly setupRoute?: string;
        }[];
        readonly externalMemory: {
          readonly status: string;
          readonly providerRecordsPublished: boolean;
          readonly setupGuideStatus?: string;
          readonly checkedProviders: readonly string[];
          readonly requiredHostContracts?: readonly string[];
          readonly contractChecklist?: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
          readonly receiptContract?: { readonly status: string; readonly requiredFields: readonly string[] };
          readonly nextRoutes?: readonly { readonly id: string; readonly modelRoute: string; readonly effect: string }[];
          readonly providerLookup?: string;
        };
        readonly nextActions: readonly string[];
        readonly policy: string;
      }>(fixture, { mode: 'memory_posture', includeParameters: true, limit: 20 });
      expect(posture.status).toBe('ready');
      expect(posture.localMemory.total).toBe(1);
      expect(posture.localMemory.promptActive).toBe(1);
      expect(posture.localMemory.routes.curator).toBe('memory action:"curator"');
      expect(posture.vector.status).toBe('ready');
      expect(posture.vector.indexedRecords).toBe(1);
      expect(posture.vector.rebuildRoute).toContain('memory-vector-rebuild');
      expect(posture.embeddings.activeProviderId).toBe('hashed-local');
      expect(posture.embeddings.syncProviders).toContain('hashed-local');
      expect(posture.providers.find((provider) => provider.id === 'hashed-local')?.active).toBe(true);
      expect(posture.providers.find((provider) => provider.id === 'honcho')?.status).toBe('not-published');
      expect(posture.providers.find((provider) => provider.id === 'mem0')?.setupRoute).toContain('host action:"capability"');
      expect(posture.externalMemory.status).toBe('not-published');
      expect(posture.externalMemory.providerRecordsPublished).toBe(false);
      expect(posture.externalMemory.setupGuideStatus).toBe('contract-needed');
      expect(posture.externalMemory.checkedProviders).toContain('supermemory');
      expect(posture.externalMemory.requiredHostContracts?.join('\n')).toContain('Credential reference');
      expect(posture.externalMemory.contractChecklist?.map((entry) => entry.id)).toContain('sync-receipts');
      expect(posture.externalMemory.contractChecklist?.find((entry) => entry.id === 'status-record')?.inspectRoute).toContain('host action:"capability"');
      expect(posture.externalMemory.receiptContract?.requiredFields).toContain('receiptId');
      expect(posture.externalMemory.receiptContract?.requiredFields).toContain('nextRoute');
      expect(posture.externalMemory.nextRoutes?.find((route) => route.id === 'inspect-one-provider')?.modelRoute).toContain('memory action:"provider"');
      expect(posture.externalMemory.providerLookup).toContain('memory action:"provider"');
      expect(posture.nextActions.join('\n')).toContain('memory action:"provider"');
      expect(posture.policy).toContain('read-only');

      const provider = await executeHarnessJson<{
        readonly id: string;
        readonly kind: string;
        readonly status: string;
        readonly active?: boolean;
        readonly dimensions?: number;
      }>(fixture, { mode: 'memory_provider', providerId: 'hashed-local' });
      expect(provider.id).toBe('hashed-local');
      expect(provider.kind).toBe('embedding');
      expect(provider.status).toBe('healthy');
      expect(provider.active).toBe(true);
      expect(provider.dimensions).toBe(384);

      const external = await executeHarnessJson<{
        readonly id: string;
        readonly kind: string;
        readonly status: string;
        readonly summary: string;
        readonly setupGuide?: {
          readonly status: string;
          readonly userOutcome: string;
          readonly safeFirstStep: string;
          readonly inspectRoutes: readonly string[];
          readonly nextRoutes: readonly { readonly id: string; readonly modelRoute: string; readonly effect: string }[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string; readonly requiredFor: string }[];
          readonly receiptContract: { readonly status: string; readonly appliesTo: readonly string[]; readonly requiredFields: readonly string[] };
          readonly requiredHostContracts: readonly string[];
          readonly credentialPolicy: string;
          readonly confirmationPolicy: string;
        };
      }>(fixture, { mode: 'memory_provider', providerId: 'supermemory' });
      expect(external.id).toBe('supermemory');
      expect(external.kind).toBe('external-memory');
      expect(external.status).toBe('not-published');
      expect(external.summary).toContain('not published');
      expect(external.setupGuide).toMatchObject({
        status: 'contract-needed',
      });
      expect(external.setupGuide?.userOutcome).toContain('Supermemory');
      expect(external.setupGuide?.safeFirstStep).toContain('Agent-local memory');
      expect(external.setupGuide?.inspectRoutes.join('\n')).toContain('host action:"capability"');
      expect(external.setupGuide?.nextRoutes.find((route) => route.id === 'inspect-host-capability')?.effect).toBe('read-only');
      expect(external.setupGuide?.contractChecklist.find((entry) => entry.id === 'confirmed-write-upsert')?.requiredFor).toContain('explicit user request');
      expect(external.setupGuide?.receiptContract.appliesTo).toContain('sync');
      expect(external.setupGuide?.receiptContract.requiredFields).toContain('failureReason');
      expect(external.setupGuide?.requiredHostContracts.join('\n')).toContain('Prompt-injection eligibility policy');
      expect(external.setupGuide?.credentialPolicy).toContain('raw API keys');
      expect(external.setupGuide?.confirmationPolicy).toContain('durable receipts');
      const query = 'the Supermemory external-memory provider';
      const selected = await executeHarnessJson<{ readonly id: string }>(fixture, { mode: 'memory_provider', query });
      expect(selected.id).toBe('supermemory');
      const searched = await executeHarnessJson<{ readonly providers: readonly { readonly id: string }[] }>(fixture, { mode: 'memory_posture', query });
      expect(searched.providers.map(provider => provider.id)).toEqual(['supermemory']);

    } finally {
      fixture.cleanup();
    }
  });


  test('surfaces supervised semantic memory refinement tasks and confirmed bounded runs', async () => {
    const fixture = makeFixture();
    try {
      const now = Date.now();
      const refinementTasks = [{
        id: 'kref-gap-1',
        spaceId: 'agent',
        subjectKind: 'node',
        subjectId: 'node-1',
        subjectTitle: 'Agent memory export',
        subjectType: 'memory',
        gapId: 'sem-gap-1',
        state: 'blocked',
        priority: 'high',
        trigger: 'manual',
        budget: { maxSearches: 5 },
        attemptCount: 1,
        blockedReason: 'No semantic gap repairer is configured.',
        acceptedSourceIds: ['src-1'],
        ingestedSourceIds: ['src-2'],
        promotedFactCount: 1,
        sourceAssessments: [{
          url: 'https://example.test/source',
          title: 'Source',
          accepted: true,
          confidence: 91,
          reasons: ['domain matched', 'fresh source'],
        }],
        trace: [
          { at: now - 1_000, state: 'detected', message: 'Gap was detected.' },
          { at: now, state: 'blocked', message: 'No semantic gap repairer is configured.' },
        ],
        metadata: { gapTitle: 'Which source proves memory sync?' },
        createdAt: now - 2_000,
        updatedAt: now,
      }];
      const runRequests: Record<string, unknown>[] = [];
      (fixture.context.extensions as unknown as { agentKnowledgeService: unknown }).agentKnowledgeService = {
        listRefinementTasks: () => refinementTasks,
        getRefinementTask: (id: string) => refinementTasks.find((task) => task.id === id) ?? null,
        listJobs: () => [{
          id: 'knowledge-semantic-self-improvement',
          kind: 'semantic-self-improvement',
          title: 'Semantic Self-Improvement',
          description: 'Classify and repair semantic Knowledge gaps.',
          defaultMode: 'background',
          metadata: { category: 'semantic' },
        }],
        listJobRuns: () => [{
          id: 'job-run-1',
          jobId: 'knowledge-semantic-self-improvement',
          status: 'completed',
          mode: 'inline',
          requestedAt: now - 500,
          completedAt: now - 100,
          result: { processedGaps: 1 },
          metadata: {},
          createdAt: now - 500,
          updatedAt: now - 100,
        }],
        runRefinement: async (input: Record<string, unknown>) => {
          runRequests.push(input);
          return {
            scannedGaps: 1,
            candidateGaps: 1,
            processedGaps: 1,
            createdGaps: 0,
            repairableGaps: 1,
            suppressedGaps: 0,
            skippedGaps: 0,
            searched: 1,
            ingestedSources: 1,
            linkedRepairs: 1,
            blockedGaps: 0,
            closedGaps: 1,
            queuedTasks: 1,
            requestedLimit: input.limit,
            effectiveLimit: 1,
            truncated: false,
            budgetExhausted: false,
            taskIds: ['kref-gap-1'],
            ingestedSourceIds: ['src-2'],
            acceptedSourceIds: ['src-1'],
            promotedFactCount: 1,
            errors: [],
          };
        },
      };

      const summary = await executeHarnessJson<{
        readonly memoryRefinement?: {
          readonly status?: string;
          readonly taskCounts?: { readonly attention?: number };
          readonly semanticJobPublished?: boolean;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryRefinement?.status).toBe('attention');
      expect(summary.memoryRefinement?.taskCounts?.attention).toBe(1);
      expect(summary.memoryRefinement?.semanticJobPublished).toBe(true);

      const refinement = await executeHarnessJson<{
        readonly status: string;
        readonly taskCounts: { readonly attention: number; readonly blocked: number };
        readonly tasks: readonly {
          readonly taskId: string;
          readonly state: string;
          readonly acceptedSourceIds?: readonly string[];
          readonly ingestedSourceIds?: readonly string[];
          readonly inspectRoute: string;
          readonly rerunRoute: string;
        }[];
        readonly semanticSelfImprovementJob: { readonly id: string; readonly latestRun?: { readonly status: string } };
        readonly policy: string;
      }>(fixture, { mode: 'memory_refinement', includeParameters: true });
      expect(refinement.status).toBe('attention');
      expect(refinement.taskCounts.attention).toBe(1);
      expect(refinement.taskCounts.blocked).toBe(1);
      expect(refinement.tasks[0]?.taskId).toBe('kref-gap-1');
      expect(refinement.tasks[0]?.acceptedSourceIds).toEqual(['src-1']);
      expect(refinement.tasks[0]?.ingestedSourceIds).toEqual(['src-2']);
      expect(refinement.tasks[0]?.inspectRoute).toContain('memory action:"refinement"');
      expect(refinement.tasks[0]?.rerunRoute).toContain('memory action:"run_refinement"');
      expect(refinement.semanticSelfImprovementJob.id).toBe('knowledge-semantic-self-improvement');
      expect(refinement.semanticSelfImprovementJob.latestRun?.status).toBe('completed');
      expect(refinement.policy).toContain('Read-only');

      const run = await executeHarnessJson<{
        readonly status: string;
        readonly result: { readonly closedGaps: number; readonly acceptedSourceIds: readonly string[]; readonly ingestedSourceIds: readonly string[] };
        readonly nextRoutes: { readonly tasks: readonly string[] };
        readonly policy: string;
      }>(fixture, {
        mode: 'run_memory_refinement',
        knowledgeSpaceId: 'agent',
        gapIds: ['sem-gap-1'],
        sourceIds: ['src-1'],
        limit: 2,
        maxRunMs: 5_000,
        force: true,
        confirm: true,
        explicitUserRequest: 'Run a scoped semantic refinement.',
      });
      expect(run.status).toBe('completed');
      expect(run.result.closedGaps).toBe(1);
      expect(run.result.acceptedSourceIds).toEqual(['src-1']);
      expect(run.result.ingestedSourceIds).toEqual(['src-2']);
      expect(run.nextRoutes.tasks[0]).toContain('memory action:"refinement"');
      expect(run.policy).toContain('KnowledgeService.runRefinement');
      expect(runRequests[0]).toEqual({
        knowledgeSpaceId: 'agent',
        sourceIds: ['src-1'],
        gapIds: ['sem-gap-1'],
        limit: 2,
        maxRunMs: 5_000,
        force: true,
      });
    } finally {
      fixture.cleanup();
    }
  });


  test('surfaces durable external memory provider receipts without claiming live provider records', async () => {
    const fixture = makeFixture();
    const artifacts = { store: new ArtifactStore({ rootDir: join(fixture.root, 'artifacts') }) };
    Object.assign(fixture.context.platform, { artifactStore: artifacts.store });
    const receipt = await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'supermemory-sync-receipt.json',
      text: JSON.stringify({ providerId: 'supermemory', operation: 'sync', status: 'succeeded' }),
      metadata: {
        purpose: 'agent-memory-provider-receipt',
        providerId: 'supermemory',
        operation: 'sync',
        status: 'succeeded',
        createdAt: '2026-06-08T12:00:00.000Z',
        sourceCount: 12,
        redaction: 'summaries-only',
        nextRoute: 'memory action:"provider" providerId:"supermemory" includeParameters:true',
        correlationId: 'memory-sync-1',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.external-memory.receipt.v1',
        publicationGuarantee: 'daemon stores confirmed external memory receipts token=memory-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method memory.providers.sync', 'sourceTool memory_provider.sync'],
        receiptId: 'supermemory-sync-1',
        receiptStatus: 'succeeded',
      },
    });
    try {
      attachMemoryApi(fixture);
      const summary = await executeHarnessJson<{
        readonly memoryPosture?: {
          readonly externalProviderRecordsPublished?: boolean;
          readonly externalProviderReceiptEvidenceFound?: boolean;
          readonly externalProviderReceiptEvidenceCount?: number;
          readonly externalProviderSetupGuideStatus?: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryPosture?.externalProviderRecordsPublished).toBe(false);
      expect(summary.memoryPosture?.externalProviderReceiptEvidenceFound).toBe(true);
      expect(summary.memoryPosture?.externalProviderReceiptEvidenceCount).toBe(1);
      expect(summary.memoryPosture?.externalProviderSetupGuideStatus).toBe('receipt-evidence-found');

      const posture = await executeHarnessJson<{
        readonly providers: readonly {
          readonly id: string;
          readonly status: string;
          readonly latestReceipt?: { readonly artifactId: string; readonly operation: string; readonly status: string; readonly sourceCount: number | null };
        }[];
        readonly externalMemory: {
          readonly status: string;
          readonly providerRecordsPublished: boolean;
          readonly receiptEvidenceFound: boolean;
          readonly receiptEvidenceCount: number;
          readonly setupGuideStatus: string;
          readonly latestReceipts: readonly {
            readonly artifactId: string;
            readonly providerId: string;
            readonly operation: string;
            readonly inspectRoute: string;
            readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
          }[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string }[];
          readonly receiptContract: { readonly status: string; readonly requiredFields: readonly string[] };
          readonly next: string;
        };
      }>(fixture, { mode: 'memory_posture', includeParameters: true, limit: 20 });
      expect(posture.externalMemory.status).toBe('receipt-evidence-found');
      expect(posture.externalMemory.providerRecordsPublished).toBe(false);
      expect(posture.externalMemory.receiptEvidenceFound).toBe(true);
      expect(posture.externalMemory.receiptEvidenceCount).toBe(1);
      expect(posture.externalMemory.setupGuideStatus).toBe('receipt-evidence-found');
      expect(posture.externalMemory.latestReceipts[0]).toMatchObject({
        artifactId: receipt.id,
        providerId: 'supermemory',
        operation: 'sync',
      });
      expect(posture.externalMemory.latestReceipts[0]?.certification?.schemaStatus).toBe('certified');
      expect(posture.externalMemory.latestReceipts[0]?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
      expect(posture.externalMemory.latestReceipts[0]?.certification?.receiptId).toBe('supermemory-sync-1');
      expect(posture.externalMemory.latestReceipts[0]?.certification?.missingSignals).toEqual([]);
      expect(posture.externalMemory.latestReceipts[0]?.inspectRoute).toContain(`agent_artifacts show artifactId:"${receipt.id}"`);
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.status).toBe('artifact-evidence-found');
      expect(posture.externalMemory.receiptContract.status).toBe('artifact-evidence-found');
      expect(posture.externalMemory.receiptContract.requiredFields).toContain('nextRoute');
      expect(posture.externalMemory.next).toContain('keep Agent-local memory');
      const supermemory = posture.providers.find((provider) => provider.id === 'supermemory');
      expect(supermemory?.status).toBe('receipt-evidence-found');
      expect(supermemory?.latestReceipt).toMatchObject({
        artifactId: receipt.id,
        operation: 'sync',
        status: 'succeeded',
        sourceCount: 12,
      });

      const provider = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly configured?: boolean;
        readonly latestReceipt?: {
          readonly artifactId: string;
          readonly operation: string;
          readonly status: string;
          readonly redaction: string | null;
          readonly nextRoute: string;
          readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
        };
        readonly setupGuide?: {
          readonly status: string;
          readonly currentState: string;
          readonly safeFirstStep: string;
          readonly latestReceipt?: { readonly artifactId: string; readonly correlationId: string | null };
          readonly receiptHistory?: readonly { readonly artifactId: string }[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
          readonly receiptContract: { readonly status: string };
        };
      }>(fixture, { mode: 'memory_provider', providerId: 'supermemory' });
      expect(provider.id).toBe('supermemory');
      expect(provider.status).toBe('receipt-evidence-found');
      expect(provider.configured).toBe(true);
      expect(provider.latestReceipt).toMatchObject({
        artifactId: receipt.id,
        operation: 'sync',
        status: 'succeeded',
        redaction: 'summaries-only',
      });
      expect(provider.latestReceipt?.nextRoute).toContain('memory action:"provider"');
      expect(provider.latestReceipt?.certification?.schemaStatus).toBe('certified');
      expect(provider.latestReceipt?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
      expect(provider.latestReceipt?.certification?.receiptId).toBe('supermemory-sync-1');
      expect(provider.latestReceipt?.certification?.missingSignals).toEqual([]);
      expect(provider.setupGuide?.status).toBe('receipt-evidence-found');
      expect(provider.setupGuide?.currentState).toContain(receipt.id);
      expect(provider.setupGuide?.safeFirstStep).toContain('Agent-local memory');
      expect(provider.setupGuide?.latestReceipt).toMatchObject({
        artifactId: receipt.id,
        correlationId: 'memory-sync-1',
      });
      expect(provider.setupGuide?.receiptHistory?.[0]?.artifactId).toBe(receipt.id);
      expect(provider.setupGuide?.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.status).toBe('artifact-evidence-found');
      expect(provider.setupGuide?.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.inspectRoute).toContain(receipt.id);
      expect(provider.setupGuide?.receiptContract.status).toBe('artifact-evidence-found');
      expect(JSON.stringify(provider)).not.toContain('memory-receipt-secret');
    } finally {
      fixture.cleanup();
    }
  });


  test('consumes live external memory provider read models when published by the host', async () => {
    const fixture = makeFixture();
    try {
      attachMemoryApi(fixture);
      const readModels = (fixture.context.platform as unknown as { readModels: Record<string, unknown> }).readModels;
      readModels.memory = {
        externalProviders: {
          getSnapshot: () => ({
            providers: {
              supermemory: {
                label: 'Supermemory',
                status: 'ready',
                configured: true,
                reachable: true,
                credentialRef: 'secret://supermemory-token',
                capabilities: {
                  read: true,
                  write: true,
                  sync: true,
                  forget: false,
                },
                promptPolicy: { eligible: false },
                routes: {
                  inspect: 'memory action:"provider" providerId:"supermemory" includeParameters:true',
                  read: 'memory_provider action:"read" providerId:"supermemory" query:"..."',
                  write: 'memory_provider action:"write" providerId:"supermemory" confirm:true explicitUserRequest:"..."',
                  sync: 'memory_provider action:"sync" providerId:"supermemory" confirm:true explicitUserRequest:"..."',
                  receipts: 'memory_provider action:"receipts" providerId:"supermemory"',
                },
                receiptIds: ['live-memory-receipt-1'],
                receiptStreamStatus: 'published',
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.external-memory.provider.v1',
                publicationGuarantee: 'daemon publishes external memory provider state token=memory-pub-secret',
                publisher: 'goodvibes-daemon',
                provenance: ['method memory.providers.list', 'sourceTool memory.externalProviders'],
                sourceCount: 12,
                recordCount: 45,
                redactionPolicy: 'summaries-only',
                updatedAt: '2026-06-08T12:00:00.000Z',
              },
            },
          }),
        },
      };

      const summary = await executeHarnessJson<{
        readonly memoryPosture?: {
          readonly externalProviderRecordsPublished?: boolean;
          readonly externalProviderLiveRecordCount?: number;
          readonly externalProviderSetupGuideStatus?: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryPosture?.externalProviderRecordsPublished).toBe(true);
      expect(summary.memoryPosture?.externalProviderLiveRecordCount).toBe(1);
      expect(summary.memoryPosture?.externalProviderSetupGuideStatus).toBe('ready');

      const posture = await executeHarnessJson<{
        readonly providers: readonly {
          readonly id: string;
          readonly status: string;
          readonly configured?: boolean;
          readonly liveRecord?: {
            readonly source: string;
            readonly credentialState: string | null;
            readonly readReady: boolean | null;
            readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
          };
          readonly setupGuide?: {
            readonly status: string;
            readonly contractChecklist: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
            readonly receiptContract: { readonly status: string };
            readonly nextRoutes: readonly { readonly id: string; readonly effect: string; readonly modelRoute: string }[];
          };
        }[];
        readonly externalMemory: {
          readonly status: string;
          readonly providerRecordsPublished: boolean;
          readonly liveProviderRecordCount: number;
          readonly latestLiveProviderRecords: readonly {
            readonly providerId: string;
            readonly source: string;
            readonly credentialState: string | null;
            readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] };
          }[];
          readonly setupGuideStatus: string;
          readonly checkedProviders: readonly string[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string }[];
          readonly receiptContract: { readonly status: string };
          readonly next: string;
        };
      }>(fixture, { mode: 'memory_posture', includeParameters: true, limit: 20 });
      expect(posture.externalMemory.status).toBe('available');
      expect(posture.externalMemory.providerRecordsPublished).toBe(true);
      expect(posture.externalMemory.liveProviderRecordCount).toBe(1);
      expect(posture.externalMemory.latestLiveProviderRecords[0]).toMatchObject({
        providerId: 'supermemory',
        source: 'context.platform.readModels.memory.externalProviders',
        credentialState: 'configured-secret-ref',
      });
      expect(posture.externalMemory.latestLiveProviderRecords[0]?.certification?.schemaStatus).toBe('certified');
      expect(posture.externalMemory.latestLiveProviderRecords[0]?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
      expect(posture.externalMemory.latestLiveProviderRecords[0]?.certification?.missingSignals).toEqual([]);
      expect(posture.externalMemory.setupGuideStatus).toBe('ready');
      expect(posture.externalMemory.checkedProviders).toContain('supermemory');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'certified-provider-contract')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'status-record')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'bounded-read-search')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'confirmed-write-upsert')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'forget-contract')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'prompt-eligibility-policy')?.status).toBe('published');
      expect(posture.externalMemory.receiptContract.status).toBe('published');
      expect(posture.externalMemory.next).toContain('live provider record');

      const supermemory = posture.providers.find((provider) => provider.id === 'supermemory');
      expect(supermemory?.status).toBe('available');
      expect(supermemory?.configured).toBe(true);
      expect(supermemory?.liveRecord).toMatchObject({
        source: 'context.platform.readModels.memory.externalProviders',
        credentialState: 'configured-secret-ref',
        readReady: true,
      });
      expect(supermemory?.liveRecord?.certification?.schemaStatus).toBe('certified');
      expect(supermemory?.liveRecord?.certification?.receiptId).toBe('live-memory-receipt-1');
      expect(supermemory?.liveRecord?.certification?.missingSignals).toEqual([]);
      expect(supermemory?.setupGuide?.status).toBe('ready');
      expect(supermemory?.setupGuide?.contractChecklist.find((entry) => entry.id === 'credential-reference')?.status).toBe('published');
      expect(supermemory?.setupGuide?.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.inspectRoute).toContain('memory_provider action:"receipts"');
      expect(supermemory?.setupGuide?.receiptContract.status).toBe('published');
      expect(supermemory?.setupGuide?.nextRoutes.find((route) => route.id === 'read-provider-memory')?.effect).toBe('read-only');
      expect(supermemory?.setupGuide?.nextRoutes.find((route) => route.id === 'write-provider-memory')?.effect).toBe('confirmed');
      expect(supermemory?.setupGuide?.nextRoutes.find((route) => route.id === 'sync-provider-memory')?.modelRoute).toContain('confirm:true');

      const provider = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly liveRecord?: {
          readonly receiptIds: readonly string[];
          readonly recordCount: number | null;
          readonly redaction: string | null;
          readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] };
        };
        readonly setupGuide?: { readonly currentState: string; readonly safeFirstStep: string };
      }>(fixture, { mode: 'memory_provider', providerId: 'supermemory' });
      expect(provider.id).toBe('supermemory');
      expect(provider.status).toBe('available');
      expect(provider.liveRecord?.receiptIds).toContain('live-memory-receipt-1');
      expect(provider.liveRecord?.recordCount).toBe(45);
      expect(provider.liveRecord?.redaction).toBe('summaries-only');
      expect(provider.liveRecord?.certification?.schemaStatus).toBe('certified');
      expect(provider.liveRecord?.certification?.publicationGuarantee).toContain('token=[REDACTED]');
      expect(provider.liveRecord?.certification?.missingSignals).toEqual([]);
      expect(provider.setupGuide?.currentState).toContain('Live Supermemory provider record');
      expect(provider.setupGuide?.safeFirstStep).toContain('published bounded read route');
      expect(JSON.stringify(provider)).not.toContain('secret://supermemory-token');
      expect(JSON.stringify(provider)).not.toContain('memory-pub-secret');
    } finally {
      fixture.cleanup();
    }
  });
});
