import { join } from 'node:path';
import { WorkProposalStore } from '../agents/work-proposal-store.js';
import { readConversationGateConfig } from '../agents/conversation-gate.js';
import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Construct the facade's existing proposal store without changing its policy. */
export function createFacadeWorkProposalStore(config: Pick<ConfigManager, 'get' | 'getCategory' | 'getControlPlaneConfigDir'>): WorkProposalStore {
  // Pending work proposals for the conversation-first spawn gate. Persisted
  // beside the other control-plane state so a proposal survives a daemon
  // restart; the store validates and reaps on load, so a stale one is not
  // answerable after it expires.
  const workProposals = new WorkProposalStore({
    storePath: join(config.getControlPlaneConfigDir(), 'work-proposals.json'),
    maxPending: readConversationGateConfig(config).maxPendingProposals,
  });
  void workProposals.init().catch((error: unknown) => {
    logger.warn('WorkProposalStore init failed; the conversation gate will re-propose', {
      error: summarizeError(error),
    });
  });
  return workProposals;
}
