import { test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, oneUnitPlan, startContract, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';
import { finishes, terminal } from './steps-support.js';

for (const stage of ['map', 'planner'] as const) {
  test(`initial planning rejects a view changed during ${stage}`, async () => {
    const plan = oneUnitPlan(1);
    let planners = 0;
    const h = makeHarness({
      plan,
      contract: { isolation: 'worktree' },
      scripts: { u1: finishes('export const parse = 10;') },
      repositoryMap: async (root) => {
        if (stage === 'map') {
          writeFileSync(join(root, 'README.md'), 'synthetic changed planner view\n');
        }
        return 'synthetic map';
      },
      planner: {
        async run(request) {
          planners++;
          if (stage === 'planner') {
            writeFileSync(join(request.workingDir, 'README.md'), 'synthetic changed planner view\n');
          }
          return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 };
        },
      },
    });
    try {
      const { contract } = startContract(h);
      await waitFor(() => terminal(h, contract.id), 'stale planner held', 15_000);
      const done = h.store.get(contract.id)!;
      console.log(JSON.stringify({
        stage, status: done.status, planners,
        members: h.agentsOf('u1').length, commit: done.commit?.status,
      }));
      expect(done.status).toBe('failed');
      expect(h.agentsOf('u1')).toHaveLength(0);
      if (stage === 'map') expect(planners).toBe(0);
    } finally {
      h.dispose();
    }
  }, 20_000);
}

for (const stage of ['route', 'judgment', 'receipt', 'cancel-map', 'cancel-judgment'] as const) {
  test(`initial planning retains its admission through ${stage}`, async () => {
    const plan = oneUnitPlan(1);
    let planners = 0;
    let mutation = false;
    const h = makeHarness({
      plan,
      contract: { isolation: 'worktree' },
      scripts: { u1: finishes('export const parse = 10;') },
      routeSelector: async ({ contract }) => {
        if (stage === 'route') {
          const view = join(contract.inputSnapshot!.sourceRoot, '.goodvibes', '.worktrees', 'contract-input', contract.inputSnapshot!.id);
          writeFileSync(join(view, 'README.md'), 'changed while routing\n');
          mutation = true;
        }
        return { model: 'provider-a:model-a', provider: 'provider-a', reason: 'fixture' };
      },
      repositoryMap: async () => {
        if (stage === 'cancel-map') {
          h.runner.cancel(h.store.list()[0]!.id, 'cancel during map');
          mutation = true;
        }
        return 'synthetic map';
      },
      port: (context) => {
        if (planners > 0 && !mutation && context.name === 'role' && (stage === 'judgment' || stage === 'cancel-judgment')) {
          const contract = h.store.list()[0]!;
          if (stage === 'cancel-judgment') h.runner.cancel(contract.id, 'cancel during plan judgment');
          else writeFileSync(join(contract.inputSnapshot!.sourceRoot, '.goodvibes', '.worktrees', 'contract-input', contract.inputSnapshot!.id, 'README.md'), 'changed during plan judgment\n');
          mutation = true;
        }
        return undefined;
      },
      planner: { async run() {
        planners++;
        if (stage === 'receipt') {
          const contract = h.store.list()[0]!;
          contract.inputSnapshot = structuredClone(contract.inputSnapshot!);
          mutation = true;
        }
        return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 };
      } },
    });
    try {
      const { contract } = startContract(h);
      await waitFor(() => terminal(h, contract.id), 'guarded planning terminal', 15_000);
      expect(mutation).toBe(true);
      expect(h.store.get(contract.id)!.status).toBe(stage.startsWith('cancel') ? 'cancelled' : 'failed');
      expect(h.agentsOf('u1')).toHaveLength(0);
      if (stage === 'route' || stage === 'cancel-map') expect(planners).toBe(0);
    } finally { h.dispose(); }
  }, 20_000);
}
