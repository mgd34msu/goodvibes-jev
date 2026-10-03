import type { CommandContext } from './command-registry.ts';
import { getAgentWorkspaceConfigReader } from './agent-workspace-config-reader.ts';

export type AgentWorkspaceVoiceMediaDomain = 'voice' | 'media';
export type AgentWorkspaceVoiceMediaSetupState = 'ready' | 'registered' | 'needs-secret' | 'not-registered';

export interface AgentWorkspaceVoiceMediaProviderDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly capabilities: readonly string[];
}

export interface AgentWorkspaceVoiceMediaProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly domain: AgentWorkspaceVoiceMediaDomain;
  readonly features: readonly string[];
  readonly setupState: AgentWorkspaceVoiceMediaSetupState;
  readonly selected: boolean;
  readonly secretKeyOptions: readonly string[];
  readonly configuredSecretKeys: readonly string[];
  readonly missingSecretKeyOptions: readonly string[];
  readonly nextStep: string;
}

export interface AgentWorkspaceVoiceMediaReadiness {
  readonly voiceProviders: readonly AgentWorkspaceVoiceMediaProviderStatus[];
  readonly mediaProviders: readonly AgentWorkspaceVoiceMediaProviderStatus[];
  readonly readyVoiceProviderCount: number;
  readonly readyMediaProviderCount: number;
  readonly selectedTtsProviderStatus: AgentWorkspaceVoiceMediaSetupState;
  readonly selectedTtsProviderLabel: string;
  readonly ttsVoiceConfigured: boolean;
  readonly ttsResponseRouteConfigured: boolean;
  readonly browserToolState: 'disabled' | 'local-only' | 'public-url';
  readonly browserToolNextStep: string;
  readonly nextSteps: readonly string[];
}

type ProviderSecretSpec = {
  readonly id: string;
  readonly secretKeyOptions: readonly string[];
  readonly noSecretRequired?: boolean;
};

