/**
 * credential-daemon-scope.test.ts, a credential captured at this terminal is
 * still there when the terminal is gone.
 *
 * The owner's rule: anything configured on one surface is automatically
 * available to the daemon afterwards, with that surface's process closed. Every
 * test here is written as that sentence, a credential is stored through the
 * REAL agent-side path, then read back by a manager standing in for the daemon:
 * a different surface root, a different project root, sharing only the machine's
 * home. If the value is filed in this surface's silo the read comes back null,
 * which is the shape the owner actually hit ("I can't send the email from this
 * session because no email integration is available").
 *
 * These are not scope-argument assertions. Asserting `{ scope: 'daemon' }` was
 * passed proves a function was called with a word; reading the value from a
 * second manager that shares no surface directory proves the credential is
 * reachable.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigManager, SecretsManager as SdkSecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { CalendarTokenStore } from '@goodvibes-jev/engine/sdk/platform/calendar';
import type { FeedFetcher } from '@goodvibes-jev/engine/sdk/platform/calendar';
import { SecretsManager } from '../../config/secrets.ts';
import { defaultSecretBackedScope, persistSecretBackedConfigValue, buildGoodVibesSecretKey } from '../../config/secret-config.ts';
import {
  credentialWriteScopeWasRelocated,
  isDaemonNeededSecretKey,
  resolveCredentialDeleteScope,
  resolveCredentialWriteScope,
} from '../../config/credential-scope.ts';
import { CalendarSubscriptionRegistry } from '../../agent/calendar-subscription-registry.ts';
import { CalendarOAuthService, daemonScopedSecrets } from '../../agent/calendar/calendar-oauth-service.ts';
import { persistEmailConfigField } from '../../input/commands/email-runtime.ts';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import { resetHarnessSetting, setHarnessSetting } from '../../agent/harness-control.ts';
import { handleSecrets } from '../../cli/management-commands.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';

const EMAIL_PASSWORD_SECRET_KEY = 'GOODVIBES_EMAIL_PASSWORD_REF';

/**
 * A config manager stand-in that behaves the way the real one does for the two
 * things these paths use it for: reading the storage policy, and accepting a
 * dynamic write of an app-layer key. `setDynamic` records rather than
 * validating, what is under test is where the SECRET went, and a real
 * ConfigManager would need its whole schema and tier layout to say the same
 * thing about a string it stores.
 */
function makeConfigStub(): { get(key: string): unknown; setDynamic(key: string, value: unknown): void; save(): void; written: Map<string, unknown> } {
  const written = new Map<string, unknown>();
  return {
    get: (key: string) => written.get(key),
    setDynamic: (key: string, value: unknown) => { written.set(key, value); },
    save: () => {},
    written,
  };
}

