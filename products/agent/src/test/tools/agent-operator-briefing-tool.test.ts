import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  createAgentOperatorBriefingTool,
  registerAgentOperatorBriefingTool,
} from '../../tools/agent-operator-briefing-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-operator-briefing');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'operator-briefing-token' }));
  }
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

function configManager(paths: ShellPaths): ConfigManager {
  return new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function routeResponse(url: string): Response {
  if (url.endsWith('/api/work-ledger/project')) return Response.json({ projectId: 'native-project' });
  if (new URL(url, 'http://fixture').pathname === '/api/work-ledger/snapshot') return Response.json(nativeSnapshot());
  if (url.endsWith('/api/projects/planning/work-plan')) {
    return Response.json({
      ok: true,
      tasks: [],
      counts: { total: 2, pending: 1, in_progress: 1, blocked: 0, done: 0, failed: 0, cancelled: 0 },
    });
  }
  if (url.endsWith('/api/approvals')) {
    return Response.json({
      awaitingDecision: true,
      mode: 'default',
      approvals: [{ id: 'approval-1', status: 'pending' }],
    });
  }
  if (url.endsWith('/api/automation')) {
    return Response.json({
      totals: { jobs: 3, enabled: 2, paused: 1, runs: 4 },
      jobs: [],
      recentRuns: [],
    });
  }
  if (url.endsWith('/api/automation/schedules')) {
    return Response.json({
      jobs: [
        { id: 'sched-1', enabled: true },
        { id: 'sched-2', enabled: false },
      ],
      runs: [{ id: 'run-1' }],
    });
  }
  if (url.endsWith('/api/runtime/scheduler')) {
    return Response.json({
      slotsTotal: 4,
      slotsInUse: 1,
      queueDepth: 0,
      oldestQueuedAgeMs: null,
    });
  }
  return Response.json({ error: 'unexpected route' }, { status: 404 });
}

describe('agent_operator_briefing tool', () => {
  test('reads only public operator status routes', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorBriefingTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return routeResponse(inputUrl(input));
    });

    try {
      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent operator briefing');
      expect(result.output).toContain('historical legacy work plan: total 2');
      expect(result.output).toContain('native work: total 0; revision 0');
      expect(result.output).toContain('reportedState: pending 0; in_progress 0; blocked 0; complete 0; cancelled 0');
      expect(result.output).toContain('verification.state: unverified 0; verified 0; failed 0; unavailable 0; stale 0');
      expect(result.output).toContain('approvals: pending 1');
      expect(result.output).toContain('automation: jobs 3');
      expect(result.output).toContain('schedules: jobs 2');
      expect(result.output).toContain('scheduler: slots 1/4');
      const requestUrls = requests.map((request) => request.url);
      expect(requestUrls).toEqual([
        'http://127.0.0.1:3421/api/work-ledger/project',
        'http://127.0.0.1:3421/api/work-ledger/snapshot?projectId=native-project',
        'http://127.0.0.1:3421/api/projects/planning/work-plan',
        'http://127.0.0.1:3421/api/approvals',
        'http://127.0.0.1:3421/api/automation',
        'http://127.0.0.1:3421/api/automation/schedules',
        'http://127.0.0.1:3421/api/runtime/scheduler',
      ]);
      expect(requests.map((request) => request.method)).toEqual(Array(7).fill('GET'));
      expect(requests.every(request => request.authorization === 'Bearer operator-briefing-token')).toBe(true);
      expect(requestUrls.filter((url) => url.includes('/api/knowledge'))).toEqual([]);
      expect(requestUrls.filter((url) => url.includes('homeGraph'))).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed without auth token and does not call routes', async () => {
    const paths = shellPaths(false);
    const tool = createAgentOperatorBriefingTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return routeResponse('/api/approvals');
    });

    try {
      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('auth_required');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('degrades individual route failures instead of failing the whole briefing', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorBriefingTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.endsWith('/api/approvals')) return Response.json({ error: 'missing' }, { status: 404 });
      return routeResponse(url);
    });

    try {
      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain('approvals.list: unavailable (connected_host_route_unavailable');
      expect(result.output).not.toContain('approvals.list: unavailable (route_unavailable');
      expect(result.output).toContain('warnings: 1 route(s) unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is registered in the model tool registry', () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentOperatorBriefingTool(registry, paths, configManager(paths));

    expect(registry.has('agent_operator_briefing')).toBe(true);
  });
});


function nativeSnapshot(works: readonly unknown[] = [], revision = 0) {
  return { projectId: 'native-project', cursor: revision, revision, works };
}

function nativeWork(index: number, reportedState: string, verificationState: string) {
  return {
    work: { id: `work-${index}`, title: 'PRIVATE_SOURCE_TITLE', goal: 'PRIVATE_SOURCE_GOAL',
      criteria: ['PRIVATE_SOURCE_CRITERION'], source: null, revision: 1, criteriaRevision: 1,
      reportedState, currentAttemptId: null, createdAt: 1, updatedAt: 1 },
    attempt: null, verification: { state: verificationState, reason: 'PRIVATE_VERIFICATION_REASON', evidence: null }, attention: [],
  };
}

