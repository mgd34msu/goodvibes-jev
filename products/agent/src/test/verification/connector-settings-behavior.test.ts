/**
 * connector-settings-behavior.test.ts, behaviour coverage for the connector
 * settings platform runtime 2.0.8 declared: the daemon's mail and calendar keys
 * (`email.*`, `calendar.*`).
 *
 * ## Why this file exists
 *
 * Before 2.0.8 these keys were cast onto the live config object at runtime by
 * `connector-config-sections.ts` and were absent from CONFIG_SCHEMA, so this
 * surface answered "Unknown setting calendar.google.clientId" for a key the
 * daemon reads and writes every time it composes mail or refreshes a calendar.
 * Declaring them fixed that, and it also put 21 of them into the settings
 * DENOMINATOR the verification ledger measures (this repo references all 21),
 * with no matching entry in the numerator.
 *
 * The floor is not the thing that moves. settings-behavior-coverage.ts states
 * the bar an entry has to clear, and these tests are written to it rather than
 * around it: every key below is driven to at least two distinct values through
 * the REAL code in this repository that consumes it, and each assertion is an
 * observable difference in outcome between those values. A ConfigManager
 * set/get round-trip would verify ConfigManager, not the setting, and that file
 * rules it out by name, so nothing here is one.
 *
 * ## The consumers being driven
 *
 *  - `buildAgentWorkspaceEmailConnectStatus` (agent-workspace-snapshot-builders.ts)
 *    is what the inbox connect wizard's entry card reports: it reads every
 *    `email.*` key through the SDK's `readEmailConfig`, runs
 *    `validateEmailConfig`, and answers connected / not-connected with the
 *    specific reasons. A key that stopped being honoured changes that answer.
 *  - `persistEmailConfigField` (input/commands/email-runtime.ts) is the single
 *    persistence path shared by `/email set` and the workspace connect wizard.
 *    It validates per field before writing, so a rejected value writes nothing.
 *  - `CalendarOAuthService` (agent/calendar/calendar-oauth-service.ts) resolves
 *    the operator's own OAuth app out of config plus the secret store.
 *  - `resolveCapabilityIndex` (capabilities/capability-index.ts) decides what
 *    the agent tells its owner it can do, and `calendar.google.icsUrl` is one
 *    of the two configuration-evidence probes behind "read the calendar".
 *
 * The remaining declared connector keys are deliberately NOT claimed here.
 * `email.imapSecurity`, `email.mailbox` and `email.draftsMailbox` are read by
 * `readEmailConfig` and consumed by the daemon's own mail service; this repo
 * has no code whose outcome differs between two of their values, so claiming
 * them would be the padding settings-behavior-coverage.ts exists to prevent.
 * `google.oauth.refreshToken` is named here only by the support-bundle
 * redactor's name list, which classifies keys rather than acting on values.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CalendarConnector } from '@goodvibes-jev/engine/sdk/platform/calendar';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildAgentWorkspaceEmailConnectStatus } from '../../input/agent-workspace-snapshot-builders.ts';
import {
  persistEmailConfigField,
  type EmailConfigManagerLike,
  type EmailSecretsManagerLike,
} from '../../input/commands/email-runtime.ts';
import {
  CalendarOAuthService,
  type CalendarSecretSlice,
} from '../../agent/calendar/calendar-oauth-service.ts';
import { registerBuiltinCapabilities } from '../../capabilities/builtin-capabilities.ts';
import {
  resetCapabilityIndexForTests,
  resolveCapabilityIndex,
} from '../../capabilities/capability-index.ts';
import { emptyProbeContext, type ProbeContext } from '../../capabilities/capability-probe-runner.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// email.* through the workspace connect status
// ---------------------------------------------------------------------------

/** A mailbox that validates clean, so each test can break exactly one key. */
const COMPLETE_MAILBOX: Readonly<Record<string, unknown>> = {
  'email.enabled': true,
  'email.imapHost': 'imap.example.com',
  'email.smtpHost': 'smtp.example.com',
  'email.username': 'operator@example.com',
  'email.passwordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORDREF',
  'email.fromAddress': 'GoodVibes <operator@example.com>',
};

let emailRoot = '';

function emailContext(overrides: Readonly<Record<string, unknown>> = {}): CommandContext {
  const configManager = new ConfigManager({
    surfaceRoot: 'agent',
    workingDir: emailRoot,
    homeDir: emailRoot,
    configDir: join(emailRoot, '.goodvibes', 'agent'),
  });
  const dynamic = configManager as unknown as { setDynamic: (key: string, value: unknown) => void };
  for (const [key, value] of Object.entries({ ...COMPLETE_MAILBOX, ...overrides })) {
    dynamic.setDynamic(key, value);
  }
  return { platform: { configManager } } as unknown as CommandContext;
}

