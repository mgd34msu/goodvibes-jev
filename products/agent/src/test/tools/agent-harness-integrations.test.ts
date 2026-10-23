import { localEndpointId } from '../../tools/agent-harness-local-model-endpoints.ts';
import { createObservabilityReadModels } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import { ApiTokenAuditor } from '@goodvibes-jev/engine/sdk/platform/security';
import { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { createRuntimeStore } from '@/runtime/index.ts';
import { VoiceProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/voice';
import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, choice, score, type JudgmentPort } from '@goodvibes-jev/judgment';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { registerAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { recordAgentChannelDeliveryReceipt } from '../../agent/channel-delivery-receipts.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { createHarnessArtifactStore, makeFixture, registerStubTool, readAuthorizationHeader, expectCompactModelRoute, expectRowsHaveCompactModelRoutes, executeHarnessJson, LOCAL_MODEL_ENDPOINT_ENV_KEYS, clearEnvForTest, restoreEnvForTest, scriptHarnessLocalReading, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


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


  test.each(['summary', 'ops', 'artifactLane', 'lane', 'reviewerLane', 'timelineLane', 'wizardLane', 'readinessAction', 'wizardAction'] as const)('exposes Document Ops readiness with an honest blind comparison runner: %s', async surface => {
    const fixture = makeFixture();
    const artifacts = new ArtifactStore({ rootDir: join(fixture.root, 'native-document-artifacts') });
    Object.assign(fixture.context.platform, { artifactStore: artifacts });
    try {
      registerStubTool(fixture.toolRegistry, 'agent_documents');
      registerAgentArtifactsTool(fixture.toolRegistry, artifacts);
      registerStubTool(fixture.toolRegistry, 'agent_knowledge_ingest');
      registerStubTool(fixture.toolRegistry, 'agent_model_compare');
      const documentRegistry = AgentDocumentRegistry.fromShellPaths(fixture.paths);
      const draft = documentRegistry.create({
        title: 'Reviewer packet',
        body: 'Draft reviewer packet body.',
        tags: ['review'],
      });
      documentRegistry.addComment(draft.id, { body: 'Clarify the release evidence section.' });
      documentRegistry.suggestUpdate(draft.id, {
        body: 'Draft reviewer packet body with clearer evidence.',
        summary: 'Clarify evidence section.',
        rationale: 'Reviewer asked for more explicit evidence.',
      });
      const savedComparison = await artifacts.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-cmp_hidden.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare',
          comparisonId: 'cmp_hidden',
          candidateCount: 2,
          completedCandidates: 2,
          revealIncludedInTranscript: false,
        },
      });
      await artifacts.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-judgment-hidden.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare-judgment',
          judgmentId: 'judgment-hidden',
          comparisonId: 'cmp_hidden',
          sourceArtifactId: savedComparison.id,
          winnerBlindId: 'A',
          revealIncludedInJudgment: false,
        },
      });
      const revealedJudgment = await artifacts.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-judgment-revealed.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare-judgment',
          judgmentId: 'judgment-revealed',
          comparisonId: 'cmp_revealed',
          winnerBlindId: 'B',
          winnerModel: 'openai:gpt-4.1',
          revealIncludedInJudgment: true,
        },
      });
      await artifacts.create({
        kind: 'data',
        mimeType: 'text/markdown',
        filename: 'blind-model-comparison-handoff-missing.md',
        text: '# Handoff',
        metadata: {
          purpose: 'agent-model-compare-handoff',
          handoffId: 'handoff-missing',
          comparisonId: 'cmp_revealed',
          sourceArtifactId: revealedJudgment.id,
          sourceKind: 'judgment',
          relatedArtifactIds: [],
          revealIncludedInHandoff: true,
        },
      });
      if (surface === 'summary') {
        const summary = await executeHarnessJson<{
          readonly documentOps?: { readonly lanes: number; readonly ready: number; readonly attention: number; readonly partial: number; readonly gap: number };
        }>(fixture, { mode: 'summary' });
        expect(summary.documentOps?.lanes).toBe(10);
        expect(summary.documentOps?.ready).toBeGreaterThanOrEqual(2);
        expect(summary.documentOps?.attention).toBeGreaterThanOrEqual(1);
        expect(summary.documentOps?.partial).toBeGreaterThanOrEqual(1);
        expect(summary.documentOps?.gap).toBe(0);
        return;
      }

      if (surface === 'ops') {
        const ops = await executeHarnessJson<{
          readonly reviewerReadiness?: {
            readonly status: string;
            readonly summary: {
              readonly openComments: number;
              readonly proposedSuggestions: number;
              readonly documentsMissingSourceArtifacts: number;
              readonly unrevealedComparisons: number;
              readonly hiddenJudgments: number;
              readonly revealedJudgments: number;
              readonly handoffsMissingRelatedArtifacts: number;
            };
            readonly checks: readonly {
              readonly id: string;
              readonly status: string;
              readonly count: number;
              readonly inspectRoute: string;
              readonly repairRoute?: string;
            }[];
          };
          readonly lanes: readonly {
            readonly id: string;
            readonly status: string;
            readonly current: string;
            readonly reviewPacketWizard?: {
              readonly status: string;
              readonly currentStepLabel?: string | null;
              readonly steps: readonly {
                readonly id: string;
                readonly status: string;
                readonly modelRoute: string;
                readonly backtrackRoute?: string;
              }[];
            };
            readonly reviewerReadiness?: {
              readonly status: string;
              readonly checks: readonly {
                readonly id: string;
                readonly status: string;
                readonly count: number;
                readonly repairRoute?: string;
              }[];
            };
            readonly actionIds?: readonly string[];
          }[];
          readonly policy: string;
          readonly nextActions: readonly string[];
        }>(fixture, { mode: 'document_ops', includeParameters: true });
        expect(ops.policy).toContain('model comparison');
        expect(ops.policy).toContain('AI suggestion review');
        expect(ops.policy).toContain('chronological review packet timelines');
        expect(ops.nextActions.join('\n')).not.toContain('AI suggestion review');

        const documents = ops.lanes.find((lane) => lane.id === 'documents');
        const uploads = ops.lanes.find((lane) => lane.id === 'uploads');
        const exports = ops.lanes.find((lane) => lane.id === 'exports');
        const reviewerReadiness = ops.lanes.find((lane) => lane.id === 'reviewer_readiness');
        const reviewPacketTimeline = ops.lanes.find((lane) => lane.id === 'review_packet_timeline');
        const reviewPacketWizard = ops.lanes.find((lane) => lane.id === 'review_packet_wizard');
        const sourceLibrary = ops.lanes.find((lane) => lane.id === 'source_library');
        const artifactBrowser = ops.lanes.find((lane) => lane.id === 'artifact_browser');
        const modelCompare = ops.lanes.find((lane) => lane.id === 'model_compare');
        expect(documents?.status).toBe('ready');
        expect(documents?.current).toContain('version history');
        expect(documents?.actionIds).toContain('document-create-draft');
        expect(documents?.actionIds).toContain('document-revise-draft');
        expect(documents?.actionIds).toContain('document-comment-draft');
        expect(documents?.actionIds).toContain('document-resolve-comment');
        expect(documents?.actionIds).toContain('document-suggest-draft');
        expect(documents?.actionIds).toContain('document-accept-suggestion');
        expect(documents?.actionIds).toContain('document-reject-suggestion');
        expect(documents?.actionIds).toContain('document-insert-artifact');
        expect(documents?.actionIds).toContain('document-attach-artifact');
        expect(documents?.actionIds).toContain('document-export-draft');
        expect(exports?.actionIds).toContain('document-export-artifact-file');
        expect(exports?.actionIds).toContain('document-export-artifact-package');
        expect(exports?.actionIds).toContain('document-export-artifact-file');
        expect(exports?.actionIds).toContain('document-export-artifact-package');
        expect(uploads?.status).toBe('ready');
        expect(uploads?.actionIds).toContain('document-ingest-file');
        expect(exports?.status).toBe('ready');
        expect(exports?.actionIds).toContain('document-export-conversation');
        expect(reviewerReadiness?.status).toBe('attention');
        expect(reviewerReadiness?.current).toContain('1 open comment');
        expect(reviewerReadiness?.actionIds).toContain('document-reviewer-readiness');
        expect(reviewerReadiness?.actionIds).toContain('document-resolve-comment');
        expect(reviewerReadiness?.actionIds).toContain('document-accept-suggestion');
        expect(reviewerReadiness?.actionIds).toContain('document-apply-compare');
        expect(reviewPacketTimeline?.status).toBe('attention');
        expect(reviewPacketTimeline?.current).toContain('packet event');
        expect(reviewPacketTimeline?.actionIds).toContain('document-review-packet-timeline');
        expect(reviewPacketTimeline?.actionIds).toContain('document-review-compare');
        expect(reviewPacketWizard?.status).toBe('attention');
        expect(reviewPacketWizard?.current).toContain('Draft review');
        expect(reviewPacketWizard?.actionIds).toContain('document-review-packet-wizard');
        expect(reviewPacketWizard?.actionIds).toContain('document-share-review-packet');
        expect(reviewPacketWizard?.actionIds).toContain('document-export-draft');
        expect(reviewPacketWizard?.reviewPacketWizard?.currentStepLabel).toBe('Draft review');
        expect(reviewPacketWizard?.reviewPacketWizard?.steps.map((step) => step.id)).toContain('route-decision');
        expect(ops.reviewerReadiness?.status).toBe('attention');
        expect(ops.reviewerReadiness?.summary.openComments).toBe(1);
        expect(ops.reviewerReadiness?.summary.proposedSuggestions).toBe(1);
        expect(ops.reviewerReadiness?.summary.documentsMissingSourceArtifacts).toBe(1);
        expect(ops.reviewerReadiness?.summary.unrevealedComparisons).toBe(1);
        expect(ops.reviewerReadiness?.summary.hiddenJudgments).toBe(1);
        expect(ops.reviewerReadiness?.summary.revealedJudgments).toBe(1);
        expect(ops.reviewerReadiness?.summary.handoffsMissingRelatedArtifacts).toBe(1);
        const reviewCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'document-review-state');
        const revealCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'comparison-reveal');
        const routeDecisionCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'route-change-decision');
        const handoffCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'handoff-archive-evidence');
        expect(reviewCheck?.status).toBe('attention');
        expect(reviewCheck?.repairRoute).toContain('resolveComment');
        expect(revealCheck?.repairRoute).toContain('agent_model_compare reveal');
        expect(routeDecisionCheck?.repairRoute).toContain(`artifactId:"${revealedJudgment.id}"`);
        expect(handoffCheck?.repairRoute).toContain('relatedArtifactIds');
        expect(sourceLibrary?.status).toBe('ready');
        expect(artifactBrowser?.status).toBe('ready');
        expect(artifactBrowser?.current).toContain('unified artifact browser');
        expect(artifactBrowser?.current).toContain('artifact export-to-file');
        expect(artifactBrowser?.current).toContain('multi-artifact package export');
        expect(artifactBrowser?.current).toContain('artifact-to-Knowledge promotion');
        expect(artifactBrowser?.actionIds).toContain('document-browse-artifacts');
        expect(artifactBrowser?.actionIds).toContain('document-show-artifact');
        expect(artifactBrowser?.actionIds).toContain('document-export-artifact-file');
        expect(artifactBrowser?.actionIds).toContain('document-export-artifact-package');
        expect(artifactBrowser?.actionIds).toContain('document-promote-artifact');
        expect(artifactBrowser?.actionIds).toContain('document-insert-artifact');
        expect(artifactBrowser?.actionIds).toContain('document-attach-artifact');
        expect(artifactBrowser?.actionIds).toContain('document-promote-artifact');
        expect(modelCompare?.status).toBe('partial');
        expect(modelCompare?.current).toContain('admitted blind comparison runner');
        expect(modelCompare?.actionIds).toContain('document-run-compare');
        expect(modelCompare?.actionIds).toContain('document-review-compare');
        expect(modelCompare?.actionIds).toContain('document-diff-handoffs');
        expect(modelCompare?.actionIds).toContain('document-judge-compare');
        expect(modelCompare?.actionIds).toContain('document-compare-analytics');
        expect(modelCompare?.actionIds).toContain('document-apply-compare');
        expect(modelCompare?.actionIds).toContain('document-export-compare');
        return;
      }

      if (surface === 'artifactLane') {
        const artifactLane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly routes?: { readonly model: string };
        }>(fixture, { mode: 'document_ops_lane', laneId: 'artifact_browser' });
        expect(artifactLane.id).toBe('artifact_browser');
        expect(artifactLane.status).toBe('ready');
        expect(artifactLane.routes?.model).toBe('agent_artifacts + agent_knowledge_ingest');
        return;
      }

      if (surface === 'lane') {
        const lane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly routes?: { readonly model: string };
        }>(fixture, { mode: 'document_ops_lane', laneId: 'model_compare' });
        expect(lane.id).toBe('model_compare');
        expect(lane.status).toBe('partial');
        expect(lane.routes?.model).toBe('agent_model_compare');
        return;
      }

      if (surface === 'reviewerLane') {
        const reviewerLane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly reviewerReadiness?: {
            readonly checks: readonly { readonly id: string; readonly repairRoute?: string }[];
          };
        }>(fixture, { mode: 'document_ops_lane', laneId: 'reviewer_readiness' });
        expect(reviewerLane.id).toBe('reviewer_readiness');
        expect(reviewerLane.status).toBe('attention');
        expect(reviewerLane.reviewerReadiness?.checks.find((check) => check.id === 'source-artifacts')?.repairRoute).toContain('attachArtifact');
        return;
      }

      if (surface === 'timelineLane') {
        const timelineLane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly signals: readonly string[];
          readonly routes?: { readonly model: string };
        }>(fixture, { mode: 'document_ops_lane', laneId: 'review_packet_timeline' });
        expect(timelineLane.id).toBe('review_packet_timeline');
        expect(timelineLane.status).toBe('attention');
        expect(timelineLane.current).toContain('packet event');
        expect(timelineLane.signals.join('\n')).toContain('handoff');
        expect(timelineLane.signals.join('\n')).toContain('agent_model_compare');
        expect(timelineLane.routes?.model).toBe('agent_harness mode:"document_ops_lane" laneId:"review_packet_timeline"');
        return;
      }

      if (surface === 'wizardLane') {
        const wizardLane = await executeHarnessJson<{
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly reviewPacketWizard?: {
            readonly progress: string;
            readonly currentStepLabel?: string | null;
            readonly steps: readonly { readonly id: string; readonly modelRoute: string; readonly backtrackRoute?: string }[];
          };
          readonly routes?: { readonly model: string };
        }>(fixture, { mode: 'document_ops_lane', laneId: 'review_packet_wizard' });
        expect(wizardLane.id).toBe('review_packet_wizard');
        expect(wizardLane.status).toBe('attention');
        expect(wizardLane.current).toContain('Draft review');
        expect(wizardLane.reviewPacketWizard?.progress).toBe('1/6');
        expect(wizardLane.reviewPacketWizard?.currentStepLabel).toBe('Draft review');
        expect(wizardLane.reviewPacketWizard?.steps.find((step) => step.id === 'route-decision')?.modelRoute).toContain('agent_model_compare apply');
        expect(wizardLane.routes?.model).toBe('agent_harness mode:"document_ops_lane" laneId:"review_packet_wizard"');
        return;
      }

      if (surface === 'readinessAction') {
        const readinessAction = await executeHarnessJson<{
          readonly status: string;
          readonly action: string;
          readonly tool: string;
          readonly output?: { readonly id?: string; readonly reviewerReadiness?: { readonly status?: string } };
        }>(fixture, {
          mode: 'run_workspace_action',
          actionId: 'document-reviewer-readiness',
          fields: { includeRoutes: 'yes' },
        });
        expect(readinessAction.status).toBe('executed_harness_lane');
        expect(readinessAction.action).toBe('document-reviewer-readiness');
        expect(readinessAction.tool).toBe('agent_harness');
        expect(readinessAction.output?.id).toBe('reviewer_readiness');
        expect(readinessAction.output?.reviewerReadiness?.status).toBe('attention');
        return;
      }

      if (surface === 'wizardAction') {
        const wizardAction = await executeHarnessJson<{
          readonly status: string;
          readonly action: string;
          readonly tool: string;
          readonly output?: { readonly id?: string; readonly reviewPacketWizard?: { readonly currentStepLabel?: string | null } };
        }>(fixture, {
          mode: 'run_workspace_action',
          actionId: 'document-review-packet-wizard',
          fields: { includeRoutes: 'yes' },
        });
        expect(wizardAction.status).toBe('executed_harness_lane');
        expect(wizardAction.action).toBe('document-review-packet-wizard');
        expect(wizardAction.tool).toBe('agent_harness');
        expect(wizardAction.output?.id).toBe('review_packet_wizard');
        expect(wizardAction.output?.reviewPacketWizard?.currentStepLabel).toBe('Draft review');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  test('exposes compact model routes across product posture catalogs', async () => {
    const fixture = makeFixture();
    const tokenAuditor = new ApiTokenAuditor({ managed: false });
    tokenAuditor.registerPolicy({ id: 'agent-policy', name: 'Synthetic scope policy', allowedScopes: ['observe'], rotationCadenceMs: 100000, rotationWarningThresholdMs: 1000 });
    tokenAuditor.registerToken({ id: 'agent-token', label: 'Synthetic token metadata', issuedAt: Date.now(), grantedScopes: ['write'], policyId: 'agent-policy' });
    const securityServices = {
      runtimeStore: createRuntimeStore(), shellPaths: fixture.paths, tokenAuditor, policyRuntimeState: new PolicyRuntimeState(),
      pluginManager: new PluginManager({ pathOptions: { cwd: fixture.root, homeDir: fixture.root }, stateFilePath: join(fixture.root, 'security-plugins.json') }),
      mcpRegistry: new McpRegistry({ hookDispatcher: { fire: async () => ({ ok: true }) }, sandboxSessions: new SandboxSessionRegistry(fixture.root) }),
    };
    const securityModels = createObservabilityReadModels(securityServices as unknown as Parameters<typeof createObservabilityReadModels>[0]);
    (fixture.context.platform as unknown as Record<string, unknown>).readModels = { security: securityModels.security };

    try {
      fixture.configManager.setDynamic('notifications.webhookUrls' as unknown as Parameters<typeof fixture.configManager.setDynamic>[0], ['https://example.test/hooks/alpha?token=secret']);

      const channels = await executeHarnessJson<{
        readonly channels: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'channels', limit: 3 });
      expectRowsHaveCompactModelRoutes(channels.channels);

      fixture.configManager.setDynamic('surfaces.telegram.enabled', true);
      fixture.configManager.setDynamic('surfaces.telegram.botToken', 'telegram-secret-token');
      const channelGuide = await executeHarnessJson<{
        readonly guide: {
          readonly currentChannelId: string | null;
          readonly currentStepId: string | null;
          readonly steps: readonly { readonly id: string; readonly status: string; readonly userRoute: string }[];
          readonly policy: string;
        };
      }>(fixture, { mode: 'channel_setup_guide', channelId: 'telegram' });
      expect(channelGuide.guide.currentChannelId).toBe('telegram');
      expect(channelGuide.guide.currentStepId).toBe('choose-delivery-target');
      expect(channelGuide.guide.steps.find((step) => step.id === 'review-policy')?.userRoute).toBe('/channels policies');
      expect(channelGuide.guide.steps.find((step) => step.id === 'send-explicit-test')?.status).toBe('pending');
      expect(channelGuide.guide.policy).toContain('Read-only channel setup guide');
      expect(JSON.stringify(channelGuide)).not.toContain('telegram-secret-token');

      recordAgentChannelDeliveryReceipt(fixture.paths, {
        source: 'model-tool',
        deliveryInput: {
          message: 'Confirm api_key=super-secret-value',
          webhook: 'https://hooks.example.test/services/T000/B000/secret-token',
        },
        result: {
          message: 'Confirm api_key=super-secret-value',
          title: 'Delivery Check',
          target: { kind: 'webhook', address: 'https://hooks.example.test/services/T000/B000/secret-token' },
          strategyCount: 1,
          responseId: 'response-1',
        },
      });
      const deliveries = await executeHarnessJson<{
        readonly mode: string;
        readonly total: number;
        readonly receipts: readonly {
          readonly receiptId: string;
          readonly target: { readonly display: string; readonly addressDigest?: string };
          readonly messagePreview: string;
          readonly responseId: string | null;
        }[];
      }>(fixture, { mode: 'channel_deliveries' });
      expect(deliveries.mode).toBe('channel_deliveries');
      expect(deliveries.total).toBe(1);
      expect(deliveries.receipts[0]?.target.display).toBe('webhook https://hooks.example.test/...');
      expect(deliveries.receipts[0]?.target.addressDigest).toBeTruthy();
      expect(deliveries.receipts[0]?.messagePreview).toContain('api_key=[redacted]');
      expect(deliveries.receipts[0]?.responseId).toBe('response-1');
      expect(JSON.stringify(deliveries)).not.toContain('secret-token');
      expect(JSON.stringify(deliveries)).not.toContain('super-secret-value');

      const originalFetch = globalThis.fetch;
      const channelTriageToken = 'channel-triage-token';
      try {
        writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: channelTriageToken }));
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(readAuthorizationHeader(init?.headers)).toBe(`Bearer ${channelTriageToken}`);
          const path = new URL(String(input)).pathname;
          if (path === '/api/deliveries') {
            return new Response(JSON.stringify({
              totals: { queued: 1, started: 2, succeeded: 1, failed: 1, deadLettered: 0 },
              attempts: [{
                id: 'delivery-triage-1',
                runId: 'run-triage-1',
                jobId: 'job-triage-1',
                status: 'failed',
                target: { kind: 'webhook', address: 'https://hooks.example.test/services/T000/B000/harness-secret-token' },
                error: 'HTTP 500 api_key=harness-secret-value',
              }],
            }));
          }
          if (path === '/api/control-plane/messages') {
            return new Response(JSON.stringify({
              messages: [{
                id: 'surface-message-1',
                surface: 'slack',
                createdAt: 1,
                title: 'Route token=surface-secret-value',
                body: 'Body with https://hooks.example.test/services/T000/B000/surface-secret-token',
                level: 'warn',
                routeId: 'route-1',
              }],
            }));
          }
          if (path === '/api/routes/bindings') {
            return new Response(JSON.stringify({
              bindings: [{
                id: 'binding-triage-1',
                kind: 'channel',
                surfaceKind: 'slack',
                surfaceId: 'slack',
                externalId: 'C-harness-secret-channel',
                title: 'Ops',
                lastSeenAt: 1,
              }],
            }));
          }
          return new Response('not found', { status: 404 });
        }) as typeof globalThis.fetch;

        const triage = await executeHarnessJson<{
          readonly mode: string;
          readonly status: string;
          readonly deliveries: {
            readonly retryCandidateCount: number;
            readonly retryCandidates: readonly { readonly target: { readonly address?: string; readonly addressDigest?: string }; readonly error?: string }[];
          };
          readonly surfaceMessages: { readonly totalMessages: number; readonly messages: readonly { readonly title: string; readonly bodyPreview: string }[] };
          readonly routeBindings: { readonly totalBindings: number; readonly bindings: readonly { readonly externalIdDigest: string | null }[] };
          readonly inboundFeed: { readonly providerInboxFeed: string };
        }>(fixture, { mode: 'channel_triage', limit: 3 });
        expect(triage.mode).toBe('channel_triage');
        expect(triage.status).toBe('attention');
        expect(triage.deliveries.retryCandidateCount).toBe(1);
        expect(triage.deliveries.retryCandidates[0]?.target.address).toBe('https://hooks.example.test/...');
        expect(triage.deliveries.retryCandidates[0]?.target.addressDigest).toBeTruthy();
        expect(triage.deliveries.retryCandidates[0]?.error).toBe('HTTP 500 api_key=[redacted]');
        expect(triage.surfaceMessages.totalMessages).toBe(1);
        expect(triage.surfaceMessages.messages[0]?.title).toBe('Route token=[redacted]');
        expect(triage.surfaceMessages.messages[0]?.bodyPreview).toContain('[redacted-url]');
        expect(triage.routeBindings.totalBindings).toBe(1);
        expect(triage.routeBindings.bindings[0]?.externalIdDigest).toContain('sha256:');
        expect(triage.inboundFeed.providerInboxFeed).toBe('not_published_by_current_channel_contract');
        expect(JSON.stringify(triage)).not.toContain(channelTriageToken);
        expect(JSON.stringify(triage)).not.toContain('harness-secret-token');
        expect(JSON.stringify(triage)).not.toContain('harness-secret-value');
        expect(JSON.stringify(triage)).not.toContain('surface-secret-token');
        expect(JSON.stringify(triage)).not.toContain('surface-secret-value');
        expect(JSON.stringify(triage)).not.toContain('C-harness-secret-channel');
      } finally {
        globalThis.fetch = originalFetch;
      }

      const notifications = await executeHarnessJson<{
        readonly targets: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'notifications' });
      expectRowsHaveCompactModelRoutes(notifications.targets);
      expect(notifications.targets[0]?.value).toBe('<redacted>');

      const providerAccounts = await executeHarnessJson<{
        readonly providers: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'provider_accounts', query: 'openai', limit: 5 });
      expectRowsHaveCompactModelRoutes(providerAccounts.providers);

      const mcpServers = await executeHarnessJson<{
        readonly servers: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'mcp_servers' });
      expectRowsHaveCompactModelRoutes(mcpServers.servers);

      const modelRouting = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'model_routing', limit: 5 });
      expectRowsHaveCompactModelRoutes(modelRouting.routes);
      expect(modelRouting.routes.filter((route) => route.commands !== undefined || route.uiSurfaces !== undefined)).toEqual([]);

      const execution = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'execution_posture' });
      expectRowsHaveCompactModelRoutes(execution.routes);

      const fileRecovery = await executeHarnessJson<{
        readonly actions: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'file_recovery' });
      expectRowsHaveCompactModelRoutes(fileRecovery.actions);

      const pairing = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'pairing_posture' });
      expectRowsHaveCompactModelRoutes(pairing.routes);
      expect(pairing.routes.filter((route) => route.harnessRoute !== undefined)).toEqual([]);

      const delegation = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'delegation_posture' });
      expectRowsHaveCompactModelRoutes(delegation.routes);
      expect(delegation.routes.filter((route) => route.commandTemplate !== undefined)).toEqual([]);

      const expandedDelegation = await executeHarnessJson<{
        readonly summary: {
          readonly decisionCards: number;
          readonly operatorClientAttached: boolean;
        };
        readonly decisionCards: readonly {
          readonly id: string;
          readonly lane: string;
          readonly status: string;
          readonly supervision: readonly string[];
        }[];
        readonly routes: readonly {
          readonly delegationRouteId: string;
          readonly effect: string;
          readonly lane: string;
          readonly requiredFields: readonly string[];
          readonly statusRoutes: readonly string[];
          readonly recoveryRoutes: readonly string[];
        }[];
      }>(fixture, { mode: 'delegation_posture', includeParameters: true });
      expect(expandedDelegation.summary.decisionCards).toBeGreaterThanOrEqual(5);
      expect(expandedDelegation.summary.operatorClientAttached).toBe(false);
      expect(expandedDelegation.decisionCards.find((card) => card.lane === 'tui-shared-session')?.status).toBe('operator-needed');
      expect(expandedDelegation.decisionCards.find((card) => card.lane === 'remote-runner')?.supervision.join('\n')).toContain('/health remote');
      expect(expandedDelegation.routes.find((route) => route.delegationRouteId === 'delegate-build-task')?.requiredFields.join('\n')).toContain('success criteria');
      expect(expandedDelegation.routes.find((route) => route.delegationRouteId === 'remote-runner-inspection')?.statusRoutes.join('\n')).toContain('/health remote');
      expect(expandedDelegation.routes.find((route) => route.delegationRouteId === 'hidden-local-fanout-blocked')?.effect).toBe('blocked');

      const expandedDelegationRoute = await executeHarnessJson<{
        readonly delegationRouteId: string;
        readonly lane: string;
        readonly requiredFields: readonly string[];
        readonly successEvidence: readonly string[];
        readonly recoveryRoutes: readonly string[];
        readonly modelAccess: { readonly runWorkspaceAction?: string };
      }>(fixture, { mode: 'delegation_route', delegationRouteId: 'delegate-build-task' });
      expect(expandedDelegationRoute.lane).toBe('tui-shared-session');
      expect(expandedDelegationRoute.requiredFields.join('\n')).toContain('delegation reason');
      expect(expandedDelegationRoute.successEvidence.join('\n')).toContain('verification result');
      expect(expandedDelegationRoute.recoveryRoutes.join('\n')).toContain('GoodVibes TUI');
      expect(expandedDelegationRoute.modelAccess.runWorkspaceAction).toContain('delegate-task');

      const security = await executeHarnessJson<{
        readonly findings: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'security_posture' });
      expectRowsHaveCompactModelRoutes(security.findings);

      const bundles = await executeHarnessJson<{
        readonly bundles: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'support_bundles' });
      expectRowsHaveCompactModelRoutes(bundles.bundles);
      expect(bundles.bundles.filter((bundle) => bundle.exportCommand !== undefined || bundle.workspaceActionIds !== undefined)).toEqual([]);

      const media = await executeHarnessJson<{
        readonly providers: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'media_posture' });
      expectRowsHaveCompactModelRoutes(media.providers);

      const sessions = await executeHarnessJson<{
        readonly sessions: readonly Record<string, unknown>[];
        readonly bookmarks: Record<string, unknown>;
      }>(fixture, { mode: 'sessions' });
      expectRowsHaveCompactModelRoutes(sessions.sessions);
      expectCompactModelRoute(sessions.bookmarks.modelRoute);
      expect(sessions.bookmarks.modelRoutes).toBeUndefined();

      const operatorMethods = await executeHarnessJson<{
        readonly methods: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'operator_methods', query: 'automation.schedules.create' });
      expectRowsHaveCompactModelRoutes(operatorMethods.methods);
      expect(operatorMethods.methods[0]?.preferredModelTool).toBeUndefined();

      const service = await executeHarnessJson<{
        readonly modelRoute?: string;
        readonly endpoints: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'service_posture' });
      expectCompactModelRoute(service.modelRoute);
      expectRowsHaveCompactModelRoutes(service.endpoints);

      const expandedMcp = await executeHarnessJson<{
        readonly servers: readonly { readonly modelAccess?: Record<string, unknown> }[];
      }>(fixture, { mode: 'mcp_servers', includeParameters: true });
      expect(expandedMcp.servers[0]?.modelAccess).toMatchObject({
        reviewCommand: '/mcp review',
        serversCommand: '/mcp servers',
        configCommand: '/mcp config',
      });

      const expandedOperatorMethod = await executeHarnessJson<{
        readonly modelRoute?: string;
        readonly preferredModelTool?: string;
      }>(fixture, { mode: 'operator_method', methodId: 'automation.schedules.create' });
      expectCompactModelRoute(expandedOperatorMethod.modelRoute);
      expect(expandedOperatorMethod.preferredModelTool).toContain('agent_operator_method');
    } finally {
      fixture.cleanup();
    }
  });


  test.each(['posture', 'route'] as const)('exposes a companion device capability map with honest unpublished sensor posture: %s', async view => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({
        token: 'device-map-secret-token',
      }));
      fixture.configManager.setDynamic('controlPlane.enabled', true);
      fixture.configManager.setDynamic('web.enabled', true);
      fixture.configManager.setDynamic('ui.voiceEnabled', true);
      fixture.configManager.setDynamic('tts.provider', 'stream-voice');
      fixture.configManager.setDynamic('tts.voice', '');
      fixture.configManager.setDynamic('notifications.webhookUrls' as unknown as Parameters<typeof fixture.configManager.setDynamic>[0], ['https://hooks.example.test/device-map/secret-token']);
      fixture.configManager.setDynamic('surfaces.telegram.enabled', true);
      fixture.configManager.setDynamic('surfaces.telegram.botToken', 'telegram-secret-token');

      if (view === 'posture') {
        const posture = await executeHarnessJson<{
          readonly summary: {
            readonly deviceCapabilities: {
              readonly total: number;
              readonly ready: number;
              readonly attention: number;
              readonly setupNeeded: number;
              readonly notPublished: number;
              readonly primaryNextStep: string;
            };
          };
          readonly pairing: {
            readonly endpoint: { readonly enabled: boolean };
            readonly token: { readonly present: boolean; readonly rawValueReturned: boolean };
          };
          readonly deviceCapabilities: readonly {
            readonly id: string;
            readonly status: string;
            readonly summary: string;
            readonly evidence?: Record<string, unknown>;
            readonly setupRoutes?: readonly string[];
            readonly policy?: string;
          }[];
        }>(fixture, { mode: 'pairing_posture', query: 'device', includeParameters: true });

        expect(posture.summary.deviceCapabilities.total).toBeGreaterThanOrEqual(8);
        expect(posture.summary.deviceCapabilities.ready).toBeGreaterThanOrEqual(3);
        expect(posture.summary.deviceCapabilities.attention).toBeGreaterThanOrEqual(1);
        expect(posture.summary.deviceCapabilities.notPublished).toBe(1);
        expect(posture.pairing.endpoint.enabled).toBe(true);
        expect(posture.pairing.token).toMatchObject({ present: true, rawValueReturned: false });
        expect(posture.deviceCapabilities.find((capability) => capability.id === 'browser-cockpit-pwa')?.status).toBe('ready');
        expect(posture.deviceCapabilities.find((capability) => capability.id === 'voice-controls')?.status).toBe('attention');
        expect(posture.deviceCapabilities.find((capability) => capability.id === 'browser-desktop-control')?.status).toBe('setup-needed');
        const sensors = posture.deviceCapabilities.find((capability) => capability.id === 'camera-location-sensors');
        expect(sensors?.status).toBe('not-published');
        expect(sensors?.summary).toContain('not published');
        expect(sensors?.setupRoutes?.join('\n')).toContain('host action:"methods"');
        expect(JSON.stringify(posture)).not.toContain('device-map-secret-token');
        expect(JSON.stringify(posture)).not.toContain('telegram-secret-token');
        expect(JSON.stringify(posture)).not.toContain('secret-token');
        return;
      }

      if (view === 'route') {
        const route = await executeHarnessJson<{
          readonly pairingRouteId: string;
          readonly deviceCapabilityMap: {
            readonly capabilities: readonly { readonly id: string; readonly status: string }[];
            readonly policy: string;
          };
        }>(fixture, { mode: 'pairing_route', query: 'camera location' });
        expect(route.pairingRouteId).toBe('device-capability-map');
        expect(route.deviceCapabilityMap.capabilities.find((capability) => capability.id === 'camera-location-sensors')?.status).toBe('not-published');
        expect(route.deviceCapabilityMap.policy).toContain('does not pair devices');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  test.each(['posture', 'listening', 'blocked', 'pushToTalk'] as const)('exposes voice interaction workflow posture, with the wake row reporting what this surface actually does: %s', async view => {
    const fixture = makeFixture();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'voice-workflow-secret-key';
      fixture.configManager.setDynamic('ui.voiceEnabled', true);
      fixture.configManager.setDynamic('tts.provider', 'openai');
      fixture.configManager.setDynamic('tts.voice', 'alloy');
      (fixture.context as { submitSpokenInput?: (text: string) => void }).submitSpokenInput = () => {};
      (fixture.context as { stopSpokenOutput?: () => void }).stopSpokenOutput = () => {};
      const voiceRegistry = new VoiceProviderRegistry();
      voiceRegistry.register({ id: 'openai', label: 'OpenAI Voice', capabilities: ['tts', 'stt', 'realtime', 'voice-list'], billing: 'none',
        status: async () => ({ id: 'openai', label: 'OpenAI Voice', capabilities: ['tts', 'stt', 'realtime', 'voice-list'], metadata: {}, state: 'healthy', configured: true, detail: 'OpenAI voice ready.' }) });
      Object.assign(fixture.context.platform, { voiceProviderRegistry: voiceRegistry });
      (fixture.context.platform as {
        voiceService?: {
          listVoices?: (providerId?: string) => Promise<readonly { readonly id: string; readonly label: string }[]>;
          transcribe?: () => Promise<{ readonly text: string }>;
        };
      }).voiceService = {
        listVoices: async (providerId?: string) => [{ id: `${providerId ?? 'default'}-voice-a`, label: 'Voice A' }],
        transcribe: async () => ({ text: 'transcribed text' }),
      };

      if (view === 'posture') {
        const posture = await executeHarnessJson<{
          readonly summary: {
            readonly voiceWorkflows: {
              readonly ready: number;
              readonly notPublished: number;
            };
          };
          readonly voiceWorkflows: readonly {
            readonly id: string;
            readonly status: string;
            readonly summary: string;
            readonly nextStep: string;
            readonly setupRoutes: readonly string[];
            readonly evidence: Record<string, unknown>;
            readonly policy: string;
          }[];
        }>(fixture, { mode: 'media_posture', query: 'voice', includeParameters: true });

        expect(posture.summary.voiceWorkflows.ready).toBeGreaterThanOrEqual(3);
        expect(posture.voiceWorkflows.find((workflow) => workflow.id === 'push-to-talk')?.status).toBe('ready');
        expect(posture.voiceWorkflows.find((workflow) => workflow.id === 'voice-memo-transcription')?.status).toBe('ready');
        expect(posture.voiceWorkflows.find((workflow) => workflow.id === 'spoken-responses')?.status).toBe('ready');
        // Wake capture IS shipped on this surface, and its delivery row ships off, so
        // the honest posture at defaults is setup-needed with the exact rows to flip,
        // not the "not-published" it read while nothing captured audio anywhere. The
        // phone half is still unpublished and says so in its own evidence field.
        const wake = posture.voiceWorkflows.find((workflow) => workflow.id === 'wake-and-speak');
        expect(wake?.status).toBe('setup-needed');
        expect(wake?.summary).toContain('voice.wake.surfaces.agent is off');
        // The next step describes what YOU do for the user, not a command to hand
        // over: setting the row also moves the surface row and fetches the models.
        expect(wake?.nextStep).toContain('Set voice.wake.enabled');
        expect(wake?.nextStep).not.toContain('/voice');
        expect(wake?.evidence.localCaptureHost).toBe(true);
        expect(wake?.evidence.listening).toBe(false);
        expect(wake?.evidence.companionWakePublishedByCurrentAgentContract).toBe(false);
        expect(wake?.policy).toContain('does not claim always-listening');

        // Both rows on and nothing refusing: the same posture reads ready.
        expect(JSON.stringify(posture)).not.toContain('voice-workflow-secret-key');
        return;
      }

      fixture.configManager.setDynamic('voice.wake.enabled', true);
      fixture.configManager.setDynamic('voice.wake.surfaces.agent', true);
      if (view === 'listening') {
        const listening = await executeHarnessJson<{
          readonly voiceWorkflows: readonly { readonly id: string; readonly status: string; readonly evidence: Record<string, unknown> }[];
        }>(fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
        expect(listening.voiceWorkflows[0]?.status).toBe('ready');
        expect(listening.voiceWorkflows[0]?.evidence.listening).toBe(true);

        // A row that refuses to start the detector is an attention state, named.
        expect(JSON.stringify(listening)).not.toContain('voice-workflow-secret-key');
        return;
      }

      fixture.configManager.setDynamic('voice.wake.vadThreshold', 0.5);
      if (view === 'blocked') {
        const blocked = await executeHarnessJson<{
          readonly voiceWorkflows: readonly { readonly id: string; readonly status: string; readonly evidence: Record<string, unknown> }[];
        }>(fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
        expect(blocked.voiceWorkflows[0]?.status).toBe('attention');
        expect(blocked.voiceWorkflows[0]?.evidence.blockedRows).toEqual(['voice.wake.vadThreshold']);
        expect(JSON.stringify(blocked)).not.toContain('voice-workflow-secret-key');
        return;
      }

      fixture.configManager.setDynamic('voice.wake.vadThreshold', 0);
      fixture.configManager.setDynamic('voice.wake.enabled', false);
      fixture.configManager.setDynamic('voice.wake.surfaces.agent', false);

      if (view === 'pushToTalk') {
        const pushToTalk = await executeHarnessJson<{
          readonly voiceWorkflows: readonly { readonly id: string; readonly status: string }[];
        }>(fixture, { mode: 'media_posture', query: 'push to talk', includeParameters: true });
        expect(pushToTalk.voiceWorkflows.map((workflow) => workflow.id)).toEqual(['push-to-talk']);
        expect(pushToTalk.voiceWorkflows[0]?.status).toBe('ready');
        expect(JSON.stringify(pushToTalk)).not.toContain('voice-workflow-secret-key');
        return;
      }


    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      fixture.cleanup();
    }
  });


  test.each(['posture', 'route', 'wake'] as const)('consumes certified companion device capability records for sensors and wake word: %s', async view => {
    const fixture = makeFixture();
    try {
      const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
      platform.readModels.device = {
        capabilities: {
          getSnapshot: () => ({
            records: [
              {
                id: 'device-sensors-live-1',
                capabilityId: 'camera-location-sensors',
                label: 'Phone camera screen and location',
                domain: 'device',
                status: 'ready',
                summary: 'Foreground camera, screen, location, and device commands are available token=[REDACTED]',
                capabilities: ['camera', 'screen capture', 'location', 'local device command'],
                permissionScope: 'foreground-camera-location-screen',
                routes: {
                  inspect: 'device action:"capability" capabilityId:"camera-location-sensors" includeParameters:true',
                  capture: 'device action:"capability" capabilityId:"camera-location-sensors" confirm:true explicitUserRequest:"..."',
                  repairPermission: 'device action:"capability" capabilityId:"camera-location-sensors" repairPermission:true confirm:true explicitUserRequest:"..."',
                },
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.device.capability.v1',
                publicationGuarantee: 'daemon publishes permission-scoped sensor receipts secret=[REDACTED]',
                publisher: 'goodvibes-daemon',
                provenance: ['method device.capabilities.list', 'sourceTool companion-daemon'],
                cursor: 'device-sensor-cursor-1',
                receiptId: 'device-sensor-receipt-1',
              },
              {
                id: 'wake-word-live-1',
                capabilityId: 'wake-and-speak',
                label: 'Wake word route',
                domain: 'voice',
                status: 'ready',
                summary: 'Foreground wake-word route with visible microphone controls token=[REDACTED]',
                capabilities: ['wake word', 'always listening', 'microphone permission repair'],
                permissionScope: 'foreground-microphone-wake-word',
                routes: {
                  inspect: 'device action:"voice" query:"wake word" includeParameters:true',
                  open: 'device action:"voice" query:"wake word" confirm:true explicitUserRequest:"..."',
                  repairPermission: 'device action:"voice" query:"wake word permission" confirm:true explicitUserRequest:"..."',
                },
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.device.voice-workflow.v1',
                publicationGuarantee: 'daemon publishes wake-word permission receipts token=[REDACTED]',
                publisher: 'goodvibes-daemon',
                provenance: ['method voice.workflows.list', 'sourceTool companion-daemon'],
                cursor: 'wake-word-cursor-1',
                receiptId: 'wake-word-receipt-1',
              },
            ],
          }),
        },
      };

      if (view === 'posture') {
        const posture = await executeHarnessJson<{
          readonly summary: {
            readonly deviceCapabilities: {
              readonly ready: number;
              readonly notPublished: number;
            };
          };
          readonly deviceCapabilities: readonly {
            readonly id: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly evidence?: {
              readonly certifiedLiveRecords?: readonly {
                readonly summary?: string;
                readonly certification: { readonly missingSignals: readonly string[]; readonly publicationGuarantee?: string; readonly receiptId?: string };
              }[];
            };
          }[];
        }>(fixture, { mode: 'pairing_posture', query: 'device', includeParameters: true });

        expect(posture.summary.deviceCapabilities.notPublished).toBe(0);
        const sensors = posture.deviceCapabilities.find((capability) => capability.id === 'camera-location-sensors');
        expect(sensors?.status).toBe('ready');
        expect(sensors?.summary).toContain('certified');
        expect(sensors?.modelRoute).toContain('camera-location-sensors');
        expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.summary).toContain('token=<redacted>');
        expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.certification.publicationGuarantee).toContain('secret=[REDACTED]');
        expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.certification.receiptId).toBe('device-sensor-receipt-1');
        expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.certification.missingSignals).toEqual([]);
        expect(JSON.stringify(posture)).not.toContain('sensor-summary-secret');
        expect(JSON.stringify(posture)).not.toContain('sensor-publication-secret');
        expect(JSON.stringify(posture)).not.toContain('wake-summary-secret');
        expect(JSON.stringify(posture)).not.toContain('wake-publication-secret');
        return;
      }

      if (view === 'route') {
        const route = await executeHarnessJson<{
          readonly deviceCapabilityMap: {
            readonly capabilities: readonly {
              readonly id: string;
              readonly status: string;
              readonly evidence?: { readonly certifiedLiveRecords?: readonly unknown[] };
            }[];
          };
        }>(fixture, { mode: 'pairing_route', query: 'camera location' });
        expect(route.deviceCapabilityMap.capabilities.find((capability) => capability.id === 'camera-location-sensors')?.status).toBe('ready');
        expect(route.deviceCapabilityMap.capabilities.find((capability) => capability.id === 'camera-location-sensors')?.evidence?.certifiedLiveRecords).toHaveLength(1);
        expect(JSON.stringify(route)).not.toContain('sensor-summary-secret');
        expect(JSON.stringify(route)).not.toContain('sensor-publication-secret');
        expect(JSON.stringify(route)).not.toContain('wake-summary-secret');
        expect(JSON.stringify(route)).not.toContain('wake-publication-secret');
        return;
      }

      if (view === 'wake') {
        const wake = await executeHarnessJson<{
          readonly summary: { readonly voiceWorkflows: { readonly ready: number; readonly notPublished: number } };
          readonly voiceWorkflows: readonly {
            readonly id: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly evidence: { readonly certifiedLiveRecords?: readonly { readonly summary?: string; readonly certification: { readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] } }[] };
          }[];
        }>(fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
        expect(wake.voiceWorkflows.map((workflow) => workflow.id)).toEqual(['wake-and-speak']);
        expect(wake.voiceWorkflows[0]?.status).toBe('ready');
        expect(wake.voiceWorkflows[0]?.modelRoute).toContain('wake word');
        expect(wake.voiceWorkflows[0]?.evidence.certifiedLiveRecords?.[0]?.summary).toContain('token=<redacted>');
        expect(wake.voiceWorkflows[0]?.evidence.certifiedLiveRecords?.[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
        expect(wake.voiceWorkflows[0]?.evidence.certifiedLiveRecords?.[0]?.certification.missingSignals).toEqual([]);
        expect(JSON.stringify(wake)).not.toContain('sensor-summary-secret');
        expect(JSON.stringify(wake)).not.toContain('sensor-publication-secret');
        expect(JSON.stringify(wake)).not.toContain('wake-summary-secret');
        expect(JSON.stringify(wake)).not.toContain('wake-publication-secret');
        return;
      }

    } finally {
      fixture.cleanup();
    }
  });


  // DELETED: 'exposes a local model cookbook through model routing and workspace actions'
  // account-local-model-cookbook, account-route-readiness, account-local-benchmark-evidence removed.
  // DELETED: 'exposes a local model cookbook through model routing and workspace actions'
  // account-local-model-cookbook, account-route-readiness, account-local-benchmark-evidence removed.;

  test.each(['cookbook', 'detail'] as const)('maps discovered local provider endpoints into smoke-testable server health: %s', async view => {
    const previousEndpointEnv = clearEnvForTest(LOCAL_MODEL_ENDPOINT_ENV_KEYS);
    const fixture = makeFixture();
    try {
      const registry = fixture.context.provider.providerRegistry as unknown as {
        listModels: () => readonly unknown[];
        listProviders?: () => readonly unknown[];
      };
      const endpointModels = [{
        provider: 'ollama-local',
        modelId: 'qwen2.5-coder:7b',
        registryKey: 'ollama-local:qwen2.5-coder:7b',
        displayName: 'qwen2.5-coder:7b',
        description: 'Discovered local model on http://127.0.0.1:11434/v1',
        baseURL: 'http://127.0.0.1:11434/v1',
        serverType: 'ollama',
        contextWindow: 8192,
        capabilities: { toolCalling: true, multimodal: false },
      }];
      registry.listModels = () => endpointModels;
      const publishedProviders = [{
        name: 'ollama-local',
        baseURL: 'http://127.0.0.1:11434/v1',
        models: ['qwen2.5-coder:7b'],
      }];
      registry.listProviders = () => publishedProviders;
      const servingSnapshot = {
        servers: {
          ollama: {
            providerId: 'ollama-local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            stack: 'ollama',
            status: 'ready',
            schemaStatus: 'certified',
            schemaVersion: 'goodvibes.local-serving.v1',
            sourceTool: 'models.local.servingDiagnostics',
            provenance: ['daemon:local-serving', 'method:models.local.servingDiagnostics'],
            publicationGuarantee: 'daemon publishes local serving diagnostics after start/repair receipts Authorization: Bearer serving-secret',
            publisher: 'goodvibes-daemon',
            serverVersion: 'ollama 0.3.2',
            loadedModels: ['qwen2.5-coder:7b'],
            contextWindowTokens: 8192,
            toolSupport: true,
            resourcePressure: 'low',
            memoryUsagePercent: 42,
            startReceiptId: 'ollama-start-receipt',
            repairReceiptId: 'ollama-repair-receipt',
            receiptStatus: 'ready',
            startRoute: 'agent_operator_method methodId:"models.local.start" confirm:true explicitUserRequest:"Start the published Ollama server."',
            repairRoute: 'agent_operator_method methodId:"models.local.repair" confirm:true explicitUserRequest:"Repair the published Ollama server."',
            lastCheckedAt: '2026-06-07T10:00:00.000Z',
            summary: 'Ollama Authorization: Bearer raw-secret is ready with one loaded model.',
          },
        },
      };
      (fixture.context.platform as unknown as { readModels: Record<string, unknown> }).readModels = {
        ...((fixture.context.platform as unknown as { readModels?: Record<string, unknown> }).readModels ?? {}),
        models: { servingDiagnostics: { getSnapshot: () => servingSnapshot } },
      };

      // The complete original diagnostic is screened before any redacted display
      // preview can be used as evidence. Credentials hold the entire read.
      let heldDiagnostic: unknown;
      try { await fixture.tool.execute({ mode: 'model_routing', query: 'local', includeParameters: true }); }
      catch (error) { heldDiagnostic = error; }
      expect(heldDiagnostic).toBeInstanceOf(Error);
      expect(String(heldDiagnostic)).not.toContain('serving-secret');
      expect(String(heldDiagnostic)).not.toContain('raw-secret');
      servingSnapshot.servers.ollama.publicationGuarantee = 'daemon publishes local serving diagnostics after start/repair receipts';
      servingSnapshot.servers.ollama.summary = 'Ollama is ready with one loaded model.';
      // Canonical responses bind the complete original native publisher records.
      // Any new or changed record remains unscripted and is refused by the fixture.
      const localModels = registry.listModels();
      for (const record of localModels) scriptHarnessLocalReading('route',
        { evidence_kind: 'registry', registry_text: JSON.stringify(record), record }, { kind: 'choice', choice: 'ollama' });
      for (const record of publishedProviders) scriptHarnessLocalReading('route',
        { evidence_kind: 'registry', registry_text: JSON.stringify(record), record }, { kind: 'choice', choice: 'ollama' });
      const providerId = 'ollama-local';
      scriptHarnessLocalReading('route', { evidence_kind: 'registry', registry_text: providerId,
        record: { providerId, providers: publishedProviders, models: localModels } }, { kind: 'choice', choice: 'ollama' });
      const diagnostic = { ...servingSnapshot.servers.ollama, id: 'ollama' };
      scriptHarnessLocalReading('route', { evidence_kind: 'registry', registry_text: 'ollama', record: diagnostic }, { kind: 'choice', choice: 'ollama' });
      scriptHarnessLocalReading('status', { value: diagnostic.status, record: diagnostic }, { kind: 'choice', choice: 'ready' });
      scriptHarnessLocalReading('pressure', { value: diagnostic.resourcePressure, record: diagnostic }, { kind: 'choice', choice: 'low' });
      scriptHarnessLocalReading('certified', { value: diagnostic.schemaStatus, record: diagnostic }, { kind: 'yes-no', probability: 0.999 });


      if (view === 'cookbook') {
        const cookbook = await executeHarnessJson<{
          readonly localCookbook: {
            readonly status: string;
            readonly detected: {
              readonly providerIds: readonly string[];
              readonly modelRoutes: readonly string[];
              readonly stacks: readonly string[];
            };
            readonly localServerHealth: {
              readonly status: string;
              readonly liveProbe: string;
              readonly endpointCount: number;
              readonly endpoints: readonly {
                readonly kind: string;
                readonly id: string;
                readonly providerId: string | null;
                readonly stack: string | null;
                readonly baseUrl: string;
                readonly modelsUrl: string;
                readonly diagnosticStatus: string;
                readonly inspectRoute: string;
                readonly sources: readonly string[];
                readonly sourceDetails: readonly string[];
                readonly modelRoutes: readonly string[];
                readonly smokeCommand: string;
                readonly smokeRoute: string;
                readonly refreshRoute: string;
                readonly addProviderRoute: string | null;
                readonly notes: readonly string[];
                readonly servingDiagnostics?: {
                  readonly status: string;
                  readonly source: string;
                  readonly summary: string;
                  readonly schemaStatus?: string;
                  readonly schemaVersion?: string;
                  readonly provenance?: readonly string[];
                  readonly publicationGuarantee?: string;
                  readonly publisher?: string;
                  readonly serverVersion?: string;
                  readonly loadedModelCount?: number;
                  readonly loadedModels: readonly string[];
                  readonly contextWindowTokens?: number;
                  readonly toolSupport?: boolean;
                  readonly resourcePressure: string;
                  readonly resourceSummary?: string;
                  readonly lastCheckedAt?: string | null;
                  readonly startReceiptId?: string;
                  readonly repairReceiptId?: string;
                  readonly receiptStatus?: string;
                  readonly startRoute?: string;
                  readonly repairRoute?: string;
                  readonly inspectRoute: string;
                  readonly missingSignals: readonly string[];
                  readonly policy: string;
                };
                readonly diagnostics?: {
                  readonly successCriteria: readonly string[];
                  readonly failureTriage: readonly string[];
                  readonly afterSmoke: readonly string[];
                  readonly policy: string;
                };
              }[];
              readonly daemonDiagnostics: {
                readonly status: string;
                readonly sourcePaths: readonly string[];
                readonly recordCount: number;
                readonly matchedEndpointCount: number;
                readonly missingSignals: readonly string[];
                readonly policy: string;
              };
              readonly nextActions: readonly string[];
              readonly policy: string;
            };
          };
        }>(fixture, { mode: 'model_routing', query: 'local', includeParameters: true });

        expect(cookbook.localCookbook.status).toBe('detected-local-route');
        expect(cookbook.localCookbook.detected.providerIds).toContain('ollama-local');
        expect(cookbook.localCookbook.detected.modelRoutes).toContain('ollama-local:qwen2.5-coder:7b');
        expect(cookbook.localCookbook.detected.stacks).toContain('ollama');
        expect(cookbook.localCookbook.localServerHealth.status).toBe('candidate-endpoints');
        expect(cookbook.localCookbook.localServerHealth.liveProbe).toBe('not-run');
        expect(cookbook.localCookbook.localServerHealth.endpointCount).toBe(1);
        const endpoint = cookbook.localCookbook.localServerHealth.endpoints[0];
        expect(endpoint?.providerId).toBe('ollama-local');
        expect(endpoint?.kind).toBe('local-server-endpoint');
        expect(endpoint?.stack).toBe('ollama');
        expect(endpoint?.baseUrl).toBe('http://127.0.0.1:11434/v1');
        expect(endpoint?.modelsUrl).toBe('http://127.0.0.1:11434/v1/models');
        expect(endpoint?.diagnosticStatus).toBe('registered-route-needs-smoke');
        expect(endpoint?.inspectRoute).toBe(`agent_harness mode:"model_route" modelRouteId:"${endpoint?.id}"`);
        expect(endpoint?.sources).toContain('model-registry');
        expect(endpoint?.sources).toContain('provider-registry');
        expect(endpoint?.sourceDetails).toContain('model:ollama-local:qwen2.5-coder:7b');
        expect(endpoint?.modelRoutes).toContain('ollama-local:qwen2.5-coder:7b');
        expect(endpoint?.smokeCommand).toBe('curl -fsS http://127.0.0.1:11434/v1/models');
        expect(endpoint?.smokeRoute).toContain('models action:"smoke"');
        expect(endpoint?.refreshRoute).toContain('/refresh-models');
        expect(endpoint?.addProviderRoute).toBeNull();
        expect(endpoint?.notes.join('\n')).toContain('Provider already exists');
        expect(endpoint?.servingDiagnostics?.status).toBe('ready');
        expect(endpoint?.servingDiagnostics?.source).toBe('context.platform.readModels.models.servingDiagnostics');
        expect(endpoint?.servingDiagnostics?.schemaStatus).toBe('certified');
        expect(endpoint?.servingDiagnostics?.schemaVersion).toBe('goodvibes.local-serving.v1');
        expect(endpoint?.servingDiagnostics?.provenance?.join('\n')).toContain('models.local.servingDiagnostics');
        expect(endpoint?.servingDiagnostics?.publicationGuarantee).toBe(servingSnapshot.servers.ollama.publicationGuarantee);
        expect(endpoint?.servingDiagnostics?.publicationGuarantee).not.toContain('serving-secret');
        expect(endpoint?.servingDiagnostics?.publisher).toBe('goodvibes-daemon');
        expect(endpoint?.servingDiagnostics?.serverVersion).toBe('ollama 0.3.2');
        expect(endpoint?.servingDiagnostics?.loadedModelCount).toBe(1);
        expect(endpoint?.servingDiagnostics?.loadedModels).toEqual(['qwen2.5-coder:7b']);
        expect(endpoint?.servingDiagnostics?.contextWindowTokens).toBe(8192);
        expect(endpoint?.servingDiagnostics?.toolSupport).toBe(true);
        expect(endpoint?.servingDiagnostics?.resourcePressure).toBe('low');
        expect(endpoint?.servingDiagnostics?.resourceSummary).toContain('memory 42%');
        expect(endpoint?.servingDiagnostics?.startReceiptId).toBe('ollama-start-receipt');
        expect(endpoint?.servingDiagnostics?.repairReceiptId).toBe('ollama-repair-receipt');
        expect(endpoint?.servingDiagnostics?.receiptStatus).toBe('ready');
        expect(endpoint?.servingDiagnostics?.startRoute).toContain('agent_operator_method methodId:"models.local.start"');
        expect(endpoint?.servingDiagnostics?.repairRoute).toContain('agent_operator_method methodId:"models.local.repair"');
        expect(endpoint?.servingDiagnostics?.lastCheckedAt).toBe('2026-06-07T10:00:00.000Z');
        expect(endpoint?.servingDiagnostics?.summary).toBe(servingSnapshot.servers.ollama.summary);
        expect(endpoint?.servingDiagnostics?.summary).not.toContain('raw-secret');
        expect(endpoint?.servingDiagnostics?.missingSignals).toEqual([]);
        expect(endpoint?.servingDiagnostics?.policy).toContain('exact confirmed routes');
        expect(endpoint?.diagnostics?.successCriteria.join('\n')).toContain('confirmed smoke command exits 0');
        expect(endpoint?.diagnostics?.failureTriage.join('\n')).toContain('start the ollama server');
        expect(endpoint?.diagnostics?.afterSmoke.join('\n')).toContain('refresh route');
        expect(endpoint?.diagnostics?.policy).toContain('models action:"smoke"');
        expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.status).toBe('published-read-model');
        expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.sourcePaths).toContain('context.platform.readModels.models.servingDiagnostics');
        expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.recordCount).toBe(1);
        expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.matchedEndpointCount).toBe(1);
        expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.missingSignals).toEqual([]);
        expect(cookbook.localCookbook.localServerHealth.nextActions.join('\n')).toContain('Review published local serving diagnostics');
        expect(cookbook.localCookbook.localServerHealth.nextActions.join('\n')).toContain('http://127.0.0.1:11434/v1/models');
        expect(cookbook.localCookbook.localServerHealth.policy).toContain('daemon-published serving diagnostics');
        return;
      }

      if (view === 'detail') {
        const endpoint = { id: localEndpointId('http://127.0.0.1:11434/v1') };

        const endpointDetail = await executeHarnessJson<{
          readonly kind: string;
          readonly modelRouteId: string;
          readonly baseUrl: string;
          readonly modelsUrl: string;
          readonly diagnosticStatus: string;
          readonly smokeCommand: string;
          readonly smokeRoute: string;
          readonly servingDiagnostics?: {
            readonly status: string;
            readonly schemaStatus?: string;
            readonly startRoute?: string;
            readonly repairRoute?: string;
            readonly serverVersion?: string;
            readonly loadedModels: readonly string[];
            readonly summary: string;
          };
          readonly diagnostics?: { readonly successCriteria: readonly string[]; readonly failureTriage: readonly string[]; readonly policy: string };
          readonly modelAccess?: { readonly cookbook: string; readonly smoke: string; readonly addProvider: string | null };
          readonly lookup?: { readonly resolvedBy: string };
        }>(fixture, { mode: 'model_route', modelRouteId: endpoint?.id });
        expect(endpointDetail.kind).toBe('local-server-endpoint');
        expect(endpointDetail.modelRouteId).toBe(endpoint?.id);
        expect(endpointDetail.baseUrl).toBe('http://127.0.0.1:11434/v1');
        expect(endpointDetail.modelsUrl).toBe('http://127.0.0.1:11434/v1/models');
        expect(endpointDetail.diagnosticStatus).toBe('registered-route-needs-smoke');
        expect(endpointDetail.smokeCommand).toBe('curl -fsS http://127.0.0.1:11434/v1/models');
        expect(endpointDetail.smokeRoute).toContain('models action:"smoke"');
        expect(endpointDetail.servingDiagnostics?.status).toBe('ready');
        expect(endpointDetail.servingDiagnostics?.schemaStatus).toBe('certified');
        expect(endpointDetail.servingDiagnostics?.startRoute).toContain('models.local.start');
        expect(endpointDetail.servingDiagnostics?.repairRoute).toContain('models.local.repair');
        expect(endpointDetail.servingDiagnostics?.serverVersion).toBe('ollama 0.3.2');
        expect(endpointDetail.servingDiagnostics?.loadedModels).toEqual(['qwen2.5-coder:7b']);
        expect(endpointDetail.servingDiagnostics?.summary).not.toContain('raw-secret');
        expect(endpointDetail.diagnostics?.successCriteria.join('\n')).toContain('model-list endpoint returns JSON');
        expect(endpointDetail.diagnostics?.failureTriage.join('\n')).toContain('/v1');
        expect(endpointDetail.diagnostics?.policy).toContain('models action:"smoke"');
        expect(endpointDetail.modelAccess?.cookbook).toContain('models action:"local"');
        expect(endpointDetail.modelAccess?.smoke).toBe(endpointDetail.smokeRoute);
        expect(endpointDetail.modelAccess?.addProvider).toBeNull();
        expect(endpointDetail.lookup?.resolvedBy).toBe('local-endpoint-id');
        return;
      }

    } finally {
      restoreEnvForTest(previousEndpointEnv);
      fixture.cleanup();
    }
  });


  test('runs confirmed local model smoke against detected endpoint candidates', async () => {
    const previousEndpointEnv = clearEnvForTest(LOCAL_MODEL_ENDPOINT_ENV_KEYS);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/models') {
          return Response.json({
            object: 'list',
            data: [
              { id: 'qwen2.5-coder:7b', object: 'model' },
              { id: 'llama3.2:3b', object: 'model' },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    const fixture = makeFixture();
    try {
      const unconfirmed = await fixture.tool.execute({
        mode: 'run_local_model_smoke',
        modelRouteId: `local-127-0-0-1-${server.port}-v1`,
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('recorded effect admission');

      const smoke = await executeHarnessJson<{
        readonly kind: string;
        readonly status: string;
        readonly liveProbe: string;
        readonly endpointCount: number;
        readonly passedCount: number;
        readonly failedCount: number;
        readonly endpoints: readonly {
          readonly kind: string;
          readonly id: string;
          readonly status: string;
          readonly liveProbe: string;
          readonly networkScope: string;
          readonly modelsUrl: string;
          readonly httpStatus: number;
          readonly jsonValid: boolean;
          readonly modelCount: number;
          readonly sampleModelIds: readonly string[];
          readonly success: boolean;
          readonly refreshRoute: string;
          readonly addProviderRoute: string | null;
        }[];
        readonly policy: string;
      }>(fixture, {
        mode: 'run_local_model_smoke',
        modelRouteId: `local-127-0-0-1-${server.port}-v1`,
        timeoutMs: 1000,
        confirm: true,
        explicitUserRequest: 'Check local model servers.',
      });

      expect(smoke.kind).toBe('local-model-smoke');
      expect(smoke.status).toBe('ready');
      expect(smoke.liveProbe).toBe('confirmed');
      expect(smoke.endpointCount).toBe(1);
      expect(smoke.passedCount).toBe(1);
      expect(smoke.failedCount).toBe(0);
      const endpoint = smoke.endpoints[0];
      expect(endpoint?.kind).toBe('local-server-endpoint');
      expect(endpoint?.status).toBe('passed');
      expect(endpoint?.liveProbe).toBe('confirmed');
      expect(endpoint?.networkScope).toBe('loopback');
      expect(endpoint?.modelsUrl).toBe(`http://127.0.0.1:${server.port}/v1/models`);
      expect(endpoint?.httpStatus).toBe(200);
      expect(endpoint?.jsonValid).toBe(true);
      expect(endpoint?.modelCount).toBe(2);
      expect(endpoint?.sampleModelIds).toContain('qwen2.5-coder:7b');
      expect(endpoint?.success).toBe(true);
      expect(endpoint?.refreshRoute).toContain('/refresh-models');
      expect(endpoint?.addProviderRoute).toContain('/provider add');
      expect(smoke.policy).toContain('Confirmed read-only local model smoke');
      expect(smoke.policy).toContain('does not add providers');
    } finally {
      server.stop();
      restoreEnvForTest(previousEndpointEnv);
      fixture.cleanup();
    }
  });


  test('reports every model a local endpoint advertises, not just the ones it prints', async () => {
    const previousEndpointEnv = clearEnvForTest(LOCAL_MODEL_ENDPOINT_ENV_KEYS);
    const advertised = 20;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/models') {
          return Response.json({
            object: 'list',
            data: Array.from({ length: advertised }, (_value, index) => ({ id: `model-${index}`, object: 'model' })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    const fixture = makeFixture();
    try {
      const smoke = await executeHarnessJson<{
        readonly endpointCount: number;
        readonly candidateEndpointCount: number;
        readonly note?: string;
        readonly endpoints: readonly {
          readonly modelCount: number;
          readonly sampleModelIds: readonly string[];
        }[];
      }>(fixture, {
        mode: 'run_local_model_smoke',
        modelRouteId: `local-127-0-0-1-${server.port}-v1`,
        timeoutMs: 1000,
        confirm: true,
        explicitUserRequest: 'Check local model servers.',
      });

      // modelCount used to be read off the 12-entry capped list, so a server
      // advertising 20 models reported 12.
      expect(smoke.endpoints[0]?.modelCount).toBe(advertised);
      expect(smoke.endpoints[0]?.sampleModelIds).toHaveLength(5);
      // Every endpoint that existed was probed, so nothing claims otherwise.
      expect(smoke.candidateEndpointCount).toBe(smoke.endpointCount);
      expect(smoke.note).toBeUndefined();
    } finally {
      server.stop();
      restoreEnvForTest(previousEndpointEnv);
      fixture.cleanup();
    }
  });


  test('surfaces saved local model benchmark history in cookbook and setup', async () => {
    const artifacts = createHarnessArtifactStore(() => 1_791_684_509_006);
    const comparisonBody = JSON.stringify({ schema: 'goodvibes.agent.model_compare.v1', comparisonId: 'cmp_local',
      prompt: 'Compare the local Ollama endpoint with our hosted baseline for latency and repository-task fit.',
      candidates: [{ blindId: 'A', status: 'completed', content: 'Local route response.' }, { blindId: 'B', status: 'completed', content: 'Hosted baseline response.' }] });
    const otherBody = JSON.stringify({ schema: 'goodvibes.agent.model_compare.v1', comparisonId: 'cmp_other',
      prompt: 'Write a concise product update using two hosted routes.', candidates: [] });
    const judgmentBody = JSON.stringify({ schema: 'goodvibes.agent.model_compare_judgment.v1', judgmentId: 'jdg_local', comparisonId: 'cmp_local',
      sourceArtifactId: 'artifact-1', winnerBlindId: 'A', winnerModel: 'ollama:qwen2.5-coder:7b',
      reasons: 'The locally served Ollama route met the repository task and responded with less waiting time than the hosted baseline.' });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-cmp_local.json',
      text: comparisonBody,
      metadata: {
        purpose: 'agent-model-compare',
        benchmarkKind: 'local-model-route',
        comparisonId: 'cmp_local',
        promptPreview: 'local model benchmark: Ollama',
        candidateCount: 2,
        completedCandidates: 2,
        candidateLatencyEvidence: [
          {
            blindId: 'A',
            status: 'completed',
            latencyMs: 642,
            registryKey: 'ollama:qwen2.5-coder:7b',
            providerId: 'ollama',
            modelId: 'qwen2.5-coder:7b',
            displayName: 'Qwen local',
          },
          {
            blindId: 'B',
            status: 'completed',
            latencyMs: 1280,
            registryKey: 'openai:gpt-4.1',
            providerId: 'openai',
            modelId: 'gpt-4.1',
            displayName: 'GPT 4.1',
          },
        ],
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-cmp_other.json',
      text: otherBody,
      metadata: {
        purpose: 'agent-model-compare',
        comparisonId: 'cmp_other',
        promptPreview: 'Write a concise product update.',
        candidateCount: 2,
        completedCandidates: 2,
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-judgment-jdg_local.json',
      text: judgmentBody,
      metadata: {
        purpose: 'agent-model-compare-judgment',
        judgmentId: 'jdg_local',
        comparisonId: 'cmp_local',
        sourceArtifactId: 'artifact-1',
        winnerBlindId: 'A',
        promptPreview: 'local model benchmark: Ollama',
        revealIncludedInJudgment: true,
        winnerModel: 'ollama:qwen2.5-coder:7b',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    const other = artifacts.records[1], savedJudgment = artifacts.records[2];
    if (!other || !savedJudgment) throw new Error('Authored benchmark fixture artifacts are absent.');
    const otherReading = { ...other, createdAt: new Date(other.createdAt).toISOString() };
    const judgmentReading = { ...savedJudgment, createdAt: new Date(savedJudgment.createdAt).toISOString() };
    scriptHarnessLocalReading('member', { artifact: { descriptor: otherReading, record: otherReading, content: otherBody } }, { kind: 'yes-no', probability: 0.001 });
    scriptHarnessLocalReading('route', { evidence_kind: 'registry', registry_text: 'ollama:qwen2.5-coder:7b',
      record: { descriptor: judgmentReading, record: judgmentReading, content: judgmentBody } }, { kind: 'choice', choice: 'ollama' });
    try {
      const cookbook = await executeHarnessJson<{
        readonly localCookbook: {
          readonly benchmarkHistory?: {
            readonly status: string;
            readonly count: number;
            readonly nextAction?: string;
            readonly analyticsRoute?: string;
            readonly evidence?: {
              readonly status: string;
              readonly confidence: string;
              readonly comparisonCount: number;
              readonly revealedJudgmentCount: number;
              readonly winnerStacks: readonly string[];
              readonly routeLatencies?: readonly { readonly registryKey: string; readonly latencyMs: number; readonly artifactId: string }[];
              readonly winnerModels: readonly { readonly registryKey: string; readonly stack?: string | null; readonly applyRoute: string }[];
            };
            readonly artifacts: readonly {
              readonly artifactId: string;
              readonly comparisonId?: string | null;
              readonly promptPreview?: string;
              readonly completedCandidates?: number | null;
              readonly reviewRoute: string;
              readonly revealRoute: string;
            }[];
            readonly judgments?: readonly {
              readonly artifactId: string;
              readonly winnerModel?: string | null;
              readonly winnerStack?: string | null;
              readonly applyRoute?: string | null;
            }[];
          };
          readonly recipes?: readonly {
            readonly id: string;
            readonly readiness?: {
              readonly confidence?: string;
              readonly missingSignals?: readonly string[];
              readonly nextStep?: string;
            };
          }[];
        };
      }>(fixture, { mode: 'model_routing', query: 'local', includeParameters: true });

      expect(cookbook.localCookbook.benchmarkHistory?.status).toBe('history-found');
      expect(cookbook.localCookbook.benchmarkHistory?.count).toBe(1);
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts.map((artifact) => artifact.artifactId)).toEqual(['artifact-1']);
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.comparisonId).toBe('cmp_local');
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.completedCandidates).toBe(2);
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.reviewRoute).toContain('agent_model_compare review');
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.revealRoute).toContain('agent_model_compare reveal');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.artifactId).toBe('artifact-3');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.winnerModel).toBe('ollama:qwen2.5-coder:7b');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.winnerStack).toBe('ollama');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.applyRoute).toContain('agent_model_compare apply');
      expect(cookbook.localCookbook.benchmarkHistory?.evidence).toMatchObject({
        status: 'reviewed-winner',
        confidence: 'measured',
        comparisonCount: 1,
        revealedJudgmentCount: 1,
      });
      expect(cookbook.localCookbook.benchmarkHistory?.evidence?.winnerStacks).toContain('ollama');
      expect(cookbook.localCookbook.benchmarkHistory?.evidence?.winnerModels[0]?.registryKey).toBe('ollama:qwen2.5-coder:7b');
      expect(cookbook.localCookbook.benchmarkHistory?.evidence?.routeLatencies?.find((entry) => entry.registryKey === 'ollama:qwen2.5-coder:7b')).toMatchObject({
        latencyMs: 642,
        artifactId: 'artifact-1',
      });
      expect(cookbook.localCookbook.benchmarkHistory?.nextAction).toContain('revealed saved judgment');
      expect(cookbook.localCookbook.benchmarkHistory?.analyticsRoute).toContain('agent_model_compare analytics');
      expect(cookbook.localCookbook.benchmarkHistory?.analyticsRoute).toContain('benchmarkKind:"local-model-route"');
      const ollamaRecipe = cookbook.localCookbook.recipes?.find((recipe) => recipe.id === 'ollama');
      expect(ollamaRecipe?.readiness?.confidence).toBeNull();
      expect(ollamaRecipe?.readiness?.missingSignals?.join('\n')).not.toContain('No live latency benchmark');
      expect(ollamaRecipe?.readiness?.missingSignals?.join('\n')).toContain('exact configured route');
      expect(ollamaRecipe?.readiness?.nextStep).toContain('separately confirmed');

      const setup = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly localModelReadiness?: {
          readonly benchmarkHistory?: {
            readonly status: string;
            readonly artifacts: readonly { readonly artifactId: string }[];
            readonly evidence?: { readonly status: string; readonly winnerStacks: readonly string[] };
          };
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'local-model-readiness' });
      expect(setup.setupItemId).toBe('local-model-readiness');
      expect(setup.localModelReadiness?.benchmarkHistory?.status).toBe('history-found');
      expect(setup.localModelReadiness?.benchmarkHistory?.artifacts.map((artifact) => artifact.artifactId)).toEqual(['artifact-1']);
      expect(setup.localModelReadiness?.benchmarkHistory?.evidence?.status).toBe('reviewed-winner');
      // Startup preserves the native linked winner but does not read a stack from its name.
      expect(setup.localModelReadiness?.benchmarkHistory?.evidence?.winnerStacks).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });


  test('scores model route readiness from provider metadata without hiding missing benchmarks', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-cmp_latency.json',
      text: '{}',
      metadata: {
        purpose: 'agent-model-compare',
        benchmarkKind: 'local-model-route',
        comparisonId: 'cmp_latency',
        promptPreview: 'local model benchmark: Ollama route latency',
        candidateCount: 2,
        completedCandidates: 2,
        candidateLatencyEvidence: [
          {
            blindId: 'A',
            status: 'completed',
            latencyMs: 642,
            registryKey: 'ollama:qwen2.5-coder:7b',
            providerId: 'ollama',
            modelId: 'qwen2.5-coder:7b',
            displayName: 'Qwen local',
          },
          {
            blindId: 'B',
            status: 'completed',
            latencyMs: 1220,
            registryKey: 'openai:gpt-4.1',
            providerId: 'openai',
            modelId: 'gpt-4.1',
            displayName: 'GPT 4.1',
          },
        ],
      },
    });
    for (const artifact of artifacts.records) Object.assign(artifact, { createdAt: 1700000000000 });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const cloudModel = {
        registryKey: 'openai:gpt-4.1',
        modelId: 'gpt-4.1',
        providerId: 'openai',
        displayName: 'GPT 4.1',
        current: true,
        contextWindow: 128_000,
        reasoningEffort: ['low', 'medium', 'high'],
        capabilities: {
          toolCalling: true,
          codeEditing: true,
          reasoning: true,
          multimodal: true,
        },
        tier: 'premium',
        benchmark: {
          compositeScore: 0.82,
          qualityTier: 'S',
        },
      };
      const localModel = {
        registryKey: 'ollama:qwen2.5-coder:7b',
        modelId: 'qwen2.5-coder:7b',
        providerId: 'ollama',
        displayName: 'Qwen local',
        current: false,
        contextWindow: 32_768,
        reasoningEffort: [],
        capabilities: {
          toolCalling: false,
          codeEditing: true,
          reasoning: false,
          multimodal: false,
        },
        tier: 'free',
      };
      (fixture.context.clients as Record<string, unknown>).providerApi = {
        getFavorites: async () => ({ pinned: [cloudModel], recent: [] }),
        getCurrentModel: async () => cloudModel,
        listModels: async () => [cloudModel, localModel],
        listProviderIds: () => ['openai', 'ollama'],
      };

      const registryModels = fixture.context.provider.providerRegistry.listModels();
      for (const providerId of ['openai', 'ollama']) scriptHarnessLocalReading('route', {
        evidence_kind: 'registry', registry_text: providerId, record: { providerId, providers: [], models: registryModels },
      }, { kind: 'choice', choice: providerId === 'ollama' ? 'ollama' : 'not-local' });

      const routing = await executeHarnessJson<{
        readonly current: {
          readonly currentModel?: {
            readonly readiness?: { readonly score: number; readonly dimensions: readonly { readonly id: string }[] };
            readonly benchmarkCompositeScore?: number | null;
          } | null;
        };
        readonly models: readonly {
          readonly modelRouteId: string;
          readonly tier?: string | null;
          readonly benchmarkCompositeScore?: number | null;
          readonly localBenchmarkLatency?: { readonly latencyMs: number; readonly artifactId: string } | null;
          readonly readinessScore?: number;
          readonly readinessLevel?: string;
          readonly readiness?: {
            readonly score: number;
            readonly level: string;
            readonly confidence: string;
            readonly dimensions: readonly { readonly id: string; readonly score: number; readonly summary?: string }[];
            readonly missingSignals: readonly string[];
            readonly providerHealth: {
              readonly status: string;
              readonly sdkContract: {
                readonly providerHealthTypes: string;
                readonly importSurface: string;
              };
              readonly daemonPublication: {
                readonly status: string;
                readonly requiredPath: string;
              };
              readonly agentConsumption: {
                readonly status: string;
                readonly readModelPath: string | null;
              };
              readonly healthStatus?: string;
              readonly avgLatencyMs?: number;
              readonly missingSignals: readonly string[];
            };
            readonly nextStep: string;
          };
        }[];
      }>(fixture, { mode: 'model_routing', includeParameters: true, limit: 10 });

      expect(routing.current.currentModel?.benchmarkCompositeScore).toBe(0.82);
      expect(routing.current.currentModel?.readiness?.dimensions.map((dimension) => dimension.id)).toEqual([
        'latency',
        'context-window',
        'tool-support',
        'vision',
        'cost',
        'privacy',
      ]);
      const cloud = routing.models.find((model) => model.modelRouteId === 'openai:gpt-4.1');
      expect(cloud?.tier).toBe('premium');
      expect(cloud?.benchmarkCompositeScore).toBe(0.82);
      expect(cloud?.localBenchmarkLatency).toMatchObject({
        latencyMs: 1220,
        artifactId: 'artifact-1',
      });
      expect(cloud?.readinessScore).toBeNull();
      expect(cloud?.readinessLevel).toBeNull();
      expect(cloud?.readiness?.dimensions.find((dimension) => dimension.id === 'tool-support')?.score).toBe(75);
      expect(cloud?.readiness?.dimensions.find((dimension) => dimension.id === 'vision')?.score).toBe(75);
      expect(cloud?.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('rubric reading');
      expect(cloud?.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(cloud?.readiness?.providerHealth.status).toBe('not-reachable-in-command-context');
      expect(cloud?.readiness?.providerHealth.sdkContract.providerHealthTypes).toBe('available');
      expect(cloud?.readiness?.providerHealth.sdkContract.importSurface).toBe('@goodvibes-jev/engine/sdk/platform/runtime/ui');
      expect(cloud?.readiness?.providerHealth.daemonPublication.status).toBe('not-published');
      expect(cloud?.readiness?.providerHealth.daemonPublication.requiredPath).toBe('context.platform.readModels.providerHealth');
      expect(cloud?.readiness?.providerHealth.agentConsumption.status).toBe('waiting-for-published-feed');
      expect(cloud?.readiness?.providerHealth.missingSignals.join('\n')).toContain('SDK provider-health types are available');
      expect(cloud?.readiness?.nextStep).toContain('separately confirmed');

      const local = routing.models.find((model) => model.modelRouteId === 'ollama:qwen2.5-coder:7b');
      expect(local?.localBenchmarkLatency).toMatchObject({
        latencyMs: 642,
        artifactId: 'artifact-1',
      });
      expect(local?.readiness?.dimensions.find((dimension) => dimension.id === 'privacy')?.score).toBeNull();
      expect(local?.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('rubric reading');
      expect(local?.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(local?.readiness?.nextStep).toContain('separately confirmed');

      const inspected = await executeHarnessJson<{
        readonly modelRouteId: string;
        readonly localBenchmarkLatency?: { readonly latencyMs: number; readonly artifactId: string } | null;
        readonly readiness?: {
          readonly confidence: string;
          readonly dimensions: readonly { readonly id: string; readonly summary?: string }[];
          readonly missingSignals: readonly string[];
          readonly providerHealth: {
            readonly status: string;
            readonly agentConsumption: { readonly status: string };
            readonly missingSignals: readonly string[];
          };
        };
      }>(fixture, { mode: 'model_route', modelRouteId: 'ollama:qwen2.5-coder:7b' });
      expect(inspected.modelRouteId).toBe('ollama:qwen2.5-coder:7b');
      expect(inspected.localBenchmarkLatency).toMatchObject({
        latencyMs: 642,
        artifactId: 'artifact-1',
      });
      expect(inspected.readiness?.dimensions.map((dimension) => dimension.id)).toContain('cost');
      expect(inspected.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('rubric reading');
      expect(inspected.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(inspected.readiness?.providerHealth.status).toBe('not-reachable-in-command-context');
      expect(inspected.readiness?.providerHealth.agentConsumption.status).toBe('waiting-for-published-feed');

      (fixture.context.platform as unknown as Record<string, unknown>).readModels = {
        modelRouteHealth: {
          getSnapshot: () => ({
            routes: new Map([[
              'openai:gpt-4.1',
              {
                recordId: 'route-health-openai-gpt4',
                modelRouteId: 'openai:gpt-4.1',
                providerId: 'openai',
                status: 'healthy',
                isConfigured: true,
                isActive: true,
                stats: {
                  avgLatencyMs: 321,
                  minLatencyMs: 200,
                  maxLatencyMs: 650,
                  lastSuccessAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                  lastCheckedAt: '2026-01-02T03:05:00.000Z',
                },
                rateLimit: {
                  remaining: 4900,
                  limit: 5000,
                  resetAt: '2026-01-02T04:00:00.000Z',
                },
                errors: {
                  errorRate: 0,
                  consecutiveErrors: 0,
                  lastErrorMessage: 'prior transient 429',
                },
              },
            ]]),
          }),
        },
      };
      const healthBacked = await executeHarnessJson<{
        readonly modelRouteId: string;
        readonly readiness?: {
          readonly confidence: string;
          readonly dimensions: readonly { readonly id: string; readonly score: number; readonly summary: string }[];
          readonly missingSignals: readonly string[];
          readonly providerHealth: {
            readonly status: string;
            readonly healthStatus?: string;
            readonly modelRouteId?: string;
            readonly sourceRecordId?: string;
            readonly avgLatencyMs?: number;
            readonly rateLimitRemaining?: number;
            readonly rateLimitResetAt?: string | null;
            readonly lastErrorMessage?: string;
            readonly agentConsumption: { readonly status: string; readonly readModelPath: string | null };
            readonly daemonPublication: { readonly status: string };
          };
        };
      }>(fixture, { mode: 'model_route', modelRouteId: 'openai:gpt-4.1' });
      expect(healthBacked.modelRouteId).toBe('openai:gpt-4.1');
      expect(healthBacked.readiness?.confidence).toBeNull();
      expect(healthBacked.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(healthBacked.readiness?.providerHealth.status).toBe('record-found');
      expect(healthBacked.readiness?.providerHealth.healthStatus).toBe('healthy');
      expect(healthBacked.readiness?.providerHealth.modelRouteId).toBe('openai:gpt-4.1');
      expect(healthBacked.readiness?.providerHealth.sourceRecordId).toBe('route-health-openai-gpt4');
      expect(healthBacked.readiness?.providerHealth.avgLatencyMs).toBe(321);
      expect(healthBacked.readiness?.providerHealth.rateLimitRemaining).toBe(4900);
      expect(healthBacked.readiness?.providerHealth.rateLimitResetAt).toBe('2026-01-02T04:00:00.000Z');
      expect(healthBacked.readiness?.providerHealth.lastErrorMessage).toBeUndefined();
      expect(healthBacked.readiness?.providerHealth.agentConsumption.status).toBe('consumed');
      expect(healthBacked.readiness?.providerHealth.agentConsumption.readModelPath).toBe('context.platform.readModels.modelRouteHealth');
      expect(healthBacked.readiness?.providerHealth.daemonPublication.status).toBe('published-read-model');
      expect(healthBacked.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('rubric reading');
    } finally {
      fixture.cleanup();
    }
  });
});
