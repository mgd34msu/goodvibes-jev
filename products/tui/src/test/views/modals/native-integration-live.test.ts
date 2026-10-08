/** Real git, runner, paired host and authenticated wire behind the production modal. */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { operatorWorkLedgerSelection } from '../../../runtime/native-work-ledger.ts';
import { createNativeWorkLedgerModalSurface } from '../../../views/modals/native-work-ledger-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { handleConfigModalToken } from '../../../input/handler-modal-routes.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { launchNativeIntegrationHost } from '../../helpers/native-integration-host.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';

async function waitFor(predicate: () => boolean, label: string, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

test('actual native conflict and autonomous fix-passed reach the TUI as separate current verdict and recorded item facts', async () => {
  const host = launchNativeIntegrationHost();
  const modal = new ConfigModal();
  let client: ReturnType<typeof createOperatorNativeWorkExecutionClient> | undefined;
  try {
    const ready = await host.ready();
    const sdk = createOperatorSdk({ baseUrl: ready.baseUrl, authToken: ready.token, retry: { maxAttempts: 1 } });
    client = createOperatorNativeWorkExecutionClient(sdk, 'project');
    const before = await client.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
    if (before.kind !== 'execution' || before.integration?.state !== 'live') throw new Error('Expected live native conflict');
    expect(before.receipt?.contractId).toBe(ready.contractId);
    const contractId = before.integration.contractId;
    const conflicted = before.integration.units.find(unit => unit.item.state === 'recorded' && unit.item.integration === 'conflict');
    if (!conflicted || conflicted.item.state !== 'recorded') throw new Error('Expected the actual conflicted item');
    const item = conflicted.item;
    expect(existsSync(item.worktreePath!)).toBe(true);
    const surface = createNativeWorkLedgerModalSurface(() => operatorWorkLedgerSelection('paired-native-host', before.projectId, sdk));
    const route = { configModal: modal, requestRender() {}, handleEscape: () => modal.close() };
    const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
    const tab = (id: string) => {
      for (let i = 0; i < 6 && modal.getActiveTabId() !== id; i++) key('right');
      expect(modal.getActiveTabId()).toBe(id);
    };
    const rows = () => surface.buildView().tabs.find(tab => tab.id === 'integration')!.rows;
    const text = () => rows().map(row => row.label).join('\n');
    const frame = (width = 180, height = 45) => frameFromLayer(renderConfigModal(modal, width, height), width, height)
      .map(line => line.map(cell => cell.char).join('')).join('\n');
    const inspect = async () => {
      tab('work'); key('down'); expect(modal.fireAction('i', { print() {} })).toBe(true);
      await waitFor(() => text().includes(`Item ${item.itemId}`), 'real status reaches Native Work modal', 10_000);
      tab('integration');
    };
    modal.open(surface);
    await waitFor(() => surface.buildView().tabs[0]!.rows.some(row => row.selectable === true), 'authenticated native ledger in modal', 10_000);
    frame(); await inspect();
    expect(rows().length).toBeGreaterThan(11);
    const preserved = [`Contract ${contractId}`, `Unit ${conflicted.unitId} · group ${conflicted.groupId}`, `Item ${item.itemId} · workstream ${item.workstreamId}`,
      'Recorded integration: conflict', `Worktree path: ${JSON.stringify(item.worktreePath)}`, `Worktree branch: ${JSON.stringify(item.worktreeBranch)}`,
      'Worktree kept: true', 'Conflict file 1: "src/shared.ts"'];
    for (const fact of preserved) expect(text()).toContain(fact);
    expect(text()).toContain(`Current unit status: ${conflicted.unitStatus}`);
    expect(frame()).toContain('Integration: live');
    for (const action of ['s', 'i', 'c', 'r']) expect(modal.fireAction(action, { print() {} })).toBe(false);
    expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });

    await host.repair(); await inspect();
    for (const fact of preserved) expect(text()).toContain(fact);
    const unitRow = rows().findIndex(row => row.label === `Unit ${conflicted.unitId} · group ${conflicted.groupId}`);
    const currentUnit = rows().slice(unitRow, unitRow + 12).map(row => row.label).join('\n');
    expect(currentUnit).toContain('Current unit status: passed'); expect(currentUnit).toContain('fix-passed · pass');
    expect(currentUnit).toContain('Recorded integration: conflict'); expect(currentUnit).not.toContain('Recorded integration: merged');
    expect(text()).not.toMatch(/waiting on (?:the )?user|needsAttention|verified success/);
    let reached = false;
    for (let i = 0; i < 250; i++) { if (frame(48, 24).includes('src/shared.ts')) { reached = true; break; } key('down'); }
    expect(reached).toBe(true);
    expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
  } finally { modal.close(); client?.dispose(); await host.stop(); }
}, 90_000);

