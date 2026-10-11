import { describe, expect, test } from 'bun:test';
import { getOperatorContract } from '../contracts/src/index.ts';
import { freezeGeneratedOperatorContract } from '../contracts/src/freeze-contract.ts';

describe('Generated operator contract ownership', () => {
  test('the actual generated public singleton retains its frozen ownership', () => {
    const contract = getOperatorContract();
    expect(getOperatorContract()).toBe(contract);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.operator)).toBe(true);
    expect(Object.isFrozen(contract.operator.methods)).toBe(true);
    expect(Object.isFrozen(contract.operator.events)).toBe(true);
    expect(Object.isFrozen(contract.auth.login.requestSchema)).toBe(true);
    for (const method of contract.operator.methods) {
      expect(Object.isFrozen(method)).toBe(true);
      if (method.inputSchema) expect(Object.isFrozen(method.inputSchema)).toBe(true);
      if (method.outputSchema) expect(Object.isFrozen(method.outputSchema)).toBe(true);
    }
    expect(Reflect.set(contract, 'version', contract.version + 1)).toBe(false);
  });

  test('freezes every complete producer-owned schema without changing its data', () => {
    const contract = structuredClone(getOperatorContract());
    const before = JSON.stringify(contract);
    expect(freezeGeneratedOperatorContract(contract)).toBe(contract);
    expect(JSON.stringify(contract)).toBe(before);
    const seen = new Set<object>();
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      expect(Object.isFrozen(value)).toBe(true);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const child: unknown = descriptor?.value;
        inspect(child);
      }
    };
    inspect(contract);
    expect(seen.size).toBeGreaterThan(10_000);
    expect(() => Object.defineProperty(contract.operator.methods[0]!, 'description', { value: 'replacement' })).toThrow();
    expect(() => Object.defineProperty(contract.operator.methods, '0', { value: null })).toThrow();
    expect(() => Object.defineProperty(contract.auth.login.requestSchema, 'hidden', { get: () => 'private' })).toThrow();
  });

  test('shared and cyclic producer-owned data is frozen once', () => {
    const contract = structuredClone(getOperatorContract());
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    metadata.contract = contract;
    Object.defineProperty(contract.operator.methods[0]!, 'metadata', { value: metadata, configurable: true });
    Object.defineProperty(contract.operator.methods[1]!, 'metadata', { value: metadata, configurable: true });
    expect(freezeGeneratedOperatorContract(contract)).toBe(contract);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(contract.operator.methods)).toBe(true);
    expect(() => Object.defineProperty(metadata, 'self', { value: null })).toThrow();
  });

  test('rejects accessors without invoking them or partially freezing a rejected graph', () => {
    const contract = structuredClone(getOperatorContract());
    let calls = 0;
    Object.defineProperty(contract.operator.methods[0]!, 'hidden', { configurable: true, get() { calls++; return 'private'; } });
    expect(() => freezeGeneratedOperatorContract(contract)).toThrow('data properties only');
    expect(calls).toBe(0);
    expect(Object.isFrozen(contract)).toBe(false);
    expect(Object.isFrozen(contract.product)).toBe(false);
  });

  test('rejects executable extension values without executing them', () => {
    const contract = structuredClone(getOperatorContract());
    let calls = 0;
    Object.defineProperty(contract.operator.methods[0]!, 'metadata', { value: { execute() { calls++; } }, configurable: true });
    expect(() => freezeGeneratedOperatorContract(contract)).toThrow('data only');
    expect(calls).toBe(0);
    expect(Object.isFrozen(contract)).toBe(false);
  });
});
