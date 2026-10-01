import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { Tool, ToolExecuteOptions } from '../sdk/src/platform/types/tools.ts';
import { installAgentToolPolicyGuard } from '../sdk/src/platform/gate/policy/index.ts';
import { forgetReadSecrets, readTouchesSecrets } from '../sdk/src/platform/permissions/credential-read-defaults.ts';

const readings = () => fakePort((name, question) => {
  if (name === 'hazard') return choiceAnswer(question, 'none', 0.99);
  if (name === 'secrets') return noulAnswer(0.01);
  throw new Error(`Unscripted policy reading: ${name}`);
});
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { forgetReadSecrets(); previous = installJudgmentPort(readings().port); });
afterEach(() => { forgetReadSecrets(); installJudgmentPort(previous); });

function tool(name: string, execute: Tool['execute']): Tool {
  return { definition: { name, description: name, parameters: { type: 'object', properties: {} } }, execute };
}
function registryWith(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  if (!tools.some((entry) => entry.definition.name === 'agent')) registry.register(tool('agent', async () => ({ success: true })));
  for (const entry of tools) registry.register(entry);
  installAgentToolPolicyGuard(registry);
  return registry;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation did not settle the policy call')), 500);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>?]> = [
  ['agent', { mode: 'list' }], ['exec', { commands: [] }], ['remote', { mode: 'pools' }],
  ['channel', { mode: 'accounts' }], ['mcp', { mode: 'servers' }], ['state', { mode: 'get' }],
  ['inspect', { mode: 'project' }], ['analyze', { mode: 'impact' }], ['registry', { mode: 'search' }],
  ['read', { files: [{ path: 'ordinary.md' }] }], ['goodvibes_settings', { mode: 'set', key: 'display.theme', value: 'system' }],
  ['control', { mode: 'commands' }], ['task', { mode: 'list' }], ['team', { mode: 'list' }],
  ['worklist', { mode: 'list' }], ['packet', { mode: 'list' }], ['query', { mode: 'list' }],
  ['fetch', { urls: [] }, { urls: [], parallel: false }],
  ['find', { queries: [] }, { queries: [], parallel: false }],
  ['web_search', { query: 'fixture' }, { query: 'fixture', safeSearch: 'moderate' }],
];

describe('composed Agent policy execution options', () => {
  for (const [name, args, normalized] of cases) test(`${name} retains options identity and its documented argument handling`, async () => {
    let receivedArgs: unknown;
    let receivedOptions: ToolExecuteOptions | undefined;
    const registry = registryWith([tool(name, async (input, options) => { receivedArgs = input; receivedOptions = options; return { success: true }; })]);
    const options = { signal: new AbortController().signal };
    expect((await registry.execute('call', name, args, options)).success).toBe(true);
    expect(receivedOptions).toBe(options);
    if (normalized) expect(receivedArgs).toEqual(normalized);
    else expect(receivedArgs).toBe(args);
  });

  for (const name of ['exec', 'mcp']) test(`${name} receives an abort while its executor is pending`, async () => {
    const entered = deferred<void>();
    const registry = registryWith([tool(name, async (_args, options) => {
      expect(options?.signal).toBe(controller.signal);
      entered.resolve();
      return new Promise((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    })]);
    const controller = new AbortController();
    const result = registry.execute('cancel', name, name === 'exec' ? { commands: [] } : { mode: 'servers' }, { signal: controller.signal });
    const settled = result.then(() => null, (error: unknown) => error);
    await entered.promise;
    controller.abort(new Error('owner cancelled'));
    expect(await within(settled)).toMatchObject({ message: 'owner cancelled' });
  });

  test('an already-aborted call never starts validation or the tool', async () => {
    const fake = readings();
    installJudgmentPort(fake.port);
    let calls = 0;
    const registry = registryWith([tool('read', async () => { calls++; return { success: true }; })]);
    const controller = new AbortController(); controller.abort(new Error('already cancelled'));
    // The registry now observes cancellation before argument repair begins;
    // it exposes the typed judgment cancellation, never the caller's reason.
    await expect(registry.execute('cancel', 'read', { files: [{ path: 'not-read.md' }] }, { signal: controller.signal })).rejects.toMatchObject({
      message: 'the judgment call was cancelled', cause: { name: 'JudgmentError', kind: 'aborted' },
    });
    expect(calls).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('pending policy judgment cancellation', () => {
  for (const name of ['read', 'goodvibes_settings']) test(`${name} forwards the signal to judgment and discards a late allow`, async () => {
    const started = deferred<AbortSignal | undefined>();
    const release = deferred<void>();
    const base = readings();
    const port: JudgmentPort = { model: base.port.model, async ask(request) {
      started.resolve(request.signal);
      await release.promise;
      return base.port.ask(request);
    } };
    installJudgmentPort(port);
    let calls = 0;
    const registry = registryWith([tool(name, async () => { calls++; return { success: true }; })]);
    const controller = new AbortController();
    const args = name === 'read' ? { files: [{ path: 'pending.md' }] } : { mode: 'set', key: 'display.theme', value: 'system' };
    const result = registry.execute('pending', name, args, { signal: controller.signal });
    const settled = result.then(() => null, (error: unknown) => error);
    expect(await started.promise).toBe(controller.signal);
    controller.abort(new Error('cancelled during judgment'));
    expect(await within(settled)).toMatchObject({ message: 'cancelled during judgment' });
    release.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
  });

  test('an aborted secret reading cannot overwrite an active caller’s cached result', async () => {
    const started = deferred<void>(); const release = deferred<void>();
    const no = fakePort(() => noulAnswer(0.01)); const yes = fakePort(() => noulAnswer(0.99));
    let calls = 0;
    installJudgmentPort({ model: no.port.model, async ask(request) {
      calls++;
      if (calls === 1) { started.resolve(); await release.promise; return no.port.ask(request); }
      return yes.port.ask(request);
    } });
    const controller = new AbortController();
    const args = { path: 'concurrent-secret-read' };
    const first = readTouchesSecrets('read', args, undefined, controller.signal);
    const settled = first.then(() => null, (error: unknown) => error);
    await started.promise;
    controller.abort(new Error('old read cancelled'));
    expect(await within(settled)).toMatchObject({ message: 'old read cancelled' });
    expect(await readTouchesSecrets('read', args)).toBe(true);
    release.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await readTouchesSecrets('read', args)).toBe(true);
    expect(calls).toBe(2);
  });
});
