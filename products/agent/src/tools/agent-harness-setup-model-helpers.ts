import type { BrowserControlPosture } from './agent-harness-browser-control.ts';
import { previewAgentWorkspaceTuiSettingsImport } from '../input/agent-workspace-settings.ts';
import { readRecord, readString, readStringArray } from './agent-harness-setup-posture-utils.ts';
import type { SetupPlanStatus } from './agent-harness-setup-posture-types.ts';

export function browserControlSignals(posture: BrowserControlPosture): readonly string[] {
  const signals: string[] = [];
  if (posture.toolMatches.length > 0) signals.push(`tools: ${posture.toolMatches.join(', ')}`);
  if (posture.mcpServers.length > 0) {
    signals.push(...posture.mcpServers.slice(0, 5).map((server) => (
      `mcp:${server.name} ${server.connected ? 'connected' : 'disconnected'} ${server.readiness} role=${server.role} trust=${server.trustMode} schema=${server.schemaFreshness}`
    )));
  }
  if (posture.certifiedRuntimeRecords.length > 0) signals.push(`certified runtime receipts: ${posture.certifiedRuntimeRecords.length}`);
  if (signals.length === 0) signals.push('No browser, desktop, computer-use, screenshot, or screen-recording tool is configured.');
  return signals;
}

export function settingsImportChangeCount(preview: ReturnType<typeof previewAgentWorkspaceTuiSettingsImport>): number {
  if (!preview) return 0;
  return preview.summary.settingsToImport
    + preview.summary.activeSubscriptionsToImport
    + preview.summary.pendingSubscriptionsToImport;
}

export function settingsImportSignals(preview: ReturnType<typeof previewAgentWorkspaceTuiSettingsImport>): readonly string[] {
  if (!preview) return ['Import preview unavailable in this runtime.'];
  return [
    `settings to import: ${preview.summary.settingsToImport}`,
    `active subscriptions to import: ${preview.summary.activeSubscriptionsToImport}`,
    `pending subscriptions to import: ${preview.summary.pendingSubscriptionsToImport}`,
    `unchanged items: ${preview.summary.settingsUnchanged + preview.summary.subscriptionsUnchanged}`,
    `parse issues: ${preview.summary.parseErrors}`,
  ];
}

export function topLocalModelRecipe(cookbook: Record<string, unknown>): Record<string, unknown> {
  const recipes = Array.isArray(cookbook.recipes) ? cookbook.recipes.map(readRecord) : [];
  return recipes[0] ?? {};
}

export function localModelSetupReadiness(cookbook: Record<string, unknown>): Record<string, unknown> {
  const detected = readRecord(cookbook.detected);
  const topRecipe = topLocalModelRecipe(cookbook);
  const setupPlan = readRecord(topRecipe.setupPlan);
  const readiness = readRecord(topRecipe.readiness);
  return {
    cookbookStatus: readString(cookbook.status),
    recommendation: readString(cookbook.recommendation),
    detected: {
      stacks: readStringArray(detected.stacks),
      providerIds: readStringArray(detected.providerIds),
      modelRoutes: readStringArray(detected.modelRoutes),
    },
    topRecipe: {
      id: readString(topRecipe.id),
      label: readString(topRecipe.label),
      fitScore: topRecipe.fitScore ?? null,
      fitLevel: topRecipe.fitLevel ?? null,
      readinessScore: topRecipe.readinessScore ?? null,
      readinessLevel: topRecipe.readinessLevel ?? null,
      detected: topRecipe.detected === true,
      setupStatus: readString(setupPlan.status),
      missingSignals: Array.isArray(readiness.missingSignals) ? readiness.missingSignals.slice(0, 3) : [],
    },
    readinessRubric: cookbook.readinessRubric ?? null,
    benchmarkHistory: cookbook.benchmarkHistory ?? null,
    nextActions: readStringArray(cookbook.nextActions).slice(0, 4),
    inspectRoute: 'models action:"local" includeParameters:true',
    inspectRecipeRoute: 'models action:"route" modelRouteId:"local-model-cookbook"',
  };
}

export function localModelSetupSignals(cookbook: Record<string, unknown>): readonly string[] {
  const readiness = localModelSetupReadiness(cookbook);
  const detected = readRecord(readiness.detected);
  const topRecipe = readRecord(readiness.topRecipe);
  const stacks = readStringArray(detected.stacks);
  const routes = readStringArray(detected.modelRoutes);
  const providerIds = readStringArray(detected.providerIds);
  const signals = [
    `cookbook status: ${readString(readiness.cookbookStatus) || 'unknown'}`,
    stacks.length > 0 ? `detected stacks: ${stacks.join(', ')}` : 'detected stacks: none',
    routes.length > 0 ? `detected model routes: ${routes.join(', ')}` : providerIds.length > 0 ? `detected providers: ${providerIds.join(', ')}` : 'detected local routes: none',
    `top recipe: ${readString(topRecipe.label) || 'unknown'} readiness=${topRecipe.readinessScore ?? 'unknown'} fit=${topRecipe.fitScore ?? 'unknown'}`,
  ];
  return signals;
}

export function localModelSetupStatus(cookbook: Record<string, unknown>): SetupPlanStatus {
  return readString(cookbook.status) === 'detected-local-route' ? 'ready' : 'recommended';
}

export function localModelSetupNextAction(cookbook: Record<string, unknown>): string {
  const readiness = localModelSetupReadiness(cookbook);
  const topRecipe = readRecord(readiness.topRecipe);
  if (readString(cookbook.status) === 'detected-local-route') {
    return 'Inspect detected local model readiness, then run the benchmark prompt before making a local route the default.';
  }
  const topLabel = readString(topRecipe.label) || 'the top local recipe';
  return `Review ${topLabel} setupPlan, start the local server outside Agent, refresh models, then run the benchmark prompt before changing the default route.`;
}
