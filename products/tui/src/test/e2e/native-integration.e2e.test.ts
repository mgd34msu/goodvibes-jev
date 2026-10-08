/** Exact compiled TUI artifact, real tmux PTY, and the engine-owned native HTTP fixture. */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkExecutionClient, type NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { beginTuiHostPairing, completeTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { launchNativeIntegrationHost } from '../helpers/native-integration-host.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { inputAreaVisible, launchTui, makeHome, screenText, startHomeDaemonServer, startStubModel, type TuiSession } from './harness.ts';

function assertReadOnlyExecution(paths: readonly string[]): void {
  const mutations = paths.filter(path => /\/(start|resume|cancel)$/.test(path));
  if (mutations.length) throw new Error(`Unexpected native execution mutation attempts: ${mutations.join(', ')}`);
}

function live(snapshot: NativeWorkExecutionSnapshot) {
  if (snapshot.kind !== 'execution' || snapshot.integration?.state !== 'live') throw new Error('Expected real live native integration');
  return snapshot.integration;
}

async function fixture(withoutInspection = false) {
  const host = launchNativeIntegrationHost(withoutInspection);
  const { model, home } = await (async () => {
    let model: ReturnType<typeof startStubModel> | undefined;
    try {
      model = startStubModel(() => ({ text: 'Unexpected native inspection model request' }));
      return { model, home: await makeHome(model) };
    } catch (error) {
      const cleanup = await Promise.allSettled([host.stop(), Promise.resolve().then(() => model?.stop())]);
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], 'Native fixture home setup and cleanup failed');
      throw error;
    }
  })();
  let tui: TuiSession | undefined;
  let proxy: Bun.Server<undefined> | undefined;
  let client: ReturnType<typeof createOperatorNativeWorkExecutionClient> | undefined;
  try {
    const ready = await host.ready();
    const networkViolations = join(home.root, 'network-violations.log');
    const guard = resolve(import.meta.dir, '../../../../../packages/engine/scripts/test-network-preload.ts');
    writeFileSync(join(home.workspace, 'bunfig.toml'), `preload = [${JSON.stringify(guard)}]\n`);
    const tuiDir = join(home.home, '.goodvibes/tui');
    const now = Date.now();
    writeFileSync(join(tuiDir, 'onboarding-checked.json'), JSON.stringify({ version: 1, checkedAt: now, updatedAt: now, source: 'e2e' }));
    const configManager = new TuiConfigManager({ configDir: tuiDir, homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
    seedProviderMetadataCacheFixture({ configManager, homeDirectory: home.home, workingDirectory: home.workspace });
    const allowed = new Set(['/api/work-ledger/snapshot', '/api/work-ledger/history', '/api/work-ledger/execution/status', '/api/work-ledger/execution/cancel']);
    const paths: string[] = [];
    // Bind the owned listener first, then configure discovery and the explicit origin.
    // Background shell routes are refused locally, never forwarded as mutations.
    proxy = await startHomeDaemonServer(home, async request => {
      const url = new URL(request.url);
      // Record rejected attempts too: the firewall cannot stand in for the
      // product's read-only guarantee or hide an accidental start/resume.
      paths.push(url.pathname);
      if (!allowed.has(url.pathname)) return new Response('Owned inspection fixture has no background service', { status: 404 });
      return fetch(`${ready.baseUrl}${url.pathname}${url.search}`, { method: request.method, headers: request.headers,
        body: request.method === 'POST' ? await request.arrayBuffer() : undefined, redirect: 'error' });
    });
    const origin = proxy.url.origin;
    const attempt = { attemptId: 'synthetic-native-pty-pairing', name: 'Owned native PTY fixture', startedAt: now };
    expect((await beginTuiHostPairing(home.home, origin, attempt)).status).toBe('begun');
    expect((await completeTuiHostPairing(home.home, origin, attempt.attemptId, {
      token: ready.token, tokenId: 'synthetic-native-pty-token', name: attempt.name, createdAt: now,
    })).status).toBe('paired');
    home.setTuiSetting('controlPlane.publicBaseUrl', origin);
    home.setTuiSetting('daemon.enabled', true);
    const sdk = createOperatorSdk({ baseUrl: ready.baseUrl, authToken: ready.token, retry: { maxAttempts: 1 } });
    client = createOperatorNativeWorkExecutionClient(sdk, 'project');
    const start = async () => {
      tui = launchTui(home, { cols: 180, rows: 55, env: { GOODVIBES_TEST_NETWORK_VIOLATIONS: networkViolations } });
      await tui.waitForScreen('compiled native input area', inputAreaVisible, 45_000);
      return tui;
    };
    const open = async () => {
      tui!.type('/work project'); tui!.key('Enter');
      await tui!.waitForScreen('authenticated native Work control', screen => screen.includes('Native Work') && screen.includes(`Control ${ready.identity.workId}:`), 15_000);
    };
    const close = async () => {
      tui!.key('Escape');
      await tui!.waitForScreen('native modal detached', screen => !screen.includes('Native Work') && inputAreaVisible(screen), 10_000);
    };
    const integration = () => { for (let i = 0; i < 5; i++) tui!.key('Right'); };
    const status = () => { tui!.key('Down'); tui!.type('i'); integration(); };
    let lastRefreshOrdinal = 0;
    const refresh = async () => {
      tui!.key('Right');
      const before = paths.length;
      await host.holdStatus(); status(); const ordinal = await host.heldStatus();
      expect(ordinal).toBeGreaterThan(lastRefreshOrdinal);
      expect(paths.slice(before).filter(path => path.startsWith('/api/work-ledger/execution/'))).toEqual(['/api/work-ledger/execution/status']);
      // An unchanged unavailable/live header can belong to the preceding read.
      // Observe this request's actual pending frame before releasing its reply.
      await tui!.waitForScreen('fresh native status pending', screen => screenText(screen).includes('native request is pending'), 10_000);
      expect(await host.releaseStatus()).toBe(ordinal);
      await tui!.waitForScreen('fresh native status resolved', screen => screen.includes('Integration: live') || screen.includes('Integration unavailable:'), 10_000);
      lastRefreshOrdinal = ordinal;
    };
    const snapshot = () => client!.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
    const assertPrivate = () => { expect(tui!.rawOutput()).not.toContain(ready.token); expect(tui!.screen()).not.toContain(ready.token); };
    return { host, home, ready, start, open, close, integration, status, refresh, snapshot, paths, assertPrivate,
      terminal: () => tui!,
      async probeRejectedMutation(operation: 'start' | 'resume') {
        const response = await fetch(`${origin}/api/work-ledger/execution/${operation}`, {
          method: 'POST', headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' }, body: '{}',
        });
        expect(response.status).toBe(404);
      },
      async restart() {
        const current = tui!;
        try { assertPrivate(); } finally { current.stop(); tui = undefined; }
        return start();
      },
      async stop(primaryError?: unknown) {
        const errors: unknown[] = [];
        const attempt = async (action: () => unknown | Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
        let output = ''; let screen = ''; let violations = '';
        await attempt(() => { if (tui) { output = tui.rawOutput(); screen = tui.screen(); } });
        // Every owned resource is reaped even if capture, privacy, or an earlier
        // disposer fails. Assertions happen only after all cleanup was attempted.
        await attempt(() => tui?.stop()); tui = undefined;
        await attempt(() => client?.dispose());
        await attempt(() => proxy?.stop(true));
        await attempt(() => host.stop());
        await attempt(() => model.stop());
        await attempt(() => { violations = existsSync(networkViolations) ? readFileSync(networkViolations, 'utf8') : ''; });
        await attempt(() => rmSync(home.root, { recursive: true, force: true }));
        await attempt(() => { expect(output).not.toContain(ready.token); expect(screen).not.toContain(ready.token); });
        await attempt(() => { expect(model.requests).toEqual([]); expect(violations).toBe(''); });
        if (errors.length) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Compiled native assertion or owned cleanup failed');
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([Promise.resolve().then(() => tui?.stop()), Promise.resolve().then(() => client?.dispose()),
      Promise.resolve().then(() => proxy?.stop(true)), host.stop(), Promise.resolve().then(() => model.stop())]);
    rmSync(home.root, { recursive: true, force: true });
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures], 'Native fixture setup and cleanup failed');
    throw error;
  }
}

/** Collect actual current panes while scrolling; never render source cell grids. */
async function scrollUntil(tui: TuiSession, label: string, predicate: (text: string, panes: readonly string[]) => boolean, limit = 180): Promise<string> {
  let text = ''; const panes: string[] = [];
  for (let step = 0; step < limit; step++) {
    const pane = tui.screen(); panes.push(pane);
    text += `\n${screenText(pane)}`;
    if (predicate(text, panes)) return text;
    tui.key('Down');
    const moved = await tui.waitForScreen('native scroll frame advances', screen => screen !== pane, 2_000).catch(() => undefined);
    if (!moved) break;
  }
  throw new Error(`Compiled native view did not expose ${label}\n${tui.screen()}`);
}

const unwrapped = (text: string): string => text.replace(/\s+/g, '');

/** Follow a long value through ordered, overlapping actual pane captures.
 * A path can be taller than the viewport. Require each extension to retain
 * the preceding 16 visible characters, without inserting headers between it.
 */
function visiblePrefix(panes: readonly string[], value: string): number {
  const expected = unwrapped(value);
  let observed = 0;
  for (const pane of panes) {
    const text = unwrapped(pane);
    const start = Math.max(0, observed - 16);
    while (observed < expected.length && text.includes(expected.slice(start, observed + 1))) observed++;
  }
  return observed;
}

function unitFacts(text: string, unitId: string): string {
  // Assertions call this on a single tall pane containing the complete unit.
  const start = text.indexOf(`Unit ${unitId} · group `);
  if (start < 0) throw new Error('Compiled view did not show the real conflicted unit');
  const tail = text.slice(start);
  const next = tail.indexOf('Unit ', 5);
  return next < 0 ? tail : tail.slice(0, next);
}

test('compiled native Integration distinguishes current repair from recorded conflict, real remerge, terminal state and restart', async () => {
  const f = await fixture();
  let primaryError: unknown;
  try {
    const before = live(await f.snapshot());
    const conflicted = before.units.find(unit => unit.item.state === 'recorded' && unit.item.integration === 'conflict');
    if (!conflicted || conflicted.item.state !== 'recorded' || !conflicted.item.worktreePath) throw new Error('Missing real conflicted item');
    const item = conflicted.item;
    let tui = await f.start(); await f.open(); f.integration();
    await tui.waitForScreen('initial unavailable inspection', screen => screenText(screen).includes('Select a Work control row and press i for status.'));
    tui.key('Right'); await f.host.holdStatus(); f.status(); const initialOrdinal = await f.host.heldStatus();
    await tui.waitForScreen('held actual native status loading', screen => screenText(screen).includes('native request is pending'));
    expect(await f.host.releaseStatus()).toBe(initialOrdinal);
    // Native row structure is deliberately interaction-frozen; an arrow adopts
    // the reply's layout, exactly as the on-screen deferred-structure hint says.
    await tui.waitForScreen('live native status header', screen => screen.includes('Integration: live'));
    tui.key('Down');
    const initial = await scrollUntil(tui, 'conflict and preserved worktree', text => text.includes(`Contract ${before.contractId}`)
      && text.includes(`Unit ${conflicted.unitId} · group ${conflicted.groupId}`) && text.includes(`Item ${item.itemId} · workstream ${item.workstreamId}`)
      && text.includes('Recorded integration: conflict') && unwrapped(text).includes(unwrapped(`Worktree path: ${JSON.stringify(item.worktreePath)}`))
      && unwrapped(text).includes(unwrapped(`Worktree branch: ${JSON.stringify(item.worktreeBranch)}`)) && text.includes('Worktree kept: true') && text.includes('Conflict file 1: "src/shared.ts"'));
    expect(initial).toContain(`Current unit status: ${conflicted.unitStatus}`);
    expect(await f.host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });

    await f.host.repair(); await f.refresh();
    await tui.waitForScreen('autonomous fix-passed header', screen => screen.includes('Integration: live'));
    tui.key('Down');
    await scrollUntil(tui, 'real repaired unit with recorded conflict', () => {
      const text = screenText(tui.screen());
      if (!text.includes(`Unit ${conflicted.unitId} · group `)) return false;
      const unit = unitFacts(text, conflicted.unitId);
      return unit.includes('Current unit status: passed') && unit.includes('fix-passed · pass') && unit.includes('Recorded integration: conflict') && unit.includes('Worktree kept: true');
    });
    expect(live(await f.snapshot()).units.find(unit => unit.unitId === conflicted.unitId)?.item).toEqual(item);
    expect(await f.host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });

    // A narrow viewport must wrap the long real path and still allow reaching
    // its conflict detail by scrolling; no data gets silently truncated.
    await f.refresh(); await tui.waitForScreen('refreshed conflict', screen => screen.includes('Integration: live')); tui.resize(48, 24);
    await tui.waitForScreen('actual narrow native pane', screen => screen.includes('Integration')
      && screen.trimEnd().split('\n').length <= 24 && screen.split('\n').every(line => Bun.stringWidth(line) <= 48), 10_000);
    const encodedPath = JSON.stringify(item.worktreePath);
    let visiblePathCharacters = 0;
    const narrow = await scrollUntil(tui, 'narrow conflict detail', (text, panes) => {
      visiblePathCharacters = visiblePrefix(panes, encodedPath);
      return text.includes('Conflict file 1: "src/shared.ts"') && visiblePathCharacters === unwrapped(encodedPath).length;
    }).catch(error => { throw new Error(`Narrow path coverage ${visiblePathCharacters}/${unwrapped(encodedPath).length}: ${String(error)}`); });
    expect(narrow).toContain('Worktree path:'); expect(tui.alive()).toBe(true);
    const narrowPane = tui.screen();
    expect(narrowPane.trimEnd().split('\n').length).toBeLessThanOrEqual(24);
    expect(narrowPane.split('\n').every(line => Bun.stringWidth(line) <= 48)).toBe(true);
    expect(narrowPane).not.toContain(item.worktreePath!);
    tui.resize(180, 55);

    // Capture a genuine old conflict response, detach, then make the real
    // engine remerge. Reopening must not adopt that late response or cancel work.
    tui.key('Right'); await f.host.holdStatus(); f.status(); const staleOrdinal = await f.host.heldStatus();
    await f.close(); await f.host.remerge(); await f.open(); f.status();
    await tui.waitForScreen('new real merged status', screen => screen.includes('Integration: live')); tui.key('Down');
    const merged = live(await f.snapshot()).units.find(unit => unit.unitId === conflicted.unitId);
    if (!merged || merged.item.state !== 'recorded' || !merged.item.mergeHash) throw new Error('Real remerge did not record its merge hash');
    expect(merged.item).toMatchObject({ integration: 'merged', worktreeKept: false });
    expect(merged.item.conflictFiles).toBeUndefined(); expect(merged.item.worktreePath).toBeUndefined();
    await scrollUntil(tui, 'real remerge hash', text => text.includes(`Merge hash: ${merged.item.state === 'recorded' ? merged.item.mergeHash : ''}`));
    const beforeLateDelivery = tui.screen();
    expect(await f.host.releaseStatus()).toBe(staleOrdinal);
    // Assert before issuing any newer request: a refresh could mask stale adoption.
    await Bun.sleep(1_200);
    expect(tui.screen()).toBe(beforeLateDelivery);
    await f.refresh(); await tui.waitForScreen('merged view survives late closed response', screen => screen.includes('Integration: live')); tui.key('Down');
    const integrated = await scrollUntil(tui, 'cleared recorded conflict', () => {
      const text = screenText(tui.screen());
      if (!text.includes(`Unit ${conflicted.unitId} · group `)) return false;
      const unit = unitFacts(text, conflicted.unitId);
      return unit.includes('Current unit status: passed') && unit.includes('fix-passed · pass') && unit.includes('Recorded integration: merged')
        && unit.includes('Worktree kept: false') && unit.includes('Conflict files: not recorded');
    });
    expect(integrated).not.toContain('Recorded integration: conflict');
    expect(await f.host.inspect()).toEqual({ remergeCalls: 1, escalations: 0, mutationCount: 1 });

    await f.host.finish(); await f.refresh();
    await tui.waitForScreen('terminal integration unavailable', screen => screenText(screen).includes('Integration unavailable: not-live.')); tui.key('Down');
    expect(tui.screen()).not.toContain('Recorded integration:'); expect(tui.screen()).not.toContain('Worktree path:');
    await f.close(); tui = await f.restart(); await f.open(); f.status();
    await tui.waitForScreen('process restart retains terminal unavailability', screen => screenText(screen).includes('Integration unavailable: not-live.')); tui.key('Down');
    expect(tui.screen()).not.toContain('Recorded integration:');
    expect(await f.host.inspect()).toEqual({ remergeCalls: 1, escalations: 0, mutationCount: 1 });
    expect(() => assertReadOnlyExecution(f.paths)).not.toThrow();
  } catch (error) { primaryError = error; throw error; }
  finally { await f.stop(primaryError); }
}, 180_000);

