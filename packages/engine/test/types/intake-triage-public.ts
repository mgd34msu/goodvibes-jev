import { scoreInboxTriage, runInboxTriage, readTriageMetadataBatch, enrichItemsWithTriage, SqliteTriageStore, labelToTag,
  type TriageInput, type TriageReceipt, type TriageStore } from '@goodvibes-jev/engine/sdk/platform/intake';
declare const items: readonly TriageInput[];
declare const store: TriageStore;
const receipt: Promise<readonly TriageReceipt[]> = scoreInboxTriage(items);
const dry: Promise<readonly TriageReceipt[]> = runInboxTriage(items, {dryRun:true});
const persisted: Promise<readonly TriageReceipt[]> = runInboxTriage(items, {store});
const metadata = readTriageMetadataBatch(items,store);
const enriched = enrichItemsWithTriage(items,store);
const owned: TriageStore = new SqliteTriageStore('/synthetic');
const tag: string = labelToTag('priority');
// @ts-expect-error labels are a closed decision vocabulary.
labelToTag('urgent');
export {receipt,dry,persisted,metadata,enriched,owned,tag};
