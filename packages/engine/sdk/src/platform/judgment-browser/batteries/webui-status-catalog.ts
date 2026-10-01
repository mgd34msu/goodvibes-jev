import type { CompanionChatSessionStatus } from '../../companion/companion-chat-types.js';
import type { KnowledgeJobStatus, KnowledgeRefinementTaskState } from '../../knowledge/types.js';
import type { ProviderAuthFreshness } from '../../runtime/provider-accounts/registry.js';
import type { StatusValue } from './webui-types.js';

type Tones = { readonly badge: Extract<StatusValue, { vocabulary: 'badge' }>['tone']; readonly 'library-dot': Extract<StatusValue, { vocabulary: 'library-dot' }>['tone'] };

/** Exhaustive presentation declarations for authoritative current producer enums. */
const SESSION_TONES = {
  active: { badge: 'ok', 'library-dot': 'info' },
  closed: { badge: 'neutral', 'library-dot': 'idle' },
} as const satisfies Record<CompanionChatSessionStatus, Tones>;
const KNOWLEDGE_JOB_TONES = {
  queued: { badge: 'warning', 'library-dot': 'info' },
  running: { badge: 'ok', 'library-dot': 'info' },
  completed: { badge: 'ok', 'library-dot': 'ok' },
  failed: { badge: 'bad', 'library-dot': 'bad' },
} as const satisfies Record<KnowledgeJobStatus, Tones>;
const ACCOUNT_AUTH_TONES = {
  healthy: { badge: 'ok', 'library-dot': 'ok' },
  expiring: { badge: 'warning', 'library-dot': 'warn' },
  expired: { badge: 'bad', 'library-dot': 'bad' },
  pending: { badge: 'warning', 'library-dot': 'info' },
  unconfigured: { badge: 'neutral', 'library-dot': 'idle' },
} as const satisfies Record<ProviderAuthFreshness, Tones>;
const REFINEMENT_TONES = {
  detected: { badge: 'neutral', 'library-dot': 'info' },
  queued: { badge: 'warning', 'library-dot': 'info' },
  searching: { badge: 'ok', 'library-dot': 'info' },
  evaluating: { badge: 'ok', 'library-dot': 'info' },
  extracting: { badge: 'ok', 'library-dot': 'info' },
  applying: { badge: 'ok', 'library-dot': 'info' },
  verified: { badge: 'ok', 'library-dot': 'ok' },
  closed: { badge: 'neutral', 'library-dot': 'idle' },
  blocked: { badge: 'warning', 'library-dot': 'warn' },
  suppressed: { badge: 'neutral', 'library-dot': 'idle' },
  needs_review: { badge: 'warning', 'library-dot': 'warn' },
  cancelled: { badge: 'neutral', 'library-dot': 'idle' },
  failed: { badge: 'bad', 'library-dot': 'bad' },
} as const satisfies Record<KnowledgeRefinementTaskState, Tones>;

export const WEBUI_STATUS_CATALOG = Object.freeze({
  'session.active': Object.freeze(SESSION_TONES.active),
  'session.closed': Object.freeze(SESSION_TONES.closed),
  'knowledge-job.queued': Object.freeze(KNOWLEDGE_JOB_TONES.queued),
  'knowledge-job.running': Object.freeze(KNOWLEDGE_JOB_TONES.running),
  'knowledge-job.completed': Object.freeze(KNOWLEDGE_JOB_TONES.completed),
  'knowledge-job.failed': Object.freeze(KNOWLEDGE_JOB_TONES.failed),
  'account-auth.healthy': Object.freeze(ACCOUNT_AUTH_TONES.healthy),
  'account-auth.expiring': Object.freeze(ACCOUNT_AUTH_TONES.expiring),
  'account-auth.expired': Object.freeze(ACCOUNT_AUTH_TONES.expired),
  'account-auth.pending': Object.freeze(ACCOUNT_AUTH_TONES.pending),
  'account-auth.unconfigured': Object.freeze(ACCOUNT_AUTH_TONES.unconfigured),
  'knowledge-refinement.detected': Object.freeze(REFINEMENT_TONES.detected),
  'knowledge-refinement.queued': Object.freeze(REFINEMENT_TONES.queued),
  'knowledge-refinement.searching': Object.freeze(REFINEMENT_TONES.searching),
  'knowledge-refinement.evaluating': Object.freeze(REFINEMENT_TONES.evaluating),
  'knowledge-refinement.extracting': Object.freeze(REFINEMENT_TONES.extracting),
  'knowledge-refinement.applying': Object.freeze(REFINEMENT_TONES.applying),
  'knowledge-refinement.verified': Object.freeze(REFINEMENT_TONES.verified),
  'knowledge-refinement.closed': Object.freeze(REFINEMENT_TONES.closed),
  'knowledge-refinement.blocked': Object.freeze(REFINEMENT_TONES.blocked),
  'knowledge-refinement.suppressed': Object.freeze(REFINEMENT_TONES.suppressed),
  'knowledge-refinement.needs_review': Object.freeze(REFINEMENT_TONES.needs_review),
  'knowledge-refinement.cancelled': Object.freeze(REFINEMENT_TONES.cancelled),
  'knowledge-refinement.failed': Object.freeze(REFINEMENT_TONES.failed),
});
export type WebuiStatusLabelId = keyof typeof WEBUI_STATUS_CATALOG;

/** Caller-side structural resolution. An unknown ID has no invented neutral tone. */
export function readWebuiStatusCatalog(labelId: string, vocabulary: StatusValue['vocabulary']): StatusValue | undefined {
  if (!Object.hasOwn(WEBUI_STATUS_CATALOG, labelId)) return undefined;
  const tones = WEBUI_STATUS_CATALOG[labelId as WebuiStatusLabelId];
  return vocabulary === 'badge' ? { vocabulary, tone: tones.badge }
    : vocabulary === 'library-dot' ? { vocabulary, tone: tones['library-dot'] } : undefined;
}
