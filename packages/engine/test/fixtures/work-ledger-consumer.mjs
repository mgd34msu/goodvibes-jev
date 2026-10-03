/**
 * Runs unchanged against Bun's source condition and the published Node ESM
 * artifact. This single-writer memory fixture tests public composition only;
 * production storage durability is tested separately.
 */
import assert from 'node:assert/strict';
import {
  createEmptyWorkLedgerState,
  createWorkLedger,
  createLocalWorkLedgerReadBinding,
  WorkLedgerAccessError,
  workLedgerCommandSchema,
  workLedgerStateSchema,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';

const projectId = 'package-consumer';
let state = createEmptyWorkLedgerState(projectId);
let sequence = 0;
const { service, authority } = createWorkLedger({
  projectId,
  clock: { now: () => 1_000, newId: (kind) => `${kind}-${++sequence}` },
  storage: {
    read: async () => structuredClone(state),
    transaction: async (decide) => {
      const decision = decide(structuredClone(state));
      if (decision.next !== null) state = structuredClone(decision.next);
      return decision.value;
    },
    subscribe: () => () => {},
  },
});

try {
  const actor = authority.issueActor({ actorId: 'host', projectId, role: 'coordinator' });
  const command = workLedgerCommandSchema.parse({
    type: 'create', requestId: 'request-1', expectedRevision: 0,
    title: 'Package consumer', goal: 'Compose from the supported subpath',
    criteria: ['Public constructor, schemas and service work together'],
  });
  const receipt = await service.execute(command, actor);
  assert.equal(receipt.kind, 'accepted');
  assert.equal(receipt.replayed, false);
  const replay = await service.execute(command, actor);
  assert.equal(replay.kind, 'accepted');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.event, receipt.event);
  assert.equal(workLedgerStateSchema.parse(state).revision, 1);
  const snapshot = await service.readSnapshot(actor);
  assert.equal(snapshot.works.length, 1);
  assert.equal(snapshot.works[0].work.title, command.title);
  assert.deepEqual(await service.history(0, actor), [receipt.event]);
  const binding = createLocalWorkLedgerReadBinding({ available: true, projectId, actorId: 'reader', service, authority });
  assert.equal(binding.available, true);
  assert.equal(binding.client.projectId, projectId);
  assert.equal((await binding.client.readSnapshot()).revision, 1);
  assert.equal('allowedActions' in (await binding.client.readSnapshot()).works[0], false);
  assert.equal('execute' in binding.client, false);
  assert.deepEqual(await binding.client.history(0), [receipt.event]);
  binding.client.dispose();
  await assert.rejects(binding.client.readSnapshot(), error => error.code === 'closed');
  assert.equal((await service.readSnapshot(actor)).revision, 1);
  assert.deepEqual(createLocalWorkLedgerReadBinding({ available: false, reason: 'Host unavailable' }), { available: false, reason: 'Host unavailable' });
  authority.revokeActor(actor);
  await assert.rejects(service.readSnapshot(actor), (error) =>
    error instanceof WorkLedgerAccessError && error.code === 'forbidden');
} finally {
  await service.close();
}

console.log('PASS work-ledger public consumer');
