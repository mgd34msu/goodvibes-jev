import { expect, test } from 'bun:test';
import { deferred, externalProtocolFixture } from '../helpers/external-protocol-fixture.js';

test('daemon readiness consumes boot config generation before the first admitted MCP write', async () => {
  // A long real watch interval makes the next polling boundary explicit, not
  // dependent on how quickly this machine builds the product graph.
  const f = await externalProtocolFixture({ watchIntervalMs: 60_000 });
  const entered = deferred(), release = deferred();
  f.onReading(async reading => { if ('disposition' in reading.questions) { entered.resolve(); await release.promise; } });
  const pending = f.call().then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    f.daemon.services.configManager.flushConfigFileChanges();
    release.resolve();
    expect(await pending).toMatchObject({ value: { done: true } });
    expect(f.calls).toHaveLength(1);
    expect(f.human).not.toHaveBeenCalled();
  } finally { release.resolve(); await pending; await f.close(); }
});
