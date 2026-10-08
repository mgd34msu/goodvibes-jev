import { expect, test } from 'bun:test';
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
