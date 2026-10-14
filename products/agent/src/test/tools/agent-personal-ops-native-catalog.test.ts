import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { contractMethodsForLane, contractMethodsForLanes } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { captureModelReadingInput } from '../../tools/agent-harness-model-reading-source.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function candidate(raw: unknown): { readonly name: string; readonly evidenceJson: string } {
  if (!raw || typeof raw !== 'object' || !('candidate' in raw)) throw new Error('Expected named catalog request');
  const value = raw.candidate;
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
    || !('evidenceJson' in value) || typeof value.evidenceJson !== 'string') throw new Error('Expected complete candidate evidence');
  return { name: value.name, evidenceJson: value.evidenceJson };
}

describe('Personal Ops complete native catalog batching', () => {
  test('reads every real native method once with complete schemas exceeding aggregate and individual source limits', async () => {
    const native = getOperatorContract().operator.methods;
    expect(JSON.stringify(native).length).toBeGreaterThan(1_000_000);
    const expected = new Map(native.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
    expect(Math.max(...[...expected.values()].map(value => value.length))).toBeGreaterThan(40_000);
    const seen = new Map<string, number>();
    const target = native[0]!;
    const fake = fakePort((name, _question, raw) => {
      expect(name).toBe('match');
      const value = candidate(raw);
      expect(value.evidenceJson).toBe(expected.get(value.name)!);
      seen.set(value.name, (seen.get(value.name) ?? 0) + 1);
      // This authored transport control proves mapping, not live lane semantics.
      return noulAnswer(value.name === target.id ? 0.99 : 0.01);
    });
    installJudgmentPort(fake.port);
    const retained: Array<() => void> = [];
    expect(await contractMethodsForLane('inbox', { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { retained.push(guard); } }))
      .toEqual(target.invokable === false ? { available: [], unavailable: [target.id] } : { available: [target.id], unavailable: [] });
    expect(seen.size).toBe(expected.size);
    expect([...seen.values()].every(count => count === 1)).toBe(true);
    expect(fake.requests.every(request => request.context?.battery === 'agent.personal-ops.lane-member')).toBe(true);
    for (const guard of retained) guard();
    expect(Object.isFrozen(target)).toBe(true);
    expect(() => Object.defineProperty(target, 'description', { value: 'Changed after completed source cleanup' })).toThrow();
    expect(() => retained.forEach(guard => guard())).not.toThrow();
  }, 60_000);

  test('rejects insertion of a private native method value before source admission or canonical requests', () => {
    const target = getOperatorContract().operator.methods[0]!;
    const descriptor = Object.getOwnPropertyDescriptor(target, 'description')!;
    const secret = 'synthetic-private-native-contract-marker';
    const fake = fakePort(() => { throw new Error('Private method reached canonical port'); });
    installJudgmentPort(fake.port);
    expect(() => Object.defineProperty(target, 'description', { ...descriptor, value: secret })).toThrow();
    expect(target.description).not.toBe(secret);
    expect(fake.requests).toHaveLength(0);
  });

  test('a native schema write attempted during a later batch is rejected before publication', async () => {
    const target = getOperatorContract().operator.methods[0]!;
    const descriptor = Object.getOwnPropertyDescriptor(target, 'inputSchema')!;
    let count = 0;
    const fake = fakePort((name) => {
      expect(name).toBe('match');
      if (++count >= 17) Object.defineProperty(target, 'inputSchema', { ...descriptor, value: { type: 'object', description: 'Changed earlier batch schema' } });
      return noulAnswer(0.01);
    });
    installJudgmentPort(fake.port);
    await expect(contractMethodsForLane('tasks', { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    expect(count).toBeGreaterThanOrEqual(17);
    expect(count).toBeLessThanOrEqual(32);
    expect(target.inputSchema).toBe(descriptor.value);
  });

  test('rejects installation of a hidden native schema accessor before invoking it or making a request', () => {
    const target = getOperatorContract().operator.methods[0]!;
    let getterCalls = 0;
    const fake = fakePort(() => { throw new Error('Accessor source reached port'); });
    installJudgmentPort(fake.port);
    expect(() => Object.defineProperty(target, 'syntheticHiddenSchema', { configurable: true, get() { getterCalls++; return 'private'; } })).toThrow();
    expect(getterCalls).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('rejects native array accessor installation before any method can be borrowed through it', () => {
    const native = getOperatorContract().operator.methods;
    const descriptor = Object.getOwnPropertyDescriptor(native, '0')!;
    let getterCalls = 0;
    const fake = fakePort(() => { throw new Error('Accessor array reached port'); });
    installJudgmentPort(fake.port);
    expect(() => Object.defineProperty(native, '0', { configurable: true, enumerable: true, get() { getterCalls++; return descriptor.value; } })).toThrow();
    expect(getterCalls).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('cancellation in a noncooperative later response prevents further routes and publication', async () => {
    const controller = new AbortController(); let count = 0;
    const fake = fakePort(name => {
      expect(name).toBe('match');
      if (++count === 17) controller.abort();
      return noulAnswer(0.99);
    });
    installJudgmentPort({ model: fake.port.model, async ask(request) {
      const response = await fake.port.ask(request);
      await Promise.resolve();
      return response;
    } });
    await expect(contractMethodsForLane('calendar', { sourceOwner: ordinaryResearchOwner(), signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true); expect(count).toBe(17);
  });

  test('all four native predicates complete before the parent receives one full catalog guard', async () => {
    const native = getOperatorContract().operator.methods;
    const seen = new Map<string, Set<string>>(); let count = 0, sourceRegisteredAt = -1, wholeGuardCalls = 0;
    const guards = new Map<string | (() => void), () => void>();
    const fake = fakePort((name, _question, raw) => {
      expect(name).toBe('match');
      if (!raw || typeof raw !== 'object' || !('query' in raw) || typeof raw.query !== 'string') throw new Error('Expected native lane query');
      const ids = seen.get(raw.query) ?? new Set<string>();
      const value = candidate(raw); expect(ids.has(value.name)).toBe(false); ids.add(value.name); seen.set(raw.query, ids); count++;
      return noulAnswer(0.01);
    });
    installJudgmentPort(fake.port);
    expect(await contractMethodsForLanes({ sourceOwner: ordinaryResearchOwner(),
      assertCurrent() { for (const guard of guards.values()) guard(); },
      retainCurrent(guard, key) {
        if (key === 'personal-ops-contract-source') {
          sourceRegisteredAt = count;
          guards.set(key, () => { wholeGuardCalls++; guard(); });
        } else if (!guards.has(key ?? guard)) guards.set(key ?? guard, guard);
      },
    })).toEqual({ inbox: { available: [], unavailable: [] }, calendar: { available: [], unavailable: [] },
      tasks: { available: [], unavailable: [] }, reminders: { available: [], unavailable: [] } });
    expect([...seen.keys()]).toEqual(['inbox', 'calendar', 'tasks', 'reminders']);
    expect([...seen.values()].every(ids => ids.size === native.length)).toBe(true);
    expect(count).toBe(4 * native.length); expect(sourceRegisteredAt).toBe(count); expect(wholeGuardCalls).toBeLessThanOrEqual(2);
    for (const guard of guards.values()) guard();
  }, 60_000);

  test('a later lane holds when a write to a previously read native schema is attempted', async () => {
    const native = getOperatorContract().operator.methods;
    const target = native.at(-1)!;
    const descriptor = Object.getOwnPropertyDescriptor(target, 'inputSchema')!;
    let count = 0, changed = false;
    const fake = fakePort((name, _question, raw) => {
      expect(name).toBe('match'); count++;
      if (!raw || typeof raw !== 'object' || !('query' in raw)) throw new Error('Expected native lane query');
      if (raw.query === 'calendar') {
        changed = true;
        Object.defineProperty(target, 'inputSchema', { ...descriptor, value: { description: 'Changed previously read complete schema' } });
      }
      return noulAnswer(0.01);
    });
    installJudgmentPort(fake.port);
    await expect(contractMethodsForLanes({ sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    expect(changed).toBe(true); expect(count).toBeGreaterThan(native.length); expect(count).toBeLessThanOrEqual(native.length + 16);
    expect(target.inputSchema).toBe(descriptor.value);
  }, 60_000);
});
