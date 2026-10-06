import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTuiLegacyImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';

test('actual TUI keyboard route and direct tool registry both permit protected read status', async () => {
  const lines: string[] = []; const calls: string[] = []; const registry = new CommandRegistry();
  registerTuiLegacyImportCommands(registry, undefined, async () => ({
    binding: { endpoint: 'http://synthetic-host', projectId: 'project', workspaceId: '/workspace', principalKind: 'user', principalId: 'authenticated' },
    status: async () => { calls.push('status'); return null; },
    prepare: async () => ({ kind: 'blocked', code: 'invalid-source', reason: 'Synthetic test does not prepare' }), dispose() {},
  }));
  const context = { print: (line: string) => lines.push(line), workspace: {} } as unknown as CommandContext;
  await registry.execute('work-import', ['status', 'project'], context); expect(lines[0]).toContain('No saved legacy import for selected project.');
  expect(lines[0]?.split('\n')[0]).toBe('No saved legacy import for selected project.');
  const state: CommandModeRouteState = { commandMode: true, prompt: '/work-import status project', cursorPos: 0, autocomplete: null, modalStack: ['command'], commandRegistry: registry, commandContext: context, conversationManager: null, requestRender() {}, handleEscape() {}, projectRoot: '/workspace', pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 1, nextImageId: 1, saveUndoState() {}, ensureInputCursorVisible() {} };
  expect(handleCommandModeToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false })).toBe(true);
  const deadline = Date.now() + 2000; while (lines.length < 2 && Date.now() < deadline) await Bun.sleep(1);
  expect(lines[1]).toContain('No saved legacy import for selected project.'); expect(calls).toEqual(['status', 'status']);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '../../runtime/index.ts';
import { pairNativeTestHost, replaceNativeTestCredential } from '../helpers/native-host-pairing.ts';
import { tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';

for (const mode of ['paired-read-only', 'global-only', 'store-replaced', 'home-changed', 'endpoint-changed'] as const) test(`legacy import ${mode} uses only its captured TUI credential and retains read scopes`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'tui-legacy-host-')); const other = join(home, 'other'); mkdirSync(other);
  const lines: string[] = []; const requests: string[] = [];
  let selectedHome = home; let baseUrl = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    expect(request.headers.get('authorization')).toBe('Bearer legacy-private-token');
    if (mode === 'store-replaced') replaceNativeTestCredential(home);
    if (mode === 'home-changed') selectedHome = other;
    if (mode === 'endpoint-changed') baseUrl = 'http://127.0.0.1:1';
    return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
      principalId: 'read-only-principal', principalKind: 'user', admin: true, scopes: ['read:work-ledger', 'read:knowledge'], roles: [] });
  } });
  baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    if (mode !== 'global-only') await pairNativeTestHost(home, baseUrl, 'legacy-private-token');
    await pairNativeTestHost(other, baseUrl, 'legacy-private-token');
    mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(home, 'operator-tokens.json'), JSON.stringify({ token: 'global-override-token' }));
    writeFileSync(join(home, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'global-token' }));
    const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? baseUrl : undefined } as unknown as ConfigManager;
    const registry = new CommandRegistry(); registerTuiLegacyImportCommands(registry, home);
    const context = { platform: { configManager }, workspace: { get shellPaths() { return createShellPathService({ workingDirectory: home, homeDirectory: selectedHome }); } }, print: (line: string) => lines.push(line) } as unknown as CommandContext;
    await registry.execute('work-import', ['status', 'project'], context);
    if (mode === 'paired-read-only') {
      expect(lines.join('\n')).toContain('No saved legacy import for selected project');
      expect(lines.join('\n')).toContain('read-only-principal'); expect(requests).toEqual(['/api/control-plane/auth', '/api/control-plane/auth']);
    } else {
      expect(lines.join('\n')).toContain('Legacy import read unavailable');
      expect(requests).toEqual(mode === 'global-only' ? [] : ['/api/control-plane/auth']);
    }
    if (mode === 'global-only') expect(existsSync(tuiHostPairingStorePath(home))).toBe(false);
    expect(lines.join('\n')).not.toContain('legacy-private-token'); expect(lines.join('\n')).not.toContain('global-token');
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
