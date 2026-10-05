import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { CONFIG_SCHEMA_ENTRIES } from '../../src/lib/generated/config-schema';
import { createTerminalThemeHost, themeConfigRequest, type TerminalThemeHost } from './terminal-theme-host';

const hosts: TerminalThemeHost[] = [];
function host(saved?: string) {
  const next = createTerminalThemeHost(saved);
  hosts.push(next);
  return next;
}
afterEach(() => { for (const item of hosts.splice(0)) item.cleanup(); });

const themeSchema = CONFIG_SCHEMA_ENTRIES.find(entry => entry.key === 'display.theme')!;

describe('terminal theme through real config dispatcher, handler and storage', () => {
  test('fresh default and every generated option round-trip in the host-local file', async () => {
    const fixture = host();
    expect(themeSchema.type).toBe('enum');
    expect(themeSchema.default).toBe('goodvibes');
    expect(themeSchema.enumValues).toHaveLength(13);
    const initial = await fixture.dispatch(themeConfigRequest('GET'));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ display: { theme: 'goodvibes', themeMode: 'auto' } });
    for (const theme of themeSchema.enumValues ?? []) {
      const response = await fixture.dispatch(themeConfigRequest('POST', { key: 'display.theme', value: theme }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, key: 'display.theme', value: theme, persistedTo: fixture.settingsPath, daemonOwned: false });
      fixture.reload();
      expect(await (await fixture.dispatch(themeConfigRequest('GET'))).json()).toMatchObject({ display: { theme, themeMode: 'auto' } });
      expect(fixture.persisted()).toMatchObject({ display: { theme } });
      expect(fixture.siblingTheme()).toBe('goodvibes');
      expect(existsSync(fixture.daemonTierPath)).toBe(false);
    }
  });

  for (const theme of ['vaporwave', 'nord', ' NoRd ']) {
    test(`saved ${JSON.stringify(theme)} retains disk bytes while adapting recognized read spelling`, async () => {
      const fixture = host(theme);
      const before = readFileSync(fixture.settingsPath, 'utf8');
      const current = theme.trim().toLowerCase();
      expect(await (await fixture.dispatch(themeConfigRequest('GET'))).json()).toMatchObject({ display: { theme: current, themeMode: 'light' } });
      fixture.reload();
      expect(fixture.manager.get('display.theme')).toBe(current);
      expect(readFileSync(fixture.settingsPath, 'utf8')).toBe(before);
      expect(fixture.requests.every(request => request.method === 'GET')).toBe(true);
    });
  }

  test('unknown names, wrong types and noncanonical new spellings reject without changing storage', async () => {
    const fixture = host('vaporwave');
    const before = readFileSync(fixture.settingsPath, 'utf8');
    for (const value of ['not-a-theme', ' NoRd ', 'NORD', '', false, 9, null, { name: 'nord' }]) {
      const response = await fixture.dispatch(themeConfigRequest('POST', { key: 'display.theme', value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error');
      fixture.reload();
      expect(fixture.manager.get('display.theme')).toBe('vaporwave');
      expect(readFileSync(fixture.settingsPath, 'utf8')).toBe(before);
    }
  });

  test('concurrent requests across hosts restore the exact prior judgment port', async () => {
    const first = host('vaporwave');
    const second = host('nord');
    const sentinel = fakePort(() => { throw new Error('Fixture leaked into the prior judgment port'); });
    const previous = installJudgmentPort(sentinel.port);
    try {
      const reads = await Promise.all([
        first.dispatch(themeConfigRequest('GET')),
        second.dispatch(themeConfigRequest('GET')),
      ]);
      expect(reads.map(response => response.status)).toEqual([200, 200]);
      expect(judgmentPort('terminal-theme concurrent reads')).toBe(sentinel.port);
      const before = readFileSync(second.settingsPath, 'utf8');
      const [read, rejected] = await Promise.all([
        first.dispatch(themeConfigRequest('GET')),
        second.dispatch(themeConfigRequest('POST', { key: 'display.theme', value: 'not-a-theme' })),
      ]);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ display: { theme: 'vaporwave' } });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toHaveProperty('error');
      second.reload();
      expect(second.manager.get('display.theme')).toBe('nord');
      expect(readFileSync(second.settingsPath, 'utf8')).toBe(before);
      expect(judgmentPort('terminal-theme concurrent rejection')).toBe(sentinel.port);
      expect(sentinel.requests).toEqual([]);
    } finally {
      installJudgmentPort(previous);
    }
  });

  test('admin refusal and authoritative reload report the actual host state', async () => {
    const fixture = host('nord');
    fixture.setWriteAccess(false);
    const refused = await fixture.dispatch(themeConfigRequest('POST', { key: 'display.theme', value: 'dracula' }));
    expect(refused.status).toBe(403);
    expect(fixture.manager.get('display.theme')).toBe('nord');
    fixture.replaceSavedTheme('solarized');
    expect(await (await fixture.dispatch(themeConfigRequest('GET'))).json()).toMatchObject({ display: { theme: 'solarized', themeMode: 'light' } });
  });
});
