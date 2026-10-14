import { ContractError } from '@goodvibes-jev/engine/errors';

const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const clone = globalThis.structuredClone;

interface SourceNode {
  readonly source: object;
  readonly parent: object | null;
  readonly slots: ReadonlyMap<PropertyKey, PropertyDescriptor>;
}

function sourceNode(source: object): SourceNode {
  const slots = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of ownKeys(source)) {
    const slot = descriptor(source, key);
    if (!slot) throw new ContractError('Contract schema source changed while being captured.');
    slots.set(key, slot);
  }
  return { source, parent: prototype(source), slots };
}

function unchanged(node: SourceNode): boolean {
  if (prototype(node.source) !== node.parent) return false;
  const keys = ownKeys(node.source);
  if (keys.length !== node.slots.size) return false;
  let index = 0;
  for (const [key, original] of node.slots) {
    if (keys[index++] !== key) return false;
    const current = descriptor(node.source, key);
    if (!current || current.enumerable !== original.enumerable || current.configurable !== original.configurable
      || current.writable !== original.writable || current.get !== original.get || current.set !== original.set
      || !Object.is(current.value, original.value)) return false;
  }
  return true;
}

// Plain schemas use these native prototypes. Retain their slots too, so a late
// inherited schema field cannot affect the detached validator.
const nativeParents = [sourceNode(Object.prototype), sourceNode(Array.prototype)];

/** Retain the exact data graph, including native recursive schemas and aliases. */
export function retainJsonSchemaSource<T>(source: T): { readonly snapshot: T; readonly assertCurrent: () => void } {
  const nodes: SourceNode[] = [];
  const copies = new Map<object, object>();
  const assertCurrent = () => {
    if (nativeParents.some(node => !unchanged(node)) || nodes.some(node => !unchanged(node))) {
      throw new ContractError('Contract schema validation source changed while reading.');
    }
  };
  const capture = (value: unknown): unknown => {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value !== 'object') throw new ContractError('Contract schema source must contain native JSON data.');
    const existing = copies.get(value);
    if (existing) return existing;
    const node = sourceNode(value);
    const isArray = Array.isArray(value);
    if (isArray ? node.parent !== Array.prototype : node.parent !== Object.prototype && node.parent !== null) {
      throw new ContractError('Contract schema source must contain plain objects and native arrays.');
    }
    const copy: object = isArray ? [] : Object.create(node.parent);
    copies.set(value, copy);
    nodes.push(node);
    for (const [key, slot] of node.slots) {
      if (typeof key !== 'string' || !Object.hasOwn(slot, 'value')) {
        throw new ContractError('Contract schema source cannot contain symbols or accessors.');
      }
      Object.defineProperty(copy, key, { ...slot, value: capture(slot.value) });
    }
    return copy;
  };
  if (nativeParents.some(node => !unchanged(node))) throw new ContractError('Contract schema native prototype changed.');
  const snapshot = capture(source) as T;
  assertCurrent();
  // Browsers have no portable proxy predicate. Native cloning rejects proxies;
  // descriptors above reject plain accessors before cloning can invoke them.
  // Include every retained node as a root, so non-enumerable descendants are
  // qualified too. One clone preserves its native visited set across aliases
  // and cycles instead of repeatedly cloning overlapping subgraphs. No await or
  // user callback occurs inside the native clone; fence the complete graph on
  // either side, rather than rescanning it once per node.
  try { clone(nodes.map(node => node.source)); }
  catch { throw new ContractError('Contract schema source cannot contain proxies or non-native data.'); }
  assertCurrent();
  return Object.freeze({ snapshot, assertCurrent });
}
