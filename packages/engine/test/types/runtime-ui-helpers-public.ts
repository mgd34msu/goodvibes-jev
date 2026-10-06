/** The TUI/agent prerequisites are available through the published engine entry points. */
import { runtimeEventKey, runtimeEventOfNotice, type RuntimeEventNotice, type RuntimeEventProvenance } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { sumConversationUsage, type ConversationMessageSnapshot, type OrchestratorUsageTotals } from '@goodvibes-jev/engine/sdk/platform/core';

const messages: readonly ConversationMessageSnapshot[] = [
  { role: 'assistant', content: 'Done.', usage: { inputTokens: 10, outputTokens: 2 }, followUp: true },
];
const restored: { usage: OrchestratorUsageTotals; lastInputTokens: number } = sumConversationUsage(messages);
const notice: RuntimeEventNotice | undefined = runtimeEventOfNotice('[Contract] ✓ ctr-a PASSED: 1 of 1 criteria met, 0 corrections');
const key: string | undefined = runtimeEventKey('CONTRACT_PASSED', { contractId: 'ctr-a' });
void [restored, notice, key];

const provenance: RuntimeEventProvenance = { type: 'CONTRACT_PASSED', occurrenceId: 'producer-minted-id' };
const identifiedNotice = runtimeEventOfNotice('[Contract] ✓ ctr-a PASSED: 1 of 1 criteria met, 0 corrections', provenance);
const persistedNotice: ConversationMessageSnapshot = { role: 'system', content: 'Notice', runtimeEvent: provenance };
void [identifiedNotice, persistedNotice];
