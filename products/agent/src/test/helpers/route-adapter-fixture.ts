import { afterAll, expect } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ProviderListing } from '@goodvibes-jev/engine/sdk/platform/routing';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentRouteTool } from '../../tools/agent-route-tool.ts';
import type { AgentTaskRouteSources } from '../../tools/agent-route-planner.ts';
import { useTaskRouteReadings, type TaskRouteReadings } from './task-route-readings.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from './research-screening.ts';

// The adapter composes these readings into the existing route contract. Request
// strings are exact fixture keys; no test-side keyword classifier replaces Jev.
const ROUTE_READINGS = {
  'triage my inbox and draft replies': {
    pick: 'personal-ops-intake-route',
    choices: { lane: 'inbox' },
    fits: { 'personal-ops-daily-briefing': 0.8, 'personal-ops-review-queue': 0.7 },
  },
  'brief my calendar for today': { pick: 'personal-ops-daily-briefing', choices: { lane: 'calendar' } },
  'show my saved inbox review queue': { pick: 'personal-ops-review-queue', choices: { lane: 'inbox' } },
  'refresh my Gmail inbox': { pick: 'personal-ops-fresh-read-plan', slots: { freshRead: 0.95 }, choices: { lane: 'inbox' } },
  'do deep research on the market map and cite sources': { pick: 'deep-research-workflow', slots: { starts: 0.95 } },
  'run a weekly source-backed research report': { pick: 'autonomy-intake', slots: { starts: 0.95 } },
  'log in to my account on example.com and download the invoice': { pick: 'drive-a-browser' },
  'fill out the contact form on the website and submit it': { pick: 'drive-a-browser', slots: { changes: 0.95 } },
  'take a screenshot of the screen': { pick: 'browser-control-workflow-plan', slots: { starts: 0.95 } },
  'check browser-backed research runner readiness': { pick: 'research-browser-runner-readiness' },
  'render the visual research report in the browser': { pick: 'research-visual-report-workflow', slots: { opensUi: 0.95 } },
  'fix the failing tests in parallel': { pick: 'build-work', slots: { delegated: 0.95 } },
  'check daemon health': { pick: 'host-runtime-diagnostics' },
  'remind me tomorrow to stretch': { pick: 'direct-schedule-route', slots: { reminder: 0.95 } },
  'set up Slack notifications': { pick: 'channels', choices: { channelTask: 'setup' }, named: { channelTarget: 'slack' }, slots: { changes: 0.95 } },
  'triage failed Discord delivery retries': { pick: 'channels', choices: { channelTask: 'triage' }, named: { channelTarget: 'discord' } },
  'show recent delivery receipts': { pick: 'channels', choices: { channelTask: 'receipts' } },
  'send message to Telegram': { pick: 'channels', choices: { channelTask: 'send' }, named: { channelTarget: 'telegram' }, slots: { changes: 0.95 } },
  'change the theme setting': { pick: 'agent-settings-configuration', slots: { changes: 0.95 } },
  'recommend an Ollama model for this laptop': { pick: 'local-model-cookbook-route', named: { modelProvider: 'ollama' } },
  'check local model servers': { pick: 'local-model-smoke-check' },
  'connect OpenRouter subscription': { pick: 'model-provider-account-posture', slots: { changes: 0.95 }, named: { modelProvider: 'openrouter' } },
  'choose the best model route for long context coding': { pick: 'model-route-readiness' },
  'show current permissions and approval mode': { pick: 'security-permission-status' },
  'why was that terminal command blocked': { pick: 'security-policy-explanation', choices: { policyTarget: 'terminal' } },
  'inspect the leaked secret security finding': { pick: 'security-finding-inspection' },
  'research market risk with citations': { pick: 'deep-research-workflow' },
  'export a support bundle for diagnostics': { pick: 'support-bundle-route', slots: { changes: 0.95 } },
  'search saved sessions for the onboarding thread': { pick: 'saved-session-route' },
  'show release readiness inventory': { pick: 'release-audit' },
  'inspect release evidence artifact live verification': { pick: 'release-audit', slots: { evidence: 0.95 } },
  'connect Supermemory as an external memory provider': { pick: 'external-memory-provider-posture', slots: { changes: 0.95 }, named: { memoryProvider: 'supermemory' } },
  'set up cross-session memory sync': { pick: 'external-memory-provider-posture', slots: { changes: 0.95 } },
  'run pytest -v tests/ in background': { pick: 'local-background-process', slots: { starts: 0.95, delegated: 0.95 } },
  'run claude code with pty=true and handle sudo prompts': { pick: 'interactive-process-capability', slots: { starts: 0.95 } },
  'write process documentation': { pick: 'documents-artifacts-compare', slots: { changes: 0.95 } },
  'run a weekly source-backed research report in background': { pick: 'autonomy-intake', slots: { starts: 0.95, delegated: 0.95 } },
  'undo the last file edit': { pick: 'local-file-recovery', slots: { changes: 0.95 } },
  'take a screenshot of the logged-in browser dashboard': { pick: 'browser-control-workflow-plan', slots: { starts: 0.95 } },
  'generate an image of a clean product dashboard': { pick: 'media-generation-artifact', slots: { changes: 0.95, starts: 0.95 } },
  'set up push-to-talk and voice memo transcription': { pick: 'voice-workflow-posture', slots: { changes: 0.95, device: 0.95 } },
  'choose a TTS provider for spoken responses': { pick: 'tts-provider-posture', slots: { changes: 0.95, device: 0.95 } },
  'open the browser dashboard': { pick: 'browser-cockpit-readiness', slots: { opensUi: 0.95 } },
  'compare models for this document': {
    pick: 'documents-artifacts-compare',
    slots: { starts: 0.95 },
    catalogFits: { 'document-run-compare': 0.95, document_ops: 0.95 },
  },
  'set up ollama local model': { pick: 'local-model-cookbook-route', slots: { changes: 0.95 }, named: { modelProvider: 'ollama' } },
} satisfies Readonly<Record<string, TaskRouteReadings>>;

