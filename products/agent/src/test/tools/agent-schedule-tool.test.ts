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
  createAgentScheduleTool,
  registerAgentScheduleTool,
} from '../../tools/agent-schedule-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

function shellPaths(): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-schedule-tool');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'schedule-tool-token' }));
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

function scheduleRecordResponse(): Response {
  return new Response(JSON.stringify({
    id: 'sched-1',
    name: 'Daily queue review',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
    execution: { prompt: 'review queue', target: { kind: 'main' } },
    delivery: {
      mode: 'none',
      targets: [],
      fallbackTargets: [],
      includeSummary: true,
      includeTranscript: false,
      includeLinks: true,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 3600000,
      retryPolicy: { maxAttempts: 2, delayMs: 60000, strategy: 'exponential' },
    },
    source: { id: 'source-sched-1', kind: 'schedule', label: 'schedule', enabled: true, createdAt: 1, updatedAt: 1, metadata: {} },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    deleteAfterRun: false,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function schedulesListResponse(): Response {
  return new Response(JSON.stringify({
    jobs: [
      {
        id: 'sched-1',
        name: 'Daily queue review',
        labels: [],
        createdAt: 1,
        updatedAt: 2,
        status: 'enabled',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 8 * * *', timezone: 'America/Chicago' },
        execution: { prompt: 'current prompt', target: { kind: 'main' } },
        delivery: {
          mode: 'none',
          targets: [],
          fallbackTargets: [],
          includeSummary: true,
          includeTranscript: false,
          includeLinks: true,
        },
        failure: {
          action: 'retry',
          maxConsecutiveFailures: 3,
          cooldownMs: 3600000,
          retryPolicy: { maxAttempts: 2, delayMs: 60000, strategy: 'exponential' },
        },
        source: { id: 'source-sched-1', kind: 'schedule', label: 'schedule', enabled: true, createdAt: 1, updatedAt: 2, metadata: {} },
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        deleteAfterRun: false,
      },
    ],
    runs: [],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('schedule adapter tool', () => {
  test('lists schedules through the read-only automation.schedules.list operator method', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return schedulesListResponse();
    });

    try {
      const result = await tool.execute({ action: 'list' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('"methodId": "automation.schedules.list"');
      expect(result.output).toContain('"sched-1"');
      expect(requests).toEqual([{ url: 'http://127.0.0.1:3421/api/automation/schedules', method: 'GET', body: '' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('previews autonomous schedule creation without calling the connected host', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleRecordResponse();
    });

    try {
      const result = await tool.execute({
        action: 'create',
        task: 'Review the ops queue',
        successCriteria: 'Report blockers and the next action.',
        every: '1d',
        confirm: false,
        explicitUserRequest: 'Review the ops queue every day.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('GoodVibes schedule preview for autonomous Agent work');
      expect(result.error).toContain('confirmation required');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('creates reminders through existing reminder schedule safety gates', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return scheduleRecordResponse();
    });

    try {
      const result = await tool.execute({
        action: 'remind',
        message: 'Review open approvals',
        every: '1d',
        confirm: true,
        explicitUserRequest: 'Remind me every day to review open approvals.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Created GoodVibes schedule for Agent reminder');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/automation/schedules');
      expect(requests[0]?.method).toBe('POST');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as { readonly prompt?: string; readonly every?: string };
      expect(payload.every).toBe('1d');
      expect(payload.prompt).toContain('GoodVibes Agent scheduled reminder');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('previews schedule edits with the existing read-only current-state diff', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return schedulesListResponse();
    });

    try {
      const result = await tool.execute({
        action: 'edit',
        scheduleId: 'sched-1',
        cron: '0 9 * * *',
        timezone: 'America/Chicago',
        confirm: false,
        explicitUserRequest: 'Move the review to 9 AM.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('GoodVibes schedule edit preview');
      expect(result.error).toContain('current source automation.schedules.list GET /api/automation/schedules');
      expect(result.error).toContain('0 8 * * * [America/Chicago] -> 0 9 * * * [America/Chicago]');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('routes schedule lifecycle actions through allowlisted operator actions', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(JSON.stringify({ id: 'sched-1', enabled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await tool.execute({
        action: 'pause',
        scheduleId: 'sched-1',
        confirm: true,
        explicitUserRequest: 'Pause sched-1.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('method: automation.schedules.disable');
      expect(result.output).toContain('nextRoutes');
      expect(result.output).toContain('schedule action:"list" query:"sched-1"');
      expect(result.output).toContain('schedule action:"resume" scheduleId:"sched-1" confirm:true explicitUserRequest:"..."');
      expect(requests).toEqual([{
        url: 'http://127.0.0.1:3421/api/automation/schedules/sched-1/disable',
        method: 'POST',
        body: '',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('registers the core schedule adapter without replacing existing tools', () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentScheduleTool(registry, paths, configManager(paths));

    expect(registry.has('schedule')).toBe(true);
  });
});
