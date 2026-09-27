// `/policy`, hoisted from goodvibes-tui src/input/commands/policy.ts and
// policy-dispatch.ts. The record-trend tests are ported from goodvibes-tui
// src/test/input/policy-record-trend-command.test.ts (`/policy record-trend`
// is a thin wrapper over PolicyRuntimeState.recordTrendEntry(), which forwards
// to the attached DivergencePanel, so the verb is honest about needing an
// active simulation dashboard). The rest pin the narrow context the TUI now
// hands the engine: the panel opener, the working-directory getter the
// simulation reads, and the config and MCP getters the preflight reads.
import { describe, expect, test } from 'bun:test';
import type { GoodVibesConfig } from '../sdk/src/platform/config/schema-types.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { runPolicyCommand, type PolicyFrontDoorContext } from '../sdk/src/platform/gate/policy/policy-command.ts';
import type { PolicyMcpServerSecurity } from '../sdk/src/platform/gate/policy/policy-dispatch.ts';

const unused = (): never => { throw new Error('not used by this verb'); };

function makeContext(out: string[], policyRuntimeState: PolicyRuntimeState, over: Partial<PolicyFrontDoorContext> = {}): PolicyFrontDoorContext {
  return {
    policyRuntimeState,
    print: (text: string) => { out.push(text); },
    workingDirectory: unused,
    config: unused,
    listMcpServerSecurity: unused,
    ...over,
  };
}

describe('/policy record-trend', () => {
  test('reports honestly when no simulation dashboard is active (no silent no-op)', async () => {
    const out: string[] = [];
    // A fresh PolicyRuntimeState has no dashboard attached.
    await runPolicyCommand(['record-trend'], makeContext(out, new PolicyRuntimeState()));
    const printed = out.join('\n');
    expect(printed).toContain('No active simulation dashboard');
    expect(printed).toContain('/policy simulate');
  });

  test("'trend' alias resolves to the same handler", async () => {
    const out: string[] = [];
    await runPolicyCommand(['trend'], makeContext(out, new PolicyRuntimeState()));
    expect(out.join('\n')).toContain('No active simulation dashboard');
  });
});

describe('/policy front door and dispatch', () => {
  test('no arguments opens the panel when the surface has one, and prints usage when it does not', async () => {
    let opened = 0;
    const out: string[] = [];
    await runPolicyCommand([], makeContext(out, new PolicyRuntimeState(), { openPolicyPanel: () => { opened += 1; } }));
    expect(opened).toBe(1);
    expect(out).toEqual([]);

    await runPolicyCommand([], makeContext(out, new PolicyRuntimeState()));
    expect(out.join('\n')).toContain('Usage: /policy <subcommand>');
  });

  test('a verb that needs policy state says so when the runtime has none', async () => {
    const out: string[] = [];
    const ctx: PolicyFrontDoorContext = { print: (text) => { out.push(text); }, workingDirectory: unused, config: unused, listMcpServerSecurity: unused };
    await expect(runPolicyCommand(['status'], ctx)).rejects.toThrow('Policy runtime state is not available in this runtime.');
  });

  test('load, then simulate against the working directory and the owner\'s threshold, then report status', async () => {
    const state = new PolicyRuntimeState();
    const out: string[] = [];
    let rootsAsked = 0;
    const config = { permissions: { divergenceThreshold: 0.2 } } as unknown as GoodVibesConfig;
    const ctx = makeContext(out, state, {
      workingDirectory: () => { rootsAsked += 1; return '/work/project'; },
      config: () => config,
    });

    await runPolicyCommand(['load', 'bundle-a', '2'], ctx);
    expect(out.join('\n')).toContain('[policy] Candidate loaded: bundle-a');
    expect(out.join('\n')).toContain('[2 rules, loaded]');

    await runPolicyCommand(['simulate', 'silent'], ctx);
    expect(rootsAsked).toBe(1);
    expect(out.join('\n')).toContain('[policy] Simulation started in "simulation-only" mode.');
    expect(state.getDashboard()?.checkEnforceGate().threshold).toBe(0.2);

    await runPolicyCommand(['status'], ctx);
    expect(out.join('\n')).toContain('[policy] Candidate: bundle-a');
    expect(out.join('\n')).toContain('[policy] Divergence gate:');
  });

  test('preflight reads the live config and the MCP servers through the getters', async () => {
    const out: string[] = [];
    const servers: PolicyMcpServerSecurity[] = [
      { name: 'deploy', trustMode: 'allow-all', role: 'ops', allowedPaths: [], allowedHosts: [] },
    ];
    const config = { permissions: { mode: 'allow-all', rules: [] } } as unknown as GoodVibesConfig;
    const state = new PolicyRuntimeState();
    await runPolicyCommand(['preflight'], makeContext(out, state, { config: () => config, listMcpServerSecurity: () => servers }));
    const printed = out.join('\n');
    expect(printed).toContain('[policy] Preflight review: BLOCK');
    expect(printed).toContain('deploy');
    expect(state.getSnapshot().lastPreflightReview?.status).toBe('block');
  });
});
