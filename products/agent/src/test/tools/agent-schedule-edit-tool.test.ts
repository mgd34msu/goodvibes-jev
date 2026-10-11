import { scheduleEffectAdmission } from '../helpers/schedule-effect-admission.ts';
import { createScheduleInputProjector } from '../../tools/agent-schedule-effect.ts';
import { registerAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
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
  readonly expectedMutationRevision?: string;
  readonly admission?: string;
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
        mutationRevision: 'synthetic-edit-revision-1',
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

function admittedTool(paths: ShellPaths) {
  const fixture = scheduleEffectAdmission(paths.workingDirectory), config = configManager(paths);
  registerAgentOperatorMethodTool(fixture.registry, paths, config);
  const raw = createAgentScheduleEditTool(paths, config, fixture.registry);
  fixture.registry.register(raw, { inputProjection: createScheduleInputProjector(paths, config) });
  return { definition: raw.definition, execute: (args: Record<string, unknown>, options?: Parameters<typeof raw.execute>[1]) => fixture.run(raw, args, options) };
}

describe('agent_schedule_edit tool', () => {
  test('holds an unadmitted edit before reading the connected host', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleEditTool(paths, configManager(paths), new ToolRegistry());
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
      expect(result.error).toContain('recorded effect admission');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('holds forged edit confirmation without recorded admission', async () => {
    const paths = shellPaths();
    const tool = createAgentScheduleEditTool(paths, configManager(paths), new ToolRegistry());
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
      expect(result.error).toContain('recorded effect admission');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('patches a connected schedule under recorded admission', async () => {
    const paths = shellPaths();
    const tool = admittedTool(paths);
    const requests: ScheduleEditRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return init?.method === 'GET' ? schedulesListResponse() : scheduleResponse();
    });

    try {
      const result = await tool.execute({
        scheduleId: 'sched-edit-1',
        scheduleKind: 'cron',
        scheduleValue: '0 9 * * *',
        timezone: 'America/Chicago',
        name: 'Daily queue review',
        explicitUserRequest: 'Move the daily review to 9 AM.',
      });

      expect(result).toEqual(expect.objectContaining({ success: true }));
      if (!result.success || !('output' in result) || typeof result.output !== 'string') {
        throw new Error('Successful schedule edit must include output text.');
      }
      expect(result.output).toContain('Updated GoodVibes schedule');
      expect(result.output).toContain('nextRoutes');
      expect(result.output).toContain('schedule action:"list" query:"sched-edit-1"');
      expect(result.output).toContain('schedule action:"run" scheduleId:"sched-edit-1"');
      expect(result.output).toContain('schedule action:"delete" scheduleId:"sched-edit-1"');
      expect(requests).toHaveLength(3);
      expect(requests[2]?.url).toBe('http://127.0.0.1:3421/api/automation/jobs/sched-edit-1');
      expect(requests[2]?.method).toBe('PATCH');
      const payload = JSON.parse(requests[2]?.body ?? '{}') as SchedulePatchPayload;
      expect(payload.jobId).toBeUndefined();
      expect(payload.expectedMutationRevision).toBe('synthetic-edit-revision-1');
      expect(payload.admission).toBe('autonomous');
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
    const tool = admittedTool(paths);
    const requests: ScheduleEditRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return init?.method === 'GET' ? schedulesListResponse() : scheduleResponse();
    });

    try {
      const result = await tool.execute({
        scheduleId: 'sched-edit-1',
        task: 'Review the ops queue and summarize blockers',
        successCriteria: 'Report blocker count and highest priority action.',
        explicitUserRequest: 'Change the daily review to summarize blockers.',
      });

      expect(result).toEqual(expect.objectContaining({ success: true }));
      const payload = JSON.parse(requests[2]?.body ?? '{}') as SchedulePatchPayload;
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
