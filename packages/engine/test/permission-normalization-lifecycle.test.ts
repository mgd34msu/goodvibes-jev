import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createJudgmentSourceLifetime } from '../sdk/src/platform/runtime/judgment-source-lifetime.js';
import {
  brokerSandboxEscalation,
  resolveRuntimeSandboxPlan,
  type ExecSandboxRuntime,
} from '../sdk/src/platform/tools/exec/sandbox.js';
import {
  forgetCommandNeeds,
  readCommandNeeds,
} from '../sdk/src/platform/runtime/permissions/normalization/classifier.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); forgetCommandNeeds(); });
afterEach(() => { installJudgmentPort(previous); forgetCommandNeeds(); });

function heldReading() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.99));
  const records: string[] = [];
  let signal: AbortSignal | undefined;
  const port: JudgmentPort = {
    model: fake.port.model,
    async ask(request) {
      signal = request.signal;
      entered.resolve();
      try {
        await release.promise;
        return { ...await fake.port.ask(request), decisionId: 'fixture-reading' };
      } finally { finished.resolve(); }
    },
    recorder: { recordReadings() { records.push('readings'); }, recordAction() { records.push('action'); } },
  };
  return { port, entered, release, finished, records, get signal() { return signal; } };
}

async function promptly<T>(promise: Promise<T>): Promise<T | symbol> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<symbol>(resolve => {
      timer = setTimeout(() => resolve(Symbol('reader did not stop')), 250);
    })]);
  } finally { clearTimeout(timer); }
}

const sandbox: ExecSandboxRuntime = {
  featureEnabled: true,
  config: { enabled: true, egressAllowlist: [], workspaceWritable: [] },
  availability: { available: true, backend: 'bubblewrap', bwrapPath: '/fixture/bwrap', reason: 'fixture', networkIsolationGuaranteed: true },
};