async function withFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch(async (input, init) => handler(inputUrl(input), init));
  try { await run(); } finally { globalThis.fetch = original; }
}

function expectNoNativeClaims(result: { output?: string; error?: string }) {
  const text = `${result.output ?? ''} ${result.error ?? ''}`;
  expect(text).not.toContain('native work: total');
  expect(text).not.toContain('reportedState:');
  expect(text).not.toContain('verification.state:');
  expect(text).not.toContain('PRIVATE_');
}

describe('native work operator briefing', () => {
  test('keeps reported completion separate from evidence and emits counts only', async () => {
    const paths = shellPaths(); const tool = createAgentOperatorBriefingTool(paths, configManager(paths));
    const states = ['pending', 'in_progress', 'blocked', 'complete', 'cancelled'];
    const verification = ['verified', 'failed', 'unavailable', 'unverified', 'stale'];
    await withFetch(url => new URL(url).pathname === '/api/work-ledger/snapshot'
      ? Response.json(nativeSnapshot(states.map((state, i) => nativeWork(i, state, verification[i]!)), 17)) : routeResponse(url), async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('native work: total 5; revision 17');
      expect(result.output).toContain('reportedState: pending 1; in_progress 1; blocked 1; complete 1; cancelled 1');
      expect(result.output).toContain('verification.state: unverified 1; verified 1; failed 1; unavailable 1; stale 1');
      expect(result.output).toContain('historical legacy work plan: total 2');
      expect(result.output).not.toContain('PRIVATE_');
    });
  });

  for (const discovery of [{}, { projectId: '' }, { projectId: 'x'.repeat(201) }, { projectId: 1 }]) {
    test(`rejects malformed project discovery ${JSON.stringify(discovery).slice(0, 70)} without snapshot reads`, async () => {
      const paths = shellPaths(); const calls: string[] = [];
      await withFetch(url => {
        calls.push(new URL(url).pathname);
        return new URL(url).pathname === '/api/work-ledger/project' ? Response.json(discovery) : routeResponse(url);
      }, async () => {
        const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({});
        expect(result.output).toContain('native work: unavailable'); expectNoNativeClaims(result);
        expect(calls).not.toContain('/api/work-ledger/snapshot');
      });
    });
  }

  const invalidSnapshots: readonly [string, () => unknown][] = [
    ['malformed', () => ({ ...nativeSnapshot(), works: [{}] })],
    ['project mismatch', () => ({ ...nativeSnapshot(), projectId: 'other-project' })],
    ['cursor mismatch', () => ({ ...nativeSnapshot(), revision: 2 })],
    ['unknown reported state', () => nativeSnapshot([nativeWork(0, 'done', 'verified')])],
    ['unknown verification state', () => nativeSnapshot([nativeWork(0, 'complete', 'passed')])],
    ['oversized valid snapshot', () => nativeSnapshot(Array.from({ length: 6000 }, (_, i) => nativeWork(i, 'pending', 'unverified')))],
  ];
  for (const [name, snapshot] of invalidSnapshots) test(`fails closed on ${name} without turning native failure into legacy work`, async () => {
    const paths = shellPaths(); const tool = createAgentOperatorBriefingTool(paths, configManager(paths));
    await withFetch(url => new URL(url).pathname === '/api/work-ledger/snapshot' ? Response.json(snapshot()) : routeResponse(url), async () => {
      const result = await tool.execute({});
      expect(result.output).toContain('native work: unavailable');
      expect(result.output).toContain('historical legacy work plan: total 2');
      expectNoNativeClaims(result);
    });
  });

  for (const route of ['project', 'snapshot']) for (const status of [401, 403, 404, 500]) {
    test(`native ${route} HTTP ${status} remains unavailable and does not expose raw errors`, async () => {
      const paths = shellPaths(); const tool = createAgentOperatorBriefingTool(paths, configManager(paths)); const calls: string[] = [];
      await withFetch(url => {
        calls.push(new URL(url).pathname);
        return new URL(url).pathname === `/api/work-ledger/${route}`
          ? Response.json({ error: 'PRIVATE_SERVER_ERROR operator-briefing-token' }, { status }) : routeResponse(url);
      }, async () => {
        const result = await tool.execute({});
        expect(result.output).toContain('native work: unavailable'); expectNoNativeClaims(result);
        expect(result.output).not.toContain('operator-briefing-token');
        if (route === 'project') expect(calls).not.toContain('/api/work-ledger/snapshot');
      });
    });
  }

  for (const boundary of ['project', 'snapshot', 'approvals']) for (const replacement of ['host', 'token']) {
    test(`discards native counts after ${replacement} replacement during ${boundary}`, async () => {
      const paths = shellPaths(); const config = configManager(paths); const tool = createAgentOperatorBriefingTool(paths, config);
      let replaced = false; let callsAfterReplacement = 0;
      await withFetch(url => {
        if (replaced) callsAfterReplacement++;
        if (new URL(url).pathname.endsWith(`/${boundary}`)) {
          replaced = true;
          if (replacement === 'host') config.set('controlPlane.port', 45678);
          else writeFileSync(join(paths.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'replacement-token' }));
        }
        return routeResponse(url);
      }, async () => {
        const result = await tool.execute({});
        expect(replaced).toBe(true); expectNoNativeClaims(result); expect(callsAfterReplacement).toBe(0);
      });
    });
  }

  test('an already cancelled invocation performs no requests', async () => {
    const paths = shellPaths(); const controller = new AbortController(); controller.abort(); let calls = 0;
    await withFetch(url => { calls++; return routeResponse(url); }, async () => {
      const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({}, { signal: controller.signal });
      expectNoNativeClaims(result); expect(calls).toBe(0);
    });
  });

  test('cancellation fences an abort-ignoring late snapshot and disposes its request', async () => {
    const paths = shellPaths(); const controller = new AbortController(); let signal: AbortSignal | null | undefined;
    let release!: (response: Response) => void; let entered!: () => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    await withFetch((url, init) => {
      if (new URL(url).pathname === '/api/work-ledger/snapshot') { signal = init?.signal; entered(); return pending; }
      return routeResponse(url);
    }, async () => {
      const running = createAgentOperatorBriefingTool(paths, configManager(paths)).execute({}, { signal: controller.signal });
      await started; controller.abort();
      const result = await running; expectNoNativeClaims(result); expect(signal?.aborted).toBe(true);
      release(Response.json(nativeSnapshot([nativeWork(0, 'complete', 'verified')], 1)));
      await Bun.sleep(10); expectNoNativeClaims(result);
    });
  });

  test('bounds stalled native reads at five seconds and ignores their late response', async () => {
    const paths = shellPaths(); let release!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    await withFetch((url, init) => {
      if (new URL(url).pathname === '/api/work-ledger/snapshot') { signal = init?.signal; return pending; }
      return routeResponse(url);
    }, async () => {
      const start = Date.now(); const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({});
      expect(Date.now() - start).toBeLessThan(6500); expect(signal?.aborted).toBe(true);
      expect(result.success).toBe(false); expect(result.error).toContain('briefing_unavailable'); expectNoNativeClaims(result);
      release(Response.json(nativeSnapshot([nativeWork(0, 'complete', 'verified')], 1)));
      await Bun.sleep(10); expectNoNativeClaims(result);
    });
  }, 8000);
});


