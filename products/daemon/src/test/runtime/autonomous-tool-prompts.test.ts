/** Real daemon child registry producer, public core admission, synthetic readings only. */
import { afterAll, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
function installNativeSandboxHost() {
  const sandboxBin = makeOwnedTempDir('daemon-sandbox-host');
  const bwrap = join(sandboxBin, 'bwrap');
  const dispatchArgs = join(sandboxBin, 'dispatch-argv');
  // Real native availability probes succeed; every final command is refused.
  // This adapter never evaluates the supplied shell command or claims OS isolation.
  writeFileSync(bwrap, '#!/bin/sh\nfor arg do last="$arg"; done\nif [ "$last" = /bin/true ]; then exit 0; fi\nprintf "%s\\n" "$@" >> "${0%/*}/dispatch-argv"\nprintf "owned-sandbox-adapter-refused\\n" >&2\nexit 73\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  const hostProbes: unknown[] = [];
  const hostSpawnSync = childProcess.spawnSync;
  // Bun retains the initial PATH for child_process. Only native resolution
  // receives the fixture PATH; probes and final execution remain real processes.
  const hostResolution = spyOn(childProcess, 'spawnSync').mockImplementation(new Proxy(hostSpawnSync, {
    apply(target, receiver, args: unknown[]) {
      if (args[0] === 'sh' && Array.isArray(args[1]) && args[1].length === 2
        && args[1][0] === '-c' && args[1][1] === 'command -v bwrap'
        && args[2] !== null && typeof args[2] === 'object') {
        const result = Reflect.apply(target, receiver, [args[0], args[1], { ...args[2], env: { ...process.env } }]);
        hostProbes.push({ resolution: true, status: result.status, ownedAdapter: result.stdout.trim() === bwrap });
        return result;
      }
      const result = Reflect.apply(target, receiver, args);
      if (args[0] === bwrap) hostProbes.push({ resolution: false, status: result.status });
      return result;
    },
  }));
  process.env.PATH = `${sandboxBin}:${previousPath ?? ''}`;
  return { bwrap, dispatchArgs, hostProbes, restore() {
    hostResolution.mockRestore();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  } };
}
let sandboxHost: ReturnType<typeof installNativeSandboxHost> | undefined;
const fixture = useGatewayFixture({ hostSessions: false, configure(config) {
  config.set('sandbox.enabled', true);
  // The server composes its registry during startup, so capture this host first.
  sandboxHost = installNativeSandboxHost();
} });
afterAll(() => sandboxHost?.restore());


test('daemon child registry preserves sandbox containment and cancels before dispatch', async () => {
  const daemon = fixture(); const services = daemon.services;
  if (!sandboxHost) throw new Error('Native sandbox fixture did not start');
  const { bwrap, dispatchArgs, hostProbes } = sandboxHost;
  let sandboxAdmissions = 0;
  const sandboxRequests: unknown[] = [];
  let cancelAtSandbox: AbortController | undefined;
  const answers = fakePort((name, question, state) => {
    if (name === 'disposition') return choiceAnswer(question, 'act', 0.98);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.98);
    if (name === 'kind') return choiceAnswer(question, 'other', 0.98);
    if (name === 'category') return choiceAnswer(question, 'lasting', 0.98);
    if (name === 'hazard') return choiceAnswer(question, 'none', 0.98);
    if (name === 'needsNetwork') return noulAnswer(JSON.stringify(state).includes('owned-daemon-sandbox') ? 0.98 : 0.02);
    if (name === 'mutates' || name === 'owned_targets') return noulAnswer(0.98);
    if (name === 'credential') return noulAnswer(/key|token|secret|password|credential/i.test(String((state as { name?: string }).name)) ? 0.98 : 0.02);
    if (question.type === 'noul') return noulAnswer(0.02);
    throw new Error(`Unscripted daemon sandbox question: ${name}`);
  });
  const recorded = withDecisionLog(answers.port, services.judgment.decisionLog);
  const port = spyOn(services.judgment.port, 'ask').mockImplementation(async request => {
    const state: unknown = request.state;
    const input = state !== null && typeof state === 'object' && 'input' in state ? state.input : null;
    const args = input !== null && typeof input === 'object' && 'arguments' in input ? input.arguments : null;
    const sandbox = 'disposition' in request.questions && args !== null && typeof args === 'object' && 'sandboxEscalation' in args;
    if (sandbox) { sandboxAdmissions++; sandboxRequests.push(args.sandboxEscalation); }
    const answer = await recorded.ask(request);
    if (sandbox) cancelAtSandbox?.abort();
    return answer;
  });
  let admission: ReturnType<typeof spyOn<typeof services.permissionManager, 'admitAutonomous'>> | undefined;
  const human = spyOn(services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('Human fallback forbidden'); });
  try {
    expect(services.configManager.getCategory('sandbox').enabled).toBe(true);
    expect(services.featureFlags.isEnabled('exec-sandbox')).toBe(true);
    const registry = services.agentOrchestrator.getToolRegistry();
    expect(hostProbes).toEqual([{ resolution: true, status: 0, ownedAdapter: true },
      { resolution: false, status: 0 }, { resolution: false, status: 0 }]);
    const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Run only the owned daemon sandbox fixture', criteria: ['Keep the exact existing containment plan', 'No external operation or human wait'] }),
      permissionManager: services.permissionManager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
      sessionId: 'daemon-sandbox-fixture', emitterContext: () => ({ sessionId: 'daemon-sandbox-fixture', traceId: 'fixture', source: 'orchestrator' }),
    };
    const command = 'printf owned-daemon-sandbox';
    const call = { id: 'daemon-sandbox-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } };
    const result = await executeToolCalls(deps, 'daemon-sandbox', [call]);
    expect(sandboxAdmissions).toBe(0); expect(human).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.success).toBe(false);
    const output: unknown = JSON.parse(result[0]?.output ?? '{}');
    expect(output).toMatchObject({ cmd: command, sandboxed: true, sandbox_network: 'disabled', exit_code: 73,
      success: false, stdout: '', stderr: 'owned-sandbox-adapter-refused' });
    expect(sandboxRequests).toEqual([]);
    const dispatched = readFileSync(dispatchArgs, 'utf8');
    const argv = dispatched.trimEnd().split('\n');
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--unshare-pid');
    expect(argv).toContain('--new-session');
    expect(argv.slice(-4)).toEqual(['--', '/bin/sh', '-c', command]);
    expect(dispatched).toContain(`--bind\n${daemon.workingDirectory}\n${daemon.workingDirectory}\n`);
    expect(dispatched).toContain('--tmpfs\n/run\n');
    expect(dispatched).not.toContain('--ro-bind\n/\n/\n');

    // Revoke the turn after its real admission, before that admission can be
    // claimed. The native adapter must receive no second call.
    cancelAtSandbox = new AbortController();
    const admit = services.permissionManager.admitAutonomous.bind(services.permissionManager);
    admission = spyOn(services.permissionManager, 'admitAutonomous').mockImplementation(async (...args) => {
      const result = await admit(...args); cancelAtSandbox?.abort(); return result;
    });
    const cancelled = executeToolCalls({ ...deps, turnSignal: cancelAtSandbox.signal }, 'daemon-sandbox-cancelled',
      [{ ...call, id: 'daemon-sandbox-cancelled-call' }]);
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError', message: 'The operation was aborted.' });
    expect(cancelAtSandbox.signal.aborted).toBe(true);
    expect(sandboxAdmissions).toBe(0);
    expect(sandboxRequests).toEqual([]);
    expect(readFileSync(dispatchArgs, 'utf8')).toBe(dispatched);
    expect(human).not.toHaveBeenCalled();
  } finally {
    admission?.mockRestore(); port.mockRestore(); human.mockRestore();
  }
});