for (const afterRepair of [false, true]) test(`an actual legacy runner keeps native status and cancellation ${afterRepair ? 'after repair' : 'at the repair gate'} while the modal reports unsupported inspection`, async () => {
  const host = launchNativeIntegrationHost(true); const modal = new ConfigModal();
  let client: ReturnType<typeof createOperatorNativeWorkExecutionClient> | undefined;
  let primaryError: unknown;
  try {
    const ready = await host.ready(); const paths: string[] = [];
    const sdk = createOperatorSdk({ baseUrl: ready.baseUrl, authToken: ready.token, retry: { maxAttempts: 1 },
      fetchImpl: (input, init) => {
        paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
        return fetch(input, init); // Observe real HTTP requests; no replacement responses.
      },
    });
    client = createOperatorNativeWorkExecutionClient(sdk, 'project');
    const before = await client.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
    if (before.kind !== 'execution' || !before.progress) throw new Error('Legacy native runner must preserve real execution progress');
    expect(before.receipt?.contractId).toBe(ready.contractId);
    expect(before).toMatchObject({ state: 'launch-claimed', recovery: 'available', currentAttempt: true, stale: false,
      expectedRevision: ready.identity.expectedRevision, integration: { state: 'unavailable', reason: 'unsupported-runner' },
      progress: { semanticState: 'deciding', stage: 'fix-plan' } });
    expect(Object.keys(before.integration!).sort()).toEqual(['reason', 'state']);
    const surface = createNativeWorkLedgerModalSurface(() => operatorWorkLedgerSelection('paired-legacy-runner', before.projectId, sdk));
    const route = { configModal: modal, requestRender() {}, handleEscape: () => modal.close() };
    const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
    const tab = (id: string) => {
      for (let i = 0; i < 6 && modal.getActiveTabId() !== id; i++) key('right');
      expect(modal.getActiveTabId()).toBe(id);
    };
    const integration = () => surface.buildView().tabs.find(tab => tab.id === 'integration')!;
    const work = () => surface.buildView().tabs.find(tab => tab.id === 'work')!.rows.map(row => row.label).join('\n');
    const frame = () => frameFromLayer(renderConfigModal(modal, 180, 45), 180, 45).map(line => line.map(cell => cell.char).join('')).join('\n');
    const inspect = async () => {
      tab('work'); key('down'); expect(modal.fireAction('i', { print() {} })).toBe(true);
      await waitFor(() => integration().header?.some(line => line.includes('unsupported-runner')) === true, 'unsupported capability through real modal status', 10_000);
      tab('integration');
    };
    modal.open(surface);
    await waitFor(() => surface.buildView().tabs[0]!.rows.some(row => row.selectable === true), 'legacy runner authenticated native ledger', 10_000);
    frame(); await inspect();
    expect(frame()).toContain('Integration unavailable: unsupported-runner');
    expect(integration().rows).toHaveLength(1);
    expect(integration().rows[0]?.label).toContain(`execution attempt ${ready.identity.attemptId}`);
    expect(integration().rows.every(row => row.selectable === false)).toBe(true);
    expect(integration().rows.map(row => row.label).join('\n')).not.toMatch(/Unit |Item |Worktree|Conflict file|Recorded integration:/);
    expect(work()).toContain(`Receipt: contract ${ready.contractId}`); expect(work()).toContain('stage fix-plan');
    for (const action of ['s', 'i', 'c', 'r']) expect(modal.fireAction(action, { print() {} })).toBe(false);
    expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });

    // Cover cancellation both at the Jev repair gate and after autonomous repair.
    if (afterRepair) {
      // The scripted later worker uses the actual manager cancellation signal,
      // so it remains active for inspection but cooperates with real cancellation.
      await host.repair(); await inspect();
      const repaired = await client.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
      if (repaired.kind !== 'execution' || !repaired.progress) throw new Error('Legacy runner lost progress after native repair');
      expect(repaired.receipt?.contractId).toBe(ready.contractId);
      expect(repaired.progress.units.passed).toBeGreaterThan(before.progress.units.passed);
      expect(repaired.integration).toEqual({ state: 'unavailable', reason: 'unsupported-runner' });
      expect(integration().rows).toHaveLength(1); expect(frame()).toContain('Integration unavailable: unsupported-runner');
      expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
    }

    tab('work'); key('down');
    expect(surface.actions?.map(action => action.id)).toEqual(['start', 'status', 'cancel', 'resume']);
    expect(surface.actions?.every(action => action.enabledFor?.(modal.getSelectedRow(), 'work') === true)).toBe(true);
    expect(modal.fireAction('c', { print() {} })).toBe(true);
    await waitFor(() => work().includes('· cancelled · recovery cancelled'), 'explicit native cancellation through existing Work control', 10_000);
    const cancelled = await client.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
    expect(cancelled).toMatchObject({ kind: 'execution', attemptId: ready.identity.attemptId, state: 'cancelled', recovery: 'cancelled' });
    expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 2 });
    expect(paths.filter(path => path.endsWith('/cancel'))).toHaveLength(1);
    expect(paths.every(path => ['/api/work-ledger/snapshot', '/api/work-ledger/history', '/api/work-ledger/execution/status', '/api/work-ledger/execution/cancel'].includes(path))).toBe(true);
  } catch (error) { primaryError = error; throw error; }
  finally {
    modal.close(); client?.dispose();
    try { await host.stop(); }
    catch (error) { if (primaryError !== undefined) throw new AggregateError([primaryError, error], 'Native modal assertion and fixture shutdown both failed'); throw error; }
  }
}, 90_000);

