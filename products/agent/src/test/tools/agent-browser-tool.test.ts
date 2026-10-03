import { describe, expect, test } from 'bun:test';
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
