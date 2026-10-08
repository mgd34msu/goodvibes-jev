/**
 * exec-refusal-and-kill.test.ts
 *
 * A command refused, and a command killed, through the agent's OWN exec
 * pipeline: the runtime graph from createRuntimeServices (this repo's
 * composition root), the tool registry from composeAgentToolRegistry (the one
 * function bootstrap-core.ts builds the live registry with: the platform tools
 * with the agent's owner-terminal posture, the agent's own tools, then its
 * policy guard, platform-boundary guard and execution-safety wrapper, in that
 * order), the graph's permission manager with the agent's permission safety
 * guard installed on it, and the SDK's executeToolCalls, the
 * function the live Orchestrator calls for every tool call of a
 * main-conversation turn (permission check, then registry execute, with the
 * per-call cancel signal).
 *
 * The agent runs exec inside its sandbox, where only the workspace is
 * writable. Every file this test asserts on therefore lives INSIDE the agent's
 * workspace, so a guard that failed to refuse would really have written it.
 * The only destructive command is an `rm -rf` aimed at a directory this test
 * created inside that same temp workspace.
 *
 * The sandbox also gives commands their own PID namespace, so a PID the
 * command prints is not a host PID. Whether a command is still running is
 * answered on the host instead: each long command carries a unique token in
 * its own command line, and /proc is scanned for it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool, ToolCall, ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { composeAgentPermissionManager } from '../../runtime/bootstrap-core.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { installAgentMcpCallRoute } from '../../tools/agent-mcp-call-route.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** What the owner said this turn; the platform-boundary guard reads it. */
const LAST_USER_MESSAGE = 'run the maintenance commands in the scratch folder';

