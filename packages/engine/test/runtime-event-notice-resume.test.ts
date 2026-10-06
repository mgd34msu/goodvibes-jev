/** Restoring a supported older snapshot can produce a new outcome for the same contract id. */
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { makeHarness, makeRepo, oneUnitPlan } from './contract/runner-support.js';
import { makeContract, makeGroup } from './contract/fixtures.js';
import { registerHostRuntimeEvents, runtimeEventKey, runtimeEventOfNotice, type RuntimeEventProvenance } from '../sdk/src/platform/runtime/bootstrap-runtime-events.js';
import { waitFor } from './_helpers/test-timeout.js';

for (const type of ['CONTRACT_FAILED', 'CONTRACT_CANCELLED', 'CONTRACT_PASSED', 'CONTRACT_COMMITTED'] as const) {
  test(`${type} from a restored older snapshot is a new occurrence of the same contract`, async () => {
    const root = makeRepo();
    const h = makeHarness({ root, plan: oneUnitPlan(), scripts: {} });
    const lines: string[] = [];
    const provenance: Array<RuntimeEventProvenance | undefined> = [];
    const bridge = registerHostRuntimeEvents({
      runtimeBus: h.bus, domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
      getSystemMessageRouter: () => ({ low: () => {}, high: () => {}, contract: (text, _priority, event) => { lines.push(text); provenance.push(event); } }),
      requestRender: () => {}, agentManager: h.manager, contractRunner: h.runner,
    });
    try {
      const contract = makeContract({
        projectRoot: root,
        status: type === 'CONTRACT_CANCELLED' ? 'awaiting-owner' : type === 'CONTRACT_FAILED' ? 'running' : 'committing',
        statusBeforeOwner: 'planning',
        groups: type === 'CONTRACT_FAILED' ? [makeGroup({ status: 'running' })] : [],
        units: [], criteria: [],
      });
      h.store.hold(contract);
      h.store.write(contract.id);
      const older = h.runner.serializeContract(contract.id)!;
      for (let occurrence = 1; occurrence <= 2; occurrence++) {
        const report = await h.runner.resumeAll();
        if (type === 'CONTRACT_CANCELLED') {
          expect(report.resumed).toEqual([{ contractId: contract.id, step: 'await-owner' }]);
          expect(h.runner.cancel(contract.id, 'Owner stopped this work.')).toBe(true);
          expect(h.runner.cancel(contract.id, 'Already ended.')).toBe(false);
        }
        await waitFor(() => h.events.filter((event) => event.type === type).length === occurrence);
        await waitFor(() => lines.map((line, index) => runtimeEventOfNotice(line, provenance[index])).filter((notice) => notice?.type === type).length === occurrence);
        if (occurrence === 1) {
          // The supported importer permits replacing a terminal contract with
          // its older nonterminal snapshot without a force override.
          expect(h.runner.importContract(older)).toBe(true);
        }
      }
      const events = h.events.filter((event) => event.type === type);
      const notices = lines.map((line, index) => runtimeEventOfNotice(line, provenance[index])).filter((notice) => notice?.type === type);
      expect(events.map((event) => event.contractId)).toEqual([contract.id, contract.id]);
      const retained = new Map<string, unknown>();
      for (const [index, event] of events.entries()) retained.set(runtimeEventKey(type, event) ?? `occurrence:${index}`, event);
      expect(retained.size).toBe(2);
      expect(events.every((event) => runtimeEventKey(type, event) !== undefined)).toBe(true);
      expect(notices.map((notice) => notice?.key)).toEqual(events.map((event) => runtimeEventKey(type, event)));
      expect(new Set(notices.map((notice) => notice?.key)).size).toBe(2);
      expect(new Set(notices.map((notice) => notice?.detail)).size).toBe(1);
    } finally {
      for (const unsub of bridge.unsubs) unsub();
      if (bridge.agentStatusIntervalRef.value) clearInterval(bridge.agentStatusIntervalRef.value);
      h.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
