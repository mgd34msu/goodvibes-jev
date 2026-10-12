import { afterEach, describe, expect, test } from 'bun:test';
import { createToolRegistryDouble } from '../helpers/tool-registry-double.ts';
import type { BrowserEngine } from '@goodvibes-jev/engine/sdk/platform/browser';
import { BrowserSessionError } from '@goodvibes-jev/engine/sdk/platform/browser';
import {
  BROWSER_TOOL_ACTIONS,
  BROWSER_TOOL_READ_ONLY_ACTIONS,
  createAgentBrowserTool,
  registerAgentBrowserTool,
} from '../../tools/agent-browser-tool.ts';

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function fakeEngine(calls: RecordedCall[], overrides: Record<string, unknown> = {}): BrowserEngine {
  const record = (method: string) => async (...args: unknown[]): Promise<Record<string, unknown>> => {
    calls.push({ method, args });
    return { method };
  };
  return {
    status: record('status'),
    provision: record('provision'),
    launch: record('launch'),
    attach: record('attach'),
    release: (sessionId: string) => {
      calls.push({ method: 'release', args: [sessionId] });
      return { method: 'release' };
    },
    close: record('close'),
    navigate: record('navigate'),
    snapshot: record('snapshot'),
    click: record('click'),
    type: record('type'),
    select: record('select'),
    press: record('press'),
    scroll: record('scroll'),
    waitFor: record('waitFor'),
    readText: record('readText'),
    screenshot: record('screenshot'),
    tabs: record('tabs'),
    newTab: record('newTab'),
    switchTab: (target: unknown, args: unknown) => {
      calls.push({ method: 'switchTab', args: [target, args] });
      return { method: 'switchTab' };
    },
    closeTab: record('closeTab'),
    goBack: record('goBack'),
    goForward: record('goForward'),
    extract: record('extract'),
    shutdown: record('shutdown'),
    ...overrides,
  } as unknown as BrowserEngine;
}

