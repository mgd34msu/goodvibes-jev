/**
 * calendar-connect-runtime.ts, the /calendar connect|disconnect|accounts subcommands
 * and the provider-event merge for /calendar upcoming.
 *
 * The OAuth network dance lives here (not in the workspace card) because a command
 * handler can print the authorization URL / device user-code IMMEDIATELY, then await
 * the browser callback or poll the device code. The default path uses the bundled
 * project client id + PKCE; a power user's own client id/secret come from config +
 * the secret manager (captured by the advanced workspace card). No secret is ever put
 * into a command string.
 *
 * The service is injectable so tests drive every path against fakes with no real
 * network, port, or browser.
 */
import type { CalendarProviderId, DeviceCodeFlowStart, EventWindow, MergedCalendarEvent } from '@goodvibes-jev/engine/sdk/platform/calendar';
import type { CommandContext } from '../command-registry.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { CalendarOAuthService, type CalendarConfigReader, type CalendarSecretSlice } from '../../agent/calendar/calendar-oauth-service.ts';

/** Factory seam: production builds the real service from context; tests inject a fake. */
export type CalendarServiceFactory = (ctx: CommandContext) => CalendarOAuthService;

const PROVIDER_LABEL: Record<CalendarProviderId, string> = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };

const CONNECTION_STATE_NOTE: Record<string, string> = {
  connected: 'connected',
  'refresh-due': 'connected (token refresh due)',
  'reconnect-needed': 'reconnect needed, run the connect command again',
  disconnected: 'disconnected',
};

/** Map the user's provider word to a provider id ('outlook' and 'microsoft' both ok). */
export function normalizeProvider(word: string | undefined): CalendarProviderId | null {
  const w = (word ?? '').trim().toLowerCase();
  if (w === 'google' || w === 'gcal') return 'google';
  if (w === 'outlook' || w === 'microsoft' || w === 'ms' || w === 'msft') return 'microsoft';
  return null;
}

function defaultServiceFactory(ctx: CommandContext): CalendarOAuthService {
  const config = ctx.platform.configManager as unknown as CalendarConfigReader;
  const secrets = requireSecretsManager(ctx) as unknown as CalendarSecretSlice;
  return new CalendarOAuthService({ config, secrets });
}

function deviceCodeMessage(label: string, start: DeviceCodeFlowStart): string {
  return [
    `Authorize ${label} on another device or browser:`,
    `  1. Open ${start.verificationUri}`,
    `  2. Enter the code: ${start.userCode}`,
    start.verificationUriComplete ? `  (or open directly: ${start.verificationUriComplete})` : '',
    '  Waiting for approval...',
  ].filter(Boolean).join('\n');
}

function authUrlMessage(label: string, url: string): string {
  return [
    `Authorize ${label} in your browser:`,
    `  ${url}`,
    '  (Attempting to open it automatically. Waiting for the redirect...)',
  ].join('\n');
}

/**
 * The real guide for a bare `/calendar connect` (F1a): what connecting does, the
 * two providers, and, since this build ships only the SDK's placeholder client
 * ids until someone registers a project app, the honest situation and the exact
 * next step, instead of a bare usage line that dead-ends with no explanation.
 */
function connectGuideMessage(): string {
  return [
    'Connect a calendar account over OAuth so its events show up alongside your local ones in /calendar upcoming.',
    '  Providers: google (Google Calendar), outlook (Microsoft Outlook)',
    '    /calendar connect google',
    '    /calendar connect outlook',
    '    (add --device to sign in with a device code instead of a browser)',
    '',
    'This build has no built-in Google/Microsoft sign-in configured yet, there is no project ' +
      'client id shipped, so a bare connect will stop at the config step and tell you so. To ' +
      'connect, you need a client id:',
    '  1. Register a free OAuth app with the provider (Google Cloud Console, or the Azure portal for Microsoft).',
    '  2. Copy the client id it gives you, a desktop/public-client app needs no secret.',
    '  3. Open /agent personal-ops -> "Connect Google Calendar (advanced)" or "Connect Microsoft Outlook (advanced)" and paste it in.',
    '  4. Run /calendar connect google (or outlook) again to authorize.',
  ].join('\n');
}

/** An unrecognized provider word (not a missing one) keeps the short usage form. */
function unknownProviderMessage(word: string): string {
  return `Unknown calendar provider '${word}'. Usage: /calendar connect <google|outlook> [--device]`;
}

