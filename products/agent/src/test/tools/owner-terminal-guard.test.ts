import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_OWNER_TERMINAL_GUARD as ENGINE_OWNER_TERMINAL_GUARD } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import type { RuntimeServices } from '../../runtime/services.ts';
import { AGENT_OWNER_TERMINAL_GUARD } from '../../runtime/agent-exec-posture.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
const runtimes: RuntimeServices[] = [];
// Own the reset even when another suite imported the cached helper first.
beforeEach(() => {
  resetTestRuntimeServices();
  previousPort = installJudgmentPort(undefined);
});
afterEach(async () => {
  try {
    for (const services of runtimes.splice(0)) {
      try { await services.processManager.close(); }
      finally { services.dispose(); }
    }
  } finally {
    resetTestRuntimeServices();
    installJudgmentPort(previousPort);
  }
});

/** The line the refusal carries, so a person is told which rule stopped them. */
const RULE = 'the owner\'s terminal is untouchable';

/** The same local composition bootstrap-core.ts builds for a live Agent turn. */
function localTurnTools(): { registry: ToolRegistry; workingDirectory: string } {
  const services = getTestRuntimeServices();
  runtimes.push(services);
  const { toolRegistry: registry } = composeAgentToolRegistry({
    services,
    configManager: services.configManager,
    homeDirectory: services.homeDirectory,
    resolveSessionId: () => 'owner-terminal-adoption',
    getLastUserMessage: () => 'Run the scratch terminal probes',
  });
  installJudgmentPort(fakePort((name, question, state) => {
    const text = JSON.stringify(state);
    if (name === 'acts_on_session') return noulAnswer(text.includes('send-keys') ? 0.999 : 0.001);
    if (name === 'owned_targets') return noulAnswer(text.includes('goodvibes-agent-workspace') ? 0.999 : 0.001);
    if (name === 'credential') {
      const envName = typeof state === 'object' && state !== null && 'name' in state ? String(state.name) : '';
      return noulAnswer(/key|token|secret|password|credential/i.test(envName) ? 0.999 : 0.001);
    }
    if (name === 'kind') return choiceAnswer(question, 'other', 0.99);
    if (['catastrophic', 'needsNetwork', 'needsPrivilege', 'will_prompt'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unexpected owner-terminal judgment: ${name}`);
  }).port);
  return { registry, workingDirectory: services.workingDirectory };
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
  test('the product compatibility export is the canonical engine posture, not a copied value', () => {
    expect(AGENT_OWNER_TERMINAL_GUARD).toBe(ENGINE_OWNER_TERMINAL_GUARD);
    expect(AGENT_OWNER_TERMINAL_GUARD).toEqual({ posture: 'enforced' });
  });

  test('typing into a session this platform did not name is refused, naming the rule', async () => {
    const { registry, workingDirectory } = localTurnTools();

    const marker = join(workingDirectory, 'foreign-terminal-ran');
    // A private socket with no server: even if enforcement regresses, the
    // command can only write this fixture marker, never touch a real terminal.
    const outcome = await runCommand(registry,
      `tmux -L gv-posture-${process.pid} send-keys -t main "echo owned" Enter; printf ran > '${marker}'`);

    expect(existsSync(marker)).toBe(false);

    expect(outcome.success).toBe(false);
    expect(outcome.stderr).toContain(RULE);
    // The command must not have run on the way to being reported.
    expect(outcome.stdout).not.toContain('owned');
  });

  test('reading tmux state is not touching it, and still runs', async () => {
    const { registry, workingDirectory } = localTurnTools();

    // The marker proves the command actually reached the shell:
    // `tmux list-sessions` fails on a host with no tmux server (and on one with
    // no tmux at all), and neither of those is the thing under test.
    const marker = join(workingDirectory, 'terminal-read-ran');
    const outcome = await runCommand(registry,
      `tmux -L gv-posture-${process.pid} list-sessions; printf probe-ran > '${marker}'; cat '${marker}'`);

    expect(outcome.stderr).not.toContain(RULE);
    expect(outcome.success, outcome.stderr).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('probe-ran');
    expect(outcome.stdout).toContain('probe-ran');
  });

  test('driving the platform\'s OWN session stays allowed', async () => {
    const { registry, workingDirectory } = localTurnTools();

    const marker = join(workingDirectory, 'owned-terminal-ran');
    const outcome = await runCommand(registry,
      `tmux -L gv-posture-${process.pid} send-keys -t goodvibes-agent-workspace "echo ours" Enter; printf probe-ran > '${marker}'; cat '${marker}'`);

    expect(outcome.stderr).not.toContain(RULE);
    expect(outcome.success, outcome.stderr).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('probe-ran');
    expect(outcome.stdout).toContain('probe-ran');
  });
});