const VOICE_SECRET_SPECS: readonly ProviderSecretSpec[] = [
  { id: 'openai', secretKeyOptions: ['OPENAI_API_KEY', 'OPENAI_KEY'] },
  { id: 'deepgram', secretKeyOptions: ['DEEPGRAM_API_KEY'] },
  { id: 'google', secretKeyOptions: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'] },
  { id: 'elevenlabs', secretKeyOptions: ['ELEVENLABS_API_KEY', 'XI_API_KEY'] },
  { id: 'microsoft', secretKeyOptions: [], noSecretRequired: true },
  { id: 'vydra', secretKeyOptions: ['VYDRA_API_KEY'] },
];

const MEDIA_SECRET_SPECS: readonly ProviderSecretSpec[] = [
  { id: 'builtin:image-understanding', secretKeyOptions: [], noSecretRequired: true },
  { id: 'byteplus', secretKeyOptions: ['BYTEPLUS_API_KEY'] },
  { id: 'runway', secretKeyOptions: ['RUNWAY_API_KEY', 'RUNWAYML_API_SECRET'] },
  { id: 'alibaba', secretKeyOptions: ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'] },
  { id: 'fal', secretKeyOptions: ['FAL_KEY', 'FAL_API_KEY'] },
  { id: 'comfy', secretKeyOptions: ['COMFY_BASE_URL', 'COMFY_API_KEY'] },
];

function readConfigString(context: CommandContext, key: string, fallback: string): string {
  try {
    const configManager = getAgentWorkspaceConfigReader(context);
    const value = configManager?.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  } catch {
    return fallback;
  }
}

function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  try {
    const configManager = getAgentWorkspaceConfigReader(context);
    const value = configManager?.get(key);
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

function configuredSecretKeys(options: readonly string[]): readonly string[] {
  return options.filter((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function specFor(domain: AgentWorkspaceVoiceMediaDomain, id: string): ProviderSecretSpec {
  const specs = domain === 'voice' ? VOICE_SECRET_SPECS : MEDIA_SECRET_SPECS;
  return specs.find((entry) => entry.id === id) ?? { id, secretKeyOptions: [] };
}

function providerLabel(provider: AgentWorkspaceVoiceMediaProviderDescriptor): string {
  return typeof provider.label === 'string' && provider.label.trim().length > 0 ? provider.label.trim() : provider.id;
}

function buildProviderStatus(
  domain: AgentWorkspaceVoiceMediaDomain,
  provider: AgentWorkspaceVoiceMediaProviderDescriptor,
  selectedProviderId: string,
): AgentWorkspaceVoiceMediaProviderStatus {
  const spec = specFor(domain, provider.id);
  const configured = configuredSecretKeys(spec.secretKeyOptions);
  const selected = selectedProviderId === provider.id;
  const setupState: AgentWorkspaceVoiceMediaSetupState = spec.noSecretRequired || configured.length > 0
    ? 'ready'
    : spec.secretKeyOptions.length > 0
      ? 'needs-secret'
      : 'registered';
  const label = providerLabel(provider);
  const nextStep = setupState === 'ready'
    ? `${label} is ready for explicit Agent voice/media use.`
    : setupState === 'needs-secret'
      ? `Configure one of ${spec.secretKeyOptions.join('|')} in the owning GoodVibes host environment.`
      : `${label} is registered; confirm any provider-specific setup in the owning GoodVibes host.`;
  return {
    id: provider.id,
    label,
    domain,
    features: provider.capabilities,
    setupState,
    selected,
    secretKeyOptions: spec.secretKeyOptions,
    configuredSecretKeys: configured,
    missingSecretKeyOptions: configured.length > 0 || spec.noSecretRequired ? [] : spec.secretKeyOptions,
    nextStep,
  };
}

function missingSelectedProviderStatus(selectedProviderId: string): AgentWorkspaceVoiceMediaProviderStatus {
  return {
    id: selectedProviderId,
    label: selectedProviderId,
    domain: 'voice',
    features: [],
    setupState: 'not-registered',
    selected: true,
    secretKeyOptions: [],
    configuredSecretKeys: [],
    missingSecretKeyOptions: [],
    nextStep: `Selected TTS provider ${selectedProviderId} is not registered by the connected GoodVibes host.`,
  };
}

function selectedProviderStatus(
  providers: readonly AgentWorkspaceVoiceMediaProviderStatus[],
  selectedProviderId: string,
): AgentWorkspaceVoiceMediaProviderStatus {
  return providers.find((provider) => provider.id === selectedProviderId) ?? missingSelectedProviderStatus(selectedProviderId);
}

function browserToolState(context: CommandContext): AgentWorkspaceVoiceMediaReadiness['browserToolState'] {
  if (!readConfigBoolean(context, 'web.enabled', false)) return 'disabled';
  const publicBaseUrl = readConfigString(context, 'web.publicBaseUrl', '');
  return publicBaseUrl ? 'public-url' : 'local-only';
}

function browserToolNextStep(state: AgentWorkspaceVoiceMediaReadiness['browserToolState']): string {
  if (state === 'disabled') return 'Inspect MCP browser/automation tools; enable browser access in the owning GoodVibes host only when needed.';
  if (state === 'local-only') return 'Browser tooling is local-only; keep external exposure off unless explicitly configured.';
  return 'Public browser URL is configured; use explicit user action and Agent policy before browser-side effects.';
}

export function buildAgentWorkspaceVoiceMediaReadiness(options: {
  readonly context: CommandContext;
  readonly voiceProviders: readonly AgentWorkspaceVoiceMediaProviderDescriptor[];
  readonly mediaProviders: readonly AgentWorkspaceVoiceMediaProviderDescriptor[];
}): AgentWorkspaceVoiceMediaReadiness {
  const selectedTtsProviderId = readConfigString(options.context, 'tts.provider', '');
  const ttsVoice = readConfigString(options.context, 'tts.voice', '');
  const ttsLlmProvider = readConfigString(options.context, 'tts.llmProvider', '');
  const ttsLlmModel = readConfigString(options.context, 'tts.llmModel', '');
  const voiceProviders = options.voiceProviders.map((provider) => buildProviderStatus('voice', provider, selectedTtsProviderId));
  const mediaProviders = options.mediaProviders.map((provider) => buildProviderStatus('media', provider, ''));
  const selectedStatus = selectedTtsProviderId
    ? selectedProviderStatus(voiceProviders, selectedTtsProviderId)
    : {
        ...missingSelectedProviderStatus('(provider default)'),
        setupState: 'registered' as const,
        nextStep: 'Choose a TTS provider when live speech should be predictable.',
      };
  const browserState = browserToolState(options.context);
  const nextSteps = [
    selectedStatus.setupState === 'needs-secret' ? selectedStatus.nextStep : '',
    !ttsVoice ? 'Choose a stable TTS voice for day-one spoken replies.' : '',
    mediaProviders.some((provider) => provider.features.includes('generate') && provider.setupState === 'needs-secret')
      ? 'Configure at least one media generation provider secret before image/video generation.'
      : '',
    browserToolNextStep(browserState),
  ].filter((step) => step.length > 0);
  return {
    voiceProviders,
    mediaProviders,
    readyVoiceProviderCount: voiceProviders.filter((provider) => provider.setupState === 'ready').length,
    readyMediaProviderCount: mediaProviders.filter((provider) => provider.setupState === 'ready').length,
    selectedTtsProviderStatus: selectedStatus.setupState,
    selectedTtsProviderLabel: selectedStatus.label,
    ttsVoiceConfigured: ttsVoice.length > 0,
    ttsResponseRouteConfigured: ttsLlmProvider.length > 0 && ttsLlmModel.length > 0,
    browserToolState: browserState,
    browserToolNextStep: browserToolNextStep(browserState),
    nextSteps,
  };
}
