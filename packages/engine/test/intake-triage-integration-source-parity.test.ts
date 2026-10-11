/** Original integration assertions, using the real canonical catalog and account owner. */
import { expect, spyOn, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { aggregateInbox, normalizeInboxQuery } from '../sdk/src/platform/intake/aggregator.js';
import { registerTriagedInbox } from '../sdk/src/platform/intake/triage/owned.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

test('triaged registrar binds once, creates no triage IDs and leaves unrelated registration identity intact', async () => {
  const catalog = new GatewayMethodCatalog();
  const before = catalog.list();
  const register = spyOn(catalog, 'register');
  const owner = await registerTriagedInbox({ catalog, workingDirectory: makeProjectTempDir('triage-original-registration'),
    logger: { info() {}, warn() {}, error() {} } }, {
    providerId: 'fixture', accountScopeId: 'original-integration', skipInitialPoll: true,
    adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000,
      poll: async () => ({ items: [], configured: true, state: 'empty' as const }) }]]),
    acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() {} }),
  });
  try {
    await owner.ready;
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0].id).toBe('channels.inbox.list');
    expect(catalog.list()).toEqual(before);
    expect(catalog.list().filter(descriptor => descriptor.id.startsWith('inbox.triage'))).toEqual([]);

    const otherResult = { original: 'unrelated result' };
    const otherHandler = async () => otherResult;
    const descriptor = catalog.get('channels.routing.list');
    if (!descriptor) throw new Error('Canonical routing descriptor absent');
    const unregister = catalog.register(descriptor, otherHandler, { replace: true });
    try {
      expect(register.mock.calls[1]![1]).toBe(otherHandler);
      expect(await catalog.invoke(descriptor.id, { body: {}, context: {} })).toBe(otherResult);

      const read = await owner.acquireRead(true);
      let raw;
      try { raw = aggregateInbox(read.sources, normalizeInboxQuery({})); }
      finally { read.release(); }
      const wire = await catalog.invoke('channels.inbox.list', { body: {}, context: {} });
      expect(wire).toEqual(raw);
      expect(wire).toMatchObject({ items: [], total: 0, truncated: false, hasMore: false });

      await owner.close();
      expect(catalog.hasHandler('channels.inbox.list')).toBe(false);
      expect(await catalog.invoke(descriptor.id, { body: {}, context: {} })).toBe(otherResult);
    } finally { unregister(); }
  } finally { await owner.close(); register.mockRestore(); }
});