describe('sandbox command reading lifetime', () => {
  test('a replacement port reads the same command again instead of inheriting host access', async () => {
    const before = fakePort(() => noulAnswer(0.01));
    const after = fakePort(() => noulAnswer(0.99));
    installJudgmentPort(before.port);
    const needs = await readCommandNeeds('fixture-command', '/fixture/workspace');
    expect(needs).toEqual({ needsNetwork: false, needsPrivilege: false });
    expect(await readCommandNeeds('fixture-command', '/fixture/workspace')).toBe(needs);
    installJudgmentPort(after.port);
    expect(await readCommandNeeds('fixture-command', '/fixture/workspace')).toEqual({ needsNetwork: true, needsPrivilege: true });
    expect(before.requests).toHaveLength(1);
    expect(after.requests).toHaveLength(1);
  });

  test('changed settings retire cached readings while the port object stays installed', async () => {
    const settings: Record<string, unknown> = { 'judgment.model': 'jev-1.13.0', 'judgment.endpoint': 'https://before.example.test' };
    let probability = 0.01;
    const fake = fakePort(() => noulAnswer(probability));
    const lifetime = createJudgmentSourceLifetime({ config: { get: key => settings[key] }, env: {}, secrets: {} });
    bindJudgmentPortAuthority(fake.port, lifetime.capture);
    installJudgmentPort(fake.port);
    try {
      expect(await readCommandNeeds('fixture-command', '/fixture/workspace')).toEqual({ needsNetwork: false, needsPrivilege: false });
      settings['judgment.endpoint'] = 'https://after.example.test';
      probability = 0.99;
      expect(await readCommandNeeds('fixture-command', '/fixture/workspace')).toEqual({ needsNetwork: true, needsPrivilege: true });
      expect(fake.requests).toHaveLength(2);
    } finally { lifetime.dispose(); }
  });

  test('workspace and command remain distinct even when either contains a separator', async () => {
    const fake = fakePort((_name, _question, state) => noulAnswer(typeof state === 'object' && state !== null && 'workspace' in state && state.workspace === 'workspace' ? 0.99 : 0.01));
    installJudgmentPort(fake.port);
    expect(await readCommandNeeds('suffix', 'workspace\u0000command')).toEqual({ needsNetwork: false, needsPrivilege: false });
    expect(await readCommandNeeds('command\u0000suffix', 'workspace')).toEqual({ needsNetwork: true, needsPrivilege: true });
    expect(fake.requests).toHaveLength(2);
  });

  test('restoring a previously installed port never restores its old cache', async () => {
    let probability = 0.01;
    const fake = fakePort(() => noulAnswer(probability));
    installJudgmentPort(fake.port);
    await readCommandNeeds('fixture-command');
    installJudgmentPort(undefined);
    await expect(readCommandNeeds('fixture-command')).rejects.toThrow('No judgment port');
    probability = 0.99;
    installJudgmentPort(fake.port);
    expect(await readCommandNeeds('fixture-command')).toEqual({ needsNetwork: true, needsPrivilege: true });
    expect(fake.requests).toHaveLength(2);
  });

  test('replacing the installed port ask method invalidates its cached observations', async () => {
    const before = fakePort(() => noulAnswer(0.01));
    const after = fakePort(() => noulAnswer(0.99));
    const port: JudgmentPort = { ...before.port };
    installJudgmentPort(port);
    await readCommandNeeds('fixture-command');
    port.ask = after.port.ask;
    expect(await readCommandNeeds('fixture-command')).toEqual({ needsNetwork: true, needsPrivilege: true });
    expect(after.requests).toHaveLength(1);
  });

  test('returned observations cannot be changed through a caller reference', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    installJudgmentPort(fake.port);
    const needs = await readCommandNeeds('fixture-command');
    expect(Object.isFrozen(needs)).toBe(true);
    expect(Reflect.set(needs, 'needsNetwork', false)).toBe(false);
    expect((await readCommandNeeds('fixture-command')).needsNetwork).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  test('a canceled caller cannot read or poison another operation cached observation', async () => {
    const fake = fakePort(() => noulAnswer(0.01));
    const canceled = new AbortController();
    installJudgmentPort(fake.port);
    const needs = await readCommandNeeds('fixture-command', undefined, { signal: canceled.signal });
    canceled.abort();
    await expect(readCommandNeeds('fixture-command', undefined, { signal: canceled.signal })).rejects.toThrow('no longer current');
    expect(await readCommandNeeds('fixture-command')).toBe(needs);
    expect(fake.requests).toHaveLength(1);
  });

  test('caller current checks also apply to cached observations', async () => {
    const fake = fakePort(() => noulAnswer(0.01));
    installJudgmentPort(fake.port);
    const needs = await readCommandNeeds('fixture-command');
    await expect(readCommandNeeds('fixture-command', undefined, { assertCurrent() { throw new Error('caller revoked'); } })).rejects.toThrow('no longer current');
    expect(await readCommandNeeds('fixture-command')).toBe(needs);
    expect(fake.requests).toHaveLength(1);
  });

  for (const stop of ['caller cancellation', 'port replacement', 'source revocation'] as const) {
    test(`${stop} interrupts an uncooperative reading and prevents late records or caching`, async () => {
      const held = heldReading();
      const canceled = new AbortController();
      const source = new AbortController();
      bindJudgmentPortAuthority(held.port, () => ({ identity: held, signal: source.signal, assertCurrent() { source.signal.throwIfAborted(); } }));
      installJudgmentPort(held.port);
      const pending = readCommandNeeds('fixture-command', undefined, { signal: canceled.signal }).then(() => null, error => error);
      try {
        await held.entered.promise;
        if (stop === 'caller cancellation') canceled.abort();
        else if (stop === 'port replacement') installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
        else source.abort();
        expect(await promptly(pending)).toBeInstanceOf(Error);
        expect(held.signal?.aborted).toBe(true);
        held.release.resolve();
        await held.finished.promise;
        expect(held.records).toEqual([]);
        const fresh = fakePort(() => noulAnswer(0.01));
        installJudgmentPort(fresh.port);
        expect(await readCommandNeeds('fixture-command')).toEqual({ needsNetwork: false, needsPrivilege: false });
        expect(fresh.requests).toHaveLength(1);
      } finally { held.release.resolve(); await pending; }
    });
  }

  test('revocation after a provider result prevents recording and cache publication', async () => {
    const held = heldReading();
    let current = true;
    installJudgmentPort(held.port);
    const pending = readCommandNeeds('fixture-command', undefined, { assertCurrent() { if (!current) throw new Error('operation changed'); } });
    const refused = pending.catch(error => error);
    await held.entered.promise;
    current = false;
    held.release.resolve();
    expect(await refused).toBeInstanceOf(Error);
    expect(held.records).toEqual([]);
    await readCommandNeeds('fixture-command');
    expect(held.records).toEqual(['readings', 'action']);
  });

  test('reentrant cancellation while recording an action cannot publish a cache entry', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    const canceled = new AbortController();
    let cancelAtRecord = true;
    const port: JudgmentPort = { ...fake.port,
      async ask(request) { return { ...await fake.port.ask(request), decisionId: 'fixture-reading' }; },
      recorder: { recordReadings() {}, recordAction() { if (cancelAtRecord) canceled.abort(); } },
    };
    installJudgmentPort(port);
    await expect(readCommandNeeds('fixture-command', undefined, { signal: canceled.signal })).rejects.toThrow('no longer current');
    cancelAtRecord = false;
    await readCommandNeeds('fixture-command');
    expect(fake.requests).toHaveLength(2);
  });

  test('runtime planning uses explicit egress policy without a command reading', async () => {
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const plan = await resolveRuntimeSandboxPlan(sandbox, 'fixture-command', '/fixture', '/fixture');
    expect(plan?.network).toBe('disabled'); expect(fake.requests).toHaveLength(0);
    const canceled = new AbortController(); canceled.abort(new Error('owner cancelled'));
    await expect(resolveRuntimeSandboxPlan(sandbox, 'fixture-command', '/fixture', '/fixture', { signal: canceled.signal })).rejects.toThrow('owner cancelled');
  });

  test('an explicitly installed escalation handler receives cancellation and cannot grant late', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const canceled = new AbortController();
    let received: AbortSignal | undefined;
    const configured: ExecSandboxRuntime = { ...sandbox, config: { ...sandbox.config, egressAllowlist: ['fixture-command'] },
      requestEscalation: async (_input, execution) => { received = execution?.signal; entered.resolve(); await release.promise; return true; } };
    const plan = await resolveRuntimeSandboxPlan(configured, 'fixture-command', '/fixture', '/fixture');
    const pending = brokerSandboxEscalation(configured, plan, 'fixture-command', '/fixture', { signal: canceled.signal, assertCurrent() {} });
    const observed = pending.catch(error => error);
    try {
      await entered.promise; expect(received).toBe(canceled.signal);
      canceled.abort(new Error('owner cancelled')); release.resolve();
      expect(await observed).toMatchObject({ message: 'owner cancelled' });
    } finally { release.resolve(); await observed; }
  });
});
