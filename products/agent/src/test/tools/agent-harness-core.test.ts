import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentPromptContextReceiptStore } from '../../agent/prompt-context-receipts.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { createHarnessArtifactStore, makeFixture, makeMemoryRecord, attachMemoryApi, expectModelFacingText, expectRowsHaveCompactModelRoutes, executeHarnessJson, writeConnectedHostOperatorToken, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


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


  test('summary checks earlier catalog owners before publishing later catalog results', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    const readiness = await import('../../tools/agent-harness-release-readiness.ts');
    let reached = false;
    const later = spyOn(readiness, 'releaseReadinessInventoryStatus').mockImplementationOnce(async () => {
      reached = true;
      Object.assign(fixture.context.platform, { artifactStore: createHarnessArtifactStore().store });
      return { status: 'available' };
    });
    try {
      await expect(fixture.tool.execute({ mode: 'summary' })).rejects.toThrow();
      expect(reached).toBe(true);
    } finally { later.mockRestore(); fixture.cleanup(); }
  });


  test('exposes a searchable compact harness mode catalog to the model', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary' });
      expect(summary.success, summary.error).toBe(true);
      if (!summary.success) throw new Error(summary.error);
      const summaryJson = JSON.parse(summary.output ?? '{}') as {
        readonly assistant?: {
          readonly status?: string;
          readonly primaryNextAction?: string;
          readonly boundaryPolicy?: string;
          readonly lanes?: readonly {
            readonly id: string;
            readonly label: string;
            readonly state: string;
            readonly routes: readonly string[];
          }[];
        };
        readonly harnessModes?: number;
        readonly modeGuide?: { readonly discover?: readonly string[]; readonly inspect?: readonly string[] };
      };
      expect(summaryJson.assistant?.status).toBeTruthy();
      expect(summaryJson.assistant?.primaryNextAction).toBeTruthy();
      expect(summaryJson.assistant?.boundaryPolicy).toContain('Primary UX is one assistant');
      expect(summaryJson.assistant?.lanes?.map((lane) => lane.id)).toEqual([
        'setup',
        'chat-and-model',
        'work-and-files',
        'personal-ops',
        'research-and-docs',
        'background-work',
        'safety-and-recovery',
      ]);
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'setup')?.routes.join('\n')).toContain('setup action:"status"');
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'setup')?.routes.join('\n')).toContain('setup action:"token"');
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'setup')?.routes.join('\n')).toContain('setup action:"smoke"');
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'work-and-files')?.label).toBe('Work in this project');
      expect(summaryJson.harnessModes).toBeGreaterThan(60);
      expect(summaryJson.modeGuide?.discover).toContain('modes');
      expect(summaryJson.modeGuide?.discover).toContain('execution_posture');
      expect(summaryJson.modeGuide?.discover).toContain('execution_history');
      expect(summaryJson.modeGuide?.discover).toContain('file_recovery');
      expect(summaryJson.modeGuide?.discover).toContain('personal_ops');
      expect(summaryJson.modeGuide?.discover).toContain('autonomy_intake');
      expect(summaryJson.modeGuide?.discover).toContain('research_briefing');
      expect(summaryJson.modeGuide?.discover).toContain('research_runs');
      expect(summaryJson.modeGuide?.inspect).toContain('mode');
      expect(summaryJson.modeGuide?.inspect).toContain('execution_route');
      expect(summaryJson.modeGuide?.inspect).toContain('execution_history_item');
      expect(summaryJson.modeGuide?.inspect).toContain('personal_ops_lane');
      expect(summaryJson.modeGuide?.inspect).toContain('research_run');
      expect(summaryJson.modeGuide?.inspect).toContain('research_source');
      expect(summaryJson.modeGuide?.inspect).toContain('document_ops_lane');

      const allModes = await fixture.tool.execute({ mode: 'modes', limit: 500 });
      expect(allModes.success).toBe(true);
      if (!allModes.success) throw new Error(allModes.error);
      const allModesJson = JSON.parse(allModes.output ?? '{}') as {
        readonly modes: readonly { readonly summary?: string; readonly next?: string; readonly parameters?: readonly string[] }[];
      };
      expect(allModesJson.modes.length).toBe(summaryJson.harnessModes!);
      expect(allModesJson.modes.filter((entry) => (entry.summary?.length ?? 0) > 72)).toEqual([]);
      expect(allModesJson.modes.filter((entry) => (entry.next?.length ?? 0) > 72)).toEqual([]);
      expect(allModesJson.modes.filter((entry) => entry.parameters !== undefined)).toEqual([]);

      const settingsModes = await fixture.tool.execute({ mode: 'modes', query: 'settings' });
      expect(settingsModes.success).toBe(true);
      if (!settingsModes.success) throw new Error(settingsModes.error);
      const settingsJson = JSON.parse(settingsModes.output ?? '{}') as {
        readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[] }[];
        readonly returned: number;
        readonly total: number;
      };
      expect(settingsJson.total).toBe(summaryJson.harnessModes!);
      expect(settingsJson.returned).toBeGreaterThan(0);
      expect(settingsJson.modes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
        'settings',
        'get_setting',
        'set_setting',
        'reset_setting',
      ]));
      expect(settingsJson.modes.filter((entry) => entry.parameters !== undefined)).toEqual([]);

      const personalModes = await fixture.tool.execute({ mode: 'modes', query: 'personal operations' });
      expect(personalModes.success).toBe(true);
      expect(personalModes.output).toContain('personal_ops');

      const autonomyModes = await fixture.tool.execute({ mode: 'modes', query: 'ongoing-work' });
      expect(autonomyModes.success).toBe(true);
      expect(autonomyModes.output).toContain('autonomy_intake');

      const executionModes = await fixture.tool.execute({ mode: 'modes', query: 'local shell execution' });
      expect(executionModes.success).toBe(true);
      expect(executionModes.output).toContain('execution_posture');

      const recoveryModes = await fixture.tool.execute({ mode: 'modes', query: 'file edit undo recovery' });
      expect(recoveryModes.success).toBe(true);
      const recoveryModesJson = JSON.parse(recoveryModes.output ?? '{}') as {
        readonly modes: readonly { readonly id: string; readonly next?: string }[];
      };
      expect(recoveryModesJson.modes[0]?.id).toBe('file_recovery');
      expect(recoveryModesJson.modes[0]?.next).toContain('execution action:"recovery"');

      const historyModes = await fixture.tool.execute({ mode: 'modes', query: 'execution history record' });
      expect(historyModes.success).toBe(true);
      const historyModesJson = JSON.parse(historyModes.output ?? '{}') as {
        readonly modes: readonly { readonly id: string; readonly next?: string }[];
      };
      expect(historyModesJson.modes.map((mode) => mode.id)).toContain('execution_history');
      expect(historyModesJson.modes.find((mode) => mode.id === 'execution_history')?.next).toContain('execution action:"history"');

      const documentModes = await fixture.tool.execute({ mode: 'modes', query: 'blind model comparison documents uploads' });
      expect(documentModes.success).toBe(true);
      expect(documentModes.output).toContain('document_ops');

      const detailedModes = await fixture.tool.execute({
        mode: 'modes',
        query: 'settings',
        includeParameters: true,
        limit: 1,
      });
      expect(detailedModes.success).toBe(true);
      if (!detailedModes.success) throw new Error(detailedModes.error);
      expect(detailedModes.output).toContain('"parameters"');
      expectModelFacingText(allModes.output!);
      expectModelFacingText(detailedModes.output!);

      const taskPhrase = await fixture.tool.execute({ mode: 'modes', query: 'set setting' });
      expect(taskPhrase.success).toBe(true);
      if (!taskPhrase.success) throw new Error(taskPhrase.error);
      const taskPhraseJson = JSON.parse(taskPhrase.output ?? '{}') as {
        readonly modes: readonly { readonly id: string }[];
      };
      expect(taskPhraseJson.modes[0]?.id).toBe('set_setting');
      expect(taskPhraseJson.modes.map((entry) => entry.id)).toContain('set_setting');

      const setSetting = await fixture.tool.execute({ mode: 'mode', target: 'set_setting' });
      expect(setSetting.success).toBe(true);
      if (!setSetting.success) throw new Error(setSetting.error);
      const setSettingJson = JSON.parse(setSetting.output ?? '{}') as {
        readonly id: string;
        readonly kind: string;
        readonly family: string;
        readonly requiresConfirmation?: boolean;
        readonly parameters?: readonly string[];
        readonly lookup?: { readonly resolvedBy?: string };
      };
      expect(setSettingJson).toMatchObject({
        id: 'set_setting',
        kind: 'effect',
        family: 'settings',
      });
      expect(setSettingJson.parameters).toEqual(expect.arrayContaining(['key', 'value']));
      expect(setSettingJson.requiresConfirmation).toBeUndefined();
      expect(setSettingJson.lookup?.resolvedBy).toBe('id');

      const missing = await fixture.tool.execute({ mode: 'mode' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('mode inspection requires target or query');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes a prioritized first-run setup plan with route-backed next actions', async () => {
    const fixture = makeFixture();
    try {
      const summary = await executeHarnessJson<{
        readonly setupPosture?: {
          readonly planItems?: number;
          readonly blockedPlanItems?: number;
          readonly autonomyBlockers?: number;
          readonly nextSetupHandoffs?: readonly {
            readonly setupItemId: string;
            readonly handoffRoute?: string;
            readonly handoffKind?: string;
            readonly requiresConfirmation?: boolean;
          }[];
          readonly setupWizard?: {
            readonly status: string;
            readonly completedSteps: number;
            readonly totalSteps: number;
            readonly currentStepId: string;
            readonly currentStepLabel: string;
            readonly reviewRoute: string;
          };
          readonly setupCloseout?: {
            readonly status: string;
            readonly primaryStepId: string | null;
            readonly modelRoute: string;
            readonly requiresConfirmation: boolean;
          };
        };
      }>(fixture, { mode: 'summary', includeParameters: true });
      expect(summary.setupPosture?.planItems).toBeGreaterThanOrEqual(7);
      expect(typeof summary.setupPosture?.blockedPlanItems).toBe('number');
      expect(summary.setupPosture?.autonomyBlockers).toBeGreaterThanOrEqual(1);
      expect(summary.setupPosture?.nextSetupHandoffs?.[0]?.setupItemId).toBe('connected-host-readiness');
      expect(summary.setupPosture?.nextSetupHandoffs?.[0]?.handoffRoute).toContain('host action:"status"');
      expect(summary.setupPosture?.setupWizard?.status).toBe('blocked');
      expect(summary.setupPosture?.setupWizard?.currentStepId).toBe('connected-host-auth');
      expect(summary.setupPosture?.setupWizard?.currentStepLabel).toBe('Connected-host auth');
      expect(summary.setupPosture?.setupWizard?.reviewRoute).toContain('setup action:"status"');
      expect(summary.setupPosture?.setupCloseout).toMatchObject({
        status: 'blocked',
        primaryStepId: 'connected-host-auth',
        requiresConfirmation: false,
      });
      expect(summary.setupPosture?.setupCloseout?.modelRoute).toContain('setup action:"token"');

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly readinessPlan: {
            readonly blocked: number;
            readonly check: number;
            readonly blocksAutonomy: number;
          };
        };
        readonly setupWizard: {
          readonly status: string;
          readonly completedSteps: number;
          readonly totalSteps: number;
          readonly currentStepId: string;
          readonly currentStepLabel: string;
          readonly progressLabel: string;
          readonly next: string;
          readonly _diagnostic: {
            readonly closeout: {
              readonly status: string;
              readonly label: string;
              readonly summary: string;
              readonly primaryStepId: string | null;
              readonly primaryStepLabel: string | null;
              readonly modelRoute: string;
              readonly userRoute: string;
              readonly requiresConfirmation: boolean;
              readonly evidence: readonly string[];
            };
            readonly smokeHistory: { readonly status: string; readonly total: number; readonly rerunRoute: string; readonly saveRoute: string };
          };
          readonly steps: readonly { readonly id: string; readonly status: string; readonly modelRoute: string; readonly backtrackRoute?: string | null }[];
        };
        readonly setupCloseout: {
          readonly status: string;
          readonly primaryStepId: string | null;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
        };
        readonly readinessPlan: readonly {
          readonly setupItemId: string;
          readonly status: string;
          readonly priority: number;
          readonly blocksAutonomy: boolean;
          readonly nextAction: string;
          readonly userRoute: string;
          readonly modelRoute: string;
          readonly primaryHandoff?: {
            readonly id: string;
            readonly label: string;
            readonly kind: string;
            readonly effect: string;
            readonly userRoute: string;
            readonly modelRoute: string;
            readonly nextStep: string;
            readonly safety: string;
            readonly requiresConfirmation?: boolean;
          };
          readonly handoffs?: readonly {
            readonly id: string;
            readonly kind: string;
            readonly effect: string;
            readonly modelRoute: string;
            readonly requiresConfirmation?: boolean;
          }[];
          readonly signals?: readonly string[];
          readonly availableRepairCards?: readonly string[];
          readonly bootstrapRoute?: string;
          readonly repairCards?: readonly {
            readonly id: string;
            readonly state: string;
            readonly effect: string;
            readonly methodId?: string;
            readonly modelRoute?: string;
            readonly prerequisite?: string;
            readonly recommendedWhen: string;
            readonly safety: string;
          }[];
          readonly serviceLifecycleDecision?: {
            readonly status: string;
            readonly recommendedAction: string;
            readonly modelRoute: string;
            readonly reason: string;
            readonly evidence: {
              readonly probeStatus: string;
              readonly serviceStatusMethodPublished: boolean;
            };
            readonly receiptRules: readonly string[];
            readonly blockedMutations: readonly string[];
          };
          readonly bootstrapPlan?: {
            readonly status: string;
            readonly source: string;
            readonly recommendedWhen: string;
            readonly steps: readonly {
              readonly id: string;
              readonly commands: readonly string[];
              readonly fallback?: string;
            }[];
            readonly reconnectRoutes: { readonly agentStatus: string; readonly serviceDiagnostics: string; readonly setupItem: string };
            readonly policy: string;
          };
          readonly installSmokePlan?: {
            readonly status: string;
            readonly source: string;
            readonly checks: readonly { readonly id: string; readonly status: string; readonly route: string; readonly evidence: string }[];
            readonly successCriteria: readonly string[];
            readonly policy: string;
          };
          readonly localModelReadiness?: {
            readonly cookbookStatus: string;
            readonly inspectRoute: string;
            readonly inspectRecipeRoute: string;
            readonly readinessRubric?: {
              readonly dimensions: readonly { readonly id: string; readonly weight: number }[];
            };
            readonly topRecipe?: {
              readonly id: string;
              readonly readinessScore?: number | null;
              readonly setupStatus?: string;
            };
            readonly nextActions?: readonly string[];
          };
          readonly sudoPosture?: {
            readonly status: string;
            readonly setupStatus: string;
            readonly setupRoute: string;
            readonly credentialSignal: {
              readonly envPresent: boolean;
              readonly checked: string;
              readonly rawValueReturned: boolean;
              readonly valueUsableForBackgroundProcess: boolean;
            };
            readonly blockedRoutes: readonly { readonly id: string; readonly reason: string }[];
            readonly missingContracts: readonly string[];
            readonly policy: string;
          };
        }[];
        readonly nextSetupActions: readonly {
          readonly setupItemId: string;
          readonly status: string;
          readonly modelRoute: string;
          readonly handoffLabel?: string;
          readonly handoffKind?: string;
          readonly handoffRoute?: string;
          readonly handoffUserRoute?: string;
          readonly requiresConfirmation?: boolean;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'setup_posture', includeParameters: true });

      expect(typeof posture.summary.readinessPlan.blocked).toBe('number');
      expect(posture.summary.readinessPlan.check).toBeGreaterThanOrEqual(1);
      expect(posture.summary.readinessPlan.blocksAutonomy).toBeGreaterThanOrEqual(1);
      expect(posture.policy).toContain('Read-only setup/onboarding posture');
      expect(posture.setupWizard.status).toBe('blocked');
      expect(posture.setupWizard.currentStepId).toBe('connected-host-auth');
      expect(posture.setupWizard.currentStepLabel).toBe('Connected-host auth');
      expect(posture.setupWizard.progressLabel).toContain('setup step');
      expect(posture.setupWizard.next).toContain('Connected-host auth');
      expect(posture.setupWizard._diagnostic.smokeHistory.status).toBe('unavailable');
      expect(posture.setupWizard._diagnostic.smokeHistory.rerunRoute).toContain('setup action:"smoke"');
      expect(posture.setupWizard._diagnostic.smokeHistory.saveRoute).toContain('fields:{...}');
      expect(posture.setupWizard._diagnostic.closeout.status).toBe('blocked');
      expect(posture.setupWizard._diagnostic.closeout.label).toBe('Fix setup blocker');
      expect(posture.setupWizard._diagnostic.closeout.primaryStepId).toBe('connected-host-auth');
      expect(posture.setupWizard._diagnostic.closeout.modelRoute).toContain('setup action:"token"');
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('critical setup blockers: Connected-host auth');
      expect(posture.setupCloseout).toMatchObject({
        status: 'blocked',
        primaryStepId: 'connected-host-auth',
        requiresConfirmation: false,
      });
      expect(posture.setupWizard.steps[0]?.id).toBe('connected-host-readiness');
      expect(posture.setupWizard.steps[0]?.status).toBe('blocked');
      expect(posture.setupWizard.steps[0]?.modelRoute).toContain('host action:"status"');
      expect(posture.setupWizard.steps.find((step) => step.id === 'connected-host-auth')?.status).toBe('current');

      const first = posture.readinessPlan[0];
      expect(first?.setupItemId).toBe('connected-host-readiness');
      expect(first?.status).toBe('check');
      expect(first?.blocksAutonomy).toBe(true);
      expect(first?.modelRoute).toContain('host action:"status"');
      expect(first?.userRoute).toContain('Connected Host');
      expect(first?.primaryHandoff?.id).toBe('connected-host-status');
      expect(first?.primaryHandoff?.kind).toBe('diagnostic');
      expect(first?.primaryHandoff?.modelRoute).toContain('host action:"status"');
      expect(first?.handoffs?.map((handoff) => handoff.id)).toContain('connected-host-bootstrap');
      expect(first?.availableRepairCards).toContain('connected-host-status');
      expect(first?.bootstrapRoute).toContain('connected-host-readiness');
      expect(first?.serviceLifecycleDecision?.status).toBe('needs-status-receipt');
      expect(first?.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(first?.serviceLifecycleDecision?.modelRoute).toContain('services.status');
      expect(first?.serviceLifecycleDecision?.reason).toContain('Probe evidence is not enough');
      expect(first?.serviceLifecycleDecision?.evidence.serviceStatusMethodPublished).toBe(true);
      expect(first?.serviceLifecycleDecision?.receiptRules.join('\n')).toContain('installed:false');
      expect(first?.serviceLifecycleDecision?.blockedMutations.join('\n')).toContain('services.start');
      expect(first?.bootstrapPlan?.source).toContain('goodvibes-tui');
      expect(first?.bootstrapPlan?.steps.map((step) => step.id)).toEqual([
        'verify-bun',
        'install-goodvibes-host',
        'verify-goodvibes-binaries',
        'start-goodvibes-host',
        'reconnect-agent',
      ]);
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'install-goodvibes-host')?.commands.join('\n')).toContain('bun add -g @pellux/goodvibes-tui');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'install-goodvibes-host')?.commands.join('\n')).toContain('bun pm trust -g');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'verify-goodvibes-binaries')?.commands.join('\n')).toContain('goodvibes-daemon --version');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'start-goodvibes-host')?.commands.join('\n')).toContain('goodvibes service start');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'reconnect-agent')?.fallback).toContain('GOODVIBES_AGENT_RUNTIME_URL');
      expect(first?.bootstrapPlan?.reconnectRoutes.agentStatus).toContain('host action:"status"');
      expect(first?.bootstrapPlan?.policy).toContain('does not run host install/start commands implicitly');
      expect(first?.repairCards?.find((card) => card.id === 'service-status')?.methodId).toBe('services.status');
      expect(first?.repairCards?.find((card) => card.id === 'service-install')?.modelRoute).toContain('services.install');
      expect(first?.repairCards?.find((card) => card.id === 'service-start')?.effect).toBe('confirmed-effect');
      expect(first?.repairCards?.find((card) => card.id === 'service-restart')?.safety).toContain('Confirmed service mutation');
      expect(first?.repairCards?.some((card) => card.methodId === 'services.uninstall')).toBe(false);

      expect(posture.readinessPlan
        .filter((item) => item.status === 'blocked' || item.status === 'check' || item.status === 'recommended')
        .every((item) => Boolean(item.primaryHandoff?.modelRoute))).toBe(true);
      const auth = posture.readinessPlan.find((item) => item.setupItemId === 'connected-host-auth');
      expect(auth?.primaryHandoff?.id).toBe('provision-connected-host-token');
      expect(auth?.primaryHandoff?.requiresConfirmation).toBe(true);
      expect(auth?.primaryHandoff?.modelRoute).toContain('setup action:"token"');

      const provider = posture.readinessPlan.find((item) => item.setupItemId === 'provider-access');
      expect(['ready', 'blocked']).toContain(provider!.status);
      expect(provider?.blocksAutonomy).toBe(true);
      expect(provider?.modelRoute).toContain('models action:"status');
      expect(provider?.nextAction).toMatch(/Choose a provider\/model route|Review the current model route/);
      expect(provider?.primaryHandoff?.id).toBe('open-main-model-picker');
      expect(provider?.primaryHandoff?.modelRoute).toContain('surfaceId:"model-picker"');
      expect(provider?.primaryHandoff?.requiresConfirmation).toBe(true);
      expect(posture.nextSetupActions[0]?.setupItemId).toBe('connected-host-readiness');
      expect(posture.nextSetupActions[0]?.handoffRoute).toContain('host action:"status"');
      expect(posture.nextSetupActions.find((item) => item.setupItemId === 'connected-host-auth')?.handoffRoute).toContain('setup action:"token"');

      const installSmoke = posture.readinessPlan.find((item) => item.setupItemId === 'install-smoke');
      expect(installSmoke?.status).toBe('blocked');
      expect(installSmoke?.blocksAutonomy).toBe(false);
      expect(installSmoke?.priority).toBe(22);
      expect(installSmoke?.modelRoute).toContain('install-smoke');
      expect(installSmoke?.primaryHandoff?.id).toBe('run-setup-smoke');
      expect(installSmoke?.primaryHandoff?.modelRoute).toContain('setup action:"smoke"');
      expect(installSmoke?.primaryHandoff?.requiresConfirmation).toBe(true);
      expect(installSmoke?.signals?.join('\n')).toContain('install smoke');
      expect(installSmoke?.installSmokePlan?.source).toContain('GoodVibes Agent installed package');
      expect(installSmoke?.installSmokePlan?.checks.map((check) => check.id)).toEqual([
        'agent-binary',
        'connected-host-status',
        'connected-host-auth',
        'provider-model',
        'setup-posture',
        'first-assistant-turn',
      ]);
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'agent-binary')?.route).toContain('goodvibes-agent --version');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'connected-host-status')?.route).toContain('host action:"status"');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'connected-host-auth')?.route).toContain('connected-host-auth');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'provider-model')?.route).toContain('models action:"status"');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'first-assistant-turn')?.route).toContain('Say ready');
      expect(installSmoke?.installSmokePlan?.successCriteria.join('\n')).toContain('first assistant turn');
      expect(installSmoke?.installSmokePlan?.policy).toContain('does not run package, host, or shell smoke commands implicitly');

      const localModels = posture.readinessPlan.find((item) => item.setupItemId === 'local-model-readiness');
      expect(localModels?.status).toBe('recommended');
      expect(localModels?.blocksAutonomy).toBe(false);
      expect(localModels?.modelRoute).toBe('models action:"local"');
      expect(localModels?.primaryHandoff?.id).toBe('inspect-local-model-cookbook');
      expect(localModels?.primaryHandoff?.modelRoute).toContain('models action:"local"');
      expect(localModels?.signals?.join('\n')).toContain('cookbook status');
      expect(localModels?.signals?.join('\n')).toContain('top recipe');
      expect(localModels?.localModelReadiness?.cookbookStatus).toBe('recommendations-only');
      expect(localModels?.localModelReadiness?.inspectRoute).toContain('models action:"local"');
      expect(localModels?.localModelReadiness?.inspectRecipeRoute).toContain('local-model-cookbook');
      // Startup is a facts-only snapshot: no model judgment or fabricated winner.
      expect(localModels?.localModelReadiness?.topRecipe?.id).toBe('');
      expect(localModels?.localModelReadiness?.topRecipe?.readinessScore).toBeNull();
      expect(localModels?.signals?.join('\n')).toContain('top recipe: unknown readiness=unknown fit=unknown');
      expect(localModels?.localModelReadiness?.readinessRubric?.dimensions.map((dimension) => dimension.id)).toEqual([
        'latency',
        'context-window',
        'tool-support',
        'vision',
        'cost',
        'privacy',
      ]);
      expect(localModels?.localModelReadiness?.nextActions?.join('\n')).toContain('Refresh the model catalog');

      const browserControl = posture.readinessPlan.find((item) => item.setupItemId === 'browser-desktop-control');
      expect(browserControl?.status).toBe('recommended');
      expect(browserControl?.blocksAutonomy).toBe(false);
      expect(browserControl?.userRoute).toContain('Tools & MCP');
      expect(browserControl?.modelRoute).toContain('mcp_servers');
      expect(browserControl?.signals?.join('\n')).toContain('No browser');

      const sudoPosture = posture.readinessPlan.find((item) => item.setupItemId === 'sudo-execution-posture');
      expect(['optional', 'check']).toContain(sudoPosture!.status);
      expect(sudoPosture?.blocksAutonomy).toBe(false);
      expect(sudoPosture?.priority).toBe(66);
      expect(sudoPosture?.modelRoute).toContain('sudo-execution-posture');
      expect(sudoPosture?.primaryHandoff?.id).toBe('inspect-sudo-posture');
      expect(sudoPosture?.handoffs?.map((handoff) => handoff.id)).toEqual(expect.arrayContaining([
        'inspect-process-parity',
        'inspect-foreground-shell-route',
        'review-sudo-env-guidance',
      ]));
      expect(sudoPosture?.signals?.join('\n')).toContain('background sudo prompt: blocked');
      expect(sudoPosture?.sudoPosture?.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(sudoPosture?.sudoPosture?.credentialSignal.rawValueReturned).toBe(false);
      expect(sudoPosture?.sudoPosture?.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(sudoPosture?.sudoPosture?.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');
      expect(sudoPosture?.sudoPosture?.missingContracts).toContain('daemon credential-prompt mediation');
      expect(sudoPosture?.sudoPosture?.policy).toContain('never reads');

      const hostItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly modelRoute: string;
        readonly bootstrapPlan?: {
          readonly steps: readonly { readonly id: string; readonly commands: readonly string[] }[];
          readonly policy: string;
        };
        readonly repairCards?: readonly {
          readonly id: string;
          readonly state: string;
          readonly methodId?: string;
          readonly modelRoute?: string;
        }[];
        readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string; readonly modelRoute: string };
        readonly policy?: { readonly effect: string };
      }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });
      expect(hostItem.setupItemId).toBe('connected-host-readiness');
      expect(hostItem.status).toBe('check');
      expect(hostItem.lookup?.resolvedBy).toBe('plan-id');
      expect(hostItem.modelRoute).toContain('host action:"status"');
      expect(hostItem.bootstrapPlan?.steps.find((step) => step.id === 'verify-bun')?.commands).toEqual(['bun --version']);
      expect(hostItem.bootstrapPlan?.policy).toContain('confirmed operator methods');
      expect(hostItem.repairCards?.find((card) => card.id === 'service-start')?.modelRoute).toContain('services.start');
      expect(hostItem.serviceLifecycleDecision?.status).toBe('needs-status-receipt');
      expect(hostItem.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(hostItem.serviceLifecycleDecision?.modelRoute).toContain('services.status');
      expect(hostItem.policy?.effect).toBe('read-only');

      const hostRepair = await executeHarnessJson<{
        readonly mode: string;
        readonly setupItemId: string;
        readonly decision: {
          readonly id: string;
          readonly status: string;
          readonly effect: string;
          readonly modelRoute: string;
          readonly requiresConfirmation?: boolean;
        };
        readonly possibleConfirmedRepairs?: readonly { readonly id: string; readonly requiresConfirmation?: boolean; readonly modelRoute: string }[];
        readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string };
        readonly policy: { readonly effect: string; readonly boundary: string; readonly hostOwnership: string };
      }>(fixture, { mode: 'setup_repair', setupItemId: 'connected-host-readiness', includeParameters: true });
      expect(hostRepair.mode).toBe('setup_repair');
      expect(hostRepair.setupItemId).toBe('connected-host-readiness');
      expect(hostRepair.decision.id).toBe('service-status');
      expect(hostRepair.decision.status).toBe('inspect-first');
      expect(hostRepair.decision.effect).toBe('read-only');
      expect(hostRepair.decision.modelRoute).toContain('services.status');
      expect(hostRepair.decision.requiresConfirmation).toBeUndefined();
      expect(hostRepair.possibleConfirmedRepairs?.map((repair) => repair.id)).toEqual(expect.arrayContaining([
        'service-install',
        'service-start',
        'service-restart',
      ]));
      expect(hostRepair.possibleConfirmedRepairs?.every((repair) => repair.requiresConfirmation === true)).toBe(true);
      expect(hostRepair.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(hostRepair.policy.effect).toBe('read-only-repair-decision');
      expect(hostRepair.policy.boundary).toContain('never starts');
      expect(hostRepair.policy.hostOwnership).toContain('does not take ambient ownership');

      const localModelItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly modelRoute: string;
        readonly localModelReadiness?: {
          readonly topRecipe?: { readonly readinessScore?: number | null };
          readonly readinessRubric?: { readonly dimensions: readonly { readonly id: string }[] };
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'local-model-readiness' });
      expect(localModelItem.setupItemId).toBe('local-model-readiness');
      expect(localModelItem.status).toBe('recommended');
      expect(localModelItem.lookup?.resolvedBy).toBe('plan-id');
      expect(localModelItem.modelRoute).toContain('models action:"local"');
      expect(localModelItem.localModelReadiness?.topRecipe?.readinessScore).toBeNull();
      expect(localModelItem.localModelReadiness?.readinessRubric?.dimensions.map((dimension) => dimension.id)).toContain('privacy');

      const installSmokeItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly installSmokePlan?: {
          readonly status: string;
          readonly checks: readonly { readonly id: string; readonly status: string; readonly route: string }[];
          readonly policy: string;
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'install-smoke' });
      expect(installSmokeItem.setupItemId).toBe('install-smoke');
      expect(installSmokeItem.status).toBe('blocked');
      expect(installSmokeItem.lookup?.resolvedBy).toBe('plan-id');
      expect(installSmokeItem.installSmokePlan?.checks.find((check) => check.id === 'connected-host-auth')?.status).toBe('blocked');
      expect(installSmokeItem.installSmokePlan?.checks.find((check) => check.id === 'first-assistant-turn')?.status).toBe('user-run');
      expect(installSmokeItem.installSmokePlan?.policy).toContain('token-safe');

      const unconfirmedSmoke = await fixture.tool.execute({ mode: 'run_setup_smoke', setupItemId: 'install-smoke' });
      expect(unconfirmedSmoke.success).toBe(false);
      expect(unconfirmedSmoke.error).toContain('recorded effect admission');

      const smokeMissingConfirm = await fixture.tool.execute({
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        explicitUserRequest: 'Run the install smoke checks',
      });
      expect(smokeMissingConfirm.success).toBe(false);
      expect(smokeMissingConfirm.error).toContain('recorded effect admission');

      const smokeRun = await executeHarnessJson<{
        readonly status: string;
        readonly mode: string;
        readonly setupItemId: string;
        readonly smokeStatus: string;
        readonly result: string;
        readonly summary: { readonly blocked: number; readonly userRun: number; readonly total: number };
        readonly blockedChecks: readonly string[];
        readonly userRunChecks: readonly string[];
        readonly checks: readonly { readonly id: string; readonly status: string; readonly action: string; readonly route: string; readonly evidence: string }[];
        readonly artifact: { readonly status: string; readonly reason?: string; readonly supportedFields?: readonly string[] };
        readonly nextAction: string;
        readonly routes: { readonly inspectSetup: string; readonly inspectSmoke: string; readonly rerunSmoke: string };
        readonly policy: { readonly effect: string; readonly shell: string; readonly secrets: string; readonly source: string };
      }>(fixture, {
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        includeParameters: true,
        confirm: true,
        explicitUserRequest: 'Run the install smoke checks',
      });
      expect(smokeRun.status).toBe('executed');
      expect(smokeRun.mode).toBe('run_setup_smoke');
      expect(smokeRun.setupItemId).toBe('install-smoke');
      expect(smokeRun.smokeStatus).toBe('blocked');
      expect(smokeRun.result).toBe('blocked');
      expect(smokeRun.summary.total).toBe(6);
      expect(smokeRun.summary.blocked).toBeGreaterThanOrEqual(1);
      expect(smokeRun.summary.userRun).toBeGreaterThanOrEqual(1);
      expect(smokeRun.blockedChecks).toContain('connected-host-auth');
      expect(smokeRun.userRunChecks).toContain('first-assistant-turn');
      expect(smokeRun.checks.map((check) => check.id)).toEqual([
        'agent-binary',
        'connected-host-status',
        'connected-host-auth',
        'provider-model',
        'setup-posture',
        'first-assistant-turn',
      ]);
      expect(smokeRun.checks.find((check) => check.id === 'agent-binary')?.action).toBe('user-visible-run');
      expect(smokeRun.checks.find((check) => check.id === 'connected-host-auth')?.action).toBe('fix-before-smoke');
      expect(smokeRun.artifact.status).toBe('not_requested');
      expect(smokeRun.artifact.supportedFields).toContain('agentBinaryOutput');
      expect(smokeRun.nextAction).toContain('Resolve blocked checks');
      expect(smokeRun.routes.inspectSetup).toContain('setup action:"status"');
      expect(smokeRun.routes.inspectSmoke).toContain('install-smoke');
      expect(smokeRun.routes.rerunSmoke).toContain('setup action:"smoke"');
      expect(smokeRun.policy.effect).toBe('confirmed-redacted-setup-smoke');
      expect(smokeRun.policy.shell).toContain('No package, host, or shell commands were executed implicitly');
      expect(smokeRun.policy.secrets).toContain('tokens are never returned');
      expect(JSON.stringify(smokeRun)).not.toContain('fixture-connected-host-token');

      const browserItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly modelRoute: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(browserItem.setupItemId).toBe('browser-desktop-control');
      expect(browserItem.status).toBe('recommended');
      expect(browserItem.lookup?.resolvedBy).toBe('plan-id');
      expect(browserItem.modelRoute).toContain('mcp_servers');
      expect(browserItem.signals?.join('\n')).toContain('No browser');

      const sudoItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly sudoPosture?: {
          readonly setupRoute: string;
          readonly credentialSignal: {
            readonly checked: string;
            readonly rawValueReturned: boolean;
            readonly valueUsableForBackgroundProcess: boolean;
          };
          readonly supportedRoutes: readonly { readonly id: string; readonly route: string }[];
          readonly blockedRoutes: readonly { readonly id: string; readonly reason: string }[];
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'sudo-execution-posture' });
      expect(sudoItem.setupItemId).toBe('sudo-execution-posture');
      expect(['optional', 'check']).toContain(sudoItem.status);
      expect(sudoItem.lookup?.resolvedBy).toBe('plan-id');
      expect(sudoItem.sudoPosture?.setupRoute).toContain('sudo-execution-posture');
      expect(sudoItem.sudoPosture?.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(sudoItem.sudoPosture?.credentialSignal.rawValueReturned).toBe(false);
      expect(sudoItem.sudoPosture?.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(sudoItem.sudoPosture?.supportedRoutes.map((route) => route.id)).toContain('foreground-supervised-shell');
      expect(sudoItem.sudoPosture?.blockedRoutes.map((route) => route.id)).toContain('raw-password-display');
    } finally {
      fixture.cleanup();
    }
  });


  test('retains durable receipts as history without upgrading live host or auth readiness', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      text: '{}',
      filename: 'setup-service-ready.json',
      mimeType: 'application/json',
      metadata: {
        purpose: 'connected-host-setup-receipt',
        setupStepId: 'connected-host-readiness',
        methodId: 'services.status',
        receiptId: 'svc-ready',
        receiptStatus: 'ready',
        recordedAt: '1970-01-01T00:00:03.000Z',
        summary: 'services.status reported healthy.',
      },
    });
    await artifacts.store.create({
      text: '{}',
      filename: 'setup-auth-ready.json',
      mimeType: 'application/json',
      metadata: {
        purpose: 'connected-host-setup-receipt',
        setupStepId: 'connected-host-auth',
        receiptId: 'auth-ready',
        receiptStatus: 'authenticated',
        recordedAt: '1970-01-01T00:00:04.000Z',
        summary: 'Connected-host operator auth was validated.',
      },
    });
    await artifacts.store.create({
      text: '{}',
      filename: 'setup-smoke-ready.json',
      mimeType: 'application/json',
      metadata: {
        purpose: 'agent-setup-receipt',
        setupStepId: 'install-smoke',
        receiptId: 'smoke-ready',
        receiptStatus: 'ready',
        recordedAt: '1970-01-01T00:00:05.000Z',
        summary: 'Setup smoke completed with first assistant turn.',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const posture = await executeHarnessJson<{
        readonly setupWizard: {
          readonly steps: readonly { readonly id: string; readonly status: string; readonly detail: string }[];
          readonly _diagnostic: {
            readonly stepHistory: readonly {
              readonly kind: string;
              readonly receiptId: string;
              readonly receiptStatus?: string;
              readonly satisfiesReceipt?: boolean;
            }[];
            readonly receiptGaps: readonly { readonly stepId: string }[];
            readonly closeout: {
              readonly evidence: readonly string[];
            };
          };
        };
      }>(fixture, { mode: 'setup_posture', includeParameters: true });

      const steps = new Map(posture.setupWizard.steps.map((step) => [step.id, step]));
      expect(steps.get('connected-host-readiness')?.status).toBe('blocked');
      expect(steps.get('connected-host-readiness')?.detail).not.toContain('Durable receipt svc-ready');
      expect(steps.get('connected-host-auth')?.status).toBe('current');
      expect(steps.get('install-smoke')?.status).toBe('done');
      expect(posture.setupWizard._diagnostic.stepHistory.filter((entry) => entry.kind === 'durable-receipt')).toHaveLength(3);
      expect(posture.setupWizard._diagnostic.stepHistory.every((entry) => entry.satisfiesReceipt === true)).toBe(true);
      expect(posture.setupWizard._diagnostic.receiptGaps).toEqual([]);
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('setup smoke receipt: ready');
    } finally {
      fixture.cleanup();
    }
  });


  test('retains read-model receipts without upgrading live host or auth readiness', async () => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.setup = {
        getSnapshot: () => ({
          setupReceipts: {
            service: {
              setupStepId: 'connected-host-readiness',
              methodId: 'services.status',
              receiptId: 'live-svc-ready',
              receiptStatus: 'ready',
              recordedAt: '1970-01-01T00:00:03.000Z',
              summary: 'services.status reported healthy from live daemon setup receipts.',
            },
            auth: {
              setupStepId: 'connected-host-auth',
              receiptId: 'live-auth-ready',
              status: 'authenticated',
              recordedAt: '1970-01-01T00:00:04.000Z',
              summary: 'Connected-host operator auth token=hidden-live-secret was validated.',
              inspectRoute: 'setup action:"item" setupItemId:"connected-host-auth" includeParameters:true',
            },
            smoke: {
              setupStepId: 'install-smoke',
              receiptId: 'live-smoke-ready',
              outcome: 'ready',
              recordedAt: '1970-01-01T00:00:05.000Z',
              summary: 'Setup smoke completed through live setup receipt stream.',
            },
          },
        }),
      };
      readModels.setupReceiptEventStream = {
        listEvents: () => ({
          cursor: 'setup-cursor-0006',
          events: [{
            setupStepId: 'install-smoke',
            receiptId: 'live-smoke-event-ready',
            receiptStatus: 'ready',
            recordedAt: '1970-01-01T00:00:06.000Z',
            summary: 'Setup smoke event stream certified first-run output with token=event-stream-secret.',
            schemaVersion: 'goodvibes.setup.receipt.v1',
            schemaStatus: 'certified',
            methodId: 'setup.smoke',
            repairRoute: 'setup action:"smoke" setupItemId:"install-smoke" confirm:true explicitUserRequest:"..."',
            actionRoute: 'setup action:"finish" confirm:true explicitUserRequest:"..."',
            publicationGuarantee: 'The GoodVibes daemon publishes ordered setup receipt events before closeout; token=publication-secret.',
            publisher: 'goodvibes-daemon',
            eventSequence: 6,
            inspectRoute: 'setup action:"item" setupItemId:"install-smoke" includeParameters:true',
          }],
        }),
      };

      const posture = await executeHarnessJson<{
        readonly setupWizard: {
          readonly steps: readonly { readonly id: string; readonly status: string; readonly detail: string }[];
          readonly _diagnostic: {
            readonly stepHistory: readonly {
              readonly kind: string;
              readonly receiptId: string;
              readonly source?: string;
              readonly summary: string;
              readonly receiptStatus?: string;
              readonly satisfiesReceipt?: boolean;
              readonly schemaStatus?: string;
              readonly schemaVersion?: string;
              readonly provenance?: readonly string[];
              readonly publicationGuarantee?: string;
              readonly eventCursor?: string;
              readonly eventSequence?: number;
              readonly publisher?: string;
            }[];
            readonly receiptGaps: readonly { readonly stepId: string }[];
            readonly closeout: {
              readonly evidence: readonly string[];
            };
          };
        };
      }>(fixture, { mode: 'setup_posture', includeParameters: true });

      const steps = new Map(posture.setupWizard.steps.map((step) => [step.id, step]));
      expect(steps.get('connected-host-readiness')?.status).toBe('blocked');
      expect(steps.get('connected-host-readiness')?.detail).not.toContain('live-svc-ready');
      expect(steps.get('connected-host-auth')?.status).toBe('current');
      expect(steps.get('connected-host-auth')?.detail).not.toContain('hidden-live-secret');
      expect(steps.get('install-smoke')?.status).toBe('done');
      const durableHistory = posture.setupWizard._diagnostic.stepHistory.filter((entry: { kind: string; receiptId: string }) => entry.kind === 'durable-receipt');
      expect(durableHistory).toHaveLength(4);
      expect(durableHistory.filter((entry: { receiptId: string; source?: string }) => entry.receiptId !== 'live-smoke-event-ready').every((entry: { source?: string }) => entry.source === 'context.platform.readModels.setup')).toBe(true);
      expect(durableHistory.find((entry: { receiptId: string; summary: string }) => entry.receiptId === 'live-auth-ready')?.summary).toContain('token=<redacted>');
      const eventReceipt = durableHistory.find((entry: { receiptId: string }) => entry.receiptId === 'live-smoke-event-ready');
      expect(eventReceipt?.source).toBe('context.platform.readModels.setupReceiptEventStream');
      expect(eventReceipt?.schemaStatus).toBe('certified');
      expect(eventReceipt?.schemaVersion).toBe('goodvibes.setup.receipt.v1');
      expect(eventReceipt?.eventCursor).toBe('setup-cursor-0006');
      expect(eventReceipt?.eventSequence).toBe(6);
      expect(eventReceipt?.publisher).toBe('goodvibes-daemon');
      expect(eventReceipt?.summary).toContain('token=<redacted>');
      expect(eventReceipt?.summary).not.toContain('event-stream-secret');
      expect(eventReceipt?.publicationGuarantee).toContain('token=<redacted>');
      expect(eventReceipt?.publicationGuarantee).not.toContain('publication-secret');
      expect(eventReceipt?.provenance?.join('\n')).toContain('method setup.smoke');
      expect(eventReceipt?.provenance?.join('\n')).toContain('repair setup action:"smoke"');
      expect(durableHistory.every((entry: { satisfiesReceipt?: boolean }) => entry.satisfiesReceipt === true)).toBe(true);
      expect(posture.setupWizard._diagnostic.receiptGaps).toEqual([]);
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('setup smoke receipt: ready');
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('certified setup receipts: 1/4');
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('setup receipt event streams: 1');
    } finally {
      fixture.cleanup();
    }
  });


  test('persists setup wizard checkpoints through confirmed harness and workspace routes', async () => {
    const fixture = makeFixture();
    try {
      const initial = await executeHarnessJson<{
        readonly checkpoint: { readonly status: string; readonly path: string | null; readonly resumed: boolean };
        readonly setupWizard: { readonly currentStepId: string | null; readonly currentStepLabel: string | null };
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(initial.checkpoint.status).toBe('none');
      expect(initial.checkpoint.path).toContain('wizard-checkpoint.json');
      expect(initial.setupWizard.currentStepId).toBe('connected-host-auth');

      const unconfirmed = await fixture.tool.execute({
        mode: 'mark_setup_checkpoint',
        explicitUserRequest: 'Save setup resume point.',
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('recorded effect admission');

      const saved = await executeHarnessJson<{
        readonly status: string;
        readonly step: { readonly id: string; readonly label: string; readonly sourceStatus: string };
        readonly checkpoint: { readonly exists: boolean; readonly checkpoint?: { readonly currentStepId: string; readonly currentStepLabel: string; readonly source: string } | null };
        readonly setupWizard: {
          readonly currentStepId: string | null;
          readonly checkpoint: { readonly status: string; readonly resumed: boolean; readonly summary: string };
        };
      }>(fixture, {
        mode: 'mark_setup_checkpoint',
        confirm: true,
        explicitUserRequest: 'Save setup resume point.',
      });
      expect(saved.status).toBe('checkpoint_saved');
      expect(saved.step).toMatchObject({ id: 'connected-host-auth', label: 'Connected-host auth', sourceStatus: 'blocked' });
      expect(saved.checkpoint.exists).toBe(true);
      expect(saved.checkpoint.checkpoint).toMatchObject({
        currentStepId: 'connected-host-auth',
        currentStepLabel: 'Connected-host auth',
        source: 'harness',
      });
      expect(saved.setupWizard.currentStepId).toBe('connected-host-auth');
      expect(saved.setupWizard.checkpoint).toMatchObject({
        status: 'available',
        resumed: true,
      });

      const inspected = await executeHarnessJson<{
        readonly checkpoint: { readonly status: string; readonly currentStepId: string; readonly resumed: boolean; readonly summary: string };
        readonly currentStep: { readonly id: string; readonly status: string } | null;
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(inspected.checkpoint.status).toBe('available');
      expect(inspected.checkpoint.currentStepId).toBe('connected-host-auth');
      expect(inspected.checkpoint.resumed).toBe(true);
      expect(inspected.checkpoint.summary).toContain('Resuming Connected-host auth');
      expect(inspected.currentStep?.id).toBe('connected-host-auth');

      writeConnectedHostOperatorToken(fixture);
      const advanced = await executeHarnessJson<{
        readonly checkpoint: {
          readonly status: string;
          readonly currentStepId: string;
          readonly resumed: boolean;
          readonly summary: string;
          readonly autoAdvance?: {
            readonly status: string;
            readonly fromStepId: string | null;
            readonly fromStepLabel: string | null;
            readonly toStepId: string | null;
            readonly toStepLabel: string | null;
            readonly reason: string;
            readonly evidence: string;
            readonly clearRoute: string;
          };
        };
        readonly currentStep: { readonly id: string; readonly status: string } | null;
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(advanced.checkpoint.status).toBe('available');
      expect(advanced.checkpoint.resumed).toBe(true);
      expect(advanced.checkpoint.summary).toContain('Resuming Connected-host auth');
      expect(advanced.checkpoint.autoAdvance?.status).not.toBe('advanced');
      expect(advanced.currentStep?.id).toBe('connected-host-auth');

      const workspaceSaved = await executeHarnessJson<{
        readonly status: string;
        readonly result: {
          readonly status: string;
          readonly setupWizard: { readonly checkpoint: { readonly status: string; readonly resumed: boolean } };
        };
      }>(fixture, {
        mode: 'run_workspace_action',
        actionId: 'setup-checkpoint-mark-current',
        confirm: true,
        explicitUserRequest: 'Keep my setup wizard place.',
      });
      expect(workspaceSaved.status).toBe('checkpoint_action_completed');
      expect(workspaceSaved.result.status).toBe('checkpoint_saved');
      expect(workspaceSaved.result.setupWizard.checkpoint).toMatchObject({
        status: 'available',
        resumed: true,
      });

      const cleared = await executeHarnessJson<{
        readonly status: string;
        readonly checkpoint: { readonly exists: boolean; readonly checkpoint: null };
      }>(fixture, {
        mode: 'clear_setup_checkpoint',
        confirm: true,
        explicitUserRequest: 'Clear setup resume point.',
      });
      expect(cleared.status).toBe('checkpoint_cleared');
      expect(cleared.checkpoint.exists).toBe(false);
      expect(cleared.checkpoint.checkpoint).toBeNull();

      const afterClear = await executeHarnessJson<{
        readonly checkpoint: { readonly status: string; readonly resumed: boolean };
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(afterClear.checkpoint.status).toBe('none');
      expect(afterClear.checkpoint.resumed).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });


  test('surfaces VIBE.md health while refusing credential-bearing curator sources', async () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.root, 'VIBE.md'), '# Project VIBE\n\napi_key=supersecretvalue\n');
      const globalVibePath = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md');
      mkdirSync(join(fixture.root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT), { recursive: true });
      writeFileSync(globalVibePath, `# Global VIBE\n\n${'Prefer calm direct answers. '.repeat(420)}\n`);

      const posture = await executeHarnessJson<{
        readonly readinessPlan: readonly {
          readonly setupItemId: string;
          readonly status: string;
          readonly priority: number;
          readonly signals?: readonly string[];
          readonly primaryHandoff?: { readonly id: string; readonly modelRoute: string };
          readonly handoffs?: readonly { readonly id: string; readonly requiresConfirmation?: boolean }[];
          readonly vibeHealth?: {
            readonly applied: number;
            readonly blocked: number;
            readonly truncated: number;
            readonly files: readonly { readonly path: string; readonly truncated?: boolean }[];
            readonly blockedFiles: readonly { readonly path: string; readonly reason: string }[];
          };
        }[];
      }>(fixture, { mode: 'setup_posture', includeParameters: true });
      const vibeItem = posture.readinessPlan.find((item) => item.setupItemId === 'vibe-personality');
      expect(vibeItem?.status).toBe('check');
      expect(vibeItem?.priority).toBe(35);
      expect(vibeItem?.signals?.join('\n')).toContain('blocked VIBE.md files: 1');
      expect(vibeItem?.signals?.join('\n')).toContain('truncated VIBE.md files: 0');
      expect(vibeItem?.primaryHandoff?.id).toBe('inspect-vibe-status');
      expect(vibeItem?.primaryHandoff?.modelRoute).toBe('vibe action:"status"');
      expect(vibeItem?.handoffs?.some((handoff) => handoff.id === 'init-project-vibe' && handoff.requiresConfirmation)).toBe(true);
      expect(vibeItem?.handoffs?.some((handoff) => handoff.id === 'import-vibe-persona' && handoff.requiresConfirmation)).toBe(true);
      expect(vibeItem?.vibeHealth?.applied).toBe(1);
      expect(vibeItem?.vibeHealth?.blocked).toBe(1);
      expect(vibeItem?.vibeHealth?.truncated).toBe(0);
      expect(vibeItem?.vibeHealth?.files[0]?.path).toBe(globalVibePath);
      expect(vibeItem?.vibeHealth?.files[0]?.truncated).toBeUndefined();
      expect(vibeItem?.vibeHealth?.blockedFiles[0]?.path).toBe(join(fixture.root, 'VIBE.md'));
      expect(vibeItem?.vibeHealth?.blockedFiles[0]?.reason).toContain('secret-looking');

      const { learningCuratorSummary } = await import('../../tools/agent-harness-learning-curator.ts');
      await expect(learningCuratorSummary(fixture.context, {}, { sourceOwner: ordinaryResearchOwner() }))
        .rejects.toMatchObject({ problem: 'credential-material' });
      for (const mode of ['summary', 'learning_curator']) {
        const held = await fixture.admittedTool.execute({ mode });
        expect(held.success).toBe(false);
        expect(JSON.stringify(held)).not.toContain('supersecretvalue');
      }
      // A later invocation may review the remaining safe, complete source.
      rmSync(join(fixture.root, 'VIBE.md'));

      const summary = await executeHarnessJson<{
        readonly learningCurator?: { readonly personalityIssues: number; readonly needsReview: number; readonly needsSetup: number };
      }>(fixture, { mode: 'summary' });
      expect(summary.learningCurator?.personalityIssues).toBe(0);
      expect(summary.learningCurator?.needsReview).toBe(0);
      expect(summary.learningCurator?.needsSetup).toBe(0);

      const curator = await executeHarnessJson<{
        readonly summary: { readonly personalityIssues: number };
        readonly candidates: readonly { readonly domain: string; readonly proposalFields?: Record<string, string> }[];
        readonly policy: string;
      }>(fixture, { mode: 'learning_curator', query: 'vibe', includeParameters: true });
      expect(curator.summary.personalityIssues).toBe(0);
      expect(curator.policy).toContain('VIBE.md personality health');
      expect(curator.candidates.filter(candidate => candidate.domain === 'vibe')).toEqual([]);

    } finally {
      fixture.cleanup();
    }
  });


  test('exposes project context files to the model without loading blocked content', async () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture.root, 'frontend', 'src'), { recursive: true });
      mkdirSync(join(fixture.root, '.cursor', 'rules'), { recursive: true });
      writeFileSync(join(fixture.root, 'AGENTS.md'), 'Prefer visible project context before hidden assumptions.');
      writeFileSync(join(fixture.root, 'frontend', 'AGENTS.md'), 'Frontend work should use compact controls and visible state.');
      writeFileSync(join(fixture.root, '.cursor', 'rules', 'ui.mdc'), 'Use focused UI rules for dense operator surfaces.');
      writeFileSync(join(fixture.root, 'CLAUDE.md'), 'api_key=supersecretvalue\nDo not load this project secret.');

      const summary = await executeHarnessJson<{
        readonly projectContext?: {
          readonly status: string;
          readonly loaded: number;
          readonly blocked: number;
          readonly targetAware: boolean;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.projectContext?.status).toBe('attention');
      expect(summary.projectContext?.loaded).toBeGreaterThanOrEqual(1);
      expect(summary.projectContext?.blocked).toBe(1);
      expect(summary.projectContext?.targetAware).toBe(true);

      const catalog = await executeHarnessJson<{
        readonly status: string;
        readonly returned: number;
        readonly total: number;
        readonly loaded: number;
        readonly blocked: number;
        readonly files: readonly {
          readonly id: string;
          readonly path: string;
          readonly source: string;
          readonly scope: string;
          readonly status: string;
          readonly body?: string;
          readonly reason?: string;
          readonly modelRoute: string;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'project_context', target: 'frontend/src/App.ts', includeParameters: true });
      expect(catalog.status).toBe('attention');
      expect(catalog.loaded).toBeGreaterThanOrEqual(3);
      expect(catalog.blocked).toBe(1);
      expect(catalog.returned).toBe(catalog.total);
      expect(catalog.policy).toContain('Secret-looking files are blocked');
      expect(JSON.stringify(catalog)).not.toContain('Do not load this project secret');
      expect(catalog.files.map((file) => file.source)).toEqual(expect.arrayContaining(['AGENTS.md', '.cursor/rules/*.mdc', 'CLAUDE.md']));
      expectRowsHaveCompactModelRoutes(catalog.files);

      const frontendContext = catalog.files.find((file) => file.path.endsWith(join('frontend', 'AGENTS.md')));
      expect(frontendContext?.scope).toBe('subdirectory');
      expect(frontendContext?.modelRoute).toContain('context action:"file"');

      const detail = await executeHarnessJson<{
        readonly path: string;
        readonly status: string;
        readonly body: string;
      }>(fixture, { mode: 'project_context_file', contextFileId: frontendContext?.id, target: 'frontend/src/App.ts' });
      expect(detail.path).toBe(frontendContext!.path);
      expect(detail.status).toBe('loaded');
      expect(detail.body).toContain('compact controls');

      const blocked = catalog.files.find((file) => file.status === 'blocked');
      const blockedDetail = await executeHarnessJson<{
        readonly status: string;
        readonly reason: string;
      }>(fixture, { mode: 'project_context_file', contextFileId: blocked?.id });
      expect(blockedDetail.status).toBe('blocked');
      expect(blockedDetail.reason).toContain('secret-looking');
      expect(JSON.stringify(blockedDetail)).not.toContain('Do not load this project secret');

      const cursorOnly = await executeHarnessJson<{
        readonly returned: number;
        readonly total: number;
        readonly files: readonly { readonly source: string }[];
      }>(fixture, { mode: 'project_context', query: 'cursor' });
      expect(cursorOnly.returned).toBe(1);
      expect(cursorOnly.total).toBeGreaterThan(cursorOnly.returned);
      expect(cursorOnly.files[0]?.source).toBe('.cursor/rules/*.mdc');
    } finally {
      fixture.cleanup();
    }
  });


  test('exposes current prompt context composition and budget without mutating records', async () => {
    const fixture = makeFixture();
    try {
      attachMemoryApi(fixture, [
        makeMemoryRecord(),
        makeMemoryRecord({ id: 'mem-low-confidence', confidence: 55, summary: 'Low confidence memory' }),
        makeMemoryRecord({ id: 'mem-unreviewed', reviewState: 'fresh', confidence: 91, summary: 'Unreviewed memory' }),
      ]);
      writeFileSync(join(fixture.root, 'VIBE.md'), 'Keep the assistant concise and user-first.');
      writeFileSync(join(fixture.root, 'AGENTS.md'), 'Prefer visible prompt context inspection before relying on hidden assumptions.');

      const personaRegistry = AgentPersonaRegistry.fromShellPaths(fixture.paths);
      const persona = personaRegistry.create({
        name: 'Reviewed prompt inspector',
        description: 'Reviewed prompt behavior.',
        body: 'Explain applied context before acting when context is ambiguous.',
        source: 'agent',
      });
      personaRegistry.markReviewed(persona.id);
      personaRegistry.setActive(persona.id);

      const skillRegistry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const readySkill = skillRegistry.create({
        name: 'Prompt evidence skill',
        description: 'Summarize active prompt evidence.',
        procedure: 'List selected context records, then ask for confirmation before changes.',
        enabled: true,
        source: 'agent',
      });
      skillRegistry.markReviewed(readySkill.id);
      skillRegistry.create({
        name: 'Blocked prompt skill',
        description: 'Needs unavailable setup.',
        procedure: 'Use an unavailable command.',
        requirements: [{ kind: 'command', name: 'definitely-missing-goodvibes-agent-test-command' }],
        enabled: true,
        source: 'agent',
      });

      const routineRegistry = AgentRoutineRegistry.fromShellPaths(fixture.paths);
      const readyRoutine = routineRegistry.create({
        name: 'Prompt closeout routine',
        description: 'Close out prompt context reviews.',
        steps: 'Summarize applied context, suppressed context, and next review route.',
        enabled: true,
        source: 'agent',
      });
      routineRegistry.markReviewed(readyRoutine.id);
      routineRegistry.create({
        name: 'Blocked prompt routine',
        description: 'Needs unavailable setup.',
        steps: 'Run unavailable setup before use.',
        requirements: [{ kind: 'command', name: 'definitely-missing-goodvibes-agent-test-command' }],
        enabled: true,
        source: 'agent',
      });

      const promptContextReceipts = new AgentPromptContextReceiptStore();
      const completedReceipt = promptContextReceipts.record({
        sessionId: 'session-alpha',
        turnId: 'turn-prompt-context-ok',
        source: 'turn',
        provider: 'openai',
        model: 'gpt-4.1',
        contextWindow: 128_000,
        promptHash: 'a'.repeat(64),
        promptChars: 1024,
        approxPromptTokens: 256,
        activeRecords: 3,
        suppressedRecords: 0,
        segments: [{
          id: 'vibe',
          label: 'VIBE.md personality',
          order: 2,
          status: 'active',
          activeCount: 1,
          suppressedCount: 0,
          promptChars: 256,
          approxTokens: 64,
        }],
      });
      promptContextReceipts.recordTurnOutcome({
        turnId: 'turn-prompt-context-ok',
        status: 'completed',
        terminalEvent: 'TURN_COMPLETED',
        stopReason: 'stop',
        completedAt: 1_699_999_999_000,
      });
      const storedReceipt = promptContextReceipts.record({
        sessionId: 'session-alpha',
        turnId: 'turn-prompt-context',
        source: 'turn',
        provider: 'openai',
        model: 'gpt-4.1',
        contextWindow: 128_000,
        promptHash: 'b'.repeat(64),
        promptChars: 2048,
        approxPromptTokens: 512,
        activeRecords: 7,
        suppressedRecords: 2,
        segments: [{
          id: 'memory',
          label: 'Reviewed memory',
          order: 5,
          status: 'attention',
          activeCount: 1,
          suppressedCount: 2,
          promptChars: 512,
          approxTokens: 128,
        }],
      });
      promptContextReceipts.recordTurnOutcome({
        turnId: 'turn-prompt-context',
        status: 'error',
        terminalEvent: 'TURN_ERROR',
        stopReason: 'provider_error',
        detail: 'Provider rejected a test request.',
        completedAt: 1_700_000_000_000,
      });
      (fixture.context.clients as Record<string, unknown>).promptContextReceipts = promptContextReceipts;

      const summary = await executeHarnessJson<{
        readonly promptContext?: {
          readonly status: string;
          readonly activeRecords: number;
          readonly suppressedRecords: number;
          readonly approxPromptTokens: number;
          readonly latestReceiptId?: string | null;
          readonly receiptCount?: number;
          readonly modelRoute: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.promptContext?.status).toBe('attention');
      expect(summary.promptContext?.activeRecords).toBeGreaterThan(4);
      expect(summary.promptContext?.suppressedRecords).toBeGreaterThan(1);
      expect(summary.promptContext?.approxPromptTokens).toBeGreaterThan(0);
      expect(summary.promptContext?.receiptCount).toBe(2);
      expect(summary.promptContext?.latestReceiptId).toBe(storedReceipt.receiptId);
      expect(summary.promptContext?.modelRoute).toContain('context action:"prompt"');

      const promptContext = await executeHarnessJson<{
        readonly status: string;
        readonly order: readonly string[];
        readonly activeRecords: number;
        readonly suppressedRecords: number;
        readonly approxPromptTokens: number;
        readonly budget: { readonly approxPromptTokens: number; readonly percentOfWindow: number | null };
        readonly receipts: {
          readonly status: string;
          readonly count: number;
          readonly latestReceiptId: string | null;
          readonly latestTurnId: string | null;
          readonly matchingCount?: number;
          readonly selected?: { readonly receiptId: string; readonly turnOutcome?: { readonly status: string } } | null;
          readonly routes?: {
            readonly latestReceipt?: string | null;
            readonly filterCompleted?: string;
            readonly filterErrors?: string;
          };
          readonly latest?: {
            readonly receiptId: string;
            readonly turnOutcome?: {
              readonly status: string;
              readonly terminalEvent: string;
              readonly stopReason: string;
              readonly detail?: string;
            };
            readonly promptHash?: string;
            readonly segments?: readonly { readonly id: string; readonly status: string }[];
          } | null;
        };
        readonly segments: readonly {
          readonly id: string;
          readonly status: string;
          readonly activeCount: number;
          readonly suppressedCount: number;
          readonly approxTokens: number;
          readonly selected?: readonly { readonly id?: string; readonly path?: string; readonly name?: string; readonly source?: string; readonly inspectRoute?: string }[];
          readonly suppressed?: readonly { readonly id?: string; readonly reason?: string; readonly reviewState?: string; readonly missingRequirements?: number }[];
          readonly preview?: string;
        }[];
        readonly routes: { readonly promptPlan: string; readonly memoryPosture: string; readonly learningCurator: string };
        readonly policy: string;
      }>(fixture, { mode: 'prompt_context', includeParameters: true });

      expect(promptContext.status).toBe('attention');
      expect(promptContext.order).toEqual(expect.arrayContaining(['vibe', 'project_context', 'memory', 'routines', 'skills', 'persona']));
      expect(promptContext.activeRecords).toBe(summary.promptContext!.activeRecords);
      expect(promptContext.suppressedRecords).toBe(summary.promptContext!.suppressedRecords);
      expect(promptContext.approxPromptTokens).toBe(promptContext.budget.approxPromptTokens);
      expect(promptContext.budget.percentOfWindow).not.toBeNull();
      expect(promptContext.receipts.status).toBe('ready');
      expect(promptContext.receipts.count).toBe(2);
      expect(promptContext.receipts.matchingCount).toBe(2);
      expect(promptContext.receipts.latestReceiptId).toBe(storedReceipt.receiptId);
      expect(promptContext.receipts.latestTurnId).toBe('turn-prompt-context');
      expect(promptContext.receipts.selected).toBeNull();
      expect(promptContext.receipts.routes?.latestReceipt).toContain(`receiptId:"${storedReceipt.receiptId}"`);
      expect(promptContext.receipts.routes?.filterErrors).toContain('outcomeStatus:"error"');
      expect(promptContext.receipts.latest?.turnOutcome?.status).toBe('error');
      expect(promptContext.receipts.latest?.turnOutcome?.terminalEvent).toBe('TURN_ERROR');
      expect(promptContext.receipts.latest?.turnOutcome?.detail).toContain('Provider rejected');
      expect(promptContext.receipts.latest?.promptHash).toBe('b'.repeat(64));
      expect(promptContext.receipts.latest?.segments?.some((segment) => segment.id === 'memory' && segment.status === 'attention')).toBe(true);

      const memory = promptContext.segments.find((segment) => segment.id === 'memory');
      expect(memory?.selected?.some((record) => record.id === 'mem-briefing')).toBe(true);
      expect(memory?.suppressed?.some((record) => record.id === 'mem-low-confidence' && record.reason?.includes('confidence'))).toBe(true);
      // mem-unreviewed (confidence 91) is now ACTIVE: autonomous-learning change dropped the reviewState gate.
      expect(memory?.selected?.some((record) => record.id === 'mem-unreviewed')).toBe(true);
      expect(memory?.preview).toContain('Reviewed GoodVibes Agent Memory');
      // F7c: the memory segment states its own ordering basis so it never reads
      // as contradicting the separately-ranked context action:"receipt" surface.
      expect((memory as unknown as { readonly note?: string })?.note).toContain('confidence/recency');
      expect((memory as unknown as { readonly note?: string })?.note).toContain('not by relevance to the current turn');

      const vibe = promptContext.segments.find((segment) => segment.id === 'vibe');
      expect(vibe?.selected?.[0]?.path).toBe(join(fixture.root, 'VIBE.md'));
      const project = promptContext.segments.find((segment) => segment.id === 'project_context');
      expect(project?.selected?.some((record) => record.source === 'AGENTS.md')).toBe(true);
      const skills = promptContext.segments.find((segment) => segment.id === 'skills');
      expect(skills?.selected?.some((record) => record.id === readySkill.id)).toBe(true);
      expect(skills?.suppressedCount).toBeGreaterThan(0);
      const routines = promptContext.segments.find((segment) => segment.id === 'routines');
      expect(routines?.selected?.some((record) => record.id === readyRoutine.id)).toBe(true);
      expect(routines?.suppressed?.some((record) => record.missingRequirements !== undefined || record.reviewState === 'fresh')).toBe(true);
      const personaSegment = promptContext.segments.find((segment) => segment.id === 'persona');
      expect(personaSegment?.selected?.[0]?.name).toBe('Reviewed prompt inspector');

      expect(promptContext.routes.promptPlan).toContain('memory action:"curator"');
      expect(promptContext.routes.memoryPosture).toContain('memory action:"status"');
      expect(promptContext.routes.learningCurator).toContain('memory action:"curator"');
      expect(promptContext.policy).toContain('Read-only');

      const completedFilter = await executeHarnessJson<{
        readonly receipts: {
          readonly status: string;
          readonly matchingCount: number;
          readonly selected: {
            readonly receiptId: string;
            readonly turnId: string | null;
            readonly turnOutcome?: { readonly status: string; readonly terminalEvent: string };
            readonly promptHash?: string;
          } | null;
          readonly recent: readonly { readonly receiptId: string; readonly turnOutcome?: { readonly status: string } }[];
        };
      }>(fixture, { mode: 'prompt_context', outcomeStatus: 'completed', includeParameters: true });
      expect(completedFilter.receipts.status).toBe('ready');
      expect(completedFilter.receipts.matchingCount).toBe(1);
      expect(completedFilter.receipts.selected?.receiptId).toBe(completedReceipt.receiptId);
      expect(completedFilter.receipts.selected?.turnId).toBe('turn-prompt-context-ok');
      expect(completedFilter.receipts.selected?.turnOutcome?.terminalEvent).toBe('TURN_COMPLETED');
      expect(completedFilter.receipts.selected?.promptHash).toBe('a'.repeat(64));
      expect(completedFilter.receipts.recent.map((receipt) => receipt.receiptId)).toEqual([completedReceipt.receiptId]);

      const exactReceipt = await executeHarnessJson<{
        readonly receipts: {
          readonly status: string;
          readonly matchingCount: number;
          readonly selected: { readonly receiptId: string; readonly turnOutcome?: { readonly status: string } } | null;
          readonly filters?: { readonly receiptId?: string; readonly limit: number };
        };
      }>(fixture, { mode: 'prompt_context', receiptId: storedReceipt.receiptId, limit: 1 });
      expect(exactReceipt.receipts.status).toBe('ready');
      expect(exactReceipt.receipts.matchingCount).toBe(1);
      expect(exactReceipt.receipts.selected?.receiptId).toBe(storedReceipt.receiptId);
      expect(exactReceipt.receipts.selected?.turnOutcome?.status).toBe('error');
      expect(exactReceipt.receipts.filters?.receiptId).toBe(storedReceipt.receiptId);

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'context-prompt-context' });
      expect(action.id).toBe('context-prompt-context');
      expect(action.modelRoute).toBe('context action:"prompt" includeParameters:true');
    } finally {
      fixture.cleanup();
    }
  });


  test('prompt context memory suppressed reasons come straight from describeMemoryPromptEligibility: no "not reviewed"/"outside prompt limit" paraphrase', async () => {
    const fixture = makeFixture();
    try {
      // 11 eligible records (confidence 100 down to 90, all reviewed) so the top-10
      // prompt slice cuts exactly one, that one must read as "eligible ... but outside
      // the top-10 prompt slice ... budget-limited, not a trust problem", never the old
      // coarse "outside prompt limit". A genuinely low-confidence record must still read
      // as ineligible via describeMemoryPromptEligibility's own reason, never "not
      // reviewed" (its reviewState here IS reviewed, confidence is why it fails).
      const eligibleRecords = Array.from({ length: 11 }, (_, index) => makeMemoryRecord({
        id: `mem-eligible-${index}`,
        confidence: 100 - index,
        reviewState: 'reviewed',
        summary: `Eligible memory record ${index}`,
      }));
      const ineligibleRecord = makeMemoryRecord({
        id: 'mem-below-floor',
        confidence: 40,
        reviewState: 'reviewed',
        summary: 'Explicitly below the recall floor',
      });
      attachMemoryApi(fixture, [...eligibleRecords, ineligibleRecord]);

      const promptContext = await executeHarnessJson<{
        readonly segments: readonly {
          readonly id: string;
          readonly selected?: readonly { readonly id?: string }[];
          readonly suppressed?: readonly { readonly id?: string; readonly reason?: string }[];
        }[];
      }>(fixture, { mode: 'prompt_context', includeParameters: true });

      const memory = promptContext.segments.find((segment) => segment.id === 'memory');
      expect(memory?.selected?.length).toBe(10);
      // The 11th-ranked eligible record (lowest confidence, mem-eligible-10) is the one
      // the top-10 slice cuts.
      const sliceCut = memory?.suppressed?.find((record) => record.id === 'mem-eligible-10');
      expect(sliceCut?.reason).toContain('eligible (');
      expect(sliceCut?.reason).toContain('outside the top-10 prompt slice');
      expect(sliceCut?.reason).toContain('budget-limited, not a trust problem');
      expect(sliceCut?.reason).not.toBe('outside prompt limit');

      const belowFloor = memory?.suppressed?.find((record) => record.id === 'mem-below-floor');
      expect(belowFloor?.reason).toContain('confidence');
      expect(belowFloor?.reason).not.toBe('not reviewed');
      expect(belowFloor?.reason).not.toBe(`confidence below ${60}`);
    } finally {
      fixture.cleanup();
    }
  });
});
