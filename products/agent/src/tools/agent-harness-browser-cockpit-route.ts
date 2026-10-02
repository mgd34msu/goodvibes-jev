import type { CommandContext } from '../input/command-registry.ts';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../input/agent-workspace-categories.ts';
import type { AgentSetupWizardDurableReceipt } from '../agent/setup-wizard.ts';
import { buildSetupWizardDurableReceipts } from '../agent/setup-wizard-artifact-receipts.ts';
import { mergeSetupWizardDurableReceipts, setupWizardLiveDurableReceipts } from '../input/setup-wizard-live-receipts.ts';
import { readOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { urlHostForConfiguredHost } from '../config/connected-host-dial.ts';
import {
  browserPwaReadModelSnapshot,
  certifiedBrowserPwaCategoryRouteForCategory,
  certifiedBrowserPwaFirstRunReceipts,
  isCertifiedBrowserPwaCategoryRoute,
  type BrowserPwaCategoryRouteRecord,
  type BrowserPwaReadModelSnapshot,
} from './agent-harness-browser-pwa-read-models.ts';

/** This browser opens on THIS host, so a wildcard bind resolves to loopback. */
const browserConnectHost = urlHostForConfiguredHost;

const BROWSER_COCKPIT_EXPECTED_LANES = [
  {
    id: 'chat-and-sessions',
    label: 'Chat and sessions',
    categoryIds: ['home', 'conversation'],
    userOutcome: 'Continue normal assistant chat, session review, prompt history, bookmarks, and current work from the browser.',
  },
  {
    id: 'setup-and-settings',
    label: 'Setup and settings',
    categoryIds: ['setup', 'account-model', 'assistant-behavior', 'tools-permissions', 'onboarding-display', 'finish'],
    userOutcome: 'Finish first-run setup, choose models, adjust behavior, review permissions, and close onboarding without returning to terminal-only controls.',
  },
  {
    id: 'mobile-and-channels',
    label: 'Mobile and channels',
    categoryIds: ['onboarding-channels', 'onboarding-voice-media', 'personal-ops'],
    userOutcome: 'Configure mobile-friendly messaging, notification, voice, phone, and daily personal-operation routes from one cockpit.',
  },
  {
    id: 'knowledge-and-memory',
    label: 'Knowledge and memory',
    categoryIds: ['onboarding-context', 'knowledge', 'profiles', 'memory', 'notes', 'personas', 'skills', 'routines'],
    userOutcome: 'Review and curate user context, project knowledge, memories, notes, personas, skills, and routines with browser-native forms.',
  },
  {
    id: 'work-and-automation',
    label: 'Work and automation',
    categoryIds: ['work', 'automation'],
    userOutcome: 'Approve, supervise, recover, schedule, and delegate autonomous work with touch-friendly controls and receipts.',
  },
  {
    id: 'research-and-artifacts',
    label: 'Research and artifacts',
    categoryIds: ['research', 'documents'],
    userOutcome: 'Run research, draft documents, review packets, browse artifacts, and export/share deliverables from the browser.',
  },
  {
    id: 'host-and-safety',
    label: 'Host and safety',
    categoryIds: ['tools', 'host'],
    userOutcome: 'Inspect tool trust, MCP posture, connected-host repair, service health, support bundles, and recovery routes.',
  },
] as const;

function confirmedCategoryRoute(categoryId: string, label: string): string {
  return `agent_harness mode:"open_ui_surface" surfaceId:"agent-workspace" categoryId:"${categoryId}" confirm:true explicitUserRequest:"Open the ${label} workspace."`;
}

function browserPwaSetupReceipts(context: CommandContext): readonly AgentSetupWizardDurableReceipt[] {
  const artifactReceipts = (() => {
    try {
      const artifacts = context.platform?.artifactStore?.list?.(100) ?? [];
      return buildSetupWizardDurableReceipts(artifacts);
    } catch {
      return [];
    }
  })();
  return mergeSetupWizardDurableReceipts(artifactReceipts, setupWizardLiveDurableReceipts(context))
    .filter((receipt) => receipt.stepId === 'browser-pwa');
}

function readyBrowserPwaSetupReceipt(receipts: readonly AgentSetupWizardDurableReceipt[]): AgentSetupWizardDurableReceipt | null {
  return receipts.find((receipt) => receipt.status === 'ready') ?? null;
}

function routeCertificationSummary(route: BrowserPwaCategoryRouteRecord): Record<string, unknown> {
  return {
    id: route.id,
    categoryIds: route.categoryIds,
    route: route.route,
    mobileReady: route.mobileReady,
    pwaReady: route.pwaReady,
    modelRoute: route.modelRoute,
    sourcePath: route.sourcePath,
    certification: route.certification,
  };
}

function browserCockpitWorkspaceCoverage(
  enabled: boolean,
  includeDetails: boolean,
  browserPwa: BrowserPwaReadModelSnapshot,
): Record<string, unknown> {
  const categories = AGENT_WORKSPACE_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    group: category.group,
    actions: category.actions.length,
    certifiedRoute: enabled ? certifiedBrowserPwaCategoryRouteForCategory(browserPwa, category.id) : null,
    agentRoute: confirmedCategoryRoute(category.id, category.label),
  }));
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const coveredCategoryCount = categories.filter((category) => category.certifiedRoute).length;
  const nativeCategoryRoutesPublished = enabled && coveredCategoryCount === categories.length;
  const status = !enabled
    ? 'web-setup-needed'
    : nativeCategoryRoutesPublished
      ? 'browser-native-ready'
      : coveredCategoryCount > 0
        ? 'partial-browser-native-category-contracts'
        : 'needs-browser-native-category-contracts';
  const certifiedRoutes = browserPwa.categoryRoutes.filter(isCertifiedBrowserPwaCategoryRoute);
  const categoryRows = categories.map((category) => {
    const route = category.certifiedRoute;
    return {
      id: category.id,
      label: category.label,
      group: category.group,
      actions: category.actions,
      browserStatus: !enabled ? 'blocked-by-web-setup' : route ? 'browser-native-ready' : 'terminal-first',
      browserRoute: route?.route ?? null,
      ...(route ? {
        browserRouteId: route.id,
        browserRouteSource: route.sourcePath,
        browserRouteReceiptId: route.certification.receiptId ?? null,
        mobileReady: route.mobileReady,
        pwaReady: route.pwaReady,
      } : {
        neededContract: 'connected-host browser-native Agent workspace category route',
      }),
      agentRoute: category.agentRoute,
    };
  });
  return {
    status,
    summary: !enabled
      ? 'The connected-host web endpoint is disabled, so browser-native workspace categories cannot be reached yet.'
      : nativeCategoryRoutesPublished
        ? 'The connected host has published certified browser-native routes for every Agent workspace category.'
        : coveredCategoryCount > 0
          ? `${coveredCategoryCount}/${categories.length} Agent workspace categories have certified browser-native routes; terminal workspace fallback remains available for the rest.`
          : 'The connected-host web URL is openable, but Agent has not received a published browser-native route contract for workspace categories yet.',
    categoryCount: categories.length,
    coveredCategoryCount,
    certifiedCategoryRouteCount: certifiedRoutes.length,
    nativeCategoryRoutesPublished,
    terminalFallback: nativeCategoryRoutesPublished
      ? 'The TUI Agent Workspace remains available as an equivalent local fallback.'
      : 'Every Agent workspace category remains reachable through the TUI Agent Workspace while browser-native category routes are being published.',
    laneCount: BROWSER_COCKPIT_EXPECTED_LANES.length,
    ...(includeDetails ? {
      lanes: BROWSER_COCKPIT_EXPECTED_LANES.map((lane) => ({
        id: lane.id,
        label: lane.label,
        categoryIds: lane.categoryIds,
        userOutcome: lane.userOutcome,
        coveredCategoryCount: lane.categoryIds.filter((categoryId) => categoryById.get(categoryId)?.certifiedRoute).length,
        browserStatus: !enabled
          ? 'blocked-by-web-setup'
          : lane.categoryIds.every((categoryId) => categoryById.get(categoryId)?.certifiedRoute)
            ? 'browser-native-ready'
            : lane.categoryIds.some((categoryId) => categoryById.get(categoryId)?.certifiedRoute)
              ? 'partial-browser-native-contract'
              : 'needs-browser-native-contract',
        browserRoutes: lane.categoryIds
          .map((categoryId) => categoryById.get(categoryId)?.certifiedRoute)
          .filter((route): route is BrowserPwaCategoryRouteRecord => Boolean(route))
          .map(routeCertificationSummary),
        agentRoutes: lane.categoryIds
          .map((categoryId) => categoryById.get(categoryId))
          .filter((category): category is NonNullable<typeof category> => Boolean(category))
          .map((category) => category.agentRoute),
      })),
      categories: categoryRows,
      publishedCategoryRoutes: certifiedRoutes.slice(0, 20).map(routeCertificationSummary),
      sourceCounts: browserPwa.sourceCounts,
    } : {}),
    policy: nativeCategoryRoutesPublished
      ? 'Workspace coverage is counted ready only from certified SDK/daemon browser-native category route records with exact routes, mobile/touch evidence, publication, provenance, and freshness cursor metadata.'
      : 'Workspace coverage is a route contract map, not a claim that the connected-host browser already renders these Agent category controls.',
  };
}

