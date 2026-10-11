import { BatteryRegistry } from '@goodvibes-jev/judgment';

/**
 * Every named decision the state and runtime layers make, for calibration:
 *
 *   bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/runtime/judgment-registry.ts
 */
export const registry = new BatteryRegistry();

// State: memory and knowledge.
import { knowledgeRelevance } from '../state/batteries/knowledge-relevance.js';
import { memoryAgreement, memoryAlignment } from '../state/batteries/memory-alignment.js';
import { memoryReviewPriority } from '../state/batteries/memory-review-priority.js';
import { memorySearchRerank } from '../state/batteries/memory-search-rerank.js';
import { memoryUsage } from '../state/batteries/memory-usage.js';
registry.register(knowledgeRelevance);
registry.register(memoryAlignment);
registry.register(memoryAgreement);
registry.register(memoryReviewPriority);
registry.register(memorySearchRerank);
registry.register(memoryUsage);

// Runtime: compaction, forensics, ops, tool contracts.
// (The forensics classifier reads error messages through engine.failure-reading,
// registered in packages/engine/errors/src/judgment-registry.ts.)
import { collapseKeep } from './compaction/batteries/collapse-keep.js';
import { compactionFidelity } from './compaction/batteries/compaction-fidelity.js';
import { compactionRetention } from './compaction/batteries/compaction-retention.js';
import { recommendationFit } from './ecosystem/batteries/recommendation-fit.js';
import { playbookSearch } from './ops/batteries/playbook-search.js';
import { descriptionQuality } from './tools/batteries/description-quality.js';
registry.register(collapseKeep);
registry.register(compactionFidelity);
registry.register(compactionRetention);
registry.register(recommendationFit);
registry.register(playbookSearch);
registry.register(descriptionQuality);

// Runtime: session return, setup contract, system messages.
import { pendingApproval } from './batteries/pending-approval.js';
import { setupReplyCommand } from './batteries/setup-reply-command.js';
import { systemMessagePriority } from './batteries/system-message-priority.js';
registry.register(pendingApproval);
registry.register(setupReplyCommand);
registry.register(systemMessagePriority);

// State: code index.
import { codeSearchRerank } from '../state/batteries/code-search-rerank.js';
registry.register(codeSearchRerank);

// State: file watching, the sqlite-vec loader, VIBE.md import.
import { sqliteVecRefusal } from '../state/batteries/sqlite-vec-refusal.js';
import { vibePersonaLine } from '../state/batteries/vibe-persona-line.js';
import { watchedConfig } from '../state/batteries/watched-config.js';
registry.register(watchedConfig);
registry.register(sqliteVecRefusal);
registry.register(vibePersonaLine);

// Runtime: ecosystem catalog search and review.
import { catalogSearch } from './ecosystem/batteries/catalog-search.js';
import { trustNoteCaution } from './ecosystem/batteries/trust-note-caution.js';
registry.register(catalogSearch);
registry.register(trustNoteCaution);

// Utils: error display.
import { displayPayload } from '../utils/batteries/display-payload.js';
registry.register(displayPayload);

// Types: the wait a provider error's message states before retrying.
import { retryWait } from '../types/batteries/retry-wait.js';
registry.register(retryWait);

// Runtime: model picker.
import { modelFamily } from './ui/model-picker/batteries/model-family.js';
registry.register(modelFamily);

// Runtime: tool output policy.
import { outputKind } from './tools/batteries/output-kind.js';
registry.register(outputKind);

// Runtime: settings control plane.
import { settingsRisk } from './settings/batteries/settings-risk.js';
registry.register(settingsRisk);

// Runtime: forensics.
import { forensicsSlowPhase } from './forensics/batteries/slow-phase.js';
registry.register(forensicsSlowPhase);

// Runtime: observed fleet agents.

// Runtime: credentials at rest and in config events.
import { atRestCredential } from './batteries/at-rest-credential.js';
registry.register(atRestCredential);
import { eventCredentialKey } from './config/batteries/event-credential-key.js';
registry.register(eventCredentialKey);

// Structured compaction source membership.
import { conversationSubstance, toolResultRelevance, resolvedProblemEvidence, compactionEvidenceDependency } from './compaction/batteries/section-selection.js';
registry.register(conversationSubstance);
registry.register(toolResultRelevance);
registry.register(resolvedProblemEvidence);
registry.register(compactionEvidenceDependency);

// Email: semantic refusals and mailbox purpose; RFC grammar stays deterministic.
import { imapRefusalReading, imapCursorFailureReading, imapDraftsReading } from '../email/imap-readings.js';
registry.register(imapRefusalReading);
registry.register(imapCursorFailureReading);
registry.register(imapDraftsReading);

// Browser host provisioning diagnoses, shared by runtime and driver installs.
import { browserProvisionFailure } from '../browser/browser-failure-reading.js';
registry.register(browserProvisionFailure);
import { browserControlIdentity } from '../browser/browser-control-identity.js';
registry.register(browserControlIdentity);
// Google setup control purposes and authentication page state.
import { googleSetupControl, googleSignInPage } from '../google/browser-readings.js';
registry.register(googleSetupControl);
registry.register(googleSignInPage);

// Managed local voice round-trip semantic proof.
import { voiceRoundTripReading } from '../voice/provisioning/round-trip-reading.js';
registry.register(voiceRoundTripReading);

// Occasion meaning; closed dates and delivery authority remain mechanical.
import { occasionInterest, occasionTitlePerson, occasionSubject } from '../occasions/readings.js';
registry.register(occasionInterest);
registry.register(occasionTitlePerson);
registry.register(occasionSubject);
// Recorder diagnostic semantics shared by Agent and TUI capture.
import { recorderFailureReading } from '../voice/capture/recorder-failure-reading.js';
registry.register(recorderFailureReading);

import { localEngineFailureReading } from '../voice/providers/local-failure-reading.js';
registry.register(localEngineFailureReading);

// Owner profile: named People prose, never read/disclosure authority.
import { profilePersonLine } from '../owner-profile/person-reading.js';
registry.register(profilePersonLine);
