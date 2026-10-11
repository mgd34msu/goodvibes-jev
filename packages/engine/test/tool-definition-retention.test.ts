import { expect, test } from 'bun:test';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { ToolInputProjectionError, type ToolInputProjector } from '../sdk/src/platform/tools/input-projection.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';

async function fixture() {
  const field = { type: 'string' };
  const properties = { first: field, second: field };
  const hidden = { nested: { value: 'original' } };
  const counts = { bodies: 0, owners: 0, callers: 0, releases: 0 };
  const tool: Tool = {
    definition: { name: 'retained_definition', description: 'Bounded definition currentness fixture.',
      parameters: { type: 'object', properties } },
    async execute(_args, options) { options?.assertCurrent?.(); counts.bodies++; return { success: true, output: 'ran' }; },
  };
  Object.defineProperty(tool.definition, 'internal', { value: hidden });
  const projector: ToolInputProjector = {
    assertCurrent() { counts.owners++; },
    async project(request) { return { status: 'projected', args: request.args, async release() { counts.releases++; } }; },
  };
  const registry = new ToolRegistry();
  registry.register(tool, { inputProjection: projector });
  const controller = new AbortController();
  const projected = await registry.projectCall('retained', tool.definition.name, {}, {
    signal: controller.signal, assertCurrent() { counts.callers++; },
  });
  return { registry, tool, properties, field, hidden, counts, projector, controller, projected };
}

test('unchanged definition observations retain each original authority callback', async () => {
  const f = await fixture(); const before = { ...f.counts };
  for (let index = 0; index < 64; index++) f.registry.assertProjected(f.projected);
  expect(f.counts.owners - before.owners).toBe(64); expect(f.counts.callers - before.callers).toBe(64);
  const prepared = await f.registry.prepareCall('retained', f.tool.definition.name, f.projected.args);
  expect(await f.registry.executePrepared(prepared, () => {})).toMatchObject({ success: true });
  expect(f.counts.bodies).toBe(1); expect(f.counts.releases).toBe(1);
});

test.each(['definition replacement', 'alias replacement', 'descriptor change', 'ignored hidden value'] as const)(
  'canonical equality still permits %s without adopting a changed schema', async change => {
    const f = await fixture();
    if (change === 'definition replacement') f.tool.definition = structuredClone(f.tool.definition);
    if (change === 'alias replacement') f.properties.second = { type: 'string' };
    if (change === 'descriptor change') Object.defineProperty(f.field, 'type', { writable: false });
    if (change === 'ignored hidden value') f.hidden.nested.value = 'changed';
    f.registry.assertProjected(f.projected);
    const prepared = await f.registry.prepareCall('retained', f.tool.definition.name, f.projected.args);
    expect(prepared.schemaRevision).toBe(f.projected.schemaRevision);
    expect(await f.registry.executePrepared(prepared, () => {})).toMatchObject({ success: true });
    expect(f.counts.bodies).toBe(1); expect(f.counts.releases).toBe(1);
  },
);

test('equal definition replacement cannot refresh the original canonical baseline', async () => {
  const f = await fixture(); f.tool.definition = structuredClone(f.tool.definition);
  f.registry.assertProjected(f.projected);
  f.tool.definition.description = 'Changed definition';
  expect(() => f.registry.assertProjected(f.projected)).toThrow(ToolInputProjectionError);
  await expect(f.registry.prepareCall('retained', 'retained_definition', f.projected.args)).rejects.toThrow();
  expect(f.counts.bodies).toBe(0); expect(f.counts.releases).toBe(0);
  await f.registry.releaseProjected(f.projected); expect(f.counts.releases).toBe(1);
});

test.each(['visible getter', 'visible proxy', 'hidden nested getter', 'hidden nested proxy'] as const)(
  'original unchanged metadata slots cannot hide a later %s', async change => {
    const f = await fixture(); let traps = 0;
    const prepared = await f.registry.prepareCall('retained', f.tool.definition.name, f.projected.args);
    const getter = { get() { traps++; throw new Error('private-local-value'); }, enumerable: true };
    if (change === 'visible getter') Object.defineProperty(f.field, 'type', getter);
    if (change === 'visible proxy') f.properties.first = new Proxy(f.field, { ownKeys() { traps++; throw new Error('private-local-value'); } });
    if (change === 'hidden nested getter') Object.defineProperty(f.hidden.nested, 'value', getter);
    if (change === 'hidden nested proxy') f.hidden.nested = new Proxy(f.hidden.nested, { ownKeys() { traps++; throw new Error('private-local-value'); } });
    const callbacks = [f.counts.owners, f.counts.callers];
    expect(() => f.registry.assertPrepared(prepared)).toThrow();
    let claims = 0;
    await expect(f.registry.executePrepared(prepared, () => { claims++; })).rejects.toThrow();
    expect(traps).toBe(0); expect(claims).toBe(0); expect(f.counts.bodies).toBe(0);
    expect([f.counts.owners, f.counts.callers]).toEqual(callbacks); expect(f.counts.releases).toBe(1);
  },
);

test.each(['registration ABA', 'release', 'cancellation'] as const)(
  'unchanged schema currentness cannot retain authority after %s', async change => {
    const f = await fixture(); const prepared = await f.registry.prepareCall('retained', f.tool.definition.name, f.projected.args);
    if (change === 'registration ABA') { f.registry.unregister(f.tool.definition.name); f.registry.register(f.tool, { inputProjection: f.projector }); }
    if (change === 'release') await f.registry.releaseProjected(f.projected);
    if (change === 'cancellation') f.controller.abort();
    let claims = 0;
    await expect(f.registry.executePrepared(prepared, () => { claims++; })).rejects.toThrow();
    expect(claims).toBe(0); expect(f.counts.bodies).toBe(0); expect(f.counts.releases).toBe(1);
  },
);
