import { DEFAULT_CONFIG } from '../../config/index.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import type {
  OnboardingAcknowledgementState,
  OnboardingAcknowledgementTarget,
  OnboardingNetworkMode,
  OnboardingReopenEditAcknowledgementState,
  OnboardingSnapshotState,
  OnboardingStep1CapabilityFlags,
  OnboardingStep1CapabilityItem,
  OnboardingStepDerivationState,
} from './types.ts';

const PROVIDER_SECRET_ENV_ALIASES = {
  openai: ['OPENAI_API_KEY', 'OPENAI_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  inceptionlabs: ['INCEPTION_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  aihubmix: ['AIHUBMIX_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
  huggingface: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  nvidia: ['NVIDIA_API_KEY'],
  llm7: ['LLM7_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'microsoft-foundry': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  qianfan: ['QIANFAN_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
  sglang: ['SGLANG_API_KEY'],
  stepfun: ['STEPFUN_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  venice: ['VENICE_API_KEY'],
  volcengine: ['VOLCANO_ENGINE_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
  'copilot-proxy': ['COPILOT_PROXY_API_KEY'],
} as const satisfies Record<string, readonly string[]>;

const SECRET_KEY_TO_PROVIDER_IDS = new Map<string, readonly string[]>(
  Object.entries(PROVIDER_SECRET_ENV_ALIASES).flatMap(([providerId, aliases]) => aliases.map((alias) => [alias, [providerId] as const])),
);

const INBOUND_EVENT_SURFACE_KINDS = new Set<string>([
  'bluebubbles',
  'discord',
  'google-chat',
  'googleChat',
  'imessage',
  'mattermost',
  'matrix',
  'msteams',
  'ntfy',
  'signal',
  'slack',
  'telegram',
  'webhook',
  'whatsapp',
]);

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => isDeepEqual(value, right[index]));
  }

  if (
    typeof left === 'object' && left !== null
    && typeof right === 'object' && right !== null
    && !Array.isArray(left)
    && !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) return false;

    return leftEntries.every(([key, value]) => isDeepEqual(value, Reflect.get(right, key)));
  }

  return false;
}

function countPermissionToolOverrides(snapshot: OnboardingSnapshotState): number {
  return Object.entries(snapshot.config.permissions.tools).filter(([key, value]) => {
    if (value === undefined) return false;
    return value !== DEFAULT_CONFIG.permissions.tools[key as keyof typeof DEFAULT_CONFIG.permissions.tools];
  }).length;
}

function hasCustomizedProviderRouting(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.providerRouting.primaryProviderId !== getProviderIdFromModel(DEFAULT_CONFIG.provider.model)
    || snapshot.providerRouting.primaryModelId !== DEFAULT_CONFIG.provider.model
    || snapshot.providerRouting.primaryReasoningEffort !== DEFAULT_CONFIG.provider.reasoningEffort
    || snapshot.providerRouting.embeddingProviderId !== DEFAULT_CONFIG.provider.embeddingProvider
    || snapshot.providerRouting.systemPromptFile.trim() !== DEFAULT_CONFIG.provider.systemPromptFile.trim()
    || snapshot.providerRouting.helperEnabled !== DEFAULT_CONFIG.helper.enabled
    || snapshot.providerRouting.helperProviderId !== DEFAULT_CONFIG.helper.globalProvider
    || snapshot.providerRouting.helperModelId !== DEFAULT_CONFIG.helper.globalModel
    || snapshot.providerRouting.toolLlmEnabled !== DEFAULT_CONFIG.tools.llmEnabled
    || snapshot.providerRouting.toolProviderId !== DEFAULT_CONFIG.tools.llmProvider
    || snapshot.providerRouting.toolModelId !== DEFAULT_CONFIG.tools.llmModel;
}

function getProviderAccountSignalIds(snapshot: OnboardingSnapshotState): string[] {
  return (snapshot.providerAccounts?.providers ?? [])
    .filter((provider) => provider.activeRoute !== 'unconfigured' || provider.pendingLogin || provider.oauthReady)
    .map((provider) => provider.providerId);
}

function getServiceCredentialProviderIds(snapshot: OnboardingSnapshotState): string[] {
  return snapshot.services.services
    .filter((service) => service.hasPrimaryCredential || service.hasPasswordCredential)
    .map((service) => service.providerId);
}

function getSecretBackedProviderIds(snapshot: OnboardingSnapshotState): string[] {
  const providerIds = new Set<string>();

  for (const record of snapshot.secrets.records) {
    const matches = SECRET_KEY_TO_PROVIDER_IDS.get(record.key);
    if (!matches) continue;
    for (const providerId of matches) providerIds.add(providerId);
  }

  return [...providerIds].sort((left, right) => left.localeCompare(right));
}

function getConfiguredProviderSignalIds(snapshot: OnboardingSnapshotState): string[] {
  return [...new Set<string>([
    ...getProviderAccountSignalIds(snapshot),
    ...snapshot.services.oauthProviderIds,
    ...getServiceCredentialProviderIds(snapshot),
    ...snapshot.subscriptions.activeProviderIds,
    ...snapshot.subscriptions.pendingProviderIds,
    ...getSecretBackedProviderIds(snapshot),
  ])].sort((left, right) => left.localeCompare(right));
}

function hasConfiguredProviderState(snapshot: OnboardingSnapshotState): boolean {
  return getConfiguredProviderSignalIds(snapshot).length > 0;
}

function getConfiguredSurfaceKinds(snapshot: OnboardingSnapshotState): string[] {
  const kinds = new Set<string>([
    ...snapshot.surfaces.configuredEnabledKinds,
    ...snapshot.surfaces.records.filter((surface) => surface.enabled).map((surface) => surface.kind),
  ]);

  for (const [kind, value] of Object.entries(snapshot.config.surfaces)) {
    if (!value || typeof value !== 'object') continue;
    const defaults = DEFAULT_CONFIG.surfaces[kind as keyof typeof DEFAULT_CONFIG.surfaces];
    if (!defaults || typeof defaults !== 'object') continue;
    if (!isDeepEqual(value, defaults)) kinds.add(kind);
  }

  return [...kinds].sort((left, right) => left.localeCompare(right));
}

function countConfiguredSurfaceKinds(snapshot: OnboardingSnapshotState): number {
  return getConfiguredSurfaceKinds(snapshot).length;
}

function hasInboundEventSurface(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.surfaces.configuredEnabledKinds.some((kind) => INBOUND_EVENT_SURFACE_KINDS.has(kind))
    || snapshot.surfaces.records.some((surface) => surface.enabled && INBOUND_EVENT_SURFACE_KINDS.has(surface.kind));
}

function hasCustomizedWorkspaceDefaults(snapshot: OnboardingSnapshotState): boolean {
  return !isDeepEqual(snapshot.config.behavior, DEFAULT_CONFIG.behavior)
    || !isDeepEqual(snapshot.config.display, DEFAULT_CONFIG.display);
}

function hasWebhookOrEventIngress(snapshot: OnboardingSnapshotState): boolean {
  return hasInboundEventSurface(snapshot)
    || snapshot.services.services.some((service) => service.hasWebhookUrl || service.hasSigningSecret || service.hasPublicKey || service.hasAppToken);
}

function getProviderIdentityIds(snapshot: OnboardingSnapshotState): Set<string> {
  return new Set<string>([
    ...Object.keys(PROVIDER_SECRET_ENV_ALIASES),
    ...getConfiguredProviderSignalIds(snapshot),
    snapshot.providerRouting.primaryProviderId,
    snapshot.providerRouting.embeddingProviderId,
    snapshot.providerRouting.helperProviderId,
    snapshot.providerRouting.toolProviderId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
}

function getExternalIntegrationServiceIds(snapshot: OnboardingSnapshotState): string[] {
  const providerIdentityIds = getProviderIdentityIds(snapshot);

  return snapshot.services.services
    .filter((service) => !providerIdentityIds.has(service.providerId) && !providerIdentityIds.has(service.name))
    .map((service) => service.name);
}

function hasExternalIntegrations(snapshot: OnboardingSnapshotState): boolean {
  return getExternalIntegrationServiceIds(snapshot).length > 0
    || countConfiguredSurfaceKinds(snapshot) > 0;
}

function hasLocalBehaviorCustomization(snapshot: OnboardingSnapshotState): boolean {
  return hasCustomizedWorkspaceDefaults(snapshot)
    || countPermissionToolOverrides(snapshot) > 0
    || snapshot.runtimeDefaults.secretStoragePolicy !== DEFAULT_CONFIG.storage.secretPolicy
    || countDiscoveredLocalBehavior(snapshot) > 0;
}

function hasCommunicationChannelSignals(snapshot: OnboardingSnapshotState): boolean {
  return hasExternalIntegrations(snapshot);
}

function hasAutomationReviewSignals(snapshot: OnboardingSnapshotState): boolean {
  return hasWebhookOrEventIngress(snapshot);
}

function describeOperatorTerminal(): string {
  return 'Use GoodVibes Agent as the terminal operator while connecting to an existing GoodVibes host. Agent setup does not create new entrypoints.';
}

function describeProviderAccess(snapshot: OnboardingSnapshotState): string {
  const configuredCount = getConfiguredProviderSignalIds(snapshot).length;
  if (configuredCount === 0 && !hasCustomizedProviderRouting(snapshot)) {
    return 'Choose the model route the Agent should use for normal assistant turns, tool reasoning, and embeddings.';
  }

  return `Review ${Math.max(configuredCount, 1)} provider auth or routing signal(s) already available to Agent.`;
}

function describeAgentKnowledge(): string {
  return 'Agent Knowledge uses the isolated /api/goodvibes-agent/knowledge segment only; it never falls back to another knowledge segment.';
}

function describeLocalBehavior(snapshot: OnboardingSnapshotState): string {
  const discoveredCount = countDiscoveredLocalBehavior(snapshot);
  if (discoveredCount > 0) {
    const discovery = snapshot.localBehaviorDiscovery;
    const samples = [
      ...discovery.personas.names,
      ...discovery.skills.names,
      ...discovery.routines.names,
    ].slice(0, 4);
    const sampleText = samples.length > 0 ? ` Found: ${samples.join(', ')}.` : '';
    return `Import ${discoveredCount} discovered Agent persona/skill/routine file(s) from Agent-local folders before creating blank behavior.${sampleText}`;
  }

  if (!hasLocalBehaviorCustomization(snapshot)) {
    return 'Configure local memory, routines, skills, personas, permissions, and secret handling before the Agent starts doing useful work.';
  }

  return 'Review existing local behavior, permission, display, or secret-handling choices before applying Agent setup.';
}

function countDiscoveredLocalBehavior(snapshot: OnboardingSnapshotState): number {
  return snapshot.localBehaviorDiscovery.personas.count
    + snapshot.localBehaviorDiscovery.skills.count
    + snapshot.localBehaviorDiscovery.routines.count;
}

function describeCommunicationChannels(snapshot: OnboardingSnapshotState): string {
  const integrationCount = new Set<string>([
    ...getExternalIntegrationServiceIds(snapshot),
    ...getConfiguredSurfaceKinds(snapshot),
  ]).size;

  if (integrationCount === 0) {
    return 'Connect only the channels the Agent should use, and keep outbound delivery explicit until a user action allows it.';
  }

  return `Review ${integrationCount} configured channel or integration signal(s) before the Agent uses them for delivery.`;
}

function describeAutomationReview(snapshot: OnboardingSnapshotState): string {
  if (!hasAutomationReviewSignals(snapshot)) {
    return 'Review schedules, routine promotion, approvals, and automation visibility without starting hidden background work.';
  }

  return 'Review existing event, schedule, or automation signals and keep all side effects behind explicit commands or confirmations.';
}

function describeTuiDelegation(): string {
  return 'Delegate explicit build, fix, implementation, and review work to GoodVibes TUI; delegated review is requested only when the user explicitly asks for it.';
}

function getAcknowledgementAccepted(
  snapshot: OnboardingSnapshotState,
  target: OnboardingAcknowledgementTarget,
): boolean {
  return snapshot.acknowledgements.accepted[target] === true;
}

function buildNotNeededAcknowledgement(
  snapshot: OnboardingSnapshotState,
  target: OnboardingAcknowledgementTarget,
  detail: string,
): OnboardingAcknowledgementState {
  return {
    required: false,
    accepted: getAcknowledgementAccepted(snapshot, target),
    reason: 'not-needed',
    detail,
  };
}

function buildRequiredAcknowledgement(
  snapshot: OnboardingSnapshotState,
  target: OnboardingAcknowledgementTarget,
  reason: Exclude<OnboardingAcknowledgementState['reason'], 'not-needed'>,
  detail: string,
): OnboardingAcknowledgementState {
  return {
    required: true,
    accepted: getAcknowledgementAccepted(snapshot, target),
    reason,
    detail,
  };
}

export function deriveStep1Capabilities(
  snapshot: OnboardingSnapshotState,
): readonly OnboardingStep1CapabilityItem[] {
  return [
    {
      id: 'operator-terminal',
      label: 'Agent Operator TUI',
      selected: true,
      detail: describeOperatorTerminal(),
    },
    {
      id: 'provider-access',
      label: 'Provider and Model Access',
      selected: hasConfiguredProviderState(snapshot) || hasCustomizedProviderRouting(snapshot),
      detail: describeProviderAccess(snapshot),
    },
    {
      id: 'agent-knowledge',
      label: 'Isolated Agent Knowledge',
      selected: true,
      detail: describeAgentKnowledge(),
    },
    {
      id: 'local-behavior',
      label: 'Local Memory and Skills',
      selected: hasLocalBehaviorCustomization(snapshot),
      detail: describeLocalBehavior(snapshot),
    },
    {
      id: 'communication-channels',
      label: 'Channels and Notifications',
      selected: hasCommunicationChannelSignals(snapshot),
      detail: describeCommunicationChannels(snapshot),
    },
    {
      id: 'automation-review',
      label: 'Routines and Automation Review',
      selected: hasAutomationReviewSignals(snapshot),
      detail: describeAutomationReview(snapshot),
    },
    {
      id: 'tui-delegation',
      label: 'Explicit Build Delegation',
      selected: true,
      detail: describeTuiDelegation(),
    },
  ];
}

export function deriveStep1CapabilityFlags(
  snapshot: OnboardingSnapshotState,
): OnboardingStep1CapabilityFlags {
  return {
    providerAccess: hasConfiguredProviderState(snapshot) || hasCustomizedProviderRouting(snapshot),
    subscriptions: snapshot.subscriptions.active.length > 0 || snapshot.subscriptions.pending.length > 0,
    auth: snapshot.auth.snapshot.userCount > 0
      || snapshot.auth.snapshot.sessionCount > 0
      || snapshot.auth.snapshot.bootstrapCredentialPresent,
    agentKnowledge: true,
    localBehavior: hasLocalBehaviorCustomization(snapshot),
    communicationChannels: hasCommunicationChannelSignals(snapshot),
    automationReview: hasAutomationReviewSignals(snapshot),
    tuiDelegation: true,
  };
}

export function deriveStep1_5NetworkMode(): OnboardingNetworkMode {
  return 'local-network-default';
}

export function deriveReopenEditAcknowledgementState(
  snapshot: OnboardingSnapshotState,
): OnboardingReopenEditAcknowledgementState {
  const providerAccounts = snapshot.providerAccounts?.providers ?? [];
  const providerPendingCount = providerAccounts.filter((provider) => provider.pendingLogin).length;
  const providerConfiguredCount = providerAccounts.filter((provider) => provider.activeRoute !== 'unconfigured' || provider.oauthReady).length;
  const providerRoutingCustomized = hasCustomizedProviderRouting(snapshot);
  const providerSignalCount = getConfiguredProviderSignalIds(snapshot).length;

  const subscriptionsPendingCount = snapshot.subscriptions.pending.length;
  const subscriptionsActiveCount = snapshot.subscriptions.active.length;

  const authUserCount = snapshot.auth.snapshot.userCount;
  const authSessionCount = snapshot.auth.snapshot.sessionCount;
  const bootstrapCredentialPresent = snapshot.auth.snapshot.bootstrapCredentialPresent;

  const providers = providerPendingCount > 0
    ? buildRequiredAcknowledgement(
        snapshot,
        'providers',
        'pending-login',
        `${providerPendingCount} provider login(s) are still pending completion.`,
      )
    : providerConfiguredCount > 0 || providerSignalCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'providers',
          'configured-routing',
          `${Math.max(providerConfiguredCount, providerSignalCount, 1)} provider auth path(s) are already configured.`,
        )
      : providerRoutingCustomized
        ? buildRequiredAcknowledgement(
            snapshot,
            'providers',
            'customized-config',
            'Provider routing already differs from the default shell configuration.',
          )
        : buildNotNeededAcknowledgement(snapshot, 'providers', 'No existing provider routing needs confirmation.');

  const subscriptions = subscriptionsPendingCount > 0
    ? buildRequiredAcknowledgement(
        snapshot,
        'subscriptions',
        'pending-login',
        `${subscriptionsPendingCount} subscription login(s) are pending completion.`,
      )
    : subscriptionsActiveCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'subscriptions',
          'subscription-state',
          `${subscriptionsActiveCount} stored subscription session(s) already exist.`,
        )
      : buildNotNeededAcknowledgement(snapshot, 'subscriptions', 'No stored subscription sessions need confirmation.');

  const auth = bootstrapCredentialPresent
    ? buildRequiredAcknowledgement(
        snapshot,
        'auth',
        'bootstrap-credential',
        'A connected-host bootstrap credential signal is still visible to Agent.',
      )
    : authSessionCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'auth',
          'active-sessions',
          `${authSessionCount} connected-host auth session signal(s) are currently visible.`,
        )
      : authUserCount > 0
        ? buildRequiredAcknowledgement(
            snapshot,
            'auth',
            'auth-state',
            `${authUserCount} connected-host auth user signal(s) are already visible.`,
          )
        : buildNotNeededAcknowledgement(snapshot, 'auth', 'No connected-host auth signal needs confirmation.');

  return {
    providers,
    subscriptions,
    auth,
  };
}

export function deriveOnboardingStepState(
  snapshot: OnboardingSnapshotState,
): OnboardingStepDerivationState {
  return {
    step1Capabilities: deriveStep1Capabilities(snapshot),
    step1_5NetworkMode: deriveStep1_5NetworkMode(),
    reopenEditAcknowledgements: deriveReopenEditAcknowledgementState(snapshot),
  };
}
