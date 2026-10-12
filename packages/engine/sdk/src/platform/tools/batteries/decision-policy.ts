/** Native definitions and the callables that actually closed over them. */
export interface NativeDecisionPolicy {
  readonly definition: object;
  readonly assertCurrent: () => void;
}

/** Capture immediately after construction, before publishing the decision.
 * The original descriptors stay private; later readers cannot substitute a
 * deep-equal public definition for the objects used by the actual callable. */
export function captureNativeDecisionPolicy(definition: object, decision: object): NativeDecisionPolicy {
  const checks: Array<() => void> = [], seen = new Set<object>();
  const capture = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
    const fields = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError('Native decision definitions require data descriptors.');
      return { key, descriptor };
    });
    checks.push(() => {
      const currentKeys = Reflect.ownKeys(value);
      if (Object.getPrototypeOf(value) !== prototype || currentKeys.length !== keys.length
        || keys.some((key, index) => key !== currentKeys[index])) throw new Error('Native decision policy changed.');
      for (const { key, descriptor: original } of fields) {
        const current = Object.getOwnPropertyDescriptor(value, key);
        if (!current || !('value' in current) || current.value !== original.value
          || current.enumerable !== original.enumerable || current.configurable !== original.configurable
          || current.writable !== original.writable) throw new Error('Native decision policy changed.');
      }
    });
    for (const { descriptor } of fields) capture(descriptor.value);
  };
  capture(definition); capture(decision);
  const assertCurrent = () => { for (const check of checks) check(); };
  assertCurrent();
  return Object.freeze({ definition, assertCurrent });
}
