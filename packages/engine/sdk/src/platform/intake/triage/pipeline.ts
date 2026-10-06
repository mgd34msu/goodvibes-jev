import { isDeepStrictEqual } from 'node:util';
import { captureTriageData, captureTriageInputs, checkTriageReceipt, triageBinding } from './evidence.js';
import { scoreCapturedTriage } from './scorer.js';
import { SqliteTriageStore } from './store.js';
import type { RunInboxTriageOptions, TriageEvidence, TriageInput, TriageReceipt, TriageStore, TriageStoredRecord } from './types.js';

/** Scores first, then atomically publishes; dry-run does not open, read, close or write a store. */
export async function runInboxTriage(items: readonly TriageInput[], options: RunInboxTriageOptions = {}): Promise<readonly TriageReceipt[]> {
  const input = captureTriageInputs(items);
  const receipts = await scoreCapturedTriage(input, options.port, options.signal);
  if (options.dryRun || !receipts.length || options.signal?.aborted) return receipts;
  const injected = options.store;
  if (!injected && !options.workingDirectory) throw new Error('Triage persistence requires a store or working directory.');
  const store = injected ?? new SqliteTriageStore(options.workingDirectory!);
  try { await store.commit(receipts, options.signal); }
  finally { if (!injected) await store.close(); }
  return receipts;
}

/** One batched read; historical evidence is projected only when the latest receipt still agrees. */
export async function readTriageMetadataBatch(items: readonly TriageInput[], store: TriageStore): Promise<ReadonlyMap<string, TriageEvidence>> {
  const input = captureTriageInputs(items);
  const current = new Map(input.map(item => [item.id, triageBinding(item)]));
  if (!current.size) return new Map();
  const records = await store.readBatch([...current.keys()]);
  const out = new Map<string, TriageEvidence>();
  // Native iteration rejects forged/proxy Maps and ignores overridden getters/iterators.
  const entries = Map.prototype.entries.call(records) as IterableIterator<[string, TriageStoredRecord]>;
  for (const [id, raw] of entries) {
    const binding = current.get(id);
    if (!binding) continue;
    try {
      const captured = captureTriageData(raw);
      if (!captured || typeof captured !== 'object' || Array.isArray(captured)) continue;
      const record = captured as unknown as TriageStoredRecord;
      const latest = checkTriageReceipt(record.latest);
      if (latest.status !== 'settled' || latest.id !== id || latest.inputHash !== binding.inputHash) continue;
      const settled = checkTriageReceipt(record.settled);
      if (settled.status === 'settled' && isDeepStrictEqual(settled, latest)) out.set(id, settled);
    } catch { /* Invalid stored evidence is never converted into a current label. */ }
  }
  return out;
}

/** Removes stale incoming projections before adding checked evidence for this exact semantic input. */
export async function enrichItemsWithTriage(items: readonly TriageInput[], store: TriageStore): Promise<readonly (TriageInput & { readonly triage?: TriageEvidence })[]> {
  const captured = captureTriageData(items) as readonly TriageInput[];
  const evidence = await readTriageMetadataBatch(captured, store);
  return Object.freeze(captured.map(item => {
    const clean = { ...item } as Record<string, unknown>;
    for (const key of ['triage', 'triageScore', 'triageTags', 'triageLabel']) delete clean[key];
    const triage = evidence.get(item.id);
    return Object.freeze({ ...clean, ...(triage ? { triage } : {}) }) as TriageInput & { readonly triage?: TriageEvidence };
  }));
}
