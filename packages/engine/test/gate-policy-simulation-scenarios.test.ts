// Ported from goodvibes-agent src/test/runtime/permissions/simulation-scenarios.test.ts.
import { describe, expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import {
  createPermissionSimulator,
  buildDefaultPolicySimulationScenarios,
  runPolicySimulationScenarios,
} from '../sdk/src/platform/runtime/permissions/index.ts';

describe('policy simulation scenarios', () => {
  // Each scenario is read by Jev (the gate's reading) before the two policy
  // sets evaluate it; the fake port reads the read scenario as read-only.
  const readings = useGateReadings([['README.md', { mutates: false }]]);

  test('builds a concrete default scenario set', () => {
    const scenarios = buildDefaultPolicySimulationScenarios();
    expect(scenarios.length).toBeGreaterThan(4);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      'write-project-file',
      'spawn-agent',
    ]));
  });

  test('runs scenario simulations and returns a bounded summary', async () => {
    const simulator = createPermissionSimulator(
      { mode: 'default', rules: [] },
      { mode: 'plan', rules: [] },
      'warn-on-divergence',
      { onWarning: () => {} },
    );

    const summary = await runPolicySimulationScenarios(simulator);
    expect(readings.requests.length).toBeGreaterThan(0);
    expect(summary.totalScenarios).toBeGreaterThan(4);
    expect(summary.results).toHaveLength(summary.totalScenarios);
    expect(summary.divergentScenarios).toBeGreaterThan(0);
    expect(summary.results.filter((result) => result.diverged)).toHaveLength(summary.divergentScenarios);
  });
});
