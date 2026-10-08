import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { registerOwnedMailInbox } from '../../runtime/owned-inbox-mail.js';
import type { DaemonInboxControls } from '../../runtime/daemon-handler-composition.js';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { RoutingRegistration } from '../../daemon/handlers/index.js';

function fixture() {
  const config = new Set<() => void>(); const secrets = new Set<(key: string) => void>();
  let reads = 0;
  return { config, secrets, reads: () => reads,
    input: { configManager: { get: () => undefined, onDidInvalidate(fn: () => void) { config.add(fn); return () => { config.delete(fn); }; } },
      secretsManager: { get: async () => { reads++; return null; }, onDidChange(fn: (key: string) => void) { secrets.add(fn); return () => { secrets.delete(fn); }; } } } };
}
const context = {} as HandlerContext, routing = {} as RoutingRegistration;
const controls = { gatePolling() {} };

test('ignored constructor capability acquires no mail subscriptions or credentials', async () => {
  const f = fixture(); let retired = 0;
  const registration = await registerOwnedMailInbox(() => ({ async close() { retired++; } }), context, routing, controls, f.input);
  expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
  const closing = registration.close(); expect(registration.close()).toBe(closing); await closing;
  expect(retired).toBe(1); expect(f.reads()).toBe(0);
});

test('factory failure closes every constructed mail service without credential reads', async () => {
  const f = fixture();
  await expect(registerOwnedMailInbox((_ctx, _routing, capability) => {
    capability.createEmailService!(); capability.createEmailService!();
    expect(f.config.size).toBe(2); expect(f.secrets.size).toBe(2);
    throw new Error('Synthetic constructor failure');
  }, context, routing, controls, f.input)).rejects.toThrow('constructor failure');
  expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0); expect(f.reads()).toBe(0);
});

test('surface cleanup failure still retires mail; stale constructors cannot resurrect it', async () => {
  const f = fixture(); let captured: DaemonInboxControls | undefined;
  const registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
    captured = capability; const mail = capability.createEmailService!();
    expect(Object.keys(mail)).toEqual(['service', 'close']);
    return { async close() { throw new Error('Synthetic cleanup failure'); } };
  }, context, routing, controls, f.input);
  await expect(registration.close()).rejects.toThrow('cleanup failure');
  expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
  expect(() => captured!.createEmailService!()).toThrow('retired'); expect(f.reads()).toBe(0);
});

test('repeated construction and shutdown leave no accumulated source subscriptions', async () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) {
    const registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
      const mail = capability.createEmailService!(); return { async close() { mail.close(); mail.close(); } };
    }, context, routing, controls, f.input);
    expect(f.config.size).toBe(1); expect(f.secrets.size).toBe(1); await registration.close();
    expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
  }
});

test('second subscription failure rolls back the first acquired subscription', async () => {
  const f = fixture();
  f.input.secretsManager.onDidChange = () => { throw new Error('Synthetic subscribe failure'); };
  await expect(registerOwnedMailInbox((_ctx, _routing, capability) => {
    capability.createEmailService!(); return { async close() {} };
  }, context, routing, controls, f.input)).rejects.toThrow('subscribe failure');
  expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
});

test('throwing config unsubscribe still attempts secret subscription cleanup', async () => {
  const f = fixture();
  f.input.configManager.onDidInvalidate = listener => { f.config.add(listener); return () => { f.config.delete(listener); throw new Error('Synthetic unsubscribe failure'); }; };
  const registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
    capability.createEmailService!(); return { async close() {} };
  }, context, routing, controls, f.input);
  await expect(registration.close()).rejects.toThrow('mail lifetimes');
  expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
});

