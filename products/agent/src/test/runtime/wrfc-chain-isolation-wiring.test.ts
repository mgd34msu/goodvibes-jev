/**
 * The Agent is delegation-only, but chains it starts still run: their work,
 * fix steps included, runs automatically in isolated worktrees and never as
 * in-place writes to the shared directory, and never as a manual step.
 *
 * The daemon cannot accept a chain handoff: its only task intake (POST /task,
 * tasks.create) spawns a plain agent in the daemon's own directory from a task
 * string, with no workspace, template, review findings or chain to continue.
 * So the Agent runs its chains through its own copy of the SDK engine: the
 * chain gets its own git worktree, and its planned-fix workstream is rooted
 * there on the Agent's orchestration engine in `worktree` isolation mode.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEventEnvelope } from '@/runtime/index.ts';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, timeout: 30_000 }).toString('utf8');
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('Agent WRFC chains run isolated, fix steps included', () => {
  test('a chain gets its own worktree, members spawn there, and its fix workstream runs on the Agent engine rooted in that worktree', async () => {
    const services = getTestRuntimeServices();
    const root = services.workingDirectory;
    git(root, ['config', 'user.name', 'Fixture Owner']);
    git(root, ['config', 'user.email', 'owner@example.test']);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'isolation-fixture.ts'), 'export const delay = 1;\n');
    git(root, ['add', 'src/isolation-fixture.ts']);
    git(root, ['commit', '-q', '-m', 'fixture']);
    // An edit the user has not committed, in a file the chain will touch.
    writeFileSync(join(root, 'src', 'isolation-fixture.ts'), '// owner edit\nexport const delay = 1;\n');

    // The chain owner, as the agent manager records it (no executor runs in tests).
    const owner = services.agentManager.spawn({ mode: 'spawn', task: 'Cap the delay in src/isolation-fixture.ts', template: 'engineer', dangerously_disable_wrfc: true });
    const chain = services.wrfcController.createChain(owner);
    await until(() => chain.engineerAgentId !== undefined, 'engineer spawn');

    const workspace = chain.workspace!;
    expect(workspace.path.startsWith(join(root, '.goodvibes', '.worktrees', 'wrfc'))).toBe(true);
    expect(existsSync(workspace.path)).toBe(true);
    expect(git(workspace.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(workspace.branch);
    const engineer = services.agentManager.getStatus(chain.engineerAgentId!)!;
    expect(engineer.workingDirectory).toBe(workspace.cwd);
    // The chain starts from the user's files; the user's own directory is not written.
    expect(readFileSync(join(workspace.path, 'src', 'isolation-fixture.ts'), 'utf8')).toContain('owner edit');

    // The fix step: the Agent's own engine, worktree isolation, rooted in the chain worktree.
    const runner = (services.wrfcController as unknown as { fixWorkstreamRunner: { run: (input: unknown) => Promise<unknown>; stop?: (chainId: string, reason: string) => number } }).fixWorkstreamRunner;
    const before = services.orchestrationEngine.listWorkstreams().length;
    void runner.run({
      chainId: chain.id, originalTask: owner.task, attempt: 1, commitScope: 'scoped', rootDir: workspace.cwd,
      review: {
        version: 1, archetype: 'reviewer', summary: 's', score: 2, passed: false, dimensions: [],
        issues: [{ severity: 'major', description: 'src/isolation-fixture.ts: the delay is never capped.', pointValue: 2 }],
      },
    });
    const fixStream = services.orchestrationEngine.listWorkstreams().slice(before).at(-1)!;
    expect(fixStream.isolation).toBe('worktree');
    expect(fixStream.rootDir).toBe(workspace.cwd);
    expect(runner.stop?.(chain.id, 'test done')).toBeGreaterThanOrEqual(0);

    // Cancelling the chain leaves the user's files alone and releases the worktree.
    services.runtimeBus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', agentId: owner.id, reason: 'test done' }, { sessionId: 't', traceId: 't', source: 't' }));
    await until(() => chain.state === 'failed', 'chain cancel');
    expect(readFileSync(join(root, 'src', 'isolation-fixture.ts'), 'utf8')).toBe('// owner edit\nexport const delay = 1;\n');
    expect(existsSync(workspace.path)).toBe(false);
  });
});
