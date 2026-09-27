import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Every named decision the state and runtime layers make, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/runtime/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// Runtime: compaction, forensics, ops, tool contracts.
// (The forensics classifier reads error messages through engine.failure-reading,
// registered in packages/engine/errors/src/judgment-registry.ts.)
import { compactionFidelity } from './compaction/batteries/compaction-fidelity.js';
import { compactionRetention } from './compaction/batteries/compaction-retention.js';
import { playbookSearch } from './ops/batteries/playbook-search.js';
import { descriptionQuality } from './tools/batteries/description-quality.js';
registry.register(compactionFidelity);
registry.register(compactionRetention);
registry.register(playbookSearch);
registry.register(descriptionQuality);

// Runtime: session return, setup contract, system messages.
import { pendingApproval } from './batteries/pending-approval.js';
import { setupReplyCommand } from './batteries/setup-reply-command.js';
import { systemMessagePriority } from './batteries/system-message-priority.js';
registry.register(pendingApproval);
registry.register(setupReplyCommand);
registry.register(systemMessagePriority);