test('held native HTTP status ordinals preserve captured response order across actual autonomous repair', async () => {
  const host = launchNativeIntegrationHost();
  let client: ReturnType<typeof createOperatorNativeWorkExecutionClient> | undefined;
  let primaryError: unknown;
  // Attach rejection observers immediately, keeping original promises below
  // for assertions; failure-path disposal cannot precede their drain handlers.
  const inFlight: Promise<unknown>[] = [];
  try {
    const ready = await host.ready();
    client = createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl: ready.baseUrl, authToken: ready.token, retry: { maxAttempts: 1 } }), 'project');
    await host.holdStatus();
    let settled = false;
    const pending = client.status(ready.identity, { signal: AbortSignal.timeout(20_000) }).then(snapshot => { settled = true; return snapshot; });
    inFlight.push(pending.catch(() => undefined));
    const firstOrdinal = await host.heldStatus();
    expect(settled).toBe(false);
    await host.repair();
    expect(settled).toBe(false);
    expect(await host.releaseStatus()).toBe(firstOrdinal);
    const captured = await pending;
    expect(captured).toMatchObject({ kind: 'execution', progress: { semanticState: 'deciding', stage: 'fix-plan' } });
    await host.holdStatus();
    const current = client.status(ready.identity, { signal: AbortSignal.timeout(10_000) });
    inFlight.push(current.catch(() => undefined));
    const nextOrdinal = await host.heldStatus();
    expect(nextOrdinal).toBeGreaterThan(firstOrdinal);
    expect(await host.releaseStatus()).toBe(nextOrdinal);
    const repaired = await current;
    if (repaired.kind !== 'execution' || repaired.integration?.state !== 'live') throw new Error('Expected actual repaired live native status');
    expect(repaired.integration.units.some(unit => unit.unitStatus === 'passed' && unit.latestCheck?.trigger === 'fix-passed'
      && unit.item.state === 'recorded' && unit.item.integration === 'conflict')).toBe(true);
    expect(await host.inspect()).toEqual({ remergeCalls: 0, escalations: 0, mutationCount: 1 });
  } catch (error) { primaryError = error; throw error; }
  finally {
    client?.dispose();
    try { await host.stop(); }
    catch (error) { if (primaryError !== undefined) throw new AggregateError([primaryError, error], 'Native held-status assertion and fixture shutdown both failed'); throw error; }
    finally { await Promise.allSettled(inFlight); }
  }
}, 60_000);
