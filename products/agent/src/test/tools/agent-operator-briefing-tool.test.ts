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
      });
      return routeResponse(inputUrl(input));
    });

    try {
      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent operator briefing');
      expect(result.output).toContain('work plan: total 2');
      expect(result.output).toContain('approvals: pending 1');
      expect(result.output).toContain('automation: jobs 3');
      expect(result.output).toContain('schedules: jobs 2');
      expect(result.output).toContain('scheduler: slots 1/4');
      const requestUrls = requests.map((request) => request.url);
      expect(requestUrls).toEqual([
        'http://127.0.0.1:3421/api/projects/planning/work-plan',
        'http://127.0.0.1:3421/api/approvals',
        'http://127.0.0.1:3421/api/automation',
        'http://127.0.0.1:3421/api/automation/schedules',
        'http://127.0.0.1:3421/api/runtime/scheduler',
      ]);
      expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
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
