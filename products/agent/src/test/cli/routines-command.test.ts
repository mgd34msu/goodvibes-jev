import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { routineScheduleReceiptStorePath } from '../../agent/routine-schedule-receipts.ts';
import { handleRoutinesCommand } from '../../cli/routines-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function runtime(argv: readonly string[]) {
  const root = makeProjectTempDir('gv-agent-routines-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'routine-cli-token' }));
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  const registry = AgentRoutineRegistry.fromShellPaths(createShellPathService({ workingDirectory, homeDirectory }));
  registry.create({
    name: 'Daily Operations Sweep',
    description: 'Review operations posture.',
    steps: 'Inspect connected-host status, schedules, approvals, and Agent Knowledge. Ask before external changes.',
    enabled: true,
    tags: ['ops'],
    triggers: ['daily'],
    source: 'user',
    provenance: 'test',
  });
  return {
    cli: parseGoodVibesCli(['routines', ...argv]),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function scheduleResponse(): Response {
  return new Response(JSON.stringify({
    id: 'sched-cli-1',
    name: 'Agent routine: Daily Operations Sweep',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 8 * * *' },
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
      id: 'source-sched-cli-1',
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
        id: 'sched-cli-1',
        name: 'Agent routine: Daily Operations Sweep',
        labels: [],
        createdAt: 1,
        updatedAt: 1,
        status: 'enabled',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 8 * * *' },
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
          id: 'source-sched-cli-1',
          kind: 'schedule',
          label: 'schedule',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          metadata: {},
        },
        nextRunAt: 1_700_000_000_000,
        runCount: 2,
        successCount: 2,
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('routines CLI command', () => {
  test('lists and shows local Agent routines', async () => {
    const listed = await handleRoutinesCommand(runtime(['list']));
    const shown = await handleRoutinesCommand(runtime(['show', 'daily-operations-sweep']));

    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain('Daily Operations Sweep');
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain('Ask before external changes');
  });

  test('creates local routines from the CLI as parity with TUI /routines create', async () => {
    const baseRuntime = runtime([
      'create',
      '--name',
      'Daily Sweep',
      '--description',
      'Review operator state.',
      '--steps',
      'Check tasks, approvals, channels, and Agent Knowledge.',
      '--tags',
      'ops,daily',
      '--triggers',
      'morning',
      '--requires-env',
      'GOODVIBES_AGENT_TOKEN',
      '--requires-command',
      'gh',
      '--enabled',
    ]);
    const created = await handleRoutinesCommand(baseRuntime);

    expect(created.exitCode).toBe(0);
    expect(created.output).toContain('Created Agent routine daily-sweep: Daily Sweep (enabled)');

    const shown = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'show', 'daily-sweep', '--json']) });
    const payload = JSON.parse(shown.output) as {
      readonly kind?: unknown;
      readonly data?: {
        readonly name?: unknown;
        readonly enabled?: unknown;
        readonly tags?: readonly string[];
        readonly triggers?: readonly string[];
        readonly requirements?: readonly { readonly kind?: unknown; readonly name?: unknown }[];
        readonly provenance?: unknown;
      };
    };

    expect(shown.exitCode).toBe(0);
    expect(payload.kind).toBe('agent.routines.show');
    expect(payload.data?.name).toBe('Daily Sweep');
    expect(payload.data?.enabled).toBe(true);
    expect(payload.data?.tags).toEqual(['ops', 'daily']);
    expect(payload.data?.triggers).toEqual(['morning']);
    expect(payload.data?.requirements?.map((requirement) => `${String(requirement.kind)}:${String(requirement.name)}`)).toEqual([
      'env:GOODVIBES_AGENT_TOKEN',
      'command:gh',
    ]);
    expect(payload.data?.provenance).toBe('cli');
  });

  test('deletes local routines from the CLI as parity with TUI /routines delete', async () => {
    const baseRuntime = runtime(['show', 'daily-operations-sweep']);

    const withoutYes = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'delete', 'daily-operations-sweep']) });
    expect(withoutYes.exitCode).toBe(2);
    expect(withoutYes.output).toContain('Refusing to delete Agent routine daily-operations-sweep without --yes.');

    const stillThere = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'show', 'daily-operations-sweep']) });
    expect(stillThere.exitCode).toBe(0);

    const deleted = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'delete', 'daily-operations-sweep', '--yes', '--json']) });
    expect(deleted.exitCode).toBe(0);
    const payload = JSON.parse(deleted.output) as { readonly kind?: unknown; readonly data?: { readonly id?: unknown; readonly name?: unknown } };
    expect(payload.kind).toBe('agent.routines.delete');
    expect(payload.data?.id).toBe('daily-operations-sweep');
    expect(payload.data?.name).toBe('Daily Operations Sweep');

    const afterDelete = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'show', 'daily-operations-sweep']) });
    expect(afterDelete.exitCode).toBe(1);
    expect(afterDelete.output).toContain('Unknown Agent routine: daily-operations-sweep');
  });

  test('reports an honest error deleting a nonexistent routine from the CLI', async () => {
    const baseRuntime = runtime(['delete', 'never-existed', '--yes']);
    const result = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'delete', 'never-existed', '--yes', '--json']) });

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly kind?: unknown; readonly error?: unknown };
    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe('routine_not_found');
    expect(String(payload.error)).toContain('Unknown routine never-existed');
  });

  test('requires a routine id to delete', async () => {
    const result = await handleRoutinesCommand(runtime(['delete']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toBe('Usage: goodvibes-agent routines delete <id> --yes');
  });

  test('returns structured errors for invalid routine create input', async () => {
    const result = await handleRoutinesCommand({
      ...runtime(['create', '--name', 'Incomplete', '--json']),
      cli: parseGoodVibesCli(['routines', 'create', '--name', 'Incomplete', '--json']),
    });
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly kind?: unknown; readonly error?: unknown };

    expect(result.exitCode).toBe(2);
    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe('invalid_routine_command');
    expect(String(payload.error)).toContain('Usage: goodvibes-agent routines create');
    expect(String(payload.error)).toContain('Missing --description');
  });

  test('preserves option-looking routine values from the CLI', async () => {
    const baseRuntime = runtime([
      'create',
      '--name=Flag Routine',
      '--description',
      '--run-command-checks',
      '--steps',
      '--dry-run first, summarize risk, then ask before external effects.',
      '--tags=cli,flags',
    ]);
    const created = await handleRoutinesCommand(baseRuntime);
    expect(created.exitCode).toBe(0);

    const shown = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'show', 'flag-routine', '--json']) });
    const payload = JSON.parse(shown.output) as {
      readonly data?: {
        readonly description?: unknown;
        readonly steps?: unknown;
        readonly tags?: readonly string[];
      };
    };

    expect(shown.exitCode).toBe(0);
    expect(payload.data?.description).toBe('--run-command-checks');
    expect(payload.data?.steps).toBe('--dry-run first, summarize risk, then ask before external effects.');
    expect(payload.data?.tags).toEqual(['cli', 'flags']);
  });

  test('discovers previews and imports local routine markdown only after confirmation', async () => {
    const baseRuntime = runtime(['discover']);
    const routineDir = join(baseRuntime.workingDirectory, '.goodvibes', 'agent', 'routines', 'travel-prep');
    mkdirSync(routineDir, { recursive: true });
    writeFileSync(join(routineDir, 'ROUTINE.md'), [
      '---',
      'name: Travel Prep',
      'description: Prepare a trip brief from local context.',
      'triggers: travel, trip',
      'tags: planning, personal',
      'requiresEnv: GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN',
      'requiresCommands: definitely-missing-goodvibes-agent-routine-bin',
      '---',
      'Review itinerary, constraints, and reminders.',
      'Ask before booking, messaging, or changing external plans.',
    ].join('\n'));

    const discovered = await handleRoutinesCommand(baseRuntime);
    expect(discovered.exitCode).toBe(0);
    expect(discovered.output).toContain('Discovered Agent routine files (1)');
    expect(discovered.output).toContain('Travel Prep');
    expect(discovered.output).toContain('travel-prep/ROUTINE.md');

    const discoveredJson = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'discover', '--json']) });
    const discoveredPayload = JSON.parse(discoveredJson.output) as {
      readonly kind?: unknown;
      readonly data?: { readonly routines?: readonly { readonly name?: unknown; readonly origin?: unknown }[] };
    };
    expect(discoveredPayload.kind).toBe('agent.routines.discover');
    expect(discoveredPayload.data?.routines?.[0]?.name).toBe('Travel Prep');
    expect(discoveredPayload.data?.routines?.[0]?.origin).toBe('project-local');

    const preview = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'import-discovered', 'travel-prep']) });
    expect(preview.exitCode).toBe(0);
    expect(preview.output).toContain('Agent routine import preview');
    expect(preview.output).toContain('rerun with --yes');

    const beforeImport = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'show', 'travel-prep']) });
    expect(beforeImport.exitCode).toBe(1);
    expect(beforeImport.output).toContain('Unknown Agent routine: travel-prep');

    const imported = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'import-discovered', 'Travel', 'Prep', '--enabled', '--yes']) });
    expect(imported.exitCode).toBe(0);
    expect(imported.output).toContain('Imported Agent routine travel-prep: Travel Prep (enabled)');

    const attention = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'attention']) });
    expect(attention.exitCode).toBe(0);
    expect(attention.output).toContain('Agent routines needing setup');
    expect(attention.output).toContain('Travel Prep');

    const shownJson = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'show', 'travel-prep', '--json']) });
    const shownPayload = JSON.parse(shownJson.output) as {
      readonly kind?: unknown;
      readonly data?: {
        readonly source?: unknown;
        readonly provenance?: unknown;
        readonly tags?: readonly string[];
        readonly triggers?: readonly string[];
        readonly requirements?: readonly { readonly kind?: unknown; readonly name?: unknown }[];
        readonly enabled?: unknown;
      };
    };
    expect(shownPayload.kind).toBe('agent.routines.show');
    expect(shownPayload.data?.source).toBe('imported');
    expect(String(shownPayload.data?.provenance ?? '')).toContain('discovered:project-local:');
    expect(shownPayload.data?.tags).toContain('planning');
    expect(shownPayload.data?.triggers).toContain('trip');
    expect(shownPayload.data?.requirements?.map((requirement) => `${String(requirement.kind)}:${String(requirement.name)}`)).toEqual([
      'env:GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN',
      'command:definitely-missing-goodvibes-agent-routine-bin',
    ]);
    expect(shownPayload.data?.enabled).toBe(true);
  });

  test('previews schedule promotion with explicit delivery without calling the connected host', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      const result = await handleRoutinesCommand(runtime([
        'promote',
        'daily-operations-sweep',
        '--cron',
        '0 8 * * *',
        '--delivery-webhook',
        'https://hooks.example.test/routine/secret-token',
      ]));
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('GoodVibes schedule preview');
      expect(result.output).toContain('automation.schedules.create /api/automation/schedules');
      expect(result.output).toContain('delivery: webhook (1 target)');
      expect(result.output).not.toContain('secret-token');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('confirmed promotion posts automation.schedules.create with Agent-only knowledge policy and delivery target', async () => {
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
      const baseRuntime = runtime([
        'promote',
        'daily-operations-sweep',
        '--cron',
        '0 8 * * *',
        '--delivery-channel',
        'slack:route-slack:Ops',
        '--yes',
      ]);
      const result = await handleRoutinesCommand(baseRuntime);
      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('http://127.0.0.1:3421/api/automation/schedules');
      const payload = JSON.parse(requests[0]!.body) as {
        readonly prompt?: string;
        readonly target?: { readonly kind?: string; readonly surfaceKind?: string };
        readonly delivery?: {
          readonly mode?: string;
          readonly targets?: readonly {
            readonly kind?: string;
            readonly surfaceKind?: string;
            readonly routeId?: string;
            readonly label?: string;
          }[];
        };
      };
      expect(payload.target).toEqual(expect.objectContaining({ kind: 'main', surfaceKind: 'service' }));
      expect(payload.delivery?.mode).toBe('surface');
      expect(payload.delivery?.targets?.[0]).toEqual(expect.objectContaining({
        kind: 'surface',
        surfaceKind: 'slack',
        routeId: 'route-slack',
        label: 'Ops',
      }));
      expect(payload.prompt).toContain('Use isolated Agent Knowledge routes only');
      expect(payload.prompt).toContain('never use default knowledge or non-Agent knowledge spaces');
      expect(result.output).toContain('nextRoutes');
      expect(result.output).toContain('schedule action:"list" query:"sched-cli-1"');
      expect(result.output).toContain('autonomy action:"item" queueItemId:"connected-schedules" includeParameters:true');
      expect(result.output).toContain('schedule action:"delete" scheduleId:"sched-cli-1" confirm:true explicitUserRequest:"..."');
      const receiptId = result.output.match(/receipt: (routine-schedule-[a-z0-9-]+)/)?.[1];
      expect(receiptId).toEqual(expect.stringMatching(/^routine-schedule-[a-z0-9-]+$/));

      const receipts = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'receipts']) });
      expect(receipts.exitCode).toBe(0);
      expect(receipts.output).toContain('Agent routine schedule receipts');
      expect(receipts.output).toContain('schedule=sched-cli-1');

      const receipt = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'receipt', receiptId!]) });
      expect(receipt.exitCode).toBe(0);
      expect(receipt.output).toContain('Agent routine schedule receipt');
      expect(receipt.output).toContain('connected host: http://127.0.0.1:3421');
      expect(receipt.output).toContain('cadence: cron 0 8 * * *');
      expect(receipt.output).toContain('delivery: surface');
      expect(receipt.output).toContain('delivery target: channel/slack route=route-slack label=Ops');
      expect(receipt.output).not.toContain('runtime:');

      const receiptJson = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'receipt', receiptId!, '--json']) });
      const receiptPayload = JSON.parse(receiptJson.output) as {
        readonly data?: {
          readonly connectedHostBaseUrl?: unknown;
          readonly daemonBaseUrl?: unknown;
        };
      };
      expect(receiptPayload.data?.connectedHostBaseUrl).toBe('http://127.0.0.1:3421');
      expect(Object.prototype.hasOwnProperty.call(receiptPayload.data as object, 'daemonBaseUrl')).toBe(false);

      const reconciled = await handleRoutinesCommand({ ...baseRuntime, cli: parseGoodVibesCli(['routines', 'reconcile']) });
      expect(reconciled.exitCode).toBe(0);
      expect(reconciled.output).toContain('Agent routine schedule reconciliation');
      expect(reconciled.output).toContain('connected host: http://127.0.0.1:3421');
      expect(reconciled.output).toContain('matched: 1');
      expect(reconciled.output).toContain('live=sched-cli-1');
      expect(requests.map((request) => `${request.method} ${request.url}`)).toContain(
        'GET http://127.0.0.1:3421/api/automation/schedules',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('normalizes connected-host schedule failures and writes new receipt host fields', async () => {
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      throw new Error('Route not found: /api/automation/schedules (404)');
    });

    try {
      const result = await handleRoutinesCommand(runtime([
        'promote',
        'daily-operations-sweep',
        '--cron',
        '0 8 * * *',
        '--yes',
        '--json',
      ]));
      const payload = JSON.parse(result.output) as {
        readonly kind?: unknown;
        readonly daemonVersion?: unknown;
        readonly receipt?: {
          readonly connectedHostBaseUrl?: unknown;
          readonly daemonBaseUrl?: unknown;
          readonly failureKind?: unknown;
        };
      };

      expect(result.exitCode).toBe(1);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/automation/schedules',
        'http://127.0.0.1:3421/status',
      ]);
      expect(payload.kind).toBe('connected_host_route_unavailable');
      expect(Object.prototype.hasOwnProperty.call(payload as object, 'daemonVersion')).toBe(false);
      expect(payload.receipt?.connectedHostBaseUrl).toBe('http://127.0.0.1:3421');
      expect(payload.receipt?.failureKind).toBe('connected_host_route_unavailable');
      expect(Object.prototype.hasOwnProperty.call(payload.receipt as object, 'daemonBaseUrl')).toBe(false);
      expect(result.output).not.toContain('daemon_');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reads legacy daemon-named schedule receipts as connected-host receipts', async () => {
    const baseRuntime = runtime(['receipt', 'legacy-receipt']);
    const shellPaths = createShellPathService({
      workingDirectory: baseRuntime.workingDirectory,
      homeDirectory: baseRuntime.homeDirectory,
    });
    const receiptPath = routineScheduleReceiptStorePath(shellPaths);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      receipts: [
        {
          id: 'legacy-receipt',
          // Relative to now: the receipt store drops receipts older than 90 days.
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          routineId: 'daily-operations-sweep',
          routineName: 'Daily Operations Sweep',
          route: '/api/automation/schedules',
          method: 'automation.schedules.create',
          status: 'failed',
          daemonBaseUrl: 'http://127.0.0.1:3421',
          scheduleName: 'Agent routine: Daily Operations Sweep',
          scheduleKind: 'cron',
          scheduleValue: '0 8 * * *',
          enabled: true,
          target: { kind: 'main', surfaceKind: 'service' },
          failureKind: 'daemon_unavailable',
          failureError: 'connect failed',
        },
      ],
    }, null, 2)}\n`);

    const result = await handleRoutinesCommand(baseRuntime);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('connected host: http://127.0.0.1:3421');
    expect(result.output).toContain('failure: connected_host_unavailable');
    expect(result.output).not.toContain('runtime:');
  });

  test('rejects mixed delivery target kinds without calling the connected host', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return scheduleResponse();
    });

    try {
      const result = await handleRoutinesCommand(runtime([
        'promote',
        'daily-operations-sweep',
        '--cron',
        '0 8 * * *',
        '--delivery-channel',
        'slack',
        '--delivery-webhook',
        'https://hooks.example.test/routine',
        '--yes',
      ]));
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('Use one delivery target kind per routine promotion command.');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
