/** Runs unchanged with Bun source exports and published Node ESM exports. */
import assert from 'node:assert/strict';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';

const calls = [];
const projectId = 'operator-package-consumer';
const operator = createOperatorSdk({
  baseUrl: 'http://127.0.0.1:9', authToken: 'synthetic-package-token',
  fetch: async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    assert.equal(url.searchParams.get('projectId'), projectId);
    assert.equal(url.searchParams.has('actorId'), false);
    const body = url.pathname.endsWith('/snapshot')
      ? { projectId, revision: 0, cursor: 0, works: [] }
      : { projectId, afterSequence: 0, cursor: 0, throughSequence: 0, hasMore: false, events: [] };
    return Response.json(body);
  },
});
const reader = createOperatorWorkLedgerReadClient(operator, projectId);
try {
  assert.equal(reader.projectId, projectId);
  assert.deepEqual(await reader.readSnapshot(), { projectId, revision: 0, cursor: 0, provenance: 'requires_read_knowledge', works: [] });
  assert.deepEqual(await reader.history(0), []);
  assert.equal(reader.execute, undefined);
  assert.equal(reader.authority, undefined);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.headers.get('authorization') === 'Bearer synthetic-package-token'));
  reader.dispose(); reader.dispose();
  await assert.rejects(reader.readSnapshot(), /disposed/);
} finally { reader.dispose(); operator.dispose(); }
console.log('PASS work-ledger operator public consumer');
