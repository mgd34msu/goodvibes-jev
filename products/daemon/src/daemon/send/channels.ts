/** Adapted from goodvibes-daemon 254699bf; explicit one-shot send contract. */
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ChannelDeliverySurfaceKind } from '@goodvibes-jev/engine/sdk/platform/channels';
import { SURFACE_CONFIGS } from '../../cli/surface-catalog.ts';
import { canRenderInert } from './inert-text.ts';

const DESTINATION_KEY_BY_SURFACE_ID = {
  telegram: 'surfaces.telegram.defaultChatId',
  ntfy: 'surfaces.ntfy.topic',
  discord: 'surfaces.discord.defaultChannelId',
  slack: 'surfaces.slack.defaultChannel',
  googleChat: 'surfaces.googleChat.webhookUrl',
  webhook: 'surfaces.webhook.defaultTarget',
  signal: 'surfaces.signal.defaultRecipient',
  whatsapp: 'surfaces.whatsapp.defaultRecipient',
  imessage: 'surfaces.imessage.defaultChatId',
  msteams: 'surfaces.msteams.defaultConversationId',
  bluebubbles: 'surfaces.bluebubbles.defaultChatGuid',
  mattermost: 'surfaces.mattermost.defaultChannelId',
  matrix: 'surfaces.matrix.defaultRoomId',
  // Not cast: every value is checked against the real ConfigKey union, so a
  // key that is renamed or misspelled in the schema fails the build here
  // instead of reading `undefined` at send time and reporting the channel as
  // unconfigured.
} as const satisfies Readonly<Record<string, ConfigKey>>;

const SURFACE_KIND_BY_ID: Readonly<Record<string, ChannelDeliverySurfaceKind>> = {
  googleChat: 'google-chat',
};

const ADDRESS_LABEL_BY_SURFACE_ID: Readonly<Record<string, string>> = {
  telegram: 'chat id',
  ntfy: 'topic',
  discord: 'channel id',
  slack: 'channel id',
  googleChat: 'webhook URL',
  webhook: 'URL',
  signal: 'recipient',
  whatsapp: 'recipient',
  imessage: 'chat id',
  msteams: 'conversation id',
  bluebubbles: 'chat GUID',
  mattermost: 'channel id',
  matrix: 'room id',
};

export interface SendChannel {
  readonly id: string;
  readonly label: string;
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  readonly enabledKey: ConfigKey;
  readonly destinationKey: ConfigKey;
  readonly addressLabel: string;
}

const destinationKeys: Readonly<Record<string, ConfigKey>> = DESTINATION_KEY_BY_SURFACE_ID;

export const SEND_CHANNELS: readonly SendChannel[] = SURFACE_CONFIGS
  .flatMap(([id, label]): SendChannel[] => {
    const destinationKey = destinationKeys[id];
    if (!destinationKey) return [];
    const surfaceKind = SURFACE_KIND_BY_ID[id] ?? (id as ChannelDeliverySurfaceKind);
    if (!canRenderInert(surfaceKind)) return [];
    return [{
      id,
      label,
      surfaceKind,
      enabledKey: `surfaces.${id}.enabled` as ConfigKey,
      destinationKey,
      addressLabel: ADDRESS_LABEL_BY_SURFACE_ID[id] ?? 'address',
    }];
  });

export function findSendChannel(name: string): SendChannel | undefined {
  const wanted = name.trim().toLowerCase();
  return SEND_CHANNELS.find((channel) =>
    channel.id.toLowerCase() === wanted || channel.surfaceKind.toLowerCase() === wanted);
}

export interface ChannelReadiness {
  readonly channel: SendChannel;
  readonly enabled: boolean;
  readonly destination: string | null;
}

function readSetting(config: Pick<ConfigManager, 'get'>, key: ConfigKey): string {
  const value = config.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

export function readChannelReadiness(config: Pick<ConfigManager, 'get'>): readonly ChannelReadiness[] {
  return SEND_CHANNELS.map((channel) => {
    const destination = readSetting(config, channel.destinationKey);
    return {
      channel,
      enabled: config.get(channel.enabledKey) === true,
      destination: destination.length > 0 ? destination : null,
    };
  });
}

export type DefaultChannelResolution =
  | { readonly kind: 'resolved'; readonly channel: SendChannel; readonly destination: string; readonly reason: string }
  | { readonly kind: 'none'; readonly candidates: readonly ChannelReadiness[] }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ChannelReadiness[] };

export function resolveDefaultChannel(config: Pick<ConfigManager, 'get'>): DefaultChannelResolution {
  const readiness = readChannelReadiness(config);
  const qualifying = readiness.filter((entry) => entry.enabled && entry.destination !== null);
  if (qualifying.length === 1) {
    const only = qualifying[0]!;
    return {
      kind: 'resolved',
      channel: only.channel,
      destination: only.destination!,
      reason: 'the only channel that is switched on and has a destination configured',
    };
  }
  if (qualifying.length === 0) return { kind: 'none', candidates: readiness };
  return { kind: 'ambiguous', candidates: qualifying };
}
