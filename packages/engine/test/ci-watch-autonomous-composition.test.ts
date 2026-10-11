import { WorkspaceTrustManager } from '../sdk/src/platform/runtime/workspace-trust.ts';
/** Reconstructed against recovered source; all external responses are offline fixtures. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDecisionLog, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createShellPathService } from '../sdk/src/platform/runtime/shell-paths.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { composeCiWatchGatewayVerbs, type CiWatchCompositionDeps } from '../sdk/src/platform/control-plane/routes/ci-watch-composition.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { EXEC_TOOL_SCHEMA } from '../sdk/src/platform/tools/exec/schema.ts';
import { executeToolCalls } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolCallAbortRegistry } from '../sdk/src/platform/core/orchestrator-live-turn.ts';
import { currentExternalOperationSource, withExternalOperationSource } from '../sdk/src/platform/permissions/external-operation-scope.ts';
import type { ExternalPermissionHost } from '../sdk/src/platform/permissions/external-request.ts';
import { toolReadingsPort } from './_helpers/tool-readings.ts';
import { forgetGateReadings } from './_helpers/gate-readings.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); forgetGateReadings(); });
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ci-autonomous-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = process.env.PATH;
  writeFileSync(join(root, 'gh'), `#!/bin/sh\ncase "$*" in\n*check-runs*) echo '[{"id":71,"name":"build","status":"completed","conclusion":"failure","head_sha":"aabbcc","html_url":"https://github.com/fixture/project/actions/runs/51/job/61"}]';;\n*actions/jobs/61/logs*) echo 'synthetic build failure';;\n*) exit 1;;\nesac\n`);
  writeFileSync(join(root, 'git'), '#!/bin/sh\ncase "$*" in\n*remote*) echo https://github.com/fixture/project.git;;\n*) echo main;;\nesac\n');
  chmodSync(join(root, 'git'), 0o755); chmodSync(join(root, 'gh'), 0o755); process.env.PATH = `${root}:${path}`;
  cleanups.push(() => { process.env.PATH = path; });
  const config = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
  const workspaceTrust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
  const services = createClientRuntimeServices({ workspaceTrust, configManager: config, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    surfaceRoot: 'tui', workingDir: root, homeDirectory: root, modelDiscovery: 'skip', requestApproval: async () => ({ approved: false }) });
  cleanups.push(() => services.dispose());
  const lifetime = new AbortController(); cleanups.push(() => lifetime.abort());
  const readings = toolReadingsPort([]); const requests: JudgmentRequest<Questions>[] = [];
  let disposition = 'act'; let beforeCreate: (() => void) | undefined; let beforeDecision: (() => void | Promise<void>) | undefined;
  const port = withDecisionLog({ model: readings.port.model, async ask(request) {
    requests.push(request as JudgmentRequest<Questions>);
    if ('disposition' in request.questions) { await beforeDecision?.(); return fakePort((_name, question) => choiceAnswer(question, disposition, 0.99)).port.ask(request); }
    return readings.port.ask(request);
  } }, services.judgment.decisionLog);
  const spy = spyOn(services.judgment.port, 'ask').mockImplementation(port.ask); cleanups.push(() => spy.mockRestore());
  const host: ExternalPermissionHost = { port: services.judgment.port, permissionManager: services.permissionManager, config, signal: lifetime.signal };
  const catalog = new GatewayMethodCatalog(); let humanAsks = 0; let starts = 0; let created = 0;
  let observer: ((tool: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  let ownerCurrent = true; let goal = 'Repair CI for the authorized fixture/project branch.';
  const operation = { sourceOf: () => ({ goal, criteria: ['Only fix the existing project scope'] }), signal: lifetime.signal,
    assertCurrent() { lifetime.signal.throwIfAborted(); if (!ownerCurrent) throw new Error('Original operation ended'); } };
  const deps: CiWatchCompositionDeps = {
    shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui', configManager: config,
    ciAutonomousHost: () => host, workingDirectory: root, onCiAutoWatch: value => { observer = value; },
    requestApproval: async () => { humanAsks++; return { approved: false }; },
    automationManager: { createJob: async () => { created++; beforeCreate?.(); return { id: 'fixture-job' }; },
      runNow: async () => { starts++; return { id: 'fixture-run', status: 'running', sessionId: 'fixture-session' }; } } as unknown as CiWatchCompositionDeps['automationManager'],
  };
  composeCiWatchGatewayVerbs(catalog, deps);
  const invoke = (method: string, body: Record<string, unknown>) => catalog.invoke(method, { context: { admin: true }, body });
  return { invoke, requests, lifetime, config, operation, root, workspaceTrust,
    async push() {
      const registry = new ToolRegistry(); const calls = new ToolCallAbortRegistry();
      registry.register({ definition: { name: 'exec', description: 'Intercepted synthetic push', parameters: EXEC_TOOL_SCHEMA }, execute: async () => ({ success: true, output: 'synthetic push' }) });
      const result = await executeToolCalls({ permissionManager: services.permissionManager, toolRegistry: registry,
        autonomousSource: () => { operation.assertCurrent(); return operation.sourceOf(); }, turnSignal: lifetime.signal,
        toolCallSignals: calls, onToolExecuted: (tool, args, success) => observer?.(tool, args, success),
        hookDispatcher: null, runtimeBus: null, sessionId: 'ci-push-fixture',
        emitterContext: () => ({ sessionId: 'ci-push-fixture', traceId: 'synthetic', source: 'orchestrator' }) }, 'push-turn',
        [{ id: 'ci-push', name: 'exec', arguments: { commands: [{ cmd: 'git push origin main' }] } }]);
      expect(result[0]?.success).toBe(true); expect(calls.list()).toEqual([]); expect(currentExternalOperationSource()).toBeUndefined();
      for (let i = 0; i < 200; i++) {
        const response = await invoke('ci.watches.list', {}) as { watches: Array<{ id: string }> };
        if (response.watches.length) return response.watches[0]!.id; await Bun.sleep(5);
      }
      throw new Error('Self-minted watch did not appear');
    },
    endSource() { ownerCurrent = false; }, recompose() { composeCiWatchGatewayVerbs(catalog, deps); },
    create: (owned = true, triggerFixSession = false) => owned ? withExternalOperationSource(operation, () => invoke('ci.watches.create', { repo: 'fixture/project', ref: 'main', deliveryChannel: 'web', triggerFixSession })) : invoke('ci.watches.create', { repo: 'fixture/project', ref: 'main', deliveryChannel: 'web', triggerFixSession }),
    counts: () => ({ humanAsks, starts, created }), duringCreate(value: () => void) { beforeCreate = value; },
    reject() { disposition = 'reject'; }, hook(value: typeof beforeDecision) { beforeDecision = value; }, changeSource() { goal = 'A different scope'; },
  };
}
test('actual CI composition admits default red watch without human offer', async () => {
  const h = harness(); const { watch } = await h.create() as { watch: { id: string } };
  expect(await h.invoke('ci.watches.run', { watchId: watch.id })).toMatchObject({ fixSessionTriggered: true, fixSessionId: 'fixture-session' });
  expect(h.counts()).toEqual({ humanAsks: 0, starts: 1, created: 1 });
  expect(JSON.stringify(h.requests)).toContain('synthetic build failure');
  expect(JSON.stringify(h.requests)).toContain(h.operation.sourceOf().goal);
});
test.each([false, true])('missing owner refuses including opt-in %s', async trigger => {
  const h = harness(); const { watch } = await h.create(false, trigger) as { watch: { id: string } };
  expect(await h.invoke('ci.watches.run', { watchId: watch.id })).toMatchObject({ fixSessionTriggered: false, fixSessionError: 'CI repair has no current original-source admission owner' });
  expect(h.counts()).toEqual({ humanAsks: 0, starts: 0, created: 0 });
});
test('Jev refusal never falls back to a human offer', async () => {
  const h = harness(); h.reject(); const { watch } = await h.create() as { watch: { id: string } };
  expect(await h.invoke('ci.watches.run', { watchId: watch.id })).toMatchObject({ fixSessionError: 'Jev refused this CI repair' });
  expect(h.counts()).toEqual({ humanAsks: 0, starts: 0, created: 0 });
});
test.each(['source', 'cancel', 'delete', 'policy'] as const)('%s invalidation during Jev prevents work', async kind => {
  const h = harness(); const { watch } = await h.create() as { watch: { id: string } };
  h.hook(async () => {
    if (kind === 'source') h.changeSource(); if (kind === 'cancel') h.lifetime.abort();
    if (kind === 'delete') await h.invoke('ci.watches.delete', { watchId: watch.id });
    if (kind === 'policy') h.config.set('permissions.tools.agent', 'deny');
  });
  expect(await h.invoke('ci.watches.run', { watchId: watch.id })).toMatchObject({ fixSessionTriggered: false });
  expect(h.counts()).toEqual({ humanAsks: 0, starts: 0, created: 0 });
});
test('concurrent manual/poll work and repeated checks cannot duplicate repair', async () => {
  const h = harness(); const { watch } = await h.create() as { watch: { id: string } };
  await Promise.all(Array.from({ length: 8 }, () => h.invoke('ci.watches.run', { watchId: watch.id })));
  await h.invoke('ci.watches.run', { watchId: watch.id }); expect(h.counts()).toEqual({ humanAsks: 0, starts: 1, created: 1 });
});
test('restart cannot restore authority from saved watch', async () => {
  const h = harness(); const { watch } = await h.create() as { watch: { id: string } }; h.recompose();
  expect(await h.invoke('ci.watches.run', { watchId: watch.id })).toMatchObject({ fixSessionError: 'CI repair has no current original-source admission owner' });
  expect(h.counts()).toEqual({ humanAsks: 0, starts: 0, created: 0 });
});
test('changed exact CI head/run/jobs cannot claim old repair', async () => {
  const h = harness(); const { watch } = await h.create() as { watch: { id: string } };
  h.hook(() => { writeFileSync(join(h.root, 'gh'), `#!/bin/sh\necho '[{"name":"build","status":"completed","conclusion":"failure","head_sha":"different","html_url":"https://github.com/fixture/project/actions/runs/52/job/62"}]'\n`); });
  expect(await h.invoke('ci.watches.run', { watchId: watch.id })).toMatchObject({ fixSessionError: 'CI commit, run, or jobs changed during admission' });
  expect(h.counts().starts).toBe(0);
});
test('explicit policy denial survives an act-capable Jev', async () => {
  const h = harness(); h.config.set('permissions.mode', 'custom'); h.config.set('permissions.tools.agent', 'deny');
  const { watch } = await h.create(true, true) as { watch: { id: string } };
  await h.invoke('ci.watches.run', { watchId: watch.id }); expect(h.counts()).toEqual({ humanAsks: 0, starts: 0, created: 0 });
});
test('self-minted source remains usable after triggering tool scope closes', async () => {
  const h = harness(); const watchId = await h.push(); expect(h.counts().starts).toBe(0);
  await h.invoke('ci.watches.run', { watchId }); expect(h.counts()).toEqual({ humanAsks: 0, starts: 1, created: 1 });
});
test('completed native-style source owner cannot be revived from copied goal', async () => {
  const h = harness(); const watchId = await h.push(); h.endSource();
  expect(await h.invoke('ci.watches.run', { watchId })).toMatchObject({ fixSessionTriggered: false, fixSessionError: 'Original operation ended' }); expect(h.counts().starts).toBe(0);
});
test('policy change while creating disabled job prevents runNow', async () => {
  const h = harness(); const { watch } = await h.create() as { watch: { id: string } };
  h.duringCreate(() => h.config.set('permissions.tools.agent', 'deny'));
  await h.invoke('ci.watches.run', { watchId: watch.id }); expect(h.counts()).toEqual({ humanAsks: 0, starts: 0, created: 1 });
});
test('two watches of exact same failed jobs claim only one repair', async () => {
  const h = harness(); const first = await h.create() as { watch: { id: string } }; const second = await h.create() as { watch: { id: string } };
  await Promise.all([first, second].map(({ watch }) => h.invoke('ci.watches.run', { watchId: watch.id })));
  expect(h.counts()).toEqual({ humanAsks: 0, starts: 1, created: 1 });
});
