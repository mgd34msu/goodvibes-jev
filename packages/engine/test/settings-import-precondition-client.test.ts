import { expect, test } from 'bun:test';
import { captureRemoteSettingsImportPrecondition, assertRemoteSettingsImportPrecondition, inspectRemoteSettingsImportPrecondition,
  applyRemoteSettingsImportPrecondition, assertCompletedRemoteSettingsImportPrecondition } from '../sdk/src/platform/config/settings-import-precondition-client.js';

const endpoint = { baseUrl: 'http://127.0.0.1:4567', token: 'private-synthetic-owner-token', source: 'synthetic fixture' };
const request = { settings: [{ key: 'controlPlane.port', value: 3434 }, { key: 'surfaces.slack.botToken', value: 'private-synthetic-import-token' }] };
const secretPath = '/fixture/daemon/secrets.json', settingsPath = '/fixture/daemon/settings.json';
function facts() {
  const destinations = [{ path: settingsPath, operation: 'set', tier: 'daemon' }];
  const credential = { items: [{ key: 'GOODVIBES_SURFACES_SLACK_BOT_TOKEN', scope: 'daemon', configured: true }],
    destinations: [{ path: secretPath, operation: 'set', tier: 'daemon' }] };
  return { operation: 'import', incarnation: 1, credential, effects: [
    { operation: 'set', key: 'controlPlane.port', value: 3434, destinations },
    { operation: 'set', key: 'surfaces.slack.botToken', value: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN', destinations },
  ], destinations: [...credential.destinations, ...destinations, ...destinations] };
}
function transport(options: { changeFacts?: (value: ReturnType<typeof facts>) => unknown; verified?: boolean; afterApply?: () => void } = {}) {
  let captures = 0, applies = 0;
  const fetchImpl: typeof fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const arm = JSON.parse(String(init?.body)).settingsImportPrecondition;
    if (arm.action === 'capture') {
      captures++;
      return Response.json({ settingsImportPrecondition: { version: 1, action: 'captured', reference: 'synthetic-reference', expiresAt: Date.now() + 300_000,
        facts: options.changeFacts ? options.changeFacts(facts()) : facts() } });
    }
    applies++; options.afterApply?.();
    return Response.json({ settingsImportPrecondition: { version: 1, action: 'applied', reference: 'synthetic-reference',
      receipt: { status: 'committed', completedPaths: [secretPath, settingsPath, settingsPath], verifiedInOwningStore: options.verified ?? true } } });
  }, { preconnect: fetch.preconnect });
  return { fetchImpl, counts: () => ({ captures, applies }) };
}
test('private import capture exposes only exact value-safe facts and one validated receipt', async () => {
  const fixture = transport(), handle = await captureRemoteSettingsImportPrecondition(endpoint, request, fixture);
  expect(JSON.stringify(inspectRemoteSettingsImportPrecondition(handle))).not.toContain('private-synthetic');
  expect(Object.isFrozen(inspectRemoteSettingsImportPrecondition(handle).effects[0])).toBe(true);
  expect((await applyRemoteSettingsImportPrecondition(handle)).status).toBe('committed');
  expect(() => assertCompletedRemoteSettingsImportPrecondition(handle)).not.toThrow();
  expect(() => assertRemoteSettingsImportPrecondition(handle)).toThrow();
  await expect(applyRemoteSettingsImportPrecondition(handle)).rejects.toThrow();
  expect(fixture.counts()).toEqual({ captures: 1, applies: 1 });
});
test.each(['extra-field', 'raw-value', 'wrong-key', 'wrong-scope', 'missing-tail'] as const)('import facts reject %s before an apply wire', async corruption => {
  const fixture = transport({ changeFacts: original => {
    if (corruption === 'extra-field') return { ...original, unknown: 'private-synthetic' };
    if (corruption === 'raw-value') original.effects[1]!.value = 'private-synthetic-import-token';
    if (corruption === 'wrong-key') original.effects[0]!.key = 'controlPlane.host';
    if (corruption === 'wrong-scope') original.credential.items[0]!.scope = 'user';
    if (corruption === 'missing-tail') original.destinations.pop();
    return original;
  } });
  await expect(captureRemoteSettingsImportPrecondition(endpoint, request, fixture)).rejects.toThrow();
  expect(fixture.counts().applies).toBe(0);
});
test('unfinished source/effect restrictions cannot reach either private wire', async () => {
  const captureFixture = transport();
  await expect(captureRemoteSettingsImportPrecondition(endpoint, request, { ...captureFixture, assertCurrent: async () => {} })).rejects.toThrow();
  expect(captureFixture.counts()).toEqual({ captures: 0, applies: 0 });
  const applyFixture = transport(), handle = await captureRemoteSettingsImportPrecondition(endpoint, request, applyFixture);
  await expect(applyRemoteSettingsImportPrecondition(handle, { assertCurrent: async () => {} })).rejects.toThrow();
  expect(applyFixture.counts().applies).toBe(0);
});
test('native committed receipt survives post-wire cancellation while completed authority retires', async () => {
  const abort = new AbortController(), fixture = transport({ afterApply: () => abort.abort() });
  const handle = await captureRemoteSettingsImportPrecondition(endpoint, request, { ...fixture, signal: abort.signal });
  const receipt = await applyRemoteSettingsImportPrecondition(handle);
  expect(receipt.status).toBe('committed'); expect(receipt.completedPaths).toEqual([secretPath, settingsPath, settingsPath]);
  expect(() => assertCompletedRemoteSettingsImportPrecondition(handle)).toThrow(); expect(fixture.counts().applies).toBe(1);
});
test('a serving unverified committed receipt cannot authorize a local tail', async () => {
  const fixture = transport({ verified: false }), handle = await captureRemoteSettingsImportPrecondition(endpoint, request, fixture);
  expect((await applyRemoteSettingsImportPrecondition(handle)).verifiedInOwningStore).toBe(false);
  expect(() => assertCompletedRemoteSettingsImportPrecondition(handle)).toThrow();
});
