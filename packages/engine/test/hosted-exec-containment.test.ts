/**
 * hosted-exec-containment.test.ts, a hosted conversational turn does not get
 * the host, and it does not get the owner's terminal.
 *
 * Three layers, pinned separately so a regression says which one moved:
 *
 *  1. The containment decision (exec/containment.ts), pure. Whether a
 *     composition that REQUIRES the boundary may run a command given the plan
 *     the sandbox layer resolved, and whether an omitted posture changes
 *     anything (it must not).
 *  2. The owner-terminal guard (exec/owner-terminal-guard.ts): what it does
 *     with Jev's reading of the command. The benign/malicious pairs (for every
 *     refusal a neighbouring command that must still be allowed) are the
 *     calibration fixtures of engine.tools.owner-terminal.
 *  3. The exec tool end to end, a real `createExecTool` under each posture,
 *     because the decision functions being right is not the same claim as the
 *     tool consulting them on every path (foreground, retried, background).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideExecContainment,
  type ExecContainmentRequirement,
} from '../sdk/src/platform/tools/exec/containment.ts';
import {
  decideOwnerTerminalAccess,
  PLATFORM_TMUX_SESSION_PREFIX,
  type OwnerTerminalGuard,
} from '../sdk/src/platform/tools/exec/owner-terminal-guard.ts';
import type { ExecSandboxPlan } from '../sdk/src/platform/tools/exec/sandbox.ts';
import { createExecTool } from '../sdk/src/platform/tools/exec/index.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

// The tools batteries exec reads (credential names, prompts, retries, the
// owner-terminal reading) and, forwarded with EXEC_GATE_TABLE, the gate's
// questions, in one fake port. Typing into the owner's `main` session reads as
// driving a terminal the platform does not own; nothing else does.
useToolReadings([['tmux send-keys -t main', { foreignTerminal: true }]], EXEC_GATE_TABLE);

// ── Fixtures ────────────────────────────────────────────────────────────────

const REQUIRED: ExecContainmentRequirement = {
  posture: 'required',
  reason: 'this is a daemon-hosted conversational turn',
};
const HOST_ALLOWED: ExecContainmentRequirement = {
  posture: 'host-allowed',
  reason: 'this hosted workstream was composed with the host explicitly granted',
};
const ENFORCED: OwnerTerminalGuard = { posture: 'enforced' };

const contained: ExecSandboxPlan = {
  sandboxed: true,
  argvPrefix: ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--'],
  boundary: 'bubblewrap: workspace writable, system read-only',
  network: 'disabled',
  escalationsGranted: [],
  homeMasked: true,
};
const unavailable: ExecSandboxPlan = {
  sandboxed: false,
  argvPrefix: [],
  boundary: 'no sandbox: bubblewrap (bwrap) was not found on PATH',
  network: 'enabled',
  escalationsGranted: [],
  homeMasked: false,
  unavailableReason: 'per-command exec sandbox unavailable: bubblewrap (bwrap) was not found on PATH',
};
const switchedOff: ExecSandboxPlan = {
  sandboxed: false,
  argvPrefix: [],
  boundary: 'no sandbox: per-command exec sandbox is not enabled',
  network: 'enabled',
  escalationsGranted: [],
  homeMasked: false,
};

// ── 1. The containment decision ─────────────────────────────────────────────

describe('decideExecContainment', () => {
  test('required + a real boundary → allowed', () => {
    expect(decideExecContainment(REQUIRED, contained).allowed).toBe(true);
  });

  test('required + no boundary because the host cannot provide one → refused, naming why', () => {
    const decision = decideExecContainment(REQUIRED, unavailable);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain('bubblewrap (bwrap) was not found on PATH');
    expect(decision.refusal).toContain('daemon-hosted conversational turn');
  });

  test('required + the sandbox switched off → still refused; a config switch is not a grant', () => {
    const decision = decideExecContainment(REQUIRED, switchedOff);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain('not enabled');
  });

  test('required + no sandbox wired at all → refused, and says so plainly', () => {
    const decision = decideExecContainment(REQUIRED, null);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain('no exec sandbox is wired into this session');
  });

  test('host-allowed + no boundary → allowed; this is the terminal posture, unchanged', () => {
    expect(decideExecContainment(HOST_ALLOWED, unavailable).allowed).toBe(true);
    expect(decideExecContainment(HOST_ALLOWED, null).allowed).toBe(true);
  });

  test('an omitted posture never tightens a caller: undefined and null both allow', () => {
    expect(decideExecContainment(undefined, null).allowed).toBe(true);
    expect(decideExecContainment(null, unavailable).allowed).toBe(true);
  });
});

describe('terminal access uses the common tool policy', () => {
  const readings = useToolReadings([['fixture', { foreignTerminal: true }]], EXEC_GATE_TABLE);
  test('no separate Jev refusal or confidence threshold', async () => {
    expect((await decideOwnerTerminalAccess('printf fixture', ENFORCED)).allowed).toBe(true);
    expect(readings.requests).toHaveLength(0);
  });
});

// ── 3. The exec tool, end to end ────────────────────────────────────────────

describe('exec tool under a hosted conversational posture', () => {
  const roots: string[] = [];
  const makeTool = (over: {
    containment?: ExecContainmentRequirement | undefined;
    ownerTerminal?: OwnerTerminalGuard | undefined;
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'gv-hosted-exec-'));
    roots.push(root);
    return createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      // No sandbox wiring at all: the composition asked for containment and the
      // boundary is absent, which is exactly the shape the incident had.
      ...(over.containment ? { containment: over.containment } : {}),
      ...(over.ownerTerminal ? { ownerTerminal: over.ownerTerminal } : {}),
    });
  };
  const run = async (tool: ReturnType<typeof createExecTool>, cmd: string, extra: Record<string, unknown> = {}) => {
    const result = await tool.execute({ commands: [{ cmd, ...extra }] });
    return { result, output: JSON.parse(String(result.output ?? '{}')) as Record<string, unknown> };
  };

  test('required + no boundary → the command does not run, and says why', async () => {
    const { result, output } = await run(makeTool({ containment: REQUIRED }), 'echo contained-or-not');
    expect(result.success).toBe(false);
    expect(String(output['stderr'])).toContain('requires commands to run inside the exec boundary');
    expect(String(output['stdout'])).not.toContain('contained-or-not');
  });

  test('the same command under the terminal posture runs, unchanged', async () => {
    const { result, output } = await run(makeTool({ containment: HOST_ALLOWED }), 'echo contained-or-not');
    expect(result.success).toBe(true);
    expect(String(output['stdout'])).toContain('contained-or-not');
  });

  test('with no containment stated at all it runs, unchanged', async () => {
    const { result } = await run(makeTool({}), 'echo plain');
    expect(result.success).toBe(true);
  });

  test('`background: true` is not the spelling that gets a contained turn onto the host', async () => {
    const { result, output } = await run(
      makeTool({ containment: REQUIRED }),
      'sleep 30',
      { background: true },
    );
    expect(result.success).toBe(false);
    expect(String(output['stderr'])).toContain('background command cannot run inside the exec boundary');
  });

  test('terminal policy does not add a Jev veto inside the executable tool', async () => {
    const { result, output } = await run(makeTool({ ownerTerminal: ENFORCED }), 'printf terminal-fixture');
    expect(result.success).toBe(true);
    expect(String(output['stdout'])).toBe('terminal-fixture');
  });

  test('the platform driving its OWN tmux session still works through the tool', async () => {
    // Refused only if the guard fires; tmux itself need not be installed for
    // the guard's verdict, so this asserts the guard let it through rather
    // than asserting tmux succeeded.
    const { output } = await run(
      makeTool({ ownerTerminal: ENFORCED }),
      `tmux has-session -t ${PLATFORM_TMUX_SESSION_PREFIX}build`,
    );
    expect(String(output['stderr'] ?? '')).not.toContain('owner\'s terminal is untouchable');
  });

  test('cleanup', () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    expect(roots).toHaveLength(0);
  });
});
