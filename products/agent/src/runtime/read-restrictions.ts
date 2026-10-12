import { types as nodeTypes } from 'node:util';

const observePromiseRejection = Promise.prototype.then;

function retired(): never { throw new Error('Native read restrictions changed.'); }

/** Restriction-only binding of the actual callback receiver and data slots. */
export function captureNativeReadBindings(owner: object): () => void {
  if (nodeTypes.isProxy(owner)) retired();
  const chain: object[] = [];
  const slots: { readonly holder: object; readonly key: PropertyKey; readonly descriptor: PropertyDescriptor }[] = [];
  let current: object | null = owner;
  while (current && current !== Object.prototype) {
    if (nodeTypes.isProxy(current)) retired();
    chain.push(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) retired();
      slots.push({ holder: current, key, descriptor });
    }
    current = Object.getPrototypeOf(current);
  }
  const terminal = current;
  return () => {
    for (let index = 0; index < chain.length; index++) {
      const holder = chain[index];
      if (!holder || Object.getPrototypeOf(holder) !== (chain[index + 1] ?? terminal)) retired();
      const expected = slots.filter(slot => slot.holder === holder), keys = Reflect.ownKeys(holder);
      if (keys.length !== expected.length || keys.some((key, slotIndex) => key !== expected[slotIndex]?.key)) retired();
    }
    for (const slot of slots) {
      const descriptor = Object.getOwnPropertyDescriptor(slot.holder, slot.key);
      if (!descriptor || !('value' in descriptor) || !Object.is(descriptor.value, slot.descriptor.value)
        || descriptor.enumerable !== slot.descriptor.enumerable || descriptor.configurable !== slot.descriptor.configurable
        || descriptor.writable !== slot.descriptor.writable) retired();
    }
  };
}

export function captureNativeReadRestrictions(options: {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}): () => void {
  const bindings = captureNativeReadBindings(options);
  const signal = options.signal, current = options.assertCurrent;
  if (current && nodeTypes.isProxy(current)) retired();
  return () => {
    bindings(); signal?.throwIfAborted();
    const result: unknown = current?.();
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) Reflect.apply(observePromiseRejection, result, [undefined, () => {}]);
      throw new Error('Native read currentness must be synchronous.');
    }
    bindings(); signal?.throwIfAborted();
  };
}