function browserCockpitMobileAffordances(
  enabled: boolean,
  includeDetails: boolean,
  browserPwa: BrowserPwaReadModelSnapshot,
  nativeCategoryRoutesPublished: boolean,
): Record<string, unknown> {
  const certifiedFirstRun = certifiedBrowserPwaFirstRunReceipts(browserPwa);
  const controls = [
    {
      id: 'open-browser-cockpit',
      label: 'Open browser cockpit',
      status: enabled ? 'ready' : 'blocked-by-web-setup',
      modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"connected-browser-cockpit" confirm:true explicitUserRequest:"..."',
    },
    {
      id: 'inspect-web-endpoint',
      label: 'Inspect web endpoint',
      status: 'ready',
      modelRoute: 'host action:"service" endpointId:"web" includeParameters:true',
    },
    {
      id: 'inspect-device-map',
      label: 'Inspect device capability map',
      status: 'ready',
      modelRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"browser-cockpit-pwa"',
    },
    {
      id: 'review-web-settings',
      label: 'Review web settings',
      status: 'ready',
      modelRoute: 'settings action:"list" query:"web" includeHidden:true',
    },
  ];
  const laneControls = BROWSER_COCKPIT_EXPECTED_LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    status: nativeCategoryRoutesPublished ? 'ready' : enabled ? 'needs-browser-native-category-contracts' : 'blocked-by-web-setup',
    categoryIds: lane.categoryIds,
  }));
  return {
    status: enabled ? nativeCategoryRoutesPublished ? 'browser-native-ready' : 'openable' : 'setup-needed',
    controlCount: controls.length,
    nativeControlCount: laneControls.length,
    ...(includeDetails ? { controls, nativeControls: laneControls } : {}),
    pwaInstall: {
      status: certifiedFirstRun.length > 0 ? 'certified-live-receipt' : enabled ? 'browser-owned' : 'blocked-by-web-setup',
      note: certifiedFirstRun.length > 0
        ? 'The connected host published certified browser/PWA first-run evidence for the browser runtime.'
        : 'Agent can open the configured URL; installing the PWA remains a browser/connected-host UI action until a certified first-run receipt is published.',
    },
    touchControls: {
      status: nativeCategoryRoutesPublished ? 'ready' : 'needs-browser-native-category-contracts',
      note: nativeCategoryRoutesPublished
        ? 'Certified browser-native route contracts cover chat, setup, approvals, memory, channels, automation, research, and safety lanes with mobile/touch evidence.'
        : 'Agent has not received a connected-host contract proving mobile-native controls for chat, setup, approvals, memory, channels, or automation.',
    },
  };
}

