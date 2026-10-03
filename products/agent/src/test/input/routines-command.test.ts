import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerRoutinesRuntimeCommands } from '../../input/commands/routines-runtime.ts';
import { registerScheduleRuntimeCommands } from '../../input/commands/schedule-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function commandHarness(): {
  readonly registry: CommandRegistry;
  readonly out: string[];
  readonly ctx: CommandContext;
} {
  const root = makeProjectTempDir('goodvibes-agent-routine-command');
  const registry = new CommandRegistry();
  registerRoutinesRuntimeCommands(registry);
  registerScheduleRuntimeCommands(registry);
  const out: string[] = [];
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'routine-token' }));
  const ctx = {
    print: (text: string) => out.push(text),
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    },
    platform: {
      configManager: new ConfigManager({
        surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
        workingDir: root,
        homeDir: root,
      }),
    },
    ops: {
      automationManager: {
        listJobs: () => [],
      },
    },
  } as unknown as CommandContext;
  return { registry, out, ctx };
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function scheduleResponse(): Response {
  return new Response(JSON.stringify({
    id: 'sched-1',
    name: 'Agent routine: Inbox Sweep',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
    execution: { prompt: 'routine prompt', target: { kind: 'main' } },
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
      id: 'source-sched-1',
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

function schedulesListResponse(): Response {
  return new Response(JSON.stringify({
    jobs: [
      {
        id: 'sched-1',
        name: 'Agent routine: Inbox Sweep',
        labels: [],
        createdAt: 1,
        updatedAt: 1,
        status: 'enabled',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
        execution: { prompt: 'routine prompt', target: { kind: 'main' } },
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
          id: 'source-sched-1',
          kind: 'schedule',
          label: 'schedule',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          metadata: {},
        },
        nextRunAt: 1_700_000_000_000,
        runCount: 3,
        successCount: 2,
        failureCount: 1,
        deleteAfterRun: false,
      },
    ],
    runs: [],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function runsListResponse(runs: readonly Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ runs }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRunFixture(overrides: {
  readonly id?: string;
  readonly jobId?: string;
  readonly status?: string;
  readonly jobName?: string;
  readonly queuedAt?: number;
  readonly endedAt?: number;
}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'run-1',
    jobId: overrides.jobId ?? 'sched-1',
    labels: [],
    createdAt: overrides.queuedAt ?? 1,
    updatedAt: overrides.endedAt ?? overrides.queuedAt ?? 1,
    status: overrides.status ?? 'completed',
    triggeredBy: {
      id: 'trigger-1',
      kind: 'schedule',
      label: overrides.jobName ?? 'Agent routine: Inbox Sweep',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    },
    target: { kind: 'main' },
    execution: { target: { kind: 'main' } },
    queuedAt: overrides.queuedAt ?? Date.now() - 3_600_000,
    endedAt: overrides.endedAt,
    forceRun: false,
    dueRun: true,
    attempt: 1,
    deliveryIds: [],
  };
}

describe('/routines command', () => {
  test('creates, lists, enables, starts, shows, and disables a local routine', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('routines', [
      'create',
      '--name',
      'Inbox Sweep',
      '--description',
      'Summarize inbound messages without sending replies.',
      '--steps',
      'Read channel state, group by sender, summarize urgency, and ask before external replies.',
      '--tags',
      'ops,communication',
      '--requires-env',
      'GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN',
      '--requires-command',
      'definitely-missing-goodvibes-agent-routine-bin',
    ], ctx);
    await registry.execute('routines', ['enable', 'inbox-sweep'], ctx);
    await registry.execute('routines', ['attention'], ctx);
    await registry.execute('routines', ['start', 'inbox-sweep'], ctx);
    await registry.execute('routines', ['enabled'], ctx);
    await registry.execute('routines', ['show', 'inbox-sweep'], ctx);
    await registry.execute('routines', ['disable', 'inbox-sweep'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent routine inbox-sweep');
    expect(text).toContain('Enabled Agent routine inbox-sweep');
    expect(text).toContain('Agent Routines needing setup');
    expect(text).toContain('Started Agent routine inbox-sweep');
    expect(text).toContain('needs env:GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN,command:definitely-missing-goodvibes-agent-routine-bin');
    expect(text).toContain('readiness: needs setup (env:GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN, command:definitely-missing-goodvibes-agent-routine-bin)');
    expect(text).toContain('missing: env:GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN, command:definitely-missing-goodvibes-agent-routine-bin');
    expect(text).toContain('no hidden job');
    expect(text).toContain('Inbox Sweep - Summarize inbound messages');
    expect(text).toContain('ask before external replies');
    expect(text).toContain('Disabled Agent routine inbox-sweep');
  });

  test('requires explicit delete confirmation and rejects secret-looking steps', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('routines', ['create', '--name', 'Ops', '--description', 'Ops routine.', '--steps', 'Inspect then act.'], ctx);
    await registry.execute('routines', ['delete', 'ops'], ctx);
    await registry.execute('routines', ['delete', 'ops', '--yes'], ctx);
    await registry.execute('routines', ['create', '--name', 'Bad', '--description', 'Bad.', '--steps', 'token=super-secret-value'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Refusing to delete Agent routine ops without --yes');
    expect(text).toContain('Deleted Agent routine ops');
    expect(text).toContain('secret-looking');
  });

  test('preserves option-looking routine step values', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('routines', [
      'create',
      '--name',
      'Flag Routine',
      '--description=Run command-line checks.',
      '--steps',
      '--dry-run first, summarize risk, then ask before external effects.',
      '--tags=cli,flags',
      '--enabled',
    ], ctx);
    await registry.execute('routines', ['show', 'flag-routine'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent routine flag-routine');
    expect(text).toContain('Routine Flag Routine');
    expect(text).toContain('Run command-line checks.');
    expect(text).toContain('--dry-run first, summarize risk, then ask before external effects.');
    expect(text).toContain('tags: cli, flags');
  });

  test('discovers and imports local routine markdown only after confirmation', async () => {
    const { registry, out, ctx } = commandHarness();
    const shellPaths = ctx.workspace?.shellPaths;
    if (!shellPaths) throw new Error('missing shell paths');
    const routineDir = join(shellPaths.workingDirectory, '.goodvibes', 'agent', 'routines', 'travel-prep');
    mkdirSync(routineDir, { recursive: true });
    writeFileSync(join(routineDir, 'ROUTINE.md'), [
      '---',
      'name: Travel Prep',
      'description: Prepare a trip brief from local context.',
      'triggers: travel, trip',
      'tags: planning, personal',
      '---',
      'Review itinerary, constraints, and reminders.',
      'Ask before booking, messaging, or changing external plans.',
    ].join('\n'));

    await registry.execute('routines', ['discover'], ctx);
    await registry.execute('routines', ['import-discovered', 'Travel', 'Prep'], ctx);
    await registry.execute('routines', ['list'], ctx);
    await registry.execute('routines', ['import-discovered', 'travel-prep', '--enabled', '--yes'], ctx);
    await registry.execute('routines', ['enabled'], ctx);
    await registry.execute('routines', ['show', 'travel-prep'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Discovered Agent routine files (1)');
    expect(text).toContain('Travel Prep  project-local');
    expect(text).toContain('Agent routine import preview');
    expect(text).toContain('No local Agent routines yet');
    expect(text).toContain('Imported Agent routine travel-prep: Travel Prep (enabled)');
    expect(text).toContain('travel-prep  enabled');
    expect(text).toContain('Review itinerary, constraints');
    expect(text).toContain('tags: planning, personal');
    expect(text).toContain('triggers: travel, trip');
  });

  test('previews routine schedule promotion without calling the connected host', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      await registry.execute('routines', ['create', '--name', 'Inbox Sweep', '--description', 'Review messages.', '--steps', 'Summarize inbound messages and ask before replies.'], ctx);
      await registry.execute('routines', ['promote', 'inbox-sweep', '--cron', '0 9 * * *', '--timezone', 'America/Chicago'], ctx);

      const text = out.join('\n');
      expect(text).toContain('GoodVibes schedule preview for Agent routine');
      expect(text).toContain('automation.schedules.create /api/automation/schedules');
      expect(text).toContain('isolated Agent Knowledge only');
      expect(text).toContain('confirmationRoutes');
      expect(text).toContain('workspace action:"run" actionId:"schedule-promote-routine" confirm:true explicitUserRequest:"..."');
      expect(text).toContain('/schedule promote-routine "inbox-sweep" --cron "0 9 * * *" --timezone "America/Chicago" --yes');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('confirmed routine promotion uses automation.schedules.create and preserves Agent policy', async () => {
    const { registry, out, ctx } = commandHarness();
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if ((init?.method ?? 'GET') === 'GET') return schedulesListResponse();
      return scheduleResponse();
    });

    try {
      await registry.execute('routines', ['create', '--name', 'Inbox Sweep', '--description', 'Review messages.', '--steps', 'Summarize inbound messages and ask before replies.'], ctx);
      await registry.execute('schedule', [
        'promote-routine',
        'inbox-sweep',
        '--cron',
        '0 9 * * *',
        '--timezone',
        'America/Chicago',
        '--delivery-webhook',
        'https://hooks.example.test/routine/secret-token',
        '--yes',
      ], ctx);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('http://127.0.0.1:3421/api/automation/schedules');
      expect(requests[0]!.method).toBe('POST');
      const payload = JSON.parse(requests[0]!.body) as {
        readonly prompt?: string;
        readonly kind?: string;
        readonly cron?: string;
        readonly target?: { readonly kind?: string; readonly surfaceKind?: string };
        readonly delivery?: {
          readonly mode?: string;
          readonly targets?: readonly {
            readonly kind?: string;
            readonly address?: string;
          }[];
        };
      };
      expect(payload.kind).toBe('cron');
      expect(payload.cron).toBe('0 9 * * *');
      expect(payload.target).toEqual(expect.objectContaining({ kind: 'main', surfaceKind: 'service' }));
      expect(payload.delivery?.mode).toBe('webhook');
      expect(payload.delivery?.targets?.[0]).toEqual(expect.objectContaining({
        kind: 'webhook',
        address: 'https://hooks.example.test/routine/secret-token',
      }));
      expect(payload.prompt).toContain('Use isolated Agent Knowledge routes only');
      expect(payload.prompt).toContain('never use default knowledge or non-Agent knowledge spaces');
      const promotionText = out.join('\n');
      const receiptId = promotionText.match(/receipt: (routine-schedule-[a-z0-9-]+)/)?.[1];
      expect(promotionText).toContain('Created GoodVibes schedule for Agent routine');
      expect(promotionText).toContain('nextRoutes');
      expect(promotionText).toContain('schedule action:"list" query:"sched-1"');
      expect(promotionText).toContain('autonomy action:"item" queueItemId:"connected-schedules" includeParameters:true');
      expect(promotionText).toContain('schedule action:"run" scheduleId:"sched-1" confirm:true explicitUserRequest:"..."');
      expect(receiptId).toEqual(expect.stringMatching(/^routine-schedule-[a-z0-9-]+$/));

      await registry.execute('schedule', ['receipts'], ctx);
      await registry.execute('schedule', ['receipt', receiptId!], ctx);
      await registry.execute('schedule', ['reconcile'], ctx);

      const receiptText = out.join('\n');
      expect(receiptText).toContain('Agent routine schedule receipts');
      expect(receiptText).toContain('schedule=sched-1');
      expect(receiptText).toContain('Agent routine schedule receipt');
      expect(receiptText).toContain('cadence: cron 0 9 * * * [America/Chicago]');
      expect(receiptText).toContain('delivery: webhook');
      expect(receiptText).toContain('delivery target: webhook address=https://hooks.example.test/...');
      expect(receiptText).not.toContain('secret-token');
      expect(receiptText).toContain('Agent routine schedule reconciliation');
      expect(receiptText).toContain('matched: 1');
      expect(receiptText).toContain('live=sched-1');
      expect(requests.map((request) => `${request.method} ${request.url}`)).toContain(
        'GET http://127.0.0.1:3421/api/automation/schedules',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects mixed routine delivery targets from slash commands without connected-host calls', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      await registry.execute('routines', ['create', '--name', 'Inbox Sweep', '--description', 'Review messages.', '--steps', 'Summarize inbound messages and ask before replies.'], ctx);
      await registry.execute('schedule', [
        'promote-routine',
        'inbox-sweep',
        '--cron',
        '0 9 * * *',
        '--delivery-channel',
        'slack',
        '--delivery-webhook',
        'https://hooks.example.test/routine',
        '--yes',
      ], ctx);

      expect(out.join('\n')).toContain('Use one delivery target kind per routine promotion command.');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('previews reminder schedule creation without connected-host calls', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      await registry.execute('schedule', [
        'remind',
        '--at',
        '2026-06-01T09:00:00-05:00',
        '--message',
        'Follow up on the report',
      ], ctx);

      const text = out.join('\n');
      expect(text).toContain('GoodVibes schedule preview for Agent reminder');
      expect(text).toContain('automation.schedules.create /api/automation/schedules');
      expect(text).toContain('isolated Agent Knowledge only');
      expect(text).toContain('confirmationRoutes');
      expect(text).toContain('schedule action:"remind" message:"Follow up on the report" scheduleKind:"at" scheduleValue:"2026-06-01T09:00:00-05:00" confirm:true explicitUserRequest:"..."');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('confirmed reminder schedule uses automation.schedules.create and preserves Agent reminder policy', async () => {
    const { registry, out, ctx } = commandHarness();
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
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
      await registry.execute('schedule', [
        'remind',
        '--every',
        '7d',
        '--message',
        'Review open approvals',
        '--delivery-channel',
        'slack:ops:Ops',
        '--yes',
      ], ctx);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('http://127.0.0.1:3421/api/automation/schedules');
      expect(requests[0]!.method).toBe('POST');
      const payload = JSON.parse(requests[0]!.body) as {
        readonly prompt?: string;
        readonly kind?: string;
        readonly every?: string;
        readonly target?: { readonly kind?: string; readonly surfaceKind?: string };
        readonly delivery?: {
          readonly mode?: string;
          readonly targets?: readonly {
            readonly kind?: string;
            readonly surfaceKind?: string;
            readonly routeId?: string;
          }[];
        };
      };
      expect(payload.kind).toBe('every');
      expect(payload.every).toBe('7d');
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
      expect(out.join('\n')).toContain('Created GoodVibes schedule for Agent reminder');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('previews schedule edits with connected-host current-state diffs', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return schedulesListResponse();
    });

    try {
      await registry.execute('schedule', [
        'edit',
        'sched-1',
        '--every',
        '1d',
        '--name',
        'Daily queue review',
      ], ctx);

      const text = out.join('\n');
      expect(text).toContain('GoodVibes schedule edit preview');
      expect(text).toContain('automation.jobs.update');
      expect(text).toContain('changes name, schedule');
      expect(text).toContain('current source automation.schedules.list GET /api/automation/schedules');
      expect(text).toContain('name Agent routine: Inbox Sweep -> Daily queue review');
      expect(text).toContain('confirmationRoutes');
      expect(text).toContain('schedule action:"edit" scheduleId:"sched-1" name:"Daily queue review" scheduleKind:"every" scheduleValue:"1d" confirm:true explicitUserRequest:"..."');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('confirmed schedule edits use automation.jobs.update', async () => {
    const { registry, out, ctx } = commandHarness();
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
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
      await registry.execute('schedule', [
        'edit',
        'sched-1',
        '--every',
        '1d',
        '--name',
        'Daily queue review',
        '--yes',
      ], ctx);

      expect(out.join('\n')).toContain('Updated GoodVibes schedule');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('http://127.0.0.1:3421/api/automation/jobs/sched-1');
      expect(requests[0]!.method).toBe('PATCH');
      const payload = JSON.parse(requests[0]!.body) as {
        readonly jobId?: string;
        readonly name?: string;
        readonly schedule?: {
          readonly kind?: string;
          readonly intervalMs?: number;
        };
      };
      expect(payload.jobId).toBeUndefined();
      expect(payload.name).toBe('Daily queue review');
      expect(payload.schedule).toEqual(expect.objectContaining({
        kind: 'every',
        intervalMs: 86_400_000,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('confirmed schedule lifecycle actions use exact connected-host routes', async () => {
    const { registry, out, ctx } = commandHarness();
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
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
      await registry.execute('schedule', ['disable', 'sched-1', '--yes'], ctx);
      await registry.execute('schedule', ['delete', 'sched-1', '--yes'], ctx);

      expect(out.join('\n')).toContain('Agent operator action completed');
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/automation/schedules/sched-1/disable',
        'http://127.0.0.1:3421/api/automation/schedules/sched-1',
      ]);
      expect(requests.map((request) => request.method)).toEqual(['POST', 'DELETE']);
      expect(requests.map((request) => request.body)).toEqual(['', '']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('connected schedule lifecycle does not require local automation manager', async () => {
    const { registry, out, ctx } = commandHarness();
    const contextWithoutManager = {
      ...ctx,
      ops: {},
    } as unknown as CommandContext;
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
      });
      return scheduleResponse();
    });

    try {
      await registry.execute('schedule', ['run', 'sched-1', '--yes'], contextWithoutManager);

      expect(out.join('\n')).toContain('Agent operator action completed');
      expect(out.join('\n')).not.toContain('Automation manager is not available');
      expect(requests).toEqual([{
        url: 'http://127.0.0.1:3421/api/automation/schedules/sched-1/run',
        method: 'POST',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('schedule list shows the connected host\'s schedules', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/api/automation/runs')) return runsListResponse([]);
      return schedulesListResponse();
    });

    try {
      await registry.execute('schedule', ['list'], ctx);
      const text = out.join('\n');
      expect(text).toContain('Connected-host schedules');
      expect(text).toContain('sched-1');
      expect(text).toContain('Agent routine: Inbox Sweep');
      expect(text).toContain('cron 0 9 * * * [America/Chicago]');
      expect(text).not.toContain('outcome');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('schedule list renders a missed run as an outcome, not silence', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/api/automation/runs')) {
        return runsListResponse([
          makeRunFixture({ id: 'run-1', jobId: 'sched-1', status: 'missed', endedAt: Date.now() - 600_000 }),
        ]);
      }
      return schedulesListResponse();
    });

    try {
      await registry.execute('schedule', ['list'], ctx);
      const text = out.join('\n');
      expect(text).toContain('sched-1');
      expect(text).toContain('outcome missed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('schedule list renders a failed run as a distinct outcome from missed', async () => {
    const { registry, out, ctx } = commandHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/api/automation/runs')) {
        return runsListResponse([
          makeRunFixture({ id: 'run-1', jobId: 'sched-1', status: 'failed', endedAt: Date.now() - 300_000 }),
        ]);
      }
      return schedulesListResponse();
    });

    try {
      await registry.execute('schedule', ['list'], ctx);
      const text = out.join('\n');
      expect(text).toContain('outcome failed');
      expect(text).not.toContain('outcome missed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('schedule list does not require the local automation manager', async () => {
    const { registry, out, ctx } = commandHarness();
    const contextWithoutManager = { ...ctx, ops: {} } as unknown as CommandContext;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input) => {
      const url = inputUrl(input);
      if (url.includes('/api/automation/runs')) return runsListResponse([]);
      return schedulesListResponse();
    });

    try {
      await registry.execute('schedule', ['list'], contextWithoutManager);
      const text = out.join('\n');
      expect(text).toContain('Connected-host schedules');
      expect(text).not.toContain('Automation manager is not available');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
