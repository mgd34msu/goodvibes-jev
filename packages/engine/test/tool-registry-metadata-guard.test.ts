import { expect, test } from 'bun:test';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { ToolInputProjector } from '../sdk/src/platform/tools/input-projection.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';

const NAME = 'registry_metadata_guard_fixture';

function fixture() {
  const nested = { state: 'original', optional: undefined };
  const hidden = { nested };
  // This complete subtree already exists at acquisition, but JSON omits it.
  Object.defineProperty(hidden, 'cycle', { value: hidden, configurable: true });
  const parameters = { type: 'object', properties: { value: { type: 'string', enum: ['alpha', 'beta'] } }, required: ['value'] };
  const counts = { capture: 0, owner: 0, result: 0, body: 0, reads: 0, releases: 0 };
  const controls = { capture() {}, owner() {}, result() {} };
  const tool: Tool = {
    definition: { name: NAME, description: 'In-memory native metadata guard fixture.', parameters },
    async execute() { counts.body++; return { success: true }; },
  };
  Object.defineProperty(tool.definition, 'hidden', { value: hidden, configurable: true });
  const caller = new AbortController();
  const projector: ToolInputProjector = {
    assertCurrent() { counts.owner++; controls.owner(); },
    async project(request) {
      request.assertCurrent();
      return { status: 'projected', args: { value: 'alpha' },
        assertCurrent() { counts.result++; controls.result(); },
        async release() { counts.releases++; } };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool, { inputProjection: projector });
  const reader = fakePort(() => { counts.reads++; throw new Error('Unexpected metadata fixture judgment'); });
  const options = { signal: caller.signal, port: reader.port, assertCurrent() { counts.capture++; controls.capture(); } };
  return { tool, hidden, nested, parameters, counts, controls, registry, options, caller,
    async project() { return registry.projectCall('metadata-fixture', NAME, { value: 'alpha' }, options); } };
}

function nativeDescriptors<T>(targets: ReadonlySet<object>, run: () => T) {
  const originalMaps = Object.getOwnPropertyDescriptors;
  const originalSlot = Object.getOwnPropertyDescriptor;
  const mapDescriptor = originalSlot(Object, 'getOwnPropertyDescriptors');
  if (!mapDescriptor) throw new Error('Missing native descriptor method');
  const counts = { maps: 0 };
  Object.defineProperty(Object, 'getOwnPropertyDescriptors', { ...mapDescriptor, value: function <V>(value: V) {
    if (value && typeof value === 'object' && targets.has(value)) counts.maps++;
    return originalMaps(value);
  } });
  try { return { result: run(), counts }; }
  finally {
    Object.defineProperty(Object, 'getOwnPropertyDescriptors', mapDescriptor);
  }
}

test('unchanged registry observations use one fresh complete descriptor pass without descriptor maps', async () => {
  const f = fixture();
  const projected = await f.project();
  const targets = new Set<object>([f.tool.definition, f.parameters, f.parameters.properties, f.parameters.properties.value,
    f.parameters.properties.value.enum, f.parameters.required, f.hidden, f.nested]);
  const before = { ...f.counts };
  const observed = nativeDescriptors(targets, () => {
    for (let index = 0; index < 4; index++) f.registry.assertProjectedSnapshot(projected);
  });
  expect(observed.counts.maps).toBe(0);
  expect(f.counts).toEqual(before);
  await f.registry.releaseProjected(projected);
});

test.each(['accessor', 'proxy'] as const)('an acquired hidden descendant refuses a later %s without invoking it', async kind => {
  const f = fixture();
  const projected = await f.project();
  const prepared = await f.registry.prepareCall('metadata-fixture', NAME, projected.args, f.options);
  let traps = 0;
  if (kind === 'accessor') Object.defineProperty(f.nested, 'state', { get() { traps++; return 'original'; }, configurable: true });
  else Object.defineProperty(f.hidden, 'nested', { value: new Proxy({}, {
    get() { traps++; throw new Error('Unexpected proxy invocation'); },
    ownKeys() { traps++; throw new Error('Unexpected proxy invocation'); },
    getPrototypeOf() { traps++; throw new Error('Unexpected proxy invocation'); },
    getOwnPropertyDescriptor() { traps++; throw new Error('Unexpected proxy invocation'); },
  }), writable: true, enumerable: true, configurable: true });
  const before = { ...f.counts };
  expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
  expect(() => f.registry.assertProjected(projected)).toThrow();
  expect(() => f.registry.assertPrepared(prepared)).toThrow();
  let claims = 0;
  await expect(f.registry.executePrepared(prepared, () => { claims++; })).rejects.toThrow();
  expect(traps).toBe(0);
  expect(claims).toBe(0);
  expect(f.counts).toMatchObject({ capture: before.capture, owner: before.owner, result: before.result, body: 0, reads: 0 });
});

test.each(['hidden-value', 'hidden-undefined', 'hidden-prototype', 'flags', 'key-order', 'equal-root'] as const)(
  'a %s change uses the original full canonical fallback without rebasing', async change => {
    const f = fixture();
    const projected = await f.project();
    if (change === 'hidden-value') f.nested.state = 'replacement';
    if (change === 'hidden-undefined') Reflect.deleteProperty(f.nested, 'optional');
    if (change === 'hidden-prototype') Object.setPrototypeOf(f.nested, { additional: 'unconsumed' });
    if (change === 'flags') Object.defineProperty(f.nested, 'state', { writable: false });
    if (change === 'key-order') { Reflect.deleteProperty(f.nested, 'state'); Object.defineProperty(f.nested, 'state', { value: 'original', writable: true, enumerable: true, configurable: true }); }
    if (change === 'equal-root') f.tool.definition = { name: NAME, description: f.tool.definition.description,
      parameters: { type: 'object', properties: { value: { type: 'string', enum: ['alpha', 'beta'] } }, required: ['value'] } };
    const targets = new Set<object>([f.tool.definition]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const observed = nativeDescriptors(targets, () => f.registry.assertProjectedSnapshot(projected));
      expect(observed.counts.maps).toBeGreaterThan(0);
      expect(projected.schemaRevision).toBeDefined();
    }
    // A changed semantic value still compares against the initial definition.
    f.parameters.properties.value.enum[0] = 'changed';
    if (change === 'equal-root') Object.defineProperty(f.tool.definition, 'description', { value: 'Changed semantic definition', enumerable: true });
    expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
    expect(f.counts).toMatchObject({ body: 0, reads: 0 });
    await f.registry.releaseProjected(projected);
  },
);

test.each(['capture', 'owner', 'result'] as const)('a %s callback still retires acquired hidden metadata before dispatch', async callback => {
  const f = fixture();
  const projected = await f.project();
  let getters = 0;
  f.controls[callback] = () => { Object.defineProperty(f.nested, 'state', { get() { getters++; return 'original'; }, configurable: true }); };
  expect(() => f.registry.assertProjected(projected)).toThrow();
  expect(getters).toBe(0);
  expect(f.counts).toMatchObject({ body: 0, reads: 0 });
  await f.registry.releaseProjected(projected);
});

test('observed semantic mutation refuses, exact restoration keeps the original baseline, and executor identity stays live', async () => {
  const f = fixture();
  const projected = await f.project();
  f.parameters.properties.value.enum[0] = 'changed';
  expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
  f.parameters.properties.value.enum[0] = 'alpha';
  f.registry.assertProjectedSnapshot(projected);
  const before = { ...f.counts };
  f.registry.assertProjected(projected);
  expect(f.counts.capture).toBe(before.capture + 1);
  expect(f.counts.owner).toBe(before.owner + 1);
  expect(f.counts.result).toBe(before.result + 1);
  f.tool.execute = async () => ({ success: true });
  expect(() => f.registry.assertProjectedSnapshot(projected)).toThrow();
  await f.registry.releaseProjected(projected);
});
