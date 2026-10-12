import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';

/** A retired read cannot publish its original security catalog. */
export class SecurityReadSourceRetiredError extends Error {
  constructor() { super('Security read source retired'); this.name = 'SecurityReadSourceRetiredError'; }
}

export function assertSecurityReadSource(current: boolean): asserts current {
  if (!current) throw new SecurityReadSourceRetiredError();
}

/** Bind actual producer fields and methods without invoking accessors. */
export function captureSecurityReadBindings(owner: object, names: readonly string[]): () => void {
  assertSecurityReadSource(!nodeTypes.isProxy(owner));
  const prototype = Object.getPrototypeOf(owner);
  const ownKeys = Reflect.ownKeys(owner);
  for (const key of ownKeys) assertSecurityReadSource('value' in (Object.getOwnPropertyDescriptor(owner, key) ?? {}));
  const slots = names.map(name => {
    let holder: object | null = owner;
    let descriptor: PropertyDescriptor | undefined;
    while (holder) {
      assertSecurityReadSource(!nodeTypes.isProxy(holder));
      descriptor = Object.getOwnPropertyDescriptor(holder, name);
      if (descriptor) break;
      holder = Object.getPrototypeOf(holder);
    }
    assertSecurityReadSource(descriptor === undefined || 'value' in descriptor);
    return { name, holder, descriptor };
  });
  return () => {
    assertSecurityReadSource(Object.getPrototypeOf(owner) === prototype);
    const currentKeys = Reflect.ownKeys(owner);
    assertSecurityReadSource(currentKeys.length === ownKeys.length && currentKeys.every((key, index) => key === ownKeys[index]));
    for (const key of currentKeys) assertSecurityReadSource('value' in (Object.getOwnPropertyDescriptor(owner, key) ?? {}));
    for (const slot of slots) {
      let holder: object | null = owner;
      let descriptor: PropertyDescriptor | undefined;
      while (holder) {
        assertSecurityReadSource(!nodeTypes.isProxy(holder));
        descriptor = Object.getOwnPropertyDescriptor(holder, slot.name);
        if (descriptor) break;
        holder = Object.getPrototypeOf(holder);
      }
      assertSecurityReadSource(holder === slot.holder && (descriptor === undefined || 'value' in descriptor)
        && descriptor?.value === slot.descriptor?.value && descriptor?.writable === slot.descriptor?.writable
        && descriptor?.enumerable === slot.descriptor?.enumerable && descriptor?.configurable === slot.descriptor?.configurable);
    }
  };
}

interface SecurityDataSlot { readonly key: string; readonly value: unknown; readonly enumerable: boolean | undefined; readonly writable: boolean | undefined; readonly configurable: boolean | undefined }
interface SecurityDataObject { readonly owner: object; readonly prototype: unknown; readonly slots: readonly SecurityDataSlot[] }

/** Complete native DTO descriptor image, including hidden fields and named array metadata. */
function observeSecurityReadData(data: unknown) {
  const objects: SecurityDataObject[] = [], ancestors = new Set<object>();
  let nodes = 0, characters = 0;
  const visit = (value: unknown, depth: number): unknown => {
    assertSecurityReadSource(++nodes <= 100_000 && depth <= 64);
    if (typeof value === 'string') { characters += value.length; assertSecurityReadSource(characters <= 1_000_000); return value; }
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { assertSecurityReadSource(Number.isFinite(value)); return value; }
    assertSecurityReadSource(typeof value === 'object' && !nodeTypes.isProxy(value) && !ancestors.has(value));
    const prototype: unknown = Object.getPrototypeOf(value), array = Array.isArray(value);
    assertSecurityReadSource(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    const slots: SecurityDataSlot[] = [];
    const version: unknown[] = [];
    ancestors.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        assertSecurityReadSource(typeof key === 'string');
        characters += key.length; assertSecurityReadSource(characters <= 1_000_000);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        assertSecurityReadSource(descriptor !== undefined && 'value' in descriptor);
        slots.push({ key, value: descriptor.value, enumerable: descriptor.enumerable, writable: descriptor.writable, configurable: descriptor.configurable });
        version.push([key, descriptor.enumerable, descriptor.writable, descriptor.configurable, visit(descriptor.value, depth + 1)]);
      }
    } finally { ancestors.delete(value); }
    objects.push({ owner: value, prototype, slots });
    return { array, nullPrototype: prototype === null, version };
  };
  const version = visit(data, 0);
  const assertCurrent = () => {
    for (const object of objects) {
      assertSecurityReadSource(Object.getPrototypeOf(object.owner) === object.prototype);
      const keys = Reflect.ownKeys(object.owner);
      assertSecurityReadSource(keys.length === object.slots.length);
      object.slots.forEach((slot, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(object.owner, slot.key);
        assertSecurityReadSource(keys[index] === slot.key && descriptor !== undefined && 'value' in descriptor
          && Object.is(descriptor.value, slot.value) && descriptor.enumerable === slot.enumerable
          && descriptor.writable === slot.writable && descriptor.configurable === slot.configurable);
      });
    }
  };
  assertCurrent(); return { version, assertCurrent };
}

