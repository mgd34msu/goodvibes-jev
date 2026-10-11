/** Native reviewed-repair successor to the retired WRFC chain regression.
 *
 * The compiled TUI inspects an explicitly paired native work execution over the
 * public authenticated HTTP contract. The engine-owned fixture admits real
 * source-backed work and runs ContractRunner with real isolated git branches.
 * A real file-evidence review fails, native bounded correction writes the fix,
 * a fresh review reads its changed diff, and the actual merge reaches the source
 * branch. Deterministic planner/worker/Jev fixtures replace model inference only.
 * No main→agent(reviewMode=wrfc) topology or file-repair-as-conversation fallback.
 * The legacy filename remains stable for existing compiled-E2E selectors.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkExecutionClient, type NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { beginTuiHostPairing, completeTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { launchNativeIntegrationHost } from '../helpers/native-integration-host.ts';
import { inputAreaVisible, launchTui, makeHome, screenText, startHomeDaemonServer, startStubModel, type TuiSession } from './harness.ts';

const GOAL = 'Repair add() in src/math.ts, review the repair, and integrate it.';
const CRITERIA = ['The exported add(a, b) returns a + b.'];
const BUGGY = 'export function add(a: number, b: number): number {\n  return a - b;\n}\n';
const FIXED = '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Reviewed native git assertion failed: ${args.join(' ')}`);
  return result.stdout;
}
function live(snapshot: NativeWorkExecutionSnapshot) {
  if (snapshot.kind !== 'execution' || snapshot.integration?.state !== 'live') throw new Error('Expected real live reviewed native integration');
  return snapshot.integration;
}
/** Accumulate only rendered current panes, scrolling with real user keys. */
async function see(tui: TuiSession, label: string, predicate: (text: string) => boolean): Promise<string> {
  let text = '';
  for (let i = 0; i < 100; i++) {
    const pane = tui.screen(); text += `\n${screenText(pane)}`;
    if (predicate(text)) return text;
    tui.key('Down');
    if (!await tui.waitForScreen('reviewed integration scroll', screen => screen !== pane, 2_000).catch(() => undefined)) break;
  }
  throw new Error(`Compiled native view did not expose ${label}\n${tui.screen()}`);
}

