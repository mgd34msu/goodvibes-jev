/** Authenticated REST cancellation is acknowledgement, never a drainage receipt. */
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { CONTRACTS_GET_OUTPUT_SCHEMA, CONTRACTS_LIST_OUTPUT_SCHEMA } from '../../sdk/src/platform/control-plane/operator-contract-schemas-contracts.js';
import { makeHarness, oneUnitPlan, startContract, waitFor } from './runner-support.js';
import { serveContractCancellation } from './cancellation-http-support.js';

const REASON = 'Cancelled by the user from WebUI.';
const PARTIAL = 'export const unfinishedParser = true;\n';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Export the exact response bytes, never rewritten synthetic record fields. */
function exportResponse(label: string, body: string) {
  const directory = process.env.GOODVIBES_TEST_CONTRACT_CANCELLATION_FIXTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${label}.json`), body);
}

type HttpFixture = ReturnType<typeof serveContractCancellation>;
async function request(fixture: HttpFixture, path: string, token: string | undefined, body?: unknown) {
  return fetch(`${fixture.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function inspect(fixture: HttpFixture, id: string, label: string) {
  const get = await request(fixture, `/api/contracts/${id}`, fixture.writer);
  const list = await request(fixture, '/api/contracts?includeTerminal=true', fixture.writer);
  expect(get.status).toBe(200); expect(list.status).toBe(200);
  const getBody = await get.text(), listBody = await list.text();
  const record: unknown = JSON.parse(getBody), collection: unknown = JSON.parse(listBody);
  expect(firstJsonSchemaFailure(CONTRACTS_GET_OUTPUT_SCHEMA, record)).toBeUndefined();
  expect(firstJsonSchemaFailure(CONTRACTS_LIST_OUTPUT_SCHEMA, collection)).toBeUndefined();
  expect(collection).toEqual({ contracts: [record] });
  exportResponse(`${label}-get`, getBody); exportResponse(`${label}-list`, listBody);
  return record as OperatorMethodOutput<'contracts.get'>;
}
async function cancel(fixture: HttpFixture, id: string, token: string | undefined) {
  // Use the same generated route binding as the production browser facade.
  const route = WEBUI_METHOD_ROUTES['contracts.cancel'];
  if (!route) throw new Error('Generated contracts.cancel route is missing');
  expect(route).toEqual({ method: 'POST', path: '/api/contracts/{contractId}/cancel' });
  const input: OperatorMethodInput<'contracts.cancel'> = { contractId: id, reason: REASON };
  return request(fixture, route.path.replace('{contractId}', encodeURIComponent(input.contractId)), token, { reason: input.reason });
}

test('authenticated cancel enforces write:fleet and returns true before real child cleanup drains', async () => {
  const cleanup = deferred();
  let childAborted = false, childCleaned = false;
  const h = makeHarness({ plan: oneUnitPlan(1), scripts: {}, executeAgent: async (record, { manager }) => {
    record.status = 'running';
    writeFileSync(join(h.root, 'partial.ts'), PARTIAL);
    const signal = manager.getCancellationSignal(record.id)!;
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    childAborted = signal.aborted;
    await cleanup.promise;
    childCleaned = true;
  } });
  const fixture = serveContractCancellation(h);
  const id = startContract(h, { isolation: 'shared' }).contract.id;
  try {
    await waitFor(() => h.store.get(id)?.units[0]?.activeAgentId !== undefined, 'running contract unit');
    const before = await inspect(fixture, id, 'live-before');
    expect(before.status).toBe('running');
    expect(fixture.catalog.get('contracts.cancel')?.scopes).toEqual(['write:fleet']);
    for (const token of [undefined, 'invalid-fixture-token']) {
      expect((await cancel(fixture, id, token)).status).toBe(401);
      expect(h.runner.get(id)?.status).toBe('running');
    }
    expect((await cancel(fixture, id, fixture.reader)).status).toBe(403);
    expect(h.runner.get(id)?.status).toBe('running');
    const response = await cancel(fixture, id, fixture.writer);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(JSON.parse(bytes)).toEqual({ cancelled: true });
    exportResponse('live-cancel', bytes);
    await waitFor(() => childAborted, 'child cancellation signal');
    expect(childCleaned).toBe(false);
    let drained = false;
    const joinRun = h.runner.join(id).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    const after = await inspect(fixture, id, 'live-after');
    expect(after.status).toBe('cancelled');
    expect(after.error ?? after.statusLine).toContain(REASON);
    expect(after.goal).toBe(before.goal);
    expect(readFileSync(join(h.root, 'partial.ts'), 'utf8')).toBe(PARTIAL);
    expect(await (await cancel(fixture, id, fixture.writer)).json()).toEqual({ cancelled: false });
    expect((await cancel(fixture, 'ctr-ffffffff', fixture.writer)).status).toBe(404);
    cleanup.resolve(); await joinRun;
    expect(drained).toBe(true); expect(childCleaned).toBe(true);
  } finally {
    cleanup.resolve(); h.runner.cancel(id, 'Fixture teardown'); await h.runner.join(id);
    fixture.stop(); h.dispose();
  }
}, 25_000);

test('false can describe an actual retained nonterminal record with no live runner', async () => {
  const source = makeHarness({ plan: oneUnitPlan(1), scripts: { u1: () => [{ text: 'Waiting for cancellation', stop: { kind: 'hang' } }] } });
  const id = startContract(source, { isolation: 'shared' }).contract.id;
  let retained: ReturnType<typeof makeHarness> | undefined;
  let fixture: HttpFixture | undefined;
  try {
    await waitFor(() => source.store.get(id)?.units[0]?.activeAgentId !== undefined, 'source running unit');
    const running = source.store.get(id);
    if (!running) throw new Error('Running contract checkpoint is missing');
    const checkpoint = structuredClone(running);
    source.runner.cancel(id, 'Stop original fixture runner'); await source.runner.join(id);
    retained = makeHarness({ scripts: {} });
    // Hold an unmodified genuine runner checkpoint without launching/resuming it.
    retained.store.hold(checkpoint);
    fixture = serveContractCancellation(retained);
    const before = await inspect(fixture, id, 'retained-before');
    expect(before.status).toBe('running');
    const response = await cancel(fixture, id, fixture.writer);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(JSON.parse(bytes)).toEqual({ cancelled: false });
    exportResponse('retained-cancel', bytes);
    const after = await inspect(fixture, id, 'retained-after');
    expect(after).toEqual(before);
    expect(retained.manager.list()).toEqual([]);
    expect(fixture.requests.filter(item => item.method === 'POST')).toHaveLength(1);
  } finally {
    fixture?.stop(); retained?.dispose();
    source.runner.cancel(id, 'Fixture teardown'); await source.runner.join(id); source.dispose();
  }
}, 25_000);
