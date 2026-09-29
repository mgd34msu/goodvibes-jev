/**
 * config-change-events.test.ts
 *
 * The `config` runtime-event domain: key-level change notices, so a client
 * whose settings live in the daemon can subscribe to a change instead of
 * re-reading config on a timer.
 *
 * The two properties that matter, and the second is why this is not just a
 * convenience:
 *   - an ordinary setting's notice carries the new VALUE, so a subscriber can
 *     apply it without a round trip;
 *   - a credential-bearing key's notice carries the key NAME and nothing else,
 *     `secret: true`, and no `value` property at all. Not a nulled value, which
 *     a subscriber would read as "the credential was cleared".
 *
 * A declared secret-bearing key and any schema key are exact lookups; any
 * other watched key is read once through
 * `engine.runtime.config-event-credential-key`, and its value is carried only
 * on a no verdict at critical stakes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  attachConfigEmitBridge,
  listWatchableConfigPaths,
  toConfigEventValue,
  type ConfigChangeSource,
} from '../sdk/src/platform/runtime/config/index.ts';
import { clearConfigEventKeyReadings } from '../sdk/src/platform/runtime/config/emit-bridge.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { RUNTIME_EVENT_DOMAINS } from '../sdk/src/platform/runtime/events/index.ts';
import type { ConfigEvent } from '../sdk/src/platform/runtime/events/index.ts';
import { builtinGatewayEventDescriptors } from '../sdk/src/platform/control-plane/method-catalog-events.ts';
import { decisionPort } from './helpers/decision-port.ts';

/** A ConfigManager stand-in with the one seam the bridge uses. */
function fakeConfig(): ConfigChangeSource & { change(key: string, value: unknown): void; watched(): number } {
  const listeners = new Map<string, Set<(next: unknown, previous: unknown) => void>>();
  return {
    subscribe(key, callback) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(callback);
      return () => { listeners.get(key)?.delete(callback); };
    },
    change(key, value) {
      for (const callback of listeners.get(key) ?? []) callback(value, undefined);
    },
    watched: () => listeners.size,
  };
}

/** Collect config-domain events; bus dispatch is via queueMicrotask, so flush after. */
function collector(bus: RuntimeEventBus): ConfigEvent[] {
  const seen: ConfigEvent[] = [];
  bus.onDomain('config', (envelope) => { seen.push(envelope.payload as ConfigEvent); });
  return seen;
}

async function flush(): Promise<void> {
  // Two macrotask hops comfortably drains the queued microtask dispatch.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A port reading each key through `probability` (of holding a credential), recording every request. */
function keyPort(probability: (key: string) => number) {
  return decisionPort(['engine.runtime.config-event-credential-key'], (name: string, _question: Question, state: EntryType) => {
    if (name !== 'credential') throw new Error(`config key port: unexpected question ${name}`);
    return noulAnswer(probability((state as { key: string }).key));
  });
}

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(undefined);
  clearConfigEventKeyReadings();
});
afterEach(() => {
  installJudgmentPort(previousPort);
  clearConfigEventKeyReadings();
});

describe('the config event domain exists and is documented', () => {
  test('`config` is a real runtime event domain', () => {
    expect([...RUNTIME_EVENT_DOMAINS]).toContain('config');
  });

  test('the catalog describes it, and says values are withheld for secret keys', () => {
    const descriptor = builtinGatewayEventDescriptors.find((entry) => entry.id === 'runtime.config');
    expect(descriptor).toBeDefined();
    expect(descriptor?.domains).toEqual(['config']);
    expect(descriptor?.transport).toEqual(['sse', 'ws']);
    expect(descriptor?.description).toContain('secret');
  });
});

describe('attachConfigEmitBridge', () => {
  test('an ordinary setting changing emits the key, its scope and its new value', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, now: () => 1_700_000_000_000 });

    config.change('voice.wake.enabled', true);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'CONFIG_KEY_CHANGED',
      key: 'voice.wake.enabled',
      secret: false,
      value: true,
      changedAt: 1_700_000_000_000,
    });
    detach();
  });

  test('a daemon-owned key is reported as daemon-scoped, a client-owned one as client', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('watchers.enabled', false);
    config.change('voice.wake.enabled', true);
    await flush();

    const byKey = new Map(seen.map((event) => [event.key, event]));
    expect(byKey.get('watchers.enabled')?.scope).toBe('daemon');
    expect(byKey.get('voice.wake.enabled')?.scope).toBe('client');
    detach();
  });

  test('a credential-bearing key travels by NAME ONLY: no value property at all', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('surfaces.telegram.botToken', 'a-real-looking-bot-token');
    await flush();

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event.key).toBe('surfaces.telegram.botToken');
    expect(event.secret).toBe(true);
    // Absent, not null: a null would read as "the credential was cleared".
    expect(Object.hasOwn(event, 'value')).toBe(false);
    expect(JSON.stringify(event)).not.toContain('a-real-looking-bot-token');
    detach();
  });

  test('detaching stops the notices, so a torn-down bus is never emitted into', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('voice.wake.enabled', true);
    detach();
    config.change('voice.wake.enabled', false);
    await flush();

    expect(seen).toHaveLength(1);
  });

  test('a product may name extra keys the platform set does not', async () => {
    installJudgmentPort(keyPort(() => 0.03).port);
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.customSetting'] });

    config.change('acme.customSetting', 'on');
    await flush();

    expect(seen.map((event) => event.key)).toEqual(['acme.customSetting']);
    detach();
  });
});

