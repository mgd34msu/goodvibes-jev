import { expect, test } from 'bun:test';
import { FakeClusterClock, GroupAdmissionService, createGroupKeyMaterial } from '../sdk/src/platform/cluster/index.js';

function fixture(send?: (service: GroupAdmissionService) => Promise<void>) {
  const clock = new FakeClusterClock();
  // Ephemeral dummy cryptographic material, never persisted or sent to a peer.
  const material = createGroupKeyMaterial({ groupId: 'fixture-group', groupRoot: 'fixture-root', joinKey: 'fixture-join', joinSalt: 'fixture-salt', joinVerifier: 'fixture-verifier', nodeId: 'fixture-node', now: clock.now() });
  const service: GroupAdmissionService = new GroupAdmissionService({
    nodeId: 'fixture-node', nodeDisplayName: 'fixture', version: '1.0.0', clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    material: () => material, state: () => null, async commitState() {},
    send: (): Promise<void> => send?.(service) ?? Promise.resolve(), nextSeq: () => 1,
  });
  return { service, clock };
}

test('abandoned rejoin cancels its owned deadline', async () => {
  const { service, clock } = fixture();
  const outcome = service.requestRejoin(1000);
  expect(clock.pendingTimers).toBe(1);
  service.abandon('fixture shutdown');
  expect(await outcome).toMatchObject({ ok: false, failure: 'abandoned' });
  expect(clock.pendingTimers).toBe(0);
});

test('failed send cancels the admission deadline', async () => {
  const { service, clock } = fixture(async () => { throw new Error('fixture refused'); });
  expect(await service.requestRejoin(1000)).toMatchObject({ ok: false, failure: 'not-sent' });
  expect(clock.pendingTimers).toBe(0);
});

test('synchronous settlement during send cannot leave a late timeout', async () => {
  const { service, clock } = fixture(async (admission) => { admission.abandon('fixture immediate stop'); });
  expect(await service.requestRejoin(1000)).toMatchObject({ ok: false, failure: 'abandoned' });
  expect(clock.pendingTimers).toBe(0);
});

test('housekeeping expiry cancels the independent timeout', async () => {
  const { service, clock } = fixture();
  const outcome = service.requestRejoin(1000);
  service.expire(clock.now() + 1000, 'fixture expiry');
  expect(await outcome).toMatchObject({ ok: false, failure: 'unanswered' });
  expect(clock.pendingTimers).toBe(0);
});

test('natural timeout still reports unanswered and owns no timer afterward', async () => {
  const { service, clock } = fixture();
  const outcome = service.requestRejoin(1000);
  clock.advance(1000);
  expect(await outcome).toMatchObject({ ok: false, failure: 'unanswered' });
  expect(clock.pendingTimers).toBe(0);
});
