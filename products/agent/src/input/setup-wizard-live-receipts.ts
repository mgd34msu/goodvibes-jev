import type { CommandContext } from './command-registry.ts';
import { buildSetupWizardDurableReceiptsFromReadModel, mergeSetupWizardDurableReceipts } from '../agent/setup-wizard-artifact-receipts.ts';
import type { AgentSetupWizardDurableReceipt } from '../agent/setup-wizard.ts';

interface SetupReceiptReadModelSource {
  readonly path: string;
  readonly source: unknown;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function setupReceiptReadModelSources(context: CommandContext): readonly SetupReceiptReadModelSource[] {
  const contextRecord = context as unknown as Record<string, unknown>;
  const platform = readRecord(contextRecord.platform);
  const clients = readRecord(contextRecord.clients);
  const readModels = readRecord(platform.readModels);
  const setup = readRecord(readModels.setup);
  const setupWizard = readRecord(readModels.setupWizard);
  const firstRun = readRecord(readModels.firstRun);
  const browserPwa = readRecord(readModels.browserPwa);
  const operator = readRecord(clients.operator);
  return [
    { path: 'context.platform.readModels.setup.receipts', source: setup.receipts },
    { path: 'context.platform.readModels.setup.setupReceipts', source: setup.setupReceipts },
    { path: 'context.platform.readModels.setup.receiptEvents', source: setup.receiptEvents },
    { path: 'context.platform.readModels.setup.eventStream', source: setup.eventStream },
    { path: 'context.platform.readModels.setup', source: readModels.setup },
    { path: 'context.platform.readModels.setupWizard.receipts', source: setupWizard.receipts },
    { path: 'context.platform.readModels.setupWizard.durableReceipts', source: setupWizard.durableReceipts },
    { path: 'context.platform.readModels.setupWizard.receiptEvents', source: setupWizard.receiptEvents },
    { path: 'context.platform.readModels.setupWizard.eventStream', source: setupWizard.eventStream },
    { path: 'context.platform.readModels.setupReceipts', source: readModels.setupReceipts },
    { path: 'context.platform.readModels.setupReceiptEvents', source: readModels.setupReceiptEvents },
    { path: 'context.platform.readModels.setupReceiptEventStream', source: readModels.setupReceiptEventStream },
    { path: 'context.platform.readModels.durableSetupReceipts', source: readModels.durableSetupReceipts },
    { path: 'context.platform.readModels.firstRun.receipts', source: firstRun.receipts },
    { path: 'context.platform.readModels.browserPwa.firstRunReceipts', source: browserPwa.firstRunReceipts },
    { path: 'context.platform.setupReceipts', source: platform.setupReceipts },
    { path: 'context.platform.setupReceiptEvents', source: platform.setupReceiptEvents },
    { path: 'context.clients.operator.setupReceipts', source: operator.setupReceipts },
    { path: 'context.clients.operator.setupReceiptEvents', source: operator.setupReceiptEvents },
  ];
}

function readSnapshot(source: unknown): unknown {
  if (typeof source === 'function') {
    const result = (source as () => unknown)();
    return result instanceof Promise ? undefined : result;
  }
  const record = readRecord(source);
  for (const methodName of ['getSnapshot', 'snapshot', 'list', 'listReceipts', 'listEvents', 'listReceiptEvents', 'readEvents']) {
    const method = record[methodName];
    if (typeof method === 'function') {
      const result = (method as () => unknown)();
      return result instanceof Promise ? undefined : result;
    }
  }
  return source;
}

export function setupWizardLiveDurableReceipts(context: CommandContext): readonly AgentSetupWizardDurableReceipt[] {
  const receipts: AgentSetupWizardDurableReceipt[][] = [];
  for (const entry of setupReceiptReadModelSources(context)) {
    if (entry.source === undefined || entry.source === null) continue;
    try {
      receipts.push([...buildSetupWizardDurableReceiptsFromReadModel(readSnapshot(entry.source), entry.path)]);
    } catch {
      // Broken host read models should not hide local setup posture.
    }
  }
  return mergeSetupWizardDurableReceipts(...receipts);
}

export { mergeSetupWizardDurableReceipts };