// The current engine reads permission stakes and exec policy through Jev.
// Script these fixture facts, not the permission decisions: allow-all/plan,
// Agent background refusal and the owner-terminal rule still decide normally.
function execReadings() {
  return fakePort((name, question, state) => {
    if (name === 'disposition' && question.type === 'choice') return choiceAnswer(question, Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject', 0.99);
    const foreignTerminal = JSON.stringify(state).includes('tmux -L gv-exec-refusal-');
    const readsFile = (state as { tool?: string }).tool === 'read';
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.99);
    if (name === 'kind') return choiceAnswer(question, readsFile ? 'read' : 'other', 0.99);
    if (name === 'mutates') return noulAnswer(readsFile ? 0.001 : 0.999);
    if (name === 'platform_source' || name === 'platform_requested') return noulAnswer(0.001);
    if (name === 'acts_on_session') return noulAnswer(foreignTerminal ? 0.999 : 0.001);
    if (name === 'owned_targets') return noulAnswer(foreignTerminal ? 0.001 : 0.999);
    if (name === 'credential') return noulAnswer(/key|token|secret|password|credential/i.test(String((state as { name?: string }).name)) ? 0.999 : 0.001);
    if (['outward', 'secrets', 'irreversible', 'beyondProject', 'weakensSecurity', 'obfuscated', 'flagsRisk', 'catastrophic', 'cardDetails', 'derives', 'needsNetwork', 'needsPrivilege', 'will_prompt'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted composed Agent exec judgment: ${name}`);
  });
}

let answers = execReadings();
let judgmentLog: SqliteDecisionLog;
let previousPort: ReturnType<typeof installJudgmentPort>;
const runtimes: RuntimeServices[] = [];
beforeEach(() => {
  answers = execReadings();
  judgmentLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(answers.port, judgmentLog));
});
afterEach(async () => {
  try {
    for (const services of runtimes.splice(0).reverse()) {
      try { await services.processManager.close(); }
      finally { services.dispose(); }
    }
  } finally {
    installJudgmentPort(previousPort);
    judgmentLog[Symbol.dispose]();
  }
});

/**
 * The agent's runtime graph over a fresh temp workspace and home. The home is
 * the temp root, so nothing derived from it (daemon home included) can point
 * at the machine's real one.
 */
function agentRuntime(prefix: string): { services: RuntimeServices; workspace: string } {
  const root = makeProjectTempDir(prefix);
  const workspace = join(root, 'workspace');
  const homeDir = join(root, 'home');
  const configDir = join(homeDir, '.goodvibes', 'agent');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  // Its own git toplevel, so checkpoint state stays inside the temp root
  // instead of the enclosing checkout (same reason as helpers/runtime-services).
  execFileSync('git', ['init', '-q'], { cwd: workspace, timeout: 30_000 });
  const services = createRuntimeServices({
    // Opt out: this process does not outlive the unawaited sweep.
    modelDiscovery: 'skip',
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    configManager: new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir, configDir }),
    workingDir: workspace,
    homeDirectory: homeDir,
    getConversationTitle: () => 'exec-refusal-and-kill',
  });
  runtimes.push(services);
  // Composition installs its production judgment port; replace only that I/O
  // boundary after construction so this regression stays offline.
  installJudgmentPort(withDecisionLog(answers.port, judgmentLog));
  return { services, workspace };
}

/**
 * The agent's main-conversation tool pipeline, through the same function
 * bootstrap-core.ts builds the live registry with, plus the permission safety
 * guard bootstrap-core installs on the graph's permission manager.
 */
function composeAgentExecPipeline(services: RuntimeServices): ToolRegistry {
  const { toolRegistry } = composeAgentToolRegistry({
    services,
    configManager: services.configManager,
    homeDirectory: services.homeDirectory,
    resolveSessionId: () => 'exec-refusal-and-kill',
    getLastUserMessage: () => LAST_USER_MESSAGE,
  });
  composeAgentPermissionManager(services);
  return toolRegistry;
}

/** The per-call cancel seam the Orchestrator hands executeToolCalls. */
class CallSignals {
  private readonly controllers = new Map<string, AbortController>();
  open(callId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(callId, controller);
    return controller.signal;
  }
  close(callId: string): void {
    this.controllers.delete(callId);
  }
  cancel(callId: string): boolean {
    const controller = this.controllers.get(callId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

type Pipeline = {
  readonly workspace: string;
  readonly signals: CallSignals;
  run(call: ToolCall): Promise<ToolResult>;
};

function agentPipeline(prefix: string, permissionMode: 'allow-all' | 'plan'): Pipeline {
  const { services, workspace } = agentRuntime(prefix);
  // A mode that decides without asking: the ask path raises on the daemon.
  services.configManager.set('permissions.mode', permissionMode);
  const toolRegistry = composeAgentExecPipeline(services);
  const signals = new CallSignals();
  const deps = agentExecutionDeps(services, toolRegistry, signals);
  return {
    workspace,
    signals,
    async run(call) {
      const [result] = await executeToolCalls(deps, 'turn-exec-refusal-and-kill', [call]);
      if (!result) throw new Error('executeToolCalls returned no result');
      return result;
    },
  };
}

function agentExecutionDeps(
  services: RuntimeServices,
  toolRegistry: ToolRegistry,
  signals: NonNullable<ToolExecutionDeps['toolCallSignals']>,
): ToolExecutionDeps {
  return {
    autonomousSource: () => ({ goal: LAST_USER_MESSAGE, criteria: [] }),
    toolRegistry,
    permissionManager: services.permissionManager,
    hookDispatcher: null,
    runtimeBus: null,
    sessionId: 'exec-refusal-and-kill',
    emitterContext: () => {
      throw new Error('runtimeBus is null, so no emitter context is requested');
    },
    toolCallSignals: signals,
  };
}

function execCall(id: string, args: Record<string, unknown>): ToolCall {
  return { id, name: 'exec', arguments: args };
}

/** Everything the model would read back from this result, as one string. */
function modelVisibleText(result: ToolResult): string {
  const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
  return `${result.error ?? ''}\n${output}`;
}

/** Host PIDs whose command line carries `token` (this process excluded). */
function hostPidsCarrying(token: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(token)) pids.push(Number(entry));
    } catch {
      // exited between readdir and read
    }
  }
  return pids;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

/** A victim directory and a marker path, both inside the agent's writable workspace. */
function scratch(workspace: string): { victim: string; victimFile: string; marker: string } {
  const victim = join(workspace, 'victim');
  mkdirSync(victim, { recursive: true });
  const victimFile = join(victim, 'keep.txt');
  writeFileSync(victimFile, 'still here\n');
  return { victim, victimFile, marker: join(workspace, 'marker-ran') };
}

/**
 * The positive control: the same pipeline, the same workspace, a command the
 * guards allow DOES write the marker. Without this, "marker absent" could mean
 * the sandbox cannot write there at all rather than "the command was refused".
 */
async function expectPipelineCanWrite(pipeline: Pipeline): Promise<void> {
  const probe = join(pipeline.workspace, 'control-probe');
  const result = await pipeline.run(execCall('control-probe', { commands: [{ cmd: `touch '${probe}'` }] }));
  expect(result).toMatchObject({ success: true });
  expect(existsSync(probe)).toBe(true);
}

describe('a command refused through the agent exec pipeline', () => {
  test('a background rm -rf is refused by the agent exec policy even though permission approved it, and never runs', async () => {
    // The recorded fixture admits the action under allow-all. The Agent's
    // own exec wrapper must still refuse the forbidden background command.
    const pipeline = agentPipeline('exec-refusal-policy', 'allow-all');
    await expectPipelineCanWrite(pipeline);
    const { victimFile, victim, marker } = scratch(pipeline.workspace);

    const result = await pipeline.run(execCall('refuse-background', {
      commands: [{ cmd: `rm -rf '${victim}'; touch '${marker}'`, background: true }],
    }));

    // The disk first: give a detached command, had one been started, time to
    // act, then check that nothing it would have done happened.
    await Bun.sleep(500);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(victimFile)).toBe(true);
    expect(readFileSync(victimFile, 'utf8')).toBe('still here\n');
    // Then what the model reads back: a refusal naming the rule.
    expect(result.success).toBe(false);
    expect(result.callId).toBe('refuse-background');
    expect(modelVisibleText(result)).toContain('GoodVibes Agent only runs foreground, serial command-line work');
  }, 20_000);

  test('typing into a tmux session the platform did not name is refused under the agent posture, and the command never runs', async () => {
    const pipeline = agentPipeline('exec-refusal-owner-terminal', 'allow-all');
    await expectPipelineCanWrite(pipeline);
    const { marker } = scratch(pipeline.workspace);
    // A private tmux socket name with no server behind it: even with the
    // posture off, this tmux call fails harmlessly and only the touch lands.
    const socket = `gv-exec-refusal-${process.pid}`;

    const result = await pipeline.run(execCall('refuse-owner-terminal', {
      commands: [{ cmd: `tmux -L ${socket} send-keys -t owner-main 'echo owned' Enter; touch '${marker}'` }],
    }));

    expect(existsSync(marker)).toBe(false);
    expect(result.success).toBe(false);
    expect(modelVisibleText(result)).toContain('the owner\'s terminal is untouchable');
  }, 20_000);

  test('in plan mode the agent permission layer refuses exec before it reaches the shell, with a structured denial', async () => {
    const pipeline = agentPipeline('exec-refusal-permission', 'plan');
    const { victim, victimFile, marker } = scratch(pipeline.workspace);

    const result = await pipeline.run(execCall('refuse-plan-mode', {
      commands: [{ cmd: `rm -rf '${victim}'; touch '${marker}'` }],
    }));

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(victimFile)).toBe(true);
    expect(readFileSync(victimFile, 'utf8')).toBe('still here\n');
    expect(result.success).toBe(false);
    const admission = answers.requests.find(request => request.context?.site === 'engine.gate.autonomous-tool');
    expect(admission?.state).toMatchObject({ input: { source: { goal: LAST_USER_MESSAGE, criteria: [] }, evidence: { constraints: { mode: 'plan', allowAct: false } } } });
    const disposition = admission?.questions.disposition;
    expect(disposition?.type).toBe('choice');
    if (disposition?.type !== 'choice') throw new Error('Missing recorded plan-mode disposition');
    expect(disposition.criteria).not.toHaveProperty('act');
    expect(result.denial).toMatchObject({ reason: 'jev_reject', scope: 'jev_decision' });
    expect(result.autonomousDecision?.outcome).toBe('reject');
    for (const id of result.autonomousDecision!.judgmentDecisionIds) expect(judgmentLog.get(id)?.status).toBe('answered');
    expect(modelVisibleText(result).trim().length).toBeGreaterThan(0);
  }, 20_000);
});

describe('a command killed through the agent exec pipeline', () => {
  test('a command past its timeout is killed: the process is gone, its later sentinel never appears, and the result says timed out', async () => {
    const pipeline = agentPipeline('exec-kill-timeout', 'allow-all');
    const started = join(pipeline.workspace, 'started');
    const sentinel = join(pipeline.workspace, 'sentinel-after-sleep');
    // Unique on this host, so the /proc scan finds only this command's sleep.
    const token = `3.${process.pid}${Date.now() % 100_000}`;

    const pending = pipeline.run(execCall('kill-timeout', {
      commands: [{ cmd: `touch '${started}'; sleep ${token}; touch '${sentinel}'`, timeout_ms: 1_000 }],
    }));
    expect(await waitFor(() => existsSync(started), 5_000)).toBe(true);
    expect(await waitFor(() => hostPidsCarrying(`sleep ${token}`).length > 0, 2_000)).toBe(true);

    const result = await pending;

    expect(result.success).toBe(false);
    expect(modelVisibleText(result)).toContain('timed out');
    expect(await waitFor(() => hostPidsCarrying(`sleep ${token}`).length === 0, 3_000)).toBe(true);
    // Past the point the sleep would have ended: nothing wrote the sentinel.
    await Bun.sleep(3_000);
    expect(existsSync(sentinel)).toBe(false);
  }, 20_000);

  test('cancelling the call through the per-call cancel seam kills the running command promptly', async () => {
    const pipeline = agentPipeline('exec-kill-cancel', 'allow-all');
    const started = join(pipeline.workspace, 'started');
    const sentinel = join(pipeline.workspace, 'sentinel-after-sleep');
    const token = `6.${process.pid}${Date.now() % 100_000}`;

    // A long own timeout, so only the cancel can stop it inside this window.
    const pending = pipeline.run(execCall('kill-cancel', {
      commands: [{ cmd: `touch '${started}'; sleep ${token}; touch '${sentinel}'`, timeout_ms: 30_000 }],
    }));
    expect(await waitFor(() => existsSync(started), 5_000)).toBe(true);
    expect(await waitFor(() => hostPidsCarrying(`sleep ${token}`).length > 0, 2_000)).toBe(true);

    const cancelledAt = Date.now();
    expect(pipeline.signals.cancel('kill-cancel')).toBe(true);
    const result = await pending;
    const settleMs = Date.now() - cancelledAt;

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    // Settled because of the cancel, not because the sleep ran out.
    expect(settleMs).toBeLessThan(3_000);
    expect(await waitFor(() => hostPidsCarrying(`sleep ${token}`).length === 0, 2_000)).toBe(true);
    // Past the point the sleep would have ended: nothing wrote the sentinel.
    await Bun.sleep(6_500);
    expect(existsSync(sentinel)).toBe(false);
  }, 30_000);
});

/**
 * Every tool's innermost execute, replaced at registration (before any agent
 * wrapper is installed) by a recorder of the options it was handed. What the
 * recorder sees is what the platform tool itself would have seen after the
 * whole agent wrapper chain ran.
 */
function composeWithRecorders(services: RuntimeServices): { registry: ToolRegistry; received: Map<string, AbortSignal | undefined> } {
  const received = new Map<string, AbortSignal | undefined>();
  const register = ToolRegistry.prototype.register;
  ToolRegistry.prototype.register = function registerWithRecorder(this: ToolRegistry, tool: Tool, options): void {
    const name = tool.definition.name;
    tool.execute = async (_args, options) => {
      received.set(name, options?.signal);
      return { success: true, output: 'recorded' };
    };
    // Preserve the real input projector and its captured read-resource evidence.
    register.call(this, tool, options);
  };
  let registry: ToolRegistry;
  try {
    registry = composeAgentExecPipeline(services);
    // The second registration stage (bootstrap-agent-tools.ts) adds tools after
    // the guards are installed, unwrapped: agent_harness among them, which
    // goodvibes_context looks up at call time and hands its call to.
    registry.register({
      definition: { name: 'agent_harness', description: 'recorder', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: '{}' }),
    });
  } finally {
    ToolRegistry.prototype.register = register;
  }
  // The same stage installs the MCP call route over the already-wrapped mcp tool.
  expect(installAgentMcpCallRoute(registry, mcpContext(() => new Promise(() => {})))).toBe(true);
  return { registry, received };
}

/** A command context whose MCP api has one connected, trusted server and the given callTool. */
function mcpContext(callTool: (qualifiedName: string, input: Record<string, unknown>) => Promise<unknown>): CommandContext {
  const mcpApi = {
    listServerSecurity: () => [{ name: 'fixture', connected: true, trustMode: 'ask-on-risk', role: 'general', schemaFreshness: 'fresh', allowedHosts: [] }],
    listAllTools: async () => [],
    callTool,
  };
  return { clients: { mcpApi } } as unknown as CommandContext;
}

/**
 * Tools whose agent wrapper replaces the platform execute and hands the call to
 * another registered tool instead: the signal must arrive THERE.
 */
const DELEGATES_TO: Readonly<Record<string, string>> = {
  // goodvibes_context answers every mode but `capabilities` through agent_harness.
  goodvibes_context: 'agent_harness',
};

describe('the cancel signal reaches the tool through every agent wrapper chain', () => {
  test('each registered tool receives the call signal after every agent wrapper ran', async () => {
    const { services, workspace } = agentRuntime('exec-cancel-every-chain');
    services.configManager.set('permissions.mode', 'allow-all');
    const { registry, received } = composeWithRecorders(services);
    const readPath = join(workspace, 'ordinary.txt');
    writeFileSync(readPath, 'SYNTHETIC ORDINARY FILE');
    const tools = registry.list();
    expect(tools.length).toBeGreaterThan(20);
    const dropped: string[] = [];
    const neverReached: string[] = [];
    for (const tool of tools) {
      const name = tool.definition.name;
      const inner = DELEGATES_TO[name] ?? name;
      const controller = new AbortController();
      received.clear();
      if (name === 'read') {
        // Adopted READ needs the same owner readiness, resource preparation and
        // admission as a live turn; a direct empty call must never reach it.
        const deps = agentExecutionDeps(services, registry, {
          open: () => controller.signal,
          close: () => {},
        });
        const [result] = await executeToolCalls(deps, 'turn-read-wrapper-signal', [{
          id: 'read-wrapper-signal', name, arguments: { files: [{ path: readPath }] },
        }]);
        expect(result?.success).toBe(true);
        expect(result?.autonomousDecision?.outcome).toBe('act');
        for (const site of ['engine.gate.agent-read-secrets', 'engine.gate.agent-read-scope']) {
          const evidence = judgmentLog.query({ site });
          expect(evidence).toHaveLength(1);
          const request = answers.requests.find(request => request.context?.site === site);
          expect(JSON.stringify(request?.state)).toContain(readPath);
        }
      } else {
        await tool.execute({}, { signal: controller.signal });
      }
      if (!received.has(inner)) neverReached.push(name);
      else if (received.get(inner) !== controller.signal) dropped.push(name);
    }
    // Every chain reached its platform tool, including genuinely admitted READ,
    // and every one delivered the call's own signal.
    expect(neverReached).toEqual([]);
    expect(dropped).toEqual([]);
  }, 60_000);

  test('a direct READ with a real ordinary path still cannot reach its recorder without admission', async () => {
    const { services, workspace } = agentRuntime('exec-cancel-direct-read');
    services.configManager.set('permissions.mode', 'allow-all');
    const { registry, received } = composeWithRecorders(services);
    const path = join(workspace, 'ordinary.txt');
    writeFileSync(path, 'SYNTHETIC ORDINARY FILE');
    const read = registry.list().find(tool => tool.definition.name === 'read');
    expect(read).toBeDefined();
    const result = await read!.execute({ files: [{ path }] }, { signal: new AbortController().signal });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unadmitted read authority');
    expect(received.has('read')).toBe(false);
    expect(answers.requests).toHaveLength(0);
  });

  test('an MCP call that never answers settles as cancelled as soon as its signal aborts', async () => {
    const { services } = agentRuntime('exec-cancel-mcp-call');
    services.configManager.set('permissions.mode', 'allow-all');
    const { registry } = composeWithRecorders(services);
    const mcp = registry.list().find((tool) => tool.definition.name === 'mcp');
    expect(mcp).toBeDefined();
    const controller = new AbortController();
    const pending = mcp!.execute({ mode: 'call', qualifiedName: 'mcp:fixture:slow' }, { signal: controller.signal });
    await Bun.sleep(200);
    const cancelledAt = Date.now();
    controller.abort();
    const result = await pending;
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('was cancelled');
  }, 20_000);
});
