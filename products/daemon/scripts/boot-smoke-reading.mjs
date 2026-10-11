import assert from 'node:assert/strict';
import { defineBattery, PINNED_MODEL, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Interpretation is a Jev reading, never sqlite/error word co-occurrence. */
export const nativeAddonFailure = defineBattery({
  name: 'daemon.boot-smoke.native-addon-failure', version: 1, model: PINNED_MODEL,
  description: 'Whether actual compiled boot evidence reports failure of the native sqlite-vec addon.',
  accuracyFloor: 0.9,
  items: { native_addon_failure: yesNo('Does this compiled daemon evidence report an actual sqlite-vec native-addon load, initialization, indexing or query failure? A successful check mentioning errors, an unrelated failure, or quoted hypothetical failure text is not an actual addon failure. Read the evidence in context.', STAKES_BANDS.low.yesNo) },
  fixtures: [
    { name: 'loaded without errors', state: { stderr: 'sqlite-vec initialized; no errors' }, expect: { native_addon_failure: 'no' } },
    { name: 'explicit load failure', state: { stderr: 'Cannot load sqlite-vec extension: invalid ELF header' }, expect: { native_addon_failure: 'yes' } },
    { name: 'unrelated provider failure', state: { stderr: 'sqlite-vec initialized. Model provider request failed.' }, expect: { native_addon_failure: 'no' } },
    { name: 'index failure', state: { response: 'sqlite-vec insert failed: no such module vec0' }, expect: { native_addon_failure: 'yes' } },
  ],
});

export async function readNativeAddonEvidence(port, evidence, signal) {
  // Refuse oversized evidence instead of truncating away a possible failure.
  assert(Buffer.byteLength(JSON.stringify(evidence), 'utf8') <= 48_000, 'Compiled boot evidence exceeds judgment budget');
  const run = await nativeAddonFailure.run(port, evidence, { site: 'daemon.boot-smoke.native-addon-failure', signal });
  const reading = run.readings.native_addon_failure;
  run.recordAction(reading.verdict === 'no' ? 'accept-native-evidence' : 'refuse-native-evidence');
  assert.equal(reading.verdict, 'no', 'Native addon diagnostics report a failure or remain uncertain');
  return { verdict: reading.verdict, probability: reading.probability, model: PINNED_MODEL };
}

/** Shared assertion body used by the compiled consumer and source HTTP test. */
export async function proveNativeMemoryRoundTrip(invoke) {
  const summary = 'boot-smoke sqlite-vec native addon semantic search';
  const added = await invoke('memory.records.add', { cls: 'fact', scope: 'session', summary });
  assert.equal(typeof added.record?.id, 'string');
  const vector = await invoke('memory.vector.stats');
  assert.equal(vector.vector?.backend, 'sqlite-vec'); assert.equal(vector.vector?.available, true);
  assert.equal(vector.vector?.enabled, true); assert(vector.vector.indexedRecords >= 1);
  assert.equal(vector.vector.error, undefined); assert.equal(vector.vector.platformLimitReason, undefined);
  const searched = await invoke('memory.records.search-semantic', { query: summary });
  assert(Array.isArray(searched.results));
  const found = searched.results.find(result => result.record?.id === added.record.id);
  assert(found, 'The added memory must be returned by semantic search');
  assert.equal(typeof found.distance, 'number'); assert(Number.isFinite(found.distance), 'Lexical fallback does not prove vec0 query execution');
  return { added, searched, vector };
}
