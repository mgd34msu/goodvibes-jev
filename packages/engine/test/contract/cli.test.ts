/**
 * The contract command line (docs/design/contract-runner.md 10.1): every
 * command and exit code against a scripted runner over real contract trees,
 * session-mode turns through the session driver, and the composition's
 * once-per-root resume the CLI awaits.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_CANCEL_REASON,
  CLI_INTERRUPT_REASON,
  EXIT_AWAITING_OWNER,
  EXIT_FAILED,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  SESSION_CONTINUE_LINE,
  runContractCli,
} from '../../sdk/src/platform/contract/cli.js';
import { formatContractEvent } from '../../sdk/src/platform/contract/cli-render.js';
import type { ResumeReport } from '../../sdk/src/platform/contract/resume.js';
import { SurfaceHomeInUseError } from '../../sdk/src/platform/runtime/home-single-writer.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { ALL_CONTRACT_EVENTS } from './event-samples.js';
import { CLI_SESSION, FakeIo, PROJECT, cliHarness, unitCheck, until } from './cli-support.js';
import { makeContract, makeCriterion, makeUnit } from './fixtures.js';

const ASK = 'Add a parser that can accept every documented input form.';

describe('run', () => {
  test('a passing contract prints its answer on stdout and its status line on stderr, and exits 0', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => {
      harness.runner.move(contract, 'shaping');
      harness.runner.pass(contract);
    };
    const io = new FakeIo(false);
    const code = await runContractCli(['run', ASK, '--isolation', 'shared'], io, harness.deps);
    expect(code).toBe(EXIT_OK);
    expect(harness.runner.started).toEqual([{ ask: ASK, sessionId: CLI_SESSION, origin: 'cli', projectRoot: PROJECT, isolation: 'shared' }]);
    expect(io.stdout).toEqual(['The parser is written and tested.']);
    expect(io.stderr.at(-1)).toMatch(/passed; 1\/1 criteria met/);
    // The event lines, including the one start emitted before the CLI knew the id.
    expect(io.stderr.some((line) => line.includes('] created (origin cli'))).toBe(true);
    expect(io.stderr.some((line) => line.includes('] status queued -> shaping'))).toBe(true);
    expect(harness.opened.disposed).toBe(1);
  });

  test('a failing contract prints its status line on stderr and exits 1', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => harness.runner.fail(contract);
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_FAILED);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.at(-1)).toMatch(/failed: the planner could not plan/);
  });

  test('a contract that asks its owner with no terminal exits 2 and stays waiting', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => { harness.runner.escalate(contract); };
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_AWAITING_OWNER);
    const contract = [...harness.runner.contracts.values()][0]!;
    expect(contract.status).toBe('awaiting-owner');
    expect(harness.runner.cancels).toEqual([]);
    expect(harness.runner.replies).toEqual([]);
    expect(io.stderr.at(-1)).toContain(`goodvibes-contract reply ${contract.id}`);
  });

  test('at a terminal the question is put, the reply sent, a question put again is asked again, and the contract passes', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => { harness.runner.escalate(contract); };
    harness.runner.onReply = (contract, escalationId, text) => {
      harness.runner.resolveEscalation(contract, escalationId);
      if (text === 'make it faster') {
        const next = harness.runner.escalate(contract, 'I could not tell whether that approves, changes or stops the work.');
        return { escalationId, reading: 'unclear', outcome: 'escalate', action: 'asked-again', nextEscalationId: next.id };
      }
      queueMicrotask(() => harness.runner.pass(contract));
      return { escalationId, reading: 'approve', outcome: 'act', action: 'approved' };
    };
    // The empty line is no reply; the question is put again.
    const io = new FakeIo(true, ['', 'make it faster', 'yes, go ahead']);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_OK);
    const contract = [...harness.runner.contracts.values()][0]!;
    expect(harness.runner.replies).toEqual([
      [contract.id, `${contract.id}.e1`, 'make it faster'],
      [contract.id, `${contract.id}.e2`, 'yes, go ahead'],
    ]);
    expect(io.prompts).toHaveLength(3);
    expect(io.stderr.some((line) => line.includes('The parser keeps failing criterion u1.c1'))).toBe(true);
    expect(io.stderr.some((line) => line.includes('was read as unclear: asked-again'))).toBe(true);
    expect(io.stdout).toEqual(['The parser is written and tested.']);
  });

  test('at a terminal the end of input leaves the contract waiting and exits 2', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => { harness.runner.escalate(contract); };
    const io = new FakeIo(true, []);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_AWAITING_OWNER);
    expect(harness.runner.replies).toEqual([]);
  });

  test('SIGINT cancels the contract and exits 130', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => harness.runner.move(contract, 'running');
    const io = new FakeIo(false);
    const running = runContractCli(['run', ASK], io, harness.deps);
    await until(() => io.interruptHandlers.size > 0, 'the interrupt handler');
    io.interrupt();
    expect(await running).toBe(EXIT_INTERRUPTED);
    const contract = [...harness.runner.contracts.values()][0]!;
    expect(harness.runner.cancels).toEqual([[contract.id, CLI_INTERRUPT_REASON]]);
    expect(contract.status).toBe('cancelled');
    expect(harness.sessions.cancelled).toBe(1);
    expect(io.interruptHandlers.size).toBe(0);
  });

  test('a contract cancelled some other way exits 1', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => { harness.runner.cancel(contract.id, 'stopped by an operator'); };
    expect(await runContractCli(['run', ASK], new FakeIo(false), harness.deps)).toBe(EXIT_FAILED);
  });

  test('--json prints one JSON line per event and a final line with the answer and status line', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => harness.runner.pass(contract);
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK, '--json'], io, harness.deps)).toBe(EXIT_OK);
    const lines = io.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line['type'])).toEqual(['CONTRACT_CREATED', 'CONTRACT_STATUS_CHANGED', 'CONTRACT_PASSED', undefined]);
    const contract = [...harness.runner.contracts.values()][0]!;
    expect(lines.at(-1)).toEqual({ contractId: contract.id, status: 'passed', answer: 'The parser is written and tested.', statusLine: contract.statusLine! });
  });

  test('a start that throws exits 1 with the reason', async () => {
    const harness = cliHarness();
    harness.runner.start = () => { throw new Error('no route for the planner'); };
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_FAILED);
    expect(io.stderr).toEqual(['The contract could not start: no route for the planner']);
  });
});

describe('session mode', () => {
  function sessionModeStart(harness: ReturnType<typeof cliHarness>) {
    harness.runner.onStart = (contract) => {
      contract.sessionMode = true;
      harness.runner.move(contract, 'running');
      contract.units[0]!.status = 'running';
      harness.runner.emit({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: contract.id, groupId: 'g1', unitId: 'u1', from: 'pending', to: 'running' });
    };
  }

  test('the CLI submits the ask as the session turn, and a later turn with the fixed line when the checks ask for more', async () => {
    const harness = cliHarness();
    sessionModeStart(harness);
    const contract = () => [...harness.runner.contracts.values()][0]!;
    harness.sessions.onTurn = (_sessionId, text) => {
      const unit = contract().units[0]!;
      unit.checks.push(unitCheck(`u1.k${unit.checks.length + 1}`));
      if (text === ASK) {
        unit.status = 'nudged';
        harness.runner.emit({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: contract().id, groupId: 'g1', unitId: 'u1', from: 'checking', to: 'nudged' });
        return;
      }
      harness.runner.pass(contract());
    };
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_OK);
    expect(harness.sessions.submitted).toEqual([[CLI_SESSION, ASK], [CLI_SESSION, SESSION_CONTINUE_LINE]]);
  });

  test('a turn that ends before the unit\'s work is checked ends following with exit 1, and nothing more is submitted', async () => {
    const harness = cliHarness();
    sessionModeStart(harness);
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_FAILED);
    expect(harness.sessions.submitted).toEqual([[CLI_SESSION, ASK]]);
    expect(io.stderr.at(-1)).toContain('ended before its work was checked');
  });

  test('a contract that is not in session mode gets no turn', async () => {
    const harness = cliHarness();
    harness.runner.onStart = (contract) => {
      harness.runner.move(contract, 'running');
      contract.units[0]!.status = 'running';
      harness.runner.emit({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: contract.id, groupId: 'g1', unitId: 'u1', from: 'pending', to: 'running' });
      queueMicrotask(() => queueMicrotask(() => harness.runner.pass(contract)));
    };
    expect(await runContractCli(['run', ASK], new FakeIo(false), harness.deps)).toBe(EXIT_OK);
    expect(harness.sessions.submitted).toEqual([]);
  });
});

describe('status and list', () => {
  function stored() {
    const running = makeContract({
      id: 'ctr-0000000a',
      createdAt: 2_000,
      units: [makeUnit({
        status: 'running',
        criteria: [makeCriterion({
          id: 'u1.c1',
          origin: 'derived',
          serves: ['c1'],
          quote: undefined,
          status: 'met',
          readings: [
            { checkId: 'u1.k1', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', decisionId: undefined },
            { checkId: 'u1.k2', at: 2, probabilityUnmet: 0.1, verdict: 'met', outcome: 'act', decisionId: undefined },
          ],
        })],
      })],
      escalations: [{ id: 'ctr-0000000a.e1', at: 5, scope: 'unit', targetId: 'u1', reason: 'stalled', question: 'What should change?', unmetCriterionIds: [] }],
    });
    const passed = makeContract({ id: 'ctr-0000000b', status: 'passed', createdAt: 1_000, ask: 'Write the changelog entry.' });
    return { running, passed };
  }

  test('status <id> prints the tree with each criterion\'s latest verdict and the open questions', async () => {
    const harness = cliHarness();
    const { running } = stored();
    harness.onDisk.push(running);
    const io = new FakeIo(false);
    expect(await runContractCli(['status', running.id], io, harness.deps)).toBe(EXIT_OK);
    expect(io.stdout[0]).toContain('Contract ctr-0000000a  running');
    expect(io.stdout).toContain('  c1 [unread] The parser accepts every documented input form');
    expect(io.stdout).toContain('    u1.c1 [met] The parser accepts every documented input form');
    expect(io.stdout).toContain('  Unit u1 Parser  running');
    expect(io.stdout).toContain('    What should change?');
    expect(harness.opened.count).toBe(0);
  });

  test('status <id> --json prints the contract', async () => {
    const harness = cliHarness();
    const { running } = stored();
    harness.onDisk.push(running);
    const io = new FakeIo(false);
    expect(await runContractCli(['status', running.id, '--json'], io, harness.deps)).toBe(EXIT_OK);
    expect((JSON.parse(io.stdout[0]!) as { id: string }).id).toBe(running.id);
  });

  test('status of an unknown id exits 1', async () => {
    const harness = cliHarness();
    const io = new FakeIo(false);
    expect(await runContractCli(['status', 'ctr-deadbeef'], io, harness.deps)).toBe(EXIT_FAILED);
    expect(io.stderr).toEqual([`No contract ctr-deadbeef in ${PROJECT}.`]);
  });

  test('status with no id prints a table of every contract, newest first', async () => {
    const harness = cliHarness();
    const { running, passed } = stored();
    harness.onDisk.push(passed, running);
    const io = new FakeIo(false);
    expect(await runContractCli(['status'], io, harness.deps)).toBe(EXIT_OK);
    expect(io.stdout[0]).toMatch(/^ID\s+STATUS\s+UNITS\s+ORIGIN\s+CREATED\s+ASK$/);
    expect(io.stdout[1]).toContain('ctr-0000000a');
    expect(io.stdout[2]).toContain('ctr-0000000b');
  });

  test('list shows the contracts not ended; --all shows every one', async () => {
    const harness = cliHarness();
    const { running, passed } = stored();
    harness.onDisk.push(passed, running);
    const open = new FakeIo(false);
    expect(await runContractCli(['list'], open, harness.deps)).toBe(EXIT_OK);
    expect(open.stdout).toHaveLength(2);
    expect(open.stdout[1]).toContain('ctr-0000000a');
    const all = new FakeIo(false);
    expect(await runContractCli(['list', '--all'], all, harness.deps)).toBe(EXIT_OK);
    expect(all.stdout).toHaveLength(3);
  });

  test('list with nothing running says so', async () => {
    const harness = cliHarness();
    harness.onDisk.push(stored().passed);
    const io = new FakeIo(false);
    expect(await runContractCli(['list'], io, harness.deps)).toBe(EXIT_OK);
    expect(io.stdout[0]).toContain('No contracts running');
  });
});

describe('cancel and reply', () => {
  test('cancel stops a running contract (0) after the startup resume, and refuses an unknown one (1)', async () => {
    const harness = cliHarness();
    const contract = harness.runner.hold(makeContract({ id: 'ctr-0000000c' }));
    const io = new FakeIo(false);
    expect(await runContractCli(['cancel', contract.id], io, harness.deps)).toBe(EXIT_OK);
    expect(harness.opened.resumedCalls).toBe(1);
    expect(harness.runner.cancels).toEqual([[contract.id, CLI_CANCEL_REASON]]);
    expect(io.stdout[0]).toContain('cancelled');
    const again = new FakeIo(false);
    expect(await runContractCli(['cancel', contract.id], again, harness.deps)).toBe(EXIT_FAILED);
    expect(await runContractCli(['cancel', 'ctr-deadbeef'], new FakeIo(false), harness.deps)).toBe(EXIT_FAILED);
  });

  test('reply answers the open question (0); no open question or an unknown contract exits 1', async () => {
    const harness = cliHarness();
    const contract = harness.runner.hold(makeContract({ id: 'ctr-0000000d' }));
    harness.runner.escalate(contract);
    const io = new FakeIo(false);
    expect(await runContractCli(['reply', contract.id, 'Use the streaming reader instead.'], io, harness.deps)).toBe(EXIT_OK);
    expect(harness.runner.replies).toEqual([[contract.id, `${contract.id}.e1`, 'Use the streaming reader instead.']]);
    expect(io.stdout[0]).toContain('was read as approve: approved');
    const none = new FakeIo(false);
    expect(await runContractCli(['reply', contract.id, 'again'], none, harness.deps)).toBe(EXIT_FAILED);
    expect(none.stderr).toEqual([`Contract ${contract.id} has no open question.`]);
    expect(await runContractCli(['reply', 'ctr-deadbeef', 'hello'], new FakeIo(false), harness.deps)).toBe(EXIT_FAILED);
  });
});

describe('resume', () => {
  function report(overrides: Partial<ResumeReport>): ResumeReport {
    return { resumed: [], queued: [], reaped: [], skipped: [], ...overrides };
  }

  test('follows every resumed and queued contract, and exits 0 when all pass', async () => {
    const harness = cliHarness({ report: report({ resumed: [{ contractId: 'ctr-0000000e', step: 'run' }], queued: ['ctr-0000000f'] }) });
    const first = harness.runner.hold(makeContract({ id: 'ctr-0000000e' }));
    const second = harness.runner.hold(makeContract({ id: 'ctr-0000000f', status: 'queued' }));
    const io = new FakeIo(false);
    const resuming = runContractCli(['resume'], io, harness.deps);
    await until(() => io.interruptHandlers.size > 0, 'following');
    harness.runner.pass(first, 'first answer');
    harness.runner.move(second, 'running');
    harness.runner.pass(second, 'second answer');
    expect(await resuming).toBe(EXIT_OK);
    expect(io.stdout).toEqual(['first answer', 'second answer']);
  });

  test('a resumed contract waiting on its owner with no terminal exits 2; one already failed makes it 1', async () => {
    const waiting = cliHarness({ report: report({ resumed: [{ contractId: 'ctr-00000010', step: 'await-owner' }] }) });
    const contract = waiting.runner.hold(makeContract({ id: 'ctr-00000010' }));
    waiting.runner.escalate(contract);
    expect(await runContractCli(['resume'], new FakeIo(false), waiting.deps)).toBe(EXIT_AWAITING_OWNER);

    const failed = cliHarness({ report: report({ resumed: [{ contractId: 'ctr-00000011', step: 'run' }, { contractId: 'ctr-00000012', step: 'await-owner' }] }) });
    failed.runner.hold(makeContract({ id: 'ctr-00000011', status: 'failed', statusLine: 'Contract ctr-00000011 failed: gone' }));
    failed.runner.escalate(failed.runner.hold(makeContract({ id: 'ctr-00000012' })));
    expect(await runContractCli(['resume'], new FakeIo(false), failed.deps)).toBe(EXIT_FAILED);
  });

  test('nothing to resume says so and exits 0; a reaped contract exits 1', async () => {
    const empty = cliHarness();
    const io = new FakeIo(false);
    expect(await runContractCli(['resume'], io, empty.deps)).toBe(EXIT_OK);
    expect(io.stdout).toEqual([`Nothing to resume in ${PROJECT}.`]);
    const reaped = cliHarness({ report: report({ reaped: [{ contractId: 'ctr-00000013', reason: 'its worktree is gone' }] }) });
    const reapedIo = new FakeIo(false);
    expect(await runContractCli(['resume'], reapedIo, reaped.deps)).toBe(EXIT_FAILED);
    expect(reapedIo.stderr[0]).toContain('its worktree is gone');
  });

  test('a resume that failed exits 1', async () => {
    const harness = cliHarness({ report: null });
    expect(await runContractCli(['resume'], new FakeIo(false), harness.deps)).toBe(EXIT_FAILED);
  });
});

describe('usage and opening the runner', () => {
  test.each([
    [[]],
    [['launch', ASK]],
    [['run']],
    [['run', ASK, '--isolation', 'sideways']],
    [['run', ASK, '--all']],
    [['cancel']],
    [['reply', 'ctr-0000000d']],
    [['status', 'a', 'b']],
    [['list', '--cwd', '/no/such/directory/anywhere']],
  ])('%j is a usage error: usage on stderr, exit 64', async (argv) => {
    const harness = cliHarness();
    const io = new FakeIo(false);
    expect(await runContractCli(argv, io, harness.deps)).toBe(EXIT_USAGE);
    expect(io.stderr).toContain('Usage: goodvibes-contract <command> [options]');
    expect(harness.opened.count).toBe(0);
  });

  test('--help prints the usage on stdout and exits 0', async () => {
    const io = new FakeIo(false);
    expect(await runContractCli(['--help'], io, cliHarness().deps)).toBe(EXIT_OK);
    expect(io.stdout[0]).toBe('Usage: goodvibes-contract <command> [options]');
  });

  test('--cwd names the project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-cli-'));
    try {
      const harness = cliHarness();
      let asked = '';
      const io = new FakeIo(false);
      expect(await runContractCli(['list', `--cwd=${root}`], io, { ...harness.deps, readContracts: (projectRoot) => { asked = projectRoot; return []; } })).toBe(EXIT_OK);
      expect(asked).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('another process holding the project\'s contract runs is refused with its message, exit 1', async () => {
    const message = 'The contract-cli home at /work/project/.goodvibes/contract-cli/owner.json is in use by process 4242.';
    const harness = cliHarness({ openError: new SurfaceHomeInUseError(message, 4242) });
    const io = new FakeIo(false);
    expect(await runContractCli(['run', ASK], io, harness.deps)).toBe(EXIT_FAILED);
    expect(io.stderr).toEqual([message]);
    expect(harness.runner.started).toEqual([]);
  });
});

test('every contract event formats as one plain line naming its contract', () => {
  for (const event of ALL_CONTRACT_EVENTS) {
    const line = formatContractEvent(event);
    expect(line).not.toContain('\n');
    expect(line.startsWith(`[${event.contractId ?? 'contracts'}] `)).toBe(true);
  }
});

describe('resumeContracts', () => {
  test('repeated calls for one root return the same promise, resolving to the report; the runner resumes once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-resume-'));
    try {
      const resumeReport: ResumeReport = { resumed: [{ contractId: 'ctr-00000014', step: 'run' }], queued: [], reaped: [], skipped: [] };
      let calls = 0;
      const runner = { resumeAll: async () => { calls += 1; return resumeReport; } };
      const first = resumeContracts(runner, root);
      const second = resumeContracts(runner, `${root}/.`);
      expect(second).toBe(first);
      expect(await first).toBe(resumeReport);
      expect(calls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a resume that fails resolves to null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contract-resume-'));
    try {
      const runner = { resumeAll: async (): Promise<ResumeReport> => { throw new Error('store unreadable'); } };
      expect(await resumeContracts(runner, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
