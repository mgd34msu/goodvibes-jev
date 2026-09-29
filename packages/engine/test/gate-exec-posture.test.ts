// Ported from goodvibes-agent src/test/tools/owner-terminal-guard.test.ts.
//
// The Agent's local turns state the owner-terminal rule with the value in
// gate/policy/exec-posture.ts. hosted-exec-containment.test.ts already pins
// the guard itself and that the platform's own session stays drivable; these
// are the agent test's remaining claims, through a real exec tool given the
// Agent's value: typing into a session the platform did not name is refused,
// naming the rule, and reading tmux state still runs. (The agent test's check
// that its bootstrap passes this value stays with the agent product.)
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../sdk/src/platform/tools/exec/index.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { AGENT_OWNER_TERMINAL_GUARD } from '../sdk/src/platform/gate/policy/exec-posture.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// The tools batteries exec reads (credential names, prompts, retries, the
// owner-terminal reading) and, forwarded with EXEC_GATE_TABLE, the gate's
// questions, in one fake port. Typing into the owner's `main` session reads as
// driving a terminal the platform does not own; listing sessions does not.
useToolReadings([['tmux send-keys -t main', { foreignTerminal: true }]], EXEC_GATE_TABLE);

/** The line the refusal carries, so a person is told which rule stopped them. */
const RULE = 'the owner\'s terminal is untouchable';

const roots: string[] = [];

function agentExecTool() {
  const root = mkdtempSync(join(tmpdir(), 'gv-agent-owner-terminal-'));
  roots.push(root);
  return createExecTool(new ProcessManager(), {
    overflowHandler: new OverflowHandler({ baseDir: root }),
    defaultWorkingDirectory: root,
    ownerTerminal: AGENT_OWNER_TERMINAL_GUARD,
  });
}

async function run(cmd: string) {
  const result = await agentExecTool().execute({ commands: [{ cmd }] });
  const output = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
  return {
    success: result.success,
    stdout: String(output['stdout'] ?? ''),
    stderr: `${String(output['stderr'] ?? '')}${String(result.error ?? '')}`,
  };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the Agent\'s exec posture and the owner\'s tmux', () => {
  test('the Agent states the rule as enforced', () => {
    expect(AGENT_OWNER_TERMINAL_GUARD).toEqual({ posture: 'enforced' });
  });

  test('typing into a session this platform did not name is refused, naming the rule', async () => {
    const outcome = await run('tmux send-keys -t main "echo owned" Enter');
    expect(outcome.success).toBe(false);
    expect(outcome.stderr).toContain(RULE);
    // The command must not have run on the way to being reported.
    expect(outcome.stdout).not.toContain('owned');
  });

  test('reading tmux state is not touching it, and still runs', async () => {
    // The trailing echo proves the command reached the shell: `tmux
    // list-sessions` fails on a host with no tmux server, and that is not the
    // thing under test.
    const outcome = await run('tmux list-sessions; echo probe-ran');
    expect(outcome.stderr).not.toContain(RULE);
    expect(outcome.stdout).toContain('probe-ran');
  });
});