describe('browser tool surface', () => {
  test('registers once under the name a model can find', () => {
    const registry = createToolRegistryDouble();
    registerAgentBrowserTool(registry);
    registerAgentBrowserTool(registry);
    expect(registry.has('browser')).toBe(true);
    expect(registry.getToolDefinitions().filter((definition) => definition.name === 'browser')).toHaveLength(1);
  });

  test('the schema advertises every action the tool implements', () => {
    const tool = createAgentBrowserTool({ engine: fakeEngine([]) });
    const properties = tool.definition.parameters.properties as Record<string, { enum?: string[] }>;
    expect(properties.action?.enum).toEqual([...BROWSER_TOOL_ACTIONS]);
    expect(tool.definition.parameters.required).toEqual(['action']);
  });

  test('the description says what the tool does in plain words', () => {
    const tool = createAgentBrowserTool({ engine: fakeEngine([]) });
    expect(tool.definition.description.toLowerCase()).toContain('browser');
    expect(tool.definition.description).not.toContain('MCP');
  });

  test('actions route to the matching engine operation', async () => {
    const calls: RecordedCall[] = [];
    const tool = createAgentBrowserTool({ engine: fakeEngine(calls) });
    await tool.execute({ action: 'navigate', url: 'https://example.com' });
    await tool.execute({ action: 'snapshot' });
    await tool.execute({ action: 'click', ref: 'e1' });
    await tool.execute({ action: 'read_text' });
    expect(calls.map((entry) => entry.method)).toEqual(['navigate', 'snapshot', 'click', 'readText']);
  });

  test('a hyphenated action name is accepted as the underscored one', async () => {
    const calls: RecordedCall[] = [];
    const tool = createAgentBrowserTool({ engine: fakeEngine(calls) });
    await tool.execute({ action: 'read-text' });
    expect(calls[0]?.method).toBe('readText');
  });

  test('launch arguments ride along on the first navigate', async () => {
    const calls: RecordedCall[] = [];
    const tool = createAgentBrowserTool({ engine: fakeEngine(calls) });
    await tool.execute({ action: 'navigate', url: 'https://example.com', headless: true, profileName: 'work' });
    const args = calls[0]?.args[1] as { launch?: { headless?: boolean; profileName?: string } };
    expect(args.launch).toEqual({ profileName: 'work', headless: true });
  });

  test('input actions require a ref, so nothing can be typed at a guess', async () => {
    const calls: RecordedCall[] = [];
    const tool = createAgentBrowserTool({ engine: fakeEngine(calls) });
    for (const action of ['click', 'type', 'select', 'press']) {
      const result = await tool.execute({ action, text: 'hello', key: 'Enter' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('needs ref');
    }
    expect(calls).toEqual([]);
  });

  test('an unknown action lists the ones that exist', async () => {
    const tool = createAgentBrowserTool({ engine: fakeEngine([]) });
    const result = await tool.execute({ action: 'teleport' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('navigate');
  });

  test('a missing action is a plain instruction, not a crash', async () => {
    const tool = createAgentBrowserTool({ engine: fakeEngine([]) });
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('needs an action');
  });

  test('an engine refusal is returned with its fix attached', async () => {
    const tool = createAgentBrowserTool({
      engine: fakeEngine([], {
        close: async () => {
          throw new BrowserSessionError('Session b1 is an attached browser.', 'Use action:"release" instead.');
        },
      }),
    });
    const result = await tool.execute({ action: 'close', sessionId: 'b1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('attached browser');
    expect(result.error).toContain('release');
  });

  test('an unexpected failure is reported instead of thrown', async () => {
    const tool = createAgentBrowserTool({
      engine: fakeEngine([], {
        snapshot: async () => {
          throw new Error('page crashed');
        },
      }),
    });
    const result = await tool.execute({ action: 'snapshot' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('page crashed');
  });

  test('read-only actions are the observation ones only', () => {
    expect([...BROWSER_TOOL_READ_ONLY_ACTIONS].sort()).toEqual(['read_text', 'snapshot', 'status', 'tabs']);
    for (const action of BROWSER_TOOL_READ_ONLY_ACTIONS) {
      expect(BROWSER_TOOL_ACTIONS).toContain(action);
    }
  });

  test('registering the tool never starts a browser', async () => {
    const registry = createToolRegistryDouble();
    registerAgentBrowserTool(registry, { screenshotDirectory: '/tmp/does-not-matter' });
    // Nothing above may touch the filesystem or the network; the engine is
    // built on the first call that needs it.
    expect(registry.has('browser')).toBe(true);
  });

  test('attach with no cdpEndpoint says the owner\'s regular browser cannot supply one, instead of just asking for the parameter', async () => {
    const calls: RecordedCall[] = [];
    const tool = createAgentBrowserTool({ engine: fakeEngine(calls) });
    const result = await tool.execute({ action: 'attach' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('regular already-running browser');
    expect(result.error).toContain('remote-debugging-port');
    // Points at the actual sanctioned path instead of leaving a dead end.
    expect(result.error).toContain('action:"launch"');
    expect(calls).toEqual([]);
  });

  test('attach with a real cdpEndpoint still reaches the engine', async () => {
    const calls: RecordedCall[] = [];
    const tool = createAgentBrowserTool({ engine: fakeEngine(calls) });
    const result = await tool.execute({ action: 'attach', cdpEndpoint: 'http://127.0.0.1:9222' });
    expect(result.success).toBe(true);
    expect(calls.map((entry) => entry.method)).toEqual(['attach']);
  });
});


import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DEFAULT_CONFIG } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { Tool, ToolExecuteOptions } from '@goodvibes-jev/engine/sdk/platform/types';

const admissionCleanup: (() => void)[] = [];
afterEach(() => { for (const close of admissionCleanup.splice(0).reverse()) close(); });
function admittedBrowser(tool: Tool) {
  const permissions: typeof DEFAULT_CONFIG.permissions = { ...DEFAULT_CONFIG.permissions, mode: 'prompt' };
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory: '/native-browser-test' }),
    getSnapshot: () => ({ permissions }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/native-browser-test',
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
  registry.register(tool);
  const synthetic = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type === 'choice') {
      const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (!label || !Object.hasOwn(question.criteria, label)) throw new Error('Unexpected native browser admission question');
      return choiceAnswer(question, label, 0.999);
    }
    throw new Error('Unexpected native browser admission question');
  });
  const log = new SqliteDecisionLog(':memory:');
  const previous = installJudgmentPort(withDecisionLog(synthetic.port, log));
  admissionCleanup.push(() => { installJudgmentPort(previous); log[Symbol.dispose](); });
  return async (args: Record<string, unknown>, options: ToolExecuteOptions = {}) => {
    const call = await registry.prepareCall('native-browser-operation', 'browser', args, { signal: options.signal });
    const admission = await manager.admitAutonomous(call.callId, call.name, call.args, {
      sourceOf: () => ({ goal: 'Check browser caller lifetime with synthetic admission', criteria: ['No external page effects'] }),
      signal: options.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    return registry.executePrepared(call, admission, options);
  };
}
function actionLifetime(value: unknown) {
  if (!value || typeof value !== 'object' || !('signal' in value) || !(value.signal instanceof AbortSignal)
    || !('assertCurrent' in value) || typeof value.assertCurrent !== 'function') throw new Error('Missing original browser action lifetime');
  return { signal: value.signal, assertCurrent: value.assertCurrent };
}

describe('registered browser caller lifetime', () => {
  test.each(['click', 'type', 'select', 'press'])('actual admission forwards the original caller to %s', async action => {
    const calls: RecordedCall[] = [], controller = new AbortController(); let checks = 0;
    const engine = fakeEngine(calls, { [action]: async (_target: unknown, _args: unknown, options: unknown) => {
      const owner = actionLifetime(options); expect(owner.signal).toBe(controller.signal); owner.assertCurrent();
      calls.push({ method: action, args: [] }); return { observed: true };
    } });
    const run = admittedBrowser(createAgentBrowserTool({ engine }));
    const result = await run({ action, ref: 'e1', text: 'ordinary text', key: 'Tab', values: ['one'] }, { signal: controller.signal, assertCurrent: () => { checks++; } });
    expect(result.success).toBe(true); expect(calls).toHaveLength(1); expect(checks).toBeGreaterThan(0);
  });
  test('already cancelled caller never reaches an interactive method', async () => {
    const calls: RecordedCall[] = [], controller = new AbortController(); controller.abort();
    const run = admittedBrowser(createAgentBrowserTool({ engine: fakeEngine(calls) }));
    await expect(run({ action: 'click', ref: 'e1' }, { signal: controller.signal })).rejects.toThrow(); expect(calls).toEqual([]);
  });
  test.each(['cancel', 'retire', 'method'])('%s while an interactive call waits cannot publish success', async kind => {
    let release: () => void = () => {}, began: () => void = () => {}, active = true, getters = 0;
    const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
    const controller = new AbortController(), calls: RecordedCall[] = [];
    const engine = fakeEngine(calls, { click: async (_target: unknown, _args: unknown, options: unknown) => {
      const owner = actionLifetime(options); owner.assertCurrent(); began(); await pending; owner.assertCurrent(); return { clicked: true };
    } });
    const tool = createAgentBrowserTool({ engine });
    const run = admittedBrowser(tool);
    const result = run({ action: 'click', ref: 'e1' }, { signal: controller.signal, assertCurrent: () => { if (!active) throw new Error('Retired fixture owner'); } }).catch(error => error);
    try {
      await started;
      if (kind === 'cancel') controller.abort(new Error('private cancellation fixture'));
      if (kind === 'retire') active = false;
      if (kind === 'method') Object.defineProperty(engine, 'click', { configurable: true, get() { getters++; throw new Error('Replacement getter'); } });
      release(); const outcome: unknown = await result;
      expect(outcome instanceof Error || Boolean(outcome && typeof outcome === 'object' && 'success' in outcome && outcome.success === false)).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain('private cancellation fixture'); expect(getters).toBe(0); expect(calls).toEqual([]);
    } finally { release(); await result; }
  });
});