function browserCockpitReceipts(
  context: CommandContext,
  enabled: boolean,
  includeDetails: boolean,
  browserPwa: BrowserPwaReadModelSnapshot,
): Record<string, unknown> {
  const marker = (() => {
    try {
      const shellPaths = context.workspace?.shellPaths;
      if (!shellPaths) return { status: 'unavailable', exists: false, reason: 'Agent shell paths are unavailable in this runtime.' };
      const completion = readOnboardingCompletionMarker(shellPaths, 'user');
      return {
        status: completion.exists ? 'complete' : 'missing',
        exists: completion.exists,
        path: completion.path,
        updatedAt: completion.payload?.updatedAt ?? null,
        source: completion.payload?.source ?? null,
        mode: completion.payload?.mode ?? null,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        exists: false,
        reason: error instanceof Error ? error.message : 'Unable to read Agent onboarding completion marker.',
      };
    }
  })();
  const certifiedFirstRun = certifiedBrowserPwaFirstRunReceipts(browserPwa);
  const setupReceipts = browserPwaSetupReceipts(context);
  const readySetupReceipt = readyBrowserPwaSetupReceipt(setupReceipts);
  const browserFirstRunStatus = certifiedFirstRun.length > 0
    ? 'certified-live-receipt'
    : readySetupReceipt
      ? 'published'
      : 'not-published';
  return {
    status: browserFirstRunStatus !== 'not-published' && marker.exists === true
      ? 'ready'
      : browserFirstRunStatus !== 'not-published'
        ? 'browser-ready-agent-onboarding-missing'
        : marker.exists === true ? 'agent-complete-browser-receipt-missing' : 'needs-agent-closeout-and-browser-receipt',
    agentOnboardingStatus: marker.status,
    browserFirstRunStatus,
    ...(includeDetails ? {
      agentOnboardingCompletion: marker,
      browserFirstRunCompletion: certifiedFirstRun.length > 0
        ? {
          status: 'certified-live-receipt',
          webEnabled: enabled,
          certifiedReadModelCount: certifiedFirstRun.length,
          evidence: certifiedFirstRun[0],
          setupReceiptEvidence: readySetupReceipt ?? null,
          nextStep: 'Keep browser/PWA first-run receipts fresh with each connected-host browser runtime release.',
        }
        : readySetupReceipt
          ? {
            status: 'published',
            webEnabled: enabled,
            evidence: readySetupReceipt,
            certifiedReadModelCount: 0,
            nextStep: 'Publish certified browser/PWA runtime read-model receipts to make cockpit readiness independently verifiable.',
          }
          : {
            status: 'not-published',
            webEnabled: enabled,
            evidence: null,
            certifiedReadModelCount: 0,
            nextStep: 'Publish a connected-host browser/PWA completion receipt before using browser readiness as first-run closeout evidence.',
          },
      browserPwaSetupReceipts: setupReceipts.slice(0, 8),
    } : {}),
    setupCloseoutRoute: 'setup action:"status" includeParameters:true',
    policy: 'Agent reports its own user onboarding marker separately from the connected-host browser/PWA receipt contract so setup closeout does not overclaim browser readiness.',
  };
}

