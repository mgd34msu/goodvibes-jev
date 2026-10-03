/**
 * Email connect wizard, promotes the "Inbox workflows" workspace
 * card from a dead guidance card into a real, stepped connect flow.
 *
 * Security: the raw password NEVER travels through the generic slash-command
 * dispatch pipeline (AgentWorkspace.dispatchWorkspaceCommand), because that
 * pipeline echoes its `command` argument back into
 * AgentWorkspace.lastActionResult.command for the 'inline' execution path
 * (see handler.ts dispatchAgentWorkspaceCommand), a raw command string
 * containing the password would render it in the workspace UI. Instead this
 * editor is a DIRECT host action (the same pattern as the subscription
 * login editors in agent-workspace-subscription-editor.ts): it calls
 * persistEmailConfigField() and EmailService.testConnection() directly
 * against ctx.platform.configManager / ctx.platform.secretsManager and never
 * builds a command string. Credential persistence reuses the exact same
 * persistEmailConfigField() helper the /email set CLI command uses, one
 * storage path, not a fork.
 */
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-editors.ts';
import { EmailService, ensureEmailConfigDefaults, type EmailConnectionTestResult } from '@goodvibes-jev/engine/sdk/platform/email';
import { nodeEmailTransport } from '@goodvibes-jev/engine/sdk/platform/email/node';
import { describeSenderClaim } from '../agent/untrusted-content.ts';
import { requireSecretsManager } from './commands/runtime-services.ts';
import { persistEmailConfigField } from './commands/email-runtime.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceEmailConnectStatus, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

type FieldReader = (id: string) => string;

export interface AgentWorkspaceEmailConnectEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
}

/** Fields, in wizard-step order. imapPort/smtpPort/smtpSecurity carry sane defaults. */
export function createEmailConnectWizardEditor(status: AgentWorkspaceEmailConnectStatus | null): AgentWorkspaceLocalEditor {
  const message = !status
    ? 'Connect your inbox. Enter your IMAP/SMTP settings; the password is stored through the Agent secret manager, never in plain config.'
    : status.connected
      ? `Currently connected as ${status.username} (${status.imapHost}). Re-enter settings below to reconnect or update credentials.`
      : status.errors.length > 0
        ? 'Not connected, connect your inbox. Enter your IMAP/SMTP settings below.'
        : 'Not connected, connect your inbox. Enter your IMAP/SMTP settings below.';
  return {
    kind: 'email-connect-wizard',
    mode: 'create',
    title: 'Connect Inbox',
    selectedFieldIndex: 0,
    message,
    fields: [
      { id: 'imapHost', label: 'IMAP host', value: status?.imapHost ?? '', required: true, multiline: false, hint: 'For example imap.gmail.com.' },
      { id: 'imapPort', label: 'IMAP port', value: '993', required: true, multiline: false, hint: 'Default 993 (implicit TLS).' },
      { id: 'smtpHost', label: 'SMTP host', value: '', required: true, multiline: false, hint: 'For example smtp.gmail.com.' },
      { id: 'smtpPort', label: 'SMTP port', value: '587', required: true, multiline: false, hint: 'Default 587 (STARTTLS) or 465 (TLS).' },
      { id: 'smtpSecurity', label: 'SMTP security', value: 'auto', required: true, multiline: false, hint: 'tls, starttls, or auto (port-based).' },
      { id: 'username', label: 'Username', value: status?.username ?? '', required: true, multiline: false, hint: 'Mailbox login, usually your email address.' },
      { id: 'password', label: 'Password', value: '', required: true, multiline: false, hint: 'Stored through the Agent secret manager. Masked here and never rendered in results.', redact: true },
      { id: 'fromAddress', label: 'From address', value: status?.username ?? '', required: true, multiline: false, hint: 'Address used in the From: header when sending.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to store these settings and test the connection.' },
    ],
  };
}