/** Best-effort browser open; never throws, never blocks the flow. */
function bestEffortOpenBrowser(url: string): void {
  void (async () => {
    try {
      const { spawn } = await import('node:child_process');
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      const child = spawn(opener, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } catch {
      // ignore, the URL was already printed for the user to open manually
    }
  })();
}

export async function runCalendarConnect(
  args: readonly string[],
  ctx: CommandContext,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<void> {
  const provider = normalizeProvider(args[1]);
  if (!provider) {
    ctx.print(args[1] ? unknownProviderMessage(args[1]) : connectGuideMessage());
    return;
  }
  const label = PROVIDER_LABEL[provider];
  const device = args.includes('--device');
  const service = factory(ctx);

  ctx.print(`Connecting ${label}...`);
  const result = device
    ? await service.connectDeviceCode(provider, { onDeviceCode: (s) => ctx.print(deviceCodeMessage(label, s)) })
    : await service.connectAuto(provider, {
        openUrl: (url) => {
          ctx.print(authUrlMessage(label, url));
          bestEffortOpenBrowser(url);
        },
        onDeviceCode: (s) => ctx.print(deviceCodeMessage(label, s)),
      });

  if (!result.ok) {
    ctx.print([
      `Could not connect ${label} (${result.stage ?? 'unknown'} stage).`,
      `  ${result.error ?? 'unknown error'}`,
    ].join('\n'));
    return;
  }
  ctx.print([
    `Connected ${label}.`,
    `  account ${result.account?.label ?? provider}`,
    `  via     ${result.transport === 'device-code' ? 'device code' : 'browser sign-in'}`,
    `  scopes  ${(result.account?.scopes ?? []).join(', ') || '(none reported)'}`,
  ].join('\n'));
}

export async function runCalendarDisconnect(
  args: readonly string[],
  ctx: CommandContext,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<void> {
  const provider = normalizeProvider(args[1]);
  if (!provider) {
    ctx.print('Usage: /calendar disconnect <google|outlook>');
    return;
  }
  const label = PROVIDER_LABEL[provider];
  const service = factory(ctx);
  const { revokedRemotely } = await service.disconnect(provider);
  ctx.print([
    `Disconnected ${label}.`,
    revokedRemotely
      ? '  The access was revoked at the provider and local tokens were cleared.'
      : '  Local tokens were cleared. This provider offers no token-revocation endpoint, so revoke access in your account settings if desired.',
  ].join('\n'));
}

export async function runCalendarAccounts(
  ctx: CommandContext,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<void> {
  const service = factory(ctx);
  const accounts = await service.listAccounts();
  if (accounts.length === 0) {
    ctx.print([
      'Connected calendar accounts',
      '  None. Connect one with /calendar connect google  or  /calendar connect outlook',
    ].join('\n'));
    return;
  }
  ctx.print([
    `Connected calendar accounts (${accounts.length})`,
    ...accounts.map(({ account, state }) =>
      `  ${PROVIDER_LABEL[account.provider]}  ${account.label}  [${CONNECTION_STATE_NOTE[state] ?? state}]`,
    ),
  ].join('\n'));
}

/**
 * Best-effort fetch of provider events for the upcoming window, source-labeled. A
 * provider failure (reconnect needed, rate limit, etc.) is reported as an honest note
 * rather than aborting the whole /calendar upcoming view.
 */
export async function fetchProviderUpcoming(
  ctx: CommandContext,
  window: EventWindow,
  factory: CalendarServiceFactory = defaultServiceFactory,
): Promise<{ readonly events: MergedCalendarEvent[]; readonly notes: string[] }> {
  const service = factory(ctx);
  const accounts = await service.listAccounts();
  if (accounts.length === 0) return { events: [], notes: [] };
  const events: MergedCalendarEvent[] = [];
  const notes: string[] = [];
  for (const { account } of accounts) {
    try {
      const config = await service.resolveConfig(account.provider);
      const providerEvents = await service.listEventsForProvider(config, window);
      events.push(...providerEvents);
    } catch (error) {
      notes.push(`  ${PROVIDER_LABEL[account.provider]}: could not load events, ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { events, notes };
}

/** Render a source label for a merged event. */
export function sourceLabel(source: MergedCalendarEvent['source']): string {
  switch (source) {
    case 'google-api': return 'google';
    case 'microsoft-graph': return 'outlook';
    case 'ics-feed': return 'feed';
    default: return 'local';
  }
}