test('compiled native reviewed repair fails review, fixes, genuinely re-reviews, and persists its real source-branch merge', async () => {
  const host = launchNativeIntegrationHost(false, 'reviewed-repair');
  const model = startStubModel(() => ({ text: 'Unexpected direct model request in native reviewed repair' }));
  let home: Awaited<ReturnType<typeof makeHome>> | undefined;
  let proxy: Bun.Server<undefined> | undefined;
  let client: ReturnType<typeof createOperatorNativeWorkExecutionClient> | undefined;
  let tui: TuiSession | undefined;
  let token = ''; let primaryError: unknown;
  const forwarding = new Set<Promise<Response>>();
  try {
    home = await makeHome(model);
    const ready = await host.ready(); token = ready.token;
    if (!ready.projectRoot || ready.commitsBefore === undefined) throw new Error('Missing reviewed source repository');
    const sourceRoot = ready.projectRoot;
    const paths: string[] = [];
    const allowed = new Set(['/api/work-ledger/snapshot', '/api/work-ledger/history', '/api/work-ledger/execution/status']);
    proxy = await startHomeDaemonServer(home, async request => {
      const url = new URL(request.url); paths.push(url.pathname);
      // Count every attempt, including rejected mutation requests. The firewall
      // is isolation, never a replacement for product read-only assertions.
      if (!allowed.has(url.pathname)) return new Response('Owned reviewed fixture has no background service', { status: 404 });
      const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
      const pending = (async () => {
        const response = await fetch(`${ready.baseUrl}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      })();
      forwarding.add(pending); try { return await pending; } finally { forwarding.delete(pending); }
    });
    const origin = proxy.url.origin; const now = Date.now();
    const attempt = { attemptId: 'synthetic-reviewed-native-pairing', name: 'Owned reviewed native fixture', startedAt: now };
    expect((await beginTuiHostPairing(home.home, origin, attempt)).status).toBe('begun');
    expect((await completeTuiHostPairing(home.home, origin, attempt.attemptId, {
      token, tokenId: 'synthetic-reviewed-native-token', name: attempt.name, createdAt: now,
    })).status).toBe('paired');
    home.setTuiSetting('controlPlane.publicBaseUrl', origin); home.setTuiSetting('daemon.enabled', true);
    writeFileSync(join(home.home, '.goodvibes/tui/onboarding-checked.json'), JSON.stringify({ version: 1, checkedAt: now, updatedAt: now, source: 'e2e' }));
    client = createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl: ready.baseUrl, authToken: token, retry: { maxAttempts: 1 } }), 'project');
    const snapshot = () => client!.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
    const start = async () => { tui = launchTui(home!, { cols: 180, rows: 60 }); await tui.waitForScreen('compiled reviewed native input', inputAreaVisible, 45_000); };
    const openStatus = async () => {
      tui!.type('/work project'); tui!.key('Enter');
      await tui!.waitForScreen('paired reviewed native Work control', screen => screen.includes('Native Work') && screen.includes(`Control ${ready.identity.workId}:`));
      tui!.key('Down'); tui!.type('i'); for (let i = 0; i < 5; i++) tui!.key('Right');
      await tui!.waitForScreen('actual reviewed native status reply', screen => screen.includes('Integration: live') || screenText(screen).includes('Integration unavailable: not-live.'));
      tui!.key('Down'); // Adopt the reply's interaction-frozen row layout.
    };
    const close = async () => { tui!.key('Escape'); await tui!.waitForScreen('reviewed modal detached', screen => !screen.includes('Native Work') && inputAreaVisible(screen)); };

    const before = await host.reviewedProof();
    expect(before.fixWorkers).toBe(0); expect(before.fixRounds).toBe(1); expect(before.escalations).toBe(0);
    expect(before.checks.some(check => check.sourceRead === 'buggy' && check.result !== 'pass' && check.answered)).toBe(true);
    expect(before.checks.some(check => check.sourceRead === 'fixed')).toBe(false);
    expect(before.goal).toBe(GOAL); expect(before.sourceGoal).toBe(GOAL);
    expect(before.criteria).toEqual(CRITERIA); expect(before.sourceCriteria).toEqual(CRITERIA);
    expect(readFileSync(join(sourceRoot, 'src/math.ts'), 'utf8')).toBe(BUGGY);
    const failed = live(await snapshot()).units.find(unit => unit.unitId === 'u1')!;
    expect(failed.unitStatus).toBe('fixing'); expect(failed.latestCheck?.result).not.toBe('pass');
    await start(); await openStatus();
    await see(tui!, 'failed source review awaiting correction', text => text.includes('Unit u1 · group g1') && text.includes('Current unit status: fixing')
      && text.includes(`${failed.latestCheck!.trigger} · ${failed.latestCheck!.result}`));

    await host.repair();
    const reviewed = await host.reviewedProof();
    expect(reviewed.fixWorkers).toBe(1); expect(reviewed.fixPlans).toBe(1); expect(reviewed.fixRounds).toBe(1); expect(reviewed.escalations).toBe(0);
    const rereview = reviewed.checks.at(-1)!;
    expect(rereview).toMatchObject({ trigger: 'fix-passed', result: 'pass', sourceRead: 'fixed', answered: true });
    expect(before.checks.map(check => check.id)).not.toContain(rereview.id);
    expect(before.checks.map(check => check.evidenceDigest)).not.toContain(rereview.evidenceDigest);
    expect(reviewed.decisions).toEqual(expect.arrayContaining([
      { stage: 'stall', outcome: 'act', sourceBound: true, answered: true },
      { stage: 'fix-plan', outcome: 'act', sourceBound: true, answered: true },
    ]));
    const integrated = live(await snapshot());
    expect(integrated.units.find(unit => unit.unitId === 'u1')).toMatchObject({ unitStatus: 'passed', latestCheck: { trigger: 'fix-passed', result: 'pass' } });
    const repair = integrated.units.find(unit => unit.unitId === 'u1.f1.u1');
    if (!repair || repair.item.state !== 'recorded' || !repair.item.mergeHash) throw new Error('Actual native repair has no recorded merge');
    expect(repair.item).toMatchObject({ integration: 'merged', worktreeKept: false });
    expect(git(sourceRoot, 'show', `${repair.item.mergeHash}:src/math.ts`)).toBe(FIXED);
    await close(); await openStatus();
    await see(tui!, 'fresh passing re-review and actual repair merge', text => text.includes('fix-passed · pass') && text.includes('Unit u1.f1.u1 · group u1.f1')
      && text.includes('Recorded integration: merged') && text.includes(`Merge hash: ${repair.item.state === 'recorded' ? repair.item.mergeHash : ''}`));

    await host.finish();
    const finished = await host.reviewedProof();
    expect(finished.status).toBe('passed'); expect(finished.commit?.status).toBe('committed');
    expect(finished.commit?.hash).toBe(git(sourceRoot, 'rev-parse', 'HEAD').trim());
    expect(finished.checks).toEqual(reviewed.checks);
    expect(readFileSync(join(sourceRoot, 'src/math.ts'), 'utf8')).toBe(FIXED);
    expect(git(sourceRoot, 'show', 'HEAD:src/math.ts')).toBe(FIXED);
    expect(git(sourceRoot, 'branch', '--show-current').trim()).toBe('main');
    expect(Number(git(sourceRoot, 'rev-list', '--count', 'HEAD').trim())).toBeGreaterThan(ready.commitsBefore);
    expect(git(sourceRoot, 'status', '--porcelain').trim()).toBe('');
    expect(await snapshot()).toMatchObject({ kind: 'execution', progress: { status: 'passed' }, integration: { state: 'unavailable', reason: 'not-live' } });
    await close(); await openStatus();
    expect(screenText(tui!.screen())).toContain('Integration unavailable: not-live.');
    expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
    expect(paths.filter(path => /\/(start|resume|cancel)$/.test(path))).toEqual([]);
    expect(tui!.alive()).toBe(true);

    // Reopen the durable contract through a genuinely new host/runner. Reading
    // terminal work must preserve the result without silently replaying work.
    await host.restartHost();
    expect(await snapshot()).toMatchObject({ kind: 'execution', recovery: 'terminal', progress: { status: 'passed' } });
    expect(await host.inspectRecovery()).toEqual({ starts: 0, resumes: 0, agents: 0 });
    expect(await host.reviewedProof()).toEqual(finished);
  } catch (error) { primaryError = error; throw error; }
  finally {
    const errors: unknown[] = [];
    const attempt = async (action: () => unknown | Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
    let output = ''; let screen = ''; let violations = '';
    await attempt(() => { if (tui) { output = tui.rawOutput(); screen = tui.screen(); } });
    await attempt(() => tui?.stop()); await attempt(() => client?.dispose());
    await attempt(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([...forwarding]), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Reviewed native proxy did not drain')), 2_000);
      })]); } finally { clearTimeout(timer); }
    });
    await attempt(() => host.stop()); await attempt(() => proxy?.stop(true)); await attempt(() => model.stop());
    await attempt(() => { if (home) { const path = join(home.root, 'network-violations.log'); violations = existsSync(path) ? readFileSync(path, 'utf8') : ''; } });
    await attempt(() => { if (home) rmSync(home.root, { recursive: true, force: true }); });
    await attempt(() => { if (token) { expect(output).not.toContain(token); expect(screen).not.toContain(token); } });
    await attempt(() => { expect(model.requests).toEqual([]); expect(violations).toBe(''); });
    if (errors.length) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Reviewed native assertion or owned cleanup failed');
  }
}, 150_000);