export function useRouteAdapterFixture(): void {
  useTaskRouteReadings(ROUTE_READINGS);
  afterAll(cleanupResearchScreeningFixtures);
}

const providerRegistry: ProviderListing = {
  listProviders: () => [{ name: 'openrouter' }, { name: 'ollama' }],
  getConfiguredProviderIds: () => ['openrouter', 'ollama'],
  getRawCatalogModels: () => [
    { providerId: 'openrouter', provider: 'OpenRouter' },
    { providerId: 'ollama', provider: 'Ollama' },
  ],
};
export const taskRouteSources: AgentTaskRouteSources = {
  channelRegistry: {
    listDescriptors: () => [
      { surface: 'slack', displayName: 'Slack' },
      { surface: 'discord', displayName: 'Discord' },
      { surface: 'telegram', displayName: 'Telegram' },
    ],
  },
};

export function fakeContext(): CommandContext {
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  return {
    workspace: {},
    extensions: { toolRegistry: registry },
    platform: {
      config: {
        behavior: { autoApprove: false },
        permissions: { mode: 'prompt', tools: {} },
      },
    },
    session: { runtime: {} },
    provider: { providerRegistry },
  } as CommandContext;
}

export async function route(query: keyof typeof ROUTE_READINGS, includeParameters = false): Promise<Record<string, unknown>> {
  const tool = createAgentRouteTool(fakeContext(), taskRouteSources);
  const result = await tool.execute({ action: 'plan', query, includeParameters });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  return JSON.parse(result.output!) as Record<string, unknown>;
}

export function preferredId(body: Record<string, unknown>): string {
  const preferred = body.preferred as { readonly id?: unknown };
  return typeof preferred?.id === 'string' ? preferred.id : '';
}