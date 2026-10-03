import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import {
  AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES,
  AGENT_READ_ONLY_TOOL_MODES,
  validateAgentToolInvocationForAgentPolicy,
} from '../../tools/agent-tool-policy-guard.ts';
import { operatorMethodCatalogStatus } from '../../tools/agent-harness-operator-methods.ts';
import { createAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('Agent user-first autonomy policy', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeRuntimeServices() {
    root = makeProjectTempDir('gv-agent-policy');
    return createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager: new ConfigManager({
        surfaceRoot: 'agent',
        workingDir: root,
        homeDir: root,
        configDir: join(root, '.goodvibes', 'agent'),
      }),
      workingDir: root,
      homeDirectory: root,
      getConversationTitle: () => 'Agent policy test',
    });
  }

  test('model tool policy allows visible agent orchestration and local implementation tools', () => {
    expect(AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES).toEqual([]);
    expect(AGENT_READ_ONLY_TOOL_MODES).toContain('spawn');
    expect(AGENT_READ_ONLY_TOOL_MODES).toContain('batch-spawn');
    expect(AGENT_READ_ONLY_TOOL_MODES).toContain('cancel');
    expect(AGENT_READ_ONLY_TOOL_MODES).toContain('message');
    expect(AGENT_READ_ONLY_TOOL_MODES).toContain('wait');
    expect(validateAgentToolInvocationForAgentPolicy({ mode: 'spawn' })).toBeNull();
    expect(validateAgentToolInvocationForAgentPolicy({ mode: 'cancel' })).toBeNull();
  });

  test('a continuation arriving from the connected host spawns a visible tracked agent', async () => {
    // The same guarantee, one layer out: a continuation for a session THIS
    // process hosts must reach the loop and become a tracked agent run. It
    // arrives from `sessions.inputs.list` on the adopted daemon, not a
    // register this process wrote into itself, so the wire is what this
    // drives.
    const services = makeRuntimeServices();
    const sessionId = 'session-agent-policy';
    services.hostedSessions.adopt(sessionId);

    const delivered: Array<{ sessionId: string; inputId: string; consumed: boolean | undefined; agentId: string | undefined }> = [];
    let served = false;
    services.sessionBroker.activate({
      async listInputs(id) {
        // One queued `submit`, then nothing: `deliver` is the real
        // de-duplication in production, and this mirrors it so a second poll
        // cannot double-spawn.
        if (id !== sessionId || served) return { inputs: [] };
        served = true;
        return {
          inputs: [{
            id: 'input-1',
            sessionId,
            intent: 'submit',
            body: 'Build the thing',
            state: 'queued',
            createdAt: Date.now(),
          }] as never,
        };
      },
      async deliverInput(id, inputId, options) {
        delivered.push({ sessionId: id, inputId, consumed: options?.consumed, agentId: options?.agentId });
        return {};
      },
    });

    // The composed dispatch polls on its own interval, so this waits for the
    // OUTCOME rather than sleeping a fixed span past it, a bounded wait that
    // fails with a real assertion instead of timing out.
    const deadline = Date.now() + 8_000;
    while (delivered.length === 0 && Date.now() < deadline) await Bun.sleep(50);

    const spawned = services.agentManager.list().find((record) => record.task.includes('Build the thing'));
    expect(spawned).toBeTruthy();
    expect(spawned!.id).toMatch(/^agent-/);
    // Collected, and the run that will answer it is named. The naming is not
    // bookkeeping: it is the reply binding, and it is what lets an answer
    // produced HERE reach a conversation that arrived over a channel.
    //
    // The dispatcher's own tick drains the session AND reports finished
    // answers in the same pass (session-dispatch.js's `tick`), so a run fast
    // enough to reach a terminal state before that pass ends is acknowledged
    // twice on one poll: once on dispatch (`consumed: undefined`, binding the
    // reply) and once on completion (`consumed: true`, carrying the answer).
    // Locally the run is not usually done yet when this happens; how quickly
    // it finishes is a race, not a contract, so this asserts the one
    // guarantee this test is actually for, the dispatch-time delivery that
    // binds the reply, by membership rather than requiring the array to
    // stop at exactly one entry.
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    for (const entry of delivered) {
      expect(entry.sessionId).toBe(sessionId);
      expect(entry.inputId).toBe('input-1');
    }
    const dispatchDelivery = delivered.find((entry) => entry.consumed === undefined);
    expect(dispatchDelivery).toEqual({ sessionId, inputId: 'input-1', consumed: undefined, agentId: spawned!.id });
    services.dispose();
  }, 10_000);

  test('operator method catalog exposes the GoodVibes daemon contract dynamically', () => {
    const status = operatorMethodCatalogStatus() as {
      readonly methods: number;
      readonly readOnlyMethods: number;
      readonly confirmedMethods: number;
      readonly adminMethods: number;
      readonly categories: Record<string, number>;
      readonly policy: string;
    };

    expect(status.methods).toBeGreaterThanOrEqual(200);
    expect(status.readOnlyMethods).toBeGreaterThan(0);
    expect(status.confirmedMethods).toBeGreaterThan(0);
    expect(status.adminMethods).toBeGreaterThan(0);
    expect(status.categories.automation).toBeGreaterThan(0);
    expect(status.categories.knowledge).toBeGreaterThan(0);
    expect(status.policy).toContain('agent_operator_method');
  });

  test('generic operator method bridge previews and confirmation-gates write routes', async () => {
    // Not migrated to makeProjectTempDir: `root` is empty for this specific
    // test (makeRuntimeServices() is never called here), so `tmpdir()` is
    // genuinely reached, but every call below is dryRun:true or a write
    // route that stops at "confirmationRequired" before executing, so
    // nothing is ever written under this homeDirectory.
    const tool = createAgentOperatorMethodTool(
      { homeDirectory: root || tmpdir() } as never,
      {} as never,
    );

    const readPreview = await tool.execute({
      methodId: 'services.status',
      dryRun: true,
    });
    expect(readPreview.success).toBe(true);
    expect(readPreview.output).toContain('"methodId": "services.status"');
    expect(readPreview.output).toContain('"confirmationRequired": false');
    expect(readPreview.output).toContain('"expectedOutcome"');
    expect(readPreview.output).toContain('"installed"');

    const writePreview = await tool.execute({
      methodId: 'automation.jobs.create',
      input: { prompt: 'Summarize my inbox every morning.' },
    });
    expect(writePreview.success).toBe(false);
    expect(writePreview.error).toContain('"confirm": true');
    expect(writePreview.error).toContain('"confirmationRequired": true');

    const watcherPreview = await tool.execute({
      methodId: 'watchers.create',
      input: { label: 'Billing webhook triage', kind: 'webhook' },
      dryRun: true,
    });
    expect(watcherPreview.success).toBe(true);
    expect(watcherPreview.output).toContain('"expectedOutcome"');
    expect(watcherPreview.output).toContain('"created-visible-watcher"');
  });

  test('generic operator method bridge certifies service repair receipts', async () => {
    root = makeProjectTempDir('gv-agent-policy');
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'service-repair-token' }));

    const originalFetch = globalThis.fetch;
    const requests: Array<{ readonly url: string; readonly method: string; readonly authorization: string | null }> = [];
    globalThis.fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        authorization: init?.headers instanceof Headers
          ? init.headers.get('authorization')
          : (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
      });
      return new Response(JSON.stringify({
        platform: 'linux',
        path: join(tmpdir(), 'goodvibes.service'),
        installed: true,
        autostart: true,
        running: true,
        pid: 1234,
        commandPreview: 'goodvibes service start',
        suggestedCommands: [],
        lastAction: 'start',
        network: {
          controlPlane: { ready: true },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    try {
      const tool = createAgentOperatorMethodTool(
        { homeDirectory: root } as never,
        {
          get: (key: string) => key === 'controlPlane.port'
            ? 3429
            : key === 'controlPlane.host'
              ? '127.0.0.1'
              : undefined,
        },
      );
      const result = await tool.execute({
        methodId: 'services.start',
        confirm: true,
        explicitUserRequest: 'Start the GoodVibes service.',
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      const output = JSON.parse(result.output!) as {
        readonly body: { readonly running: boolean };
        readonly outcome: {
          readonly status: string;
          readonly certified: boolean;
          readonly evidence: { readonly running: boolean; readonly actionError: string | null };
          readonly expectedOutcome: { readonly target: string; readonly verificationRoute: string };
        };
      };
      expect(requests[0]).toEqual({
        url: 'http://127.0.0.1:3429/api/service/start',
        method: 'POST',
        authorization: 'Bearer service-repair-token',
      });
      expect(output.body.running).toBe(true);
      expect(output.outcome.status).toBe('certified');
      expect(output.outcome.certified).toBe(true);
      expect(output.outcome.evidence).toMatchObject({ running: true, actionError: null });
      expect(output.outcome.expectedOutcome.target).toBe('running-service');
      expect(output.outcome.expectedOutcome.verificationRoute).toContain('services.status');
      expect(result.output).not.toContain('service-repair-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('generic operator method bridge recommends service lifecycle actions from status receipts', async () => {
    root = makeProjectTempDir('gv-agent-policy');
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'service-status-token' }));

    const receipts = [
      { installed: false, autostart: false, running: false, network: { controlPlane: { ready: false } } },
      { installed: true, autostart: true, running: false, network: { controlPlane: { ready: false } } },
      { installed: true, autostart: true, running: true, network: { controlPlane: { ready: false } } },
      { installed: true, autostart: true, running: true, network: { controlPlane: { ready: true } } },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => {
      const receipt = receipts.shift();
      if (!receipt) throw new Error('No queued service receipt.');
      return new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    try {
      const tool = createAgentOperatorMethodTool(
        { homeDirectory: root } as never,
        {
          get: (key: string) => key === 'controlPlane.port'
            ? 3429
            : key === 'controlPlane.host'
              ? '127.0.0.1'
              : undefined,
        },
      );
      const decisions: Array<{
        readonly status: string;
        readonly action: string;
        readonly methodId?: string;
        readonly modelRoute: string;
      }> = [];
      for (let index = 0; index < 4; index += 1) {
        const result = await tool.execute({ methodId: 'services.status' });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(result.error);
        const output = JSON.parse(result.output!) as {
          readonly outcome: {
            readonly lifecycleDecision: {
              readonly status: string;
              readonly action: string;
              readonly methodId?: string;
              readonly modelRoute: string;
              readonly decisionRules: readonly string[];
            };
          };
        };
        expect(output.outcome.lifecycleDecision.decisionRules.join('\n')).toContain('installed:false');
        decisions.push(output.outcome.lifecycleDecision);
        expect(result.output).not.toContain('service-status-token');
      }
      expect(decisions.map((decision) => decision.action)).toEqual([
        'install-service',
        'start-service',
        'restart-service',
        'none',
      ]);
      expect(decisions[0]?.methodId).toBe('services.install');
      expect(decisions[0]?.modelRoute).toContain('services.install');
      expect(decisions[1]?.methodId).toBe('services.start');
      expect(decisions[2]?.methodId).toBe('services.restart');
      expect(decisions[3]?.status).toBe('no-action-needed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('generic operator method bridge certifies watcher receipts', async () => {
    root = makeProjectTempDir('gv-agent-policy');
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'watcher-receipt-token' }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({
      id: 'watcher-billing',
      kind: 'webhook',
      label: 'Billing webhook triage',
      state: 'active',
      source: {
        id: 'billing',
        kind: 'webhook',
        label: 'Billing webhook',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
      metadata: {},
      lastCheckpoint: 'created',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    try {
      const tool = createAgentOperatorMethodTool(
        { homeDirectory: root } as never,
        {
          get: (key: string) => key === 'controlPlane.port'
            ? 3429
            : key === 'controlPlane.host'
              ? '127.0.0.1'
              : undefined,
        },
      );
      const result = await tool.execute({
        methodId: 'watchers.create',
        input: { label: 'Billing webhook triage', kind: 'webhook' },
        confirm: true,
        explicitUserRequest: 'Create a billing webhook watcher.',
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      const output = JSON.parse(result.output!) as {
        readonly outcome: {
          readonly kind: string;
          readonly status: string;
          readonly certified: boolean;
          readonly evidence: { readonly id: string; readonly state: string; readonly sourceEnabled: boolean; readonly lastError: string | null };
          readonly expectedOutcome: { readonly target: string; readonly verificationRoute: string };
        };
      };
      expect(output.outcome.kind).toBe('watcher-receipt');
      expect(output.outcome.status).toBe('certified');
      expect(output.outcome.certified).toBe(true);
      expect(output.outcome.evidence).toMatchObject({
        id: 'watcher-billing',
        state: 'active',
        sourceEnabled: true,
        lastError: null,
      });
      expect(output.outcome.expectedOutcome.target).toBe('created-visible-watcher');
      expect(output.outcome.expectedOutcome.verificationRoute).toContain('watchers.list');
      expect(result.output).not.toContain('watcher-receipt-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
