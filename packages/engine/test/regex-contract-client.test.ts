import { createPeerRemoteClient } from '../peer-sdk/src/client-core.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { getOperatorContract, getPeerContract } from '@goodvibes-jev/engine/contracts';
import { installJudgmentPort, type ContractRegexReadingFactory } from '@goodvibes-jev/engine/errors';
import { readYesNo, STAKES_BANDS } from '@goodvibes-jev/judgment/decisions';
import { createOperatorRemoteClient } from '../operator-sdk/src/client-core.ts';
import { createHttpTransport } from '../transport-http/src/http.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function fixture(getRegexReading?: ContractRegexReadingFactory) {
  const base = getOperatorContract();
  const selected = base.operator.methods.find(method => method.http?.method === 'GET' && !/[:{]/.test(method.http.path))!;
  const outputSchema = { type: 'string', pattern: '^ok$' };
  const method = { ...selected, outputSchema };
  const contract = { ...base, operator: { ...base.operator, methods: [method] } };
  const fetch = Object.assign(async () => Response.json('ok'), { preconnect() {} }) as typeof globalThis.fetch;
  const transport = createHttpTransport({ baseUrl: 'https://fixture.invalid', fetch });
  const client = createOperatorRemoteClient(transport, contract, { getRegexReading });
  return { client, method, outputSchema };
}

test('actual operator invocation binds browser capability to method, exact schema, source, flags and request signal', async () => {
  const owner = new AbortController();
  const request = new AbortController();
  let calls = 0;
  const f = fixture(context => {
    expect(context.kind).toBe('operator');
    expect(context.methodId).toBe(f.method.id);
    expect(context.outputSchema).toEqual(f.outputSchema);
    expect(context.signal).toBe(request.signal);
    return { signal: owner.signal, assertCurrent: context.assertCurrent, async read(source, flags, cap, signal) {
      calls++;
      context.assertCurrent(); expect(signal.aborted).toBe(false);
      expect([source, flags, cap]).toEqual(['^ok$', '', 50_000]);
      return readYesNo({ type: 'noul', noul: 0.001 }, STAKES_BANDS.high.yesNo);
    } };
  });
  expect(await f.client.invoke<string>(f.method.id, {}, { signal: request.signal })).toBe('ok');
  expect(calls).toBe(1);
  owner.abort();
  await expect(f.client.invoke(f.method.id, {}, { signal: request.signal })).rejects.toThrow();
});

test('the operator client holds unavailable and stale browser schema authority', async () => {
  const unavailable = fixture();
  await expect(unavailable.client.invoke(unavailable.method.id)).rejects.toThrow();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const owner = new AbortController();
  const f = fixture(context => ({ signal: owner.signal, assertCurrent: context.assertCurrent, async read() {
    entered.resolve(); await release.promise;
    return readYesNo({ type: 'noul', noul: 0.001 }, STAKES_BANDS.high.yesNo);
  } }));
  const pending = f.client.invoke(f.method.id);
  await entered.promise;
  f.outputSchema.pattern = '^other$'; release.resolve();
  await expect(pending).rejects.toThrow('changed');
});

test('cancelling the actual invoke interrupts a noncooperating injected reader', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const f = fixture(context => ({ signal: controller.signal, assertCurrent: context.assertCurrent, async read() {
    entered.resolve(); await release.promise;
    return readYesNo({ type: 'noul', noul: 0.001 }, STAKES_BANDS.high.yesNo);
  } }));
  const pending = f.client.invoke(f.method.id, {}, { signal: controller.signal });
  await entered.promise; controller.abort();
  await expect(pending).rejects.toThrow();
  release.resolve();
});


test('the actual peer invocation uses its own method/schema-bound capability', async () => {
  const base = getPeerContract();
  const selected = base.endpoints.find(endpoint => endpoint.method === 'GET' && !/[:{]/.test(endpoint.path))!;
  const endpoint = { ...selected, outputSchema: { type: 'string', pattern: '^peer$' } };
  const owner = new AbortController();
  const fetch = Object.assign(async () => Response.json('peer'), { preconnect() {} }) as typeof globalThis.fetch;
  const transport = createHttpTransport({ baseUrl: 'https://fixture.invalid', fetch });
  let read = 0;
  const client = createPeerRemoteClient(transport, { ...base, endpoints: [endpoint] }, { getRegexReading(context) {
    expect(context.kind).toBe('peer'); expect(context.methodId).toBe(endpoint.id); expect(context.outputSchema).toEqual(endpoint.outputSchema);
    return { signal: owner.signal, assertCurrent: context.assertCurrent, async read(source, flags, cap) {
      read++; expect([source, flags, cap]).toEqual(['^peer$', '', 50_000]);
      return readYesNo({ type: 'noul', noul: 0.001 }, STAKES_BANDS.high.yesNo);
    } };
  } });
  expect(await client.invoke<string>(endpoint.id)).toBe('peer'); expect(read).toBe(1);
  owner.abort(); await expect(client.invoke(endpoint.id)).rejects.toThrow();
});
