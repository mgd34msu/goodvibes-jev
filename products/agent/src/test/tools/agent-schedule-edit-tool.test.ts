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
  createAgentScheduleEditTool,
  registerAgentScheduleEditTool,
} from '../../tools/agent-schedule-edit-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface ScheduleEditRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

interface SchedulePatchPayload {
  readonly jobId?: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly schedule?: {
    readonly kind?: string;
    readonly expression?: string;
    readonly intervalMs?: number;
    readonly timezone?: string;
    readonly staggerMs?: number;
  };
}

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-schedule-edit-tool');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'schedule-edit-token' }));
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

function scheduleResponse(): Response {
  return new Response(JSON.stringify({
    id: 'sched-edit-1',
    name: 'Daily queue review',
    labels: [],
    createdAt: 1,
    updatedAt: 2,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
    execution: { prompt: 'updated prompt', target: { kind: 'main' } },
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
    source: {
      id: 'source-sched-edit-1',
      kind: 'schedule',
      label: 'schedule',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    },
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
        id: 'sched-edit-1',
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
        source: {
          id: 'source-sched-edit-1',
          kind: 'schedule',
          label: 'schedule',
          enabled: true,
          createdAt: 1,
          updatedAt: 2,
          metadata: {},
        },
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

describe('agent_schedule_edit tool', () => {
  test('previews schedule edits with a read-only current-state diff before confirmation', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleEditTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return schedulesListResponse();
    });

    try {
      const result = await tool.execute({
        scheduleId: 'sched-edit-1',
        scheduleKind: 'cron',
        scheduleValue: '0 9 * * *',
        timezone: 'America/Chicago',
        confirm: false,
        explicitUserRequest: 'Move the daily review to 9 AM.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('GoodVibes schedule edit preview');
      expect(result.error).toContain('confirmation required');
      expect(result.error).toContain('current source automation.schedules.list GET /api/automation/schedules');
      expect(result.error).toContain('schedule 0 8 * * * [America/Chicago] -> 0 9 * * * [America/Chicago]');
      expect(result.error).toContain('confirmationRoutes');
      expect(result.error).toContain('schedule action:"edit" scheduleId:"sched-edit-1"');
      expect(result.error).toContain('scheduleKind:"cron" scheduleValue:"0 9 * * * [America/Chicago]" confirm:true explicitUserRequest:"..."');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requires explicit user request provenance before editing', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleEditTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      const result = await tool.execute({
        scheduleId: 'sched-edit-1',
        name: 'Daily queue review',
        confirm: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('explicitUserRequest is required');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('patches a connected schedule after explicit confirmation', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleEditTool(paths, configManager(paths));
    const requests: ScheduleEditRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return scheduleResponse();
    });

    try {
      const result = await tool.execute({
        scheduleId: 'sched-edit-1',
        scheduleKind: 'cron',
        scheduleValue: '0 9 * * *',
        timezone: 'America/Chicago',
        name: 'Daily queue review',
        confirm: true,
        explicitUserRequest: 'Move the daily review to 9 AM.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Updated GoodVibes schedule');
      expect(result.output).toContain('nextRoutes');
      expect(result.output).toContain('schedule action:"list" query:"sched-edit-1"');
      expect(result.output).toContain('schedule action:"run" scheduleId:"sched-edit-1" confirm:true explicitUserRequest:"..."');
      expect(result.output).toContain('schedule action:"delete" scheduleId:"sched-edit-1" confirm:true explicitUserRequest:"..."');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/automation/jobs/sched-edit-1');
      expect(requests[0]?.method).toBe('PATCH');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as SchedulePatchPayload;
      expect(payload.jobId).toBeUndefined();
      expect(payload.name).toBe('Daily queue review');
      expect(payload.schedule).toEqual(expect.objectContaining({
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'America/Chicago',
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rebuilds the autonomous policy prompt when task is edited', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleEditTool(paths, configManager(paths));
    const requests: ScheduleEditRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return scheduleResponse();
    });

    try {
      const result = await tool.execute({
        scheduleId: 'sched-edit-1',
        task: 'Review the ops queue and summarize blockers',
        successCriteria: 'Report blocker count and highest priority action.',
        confirm: true,
        explicitUserRequest: 'Change the daily review to summarize blockers.',
      });

      expect(result.success).toBe(true);
      const payload = JSON.parse(requests[0]?.body ?? '{}') as SchedulePatchPayload;
      expect(payload.prompt).toContain('GoodVibes Agent autonomous schedule');
      expect(payload.prompt).toContain('Change the daily review to summarize blockers.');
      expect(payload.prompt).toContain('Report blocker count and highest priority action.');
      expect(payload.prompt).toContain('never use default knowledge or non-Agent knowledge spaces');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is registered in the model tool registry', () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentScheduleEditTool(registry, paths, configManager(paths));

    expect(registry.has('agent_schedule_edit')).toBe(true);
  });
});
