import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  // Exercise the actual exec path without contacting the owner's tmux server.
  writeFileSync(join(root, 'tmux'), '#!/bin/sh\nprintf \"fixture-tmux:%s\\n\" \"$*\"\n', { mode: 0o700 });
  return createExecTool(new ProcessManager(), {
    overflowHandler: new OverflowHandler({ baseDir: root }),
    defaultWorkingDirectory: root,
    ownerTerminal: AGENT_OWNER_TERMINAL_GUARD,
  });
}

async function run(cmd: string) {
  const result = await agentExecTool().execute({ commands: [{ cmd: cmd.replaceAll('tmux ', './tmux ') }] });
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

describe('the Agent exec posture', () => {
  test('uses the configured permissions without an extra terminal prompt', () => {
    expect(AGENT_OWNER_TERMINAL_GUARD).toEqual({ posture: 'off' });
  });
  test.each(['tmux send-keys -t fixture echo owned', 'tmux list-sessions'])('runs authorized terminal command %s through the fixture', async command => {
    const outcome = await run(command);
    expect(outcome.success).toBe(true);
    expect(outcome.stdout).toContain('fixture-tmux:');
    expect(outcome.stderr).not.toContain(RULE);
  });
});