describe('operator briefing approval metadata', () => {
  for (const mode of ['allow-all', 'background-restricted', 'custom', 'default', 'plan']) {
    test(`preserves contract approval mode ${mode} without reflecting arbitrary strings`, async () => {
      const paths = shellPaths();
      await withFetch(url => new URL(url).pathname === '/api/approvals'
        ? Response.json({ approvals: [], mode, awaitingDecision: 'PRIVATE-DECISION' }) : routeResponse(url), async () => {
        const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({});
        expect(result.output).toContain(`mode ${mode}; awaiting decision false`);
        expect(result.output).not.toContain('PRIVATE-DECISION');
      });
    });
  }
  test('does not reflect unknown approval mode or raw error text', async () => {
    const paths = shellPaths();
    await withFetch(url => new URL(url).pathname === '/api/approvals'
      ? Response.json({ approvals: [], mode: 'PRIVATE-MODE' }) : routeResponse(url), async () => {
      const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({});
      expect(result.output).toContain('mode unknown'); expect(result.output).not.toContain('PRIVATE-MODE');
    });
    await withFetch(url => new URL(url).pathname === '/api/approvals'
      ? Response.json({ error: 'PRIVATE-ERROR' }, { status: 500 }) : routeResponse(url), async () => {
      const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({});
      expect(result.output).toContain('HTTP 500'); expect(result.output).not.toContain('PRIVATE-ERROR');
    });
  });
});


for (const deniedRoute of ['/api/work-ledger/project', '/api/work-ledger/snapshot']) {
  test(`native 401 at ${deniedRoute} performs no refresh or retry`, async () => {
    const paths = shellPaths(); const calls: string[] = [];
    await withFetch(url => {
      const path = new URL(url).pathname; calls.push(path);
      return path === deniedRoute ? Response.json({ error: 'PRIVATE-AUTH' }, { status: 401 }) : routeResponse(url);
    }, async () => {
      const result = await createAgentOperatorBriefingTool(paths, configManager(paths)).execute({});
      expect(result.output).toContain('native work: unavailable');
      expect(calls.filter(path => path === deniedRoute)).toHaveLength(1);
      expect(calls.some(path => path.includes('refresh') || path.includes('/auth'))).toBe(false);
      expect(result.output).not.toContain('PRIVATE-AUTH');
    });
  });
}