describe('email.* settings decide what the connect wizard reports', () => {
  beforeEach(() => {
    emailRoot = makeProjectTempDir('gv-connector-email');
  });

  afterEach(() => {
    rmSync(emailRoot, { recursive: true, force: true });
  });

  test('email.enabled: a mailbox that validates clean still reports not-connected while it is off', () => {
    const on = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.enabled': true }));
    const off = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.enabled': false }));

    expect(on?.connected).toBe(true);
    expect(off?.connected).toBe(false);
    // The difference is the switch alone: nothing is wrong with the mailbox.
    expect(off?.errors).toEqual([]);
  });

  test('email.imapHost: unset is a named, blocking reason; set clears it and is what the card shows', () => {
    const unset = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.imapHost': '' }));
    const set = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.imapHost': 'imap.fastmail.com' }));

    expect(unset?.connected).toBe(false);
    expect(unset?.errors).toContain('email.imapHost is required');
    expect(set?.connected).toBe(true);
    expect(set?.errors).not.toContain('email.imapHost is required');
    expect(set?.imapHost).toBe('imap.fastmail.com');
  });

  test('email.smtpHost: unset is a named, blocking reason; set clears it', () => {
    const unset = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.smtpHost': '' }));
    const set = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.smtpHost': 'smtp.fastmail.com' }));

    expect(unset?.connected).toBe(false);
    expect(unset?.errors).toContain('email.smtpHost is required');
    expect(set?.connected).toBe(true);
  });

  test('email.username: unset is a named, blocking reason; set clears it and is what the card shows', () => {
    const unset = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.username': '' }));
    const set = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.username': 'owner@example.net' }));

    expect(unset?.connected).toBe(false);
    expect(unset?.errors).toContain('email.username is required');
    expect(set?.connected).toBe(true);
    expect(set?.username).toBe('owner@example.net');
  });

  test('email.passwordRef: a raw password is refused by name, a secret reference is accepted', () => {
    const raw = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.passwordRef': 'hunter2' }));
    const ref = buildAgentWorkspaceEmailConnectStatus(emailContext({
      'email.passwordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORDREF',
    }));

    // A settings file must never hold the value itself, and the card says so
    // rather than reporting a mailbox that cannot authenticate.
    expect(raw?.connected).toBe(false);
    expect(raw?.errors.some((line) => line.includes('email.passwordRef must be a goodvibes secret reference'))).toBe(true);
    expect(ref?.connected).toBe(true);
  });

  test('email.smtpPasswordRef: empty means "same as IMAP", a raw value is refused, a reference is accepted', () => {
    const empty = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.smtpPasswordRef': '' }));
    const raw = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.smtpPasswordRef': 'submission-password' }));
    const ref = buildAgentWorkspaceEmailConnectStatus(emailContext({
      'email.smtpPasswordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_SMTPPASSWORDREF',
    }));

    expect(empty?.connected).toBe(true);
    expect(raw?.connected).toBe(false);
    expect(raw?.errors.some((line) => line.includes('email.smtpPasswordRef must be a goodvibes secret reference'))).toBe(true);
    expect(ref?.connected).toBe(true);
  });

  test('email.fromAddress: unset is a named, blocking reason; set clears it', () => {
    const unset = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.fromAddress': '' }));
    const set = buildAgentWorkspaceEmailConnectStatus(emailContext({ 'email.fromAddress': 'owner@example.net' }));

    expect(unset?.connected).toBe(false);
    expect(unset?.errors).toContain('email.fromAddress is required');
    expect(set?.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// email.* through the one persistence path
// ---------------------------------------------------------------------------

/** The `{ get, setDynamic }` slice persistEmailConfigField writes through. */
function recordingConfig(): EmailConfigManagerLike & { readonly written: Map<string, unknown> } {
  const written = new Map<string, unknown>();
  return {
    written,
    get: (key: string) => written.get(key),
    setDynamic: (key: string, value: unknown) => { written.set(key, value); },
  };
}

/** Never reached: none of the fields below is the secret-backed one. */
const NO_SECRETS: EmailSecretsManagerLike = {
  get: async () => { throw new Error('the secret store must not be touched for a non-secret field'); },
};

describe('email.* settings are validated before anything is written', () => {
  test('email.imapPort: an out-of-range port is refused and writes nothing; a real port persists as a number', async () => {
    const rejected = recordingConfig();
    const refusal = await persistEmailConfigField(rejected, NO_SECRETS, 'imapPort', '99999');
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain('Invalid port number');
    expect(refusal.configKey).toBe('email.imapPort');
    expect(rejected.written.size).toBe(0);

    const accepted = recordingConfig();
    const stored = await persistEmailConfigField(accepted, NO_SECRETS, 'imapPort', '993');
    expect(stored.ok).toBe(true);
    // A number, not the string it arrived as, a string here reaches the IMAP
    // client as a port it cannot dial.
    expect(accepted.written.get('email.imapPort')).toBe(993);
  });

  test('email.smtpPort: an out-of-range port is refused and writes nothing; a real port persists as a number', async () => {
    const rejected = recordingConfig();
    const refusal = await persistEmailConfigField(rejected, NO_SECRETS, 'smtpPort', '0');
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain('Invalid port number');
    expect(refusal.configKey).toBe('email.smtpPort');
    expect(rejected.written.size).toBe(0);

    const accepted = recordingConfig();
    const stored = await persistEmailConfigField(accepted, NO_SECRETS, 'smtpPort', '465');
    expect(stored.ok).toBe(true);
    expect(accepted.written.get('email.smtpPort')).toBe(465);
  });

  test('email.smtpSecurity: an unknown mode is refused with the valid ones named; a known mode persists', async () => {
    const rejected = recordingConfig();
    const refusal = await persistEmailConfigField(rejected, NO_SECRETS, 'smtpSecurity', 'sometimes');
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toContain('Valid values: tls, starttls, auto');
    expect(refusal.configKey).toBe('email.smtpSecurity');
    expect(rejected.written.size).toBe(0);

    const accepted = recordingConfig();
    const stored = await persistEmailConfigField(accepted, NO_SECRETS, 'smtpSecurity', 'starttls');
    expect(stored.ok).toBe(true);
    expect(accepted.written.get('email.smtpSecurity')).toBe('starttls');
  });
});

// ---------------------------------------------------------------------------
// calendar.google.clientSecretRef through the real OAuth service
// ---------------------------------------------------------------------------

function memorySecrets(): CalendarSecretSlice & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

/** Fails loudly if a resolution test ever reaches the network. */
function throwingConnector(): CalendarConnector {
  const boom = () => { throw new Error('connector should not be called'); };
  return { beginConnectAuthCode: boom, beginConnectDeviceCode: boom, listAccounts: async () => [] } as unknown as CalendarConnector;
}

describe('calendar.google.clientSecretRef decides whether a confidential client can authenticate', () => {
  test('unset resolves no client secret; a stored reference resolves the value from the secret store', async () => {
    const secrets = memorySecrets();
    await secrets.set('GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF', 'google-confidential-secret');

    const withoutRef = new CalendarOAuthService({
      config: { get: (key: string) => ({ 'calendar.google.clientId': 'google-id' } as Record<string, unknown>)[key] },
      secrets: memorySecrets(),
      connector: throwingConnector(),
    });
    const withRef = new CalendarOAuthService({
      config: {
        get: (key: string) => ({
          'calendar.google.clientId': 'google-id',
          'calendar.google.clientSecretRef': 'goodvibes://secrets/goodvibes/GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF',
        } as Record<string, unknown>)[key],
      },
      secrets,
      connector: throwingConnector(),
    });

    // A Desktop-app client using PKCE needs no secret, so "unset" is a real
    // configuration rather than an error, but a Web-app registration cannot
    // exchange a code without one, and this is where that value comes from.
    expect((await withoutRef.resolveOverrides('google')).clientSecret).toBeUndefined();
    expect((await withRef.resolveOverrides('google')).clientSecret).toBe('google-confidential-secret');
  });
});

// ---------------------------------------------------------------------------
// calendar.google.icsUrl through the capability index
// ---------------------------------------------------------------------------

describe('calendar.google.icsUrl is configuration evidence for reading the calendar', () => {
  let home = '';

  beforeEach(() => {
    // Deliberately bare: no ~/.gmail-mcp credentials and no OAuth client id, so
    // the calendar capability is in needs-setup and the only thing that can
    // move is the feed address.
    home = makeProjectTempDir('gv-connector-ics');
    resetCapabilityIndexForTests();
    registerBuiltinCapabilities({ homeDirectory: home, workingDirectory: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetCapabilityIndexForTests();
  });

  function context(icsUrlPresent: boolean): ProbeContext {
    return {
      ...emptyProbeContext(),
      registeredToolNames: new Set(['google']),
      configValuePresent: (key: string) => icsUrlPresent && key === 'calendar.google.icsUrl',
    };
  }

  test('with a feed address configured the index reports a disagreement instead of a silent needs-setup', () => {
    const without = resolveCapabilityIndex(context(false), { homeDirectory: home });
    const withFeed = resolveCapabilityIndex(context(true), { homeDirectory: home });

    // Same machine, same routes, one setting different.
    expect(without.needsSetup).toContain('calendar.read');
    expect(withFeed.needsSetup).toContain('calendar.read');

    expect(without.disagreements.some((entry) => entry.capabilityId === 'calendar.read')).toBe(false);

    const flagged = withFeed.disagreements.find((entry) => entry.capabilityId === 'calendar.read');
    expect(flagged).toBeDefined();
    // The evidence names the feed, so the owner is told what was found rather
    // than being told the calendar is simply not set up.
    expect(flagged!.evidence.join(' ')).toContain('calendar.google.icsUrl');
  });
});
