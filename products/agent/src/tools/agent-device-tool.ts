import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';

type AgentDeviceAction =
  | 'status'
  | 'capability'
  | 'browser'
  | 'open_browser'
  | 'control'
  | 'voice'
  | 'provider'
  | 'open_tts_provider'
  | 'open_tts_voice';

interface AgentDeviceToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly capabilityId?: unknown;
  readonly routeId?: unknown;
  readonly pairingRouteId?: unknown;
  readonly mediaProviderId?: unknown;
  readonly providerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentDeviceToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeviceAction(value: unknown): AgentDeviceAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'map' || action === 'capabilities' || action === 'device' || action === 'devices' || action === 'mobile' || action === 'phone' || action === 'pairing') return 'status';
  if (action === 'capability' || action === 'route' || action === 'pairing_route' || action === 'show' || action === 'inspect') return 'capability';
  if (action === 'browser' || action === 'pwa' || action === 'cockpit' || action === 'browser_cockpit' || action === 'web') return 'browser';
  if (action === 'open' || action === 'open_browser' || action === 'open_pwa' || action === 'open_cockpit' || action === 'open_browser_cockpit') return 'open_browser';
  if (action === 'control' || action === 'browser_control' || action === 'desktop' || action === 'desktop_control' || action === 'computer_use') return 'control';
  if (action === 'voice' || action === 'media' || action === 'voice_media' || action === 'workflows') return 'voice';
  if (action === 'provider' || action === 'media_provider' || action === 'voice_provider') return 'provider';
  if (action === 'open_tts_provider' || action === 'tts_provider_picker') return 'open_tts_provider';
  if (action === 'open_tts_voice' || action === 'tts_voice_picker') return 'open_tts_voice';
  return null;
}

function readAction(args: AgentDeviceToolArgs): AgentDeviceAction {
  const explicit = normalizeDeviceAction(args.action) ?? normalizeDeviceAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.mediaProviderId) || readString(args.providerId)) return 'provider';
  if (readString(args.capabilityId) || readString(args.routeId) || readString(args.pairingRouteId)) return 'capability';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function capabilityLookup(args: AgentDeviceToolArgs): string {
  return readString(args.pairingRouteId)
    || readString(args.capabilityId)
    || readString(args.routeId)
    || readString(args.id);
}

function providerLookup(args: AgentDeviceToolArgs): string {
  return readString(args.mediaProviderId)
    || readString(args.providerId)
    || readString(args.id);
}

function confirmedArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

function statusArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'pairing_posture',
    query: args.query ?? args.target ?? 'device',
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function capabilityArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  const pairingRouteId = capabilityLookup(args);
  return compactArgs({
    mode: 'pairing_route',
    pairingRouteId,
    target: pairingRouteId ? undefined : args.target,
    query: pairingRouteId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function browserArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'ui_surface',
    surfaceId: 'connected-browser-cockpit',
    includeParameters: args.includeParameters ?? true,
  });
}

function openBrowserArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'open_ui_surface',
    surfaceId: 'connected-browser-cockpit',
    ...confirmedArgs(args),
  });
}

function controlArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'execution_route',
    executionRouteId: 'browser-or-desktop-control',
    includeParameters: args.includeParameters ?? true,
  });
}

function voiceArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'media_posture',
    query: args.query ?? args.target ?? 'voice',
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function providerArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  const mediaProviderId = providerLookup(args);
  return compactArgs({
    mode: 'media_provider',
    mediaProviderId,
    target: mediaProviderId ? undefined : args.target,
    query: mediaProviderId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function openTtsProviderArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'open_ui_surface',
    surfaceId: 'tts-provider-picker',
    ...confirmedArgs(args),
  });
}

function openTtsVoiceArgs(args: AgentDeviceToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'open_ui_surface',
    surfaceId: 'tts-voice-picker',
    target: readString(args.providerId) || readString(args.mediaProviderId) || args.target,
    ...confirmedArgs(args),
  });
}

export function createAgentDeviceTool(deps: AgentDeviceToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  return {
    definition: {
      name: 'device',
      description: 'Inspect/open device, voice, and browser routes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'capability', 'browser', 'open_browser', 'control', 'voice', 'provider', 'open_tts_provider', 'open_tts_voice'],
            description: 'Read device/browser/voice posture; confirm visible open actions.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Capability, route, or provider id alias.' },
          capabilityId: { type: 'string', description: 'Device capability id.' },
          routeId: { type: 'string', description: 'Pairing route id alias.' },
          pairingRouteId: { type: 'string', description: 'Pairing route id.' },
          mediaProviderId: { type: 'string', description: 'Voice/media provider id.' },
          providerId: { type: 'string', description: 'Voice/media provider id alias.' },
          target: { type: 'string', description: 'Lookup or provider target.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed route contracts.' },
          limit: { type: 'number', description: 'Maximum rows.' },
          confirm: { type: 'boolean', description: 'Required true for visible open actions.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing visible open actions.' },
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as AgentDeviceToolArgs;
      const action = readAction(args);

      if (action === 'status') return harnessTool.execute(statusArgs(args));
      if (action === 'capability') return harnessTool.execute(capabilityArgs(args));
      if (action === 'browser') return harnessTool.execute(browserArgs(args));
      if (action === 'open_browser') return harnessTool.execute(openBrowserArgs(args));
      if (action === 'control') return harnessTool.execute(controlArgs(args));
      if (action === 'voice') return harnessTool.execute(voiceArgs(args));
      if (action === 'provider') return harnessTool.execute(providerArgs(args));
      if (action === 'open_tts_provider') return harnessTool.execute(openTtsProviderArgs(args));
      if (action === 'open_tts_voice') return harnessTool.execute(openTtsVoiceArgs(args));

      return error('Unknown device action. Use action:"status" for the device capability map.');
    },
  };
}

export function registerAgentDeviceTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('device')) registry.register(createAgentDeviceTool({ commandRegistry, commandContext, toolRegistry: registry }));
}
