import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTuiLegacyImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';

const forbidden = async (): Promise<never> => { throw new Error('Unexpected mutation'); };

test('actual TUI keyboard route and direct tool registry both permit protected read status', async () => {
  const lines: string[] = []; const calls: string[] = []; const registry = new CommandRegistry();
  registerTuiLegacyImportCommands(registry, undefined, async () => ({
    binding: { endpoint: 'http://synthetic-host', projectId: 'project', workspaceId: '/workspace', principalKind: 'user', principalId: 'authenticated' },
    status: async () => { calls.push('status'); return null; },
    prepare: async () => ({ kind: 'blocked', code: 'invalid-source', reason: 'Synthetic test does not prepare' }),
    submit: forbidden, reconsider: forbidden, recover: forbidden, cancel: forbidden, restart: forbidden, dispose() {},
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

import { createLegacyImportHostFixture, IMPORT_FIXTURE_TOKEN, IMPORT_ROUTES } from '../helpers/legacy-import-host-fixture.ts';
import { pairImportProofHost, runTuiImportProof } from '../helpers/legacy-import-product-proof.ts';

async function nativeHost() {
  const host = createLegacyImportHostFixture();
  try { await pairImportProofHost(host); return host; } catch (error) { await host.stop(); throw error; }
}

test('TUI keyboard submits complete sources through the real SDK and registry status never resubmits', async () => {
  const f = await nativeHost();
  try {
    const output = await runTuiImportProof(f, ['submit', f.projectId]);
    expect(output).toContain('Legacy import request pending'); expect(output).toContain('Legacy import status: accepted');
    expect(output).toContain('Legacy sources are retained'); expect(output).not.toContain(IMPORT_FIXTURE_TOKEN);
    expect(f.commands).toHaveLength(1); expect(f.commandBytes[0]).toContain('exact-source-tail');
    expect(f.commands[0]?.manifest.sources).toEqual(f.prepared.manifest.sources);
    expect(f.requests.filter(request => request.path === IMPORT_ROUTES.sources)).toHaveLength(2);
    expect(await runTuiImportProof(f, ['status', f.projectId], 'registry')).toContain('Legacy import status: accepted');
    expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain('Legacy import status: accepted');
    expect(f.commands).toHaveLength(1); f.assertPreserved();
  } finally { await f.stop(); }
});

test('TUI lost acknowledgement survives a fresh opener; keyboard recovery retains the exact request', async () => {
  const f = await nativeHost();
  try {
    f.setReply('lost-ack'); expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain('Legacy import operation unavailable');
    const saved = f.read()!; expect(saved.state).toBe('unknown');
    expect(await runTuiImportProof(f, ['status', f.projectId])).toContain('Legacy import status: unknown');
    expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain('Legacy import status: unknown');
    expect(await runTuiImportProof(f, ['recover', f.projectId, 'different-request'])).toContain('does not match the saved command');
    expect(f.commands).toHaveLength(1);
    f.setReply('accepted'); expect(await runTuiImportProof(f, ['recover', f.projectId, saved.command.requestId])).toContain('Legacy import status: accepted');
    expect(f.commandBytes[1]).toBe(f.commandBytes[0]); expect(f.read()).toMatchObject({ state: 'accepted', attempts: 2, result: { kind: 'accepted', replayed: true } });
    expect(f.requests.filter(request => request.path === IMPORT_ROUTES.prepare)).toHaveLength(1); f.assertPreserved();
  } finally { await f.stop(); }
});

test('TUI keyboard reconsiders a host semantic refusal only for the selected request', async () => {
  const f = await nativeHost();
  try {
    f.setReply('decision'); expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain('Recorded Jev outcome: reject');
    const saved = f.read()!; expect(saved.state).toBe('pending');
    expect(await runTuiImportProof(f, ['reconsider', f.projectId, 'different-request'])).toContain('does not match the saved command');
    expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain('Legacy import status: pending');
    expect(f.commands).toHaveLength(1);
    f.setReply('accepted'); expect(await runTuiImportProof(f, ['reconsider', f.projectId, saved.command.requestId])).toContain('Legacy import status: accepted');
    expect(f.commandBytes[1]).toBe(f.commandBytes[0]); f.assertPreserved();
  } finally { await f.stop(); }
});

for (const fence of ['forged-flag', 'no-write-scope', 'revoked-after-prepare', 'store-replaced-before-send', 'store-replaced-after-send'] as const) test(`TUI import fences ${fence} using live private credentials`, async () => {
  const f = await nativeHost();
  try {
    if (fence === 'no-write-scope') f.setScopes(['read:work-ledger', 'read:knowledge']);
    if (fence === 'revoked-after-prepare') f.onRequest(path => { if (path === IMPORT_ROUTES.prepare) f.setScopes(['read:work-ledger', 'read:knowledge']); });
    if (fence === 'store-replaced-before-send') f.onRequest(path => { if (path === IMPORT_ROUTES.prepare) replaceNativeTestCredential(f.home); });
    if (fence === 'store-replaced-after-send') f.onRequest(path => { if (path === IMPORT_ROUTES.submit) replaceNativeTestCredential(f.home); });
    const output = await runTuiImportProof(f, ['submit', f.projectId, ...(fence === 'forged-flag' ? ['--yes'] : [])]);
    expect(output).toContain(fence === 'forged-flag' ? 'payload flags cannot authorize' : 'Legacy import operation unavailable');
    expect(output).not.toContain(IMPORT_FIXTURE_TOKEN);
    expect(f.commands).toHaveLength(fence === 'store-replaced-after-send' ? 1 : 0);
    if (fence === 'store-replaced-after-send') {
      expect(f.read()).toMatchObject({ state: 'unknown', attempts: 1 });
      // A fresh session may read its durable uncertainty but cannot replay implicitly.
      expect(await runTuiImportProof(f, ['status', f.projectId])).toContain('Legacy import status: unknown');
      expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain('Legacy import status: unknown');
      expect(f.commands).toHaveLength(1);
    } else expect(f.read()).toBeNull();
    if (fence === 'forged-flag') expect(f.requests).toHaveLength(0);
    if (fence === 'store-replaced-before-send') expect(f.requests.at(-1)?.path).toBe(IMPORT_ROUTES.prepare);
    f.assertPreserved();
  } finally { await f.stop(); }
});

for (const reply of ['decision', 'rejected'] as const) test(`TUI keyboard ${reply} requires selected cancellation or rejection before fresh preparation`, async () => {
  const f = await nativeHost();
  try {
    f.setReply(reply); await runTuiImportProof(f, ['submit', f.projectId]); const saved = f.read()!;
    if (reply === 'decision') {
      expect(await runTuiImportProof(f, ['restart', f.projectId, saved.command.requestId])).toContain('Only the selected rejected');
      expect(await runTuiImportProof(f, ['cancel', f.projectId, 'different-request'])).toContain('does not match the saved command');
      expect(await runTuiImportProof(f, ['cancel', f.projectId, saved.command.requestId])).toContain('Legacy import status: cancelled');
    }
    expect(await runTuiImportProof(f, ['restart', f.projectId, 'different-request'])).toContain('Only the selected rejected');
    expect(await runTuiImportProof(f, ['submit', f.projectId])).toContain(`Legacy import status: ${reply === 'decision' ? 'cancelled' : 'rejected'}`);
    expect(f.commands).toHaveLength(1);
    f.setReply('accepted'); expect(await runTuiImportProof(f, ['restart', f.projectId, saved.command.requestId])).toContain('Legacy import status: accepted');
    expect(f.commands[1]?.requestId).not.toBe(saved.command.requestId);
    expect(f.requests.filter(request => request.path === IMPORT_ROUTES.prepare)).toHaveLength(2); f.assertPreserved();
  } finally { await f.stop(); }
});

for (const boundary of ['prepare', 'submit'] as const) test(`TUI import ${boundary} rejects redirects without forwarding source or credentials`, async () => {
  const f = await nativeHost(); const escaped: string[] = [];
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { escaped.push(request.url); return Response.json({ unexpected: true }); } });
  try {
    f.redirect(IMPORT_ROUTES[boundary], `${other.url.origin}/must-not-receive-private-import`);
    const output = await runTuiImportProof(f, ['submit', f.projectId]);
    expect(output).toContain('Legacy import operation unavailable'); expect(escaped).toEqual([]);
    expect(f.commands).toHaveLength(0);
    if (boundary === 'submit') expect(f.read()).toMatchObject({ state: 'unknown', attempts: 1 }); else expect(f.read()).toBeNull();
    f.assertPreserved();
  } finally { await other.stop(true); await f.stop(); }
});
