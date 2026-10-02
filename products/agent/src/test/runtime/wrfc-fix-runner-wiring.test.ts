/** The retired private WRFC fix-runner probe now follows the real public correction lifecycle. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { buildFixPlannerPrompt } from '@goodvibes-jev/engine/sdk/platform/contract';
import { createEventEnvelope } from '@/runtime/index.ts';
import { CONTRACT_ASK, contractPlan, contractRuntimeFixture, waitForContract } from '../helpers/contract-runtime-fixture.ts';

const fixPlan = { goal: 'Repair the uncapped delay', criteria: [], groups: [{
  id: 'g1', title: 'Fix cap', goal: 'Cap delay', kind: 'fix', dependsOn: [], criteria: [],
  units: [{ id: 'u1', title: 'Fix cap', goal: 'Cap delay', role: 'implement', brief: 'Clamp the delay after jitter',
    dependsOn: [], files: ['src/isolation-fixture.ts'], criteria: [{ id: 'u1.c1', text: 'Delay is capped after jitter', serves: ['u1.c1'] }] }],
}] };

describe('Agent composition wires contract correction', () => {
  test('a stalled unit starts an isolated planned-fix unit on this runtime, and cancellation stops the repair after the checked worker retires', async () => {
    let fixCwd: string | undefined;
    const plans: string[] = [];
    const fixture = contractRuntimeFixture(async (record, services) => {
      record.status = 'running';
      if (record.contractUnitId?.includes('.f1.')) {
        fixCwd = record.workingDirectory;
        const signal = services.agentManager.getCancellationSignal(record.id);
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      const cwd = record.workingDirectory;
      if (!cwd) throw new Error('Unit has no worktree');
      for (let turn = 0; turn < 3; turn += 1) {
        writeFileSync(join(cwd, 'src/isolation-fixture.ts'), `export const delay = ${turn + 2};\n`);
        record.fullOutput = `[unmet] attempt ${turn}`;
        const outcome = await services.contractRunner.hooks().holdCompletion(record);
        if (outcome.kind !== 'continue') {
          // The ordinary executor completes only after the runner releases its hold.
          if (record.status === 'running') {
            record.status = 'completed';
            record.completedAt = Date.now();
            services.runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: record.id, durationMs: 1, output: record.fullOutput }, { sessionId: 'correction', source: 'fixture' }));
          }
          return;
        }
        services.runtimeBus.emit('communication', createEventEnvelope('COMMUNICATION_CONSUMED', {
          type: 'COMMUNICATION_CONSUMED', messageId: outcome.nudgeId, agentId: record.id, turn: turn + 2,
        }, { sessionId: 'correction', source: 'fixture' }));
      }
    }, (record) => {
      plans.push(record.task);
      return record.systemPromptAddendum === buildFixPlannerPrompt() ? fixPlan : contractPlan;
    }, (name, question, state) => {
      if (name === 'route') return choiceAnswer(question, 'split', 0.99);
      if (name === 'goal' || name.startsWith('criterion_')) return noulAnswer(JSON.stringify(state).includes('[unmet]') ? 0.99 : 0.01);
      return undefined;
    });
    const { services } = fixture;
    const root = services.workingDirectory;
    try {
      execFileSync('git', ['config', 'user.name', 'Fixture Owner'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'owner@example.test'], { cwd: root });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
      writeFileSync(join(root, 'src/isolation-fixture.ts'), 'export const delay = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
      services.configManager.set('contract.stallLimit', 2);
      const { contract } = services.contractRunner.start({ ask: CONTRACT_ASK, sessionId: 'correction', origin: 'agent-tool', projectRoot: root });
      await waitForContract(() => fixCwd !== undefined, () => JSON.stringify({ contract: services.contractRunner.get(contract.id), requested: fixture.requested }));
      const correcting = services.contractRunner.get(contract.id)!;
      const fix = correcting.groups.find((group) => group.kind === 'fix');
      expect(fix?.repairs).toEqual({ scope: 'unit', targetId: 'u1', criterionIds: ['u1.c1'] });
      expect(correcting.units.find((unit) => unit.id === 'u1')?.fixRounds).toBe(1);
      expect(plans.some((prompt) => prompt.includes('## The part to repair (unit u1)'))).toBe(true);
      expect(fixCwd).not.toBe(root);
      expect(fixCwd).not.toBe(correcting.worktreePath);
      expect(readFileSync(join(root, 'src/isolation-fixture.ts'), 'utf8')).toBe('export const delay = 1;\n');
      expect(services.contractRunner.cancel(contract.id, 'test complete')).toBe(true);
      expect(services.contractRunner.get(contract.id)?.status).toBe('cancelled');
      expect(services.agentManager.list().filter((agent) => agent.contractId === contract.id && agent.contractRole === 'unit').map((agent) => [agent.contractUnitId, agent.status])).toEqual([['u1', 'completed'], ['u1.f1.u1', 'cancelled']]);
    } finally { fixture.dispose(); }
  }, 15_000);
});
