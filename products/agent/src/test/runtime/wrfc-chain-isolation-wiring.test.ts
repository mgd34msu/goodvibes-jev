/** The former WRFC isolation obligation, exercised through the composed public contract runner. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_ASK, contractRuntimeFixture, waitForContract } from '../helpers/contract-runtime-fixture.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, timeout: 30_000 }).toString('utf8');
}

describe('Agent contracts isolate delegated work and cancellation', () => {
  test('the real composed runner starts units in worktrees and cancelling preserves the owner edit', async () => {
    let unitCwd: string | undefined;
    const fixture = contractRuntimeFixture(async (record, services) => {
      unitCwd = record.workingDirectory;
      const signal = services.agentManager.getCancellationSignal(record.id);
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const { services } = fixture;
    const root = services.workingDirectory;
    try {
      git(root, ['config', 'user.name', 'Fixture Owner']);
      git(root, ['config', 'user.email', 'owner@example.test']);
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
      writeFileSync(join(root, 'src/isolation-fixture.ts'), 'export const delay = 1;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-q', '-m', 'fixture']);
      writeFileSync(join(root, 'src/isolation-fixture.ts'), '// owner edit\nexport const delay = 1;\n');
      const { contract, owner } = services.contractRunner.start({ ask: CONTRACT_ASK, sessionId: 'isolation', origin: 'agent-tool', projectRoot: root });
      await waitForContract(() => unitCwd !== undefined, () => JSON.stringify({ contract: services.contractRunner.get(contract.id), requested: fixture.requested }));
      const running = services.contractRunner.get(contract.id)!;
      expect(running.isolation).toBe('worktree');
      expect(running.worktreePath?.startsWith(join(root, '.goodvibes', '.worktrees', 'contract'))).toBe(true);
      expect(existsSync(running.worktreePath!)).toBe(true);
      if (!running.branch) throw new Error('Worktree contract lacks its branch');
      expect(git(running.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(running.branch);
      expect(unitCwd).not.toBe(root);
      expect(unitCwd).not.toBe(running.worktreePath);
      expect(existsSync(unitCwd!)).toBe(true);
      expect(readFileSync(join(root, 'src/isolation-fixture.ts'), 'utf8')).toBe('// owner edit\nexport const delay = 1;\n');
      expect(services.contractRunner.cancel(contract.id, 'test done')).toBe(true);
      await waitForContract(() => services.contractRunner.get(contract.id)?.status === 'cancelled', () => 'contract cancellation');
      expect(services.agentManager.getStatus(owner.id)?.status).toBe('cancelled');
      expect(services.agentManager.list().filter((record) => record.contractId === contract.id && record.contractRole === 'unit').every((record) => record.status === 'cancelled')).toBe(true);
      expect(readFileSync(join(root, 'src/isolation-fixture.ts'), 'utf8')).toBe('// owner edit\nexport const delay = 1;\n');
    } finally { fixture.dispose(); }
  }, 15_000);
});
