/**
 * daemon-config-routing.test.ts
 *
 * The agent is a CLIENT of the daemon. Two failures happened on the same
 * evening and this file covers both directions:
 *
 *   WRITE, a Telegram bot username set here reported success, landed in
 *   `~/.goodvibes/agent/settings.json`, and configured nothing, because Telegram
 *   runs in the daemon and the daemon reads a different file.
 *
 *   READ, asked to confirm the same value, the agent read its OWN store, found
 *   a blank, and reported the setting as not set.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import {
  configKeyScope,
  isDaemonOwnedConfigKey,
} from '../../config/daemon-config-routing.ts';
import {
  describeHarnessSetting,
  formatHarnessSetting,
  redactHarnessSettingValue,
  setHarnessSetting,
} from '../../agent/harness-control.ts';
import { ensureDaemonConfigMigrated } from '../../config/ensure-daemon-config-migrated.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
function home(): string {
  const dir = makeProjectTempDir('gv-agent-routing');
  roots.push(dir);
  return dir;
}
function agentConfig(h: string): ConfigManager {
  return new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
}
function daemonStore(h: string): string {
  return join(h, '.goodvibes', 'daemon', 'settings.json');
}
function agentStore(h: string): string {
  return join(h, '.goodvibes', 'agent', 'settings.json');
}
function settingFor(config: ConfigManager, key: string) {
  const setting = config.getSchema().find((entry) => entry.key === key);
  if (!setting) throw new Error(`missing schema key ${key}`);
  return setting;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('the agent shares one ownership table with the rest of the platform', () => {
  test('daemon-owned and agent-owned keys are classified, not guessed', () => {
    expect(isDaemonOwnedConfigKey('surfaces.telegram.botUsername')).toBe(true);
    expect(configKeyScope('surfaces.telegram.botUsername')).toBe('daemon');
    expect(configKeyScope('watchers.triggers.enabled')).toBe('daemon');
    expect(configKeyScope('display.theme')).toBe('client');
    expect(configKeyScope('daemon.enabled')).toBe('client');
    expect(configKeyScope('provider.model')).toBe('user');
  });
});

describe('writes go to the store the acting runtime reads', () => {
  test('a daemon-owned setting written from the agent lands in the daemon store', async () => {
    const h = home();
    const config = agentConfig(h);

    const result = await setHarnessSetting(config, null, 'surfaces.telegram.botUsername', 'goodvibes_agent_bot', {
      daemonHomeDir: h,
    });

    expect(result.scope).toBe('daemon');
    expect(result.persistedTo).toBe(daemonStore(h));
    const stored = JSON.parse(readFileSync(daemonStore(h), 'utf-8')) as Record<string, Record<string, Record<string, unknown>>>;
    expect(stored['surfaces']!['telegram']!['botUsername']).toBe('goodvibes_agent_bot');
    // Not a copy in the agent's own store, one writer per key.
    const agentRaw = existsSync(agentStore(h))
      ? JSON.parse(readFileSync(agentStore(h), 'utf-8')) as Record<string, unknown>
      : {};
    expect(agentRaw['surfaces']).toBeUndefined();
  });

  test('an agent-owned setting stays in the agent store', async () => {
    const h = home();
    const config = agentConfig(h);
    const result = await setHarnessSetting(config, null, 'display.theme', 'nord', { daemonHomeDir: h });
    expect(result.scope).toBe('client');
    expect(result.persistedTo).toBe(config.getConfigPath());
    expect(existsSync(daemonStore(h))).toBe(false);
  });
});

describe('reads answer from the owning runtime', () => {
  test('a daemon-owned value written by another product is visible here', async () => {
    const h = home();
    // Stand in for the daemon (or the TUI) having set this.
    new ConfigManager({ homeDir: h, surfaceRoot: 'tui' })
      .set('surfaces.telegram.botUsername', 'goodvibes_agent_bot');

    const config = agentConfig(h);
    const descriptor = describeHarnessSetting(config, settingFor(config, 'surfaces.telegram.botUsername'));
    expect(descriptor.value).toBe('goodvibes_agent_bot');
    expect(descriptor.scope).toBe('daemon');
  });

  test('an unreachable daemon reports UNKNOWN, never the default', () => {
    const h = home();
    const config = agentConfig(h);
    const setting = settingFor(config, 'surfaces.telegram.botUsername');
    const descriptor = describeHarnessSetting(config, setting, {
      view: {
        get: () => undefined,
        describe: (key: string) => ({
          key,
          scope: 'daemon' as const,
          source: 'daemon' as const,
          status: 'unavailable' as const,
          store: 'http://127.0.0.1:3421',
          reason: 'daemon-owned',
          error: 'The daemon at http://127.0.0.1:3421 could not be reached (ECONNREFUSED).',
        }),
        unavailable: new Set(['surfaces.telegram.botUsername']),
        daemonError: 'ECONNREFUSED',
        daemonBaseUrl: 'http://127.0.0.1:3421',
      },
    });

    expect(descriptor.valueUnavailable).toBe(true);
    expect(descriptor.value).toBeUndefined();
    // And the rendered text says so rather than printing the default.
    const text = formatHarnessSetting(descriptor);
    expect(text).toContain('current UNKNOWN');
    expect(text).toContain('could not be reached');
  });
});

describe('startup migration', () => {
  test('moves daemon-owned values once and is idempotent', () => {
    const h = home();
    new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    // Seed the pre-migration layout: a daemon-owned value in a surface silo.
    //
    // This seeding MUST be synchronous. `ensureDaemonConfigMigrated` below
    // reads the file on the next statement with no await in between, and
    // `Bun.write` returns a promise. Constructing the ConfigManager above does
    // not create `.goodvibes/tui`, so `Bun.write` has to make the directory
    // first and cannot finish inline, in a warm process the migration then
    // read an absent file, found nothing to move, and returned null. That made
    // this test pass alone and fail intermittently in the full single-process
    // suite, where 700 files run before it.
    const tuiDir = join(h, '.goodvibes', 'tui');
    mkdirSync(tuiDir, { recursive: true });
    const tuiPath = join(tuiDir, 'settings.json');
    writeFileSync(tuiPath, JSON.stringify({ surfaces: { telegram: { botUsername: 'legacy_bot' } } }, null, 2));

    const first = ensureDaemonConfigMigrated(h);
    expect(first).toContain('Daemon-owned settings');
    expect(ensureDaemonConfigMigrated(h)).toBeNull();

    // And any surface now resolves it from the daemon store.
    const config = agentConfig(h);
    expect(config.get('surfaces.telegram.botUsername')).toBe('legacy_bot');
    expect(config.describeConfigKeySource('surfaces.telegram.botUsername').tier).toBe('daemon');
  });
});

describe('what counts as a credential in settings output', () => {
  test('a token VALUE is redacted but an identifier naming one is not', () => {
    // `discoveredBotTokenId` is the id of a discovered bot, not the bot token.
    // Redacting it hid the result of bot-identity discovery from the person who
    // asked for it.
    expect(redactHarnessSettingValue('surfaces.telegram.discoveredBotTokenId', '7891234'))
      .toBe('7891234');
    expect(redactHarnessSettingValue('surfaces.telegram.botUsername', 'goodvibes_agent_bot'))
      .toBe('goodvibes_agent_bot');
    expect(redactHarnessSettingValue('surfaces.slack.signingSecret', 'shhh')).toBe('<redacted>');
    expect(redactHarnessSettingValue('surfaces.discord.botToken', 'abc.def')).toBe('<redacted>');
    expect(redactHarnessSettingValue('surfaces.telegram.botToken', 'goodvibes://secrets/goodvibes/X'))
      .toBe('<secret-ref>');
  });
});

describe('daemon-owned keys the agent used to refuse outright', () => {
  test('relay and the listener toggle are writable now that they route', async () => {
    const h = home();
    const config = agentConfig(h);
    // The old lock refused these because the agent's copy was a dead snapshot.
    // They are daemon-owned and routed now, so refusing is the wrong answer.
    const relay = await setHarnessSetting(config, null, 'relay.enabled', true, { daemonHomeDir: h });
    expect(relay.scope).toBe('daemon');
    expect(relay.persistedTo).toBe(daemonStore(h));
    const listener = await setHarnessSetting(config, null, 'danger.httpListener', true, { daemonHomeDir: h });
    expect(listener.scope).toBe('daemon');
    expect(listener.persistedTo).toBe(daemonStore(h));
  });
});