describe('an undeclared key is read through engine.runtime.config-event-credential-key', () => {
  test('a no verdict carries the value; the key is read once for every change', async () => {
    const { port, requests } = keyPort(() => 0.03);
    installJudgmentPort(port);
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.theme'] });

    config.change('acme.theme', 'dark');
    config.change('acme.theme', 'light');
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toMatchObject({ key: 'acme.theme' });
    expect(seen.map((event) => [event.secret, event.value])).toEqual([[false, 'dark'], [false, 'light']]);
    detach();
  });

  test('a reading another file started in the background does not count as this file\'s request', async () => {
    const { port, requests } = keyPort(() => 0.03);
    installJudgmentPort(port);
    const bus = new RuntimeEventBus();
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.theme'] });

    // What a leaked background reading looks like when it lands on this port.
    const stray = port.ask({ state: 'x', questions: { credential: { type: 'noul', instructions: 'q' } } as never, context: { battery: 'engine.state.watched-config' } })
      .then(() => 'answered', (error: unknown) => String(error));
    config.change('acme.theme', 'dark');
    await flush();

    expect(await stray).toContain('engine.state.watched-config');
    expect(requests).toHaveLength(1);
    detach();
  });

  test('a yes leaves the value out', async () => {
    installJudgmentPort(keyPort(() => 0.95).port);
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.deployPhrase'] });

    config.change('acme.deployPhrase', 'correct horse battery staple');
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.secret).toBe(true);
    expect(Object.hasOwn(seen[0]!, 'value')).toBe(false);
    detach();
  });

  test('a no short of the critical band leaves the value out', async () => {
    installJudgmentPort(keyPort(() => 0.12).port);
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.feedAddress'] });

    config.change('acme.feedAddress', 'https://feeds.example.com/private/abc123');
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.secret).toBe(true);
    expect(JSON.stringify(seen[0])).not.toContain('abc123');
    detach();
  });

  test('with no port installed the notice still goes out, without the value', async () => {
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus, additionalKeys: ['acme.deployPhrase'] });

    config.change('acme.deployPhrase', 'correct horse battery staple');
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.secret).toBe(true);
    expect(Object.hasOwn(seen[0]!, 'value')).toBe(false);
    detach();
  });

  test('schema keys and declared secret keys are never read', async () => {
    const { port, requests } = keyPort(() => 0.5);
    installJudgmentPort(port);
    const bus = new RuntimeEventBus();
    const seen = collector(bus);
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });

    config.change('voice.wake.enabled', true);
    config.change('surfaces.telegram.botToken', 'a-real-looking-bot-token');
    await flush();

    expect(requests).toHaveLength(0);
    expect(seen.map((event) => event.secret)).toEqual([false, true]);
    detach();
  });
});

describe('the watched surface', () => {
  test('covers the declared schema keys plus the daemon-owned non-schema paths', () => {
    const paths = listWatchableConfigPaths();
    expect(paths).toContain('watchers.enabled');
    // A daemon-owned path with no scalar schema entry, the class that every
    // owned-set walk used to miss.
    expect(paths).toContain('email.passwordRef');
    // A declared credential-bearing path.
    expect(paths).toContain('surfaces.telegram.botToken');
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('subscribing the whole surface is what makes an EXTERNAL file edit fire', () => {
    // The manager's reload diff walks the keys something subscribed to, so a
    // key nobody watched was never compared. The bridge subscribing everything
    // is the mechanism, so assert the subscription count matches the surface.
    const bus = new RuntimeEventBus();
    const config = fakeConfig();
    const detach = attachConfigEmitBridge({ config, bus });
    expect(config.watched()).toBe(listWatchableConfigPaths().length);
    detach();
  });
});

describe('toConfigEventValue', () => {
  test('passes JSON-shaped values through', () => {
    expect(toConfigEventValue(true)).toBe(true);
    expect(toConfigEventValue('x')).toBe('x');
    expect(toConfigEventValue(null)).toBe(null);
    expect(toConfigEventValue(['a', 'b'])).toEqual(['a', 'b']);
    expect(toConfigEventValue({ a: 1 })).toEqual({ a: 1 });
  });

  test('drops what cannot survive the wire rather than coercing it into prose', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(toConfigEventValue(cyclic)).toBeUndefined();
    expect(toConfigEventValue(undefined)).toBeUndefined();
  });
});
