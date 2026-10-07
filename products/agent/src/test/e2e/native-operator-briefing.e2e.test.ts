import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { registerAgentOperatorBriefingTool } from '../../tools/agent-operator-briefing-tool.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { makeHome, removeHome, startStubModel } from './harness.ts';
import { startE2ENativeHost } from './native-host-fixture.ts';

/** Actual public Agent tool, SDK, authenticated routes and daemon-owned ledger.
 * Only model/Jev providers are synthetic, and this read must not invoke them. */
test('registered operator briefing reads native daemon work without mutation or provider calls and honors revocation', async () => {
  const model = startStubModel(() => ({ text: 'unused' }));
  const home = await makeHome(model);
  let host: Awaited<ReturnType<typeof startE2ENativeHost>> | undefined;
  const originalFetch = globalThis.fetch;
  try {
    host = await startE2ENativeHost(home);
    const paths = createShellPathService({ workingDirectory: home.workspace, homeDirectory: home.root });
    const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: paths.workingDirectory, homeDir: paths.homeDirectory });
    config.set('controlPlane.host', '127.0.0.1'); config.set('controlPlane.port', Number(new URL(host.daemon.baseUrl).port));
    mkdirSync(join(paths.homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(paths.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: host.env.GOODVIBES_CONNECTED_HOST_TOKEN }));
    const registry = new ToolRegistry(); registerAgentOperatorBriefingTool(registry, paths, config);
    expect(registry.has('agent_operator_briefing')).toBe(true);
    const requests: { path: string; method: string }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === host!.daemon.baseUrl) requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
      return originalFetch(input, init);
    });
    const beforeJudgments = home.judgments.accepted.length;
    const first = await registry.execute('native-briefing-smoke', 'agent_operator_briefing', {});
    expect(first.success).toBe(true);
    expect(first.output).toContain('native work: total 0; revision 0');
    expect(first.output).toContain('reportedState: pending 0; in_progress 0; blocked 0; complete 0; cancelled 0');
    expect(first.output).toContain('verification.state: unverified 0; verified 0; failed 0; unavailable 0; stale 0');
    expect(first.output).toContain('historical legacy work plan:');
    expect(requests.map(request => request.path)).toEqual([
      '/api/work-ledger/project', '/api/work-ledger/snapshot', '/api/projects/planning/work-plan',
      '/api/approvals', '/api/automation', '/api/automation/schedules', '/api/runtime/scheduler',
    ]);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(home.judgments.accepted.length).toBe(beforeJudgments); expect(model.requests).toHaveLength(0);
    // Explicit fixture setup, outside the tool: submit genuine durable native
    // work, then verify the next public briefing only reads the resulting state.
    const seeded = await originalFetch(`${host.daemon.baseUrl}/api/work-ledger/submissions`, {
      method: 'POST', headers: { Authorization: `Bearer ${host.env.GOODVIBES_CONNECTED_HOST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'briefing-fixture-request', inputId: 'briefing-fixture-input', expectedRevision: 0,
        goal: 'PRIVATE_NATIVE_SOURCE_TEXT', criteria: ['PRIVATE_NATIVE_CRITERION'] }),
    });
    expect(seeded.status).toBe(200);
    requests.length = 0;
    const populated = await registry.execute('native-briefing-populated-smoke', 'agent_operator_briefing', {});
    expect(populated.success).toBe(true);
    expect(populated.output).toContain('native work: total 1; revision 1');
    expect(populated.output).toContain('reportedState: pending 0; in_progress 1; blocked 0; complete 0; cancelled 0');
    expect(populated.output).toContain('verification.state: unverified 1; verified 0; failed 0; unavailable 0; stale 0');
    expect(populated.output).not.toContain('PRIVATE_NATIVE_');
    expect(requests).toHaveLength(7); expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(home.judgments.accepted.length).toBe(beforeJudgments); expect(model.requests).toHaveLength(0);
    const principal = host.daemon.services.pairingTokens.authenticateNative(host.env.GOODVIBES_CONNECTED_HOST_TOKEN)!;
    expect(host.daemon.services.pairingTokens.revoke(principal.tokenId)).toBe(true);
    requests.length = 0;
    const revoked = await registry.execute('native-briefing-smoke', 'agent_operator_briefing', {});
    expect(revoked.output).toContain('native work: unavailable');
    expect(revoked.output).not.toContain('native work: total');
    expect(requests.some(request => request.path === '/api/work-ledger/snapshot')).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    try { await host?.stop(); } finally { model.stop(); removeHome(home); }
  }
}, 30000);