for (const afterRepair of [false, true]) test(`compiled unsupported native inspection preserves explicit Work cancellation ${afterRepair ? 'after repair' : 'at the repair gate'}`, async () => {
  const f = await fixture(true);
  let primaryError: unknown;
  try {
    const tui = await f.start(); await f.open(); f.status();
    await tui.waitForScreen('unsupported inspection capability', screen => screenText(screen).includes('Integration unavailable: unsupported-runner.')); tui.key('Down');
    expect(tui.screen()).not.toMatch(/Unit u\d|Item u\d|Recorded integration:|Worktree path:/);
    if (afterRepair) {
      await f.host.repair(); await f.refresh();
      await tui.waitForScreen('unsupported inspection after real repair', screen => screenText(screen).includes('Integration unavailable: unsupported-runner.'));
    }
    // Keys on Integration cannot call execution controls. They are ordinary
    // local filter input; clear each before returning to the Work control row.
    const beforeIntegrationKeys = f.paths.filter(path => path.startsWith('/api/work-ledger/execution/'));
    for (const key of ['s', 'i', 'c', 'r']) {
      tui.type(key);
      await tui.waitForScreen(`Integration ${key} is local filter input`, screen => screen.includes(`${key}▏`), 10_000);
      tui.key('BSpace');
      await tui.waitForScreen('Integration local filter cleared', screen => screen.includes('Filter integration'), 10_000);
    }
    expect(f.paths.filter(path => path.startsWith('/api/work-ledger/execution/'))).toEqual(beforeIntegrationKeys);
    expect(await f.host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
    tui.key('Right'); tui.key('Down'); tui.type('c');
    await tui.waitForScreen('explicit existing Work cancellation', screen => screenText(screen).includes('cancelled · recovery cancelled'));
    expect(await f.snapshot()).toMatchObject({ kind: 'execution', state: 'cancelled', recovery: 'cancelled' });
    expect(await f.host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 2 });
    expect(f.paths.filter(path => /\/(start|resume|cancel)$/.test(path))).toEqual(['/api/work-ledger/execution/cancel']);
  } catch (error) { primaryError = error; throw error; }
  finally { await f.stop(primaryError); }
}, 120_000);


