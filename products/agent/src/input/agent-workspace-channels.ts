import type { CommandContext } from './command-registry.ts';

export type AgentWorkspaceChannelRisk = 'dm' | 'group' | 'public' | 'webhook' | 'bridge';

export interface AgentWorkspaceChannelStatus {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly requiredKeys: readonly string[];
  readonly missingRequiredKeys: readonly string[];
  readonly missingConfigCount: number;
  readonly defaultTargetKeys: readonly string[];
  readonly configuredDefaultTargetKeys: readonly string[];
  readonly defaultTarget: 'configured' | 'missing' | 'not-required';
  readonly delivery: 'disabled' | 'blocked' | 'explicit-target' | 'default-ready';
  readonly risk: AgentWorkspaceChannelRisk;
  readonly riskLabel: string;
  readonly setupState: 'disabled' | 'needs-config' | 'needs-target' | 'ready';
  readonly nextStep: string;
}

export type AgentWorkspaceChannelSetupGuideStatus = 'ready' | 'attention' | 'setup-needed';
export type AgentWorkspaceChannelSetupGuideStepStatus = 'complete' | 'current' | 'pending';
export type AgentWorkspaceChannelSetupGuideStepSafety = 'read-only' | 'settings' | 'confirmed';

export interface AgentWorkspaceChannelSetupGuideStep {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceChannelSetupGuideStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly safety: AgentWorkspaceChannelSetupGuideStepSafety;
}

export interface AgentWorkspaceChannelSetupGuideChannel {
  readonly channelId: string;
  readonly label: string;
  readonly setupState: AgentWorkspaceChannelStatus['setupState'];
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly delivery: AgentWorkspaceChannelStatus['delivery'];
  readonly riskLabel: string;
  readonly summary: string;
  readonly guideRoute: string;
  readonly modelRoute: string;
}

export interface AgentWorkspaceChannelSetupGuide {
  readonly status: AgentWorkspaceChannelSetupGuideStatus;
  readonly summary: string;
  readonly progressLabel: string;
  readonly totalChannels: number;
  readonly enabledChannels: number;
  readonly readyChannels: number;
  readonly attentionChannels: number;
  readonly configuredTargets: number;
  readonly currentChannelId: string | null;
  readonly currentChannelLabel: string | null;
  readonly currentStepId: string | null;
  readonly currentStepLabel: string | null;
  readonly channels: readonly AgentWorkspaceChannelSetupGuideChannel[];
  readonly steps: readonly AgentWorkspaceChannelSetupGuideStep[];
  readonly routes: {
    readonly readiness: string;
    readonly attention: string;
    readonly accounts: string;
    readonly policies: string;
    readonly status: string;
  };
  readonly policy: string;
}

interface AgentWorkspaceConfigReader {
  get(key: string): unknown;
}

interface AgentWorkspaceChannelSpec {
  readonly id: string;
  readonly label: string;
  readonly enabledKey: string;
  readonly requiredKeys: readonly string[];
  readonly requiredKeyGroups?: readonly (readonly string[])[];
  readonly defaultTargetKeys: readonly string[];
  readonly risk: AgentWorkspaceChannelRisk;
  readonly riskLabel: string;
}

