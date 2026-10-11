import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';

// Product-owned semantic fixture; real public admission/registry/PTY APIs carry
// authority. No private source setter, permit constructor or engine test import.
test('actual agent graph public terminal control preserves Jev ownership and lifetime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-owned-terminal-'));
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  configManager.set('sandbox.enabled', false); // Explicit temporary fixture, no product containment policy change.
  seedProviderMetadataCacheFixture({ configManager, workingDirectory: root, homeDirectory: root, surfaceRoot: 'agent' });
  const services = createRuntimeServices({ configManager, workingDir: root, homeDirectory: root, modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  let sawSandbox = false; let sawLocalhost = false; let localRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { localRequests++; return new Response('owned-local-preview'); } });
  let humanAsks = 0; let phase: 'allow' | 'aba' | 'dispose' = 'allow'; let intercepted = false;
  services.permissionPromptRef.requestPermission = async () => { humanAsks++; return { approved: false }; };
  const answers = fakePort((name, question, state) => {
    if (name === 'disposition') return choiceAnswer(question, question.type === 'choice' && 'revise_0' in question.criteria && !('act' in question.criteria) ? 'revise_0' : 'act', 0.98);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.98);
    if (name === 'kind') return choiceAnswer(question, 'other', 0.98);
    if (name === 'category') return choiceAnswer(question, 'lasting', 0.98);
    if (name === 'hazard') return choiceAnswer(question, 'none', 0.98);
    if (name === 'needsNetwork') return noulAnswer(JSON.stringify(state).includes('owned-sandbox-control') ? 0.98 : 0.02);
    if (name === 'awaiting_input' || name === 'mutates' || name === 'owned_targets') return noulAnswer(0.98);
    if (name === 'credential') return noulAnswer(/key|token|secret|password|credential/i.test(String((state as { name?: string }).name)) ? 0.98 : 0.02);
    if (question.type === 'noul') return noulAnswer(0.02);
    throw new Error(`Unscripted product terminal question: ${name}`);
  });
  const recorded = withDecisionLog(answers.port, services.judgment.decisionLog);
  const spy = spyOn(services.judgment.port, 'ask').mockImplementation(async request => {
    if ('disposition' in request.questions && JSON.stringify(request.state).includes('sandboxEscalation')) sawSandbox = true;
    if ('disposition' in request.questions && JSON.stringify(request.state).includes('localhostAdmission')) sawLocalhost = true;
    const answer = await recorded.ask(request);
    if (!intercepted && phase !== 'allow' && 'disposition' in request.questions && JSON.stringify(request.state).includes('terminalControl')) {
      intercepted = true;
      if (phase === 'dispose') services.dispose();
    }
    return answer;
  });
  const { toolRegistry: registry } = composeAgentToolRegistry({ services, configManager, homeDirectory: root,
    resolveSessionId: () => 'owned-terminal', getLastUserMessage: () => 'Confirm only the owned local fixture' });
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Confirm only the owned local fixture', criteria: ['No external calls', 'No human wait'] }),
    permissionManager: services.permissionManager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
    sessionId: 'owned-terminal', emitterContext: () => ({ sessionId: 'owned-terminal', traceId: 'fixture', source: 'orchestrator' }) };
  const run = (id: string) => executeToolCalls(deps, id, [{ id, name: 'exec', arguments: { commands: [{
    cmd: 'printf "Continue? [y/n]: " > /dev/tty; read ans < /dev/tty; if [ "$ans" = "y" ]; then echo owned-terminal-receipt; else exit 1; fi', interactive: true, timeout_ms: 5000,
  }] } }]);
  try {
    const allowed = await run('owned-positive');
    expect(allowed[0]!.success, allowed[0]!.error ?? allowed[0]!.output).toBe(true);
    expect(allowed[0]!.output).toContain('owned-terminal-receipt');
    const fetched = await executeToolCalls(deps, 'owned-fetch', [{ id: 'owned-fetch-call', name: 'fetch', arguments: { urls: [{ url: `http://127.0.0.1:${server.port}/owned-preview` }] } }]);
    expect(fetched[0]!.success, fetched[0]!.error ?? fetched[0]!.output).toBe(true);
    expect(fetched[0]!.output).toContain('owned-local-preview'); expect(sawLocalhost).toBe(true); expect(localRequests).toBe(1);
    configManager.set('sandbox.enabled', true);
    configManager.flushConfigFileChanges();
    // The injected OS adapter accepts availability probes and refuses all
    // commands. The actual product still owns the sandbox plan and admission.
    const sandboxBin = join(root, 'sandbox-host');
    mkdirSync(sandboxBin);
    writeFileSync(join(sandboxBin, 'bwrap'), '#!/bin/sh\nfor arg do last="$arg"; done\nif [ "$last" = /bin/true ]; then exit 0; fi\nprintf "owned-sandbox-adapter-refused\\n" >&2\nexit 73\n', { mode: 0o700 });
    const previousPath = process.env.PATH;
    // Bun's default child-process environment retains its initial PATH. Give
    // only the native resolution call this fixture's current environment; the
    // real host probes and command subprocesses still run without interception.
    const hostSpawnSync = childProcess.spawnSync;
    const hostResolution = spyOn(childProcess, 'spawnSync').mockImplementation(new Proxy(hostSpawnSync, {
      apply(target, receiver, args: unknown[]) {
        if (args[0] === 'sh' && Array.isArray(args[1]) && args[1].length === 2
          && args[1][0] === '-c' && args[1][1] === 'command -v bwrap'
          && args[2] !== null && typeof args[2] === 'object') {
          return Reflect.apply(target, receiver, [args[0], args[1], { ...args[2], env: { ...process.env } }]);
        }
        return Reflect.apply(target, receiver, args);
      },
    }));
    try {
      process.env.PATH = `${sandboxBin}:${previousPath ?? ''}`;
      const { toolRegistry: sandboxRegistry } = composeAgentToolRegistry({ services, configManager, homeDirectory: root,
        resolveSessionId: () => 'owned-terminal', getLastUserMessage: () => 'Confirm only the owned local fixture' });
      const sandboxed = await executeToolCalls({ ...deps, toolRegistry: sandboxRegistry }, 'owned-sandbox', [{ id: 'owned-sandbox-call', name: 'exec', arguments: { commands: [{ cmd: 'printf owned-sandbox-control', timeout_ms: 1000 }] } }]);
      expect(sawSandbox).toBe(true);
      expect(JSON.parse(sandboxed[0]!.output ?? '{}')).toMatchObject({ sandboxed: true, exit_code: 73, stdout: '' });
      expect(sandboxed[0]!.output).toContain('owned-sandbox-adapter-refused');
    } finally {
      hostResolution.mockRestore();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    configManager.set('sandbox.enabled', false);
    configManager.flushConfigFileChanges();
    phase = 'dispose'; intercepted = false;
    const disposed = await run('owned-disposal');
    expect(intercepted).toBe(true); expect(disposed[0]!.success).toBe(false);
    expect(JSON.parse(disposed[0]!.output ?? '{}').stdout ?? '').not.toContain('owned-terminal-receipt');
    expect(humanAsks).toBe(0);
  } finally { server.stop(true); spy.mockRestore(); services.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
