/**
 * What the orchestration engine keeps for a restart (docs/design/contract-runner.md
 * section 7.2): a workstream snapshot still waiting on its debounce is written
 * when the engine is disposed; an imported item that passed but whose branch
 * had not integrated goes back on the integration lane; and a phase's end
 * releases only its own cancellation registration, so a requeued item's next
 * phase keeps the one it registered.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCancellationRegistry } from '../sdk/src/platform/orchestration/cancellation.js';
import { createOrchestrationEngine } from '../sdk/src/platform/orchestration/engine.js';
import type { PhaseRunnerAgentManagerLike } from '../sdk/src/platform/orchestration/phase-runner.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import type { OrchestrationEvent, PhaseSpec } from '../sdk/src/platform/orchestration/types.js';
import { makeFakeConfigManager, makeRecord } from './_helpers/orchestration-harness.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.email=a@b.c', '-c', 'user.name=test', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-resume-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'seed');
  return root;
}

/** An agent manager whose agents never finish: the item stays in its phase. */
function idleAgents(): PhaseRunnerAgentManagerLike {
  let count = 0;
  return {
    spawn: (input) => makeRecord({ id: `agent-${(count += 1)}`, task: (input as { task?: string }).task ?? 'task' }),
    getStatus: () => null,
    cancel: () => true,
    registerCancellationSignal: () => undefined,
    releaseCancellationSignal: () => undefined,
  };
}

const PHASE: PhaseSpec = { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } };

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the snapshot is the resume point', () => {
  test('a snapshot write still waiting on its debounce is written when the engine is disposed', () => {
    const root = repo();
    const engine = createOrchestrationEngine({ agentManager: idleAgents(), configManager: makeFakeConfigManager(), runtimeBus: new RuntimeEventBus(), projectRoot: root, skipClaimVerification: true });
    engine.createWorkstream({ id: 'ws-flush', title: 'flush', phases: [PHASE], items: [{ id: 'item-a', title: 'A', task: 't' }] });
    engine.start('ws-flush');
    const path = join(root, '.goodvibes', 'orchestration', 'ws-flush.json');
    // The spawn scheduled a write 250 ms out; nothing is on disk yet.
    expect(existsSync(path)).toBe(false);
    engine.dispose();
    const snapshot = JSON.parse(readFileSync(path, 'utf-8')) as { workstream: { items: { id: string; state: string }[] } };
    expect(snapshot.workstream.items).toEqual([expect.objectContaining({ id: 'item-a', state: 'in-phase' })]);
  });
});

describe('import reconciliation', () => {
  test('a passed item whose branch had not integrated goes back on the integration lane and merges', async () => {
    const root = repo();
    const bus = new RuntimeEventBus();
    const first = createOrchestrationEngine({ agentManager: idleAgents(), configManager: makeFakeConfigManager(), runtimeBus: bus, projectRoot: root, persist: false });
    first.createWorkstream({ id: 'ws-re', title: 're', phases: [PHASE], items: [{ id: 'item-x', title: 'X', task: 't' }], isolation: 'worktree' });
    const serialized = JSON.parse(first.serializeWorkstream('ws-re')!) as { workstream: { items: Record<string, unknown>[] } };
    first.dispose();

    // As the process left it: the item passed and committed on its branch, and the merge never ran.
    const path = join(root, '.goodvibes', '.worktrees', 'ws', 're', 'x');
    git(root, 'worktree', 'add', '-q', path, '-b', 'ws/re/x');
    writeFileSync(join(path, 'feature.txt'), 'done\n');
    git(path, 'add', 'feature.txt');
    git(path, 'commit', '-q', '-m', 'item work');
    Object.assign(serialized.workstream.items[0]!, { state: 'passed', currentPhaseId: null, worktreePath: path, worktreeBranch: 'ws/re/x', completedAt: 1 });

    const second = createOrchestrationEngine({ agentManager: idleAgents(), configManager: makeFakeConfigManager(), runtimeBus: bus, projectRoot: root, persist: false });
    const events: OrchestrationEvent[] = [];
    second.on((event) => events.push(event));
    expect(second.importWorkstream(JSON.stringify(serialized))).toBe(true);
    await until(() => events.some((event) => event.type === 'item-merged' && event.itemId === 'item-x'), 'item-x to merge');
    expect(second.getWorkstream('ws-re')!.items[0]!.mergeState).toBe('merged');
    expect(git(root, 'show', 'HEAD:feature.txt')).toBe('done\n');
    second.dispose();
  }, 30_000);
});

describe('cancellation registrations', () => {
  test('a phase that ends releases only its own registration, not the one its requeued item\'s next phase made', () => {
    const registry = createCancellationRegistry();
    const old = registry.start('item-a');
    const next = registry.start('item-a');
    expect(old.aborted).toBe(true);
    registry.release('item-a', old);
    expect(registry.isActive('item-a')).toBe(true);
    expect(registry.abort('item-a')).toBe(true);
    expect(next.aborted).toBe(true);
    registry.release('item-a', next);
    expect(registry.isActive('item-a')).toBe(false);
    // Without a signal, release drops whatever is registered.
    registry.start('item-b');
    registry.release('item-b');
    expect(registry.isActive('item-b')).toBe(false);
  });
});