const AGENT_WORKSPACE_CHANNEL_SPECS: readonly AgentWorkspaceChannelSpec[] = [
  {
    id: 'slack',
    label: 'Slack',
    enabledKey: 'surfaces.slack.enabled',
    requiredKeys: ['surfaces.slack.botToken', 'surfaces.slack.signingSecret'],
    defaultTargetKeys: ['surfaces.slack.defaultChannel'],
    risk: 'group',
    riskLabel: 'workspace/group channel',
  },
  {
    id: 'discord',
    label: 'Discord',
    enabledKey: 'surfaces.discord.enabled',
    requiredKeys: ['surfaces.discord.botToken', 'surfaces.discord.publicKey', 'surfaces.discord.applicationId'],
    defaultTargetKeys: ['surfaces.discord.defaultChannelId'],
    risk: 'group',
    riskLabel: 'server/channel delivery',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    enabledKey: 'surfaces.telegram.enabled',
    requiredKeys: ['surfaces.telegram.botToken'],
    defaultTargetKeys: ['surfaces.telegram.defaultChatId'],
    risk: 'dm',
    riskLabel: 'bot DM/group delivery',
  },
  {
    id: 'ntfy',
    label: 'ntfy',
    enabledKey: 'surfaces.ntfy.enabled',
    requiredKeys: ['surfaces.ntfy.baseUrl', 'surfaces.ntfy.chatTopic', 'surfaces.ntfy.agentTopic'],
    defaultTargetKeys: ['surfaces.ntfy.topic'],
    risk: 'public',
    riskLabel: 'topic-based public/private feed',
  },
  {
    id: 'googleChat',
    label: 'Google Chat',
    enabledKey: 'surfaces.googleChat.enabled',
    requiredKeys: ['surfaces.googleChat.webhookUrl', 'surfaces.googleChat.verificationToken'],
    defaultTargetKeys: ['surfaces.googleChat.spaceId'],
    risk: 'group',
    riskLabel: 'space delivery',
  },
  {
    id: 'signal',
    label: 'Signal',
    enabledKey: 'surfaces.signal.enabled',
    requiredKeys: ['surfaces.signal.bridgeUrl', 'surfaces.signal.account'],
    defaultTargetKeys: ['surfaces.signal.defaultRecipient'],
    risk: 'bridge',
    riskLabel: 'private routed delivery',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    enabledKey: 'surfaces.whatsapp.enabled',
    requiredKeys: ['surfaces.whatsapp.accessToken', 'surfaces.whatsapp.verifyToken', 'surfaces.whatsapp.phoneNumberId'],
    defaultTargetKeys: ['surfaces.whatsapp.defaultRecipient'],
    risk: 'dm',
    riskLabel: 'phone-number delivery',
  },
  {
    id: 'telephony',
    label: 'Telephony',
    enabledKey: 'surfaces.telephony.enabled',
    requiredKeys: [],
    requiredKeyGroups: [
      ['surfaces.telephony.bridgeUrl'],
      ['surfaces.telephony.accountSid', 'surfaces.telephony.authToken', 'surfaces.telephony.fromNumber'],
    ],
    defaultTargetKeys: ['surfaces.telephony.defaultRecipient'],
    risk: 'dm',
    riskLabel: 'SMS/voice phone-number delivery',
  },
  {
    id: 'imessage',
    label: 'iMessage',
    enabledKey: 'surfaces.imessage.enabled',
    requiredKeys: ['surfaces.imessage.bridgeUrl', 'surfaces.imessage.account'],
    defaultTargetKeys: ['surfaces.imessage.defaultChatId'],
    risk: 'bridge',
    riskLabel: 'Apple routed delivery',
  },
  {
    id: 'bluebubbles',
    label: 'BlueBubbles',
    enabledKey: 'surfaces.bluebubbles.enabled',
    requiredKeys: ['surfaces.bluebubbles.serverUrl', 'surfaces.bluebubbles.password'],
    defaultTargetKeys: ['surfaces.bluebubbles.defaultChatGuid'],
    risk: 'bridge',
    riskLabel: 'iMessage routed delivery',
  },
  {
    id: 'msteams',
    label: 'Microsoft Teams',
    enabledKey: 'surfaces.msteams.enabled',
    requiredKeys: ['surfaces.msteams.appId', 'surfaces.msteams.appPassword'],
    defaultTargetKeys: ['surfaces.msteams.defaultConversationId', 'surfaces.msteams.defaultChannelId'],
    risk: 'group',
    riskLabel: 'tenant/channel delivery',
  },
  {
    id: 'mattermost',
    label: 'Mattermost',
    enabledKey: 'surfaces.mattermost.enabled',
    requiredKeys: ['surfaces.mattermost.baseUrl', 'surfaces.mattermost.botToken'],
    defaultTargetKeys: ['surfaces.mattermost.defaultChannelId'],
    risk: 'group',
    riskLabel: 'team/channel delivery',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    enabledKey: 'surfaces.matrix.enabled',
    requiredKeys: ['surfaces.matrix.homeserverUrl', 'surfaces.matrix.accessToken'],
    defaultTargetKeys: ['surfaces.matrix.defaultRoomId'],
    risk: 'group',
    riskLabel: 'room delivery',
  },
  {
    id: 'webhook',
    label: 'Webhook',
    enabledKey: 'surfaces.webhook.enabled',
    requiredKeys: ['surfaces.webhook.defaultTarget'],
    defaultTargetKeys: ['surfaces.webhook.defaultTarget'],
    risk: 'webhook',
    riskLabel: 'external HTTP delivery',
  },
];

