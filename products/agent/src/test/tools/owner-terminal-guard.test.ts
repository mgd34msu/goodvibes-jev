/**
 * owner-terminal-guard.test.ts, the owner's terminal is untouchable on a
 * LOCAL turn too.
 *
 * A turn hosted by the daemon runs under the platform's owner-terminal rule
 * because the daemon's composition states it. A turn this process runs itself
 *, routing off, no connected host, a message carrying attachments, reaches
 * the same tmux server through the same exec tool. Stating the rule on only one
 * of those two paths protects nothing: it takes one turn that fell back to
 * local to type into the owner's pane.
 *
 * So this exercises the agent's own tool composition, with the same guard value
 * the agent's bootstrap passes (agent-exec-posture.ts), and proves both halves
 * of the rule: driving a session this platform did not name is refused, and
 * reading tmux state still runs.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { CrossSessionTaskRegistry } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { FileUndoManager, ModeManager } from '@goodvibes-jev/engine/sdk/platform/state';
import {
  AgentManager,
  OverflowHandler,
  ProcessManager,
  ToolRegistry,
  createWorkflowServices,
  registerAllTools,
} from '@goodvibes-jev/engine/sdk/platform/tools';
import { RemoteRunnerRegistry, SandboxSessionRegistry } from '@/runtime/index.ts';
import { AGENT_OWNER_TERMINAL_GUARD } from '../../runtime/agent-exec-posture.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** The line the refusal carries, so a person is told which rule stopped them. */
const RULE = 'the owner\'s terminal is untouchable';

/**
 * The agent's local tool registry, composed the way bootstrap-core.ts composes
 * it in the part that matters here: with the product's own owner-terminal
 * guard, read from the same constant production reads.
 */
function localTurnTools(): ToolRegistry {
  const registry = new ToolRegistry();
  const workingDirectory = makeProjectTempDir('agent-owner-terminal');
  const services = createTestManagers();
  const agentManager = new AgentManager({
    messageBus: new AgentMessageBus(),
    configManager: services.configManager,
  });
  registerAllTools(registry, {
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentManager,
    agentMessageBus: new AgentMessageBus(),
    configManager: services.configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    sessionOrchestration: new CrossSessionTaskRegistry(
      join(workingDirectory, '.goodvibes', 'agent', 'sessions', 'task-graph.json'),
    ),
    sandboxSessionRegistry: new SandboxSessionRegistry(workingDirectory),
    remoteRunnerRegistry: new RemoteRunnerRegistry(agentManager),
    workingDirectory,
    overflowHandler: new OverflowHandler({ baseDir: workingDirectory }),
    workflowServices: createWorkflowServices(),
    channelRegistry: null,
    ownerTerminalGuard: AGENT_OWNER_TERMINAL_GUARD,
  });
  return registry;
}

async function runCommand(registry: ToolRegistry, cmd: string): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
}> {
  const result = await registry.execute(`owner-terminal-${cmd.slice(0, 12)}`, 'exec', {
    commands: [{ cmd }],
  });
  const output = JSON.parse(String(result.output ?? '{}')) as Record<string, unknown>;
  return {
    success: result.success,
    stdout: String(output['stdout'] ?? ''),
    stderr: `${String(output['stderr'] ?? '')}${String(result.error ?? '')}`,
  };
}

describe('a local agent turn and the owner\'s tmux', () => {
  test('typing into a session this platform did not name is refused, naming the rule', async () => {
    const registry = localTurnTools();

    const outcome = await runCommand(registry, 'tmux send-keys -t main "echo owned" Enter');

    expect(outcome.success).toBe(false);
    expect(outcome.stderr).toContain(RULE);
    // The command must not have run on the way to being reported.
    expect(outcome.stdout).not.toContain('owned');
  });

  test('reading tmux state is not touching it, and still runs', async () => {
    const registry = localTurnTools();

    // The trailing echo is the proof the command actually reached the shell:
    // `tmux list-sessions` fails on a host with no tmux server (and on one with
    // no tmux at all), and neither of those is the thing under test.
    const outcome = await runCommand(registry, 'tmux list-sessions; echo probe-ran');

    expect(outcome.stderr).not.toContain(RULE);
    expect(outcome.stdout).toContain('probe-ran');
  });

  test('driving the platform\'s OWN session stays allowed', async () => {
    const registry = localTurnTools();

    const outcome = await runCommand(
      registry,
      'tmux send-keys -t goodvibes-agent-workspace "echo ours" Enter; echo probe-ran',
    );

    expect(outcome.stderr).not.toContain(RULE);
    expect(outcome.stdout).toContain('probe-ran');
  });
});
