/**
 * Calendar OAuth advanced-credentials wizard.
 *
 * The DEFAULT connect experience needs no card at all: `/calendar connect google`
 * (or `outlook`) uses the bundled project client id + PKCE and opens the browser.
 * This card is the ADVANCED override for power users who register their own app: it
 * captures a client id and (optionally) a client secret, stores them the same way
 * every other Agent credential is stored (id in config, secret through the secret
 * manager, never in plain config, never in a command string), then directs the user
 * to run the connect command to authorize.
 *
 * Security: like the email connect wizard, this is a DIRECT host action, not a slash
 * command, the client secret never travels through the command-dispatch pipeline
 * that echoes the command string into the rendered result. The OAuth network dance
 * (auth URL / device code) lives in the /calendar connect command, which can print
 * the URL/code immediately; this card only persists credentials.
 */
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { requireSecretsManager } from './commands/runtime-services.ts';
import { persistSecretBackedConfigValue } from '../config/secret-config.ts';
import type { ConfigKey } from '../config/index.ts';
import {
  CALENDAR_OAUTH_CLIENT_ID_KEYS,
  CALENDAR_OAUTH_CLIENT_SECRET_KEYS,
} from '../agent/calendar/calendar-oauth-service.ts';
import { ensureCalendarConfigDefaults } from '@goodvibes-jev/engine/sdk/platform/config';
import type { AgentWorkspaceActionResult, AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type FieldReader = (id: string) => string;
type Provider = 'google' | 'microsoft';

export interface AgentWorkspaceCalendarOAuthEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
}

/** Honest, no-I/O calendar-OAuth build state per provider, true once a client id override is stored (F1c). */
export interface AgentWorkspaceCalendarOAuthConfigStatus {
  readonly google: boolean;
  readonly microsoft: boolean;
}

const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };
const CONNECT_HINT: Record<Provider, string> = { google: '/calendar connect google', microsoft: '/calendar connect outlook' };

/**
 * Build-state-aware card message (F1c): while the build still ships only the
 * bundled SDK placeholder client id, /calendar connect always fails at the
 * config stage, so the old "most people can skip this" wording was a dead
 * end. Once a client id has been stored (through this same card), the
 * original skip-this-if-you-don't-need-it wording applies again.
 */
function cardMessage(label: string, isConfigured: boolean): string {
  if (!isConfigured) {
    return (
      `This build needs a client id to connect ${label}, it ships no project default yet. ` +
      'Enter your own below, or follow these steps: register a free OAuth app with the provider ' +
      '(Google Cloud Console, or the Azure portal for Microsoft), copy the client id it gives you ' +
      '(no client secret needed for the desktop/public-client flow), then paste it in here. ' +
      'A client secret (only for a confidential-client registration) is stored through the Agent ' +
      'secret manager and never shown again.'
    );
  }
  return (
    `Advanced: use your OWN registered ${label} app instead of the bundled default. ` +
    'Most people can skip this and just run the connect command. The client id is not a ' +
    'secret; a client secret (only for a confidential-client registration) is stored through ' +
    'the Agent secret manager and never shown again.'
  );
}

/** The advanced-credentials wizard for one provider. */
export function createCalendarOAuthEditor(provider: Provider, isConfigured = false): AgentWorkspaceLocalEditor {
  const label = PROVIDER_LABEL[provider];
  const kind: AgentWorkspaceEditorKind = provider === 'google' ? 'calendar-oauth-google' : 'calendar-oauth-outlook';
  return {
    kind,
    mode: 'create',
    title: `Connect ${label} (advanced)`,
    selectedFieldIndex: 0,
    message: cardMessage(label, isConfigured),
    fields: [
      { id: 'clientId', label: 'Client ID', value: '', required: true, multiline: false, hint: `Your ${label} OAuth client id (Desktop/public client needs no secret).` },
      { id: 'clientSecret', label: 'Client secret (optional)', value: '', required: false, multiline: false, hint: 'Only for a confidential-client app. Stored through the secret manager, masked here.', redact: true },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: `Type yes to store these credentials, then run ${CONNECT_HINT[provider]} to authorize.` },
    ],
  };
}

export async function submitAgentWorkspaceCalendarOAuthEditor(
  host: AgentWorkspaceCalendarOAuthEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
): Promise<void> {
  const provider: Provider = editor.kind === 'calendar-oauth-outlook' ? 'microsoft' : 'google';
  const label = PROVIDER_LABEL[provider];

  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Credentials not confirmed. Type yes, then press Enter.' };
    host.status = 'Calendar credentials not confirmed.';
    return;
  }
  if (!context) {
    host.localEditor = { ...editor, message: 'This runtime has no command context; cannot store credentials.' };
    host.status = 'Calendar connect unavailable.';
    host.lastActionResult = { kind: 'error', title: 'Calendar connect unavailable', detail: 'No command context is available in this runtime.', safety: 'safe' };
    return;
  }

  const clientId = readField('clientId').trim();
  if (!clientId) {
    host.localEditor = { ...editor, message: 'A client id is required for the advanced path.' };
    host.status = 'Client id is required.';
    return;
  }

  try {
    const secretsManager = requireSecretsManager(context);
    ensureCalendarConfigDefaults(context.platform.configManager);
    const cm = context.platform.configManager as unknown as {
      get: (key: ConfigKey) => unknown;
      setDynamic: (key: ConfigKey, value: unknown) => void;
      save: () => void;
    };
    // Client id is not a secret, a plain config value.
    cm.setDynamic(CALENDAR_OAUTH_CLIENT_ID_KEYS[provider] as unknown as ConfigKey, clientId);
    // Client secret (if any) goes through the secret-backed path: a ref in config,
    // the raw value only in the secret manager.
    const secret = readField('clientSecret');
    if (secret.trim().length > 0) {
      await persistSecretBackedConfigValue(cm, secretsManager, CALENDAR_OAUTH_CLIENT_SECRET_KEYS[provider] as unknown as ConfigKey, secret);
    }
    cm.save();

    host.localEditor = null;
    host.status = `${label} credentials stored.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: `${label} credentials stored`,
      detail: `Your ${label} client id was saved${secret.trim() ? ' (and the client secret through the secret manager)' : ''}. Run ${CONNECT_HINT[provider]} to open the browser and authorize.`,
      safety: 'safe',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Calendar credentials not stored', detail, safety: 'safe' };
  }
}