describe('a credential captured in the agent survives the agent closing', () => {
  let tmpDir: string;
  let machineHome: string;
  let agentProjectRoot: string;
  /** Written by the agent, at this terminal. */
  let agentSecrets: SecretsManager;
  /**
   * Reads as the daemon would: a different surface root, a different project
   * root, sharing only the machine home. Nothing about the agent's own
   * directories is visible to it.
   */
  let daemonReader: SdkSecretsManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(resolve(process.cwd(), '..'), 'gv-credscope-test-'));
    machineHome = join(tmpDir, 'home');
    agentProjectRoot = join(tmpDir, 'agent-workspace');
    const otherProjectRoot = join(tmpDir, 'somewhere-else');
    mkdirSync(machineHome, { recursive: true });
    mkdirSync(agentProjectRoot, { recursive: true });
    mkdirSync(otherProjectRoot, { recursive: true });
    agentSecrets = new SecretsManager({ projectRoot: agentProjectRoot, globalHome: machineHome });
    daemonReader = new SdkSecretsManager({
      projectRoot: otherProjectRoot,
      globalHome: machineHome,
      surfaceRoot: 'a-surface-the-agent-never-writes-to',
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[EMAIL_PASSWORD_SECRET_KEY];
    delete process.env['GOODVIBES_CALENDAR_SUB_WORK'];
    delete process.env['GOODVIBES_CALENDAR_GOOGLE_TOKENS'];
    delete process.env['GOODVIBES_CALENDAR_GOOGLE_ACCOUNT'];
  });

  test('the mailbox password entered here is readable when only the daemon is left', async () => {
    const config = makeConfigStub();

    const storedRef = await persistEmailConfigField(
      config as unknown as Parameters<typeof persistEmailConfigField>[0],
      agentSecrets as unknown as Parameters<typeof persistEmailConfigField>[1],
      'passwordRef',
      'the-app-password',
    );

    expect(storedRef.ok).toBe(true);
    // The config side holds a reference and never the password itself.
    expect(config.written.get('email.passwordRef')).toBe(`goodvibes://secrets/goodvibes/${EMAIL_PASSWORD_SECRET_KEY}`);

    // The whole point: a process with none of this surface's directories reads it.
    expect(await daemonReader.get(EMAIL_PASSWORD_SECRET_KEY)).toBe('the-app-password');
  });

  test('a calendar client secret entered here is readable when only the daemon is left', async () => {
    const config = makeConfigStub();
    const key = 'calendar.google.clientSecretRef';

    await persistSecretBackedConfigValue(
      config as unknown as Parameters<typeof persistSecretBackedConfigValue>[0],
      agentSecrets,
      key as never,
      'the-client-secret',
    );

    expect(await daemonReader.get(buildGoodVibesSecretKey(key))).toBe('the-client-secret');
  });

  test('a calendar subscription feed URL is readable when only the daemon is left', async () => {
    const fetcher: FeedFetcher = async () => ({
      kind: 'ok',
      body: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'X-WR-CALNAME:Work',
        'BEGIN:VEVENT',
        'UID:one@example.test',
        'DTSTART:20260801T090000Z',
        'SUMMARY:Standup',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    });
    const registry = new CalendarSubscriptionRegistry({
      storePath: join(tmpDir, 'subscriptions.json'),
      secrets: agentSecrets,
      fetcher,
    });

    const result = await registry.subscribe('https://calendar.example.test/private-address/basic.ics', 'work');
    expect(result.ok).toBe(true);

    // The daemon is the process that refreshes this feed on a schedule, hours
    // after the terminal that added it exited.
    expect(await daemonReader.get('GOODVIBES_CALENDAR_SUB_WORK'))
      .toBe('https://calendar.example.test/private-address/basic.ics');
  });

  test('the calendar OAuth refresh token is readable when only the daemon is left', async () => {
    // Built exactly as `/calendar connect google` builds it, then the REAL
    // writer, the SDK's token store, is pointed at the very slice the service
    // hands its connector. The store calls set(key, value) with no scope of its
    // own, which is the whole reason the slice has to decide.
    const service = new CalendarOAuthService({
      config: { get: () => undefined },
      secrets: agentSecrets,
    });
    const store = new CalendarTokenStore({ secrets: service.secrets });

    await store.save(
      'google',
      { accessToken: 'access-abc', refreshToken: 'refresh-xyz', tokenType: 'Bearer', obtainedAt: Date.now() },
      { provider: 'google', accountId: 'someone@example.test', label: 'Google Calendar', scopes: [], connectedAt: Date.now() },
    );

    const raw = await daemonReader.get('GOODVIBES_CALENDAR_GOOGLE_TOKENS');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).refreshToken).toBe('refresh-xyz');
    expect(await daemonReader.get('GOODVIBES_CALENDAR_GOOGLE_ACCOUNT')).toContain('someone@example.test');
  });

  test('surfaces.telegram.botToken: set stores it where the daemon reads, cleared removes it from there', async () => {
    const config = makeConfigStub();
    const persist = (value: string) => persistSecretBackedConfigValue(
      config as unknown as Parameters<typeof persistSecretBackedConfigValue>[0],
      agentSecrets,
      'surfaces.telegram.botToken' as never,
      value,
    );

    const setRef = await persist('the-bot-token');
    expect(setRef).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN');
    expect(await daemonReader.get('GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN')).toBe('the-bot-token');

    // The second value: cleared. The config side goes back to empty and the
    // credential is gone from the tier the daemon reads, not merely from this
    // surface's own copy.
    const clearedRef = await persist('');
    expect(clearedRef).toBe('');
    expect(await daemonReader.get('GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN')).toBeNull();
  });

  test('`secrets set --project` on a daemon-read credential relocates it and says so', async () => {
    const runtime: CliCommandRuntime = {
      cli: parseGoodVibesCli(['secrets', 'set', 'GOODVIBES_CALENDAR_SUB_WORK', 'https://calendar.example.test/private/basic.ics', '--project']),
      configManager: { get: () => undefined } as unknown as CliCommandRuntime['configManager'],
      workingDirectory: agentProjectRoot,
      homeDirectory: machineHome,
    };

    const output = await handleSecrets(runtime);

    expect(output).toContain('scope daemon');
    expect(output).toContain('filed in the daemon tier instead of project');
    expect(await daemonReader.get('GOODVIBES_CALENDAR_SUB_WORK'))
      .toBe('https://calendar.example.test/private/basic.ics');
  });

  test('surfaces.slack.botToken: the settings modal stores it where the daemon reads, and clearing it removes it from there', async () => {
    const configManager = new ConfigManager({ surfaceRoot: 'agent', homeDir: machineHome, workingDir: agentProjectRoot });
    const applied: Array<[string, unknown]> = [];
    const edit = (value: string) => {
      return setSecretBackedSettingValue({
        key: 'surfaces.slack.botToken' as never,
        value,
        configManager,
        secretsManager: agentSecrets,
        setConfigValue: (key, applied_value) => { applied.push([key as unknown as string, applied_value]); },
      });
    };

    await edit('the-slack-token');
    expect(applied[0]?.[1]).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN');
    expect(await daemonReader.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('the-slack-token');

    await edit('');
    expect(applied[1]?.[1]).toBe('');
    expect(await daemonReader.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBeNull();
  });

  test('surfaces.discord.botToken: the harness set path stores it where the daemon reads, and reset removes it from there', async () => {
    const configManager = new ConfigManager({ surfaceRoot: 'agent', homeDir: machineHome, workingDir: agentProjectRoot });

    const set = await setHarnessSetting(configManager, agentSecrets, 'surfaces.discord.botToken', 'the-discord-token');
    expect(set.action).toBe('set');
    expect(await daemonReader.get('GOODVIBES_SURFACES_DISCORD_BOT_TOKEN')).toBe('the-discord-token');

    const reset = await resetHarnessSetting(configManager, agentSecrets, 'surfaces.discord.botToken');
    expect(reset.action).toBe('reset');
    expect(await daemonReader.get('GOODVIBES_SURFACES_DISCORD_BOT_TOKEN')).toBeNull();
  });

  test('a genuinely surface-local credential is NOT moved into the daemon tier', async () => {
    // A bare name an operator invented for their own tooling. Nothing derives it
    // from a config path the daemon acts on, so it keeps the scope it was given
    // and stays out of the daemon's store, the relocation rule is a rule about
    // credentials the daemon reads, not a rule that everything moves.
    await agentSecrets.set('MY_OWN_SCRATCH_TOKEN', 'local-only', { scope: 'project' });

    expect(isDaemonNeededSecretKey('MY_OWN_SCRATCH_TOKEN')).toBe(false);
    expect(await daemonReader.get('MY_OWN_SCRATCH_TOKEN')).toBeNull();
    expect(await agentSecrets.get('MY_OWN_SCRATCH_TOKEN')).toBe('local-only');
  });
});

