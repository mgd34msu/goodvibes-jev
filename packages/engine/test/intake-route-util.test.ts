import { expect, test } from 'bun:test';
import { resolveRouteId } from '../sdk/src/platform/intake/providers/route-util.js';
import type { AdapterContext } from '../sdk/src/platform/intake/provider-adapter.js';

function context(resolveRouteId?: AdapterContext['resolveRouteId']) {
  const warnings: unknown[] = [];
  const ctx: AdapterContext = {
    credentials: { resolveRef: async () => null, resolveConfigSecret: async () => null },
    logger: { info() {}, warn(message, meta) { warnings.push({ message, meta }); }, error() {} },
    ...(resolveRouteId ? { resolveRouteId } : {}),
  };
  return { ctx, warnings };
}

test('optional intake routing leaves the item unbound', async () => {
  expect(await resolveRouteId(context().ctx, 'email', 'digest', 'dm')).toBeUndefined();
});
test('routes the exact provider, sender digest and structured kind', async () => {
  const inputs: unknown[] = [];
  const { ctx } = context(input => { inputs.push(input); return 'owner-profile'; });
  expect(await resolveRouteId(ctx, 'slack', 'digest', 'mention')).toBe('owner-profile');
  expect(inputs).toEqual([{ provider: 'slack', fromDigest: 'digest', kind: 'mention' }]);
});
test('a failed optional resolver reports a warning and leaves the poll usable', async () => {
  const { ctx, warnings } = context(async () => { throw new Error('fixture failure'); });
  expect(await resolveRouteId(ctx, 'email', 'digest', 'dm')).toBeUndefined();
  expect(warnings).toHaveLength(1);
});
test('a failed logger cannot make optional routing reject the provider poll', async () => {
  const { ctx } = context(() => { throw new Error('fixture resolver failure'); });
  const throwing: AdapterContext = { ...ctx, logger: { ...ctx.logger, warn() { throw new Error('fixture reporting failure'); } } };
  expect(await resolveRouteId(throwing, 'email', 'digest', 'dm')).toBeUndefined();
});
