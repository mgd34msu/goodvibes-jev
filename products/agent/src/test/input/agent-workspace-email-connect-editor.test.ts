/**
 * Email connect wizard editor tests.
 *
 * Uses a real ConfigManager against a tmp dir (mirrors email-command.test.ts)
 * plus an in-memory SecretsManager stub, so persistence assertions are
 * end-to-end real, not mocked. EmailService.testConnection() is stubbed via
 * the editor's injectable buildTester parameter so no real network I/O
 * happens in this file (the real testConnection() path is covered by
 * email-service.test.ts's fake-TCP-server tests).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import {
  createEmailConnectWizardEditor,
  submitAgentWorkspaceEmailConnectWizardEditor,
  type AgentWorkspaceEmailConnectEditorHost,
} from '../../input/agent-workspace-email-connect-editor.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const RAW_PASSWORD = 'super-secret-mailbox-password';

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-email-wizard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function makeMemorySecretsManager(): {
  store: Map<string, string>;
  manager: { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void>; delete: (key: string) => Promise<void> };
} {
  const store = new Map<string, string>();
  return {
    store,
    manager: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
  };
}

function makeContext(root: string, secretsManager: ReturnType<typeof makeMemorySecretsManager>['manager']): CommandContext {
  const cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'global-tui') });
  return {
    session: {} as never,
    provider: {} as never,
    workspace: {} as never,
    platform: { config: {} as never, configManager: cm, secretsManager } as never,
    ops: {} as never,
    extensions: {} as never,
    clients: {} as never,
    renderRequest: () => {},
    print: () => {},
    exit: () => {},
  } as CommandContext;
}

function readPersistedSettings(root: string): string {
  const candidates = [
    join(root, '.goodvibes', 'global-tui', 'settings.json'),
    join(root, '.goodvibes', 'global-tui', 'user-settings.json'),
  ];
  return candidates.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf-8')).join('');
}

function makeHost(): AgentWorkspaceEmailConnectEditorHost {
  return { localEditor: null, runtimeSnapshot: null, status: '', lastActionResult: null };
}

const VALID_FIELDS: Record<string, string> = {
  imapHost: 'imap.example.test',
  imapPort: '993',
  smtpHost: 'smtp.example.test',
  smtpPort: '587',
  smtpSecurity: 'auto',
  username: 'user@example.test',
  password: RAW_PASSWORD,
  fromAddress: 'user@example.test',
  confirm: 'yes',
};

function fieldReaderFrom(fields: Record<string, string>): (id: string) => string {
  return (id: string) => fields[id] ?? '';
}

describe('createEmailConnectWizardEditor', () => {
  test('null status: generic honest entry message, all known fields present', () => {
    const editor = createEmailConnectWizardEditor(null);
    expect(editor.kind).toBe('email-connect-wizard');
    expect(editor.message).toContain('secret manager');
    const ids = editor.fields.map((f) => f.id);
    expect(ids).toEqual(['imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'smtpSecurity', 'username', 'password', 'fromAddress', 'confirm']);
    const passwordField = editor.fields.find((f) => f.id === 'password');
    expect(passwordField?.redact).toBe(true);
    expect(passwordField?.value).toBe('');
  });

  test('connected status: message states the real connected account', () => {
    const editor = createEmailConnectWizardEditor({ connected: true, username: 'me@example.test', imapHost: 'imap.example.test', errors: [] });
    expect(editor.message).toContain('Currently connected as me@example.test');
    expect(editor.message).toContain('imap.example.test');
  });

  test('unconfigured status: honest "Not connected" wording, not a dead description', () => {
    const editor = createEmailConnectWizardEditor({ connected: false, username: '', imapHost: '', errors: ['email.imapHost is required'] });
    expect(editor.message).toContain('Not connected');
    expect(editor.message).toContain('connect your inbox');
  });
});

describe('submitAgentWorkspaceEmailConnectWizardEditor', () => {
  let tmpDir: string;
  let editor: AgentWorkspaceLocalEditor;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    editor = createEmailConnectWizardEditor(null);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('confirm not affirmative: no context call, editor stays open, status is honest', async () => {
    const host = makeHost();
    host.localEditor = editor;
    await submitAgentWorkspaceEmailConnectWizardEditor(host, editor, null, fieldReaderFrom({ ...VALID_FIELDS, confirm: 'no' }));
    expect(host.localEditor).not.toBeNull();
    expect(host.status).toContain('not confirmed');
    expect(host.lastActionResult).toBeNull();
  });

  test('no context: honest "unavailable" error, never claims success', async () => {
    const host = makeHost();
    host.localEditor = editor;
    await submitAgentWorkspaceEmailConnectWizardEditor(host, editor, null, fieldReaderFrom(VALID_FIELDS));
    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.lastActionResult?.title).toContain('unavailable');
  });

  test('invalid port: rejects before storing anything, no secret written', async () => {
    const { store, manager } = makeMemorySecretsManager();
    const context = makeContext(tmpDir, manager);
    const host = makeHost();
    host.localEditor = editor;

    await submitAgentWorkspaceEmailConnectWizardEditor(
      host, editor, context, fieldReaderFrom({ ...VALID_FIELDS, imapPort: '999999' }),
    );

    expect(host.lastActionResult?.kind).toBe('error');
    expect(store.size).toBe(0);
    const persisted = readPersistedSettings(tmpDir);
    expect(persisted).not.toContain(RAW_PASSWORD);
  });

  test('successful connection: stores the real secret via secretsManager, persists non-secret fields, enables email, never logs the raw password', async () => {
    const { store, manager } = makeMemorySecretsManager();
    const context = makeContext(tmpDir, manager);
    const host = makeHost();
    host.localEditor = editor;

    await submitAgentWorkspaceEmailConnectWizardEditor(
      host, editor, context, fieldReaderFrom(VALID_FIELDS),
      () => ({ testConnection: async () => ({ ok: true }) }),
    );

    // Honest success state
    expect(host.localEditor).toBeNull();
    expect(host.lastActionResult?.kind).toBe('refreshed');
    expect(host.lastActionResult?.title).toBe('Inbox connected');

    // The raw password reached the secrets manager (real store, not a config write)
    expect([...store.values()]).toContain(RAW_PASSWORD);

    // email.enabled flipped true only after a verified connection
    const cm = context.platform.configManager as unknown as { get: (k: string) => unknown };
    expect(cm.get('email.enabled')).toBe(true);
    expect(cm.get('email.imapHost')).toBe('imap.example.test');

    // The raw password never appears in the persisted settings file, the
    // workspace status line, or the rendered action result.
    const persisted = readPersistedSettings(tmpDir);
    expect(persisted).not.toContain(RAW_PASSWORD);
    expect(host.status).not.toContain(RAW_PASSWORD);
    expect(JSON.stringify(host.lastActionResult)).not.toContain(RAW_PASSWORD);

    // Runtime snapshot was refreshed (not left null/stale)
    expect(host.runtimeSnapshot).not.toBeNull();
  });

  test('failed connection: settings are saved, email stays disabled, honest error names the real stage, no false success', async () => {
    const { manager } = makeMemorySecretsManager();
    const context = makeContext(tmpDir, manager);
    const host = makeHost();
    host.localEditor = editor;

    await submitAgentWorkspaceEmailConnectWizardEditor(
      host, editor, context, fieldReaderFrom(VALID_FIELDS),
      () => ({ testConnection: async () => ({ ok: false, stage: 'imap', error: 'Invalid credentials' }) }),
    );

    expect(host.lastActionResult?.kind).toBe('error');
    expect(host.lastActionResult?.title).toBe('Inbox connection failed');
    expect(host.lastActionResult?.detail).toContain('imap');
    expect(host.lastActionResult?.detail).toContain('Invalid credentials');
    expect(JSON.stringify(host.lastActionResult)).not.toContain(RAW_PASSWORD);

    const cm = context.platform.configManager as unknown as { get: (k: string) => unknown };
    expect(cm.get('email.enabled')).not.toBe(true);
    // The host settings were still saved so the user does not have to retype them
    expect(cm.get('email.imapHost')).toBe('imap.example.test');
  });
});