/** Field ids that persistEmailConfigField expects, in order, 'password' input maps to the 'passwordRef' config field. */
const FIELD_TO_EMAIL_KEY: Record<string, string> = {
  imapHost: 'imapHost',
  imapPort: 'imapPort',
  smtpHost: 'smtpHost',
  smtpPort: 'smtpPort',
  smtpSecurity: 'smtpSecurity',
  username: 'username',
  fromAddress: 'fromAddress',
};

export type EmailConnectionTester = (
  getConfig: (key: string) => unknown,
  secretsManager: { readonly get: (key: string) => Promise<string | null> },
) => { testConnection(): Promise<EmailConnectionTestResult> };

const defaultTester: EmailConnectionTester = (getConfig, secretsManager) =>
  new EmailService({
    getConfig,
    secretsManager,
    // The real sockets, and this product's own sender-claim wording. The
    // platform service ships neither: it opens no connection itself, and the
    // phrasing of a trust boundary belongs to the surface that renders it.
    transport: nodeEmailTransport,
    describeSenderClaim,
  });

export async function submitAgentWorkspaceEmailConnectWizardEditor(
  host: AgentWorkspaceEmailConnectEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: FieldReader,
  /** Injectable for tests, avoids real network I/O. Production callers omit this and get the real EmailService. */
  buildTester: EmailConnectionTester = defaultTester,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Inbox connection not confirmed. Type yes, then press Enter.' };
    host.status = 'Inbox connection not confirmed.';
    return;
  }
  if (!context) {
    host.localEditor = { ...editor, message: 'This runtime has no command context; cannot connect the inbox.' };
    host.status = 'Inbox connect unavailable.';
    host.lastActionResult = { kind: 'error', title: 'Inbox connect unavailable', detail: 'No command context is available in this runtime.', safety: 'safe' };
    return;
  }

  try {
    const secretsManager = requireSecretsManager(context);
    ensureEmailConfigDefaults(context.platform.configManager);
    const cm = context.platform.configManager as unknown as {
      get: (key: string) => unknown;
      setDynamic: (key: string, value: unknown) => void;
      save: () => void;
    };

    for (const [fieldId, emailKey] of Object.entries(FIELD_TO_EMAIL_KEY)) {
      const result = await persistEmailConfigField(cm, secretsManager, emailKey, readField(fieldId));
      if (!result.ok) {
        host.localEditor = { ...editor, message: result.error ?? `Could not save ${fieldId}.` };
        host.status = result.error ?? 'Inbox connection settings were invalid.';
        host.lastActionResult = { kind: 'error', title: 'Inbox settings invalid', detail: result.error ?? `Could not save ${fieldId}.`, safety: 'safe' };
        return;
      }
    }
    const passwordResult = await persistEmailConfigField(cm, secretsManager, 'passwordRef', readField('password'));
    if (!passwordResult.ok) {
      host.localEditor = { ...editor, message: passwordResult.error ?? 'Could not store the password.' };
      host.status = passwordResult.error ?? 'Inbox password could not be stored.';
      host.lastActionResult = { kind: 'error', title: 'Inbox password invalid', detail: passwordResult.error ?? 'Could not store the password.', safety: 'safe' };
      return;
    }
    cm.save();

    const service = buildTester((key: string) => cm.get(key), secretsManager);
    const test = await service.testConnection();
    if (!test.ok) {
      host.localEditor = null;
      host.status = `Inbox connection failed (${test.stage ?? 'unknown'}).`;
      host.lastActionResult = {
        kind: 'error',
        title: 'Inbox connection failed',
        detail: `Could not verify the mailbox (${test.stage ?? 'unknown'} stage): ${test.error ?? 'unknown error'}. Settings were saved, fix the value above and reconnect.`,
        safety: 'safe',
      };
      host.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
      return;
    }

    cm.setDynamic('email.enabled', true);
    cm.save();
    host.localEditor = null;
    host.status = 'Inbox connected.';
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Inbox connected',
      detail: `IMAP and SMTP were verified for ${readField('username')}. Inbox workflows are ready.`,
      safety: 'safe',
    };
    host.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Inbox connect failed', detail, safety: 'safe' };
  }
}
