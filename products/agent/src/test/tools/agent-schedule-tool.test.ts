import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { registerAgentAutonomyScheduleTool } from '../../tools/agent-autonomy-schedule-tool.ts';
import { registerAgentReminderScheduleTool } from '../../tools/agent-reminder-schedule-tool.ts';
import { registerAgentScheduleEditTool } from '../../tools/agent-schedule-edit-tool.ts';
import { registerAgentOperatorActionTool } from '../../tools/agent-operator-action-tool.ts';
import { registerAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
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

// Authored synthetic response fields only; these are not production classifications.
const ordinaryFields = new Set(['methodId', 'status', 'ok', 'route', 'effect', 'id', 'name', 'labels',
  'createdAt', 'updatedAt', 'enabled', 'schedule', 'kind', 'expression', 'timezone', 'execution',
  'target', 'delivery', 'mode', 'targets', 'fallbackTargets', 'includeSummary', 'includeTranscript',
  'includeLinks', 'failure', 'action', 'maxConsecutiveFailures', 'cooldownMs', 'retryPolicy',
  'maxAttempts', 'delayMs', 'strategy', 'source', 'label', 'metadata', 'runCount', 'successCount',
  'failureCount', 'deleteAfterRun', 'jobs', 'runs', 'method', 'host', 'query', 'queueItemId',
  'includeParameters', 'scheduleId', 'mutationRevision']);
const contentFields = new Set(['body', 'prompt']);
let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  const scripted = fakePort((name, question, state) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type !== 'choice') throw new Error(`Unexpected synthetic schedule question ${name}`);
    const field = state && typeof state === 'object' && !Array.isArray(state) ? state.field : undefined;
    if (name === 'kind' && Object.hasOwn(question.criteria, 'other') && field !== undefined) {
      if (typeof field !== 'string' || (!ordinaryFields.has(field) && !contentFields.has(field)))
        throw new Error('Unexpected synthetic schedule response field');
      return choiceAnswer(question, contentFields.has(field) ? 'content' : 'other', 0.999);
    }
    return choiceAnswer(question, name === 'disposition' ? Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject'
      : name === 'kind' ? 'read' : 'generic', 0.999);
  });
  prior = installJudgmentPort(withDecisionLog(scripted.port, log));
});
afterEach(() => { installJudgmentPort(prior); log[Symbol.dispose](); });

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

function admittedSchedule(paths: ShellPaths) {
  const config = configManager(paths);
  const placeholder: Tool = { definition: { name: 'schedule', description: 'Replaced by the actual schedule facade.', parameters: {} }, execute: async () => ({ success: false }) };
  const fixture = recordedEffectFixture(placeholder, 'prompt', {}, paths.workingDirectory);
  registerAgentOperatorActionTool(fixture.registry, paths, config);
  registerAgentOperatorMethodTool(fixture.registry, paths, config);
  registerAgentAutonomyScheduleTool(fixture.registry, paths, config);
  registerAgentReminderScheduleTool(fixture.registry, paths, config);
  registerAgentScheduleEditTool(fixture.registry, paths, config);
  const tool = createAgentScheduleTool(paths, config, fixture.registry);
  placeholder.definition = tool.definition; placeholder.execute = tool.execute;
  return { definition: tool.definition, execute: (args: Record<string, unknown>) => fixture.run(args) };
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
        mutationRevision: 'schedule-tool-revision',
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
    const tool = admittedSchedule(paths);
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

      expect(result).toMatchObject({ success: true });
      expect(result.output).toContain('"methodId": "automation.schedules.list"');
      expect(result.output).toContain('"sched-1"');
      expect(requests).toEqual([{ url: 'http://127.0.0.1:3421/api/automation/schedules', method: 'GET', body: '' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('unadmitted create flags cannot call the connected host', async () => {
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
        confirm: true,
        explicitUserRequest: 'Review the ops queue every day.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('recorded tool admission');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('creates reminders through existing reminder schedule safety gates', async () => {
    const paths = shellPaths();
    const tool = admittedSchedule(paths);
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
      });

      expect(result).toMatchObject({ success: true });
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

  test('unadmitted edit flags cannot dispatch a connected schedule mutation', async () => {
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
        confirm: true,
        explicitUserRequest: 'Move the review to 9 AM.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('recorded tool admission');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('routes schedule lifecycle actions through allowlisted operator actions', async () => {
    const paths = shellPaths();
    const tool = admittedSchedule(paths);
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if ((init?.method ?? 'GET') === 'GET') return schedulesListResponse();
      return new Response(JSON.stringify({ id: 'sched-1', enabled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await tool.execute({
        action: 'pause',
        scheduleId: 'sched-1',
      });

      expect(result).toMatchObject({ success: true });
      expect(result.output).toContain('method: automation.schedules.disable');
      expect(result.output).toContain('nextRoutes');
      expect(result.output).toContain('schedule action:"list" query:"sched-1"');
      expect(requests).toEqual([{
        url: 'http://127.0.0.1:3421/api/automation/schedules',
        method: 'GET',
        body: '',
      }, {
        url: 'http://127.0.0.1:3421/api/automation/schedules/sched-1/disable',
        method: 'POST',
        body: JSON.stringify({ admission: 'autonomous', expectedMutationRevision: 'schedule-tool-revision' }),
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
