import { describe, expect, test } from 'bun:test';
import { createUnsignedBundle, PolicyRegistry } from '@/runtime/index.ts';
import type { DivergenceReport, DivergenceStats, EnforceGateResult, PolicyBundlePayload } from '@/runtime/index.ts';
import { PolicyDiagnosticsPanel } from '../../../runtime/diagnostics/panels/policy.ts';

function makeBundle(id: string) {
  const payload: PolicyBundlePayload = {
    version: 1,
    description: `Test bundle ${id}`,
    rules: [],
  };
  return createUnsignedBundle(id, payload);
}

function makeDivergenceReport(): DivergenceReport {
  const overall: DivergenceStats = {
    total: 0,
    byType: { 'allow-vs-deny': 0, 'deny-vs-allow': 0, 'reason-mismatch': 0 },
    divergenceRate: 0,
    totalEvaluations: 100,
  };
  return {
    overall,
    byToolClass: {},
    byCommandPrefix: {},
    byMode: {},
    records: [],
  };
}

function makeAllowedGate(): EnforceGateResult {
  return {
    status: 'allowed',
    divergenceRate: 0,
    threshold: 0.05,
    totalEvaluations: 100,
    message: 'Gate is allowed',
  };
}

function promoteBundle(registry: PolicyRegistry, id: string): void {
  registry.loadCandidate(makeBundle(id));
  expect(registry.markSimulating()).toBe(true);
  expect(registry.attachSimulationReport(makeDivergenceReport(), makeAllowedGate())).toBe(true);
  expect(registry.promote().ok).toBe(true);
}

describe('PolicyDiagnosticsPanel', () => {
  test('snapshots policy registry state without exposing the retired UI panel name', () => {
    const registry = new PolicyRegistry();
    promoteBundle(registry, 'policy-a');
    promoteBundle(registry, 'policy-b');
    registry.loadCandidate(makeBundle('policy-c'));

    const panel = new PolicyDiagnosticsPanel(registry);
    const snapshot = panel.getSnapshot();

    expect(snapshot.current?.bundle.bundleId).toBe('policy-b');
    expect(snapshot.candidate?.bundle.bundleId).toBe('policy-c');
    expect(snapshot.history.map((entry) => entry.bundle.bundleId)).toContain('policy-a');
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('notifies subscribers and disposes cleanly', () => {
    const registry = new PolicyRegistry();
    const panel = new PolicyDiagnosticsPanel(registry);
    let notifications = 0;

    const unsubscribe = panel.subscribe(() => {
      notifications += 1;
    });

    panel.notify();
    unsubscribe();
    panel.notify();
    panel.dispose();

    expect(notifications).toBe(1);
  });
});