test('real account lifecycle reports config and aliased secret ABA changes without exposing keys or values', async () => {
  const root = makeOwnedTempDir('inbox-account-lifecycle');
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const configManager = new ConfigManager({ configDir: join(root, 'config'), homeDir: home, workingDir: workspace, surfaceRoot: 'tui' });
  const secretsManager = new SecretsManager({ projectRoot: workspace, globalHome: home, surfaceRoot: 'tui', policy: 'require_secure' });
  const secretReads = spyOn(secretsManager, 'get');
  const observed: unknown[][] = [];
  let captured: DaemonInboxControls | undefined;
  let stop: (() => void) | undefined;
  let registration: Awaited<ReturnType<typeof registerOwnedMailInbox>> | undefined;
  try {
    registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
      captured = capability;
      stop = capability.onAccountInvalidation!((...args: unknown[]) => { observed.push(args); });
      return { async close() {} };
    }, context, routing, controls, { configManager, secretsManager });
    expect(Object.keys(captured!).sort()).toEqual(['createEmailService', 'gatePolling', 'onAccountInvalidation']);
    expect(secretReads).not.toHaveBeenCalled();
    const initial = observed.length;
    configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC-ONE');
    configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC-TWO');
    configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC-ONE');
    configManager.load();
    expect(observed.length).toBe(initial + 4);
    // An alias target is intentionally not the canonical Slack/email key.
    const beforeSecrets = observed.length;
    for (const value of ['synthetic-first', 'synthetic-second', 'synthetic-first']) {
      await secretsManager.set('SYNTHETIC_ALIAS_TARGET', value);
    }
    expect(observed.length).toBe(beforeSecrets + 3);
    expect(observed.every(args => args.length === 0)).toBe(true);
    expect(secretReads).not.toHaveBeenCalled();
    const beforeClose = observed.length;
    const closing = registration.close();
    expect(registration.close()).toBe(closing);
    await closing;
    stop!(); stop!();
    configManager.load(); await secretsManager.set('SYNTHETIC_ALIAS_TARGET', 'synthetic-after-close');
    expect(observed).toHaveLength(beforeClose);
    expect(() => captured!.onAccountInvalidation!(() => {})).toThrow('retired');
    expect(secretReads).not.toHaveBeenCalled();
  } finally {
    await registration?.close();
    secretReads.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('account subscription close is idempotent and owned root close retires remaining subscriptions', async () => {
  const f = fixture(); let notifications = 0, configStops = 0, secretStops = 0;
  f.input.configManager.onDidInvalidate = listener => {
    f.config.add(listener); return () => { configStops++; f.config.delete(listener); };
  };
  f.input.secretsManager.onDidChange = listener => {
    f.secrets.add(listener); return () => { secretStops++; f.secrets.delete(listener); };
  };
  let stop: (() => void) | undefined;
  const registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
    stop = capability.onAccountInvalidation!(() => { notifications++; });
    capability.onAccountInvalidation!(() => { notifications++; });
    return { async close() {} };
  }, context, routing, controls, f.input);
  expect(f.config.size).toBe(2); expect(f.secrets.size).toBe(2);
  stop!(); stop!();
  expect(configStops).toBe(1); expect(secretStops).toBe(1);
  for (const listener of f.secrets) listener('SYNTHETIC_ALIAS_TARGET');
  expect(notifications).toBe(1);
  const closing = registration.close(); expect(registration.close()).toBe(closing); await closing;
  expect(configStops).toBe(2); expect(secretStops).toBe(2);
  expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0); expect(f.reads()).toBe(0);
});

test('partial account subscription acquisition failure releases its first listener exactly once', async () => {
  const f = fixture(); let stopped = 0;
  f.input.configManager.onDidInvalidate = listener => {
    f.config.add(listener); return () => { stopped++; f.config.delete(listener); };
  };
  f.input.secretsManager.onDidChange = () => { throw new Error('Synthetic account subscription failure'); };
  await expect(registerOwnedMailInbox((_ctx, _routing, capability) => {
    capability.onAccountInvalidation!(() => {});
    return { async close() {} };
  }, context, routing, controls, f.input)).rejects.toThrow('account subscription failure');
  expect(stopped).toBe(1); expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
  expect(f.reads()).toBe(0);
});

test('throwing account config cleanup still disposes its secret subscription and sibling mail owner', async () => {
  const f = fixture(); let stops = 0;
  f.input.configManager.onDidInvalidate = listener => {
    f.config.add(listener); return () => { stops++; f.config.delete(listener); throw new Error('Synthetic cleanup failure'); };
  };
  const registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
    capability.createEmailService!();
    capability.onAccountInvalidation!(() => {});
    return { async close() {} };
  }, context, routing, controls, f.input);
  const closing = registration.close(); expect(registration.close()).toBe(closing);
  await expect(closing).rejects.toThrow('mail lifetimes');
  expect(stops).toBe(2); expect(f.config.size).toBe(0); expect(f.secrets.size).toBe(0);
});

test('legacy controls and managers without lifecycle subscriptions remain accepted without invented capability', async () => {
  let captured: DaemonInboxControls | undefined;
  const registration = await registerOwnedMailInbox((_ctx, _routing, capability) => {
    captured = capability;
    capability.gatePolling('slack', { async start() {}, async stop() {} });
    return { async close() {} };
  }, context, routing, controls, { configManager: { get: () => undefined }, secretsManager: { get: async () => null } });
  expect(captured!.gatePolling).toBe(controls.gatePolling);
  expect(captured!.gatePollingOwned).toBeUndefined();
  expect(captured!.onAccountInvalidation).toBeUndefined();
  await registration.close();
});
