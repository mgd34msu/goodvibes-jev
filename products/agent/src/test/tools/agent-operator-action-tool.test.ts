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
  createAgentOperatorActionTool,
  registerAgentOperatorActionTool,
} from '../../tools/agent-operator-action-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

interface OperatorActionCase {
  readonly action: string;
  readonly targetField: string;
  readonly targetId: string;
  readonly path: string;
  readonly method?: string;
  readonly response: unknown;
}

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-operator-action');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'operator-action-token' }));
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

function successResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const ACTION_CASES: readonly OperatorActionCase[] = [
  {
    action: 'approvals.approve',
    targetField: 'approvalId',
    targetId: 'approval-1',
    path: '/api/approvals/approval-1/approve',
    response: { approval: { id: 'approval-1', status: 'approved' } },
  },
  {
    action: 'approvals.deny',
    targetField: 'approvalId',
    targetId: 'approval-2',
    path: '/api/approvals/approval-2/deny',
    response: { approval: { id: 'approval-2', status: 'denied' } },
  },
  {
    action: 'approvals.cancel',
    targetField: 'approvalId',
    targetId: 'approval-3',
    path: '/api/approvals/approval-3/cancel',
    response: { approval: { id: 'approval-3', status: 'cancelled' } },
  },
  {
    action: 'automation.jobs.run',
    targetField: 'jobId',
    targetId: 'job-1',
    path: '/api/automation/jobs/job-1/run',
    response: { run: { id: 'run-1', status: 'queued' } },
  },
  {
    action: 'automation.jobs.disable',
    targetField: 'jobId',
    targetId: 'job-2',
    path: '/api/automation/jobs/job-2/disable',
    response: { id: 'job-2', enabled: false },
  },
  {
    action: 'automation.jobs.enable',
    targetField: 'jobId',
    targetId: 'job-3',
    path: '/api/automation/jobs/job-3/enable',
    response: { id: 'job-3', enabled: true },
  },
  {
    action: 'automation.runs.cancel',
    targetField: 'runId',
    targetId: 'run-2',
    path: '/api/automation/runs/run-2/cancel',
    response: { run: { id: 'run-2', status: 'cancelled' } },
  },
  {
    action: 'automation.runs.retry',
    targetField: 'runId',
    targetId: 'run-3',
    path: '/api/automation/runs/run-3/retry',
    response: { run: { id: 'run-4', status: 'queued' } },
  },
  {
    action: 'automation.schedules.run',
    targetField: 'scheduleId',
    targetId: 'schedule-1',
    path: '/api/automation/schedules/schedule-1/run',
    response: { jobId: 'job-4', runId: 'run-5', status: 'queued' },
  },
  {
    action: 'automation.schedules.enable',
    targetField: 'scheduleId',
    targetId: 'schedule-2',
    path: '/api/automation/schedules/schedule-2/enable',
    response: { id: 'schedule-2', enabled: true },
  },
  {
    action: 'automation.schedules.disable',
    targetField: 'scheduleId',
    targetId: 'schedule-3',
    path: '/api/automation/schedules/schedule-3/disable',
    response: { id: 'schedule-3', enabled: false },
  },
  {
    action: 'automation.schedules.delete',
    targetField: 'scheduleId',
    targetId: 'schedule-4',
    path: '/api/automation/schedules/schedule-4',
    method: 'DELETE',
    response: { id: 'schedule-4', removed: true },
  },
];

describe('agent_operator_action tool', () => {
  test('previews without calling the connected host when confirmation is missing', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorActionTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return successResponse({});
    });

    try {
      const result = await tool.execute({
        action: 'approvals.approve',
        approvalId: 'approval-1',
        confirm: false,
        explicitUserRequest: 'Approve approval-1.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent operator action preview');
      expect(result.error).toContain('confirmation required');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects unknown actions without calling the connected host', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorActionTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return successResponse({});
    });

    try {
      const result = await tool.execute({
        action: 'automation.jobs.delete',
        targetId: 'job-1',
        confirm: true,
        explicitUserRequest: 'Delete job-1.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('action must be one of');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed without auth token and does not call routes', async () => {
    const paths = shellPaths(false);
    const tool = createAgentOperatorActionTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return successResponse({});
    });

    try {
      const result = await tool.execute({
        action: 'automation.jobs.run',
        jobId: 'job-1',
        confirm: true,
        explicitUserRequest: 'Run job-1 now.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('auth_required');
      expect(result.error).toContain('no connected-host operator token found');
      expect(result.error).not.toContain('runtime operator token');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports connected-host route failures without legacy daemon kinds', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorActionTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({ error: 'missing route' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));

    try {
      const result = await tool.execute({
        action: 'automation.jobs.run',
        jobId: 'job-1',
        confirm: true,
        explicitUserRequest: 'Run job-1 now.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent operator action failed: connected_host_route_unavailable');
      expect(result.error).not.toContain('daemon_');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses only allowlisted exact public routes after explicit confirmation', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorActionTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const match = ACTION_CASES.find((entry) => url.endsWith(entry.path));
      return match ? successResponse(match.response) : successResponse({ error: 'unexpected route' });
    });

    try {
      for (const entry of ACTION_CASES) {
        const result = await tool.execute({
          action: entry.action,
          [entry.targetField]: entry.targetId,
          confirm: true,
          explicitUserRequest: `Run ${entry.action} for ${entry.targetId}.`,
        });
        expect(result.success).toBe(true);
        expect(result.output).toContain(`method: ${entry.action}`);
      }

      expect(requests.map((request) => request.url)).toEqual(
        ACTION_CASES.map((entry) => `http://127.0.0.1:3421${entry.path}`),
      );
      expect(requests.map((request) => request.method)).toEqual(ACTION_CASES.map((entry) => entry.method ?? 'POST'));
      expect(requests.map((request) => request.url.includes('/api/knowledge'))).toEqual(ACTION_CASES.map(() => false));
      expect(requests.map((request) => request.url.includes('homeGraph'))).toEqual(ACTION_CASES.map(() => false));
      expect(requests.map((request) => request.url.includes('/api/automation/jobs/job-1/delete'))).toEqual(
        ACTION_CASES.map(() => false),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends approval notes and remember flags only for approval actions', async () => {
    const paths = shellPaths();
    const tool = createAgentOperatorActionTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return successResponse({ approval: { id: 'approval-1', status: 'approved' } });
    });

    try {
      const result = await tool.execute({
        action: 'approvals.approve',
        approvalId: 'approval-1',
        note: 'Approved by user request.',
        remember: true,
        confirm: true,
        explicitUserRequest: 'Approve approval-1 and remember it.',
      });

      expect(result.success).toBe(true);
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0]?.body ?? '{}') as unknown).toEqual({
        note: 'Approved by user request.',
        remember: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is registered in the model tool registry', () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentOperatorActionTool(registry, paths, configManager(paths));

    expect(registry.has('agent_operator_action')).toBe(true);
  });
});
