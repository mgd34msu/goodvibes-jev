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
  createAgentReminderScheduleTool,
  registerAgentReminderScheduleTool,
} from '../../tools/agent-reminder-schedule-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface ScheduleRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

interface SchedulePayload {
  readonly kind?: string;
  readonly at?: string;
  readonly every?: string;
  readonly cron?: string;
  readonly prompt?: string;
  readonly target?: {
    readonly kind?: string;
    readonly surfaceKind?: string;
  };
  readonly delivery?: {
    readonly mode?: string;
    readonly targets?: readonly {
      readonly kind?: string;
      readonly surfaceKind?: string;
      readonly routeId?: string;
    }[];
  };
}

function shellPaths(): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-reminder-tool');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'reminder-tool-token' }));
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
    id: 'sched-reminder-1',
    name: 'Agent reminder: Review approvals',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'every', intervalMs: 86_400_000 },
    execution: { prompt: 'reminder prompt', target: { kind: 'main' } },
    delivery: {
      mode: 'surface',
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
      id: 'source-sched-reminder-1',
      kind: 'schedule',
      label: 'schedule',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
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

describe('agent_reminder_schedule tool', () => {
  test('previews without calling the connected host when confirmation is missing', async () => {
    const paths = shellPaths();
    const tool = createAgentReminderScheduleTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      const result = await tool.execute({
        message: 'Review open approvals',
        scheduleKind: 'every',
        scheduleValue: '1d',
        confirm: false,
        explicitUserRequest: 'Remind me every day to review open approvals.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('GoodVibes schedule preview for Agent reminder');
      expect(result.error).toContain('confirmation required');
      expect(result.error).toContain('confirmationRoutes');
      expect(result.error).toContain('schedule action:"remind" message:"Review open approvals"');
      expect(result.error).toContain('scheduleKind:"every" scheduleValue:"1d" confirm:true explicitUserRequest:"..."');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requires explicit user request provenance before scheduling', async () => {
    const paths = shellPaths();
    const tool = createAgentReminderScheduleTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      const result = await tool.execute({
        message: 'Review open approvals',
        scheduleKind: 'every',
        scheduleValue: '1d',
        confirm: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('explicitUserRequest is required');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('creates a connected reminder through automation.schedules.create after explicit confirmation', async () => {
    const paths = shellPaths();
    const tool = createAgentReminderScheduleTool(paths, configManager(paths));
    const requests: ScheduleRequest[] = [];
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
        message: 'Review open approvals',
        scheduleKind: 'every',
        scheduleValue: '1d',
        deliveryChannel: 'slack:ops:Ops',
        confirm: true,
        explicitUserRequest: 'Remind me every day to review open approvals.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Created GoodVibes schedule for Agent reminder');
      expect(result.output).toContain('nextRoutes');
      expect(result.output).toContain('schedule action:"list" query:"sched-reminder-1"');
      expect(result.output).toContain('schedule action:"edit" scheduleId:"sched-reminder-1" confirm:true explicitUserRequest:"..."');
      expect(result.output).toContain('schedule action:"delete" scheduleId:"sched-reminder-1" confirm:true explicitUserRequest:"..."');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/automation/schedules');
      expect(requests[0]?.method).toBe('POST');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as SchedulePayload;
      expect(payload.kind).toBe('every');
      expect(payload.every).toBe('1d');
      expect(payload.target).toEqual(expect.objectContaining({ kind: 'main', surfaceKind: 'service' }));
      expect(payload.delivery?.mode).toBe('surface');
      expect(payload.delivery?.targets?.[0]).toEqual(expect.objectContaining({
        kind: 'surface',
        surfaceKind: 'slack',
        routeId: 'ops',
      }));
      expect(payload.prompt).toContain('GoodVibes Agent scheduled reminder');
      expect(payload.prompt).toContain('never use default knowledge or non-Agent knowledge spaces');
      expect(payload.prompt).toContain('Do not request GoodVibes TUI delegation from a reminder');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is registered in the model tool registry', async () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentReminderScheduleTool(registry, paths, configManager(paths));

    expect(registry.has('agent_reminder_schedule')).toBe(true);
  });
});
