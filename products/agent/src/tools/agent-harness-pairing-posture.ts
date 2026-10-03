import { networkInterfaces } from 'node:os';
import type { CommandContext } from '../input/command-registry.ts';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import { resolveRuntimeEndpointBinding } from '../cli/endpoints.ts';
import { connectedHostOperatorTokenFingerprint, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { buildAgentWorkspaceChannels } from '../input/agent-workspace-channels.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from '../input/agent-workspace-voice-media.ts';
import { requirePlatform, requireShellPaths } from '../input/commands/runtime-services.ts';
import { browserControlPosture } from './agent-harness-browser-control.ts';
import { certifiedDeviceLiveRecords, deviceLiveReadModelSnapshot } from './agent-harness-device-live-read-models.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessPairingArgs {
  readonly pairingRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type PairingResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type PairingLookupSource = 'pairingRouteId' | 'target' | 'query';

interface PairingRoute {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly effect: 'read-only' | 'visible-navigation' | 'external-network' | 'confirmation-gated-secret-display' | 'confirmed-local-auth-provisioning';
  readonly command?: string;
  readonly harnessRoute?: string;
  readonly capabilityIds?: readonly string[];
  readonly requiresConfirmation?: boolean;
}

type DeviceCapabilityStatus = 'ready' | 'attention' | 'setup-needed' | 'not-published';

interface DeviceCapability {
  readonly id: string;
  readonly label: string;
  readonly domain: 'companion' | 'browser' | 'voice' | 'delivery' | 'desktop' | 'device';
  readonly status: DeviceCapabilityStatus;
  readonly userOutcome: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly capabilities: readonly string[];
  readonly modelRoute: string;
  readonly userRoute?: string;
  readonly setupRoutes?: readonly string[];
  readonly evidence?: Record<string, unknown>;
  readonly policy: string;
}

interface DeviceCapabilityMap {
  readonly summary: {
    readonly total: number;
    readonly ready: number;
    readonly attention: number;
    readonly setupNeeded: number;
    readonly notPublished: number;
    readonly primaryNextStep: string;
  };
  readonly capabilities: readonly DeviceCapability[];
  readonly policy: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
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

function readConfigStringArray(context: CommandContext, key: string): readonly string[] {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
    return [];
  } catch {
    return [];
  }
}

function localNetworkIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const netInfo of nets[name] ?? []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
      }
    }
  } catch {
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

function urlHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return localNetworkIp();
  return host || '127.0.0.1';
}

