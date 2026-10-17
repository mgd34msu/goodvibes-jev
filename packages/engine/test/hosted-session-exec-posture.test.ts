import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import {
  createClientRuntimeServices,
  type ClientRuntimeServices,
} from '../sdk/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime } from '../sdk/src/platform/hosted-sessions/session-runtime.ts';
import type { HostedSessionExecPosture } from '../sdk/src/platform/hosted-sessions/exec-posture.ts';
import type { PermissionPromptDecision } from '../sdk/src/platform/permissions/prompt.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';

let root: string;
let workspace: string;
let services: ClientRuntimeServices;
let readings: ReturnType<typeof installHostedSessionReadings>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-posture-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'tmux'), '#!/bin/sh\nprintf \"fixture-tmux:%s\\n\" \"$*\"\n', { mode: 0o700 });

  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes',
    configDir: join(root, 'cfg'),
    workingDir: workspace,
    homeDir: root,
  });
  // The state the daemon was actually in: the boundary is not applied. Whether
  // that is because bubblewrap is missing, the host refuses user namespaces, or
  // the switch is off makes no difference to what a contained turn owes.
  configManager.set('sandbox.enabled', false);

  const approveEverything = async (): Promise<PermissionPromptDecision> => ({ approved: true });
  services = createClientRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: workspace,
    homeDirectory: root,
    requestApproval: approveEverything,
    modelDiscovery: 'skip',
  });
  readings = installHostedSessionReadings({
    tools: [['tmux send-keys -t main', { foreignTerminal: true }]],
    gate: EXEC_GATE_TABLE,
  });
});

afterEach(() => {
  readings.restore();
  services.dispose();
  rmSync(root, { recursive: true, force: true });
});

/**
 * @param stated - How the posture is stated: not at all, on the FLOOR (the
 *   shape a product uses), or per session on the runtime options.
 */
function hostedSession(execPosture?: HostedSessionExecPosture, stated: 'floor' | 'session' = 'floor') {
  return createHostedSessionRuntime({
    sessionId: `hosted-posture-${execPosture ?? 'default'}`,
    workspaceRoot: workspace,
    floor: {
      services,
      contractRunner: services.contractRunner,
      ...(execPosture !== undefined && stated === 'floor' ? { execPosture: () => execPosture } : {}),
      dispose: (): void => {},
    },
    systemPrompt: 'hosted',
    ...(execPosture !== undefined && stated === 'session' ? { execPosture } : {}),
  });
}

async function runExec(
  session: ReturnType<typeof hostedSession>,
  cmd: string,
): Promise<{ success: boolean; stderr: string; stdout: string }> {
  const result = await session.toolRegistry.execute('call-1', 'exec', { commands: [{ cmd: cmd.replaceAll('tmux ', './tmux ') }] });
  const payload = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
  return {
    success: result.success,
    stderr: String(payload['stderr'] ?? ''),
    stdout: String(payload['stdout'] ?? ''),
  };
}

test('a hosted session with NO posture stated is contained: an uncontained command refuses', async () => {
  const session = hostedSession();
  const outcome = await runExec(session, 'echo reached-the-host');
  expect(outcome.success).toBe(false);
  expect(outcome.stderr).toContain('requires commands to run inside the exec boundary');
  expect(outcome.stderr).toContain('daemon-hosted conversational turn');
  expect(outcome.stdout).not.toContain('reached-the-host');
  expect(readings.requests.filter(request => request.context?.battery === 'engine.tools.owner-terminal')).toEqual([]);
  session.dispose();
});

test('the explicit conversational posture is the same answer', async () => {
  const session = hostedSession('conversational');
  const outcome = await runExec(session, 'echo reached-the-host');
  expect(outcome.success).toBe(false);
  expect(outcome.stdout).not.toContain('reached-the-host');
  session.dispose();
});

test('a workstream floor, granted the host explicitly, runs it', async () => {
  const session = hostedSession('workstream');
  const outcome = await runExec(session, 'echo reached-the-host');
  expect(outcome.success).toBe(true);
  expect(outcome.stdout).toContain('reached-the-host');
  session.dispose();
});

test('a per-session grant works too, and a per-session grant does not leak to the floor', async () => {
  const granted = hostedSession('workstream', 'session');
  expect((await runExec(granted, 'echo reached-the-host')).success).toBe(true);
  granted.dispose();
  // The floor said nothing, so the NEXT session on it is contained again.
  const next = hostedSession();
  expect((await runExec(next, 'echo reached-the-host')).success).toBe(false);
  next.dispose();
});

test('terminal commands follow the explicit containment posture without another Jev gate', async () => {
  for (const posture of ['conversational', 'workstream'] as const) {
    const session = hostedSession(posture);
    try {
      const outcome = await runExec(session, 'tmux send-keys -t fixture echo probe');
      expect(outcome.success).toBe(posture === 'workstream');
      if (posture === 'workstream') expect(outcome.stdout).toContain('fixture-tmux:');
      else expect(outcome.stderr).toContain('requires commands to run inside the exec boundary');
      expect(readings.requests.some(request => request.context?.battery === 'engine.tools.owner-terminal')).toBe(false);
    } finally { session.dispose(); }
  }
});