function configValue(context: CommandContext, key: string): unknown {
  const configManager = context.platform?.configManager as AgentWorkspaceConfigReader | undefined;
  return configManager?.get(key);
}

function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  try {
    const value = configValue(context, key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function hasConfigValue(context: CommandContext, key: string): boolean {
  try {
    const value = configValue(context, key);
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return value;
    return value !== null && value !== undefined;
  } catch {
    return false;
  }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function missingKeysForBestRequiredGroup(context: CommandContext, groups: readonly (readonly string[])[]): readonly string[] {
  if (groups.length === 0) return [];
  const missingByGroup = groups.map((group) => group.filter((key) => !hasConfigValue(context, key)));
  if (missingByGroup.some((missing) => missing.length === 0)) return [];
  return missingByGroup.reduce((best, missing) => missing.length < best.length ? missing : best, missingByGroup[0] ?? []);
}

function buildChannelStatus(context: CommandContext, spec: AgentWorkspaceChannelSpec): AgentWorkspaceChannelStatus {
  const enabled = readConfigBoolean(context, spec.enabledKey, false);
  const requiredKeyGroups = spec.requiredKeyGroups ?? [];
  const requiredKeys = uniqueStrings([
    ...spec.requiredKeys,
    ...requiredKeyGroups.flat(),
  ]);
  const missingRequiredKeys = [
    ...spec.requiredKeys.filter((key) => !hasConfigValue(context, key)),
    ...missingKeysForBestRequiredGroup(context, requiredKeyGroups),
  ];
  const configuredDefaultTargetKeys = spec.defaultTargetKeys.filter((key) => hasConfigValue(context, key));
  const missingConfigCount = missingRequiredKeys.length;
  const defaultTarget = spec.defaultTargetKeys.length === 0
    ? 'not-required'
    : configuredDefaultTargetKeys.length > 0
      ? 'configured'
      : 'missing';
  const ready = enabled && missingConfigCount === 0;
  const delivery = !enabled
    ? 'disabled'
    : !ready
      ? 'blocked'
      : defaultTarget === 'configured'
        ? 'default-ready'
        : 'explicit-target';
  const setupState = !enabled
    ? 'disabled'
    : missingConfigCount > 0
      ? 'needs-config'
      : defaultTarget === 'missing'
        ? 'needs-target'
        : 'ready';
  const nextStep = setupState === 'disabled'
    ? `Enable ${spec.label} in the owning GoodVibes host before Agent can use it.`
    : setupState === 'needs-config'
      ? `Configure ${missingRequiredKeys.join(', ')} in the owning GoodVibes host or secret manager.`
      : setupState === 'needs-target'
        ? `Provide an explicit delivery target per send, or configure one of ${spec.defaultTargetKeys.join(', ')}.`
        : `Use explicit user action or Agent policy to send through ${spec.label}.`;
  return {
    id: spec.id,
    label: spec.label,
    enabled,
    ready,
    requiredKeys,
    missingRequiredKeys,
    missingConfigCount,
    defaultTargetKeys: spec.defaultTargetKeys,
    configuredDefaultTargetKeys,
    defaultTarget,
    delivery,
    risk: spec.risk,
    riskLabel: spec.riskLabel,
    setupState,
    nextStep,
  };
}

export function buildAgentWorkspaceChannels(context: CommandContext): readonly AgentWorkspaceChannelStatus[] {
  return AGENT_WORKSPACE_CHANNEL_SPECS.map((spec) => buildChannelStatus(context, spec));
}

function channelGuideModelRoute(channelId?: string): string {
  return channelId
    ? `channels action:"setup" channelId:"${channelId}"`
    : 'channels action:"setup"';
}

function summarizeGuideChannel(channel: AgentWorkspaceChannelStatus): string {
  if (!channel.enabled) return `Enable ${channel.label} only if the user wants this surface.`;
  if (channel.setupState === 'needs-config') return `Missing ${channel.missingRequiredKeys.length} required config key(s).`;
  if (channel.setupState === 'needs-target') return 'Ready for explicit targets; default target is not configured.';
  return `${channel.label} is ready; delivery still requires explicit user action.`;
}

function rankedChannelGuideChannels(channels: readonly AgentWorkspaceChannelStatus[]): readonly AgentWorkspaceChannelStatus[] {
  const rank = (channel: AgentWorkspaceChannelStatus): number => {
    if (channel.setupState === 'needs-config') return 0;
    if (channel.setupState === 'needs-target') return 1;
    if (channel.setupState === 'disabled') return 2;
    return 3;
  };
  return [...channels].sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label));
}

function currentGuideChannel(channels: readonly AgentWorkspaceChannelStatus[]): AgentWorkspaceChannelStatus | null {
  const ranked = rankedChannelGuideChannels(channels);
  return ranked[0] ?? null;
}

function currentGuideStepId(channel: AgentWorkspaceChannelStatus | null): string {
  if (!channel) return 'choose-channel';
  if (!channel.enabled) return 'enable-channel';
  if (channel.setupState === 'needs-config') return 'inspect-setup-schema';
  if (channel.setupState === 'needs-target') return 'choose-delivery-target';
  return 'review-policy';
}

function guideStepStatus(stepId: string, currentStepId: string, order: readonly string[]): AgentWorkspaceChannelSetupGuideStepStatus {
  const stepIndex = order.indexOf(stepId);
  const currentIndex = order.indexOf(currentStepId);
  if (stepIndex < currentIndex) return 'complete';
  if (stepIndex === currentIndex) return 'current';
  return 'pending';
}

function buildGuideSteps(channel: AgentWorkspaceChannelStatus | null): readonly AgentWorkspaceChannelSetupGuideStep[] {
  const channelId = channel?.id ?? '<channel-id>';
  const channelLabel = channel?.label ?? 'a channel';
  const currentStepId = currentGuideStepId(channel);
  const order = [
    'choose-channel',
    'enable-channel',
    'inspect-setup-schema',
    'configure-secrets',
    'choose-delivery-target',
    'review-policy',
    'run-live-checks',
    'send-explicit-test',
  ] as const;
  const missingConfig = channel && channel.missingRequiredKeys.length > 0
    ? channel.missingRequiredKeys.join(', ')
    : 'the required secret refs or host-owned settings';
  const targetKeys = channel && channel.defaultTargetKeys.length > 0
    ? channel.defaultTargetKeys.join(', ')
    : 'an explicit delivery target';
  const makeStep = (
    id: typeof order[number],
    label: string,
    detail: string,
    userRoute: string,
    modelRoute: string,
    safety: AgentWorkspaceChannelSetupGuideStepSafety,
  ): AgentWorkspaceChannelSetupGuideStep => ({
    id,
    label,
    status: guideStepStatus(id, currentStepId, order),
    detail,
    userRoute,
    modelRoute,
    safety,
  });
  return [
    makeStep(
      'choose-channel',
      'Choose channel',
      'Pick the channel the user actually wants before collecting credentials or exposing delivery routes.',
      '/channels',
      'channels action:"status"',
      'read-only',
    ),
    makeStep(
      'enable-channel',
      'Enable surface',
      `Enable ${channelLabel} in the owning GoodVibes host or Agent settings only after the user chooses it.`,
      `/settings surfaces.${channelId}.enabled`,
      `settings action:"get" query:"surfaces.${channelId}.enabled" includeParameters:true`,
      'settings',
    ),
    makeStep(
      'inspect-setup-schema',
      'Inspect setup schema',
      `Open the read-only ${channelLabel} setup schema before asking for credentials.`,
      `/channels setup ${channelId}`,
      `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
      'read-only',
    ),
    makeStep(
      'configure-secrets',
      'Configure secrets',
      `Configure ${missingConfig}; secret values must stay in the secret manager or owning host.`,
      `/settings surfaces.${channelId}`,
      `settings action:"list" query:"surfaces.${channelId}" includeParameters:true`,
      'settings',
    ),
    makeStep(
      'choose-delivery-target',
      'Choose target',
      `Configure ${targetKeys}, or require the user to provide an explicit target on every send.`,
      `/channels show ${channelId}`,
      `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
      'read-only',
    ),
    makeStep(
      'review-policy',
      'Review allowlist',
      `Review ${channelLabel} account and allowlist policy before any delivery test.`,
      '/channels policies',
      'channels action:"status" includeParameters:true',
      'read-only',
    ),
    makeStep(
      'run-live-checks',
      'Run live checks',
      `Inspect connected-host status and doctor output for ${channelLabel}; do not run repair actions from the guide.`,
      `/channels doctor ${channelId}`,
      `channels action:"channel" channelId:"${channelId}" includeParameters:true`,
      'read-only',
    ),
    makeStep(
      'send-explicit-test',
      'Send explicit test',
      'Send one test message only after the user asks for that exact target and confirms the send.',
      `/channels send --channel ${channelId}:route:Label --message "Test from GoodVibes Agent" --yes`,
      'agent_channel_send confirm:true explicitUserRequest:"..."',
      'confirmed',
    ),
  ];
}

export function buildAgentWorkspaceChannelSetupGuide(
  channels: readonly AgentWorkspaceChannelStatus[],
  options: { readonly channelId?: string } = {},
): AgentWorkspaceChannelSetupGuide {
  const lookup = options.channelId?.trim().toLowerCase();
  const requested = lookup
    ? channels.find((channel) => channel.id.toLowerCase() === lookup || channel.label.toLowerCase() === lookup) ?? null
    : null;
  const ranked = rankedChannelGuideChannels(channels);
  const current = requested ?? currentGuideChannel(channels);
  const enabledChannels = channels.filter((channel) => channel.enabled).length;
  const readyChannels = channels.filter((channel) => channel.ready).length;
  const attentionChannels = channels.filter((channel) => channel.enabled && channel.setupState !== 'ready').length;
  const configuredTargets = channels.filter((channel) => channel.defaultTarget === 'configured').length;
  const status: AgentWorkspaceChannelSetupGuideStatus = attentionChannels > 0
    ? 'attention'
    : readyChannels > 0
      ? 'ready'
      : 'setup-needed';
  const steps = buildGuideSteps(current);
  const currentStep = steps.find((step) => step.status === 'current') ?? null;
  const summary = status === 'attention'
    ? `${attentionChannels} enabled channel(s) need setup. Start with ${current?.label ?? 'the first attention channel'}.`
    : status === 'ready'
      ? `${readyChannels}/${channels.length} channel(s) ready. Review allowlists and use explicit delivery tests only on request.`
      : 'No channel is ready yet. Choose one channel, enable it intentionally, then configure only that surface.';
  return {
    status,
    summary,
    progressLabel: currentStep ? `${steps.findIndex((step) => step.id === currentStep.id) + 1}/${steps.length} ${currentStep.label}` : `0/${steps.length}`,
    totalChannels: channels.length,
    enabledChannels,
    readyChannels,
    attentionChannels,
    configuredTargets,
    currentChannelId: current?.id ?? null,
    currentChannelLabel: current?.label ?? null,
    currentStepId: currentStep?.id ?? null,
    currentStepLabel: currentStep?.label ?? null,
    channels: ranked.map((channel) => ({
      channelId: channel.id,
      label: channel.label,
      setupState: channel.setupState,
      enabled: channel.enabled,
      ready: channel.ready,
      delivery: channel.delivery,
      riskLabel: channel.riskLabel,
      summary: summarizeGuideChannel(channel),
      guideRoute: `/channels guide ${channel.id}`,
      modelRoute: channelGuideModelRoute(channel.id),
    })),
    steps,
    routes: {
      readiness: '/channels',
      attention: '/channels attention',
      accounts: '/channels accounts',
      policies: '/channels policies',
      status: '/channels status',
    },
    policy: 'Read-only channel setup guide. Credentials stay in secret-backed settings or the owning GoodVibes host, and delivery tests require explicit confirmed user action.',
  };
}