export function connectedBrowserCockpitRoute(context: CommandContext, options: { readonly includeWorkspaceCoverage?: boolean } = {}): Record<string, unknown> {
  const configManager = context.platform?.configManager;
  let enabled = false;
  let binding = { hostMode: 'local', configuredHost: '127.0.0.1', host: '127.0.0.1', port: 3423 };
  let publicBaseUrl = '';
  if (configManager) {
    try {
      enabled = configManager.get('web.enabled') === true;
      binding = resolveRuntimeEndpointBinding(configManager, 'web');
      publicBaseUrl = String(configManager.get('web.publicBaseUrl') ?? '').trim();
    } catch {
      enabled = false;
    }
  }
  const url = publicBaseUrl || `http://${browserConnectHost(binding.host)}:${binding.port}`;
  const browserPwa = browserPwaReadModelSnapshot(context);
  const nativeCategoryRoutesPublished = enabled && AGENT_WORKSPACE_CATEGORIES.every((category) =>
    Boolean(certifiedBrowserPwaCategoryRouteForCategory(browserPwa, category.id))
  );
  const browserFirstRunCertified = certifiedBrowserPwaFirstRunReceipts(browserPwa).length > 0;
  return {
    enabled,
    readiness: enabled ? nativeCategoryRoutesPublished && browserFirstRunCertified ? 'browser-native-ready' : 'ready' : 'setup-needed',
    url,
    source: publicBaseUrl ? 'web.publicBaseUrl' : 'web endpoint binding',
    endpoint: {
      id: 'web',
      binding,
      settings: ['web.enabled', 'web.hostMode', 'web.host', 'web.port', 'web.publicBaseUrl'],
    },
    workspaceCoverage: browserCockpitWorkspaceCoverage(enabled, options.includeWorkspaceCoverage === true, browserPwa),
    mobile: browserCockpitMobileAffordances(enabled, options.includeWorkspaceCoverage === true, browserPwa, nativeCategoryRoutesPublished),
    receipts: browserCockpitReceipts(context, enabled, options.includeWorkspaceCoverage === true, browserPwa),
    setupRoutes: {
      inspectEndpoint: 'host action:"service" endpointId:"web" includeParameters:true',
      servicePosture: 'host action:"services" includeParameters:true',
      connectedHostStatus: 'host action:"status" includeParameters:true',
      settings: 'settings action:"list" query:"web" includeHidden:true',
    },
    policy: 'Opens the connected GoodVibes browser cockpit only after explicit user confirmation. Agent does not host a separate browser app or bypass connected-host setup.',
  };
}