/**
 * The scope each path ASKS the store for.
 *
 * The end-to-end tests above prove the credential is reachable. They cannot
 * prove which of two things made it reachable, because at this SDK version the
 * store relocates daemon-owned names by itself: a call site that asks for
 * 'user' and one that asks for 'daemon' produce the same file on disk. These
 * tests read the request instead, with a recording store in place of the real
 * one, so a call site that goes back to pinning a client tier fails here even
 * while the store is still covering for it.
 */
describe('the scope each credential path asks for', () => {
  function recorder(): { set: (key: string, value: string, options?: { scope?: string }) => Promise<void>; delete: (key: string, options?: { scope?: string }) => Promise<void>; sets: Array<[string, string | undefined]>; deletes: Array<[string, string | undefined]> } {
    const sets: Array<[string, string | undefined]> = [];
    const deletes: Array<[string, string | undefined]> = [];
    return {
      sets,
      deletes,
      set: async (key, _value, options) => { sets.push([key, options?.scope]); },
      delete: async (key, options) => { deletes.push([key, options?.scope]); },
    };
  }

  test('the shared secret-backed write path asks for the daemon tier for a daemon-owned key', async () => {
    const store = recorder();
    const config = makeConfigStub();

    await persistSecretBackedConfigValue(
      config as unknown as Parameters<typeof persistSecretBackedConfigValue>[0],
      store as unknown as Parameters<typeof persistSecretBackedConfigValue>[1],
      'surfaces.telegram.botToken' as never,
      'a-token',
    );

    expect(store.sets).toEqual([['GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN', 'daemon']]);
  });

  test('the mailbox password path asks for the daemon tier', async () => {
    const store = recorder();
    const config = makeConfigStub();

    await persistEmailConfigField(
      config as unknown as Parameters<typeof persistEmailConfigField>[0],
      store as unknown as Parameters<typeof persistEmailConfigField>[1],
      'passwordRef',
      'a-password',
    );

    expect(store.sets).toEqual([[EMAIL_PASSWORD_SECRET_KEY, 'daemon']]);
  });

  test('the settings modal asks for the daemon tier', async () => {
    const store = recorder();

    await setSecretBackedSettingValue({
      key: 'surfaces.slack.botToken' as never,
      value: 'a-token',
      configManager: { get: () => undefined } as never,
      secretsManager: store as never,
      setConfigValue: () => {},
    });
    expect(store.sets).toEqual([['GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'daemon']]);
  });

  test('the harness setting path asks for the daemon tier, on write and on reset', async () => {
    const tmp = mkdtempSync(join(resolve(process.cwd(), '..'), 'gv-credscope-harness-'));
    try {
      const configManager = new ConfigManager({ surfaceRoot: 'agent', homeDir: tmp, workingDir: tmp });
      const store = recorder();

      await setHarnessSetting(configManager, store as never, 'surfaces.discord.botToken', 'a-token');
      await resetHarnessSetting(configManager, store as never, 'surfaces.discord.botToken');

      expect(store.sets).toEqual([['GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', 'daemon']]);
      expect(store.deletes).toEqual([['GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', 'daemon']]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a client-owned secret-backed key still asks for the user tier', async () => {
    const store = recorder();
    const config = makeConfigStub();

    // Not a real secret key today; the point is the DECISION, which must stay
    // "user" for anything the daemon does not act on rather than sweeping
    // everything into the daemon's store.
    expect(defaultSecretBackedScope('behavior.autoCompactThreshold' as never)).toBe('user');
    await persistSecretBackedConfigValue(
      config as unknown as Parameters<typeof persistSecretBackedConfigValue>[0],
      store as unknown as Parameters<typeof persistSecretBackedConfigValue>[1],
      'behavior.autoCompactThreshold' as never,
      'x',
    );
    expect(store.sets[0]?.[1]).toBe('user');
  });
});

describe('credential scope decisions', () => {
  test('daemon-owned config keys default their secret material to the daemon tier', () => {
    expect(defaultSecretBackedScope('email.passwordRef' as never)).toBe('daemon');
    expect(defaultSecretBackedScope('calendar.google.clientSecretRef' as never)).toBe('daemon');
    expect(defaultSecretBackedScope('calendar.microsoft.clientSecretRef' as never)).toBe('daemon');
    expect(defaultSecretBackedScope('surfaces.slack.botToken' as never)).toBe('daemon');
    expect(defaultSecretBackedScope('surfaces.telegram.webhookSecret' as never)).toBe('daemon');
  });

  test('a client-owned key keeps the user tier', () => {
    expect(defaultSecretBackedScope('provider.model' as never)).toBe('user');
  });

  test('the names this product invents are recognised as daemon-read', () => {
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_SUB_WORK')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_SUB_FAMILY_HOLIDAYS')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_GOOGLE_TOKENS')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_GOOGLE_ACCOUNT')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_GOOGLE_STATUS')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_MICROSOFT_TOKENS')).toBe(true);
  });

  test('the names the SDK already derives are recognised without being restated here', () => {
    expect(isDaemonNeededSecretKey('GOODVIBES_EMAIL_PASSWORD_REF')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(isDaemonNeededSecretKey('GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF')).toBe(true);
  });

  test('an explicit non-daemon scope loses to daemon need, and the caller can tell', () => {
    expect(resolveCredentialWriteScope('GOODVIBES_CALENDAR_SUB_WORK', 'project')).toBe('daemon');
    expect(resolveCredentialWriteScope('GOODVIBES_CALENDAR_SUB_WORK', 'user')).toBe('daemon');
    expect(credentialWriteScopeWasRelocated('GOODVIBES_CALENDAR_SUB_WORK', 'project')).toBe(true);
    expect(credentialWriteScopeWasRelocated('MY_OWN_SCRATCH_TOKEN', 'project')).toBe(false);
  });

  test('the calendar secret wrapper pins writes by name and leaves reads and deletes alone', async () => {
    const writes: Array<[string, string, unknown]> = [];
    const deletes: Array<[string, unknown]> = [];
    const wrapped = daemonScopedSecrets({
      get: async () => 'value',
      set: async (key, value, options) => { writes.push([key, value, options?.scope]); },
      delete: async (key, options) => { deletes.push([key, options?.scope]); },
    });

    await wrapped.set('GOODVIBES_CALENDAR_GOOGLE_TOKENS', '{}');
    await wrapped.set('SOMETHING_THE_DAEMON_NEVER_READS', 'x', { scope: 'project' });
    await wrapped.delete('GOODVIBES_CALENDAR_GOOGLE_TOKENS');

    expect(writes[0]).toEqual(['GOODVIBES_CALENDAR_GOOGLE_TOKENS', '{}', 'daemon']);
    expect(writes[1]).toEqual(['SOMETHING_THE_DAEMON_NEVER_READS', 'x', 'project']);
    // A delete carries no scope, so it sweeps every tier, including a copy left
    // in the project tier by a build from before this shipped.
    expect(deletes[0]).toEqual(['GOODVIBES_CALENDAR_GOOGLE_TOKENS', undefined]);
    expect(await wrapped.get('anything')).toBe('value');
  });

  test('deleting a daemon-read credential sweeps every tier rather than the requested one', () => {
    expect(resolveCredentialDeleteScope('GOODVIBES_CALENDAR_SUB_WORK', 'project')).toBeUndefined();
    expect(resolveCredentialDeleteScope('GOODVIBES_CALENDAR_GOOGLE_TOKENS', 'user')).toBeUndefined();
    expect(resolveCredentialDeleteScope('MY_OWN_SCRATCH_TOKEN', 'project')).toBe('project');
  });
});
