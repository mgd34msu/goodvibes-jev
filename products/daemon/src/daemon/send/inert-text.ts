/** Adapted from goodvibes-daemon 254699bf; explicit one-shot send contract. */
import type { ChannelDeliverySurfaceKind } from '@goodvibes-jev/engine/sdk/platform/channels';

const ZERO_WIDTH_SPACE = '​';

function breakMentionForms(text: string): string {
  return text
    .replace(/@(everyone|here)/g, (_match, word: string) => `@${ZERO_WIDTH_SPACE}${word}`)
    .replace(/<@[!&]?(\d+)>/g, (_match, id: string) => `<@${ZERO_WIDTH_SPACE}${id}>`)
    .replace(/<#(\d+)>/g, (_match, id: string) => `<#${ZERO_WIDTH_SPACE}${id}>`);
}

function escapeDiscordMarkdown(text: string): string {
  return breakMentionForms(text.replace(/[*_~`|>[\]()\\]/g, (ch) => `\\${ch}`));
}

function escapeSlackMrkdwn(text: string): string {
  const entityEscaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return entityEscaped.replace(/[*_~`]/g, (ch) => `${ch}${ZERO_WIDTH_SPACE}`);
}

function escapeGoogleChatMarkup(text: string): string {
  const entityEscaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return entityEscaped.replace(/[*_~`]/g, (ch) => `${ch}${ZERO_WIDTH_SPACE}`);
}

function escapeWhatsAppMarkup(text: string): string {
  return text.replace(/[*_~`]/g, (ch) => `${ch}${ZERO_WIDTH_SPACE}`);
}

const INERT_TRANSFORMS: Partial<Record<ChannelDeliverySurfaceKind, (text: string) => string>> = {
  // Renders markup, including a masked link: full escaping.
  discord: escapeDiscordMarkdown,
  mattermost: escapeDiscordMarkdown,
  // Renders markup, but has no masked-link syntax: delimiters only.
  slack: escapeSlackMrkdwn,
  'google-chat': escapeGoogleChatMarkup,
  whatsapp: escapeWhatsAppMarkup,
  // Delivered as plain text by the strategy: transforming would corrupt, not
  // protect. These strategies use plain text, JSON text fields, or an explicit
  // plain-text transport flag. Client-side URL auto-linking remains possible.
  telegram: (text) => text,
  ntfy: (text) => text,
  webhook: (text) => text,
  signal: (text) => text,
  imessage: (text) => text,
  bluebubbles: (text) => text,
  msteams: (text) => text,
  matrix: (text) => text,
};

export const INERT_RENDERABLE_SURFACE_KINDS: readonly ChannelDeliverySurfaceKind[] = [
  'telegram', 'ntfy', 'discord', 'slack', 'google-chat', 'webhook',
  'signal', 'whatsapp', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
];

export function canRenderInert(surfaceKind: ChannelDeliverySurfaceKind): boolean {
  return Object.prototype.hasOwnProperty.call(INERT_TRANSFORMS, surfaceKind);
}

export function inertBodyFor(surfaceKind: ChannelDeliverySurfaceKind, text: string): string {
  const transform = canRenderInert(surfaceKind) ? INERT_TRANSFORMS[surfaceKind] : undefined;
  if (!transform) {
    throw new Error(
      `No verified inert-text transform for surface '${surfaceKind}'. `
      + 'Sending would risk the message being rendered as markup rather than as text, '
      + `so nothing was sent. Supported: ${INERT_RENDERABLE_SURFACE_KINDS.join(', ')}.`,
    );
  }
  return transform(text);
}