function lookupFromArgs(args: AgentHarnessPairingArgs): { readonly source: PairingLookupSource; readonly input: string } | null {
  const pairingRouteId = readString(args.pairingRouteId);
  if (pairingRouteId) return { source: 'pairingRouteId', input: pairingRouteId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function pairingRoutes(): readonly PairingRoute[] {
  return [
    {
      id: 'qr-pairing',
      label: 'QR pairing',
      detail: 'Visible companion pairing route that prints QR setup details in the Agent TUI without printing the raw token.',
      effect: 'external-network',
      command: '/pair',
      harnessRoute: 'agent_harness mode:"run_command" command:"/pair" confirm:true explicitUserRequest:"..."',
      requiresConfirmation: true,
    },
    {
      id: 'manual-token-display',
      label: 'Manual token display',
      detail: 'Explicitly confirmed fallback route that prints the raw companion token only when the user asks for manual setup.',
      effect: 'confirmation-gated-secret-display',
      command: '/pair --show-token --yes',
      harnessRoute: 'agent_harness mode:"run_command" command:"/pair --show-token --yes" confirm:true explicitUserRequest:"..."',
      requiresConfirmation: true,
    },
    {
      id: 'pairing-ui',
      label: 'Pairing workspace route',
      detail: 'Visible Agent workspace route for companion pairing and channel setup.',
      effect: 'visible-navigation',
      command: '/agent channels',
      harnessRoute: 'agent_harness mode:"workspace_action" target:"pair"',
      capabilityIds: ['companion-pairing', 'mobile-command-routing'],
    },
    {
      id: 'connected-host-token-provisioning',
      label: 'Connected-host token provisioning',
      detail: 'Confirmed SDK-backed route that creates or repairs the local canonical connected-host token file without printing the raw token.',
      effect: 'confirmed-local-auth-provisioning',
      harnessRoute: 'setup action:"token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."',
      capabilityIds: ['connected-host-status', 'companion-pairing'],
      requiresConfirmation: true,
    },
    {
      id: 'connected-host-status',
      label: 'Connected host live posture',
      detail: 'Read-only reachability, token posture, and route readiness used before companion setup.',
      effect: 'read-only',
      harnessRoute: 'host action:"status"',
      capabilityIds: ['connected-host-status'],
    },
    {
      id: 'companion-capabilities',
      label: 'Companion capability map',
      detail: 'Allowed and blocked companion route families for pairing, shared sessions, tasks, approvals, provider/model changes, attachments, and mobile command surfaces.',
      effect: 'read-only',
      harnessRoute: 'host action:"capabilities"',
      capabilityIds: [
        'companion-pairing',
        'shared-session',
        'task-management',
        'approval-actions',
        'provider-model-routing',
        'attachment-upload',
        'mobile-command-routing',
      ],
    },
    {
      id: 'device-capability-map',
      label: 'Device capability map',
      detail: 'Read-only mobile, browser/PWA, voice, notification, browser/desktop, camera, screen, location, and device-command readiness map with honest setup and not-published states.',
      effect: 'read-only',
      harnessRoute: 'agent_harness mode:"pairing_posture" query:"device" includeParameters:true',
      capabilityIds: [
        'companion-pairing',
        'mobile-command-routing',
        'browser-cockpit-pwa',
        'voice-controls',
        'tts-spoken-responses',
        'notifications',
        'browser-desktop-control',
        'camera-location-sensors',
      ],
    },
    {
      id: 'channels-readiness',
      label: 'Channel readiness',
      detail: 'Read-only channel setup and delivery posture used after pairing when messages or reminders need an explicit delivery target.',
      effect: 'read-only',
      command: '/channels',
      harnessRoute: 'channels action:"status"',
      capabilityIds: ['channels', 'notifications'],
    },
  ];
}

function routeSearchText(route: PairingRoute): string {
  return [
    route.id,
    route.label,
    route.detail,
    route.effect,
    route.command ?? '',
    route.harnessRoute ?? '',
    ...(route.capabilityIds ?? []),
  ].join('\n').toLowerCase();
}

function routeMatches(route: PairingRoute, query: string): boolean {
  if (!query) return true;
  const text = routeSearchText(route);
  if (text.includes(query)) return true;
  const tokens = query.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

function describeCandidate(route: PairingRoute): Record<string, unknown> {
  return {
    pairingRouteId: route.id,
    label: route.label,
    effect: route.effect,
    requiresConfirmation: route.requiresConfirmation === true,
    modelRoute: pairingRouteModelRoute(route),
  };
}

function describeRoute(route: PairingRoute, options: {
  readonly includeParameters?: boolean;
  readonly lookup?: Record<string, unknown>;
  readonly context?: CommandContext;
} = {}): Record<string, unknown> {
  return {
    pairingRouteId: route.id,
    label: route.label,
    ...(options.includeParameters ? { detail: route.detail } : { summary: previewHarnessText(route.detail) }),
    effect: route.effect,
    requiresConfirmation: route.requiresConfirmation === true,
    modelRoute: pairingRouteModelRoute(route),
    ...(options.includeParameters ? {
      ...(route.command ? { command: route.command } : {}),
      ...(route.harnessRoute ? { harnessRoute: route.harnessRoute } : {}),
      ...(route.capabilityIds ? { capabilityIds: route.capabilityIds } : {}),
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: route.effect,
        values: 'Pairing posture returns endpoint binding and token fingerprint only; raw companion tokens and QR payloads are never returned by this read-only mode.',
        mutation: 'Pairing display, manual token display, companion connection, channel sends, provider/model changes, approval actions, and attachment flows stay explicit visible user flows.',
      },
      modelAccess: {
        inspectPairing: 'agent_harness mode:"pairing_posture"',
        inspectRoute: 'agent_harness mode:"pairing_route"',
        connectedHostStatus: 'host action:"status"',
        connectedHostCapabilities: 'host action:"capabilities"',
        channels: 'channels action:"status"',
      },
    } : {}),
    ...(options.includeParameters && route.id === 'device-capability-map' && options.context ? {
      deviceCapabilityMap: buildDeviceCapabilityMap(options.context),
    } : {}),
  };
}

function pairingRouteModelRoute(route: PairingRoute): string {
  if (route.command === '/pair') return 'agent_harness mode:"run_command" command:"/pair"';
  if (route.command === '/pair --show-token --yes') return 'agent_harness mode:"run_command" command:"/pair --show-token --yes"';
  if (route.id === 'pairing-ui') return 'agent_harness mode:"workspace_action" target:"pair"';
  return previewHarnessText(route.harnessRoute ?? 'agent_harness mode:"pairing_route"');
}

function pairingState(context: CommandContext): Record<string, unknown> {
  const shellPaths = requireShellPaths(context);
  const configManager = requirePlatform(context).configManager;
  const tokenRecord = readConnectedHostOperatorToken(shellPaths.homeDirectory);
  const binding = resolveRuntimeEndpointBinding(configManager, 'controlPlane');
  const host = urlHostForBindHost(binding.host);
  return {
    surface: GOODVIBES_AGENT_PAIRING_SURFACE,
    endpoint: {
      endpointId: 'controlPlane',
      enabled: readConfigBoolean(context, 'controlPlane.enabled', false),
      bindHost: binding.host,
      advertisedHost: host,
      port: binding.port,
      url: `http://${host}:${binding.port}`,
    },
    token: {
      present: Boolean(tokenRecord.token),
      path: tokenRecord.path,
      fingerprint: tokenRecord.token ? `sha256:${connectedHostOperatorTokenFingerprint(tokenRecord.token)}` : null,
      rawValueReturned: false,
    },
    companionPayloadReturned: false,
  };
}

function tokenPresent(state: Record<string, unknown>): boolean {
  const token = state.token as { readonly present?: boolean } | undefined;
  return token?.present === true;
}

function endpointEnabled(state: Record<string, unknown>): boolean {
  const endpoint = state.endpoint as { readonly enabled?: boolean } | undefined;
  return endpoint?.enabled === true;
}

function deviceStatusRank(status: DeviceCapabilityStatus): number {
  if (status === 'attention') return 0;
  if (status === 'setup-needed') return 1;
  if (status === 'not-published') return 2;
  return 3;
}

function deviceCapabilitySearchText(capability: DeviceCapability): string {
  return [
    capability.id,
    capability.label,
    capability.domain,
    capability.status,
    capability.userOutcome,
    capability.summary,
    capability.nextStep,
    capability.modelRoute,
    capability.userRoute ?? '',
    ...(capability.setupRoutes ?? []),
    ...capability.capabilities,
  ].join('\n').toLowerCase();
}

function deviceCapabilityMatches(capability: DeviceCapability, query: string): boolean {
  if (!query) return true;
  const text = deviceCapabilitySearchText(capability);
  if (text.includes(query)) return true;
  const tokens = query.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

function queryRequestsWholeDeviceMap(query: string): boolean {
  if (!query) return true;
  const tokens = query.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  if (query === 'device' || query === 'mobile' || query === 'phone') return true;
  return tokens.includes('device') && (tokens.includes('capability') || tokens.includes('capabilities') || tokens.includes('map'));
}

function liveDeviceEvidence(records: ReturnType<typeof certifiedDeviceLiveRecords>): Record<string, unknown> | undefined {
  return records.length > 0 ? { certifiedLiveRecords: records.slice(0, 5) } : undefined;
}

function buildDeviceCapabilityMap(context: CommandContext): DeviceCapabilityMap {
  const state = pairingState(context);
  const hasToken = tokenPresent(state);
  const controlPlaneReady = endpointEnabled(state) && hasToken;
  const webEnabled = readConfigBoolean(context, 'web.enabled', false);
  const webBinding = resolveRuntimeEndpointBinding(requirePlatform(context).configManager, 'web');
  const webHost = urlHostForBindHost(webBinding.host);
  const webUrl = `http://${webHost}:${webBinding.port}`;
  const voiceEnabled = readConfigBoolean(context, 'ui.voiceEnabled', false);
  const voiceReadiness = buildAgentWorkspaceVoiceMediaReadiness({
    context,
    voiceProviders: context.platform.voiceProviderRegistry?.list() ?? [],
    mediaProviders: context.platform.mediaProviderRegistry?.list() ?? [],
  });
  const channels = buildAgentWorkspaceChannels(context);
  const readyChannels = channels.filter((channel) => channel.ready);
  const enabledChannels = channels.filter((channel) => channel.enabled);
  const notificationWebhookCount = readConfigStringArray(context, 'notifications.webhookUrls').length;
  const browserPosture = browserControlPosture(context);
  const liveDevice = deviceLiveReadModelSnapshot(context);
  const sensorRecords = certifiedDeviceLiveRecords(liveDevice, 'camera-location-sensors', ['camera', 'location', 'screen', 'device command', 'sensor']);
  const sensorReady = sensorRecords.length > 0;
  const ttsStatus: DeviceCapabilityStatus = voiceReadiness.selectedTtsProviderStatus === 'ready' && voiceReadiness.ttsVoiceConfigured
    ? 'ready'
    : voiceReadiness.selectedTtsProviderStatus === 'ready' || voiceReadiness.selectedTtsProviderStatus === 'registered'
      ? 'attention'
      : 'setup-needed';
  const notificationStatus: DeviceCapabilityStatus = readyChannels.length > 0 || notificationWebhookCount > 0
    ? 'ready'
    : enabledChannels.length > 0
      ? 'attention'
      : 'setup-needed';
  const capabilities: DeviceCapability[] = [
    {
      id: 'companion-pairing',
      label: 'Companion pairing',
      domain: 'companion',
      status: hasToken ? 'ready' : 'setup-needed',
      userOutcome: 'Pair a phone or companion surface without exposing the raw operator token in chat.',
      summary: hasToken
        ? 'A connected-host operator token is present; QR and manual setup still require visible confirmed routes.'
        : 'No connected-host operator token is present, so companion pairing needs local token provisioning first.',
      nextStep: hasToken
        ? 'Use /pair or inspect the QR/manual routes when the user asks to pair a companion.'
        : 'Provision connected-host auth, then return to QR pairing.',
      capabilities: ['QR pairing', 'manual setup fallback', 'token-safe handoff'],
      modelRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"qr-pairing"',
      userRoute: '/pair',
      setupRoutes: [
        'setup action:"item" setupItemId:"connected-host-auth"',
        'setup action:"token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."',
      ],
      evidence: {
        tokenPresent: hasToken,
        rawTokenReturned: false,
      },
      policy: 'Pairing display and raw-token fallback are visible, confirmation-gated user flows.',
    },
    {
      id: 'mobile-command-routing',
      label: 'Mobile command routing',
      domain: 'companion',
      status: controlPlaneReady ? 'ready' : endpointEnabled(state) ? 'attention' : 'setup-needed',
      userOutcome: 'Send commands from a companion surface into the same visible Agent control plane.',
      summary: controlPlaneReady
        ? 'Control-plane routing and operator auth are both configured.'
        : endpointEnabled(state)
          ? 'The control plane is enabled, but companion auth is not ready.'
          : 'The control plane is disabled, so mobile command routing is not reachable yet.',
      nextStep: controlPlaneReady
        ? 'Use connected-host status before accepting companion-originated work.'
        : 'Enable and authenticate the control plane before relying on mobile command routing.',
      capabilities: ['shared session routing', 'task handoff', 'approval handoff', 'provider/model routing'],
      modelRoute: 'host action:"status"',
      setupRoutes: [
        'host action:"service" endpointId:"controlPlane"',
        'setup action:"item" setupItemId:"connected-host-auth"',
      ],
      evidence: {
        controlPlaneEnabled: endpointEnabled(state),
        tokenPresent: hasToken,
      },
      policy: 'Companion-originated tasks, approvals, sends, and provider/model changes remain explicit visible routes.',
    },
    {
      id: 'browser-cockpit-pwa',
      label: 'Browser cockpit/PWA',
      domain: 'browser',
      status: webEnabled ? 'ready' : 'setup-needed',
      userOutcome: 'Use the connected-host browser cockpit from desktop or mobile without returning to the terminal.',
      summary: webEnabled
        ? `The connected-host web endpoint is enabled at ${webUrl}.`
        : 'The connected-host web endpoint is disabled, so the browser cockpit/PWA cannot open yet.',
      nextStep: webEnabled
        ? 'Open the connected browser cockpit when the user confirms a browser handoff.'
        : 'Inspect the web service endpoint and enable the host web surface only when the user wants browser access.',
      capabilities: ['responsive browser workspace', 'PWA route', 'mobile-friendly cockpit'],
      modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"connected-browser-cockpit" confirm:true explicitUserRequest:"..."',
      setupRoutes: [
        'agent_harness mode:"ui_surface" surfaceId:"connected-browser-cockpit"',
        'host action:"service" endpointId:"web"',
      ],
      evidence: {
        webEnabled,
        webEndpoint: webEnabled ? webUrl : null,
      },
      policy: 'Opening external browser surfaces is confirmation-gated and never mutates host state by inspection alone.',
    },
    {
      id: 'voice-controls',
      label: 'Voice controls',
      domain: 'voice',
      status: voiceEnabled && voiceReadiness.readyVoiceProviderCount > 0 ? 'ready' : voiceEnabled ? 'attention' : 'setup-needed',
      userOutcome: 'Talk to the assistant through an intentionally enabled voice surface.',
      summary: voiceEnabled
        ? `${voiceReadiness.readyVoiceProviderCount}/${voiceReadiness.voiceProviders.length} voice provider(s) are ready.`
        : 'The voice surface is disabled.',
      nextStep: voiceEnabled
        ? 'Review media posture for provider or voice setup blockers before claiming hands-free use.'
        : 'Enable voice only after the user asks for spoken or push-to-talk interaction.',
      capabilities: ['voice surface toggle', 'push-to-talk setup posture', 'provider readiness'],
      modelRoute: 'agent_harness mode:"media_posture" query:"voice" includeParameters:true',
      setupRoutes: [
        'settings action:"get" query:"ui.voiceEnabled" includeParameters:true',
        'agent_harness mode:"media_posture" query:"voice" includeParameters:true',
      ],
      evidence: {
        voiceSurfaceEnabled: voiceEnabled,
        readyVoiceProviders: voiceReadiness.readyVoiceProviderCount,
        totalVoiceProviders: voiceReadiness.voiceProviders.length,
      },
      policy: 'Voice enablement and provider changes stay visible settings or media-provider flows.',
    },
    {
      id: 'tts-spoken-responses',
      label: 'Spoken responses',
      domain: 'voice',
      status: ttsStatus,
      userOutcome: 'Hear assistant responses with a predictable provider and voice.',
      summary: `${voiceReadiness.selectedTtsProviderLabel} is ${voiceReadiness.selectedTtsProviderStatus}; voice configured=${voiceReadiness.ttsVoiceConfigured ? 'yes' : 'no'}.`,
      nextStep: ttsStatus === 'ready'
        ? 'Use explicit TTS routes when the user asks for spoken output.'
        : 'Choose a ready TTS provider and voice before presenting spoken replies as ready.',
      capabilities: ['TTS provider selection', 'voice picker', 'spoken reply route'],
      modelRoute: 'agent_harness mode:"media_posture" query:"tts" includeParameters:true',
      setupRoutes: [
        'agent_harness mode:"open_ui_surface" surfaceId:"tts-provider-picker" confirm:true explicitUserRequest:"..."',
        'agent_harness mode:"open_ui_surface" surfaceId:"tts-voice-picker" confirm:true explicitUserRequest:"..."',
      ],
      evidence: {
        selectedTtsProviderStatus: voiceReadiness.selectedTtsProviderStatus,
        ttsVoiceConfigured: voiceReadiness.ttsVoiceConfigured,
      },
      policy: 'Spoken replies and TTS setting changes require explicit user-visible routes.',
    },
    {
      id: 'notifications',
      label: 'Notifications and delivery',
      domain: 'delivery',
      status: notificationStatus,
      userOutcome: 'Receive completion/status messages through a chosen channel without hidden sends.',
      summary: `${readyChannels.length}/${channels.length} channel(s) ready; ${notificationWebhookCount} notification webhook target(s) configured.`,
      nextStep: notificationStatus === 'ready'
        ? 'Use explicit confirmed send/test routes only for the channel the user chose.'
        : enabledChannels.length > 0
          ? 'Finish setup for enabled channels before relying on notifications.'
          : 'Choose one notification channel intentionally, then configure only that surface.',
      capabilities: ['channel delivery', 'desktop notification posture', 'webhook notification posture'],
      modelRoute: 'channels action:"setup"',
      userRoute: '/channels',
      setupRoutes: [
        'channels action:"status" includeParameters:true',
        'channels action:"setup"',
        'agent_harness mode:"notifications"',
      ],
      evidence: {
        readyChannels: readyChannels.length,
        enabledChannels: enabledChannels.length,
        notificationWebhookTargets: notificationWebhookCount,
      },
      policy: 'Delivery tests and outbound messages require explicit confirmed user action.',
    },
    {
      id: 'browser-desktop-control',
      label: 'Browser and desktop control',
      domain: 'desktop',
      status: browserPosture.status,
      userOutcome: 'Control browser, screen, or desktop surfaces only through trusted configured tools.',
      summary: browserPosture.configured
        ? 'A browser/desktop control route is configured.'
        : browserPosture.needsReview
          ? 'Browser/desktop tooling exists but needs trust or schema review.'
          : 'No trusted browser/desktop control route is configured.',
      nextStep: browserPosture.recommendedRoute,
      capabilities: ['browser navigation', 'screenshot/screen observation', 'desktop control'],
      modelRoute: browserPosture.recommendedRoute,
      setupRoutes: [
        browserPosture.setupRoute,
        'execution action:"status" query:"browser desktop" includeParameters:true',
      ],
      evidence: {
        declaredControlTools: browserPosture.declaredControlTools,
        mcpServers: browserPosture.mcpServers.length,
      },
      policy: browserPosture.policy,
    },
    {
      id: 'camera-location-sensors',
      label: 'Camera, screen, and location sensors',
      domain: 'device',
      status: sensorReady ? 'ready' : 'not-published',
      userOutcome: 'Use phone camera, screen, location, or local device commands only after the daemon/companion publishes permission-scoped records.',
      summary: sensorReady
        ? 'The SDK/daemon published certified permission-scoped camera, screen, location, or device-command capability records.'
        : 'Camera, screen, location, and device-command adapters are not published by the current Agent-visible SDK/daemon contract.',
      nextStep: sensorReady
        ? 'Inspect the certified device record and use only its returned confirmed permission/control routes.'
        : 'Inspect operator methods for newly published camera/location/screen contracts before claiming device access.',
      capabilities: [
        'camera permission posture',
        'screen capture permission posture',
        'location permission posture',
        'local device command routes',
        ...sensorRecords.flatMap((record) => record.capabilities),
      ],
      modelRoute: sensorRecords[0]?.modelRoute ?? 'host action:"methods" query:"camera location device"',
      setupRoutes: [
        ...sensorRecords.slice(0, 3).map((record) => record.modelRoute),
        'host action:"methods" query:"camera location device"',
        'host action:"capabilities" includeParameters:true',
      ],
      evidence: {
        publishedByCurrentAgentContract: sensorReady,
        liveDeviceRecords: liveDevice.capabilities.length,
        ...liveDeviceEvidence(sensorRecords),
      },
      policy: 'Agent reports unpublished device sensor APIs honestly and counts device access only when certified SDK/daemon permission-scoped records publish exact routes without raw payloads.',
    },
  ];
  capabilities.sort((left, right) => deviceStatusRank(left.status) - deviceStatusRank(right.status) || left.label.localeCompare(right.label));
  const counts = {
    ready: capabilities.filter((capability) => capability.status === 'ready').length,
    attention: capabilities.filter((capability) => capability.status === 'attention').length,
    setupNeeded: capabilities.filter((capability) => capability.status === 'setup-needed').length,
    notPublished: capabilities.filter((capability) => capability.status === 'not-published').length,
  };
  const primaryNextStep = capabilities.find((capability) => capability.status !== 'ready')?.nextStep
    ?? 'All published companion device capabilities are ready; use explicit confirmed routes for effects.';
  return {
    summary: {
      total: capabilities.length,
      ...counts,
      primaryNextStep,
    },
    capabilities,
    policy: 'Read-only device capability map. It does not pair devices, send notifications, open browsers, change voice settings, capture screens, or claim unpublished sensor APIs.',
  };
}

export function pairingPostureCatalogStatus(context: CommandContext): Record<string, unknown> {
  const state = pairingState(context);
  const deviceMap = buildDeviceCapabilityMap(context);
  return {
    modes: ['pairing_posture', 'pairing_route'],
    routes: pairingRoutes().length,
    tokenPresent: tokenPresent(state),
    deviceCapabilitySummary: deviceMap.summary,
    readOnly: true,
  };
}

export function pairingPostureSummary(context: CommandContext, args: AgentHarnessPairingArgs): Record<string, unknown> {
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const routes = pairingRoutes();
  const deviceMap = buildDeviceCapabilityMap(context);
  const limit = readLimit(args.limit, 100);
  const filtered = routes
    .filter((route) => routeMatches(route, query))
    .slice(0, limit);
  const includeWholeDeviceMap = queryRequestsWholeDeviceMap(query);
  const filteredCapabilities = deviceMap.capabilities
    .filter((capability) => includeWholeDeviceMap || deviceCapabilityMatches(capability, query))
    .slice(0, limit);
  return {
    status: 'available',
    summary: {
      deviceCapabilities: deviceMap.summary,
      returnedDeviceCapabilities: filteredCapabilities.length,
    },
    pairing: pairingState(context),
    deviceCapabilities: filteredCapabilities.map((capability) => includeParameters ? capability : {
      capabilityId: capability.id,
      label: capability.label,
      domain: capability.domain,
      status: capability.status,
      summary: previewHarnessText(capability.summary),
      modelRoute: capability.modelRoute,
    }),
    routes: filtered.map((route) => describeRoute(route, { includeParameters, context })),
    returned: filtered.length,
    total: routes.length,
    policy: `${deviceMap.policy} QR display, manual token display, companion connection, channel delivery, task, approval, provider/model, and attachment actions remain explicit visible user flows.`,
  };
}

export function describeHarnessPairingRoute(context: CommandContext, args: AgentHarnessPairingArgs): PairingResolution {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'pairing_route requires pairingRouteId, target, or query. Use mode:"pairing_posture" to inspect pairing route ids.',
    };
  }
  const routes = pairingRoutes();
  const normalized = lookup.input.toLowerCase();
  const exact = routes.find((route) => route.id === lookup.input);
  if (exact) return { status: 'found', route: describeRoute(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' }, context }) };
  const insensitive = routes.find((route) => route.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', route: describeRoute(insensitive, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' }, context }) };
  const searched = routes.filter((route) => routeMatches(route, normalized));
  if (searched.length === 1) return { status: 'found', route: describeRoute(searched[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' }, context }) };
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown pairing route ${lookup.input}. Use mode:"pairing_posture" to inspect pairing route ids.`,
  };
}
