import assert from 'node:assert/strict';
import { matchesJudgmentModel } from '@goodvibes-jev/judgment';
import { nativeAddonFailure } from '@goodvibes-jev/engine/toolchain';
import { retainStrictJudgmentJson, snapshotJudgmentInput, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
export { nativeAddonFailure };

export async function readNativeAddonEvidence(port, evidence, signal) {
  const retained = retainStrictJudgmentJson(evidence);
  const snapshot = snapshotJudgmentInput(retained.snapshot);
  assert(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 48_000, 'Compiled boot evidence exceeds judgment budget');
  const model = port.model, ask = port.ask, recorder = port.recorder;
  const current = () => {
    retained.assertCurrent(); signal?.throwIfAborted();
    assert(port.model === model && port.ask === ask && port.recorder === recorder, 'Native diagnostic judgment owner changed');
  };
  current();
  const capturedPort = {
    model, recorder,
    async ask(request) {
      current();
      const prepared = prepareJudgmentResult(request.questions);
      let cancel;
      const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason ?? new Error('Native diagnostic reading cancelled')); });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        current();
        const original = await Promise.race([Promise.resolve().then(() => { current(); return ask.call(port, { ...request, questions: prepared.questions, signal }); }), aborted]);
        current(); prepared.assertCurrent();
        const result = prepared.capture(original);
        assert(result.requestedModel === model && matchesJudgmentModel(model, result.model), 'Native diagnostic judgment model mismatch');
        return result;
      } finally { signal?.removeEventListener('abort', cancel); }
    },
  };
  const run = await nativeAddonFailure.run(capturedPort, snapshot, { site: nativeAddonFailure.name, signal });
  current();
  const reading = run.readings.native_addon_failure;
  const accepted = reading.outcome === 'act' && reading.verdict === 'no';
  run.recordAction(accepted ? 'accept-native-evidence' : 'refuse-native-evidence');
  current();
  assert(accepted, 'Native addon diagnostics report a failure or remain uncertain');
  return { verdict: reading.verdict, probability: reading.probability, requestedModel: run.result.requestedModel, model: run.result.model };
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