test('compiled native Integration reports a genuine replacement host as recovery-required without adoption', async () => {
  const f = await fixture();
  let primaryError: unknown;
  try {
    const tui = await f.start(); await f.open(); f.status();
    await tui.waitForScreen('original live host', screen => screen.includes('Integration: live'));
    await f.host.restartHost(); await f.refresh();
    await tui.waitForScreen('replacement host needs explicit recovery', screen => screenText(screen).includes('Integration unavailable: recovery-required.')); tui.key('Down');
    expect(await f.snapshot()).toMatchObject({ kind: 'execution', recovery: 'required', integration: { state: 'unavailable', reason: 'recovery-required' } });
    expect(tui.screen()).not.toMatch(/Recorded integration:|Worktree path:|Conflict file/);
    expect(await f.host.inspectRecovery()).toEqual({ starts: 0, resumes: 0, agents: 0 });
    await f.close(); await f.open(); f.status();
    await tui.waitForScreen('reopened replacement host remains unavailable', screen => screenText(screen).includes('Integration unavailable: recovery-required.'));
    expect(await f.host.inspectRecovery()).toEqual({ starts: 0, resumes: 0, agents: 0 });
    expect(await f.host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
    expect(() => assertReadOnlyExecution(f.paths)).not.toThrow();
  } catch (error) { primaryError = error; throw error; }
  finally { await f.stop(primaryError); }
}, 120_000);


test('owned native proxy records forbidden mutation attempts and the read-only witness rejects them', async () => {
  const f = await fixture();
  let primaryError: unknown;
  try {
    expect(() => assertReadOnlyExecution(f.paths)).not.toThrow();
    const before = await f.host.inspect();
    expect(before).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
    // Deliberately exercise the firewall, without ever forwarding a mutation.
    // The same witness used by compiled product cases must turn red on each
    // attempted operation even though the genuine engine stays unchanged.
    for (const operation of ['start', 'resume'] as const) {
      await f.probeRejectedMutation(operation);
      expect(f.paths).toContain(`/api/work-ledger/execution/${operation}`);
      expect(() => assertReadOnlyExecution(f.paths)).toThrow('Unexpected native execution mutation attempts:');
      expect(await f.host.inspect()).toEqual(before);
    }
  } catch (error) { primaryError = error; throw error; }
  finally { await f.stop(primaryError); }
}, 60_000);


test('pane-fragment witness requires the complete ordered path, including its middle and tail', () => {
  const path = JSON.stringify(`/fixture/${Array.from({ length: 20 }, (_, index) => `unique-segment-${index}`).join('/')}/tail.ts`);
  const panes = Array.from({ length: Math.ceil(path.length / 32) }, (_, index) => `header\n  ${path.slice(index * 32, index * 32 + 48)}\nfooter`);
  expect(visiblePrefix(panes, path)).toBe(path.length);
  expect(visiblePrefix(panes.slice(0, -2), path)).toBeLessThan(path.length);
  expect(visiblePrefix(panes.filter((_pane, index) => index !== 2), path)).toBeLessThan(path.length);
  expect(visiblePrefix([...panes].reverse(), path)).toBeLessThan(path.length);
});