export function retainSecurityReadData(data: unknown): () => void {
  return observeSecurityReadData(data).assertCurrent;
}

/** Fresh DTO comparisons preserve every original data descriptor. */
export function captureSecurityReadData(read: () => unknown): () => void {
  const original = observeSecurityReadData(read());
  return () => {
    original.assertCurrent();
    assertSecurityReadSource(isDeepStrictEqual(original.version, observeSecurityReadData(read()).version));
  };
}

export function retainSecurityReadMap<K, V>(map: Map<K, V>): () => void {
  assertSecurityReadSource(!nodeTypes.isProxy(map) && Object.getPrototypeOf(map) === Map.prototype && Reflect.ownKeys(map).length === 0);
  const binding = captureSecurityReadBindings(map, ['entries']);
  const entries = [...map.entries()];
  const dataCurrent = retainSecurityReadData(entries);
  return () => {
    binding(); dataCurrent();
    assertSecurityReadSource(Object.getPrototypeOf(map) === Map.prototype && Reflect.ownKeys(map).length === 0);
    const current = [...map.entries()];
    assertSecurityReadSource(current.length === entries.length && current.every((entry, index) => {
      const original = entries[index];
      return original !== undefined && Object.is(entry[0], original[0]) && Object.is(entry[1], original[1]);
    }));
  };
}

/** Observe manifests plus native inode clocks; missing paths retain their nearest existing parent. */
function observeSecurityReadFile(path: string): unknown {
  try {
    const link = lstatSync(path, { bigint: true }), resolved = realpathSync(path);
    const stat = statSync(path, { bigint: true });
    const bytes = stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
    const after = statSync(path, { bigint: true }), afterLink = lstatSync(path, { bigint: true });
    assertSecurityReadSource(stat.dev === after.dev && stat.ino === after.ino && stat.size === after.size
      && stat.mode === after.mode && stat.mtimeNs === after.mtimeNs && stat.ctimeNs === after.ctimeNs
      && link.dev === afterLink.dev && link.ino === afterLink.ino && link.size === afterLink.size
      && link.mode === afterLink.mode && link.mtimeNs === afterLink.mtimeNs && link.ctimeNs === afterLink.ctimeNs
      && resolved === realpathSync(path));
    return { path, resolved, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), bytes,
      link: { dev: String(link.dev), ino: String(link.ino), mode: String(link.mode), mtime: String(link.mtimeNs), ctime: String(link.ctimeNs) } };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      const parent = dirname(path);
      assertSecurityReadSource(parent !== path);
      return { path, absent: true, parent: observeSecurityReadFile(parent) };
    }
    throw new SecurityReadSourceRetiredError();
  }
}

export function captureSecurityReadFiles(paths: readonly string[]): () => void {
  return captureSecurityReadData(() => paths.map(observeSecurityReadFile));
}

export function captureSecurityPluginFiles(roots: readonly string[]): () => void {
  const read = () => roots.map(root => {
    const rootImage = observeSecurityReadFile(root);
    let entries: string[];
    try { entries = readdirSync(root).sort(); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') entries = [];
      else throw new SecurityReadSourceRetiredError();
    }
    return { root: rootImage, entries: entries.map(entry => {
      const path = join(root, entry);
      return { entry, path: observeSecurityReadFile(path), manifest: statSync(path).isDirectory() ? observeSecurityReadFile(join(path, 'manifest.json')) : null };
    }) };
  });
  return captureSecurityReadData(read);
}
