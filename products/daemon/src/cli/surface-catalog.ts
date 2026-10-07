/** Pinned upstream names/setup vocabulary, used by standalone channel selection. */
export const SURFACE_CONFIGS = [
  ['slack', 'Slack', ['surfaces.slack.signingSecret', 'surfaces.slack.botToken']],
  ['discord', 'Discord', ['surfaces.discord.publicKey', 'surfaces.discord.botToken', 'surfaces.discord.applicationId']],
  ['telegram', 'Telegram', ['surfaces.telegram.botToken']],
  ['webhook', 'Webhook', ['surfaces.webhook.secret']],
  ['ntfy', 'ntfy', ['surfaces.ntfy.baseUrl']],
  ['googleChat', 'Google Chat', ['surfaces.googleChat.webhookUrl']],
  ['signal', 'Signal', ['surfaces.signal.bridgeUrl', 'surfaces.signal.account']],
  ['whatsapp', 'WhatsApp', ['surfaces.whatsapp.accessToken', 'surfaces.whatsapp.phoneNumberId']],
  ['imessage', 'iMessage', ['surfaces.imessage.bridgeUrl', 'surfaces.imessage.account']],
  ['msteams', 'Microsoft Teams', ['surfaces.msteams.appId', 'surfaces.msteams.appPassword']],
  ['bluebubbles', 'BlueBubbles', ['surfaces.bluebubbles.serverUrl', 'surfaces.bluebubbles.password']],
  ['mattermost', 'Mattermost', ['surfaces.mattermost.baseUrl', 'surfaces.mattermost.botToken']],
  ['matrix', 'Matrix', ['surfaces.matrix.homeserverUrl', 'surfaces.matrix.accessToken', 'surfaces.matrix.userId']],
] as const;
