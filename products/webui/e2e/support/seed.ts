/**
 * Seeded daemon state for the hermetic Playwright harness.
 *
 * This is a deterministic, in-memory fixture, NOT a real daemon. The harness never
 * talks to a real GoodVibes daemon (never 3421/4444, never any port): every /api
 * request is intercepted in the browser by installMockDaemon (support/mock-daemon.ts)
 * and answered from these fixtures. That keeps the phone-viewport proofs reproducible
 * and offline, with no port coordination and zero risk of touching a live process.
 *
 * CONTRACT-BOUND: sessionRecord()/messagesResponse()/unionListResponse()
 * shapes are asserted, in e2e/support/assert-contract-shape.test.ts, against the SDK's
 * generated operator-contract.json (sessions.list / sessions.get /
 * sessions.messages.list all share this session-record shape). A field rename or a
 * new required field on that contract fails that assertion instead of the mock
 * silently answering a shape the daemon would never send, the drift class that bit
 * once already (see providersResponse()'s header below).
 */

import type { FleetProcessNode } from '../../src/lib/contract-bridge-types';
import type { OperatorMethodOutput } from '../../src/lib/goodvibes';

/**
 * The fleet node fixtures below are annotated with the app's own FleetProcessNode
 * (= FleetSnapshotResult['nodes'][number], generated from the SDK's operator
 * contract) rather than left to inference. Left inferred, the array in
 * FLEET_SNAPSHOT.nodes collapsed to the handful of properties every node shares,
 * so `needsAttention`, `observed`, `sessionRef`, `usage`, `provider`/`model` were
 * invisible to the compiler, assert-contract-shape.test.ts's
 * `blocked?.needsAttention` assertion referenced a property TypeScript did not
 * believe existed, and mock-daemon's withManualPricing() could not be applied to
 * the array at all.
 *
 * `WithRequired` re-states, at the type level, the fact each fixture's comment
 * already claims: this specific node always carries this optional field. Specs
 * read those fields directly, so the fixture, not every call site, is where the
 * guarantee belongs.
 */
type WithRequired<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> };

/** The daemon's honest reason when an observed agent has no steer channel. Shared
 *  by the fixture and fleet-observed.e2e.ts so the spec asserts the exact string the
 *  fixture serves, with no optional-property indirection between them. */
export const FLEET_OBSERVED_NO_CHANNEL_REASON = 'no controlling tty found for this process';

export interface SeedMessage {
  id: string;
  role: string;
  body: string;
  createdAt: number;
}

export interface SeedParticipant {
  surfaceKind: string;
  surfaceId: string;
  lastSeenAt: number;
}

export interface SeedSession {
  id: string;
  kind: string;
  project: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  messageCount: number;
  pendingInputCount: number;
  routeIds: string[];
  surfaceKinds: string[];
  participants: SeedParticipant[];
  metadata: Record<string, unknown>;
  activeAgentId?: string;
  messages: SeedMessage[];
}

/** A steerable session (agent bound, open), the target of the hero journey. */
export const STEERABLE_SESSION: SeedSession = {
  id: 's-agent-live',
  kind: 'agent',
  project: 'goodvibes-tui',
  title: 'Refactor the session spine',
  status: 'active',
  createdAt: 100,
  updatedAt: 200,
  lastActivityAt: 200,
  messageCount: 4,
  pendingInputCount: 0,
  routeIds: ['r-agent-live'],
  surfaceKinds: ['webui', 'tui'],
  participants: [{ surfaceKind: 'webui', surfaceId: 'goodvibes-webui', lastSeenAt: 200 }],
  metadata: {},
  activeAgentId: 'agent-42',
  messages: [
    { id: 'm1', role: 'user', body: 'Extract the new-file logic so we stay under the 800-line cap.', createdAt: 110 },
    { id: 'm2', role: 'assistant', body: 'Moved the new-file branch into a helper and wired the timer-driven keepalive so a live surface never goes stale mid-idle. Running the suite now.', createdAt: 140 },
    { id: 'm3', role: 'user', body: 'Good. Keep the wire shapes identical to the spine contract.', createdAt: 170 },
    { id: 'm4', role: 'assistant', body: 'Confirmed: the create-time race is closed and the detached-spawn default holds. Standing by for the next steer.', createdAt: 200 },
  ],
};

/** A closed session (no agent), steer degrades to follow-up honesty. */
export const FOLLOWUP_SESSION: SeedSession = {
  id: 's-tui-idle',
  kind: 'tui',
  project: 'goodvibes-tui',
  title: 'Earlier TUI coding pass',
  status: 'active',
  createdAt: 50,
  updatedAt: 150,
  lastActivityAt: 150,
  messageCount: 2,
  pendingInputCount: 0,
  routeIds: ['r-tui-idle'],
  surfaceKinds: ['tui'],
  participants: [{ surfaceKind: 'tui', surfaceId: 'goodvibes-tui-local', lastSeenAt: 150 }],
  metadata: {},
  // No activeAgentId → canSteer is false → the composer offers a follow-up instead.
  messages: [
    { id: 'm1', role: 'user', body: 'Tighten the splash boundary math.', createdAt: 60 },
    { id: 'm2', role: 'assistant', body: 'Done: wide/narrow glyph typography preserved exactly.', createdAt: 150 },
  ],
};

export const CLOSED_SESSION: SeedSession = {
  id: 's-webui-closed',
  kind: 'webui',
  project: 'goodvibes-webui',
  title: 'Closed operator surface',
  status: 'closed',
  createdAt: 10,
  updatedAt: 90,
  lastActivityAt: 90,
  messageCount: 5,
  pendingInputCount: 0,
  routeIds: ['r-webui-closed'],
  surfaceKinds: ['webui'],
  participants: [{ surfaceKind: 'webui', surfaceId: 'goodvibes-webui', lastSeenAt: 90 }],
  metadata: {},
  messages: [{ id: 'm1', role: 'user', body: 'Archive this one.', createdAt: 90 }],
};

export const SEED_SESSIONS: SeedSession[] = [STEERABLE_SESSION, FOLLOWUP_SESSION, CLOSED_SESSION];

/**
 * The wire's session-record shape (SharedSessionRecordResponse), shared verbatim by
 * sessions.list / sessions.get / sessions.messages.list on the real operator contract
 *, never messages, which is a sibling field on those envelopes, not part of this
 * record. Building it from one place keeps every mocked "session" field the same
 * shape wherever it appears, so a contract change only needs fixing here.
 */
export function sessionRecord(session: SeedSession) {
  return {
    id: session.id,
    kind: session.kind,
    project: session.project,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    messageCount: session.messageCount,
    pendingInputCount: session.pendingInputCount,
    routeIds: session.routeIds,
    surfaceKinds: session.surfaceKinds,
    participants: session.participants,
    ...(session.activeAgentId ? { activeAgentId: session.activeAgentId } : {}),
    metadata: session.metadata,
  };
}

/** The wire's message-record shape, shared by sessions.get / sessions.messages.list. */
export function contractMessage(sessionId: string, message: SeedMessage) {
  return {
    id: message.id,
    sessionId,
    role: message.role,
    body: message.body,
    createdAt: message.createdAt,
    metadata: {},
  };
}

/** A stub session record for an id the seed doesn't know, still contract-shaped. */
function unknownSession(sessionId: string): SeedSession {
  return {
    id: sessionId,
    kind: 'unknown',
    project: '',
    title: '',
    status: 'closed',
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: [],
    participants: [],
    metadata: {},
    messages: [],
  };
}

export function unionListResponse() {
  return {
    totals: {
      sessions: SEED_SESSIONS.length,
      active: SEED_SESSIONS.filter((s) => s.status === 'active').length,
      closed: SEED_SESSIONS.filter((s) => s.status === 'closed').length,
    },
    sessions: SEED_SESSIONS.map(sessionRecord),
  };
}

/** sessions.get / sessions.messages.list share this {session, messages} envelope shape. */
export function messagesResponse(sessionId: string) {
  const session = SEED_SESSIONS.find((s) => s.id === sessionId) ?? unknownSession(sessionId);
  return {
    session: sessionRecord(session),
    messages: session.messages.map((m) => contractMessage(session.id, m)),
  };
}

/**
 * Provider pills fixture, the REAL providers.list wire shape (verified against the
 * SDK's operator-contract.json): each provider carries `providerId`/`active`/
 * `modelCount`/`models` at top level and its auth health nested at
 * `runtime.auth.routes[].freshness` (with `runtime.auth.mode`/`configured`). There is
 * NO top-level `authenticated`/`freshnessSeconds` on the wire, the old fixture invented
 * those, and deriveProviderStatus (which only reads `runtime.auth.routes[].freshness`)
 * ignored them, so every pill fell through to 'status unavailable' and the freshness
 * ladder was never exercised (F5). This fixture drives the full ladder, healthy /
 * expiring / expired / unconfigured / status-unavailable (routes genuinely absent),
 * one per provider, so the pills screenshot proves each state.
 *
 * SECOND DRIFT CAUGHT BY the contract-shape assertion: the top-level `models` field is
 * priced model SUMMARIES (`{id, registryKey, displayName, selectable, contextWindow,
 * pricing?}`), per operator-contract.json, NOT the plain model-id strings this
 * fixture used to put there (it reused the same string list for both the top-level
 * field and `runtime.models.models`, which really is a plain string array). Reading
 * side (modelOptionsFromProvider, provider-models.ts) is tolerant of either shape via
 * normalizeModel(), so the app behavior this fixture drives is unchanged, but the
 * fixture itself was structurally wrong until this assertion caught it.
 */
export function providersResponse() {
  const provider = (
    providerId: string,
    active: boolean,
    auth: {
      mode: 'api-key' | 'oauth' | 'anonymous' | 'none';
      configured: boolean;
      detail?: string;
      routes: {
        route: string;
        label: string;
        configured: boolean;
        usable?: boolean;
        freshness?: string;
        detail?: string;
        repairHints?: string[];
      }[];
    },
    modelIds: string[],
    // Real, optional per-model tier/pricing, additive only (existing callers that
    // omit this keep the exact prior shape). Mirrors what providers.list genuinely
    // populates today (packages/sdk/src/platform/providers/runtime-snapshot.ts's
    // toModelSnapshot) for the ModelWorkspaceModal price-filter/group proofs.
    // pricing.source is contract-required now (the SDK's runtime snapshot stamps
    // every priced model with its provenance); asOf is the optional dated stamp.
    pricing: Record<
      string,
      {
        tier?: string;
        pricing?: {
          inputPerMillionTokens: number;
          outputPerMillionTokens: number;
          currency: string;
          source: 'user' | 'provider' | 'catalog';
          asOf?: string;
        };
      }
    > = {},
  ) => ({
    providerId,
    active,
    modelCount: modelIds.length,
    models: modelIds.map((modelId) => ({
      id: modelId,
      registryKey: `${providerId}:${modelId}`,
      displayName: modelId,
      selectable: true,
      contextWindow: 200_000,
      ...pricing[modelId],
    })),
    runtime: {
      auth: { mode: auth.mode, configured: auth.configured, detail: auth.detail, routes: auth.routes },
      models: { models: modelIds, defaultModel: modelIds[0] },
    },
  });

  return {
    providers: [
      provider('anthropic', true, {
        mode: 'oauth',
        configured: true,
        routes: [{ route: 'oauth', label: 'Claude Pro/Max', configured: true, usable: true, freshness: 'healthy' }],
      }, ['claude-opus-4-8'], {
        'claude-opus-4-8': { tier: 'subscription' },
      }),
      provider('openai', true, {
        mode: 'api-key',
        configured: true,
        routes: [{ route: 'api-key', label: 'API key', configured: true, usable: true, freshness: 'expiring', detail: 'Token refreshes soon' }],
      }, ['gpt-5'], {
        'gpt-5': { tier: 'premium', pricing: { inputPerMillionTokens: 5, outputPerMillionTokens: 15, currency: 'USD', source: 'catalog', asOf: '2026-07-01T00:00:00.000Z' } },
      }),
      provider('google', true, {
        mode: 'api-key',
        configured: true,
        routes: [{
          route: 'api-key',
          label: 'API key',
          configured: true,
          usable: false,
          freshness: 'expired',
          detail: 'Credentials expired: re-authenticate',
          repairHints: ['Run: gv auth google'],
        }],
      }, ['gemini-3']),
      provider('mistral', false, {
        mode: 'none',
        configured: false,
        routes: [{ route: 'api-key', label: 'API key', configured: false, freshness: 'unconfigured' }],
      }, ['mistral-large']),
      // Health genuinely absent: no routes at all → the honest 'status unavailable'
      // state (distinct from 'unconfigured').
      provider('ollama', true, {
        mode: 'anonymous',
        configured: true,
        routes: [],
      }, ['llama-4'], {
        'llama-4': { tier: 'free' },
      }),
    ],
  };
}

/** models.current()'s real shape (CurrentModelResponse), the counterpart to
 *  providersResponse()'s 'claude-opus-4-8' model, so ModelWorkspaceModal's
 *  "current" highlighting has a genuine match in the same fixture set. */
export function modelsCurrentResponse() {
  return {
    model: { registryKey: 'anthropic:claude-opus-4-8', provider: 'anthropic', id: 'claude-opus-4-8' },
    configured: true,
    configuredVia: 'subscription',
  };
}

/**
 * config.get()'s shape, a small, realistic slice of configManager.getAll(),
 * including one surfaces.* secret-shaped key so the settings e2e proof can
 * confirm it never renders raw in the browser.
 */
export function configGetResponse() {
  return {
    display: { theme: 'vaporwave' },
    provider: { model: 'anthropic:claude-opus-4', embeddingProvider: 'hashed-local' },
    helper: { enabled: false, globalProvider: '', globalModel: '' },
    behavior: { hitlMode: 'balanced' },
    tools: { llmEnabled: false, llmProvider: '', llmModel: '' },
    tts: { provider: 'elevenlabs', voice: '', llmProvider: '', llmModel: '', speed: 1 },
    surfaces: { slack: { botToken: 'xoxb-e2e-hermetic-secret-9999' } },
  };
}

/** accounts.snapshot()'s real shape (ProviderAccountSnapshot). */
export function accountsSnapshotResponse() {
  return {
    capturedAt: Date.now(),
    configuredCount: 1,
    issueCount: 1,
    providers: [
      {
        providerId: 'anthropic',
        active: true,
        modelCount: 2,
        configured: true,
        activeRoute: 'subscription',
        authFreshness: 'expiring',
        usageWindows: [{ label: '5-hour window', detail: 'Rolling usage limit may apply.' }],
        issues: ['Subscription token refreshes soon.'],
        recommendedActions: ['Re-authenticate before it expires.'],
      },
      {
        providerId: 'openai',
        active: false,
        modelCount: 0,
        configured: false,
        activeRoute: 'unconfigured',
        authFreshness: 'unconfigured',
        usageWindows: [],
        issues: [],
        recommendedActions: [],
      },
    ],
  };
}

/**
 * Memory records fixture (memory.records.* / memory.review-queue, SDK 1.1.0). Shapes
 * are cross-checked against the daemon's own MEMORY_RECORD_SCHEMA
 * (operator-contract-schemas-runtime.js) the same way the session/provider fixtures
 * above are checked against their contracts, id/scope/cls/summary/tags/provenance/
 * reviewState/confidence/createdAt/updatedAt required, detail/reviewedAt/reviewedBy/
 * staleReason optional.
 */
export interface SeedMemoryRecord {
  id: string;
  scope: 'session' | 'project' | 'team';
  cls: string;
  summary: string;
  detail?: string;
  tags: string[];
  provenance: { kind: string; ref: string; label?: string }[];
  reviewState: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
  confidence: number;
  reviewedAt?: number;
  reviewedBy?: string;
  staleReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** A plain fresh fact, the default "everything is fine" record. */
export const MEMORY_FACT: SeedMemoryRecord = {
  id: 'mem-fact-1',
  scope: 'project',
  cls: 'fact',
  summary: 'The daemon is the single writer for the canonical memory store',
  detail: 'Client surfaces route writes through memory.records.* rather than opening the store file directly.',
  tags: ['memory', 'architecture'],
  provenance: [{ kind: 'session', ref: 's-agent-live', label: 'Refactor the session spine' }],
  reviewState: 'fresh',
  confidence: 82,
  createdAt: 1_000,
  updatedAt: 1_000,
};

/** A record waiting in the review queue, low-enough confidence / fresh enough to
 * be prioritized, distinct from MEMORY_FACT so the journey can tell them apart. */
export const MEMORY_REVIEW_CANDIDATE: SeedMemoryRecord = {
  id: 'mem-review-1',
  scope: 'project',
  cls: 'incident',
  summary: 'Splash boundary math regressed once during a wide-glyph edit',
  tags: ['splash'],
  provenance: [{ kind: 'file', ref: 'src/splash.ts' }],
  reviewState: 'fresh',
  confidence: 55,
  createdAt: 2_000,
  updatedAt: 2_000,
};

/** A VIBE.md persona/preference line, cls 'constraint', tagged 'vibe', the read
 * surface MemoryView projects into its Personas panel. */
export const MEMORY_PERSONA: SeedMemoryRecord = {
  id: 'mem-persona-1',
  scope: 'project',
  cls: 'constraint',
  summary: 'Use plain, concrete, descriptive language',
  detail: 'Name the files, functions, and behavior explicitly; avoid security-flavored jargon.',
  tags: ['vibe'],
  provenance: [{ kind: 'file', ref: 'VIBE.md' }],
  reviewState: 'reviewed',
  confidence: 90,
  reviewedAt: 1_500,
  reviewedBy: 'operator',
  createdAt: 500,
  updatedAt: 1_500,
};

export const SEED_MEMORY_RECORDS: SeedMemoryRecord[] = [MEMORY_FACT, MEMORY_REVIEW_CANDIDATE, MEMORY_PERSONA];

export function memoryRecordWire(record: SeedMemoryRecord) {
  return {
    id: record.id,
    scope: record.scope,
    cls: record.cls,
    summary: record.summary,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    tags: record.tags,
    provenance: record.provenance,
    reviewState: record.reviewState,
    confidence: record.confidence,
    ...(record.reviewedAt !== undefined ? { reviewedAt: record.reviewedAt } : {}),
    ...(record.reviewedBy !== undefined ? { reviewedBy: record.reviewedBy } : {}),
    ...(record.staleReason !== undefined ? { staleReason: record.staleReason } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Consolidation candidates fixture (knowledge.candidates.list / .candidate.get),
 * the wire shape per method-catalog-knowledge.ts's KNOWLEDGE_CANDIDATE_SCHEMA:
 * id/candidateType/status/title/score/evidence/metadata/createdAt/updatedAt
 * required, summary/subjectKind/subjectId optional-but-present here.
 */
export function knowledgeCandidatesResponse() {
  return {
    candidates: [
      {
        id: 'cand-1',
        candidateType: 'promotion',
        status: 'pending',
        subjectKind: 'session',
        subjectId: 's-agent-live',
        title: 'Promote the session-spine keepalive decision',
        summary: 'Referenced across three sessions: a durable-memory candidate.',
        score: 0.86,
        evidence: ['s-agent-live', 's-tui-idle'],
        metadata: {},
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'cand-2',
        candidateType: 'refresh',
        status: 'accepted',
        subjectKind: 'source',
        subjectId: 'src-1',
        title: 'Refresh the daemon architecture source',
        summary: 'Already accepted in an earlier session.',
        score: 0.41,
        evidence: [],
        metadata: {},
        createdAt: 900,
        updatedAt: 1100,
      },
    ],
  };
}

export function knowledgeCandidateDecideResponse(id: string, decision: string) {
  return {
    candidate: {
      id,
      candidateType: 'promotion',
      status: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'superseded',
      title: 'Promote the session-spine keepalive decision',
      score: 0.86,
      evidence: [],
      metadata: {},
      createdAt: 1000,
      updatedAt: 2000,
    },
  };
}

/**
 * knowledge.packet fixture, KNOWLEDGE_PACKET_SCHEMA shape, now the final SDK's real
 * (required, not optional) truncation fields: truncated/totalCandidates/droppedCount/
 * droppedForBudget/budgetExhausted (packet.ts). `truncated: false` (default) is the
 * every-candidate-fit case, no disclosure should render. `truncated: true` answers a
 * genuinely truncated packet where the token budget was the binding constraint
 * (droppedForBudget > 0, budgetExhausted: true), proving KnowledgePacketPanel's
 * disclosure renders from the real post-1.2.0 wire shape.
 */
export function knowledgePacketResponse(task: string, truncated = false) {
  return {
    task,
    writeScope: [],
    generatedAt: 1234,
    detail: 'standard',
    strategy: 'hybrid-recall',
    budgetLimit: 4000,
    estimatedTokens: 180,
    truncated,
    totalCandidates: truncated ? 20 : 1,
    droppedCount: truncated ? 19 : 0,
    droppedForBudget: truncated ? 19 : 0,
    budgetExhausted: truncated,
    items: [
      {
        kind: 'source',
        id: 'src-1',
        title: 'Session spine decision record',
        summary: 'Timer-driven keepalive design.',
        reason: 'directly relevant to the task',
        score: 0.91,
        estimatedTokens: 180,
        related: [],
        evidence: [],
        metadata: {},
      },
    ],
  };
}

/**
 * Calendar events fixture (calendar.events.list/.get), the wire shape per
 * method-catalog-calendar.ts's CALENDAR_EVENT_SUMMARY_SCHEMA/DETAIL_SCHEMA.
 *
 * Dated relative to today so they fall inside the view's default 15-day agenda
 * window: ev-1 tomorrow morning, ev-2 the day after. The seed lists ev-2 first
 * so the e2e sort-by-start proof has something to sort. ev-old sits two months
 * back, outside the default window, so a range the mock honors visibly drops it.
 */
function seedDay(offsetDays: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setUTCHours(hour, minute, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString();
}

function calendarSeedEvents() {
  return [
    {
      id: 'ev-2',
      title: 'Design review',
      start: seedDay(2, 15),
      end: seedDay(2, 16),
      location: 'Room B',
    },
    {
      id: 'ev-1',
      title: 'Team standup',
      start: seedDay(1, 9),
      end: seedDay(1, 9, 15),
    },
    {
      id: 'ev-old',
      title: 'Quarter kickoff',
      start: seedDay(-60, 14),
      end: seedDay(-60, 15),
    },
  ];
}

/**
 * calendar.events.list: like the daemon, only events that overlap the requested
 * window (`from` / `to`, ISO strings; either may be absent) come back.
 */
export function calendarEventsResponse(range: { from?: string | null; to?: string | null } = {}) {
  const fromMs = range.from ? Date.parse(range.from) : Number.NEGATIVE_INFINITY;
  const toMs = range.to ? Date.parse(range.to) : Number.POSITIVE_INFINITY;
  return {
    events: calendarSeedEvents().filter((event) => Date.parse(event.end) >= fromMs && Date.parse(event.start) <= toMs),
  };
}

export function calendarEventDetailResponse(eventId: string) {
  const base = calendarSeedEvents().find((event) => event.id === eventId);
  return {
    id: eventId,
    uid: `${eventId}@goodvibes`,
    title: base?.title ?? 'Unknown event',
    start: base?.start ?? seedDay(1, 9),
    end: base?.end ?? seedDay(1, 9, 15),
    ...(base?.location ? { location: base.location } : {}),
    description: 'Seeded e2e fixture event.',
    attendees: ['Operator'],
  };
}

/**
 * Email fixtures (email.inbox.list / email.inbox.read). Field-for-field the SDK's
 * EMAIL_INBOX_MESSAGE_SCHEMA and EMAIL_MESSAGE_DETAIL_SCHEMA, every required key
 * present, and the optional ones (bodyHtml, attachments) present on exactly one
 * message so the peek can be proven to list attachments AND to refuse to render an
 * HTML part, rather than only ever seeing the plain case.
 */
export function emailInboxResponse() {
  return {
    messages: [
      {
        uid: 1002,
        from: 'ops@example.com',
        subject: 'Nightly build finished',
        date: '2026-08-02T06:12:00.000Z',
        unread: true,
        bodyPreview: 'All three jobs are green. Artifacts are attached.',
        messageId: '<build-1002@example.com>',
      },
      {
        uid: 1001,
        from: 'someone@example.com',
        subject: 'Re: scheduling next week',
        date: '2026-08-01T17:40:00.000Z',
        unread: false,
        bodyPreview: 'Tuesday afternoon works for me.',
        messageId: '<sched-1001@example.com>',
      },
    ],
    total: 2,
  };
}

export function emailMessageDetailResponse(uid: number) {
  const summary = emailInboxResponse().messages.find((message) => message.uid === uid);
  const hasExtras = uid === 1002;
  return {
    uid,
    from: summary?.from ?? 'unknown@example.com',
    subject: summary?.subject ?? 'Unknown message',
    date: summary?.date ?? '2026-08-01T00:00:00.000Z',
    messageId: summary?.messageId ?? `<${uid}@example.com>`,
    bodyText: 'Seeded e2e fixture body.\nSecond line.',
    ...(hasExtras
      ? {
          bodyHtml: '<p>Seeded <b>HTML</b> alternative that the console must not render.</p>',
          attachments: [
            { filename: 'build-log.txt', contentType: 'text/plain', sizeBytes: 2048 },
          ],
        }
      : {}),
  };
}

/**
 * The honest refusal shapes for the email surface. NOT_CONFIGURED is the 412
 * precondition refusal (an account has not been brought); NOT_INVOKABLE is the 501
 * every daemon build answers TODAY, because the four email verbs ship
 * `invokable: false` and no /api/email route is served yet.
 */
export const EMAIL_NOT_CONFIGURED_BODY = { error: 'No mail account is configured. Set the mail host and account, and store the app password in the daemon secret tier.', code: 'EMAIL_NOT_CONFIGURED' };
export const EMAIL_NOT_INVOKABLE_BODY = { error: 'Gateway method is cataloged but not invokable through method dispatch', code: 'METHOD_NOT_INVOKABLE' };

export const CALENDAR_NOT_CONFIGURED_BODY = { error: 'CalDAV is not configured. Set surfaces.calendar.caldavUrl and surfaces.calendar.caldavUser.', code: 'CALENDAR_NOT_CONFIGURED' };

/**
 * Occasions/plans fixtures (occasions.list / occasions.plans.list / occasions.pending
 * / occasions.state), the dates panel (docs/occasions.md). Field-for-field the SDK's
 * generated shapes: one occasion with a real next-occurrence date (occasions.list is
 * the explicit-ask read that carries one, docs/occasions.md §4.3), one plan, one
 * outstanding nudge whose subjects carry a proximity WORD and never a date, and one
 * in-progress gift interview so the Open items section has real content to render.
 */
export function occasionsListResponse(): OperatorMethodOutput<'occasions.list'> {
  return {
    today: '2026-07-29',
    timezone: 'America/Chicago',
    occasions: [
      {
        occasion: {
          id: 'occ-e2e-1',
          title: 'Sarah’s birthday',
          date: { kind: 'recurring' as const, month: 3, day: 14 },
          recurrence: 'annual' as const,
          kind: 'gift-giving' as const,
          person: 'Sarah',
          selfDeclared: false,
          subject: 'other' as const,
          leadDays: 21,
          mirrored: false,
          extras: [],
          lineIndex: 0,
          text: 'Sarah’s birthday · 03-14 · annual · gift-giving · for Sarah · lead 21',
        },
        nextOccurrence: '2027-03-14T00:00:00.000Z',
        daysUntil: 228,
        leadDays: 21,
        inLeadWindow: false,
        answer: null,
        mirrored: false,
      },
      {
        occasion: {
          id: 'occ-e2e-2',
          title: 'Dad',
          date: { kind: 'recurring' as const, month: 11, day: 2 },
          recurrence: 'annual' as const,
          kind: 'remember-only' as const,
          person: 'Dad',
          selfDeclared: false,
          subject: 'other' as const,
          leadDays: 10,
          mirrored: false,
          extras: [],
          lineIndex: 1,
          text: 'Dad · 11-02 · annual · remember-only',
        },
        nextOccurrence: '2026-11-02T00:00:00.000Z',
        daysUntil: 96,
        leadDays: 10,
        inLeadWindow: false,
        answer: 'yes' as const,
        mirrored: false,
      },
    ],
    unparsed: [],
    conflicts: [],
  };
}

export function occasionsPlansListResponse(): OperatorMethodOutput<'occasions.plans.list'> {
  return {
    today: '2026-07-29',
    plans: [
      {
        id: 'plan-e2e-1',
        title: 'Lisbon',
        from: '2026-09-12T00:00:00.000Z',
        to: '2026-09-19T00:00:00.000Z',
        away: true,
        destination: 'Lisbon',
        extras: [],
        lineIndex: 2,
        text: 'Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon',
      },
    ],
    unparsed: [],
    awayNow: null,
  };
}

/**
 * occasions.pending, deliberately never carries a date, only the proximity word
 * (docs/occasions.md §4.3). One nudge subject, one in-progress interview so the
 * webui's answer/continue-interview actions have something real to act on.
 */
export function occasionsPendingResponse(): OperatorMethodOutput<'occasions.pending'> {
  return {
    today: '2026-07-29',
    // Platform 2.0.9: occurrences acknowledged this cycle (muted pushes).
    acknowledged: [],
    nudge: {
      id: 'nudge-e2e-1',
      raisedAt: 1_753_700_000_000,
      subjects: [
        { occasionId: 'occ-e2e-1', title: 'Sarah’s birthday', person: 'Sarah', kind: 'gift-giving' as const, proximity: 'approaching' as const, subject: 'other' as const, acknowledged: false },
      ],
      message: 'Sarah’s birthday is approaching.',
      answerable: true,
    },
    conflicts: [],
    interviews: [
      {
        interviewId: 'iv-e2e-1',
        occasionId: 'occ-e2e-1',
        occurrence: '2027-03-14',
        steps: [{ id: 'step-1', prompt: 'What has she mentioned wanting lately?', opensFrom: '2027-02-21' }],
        nextStep: { id: 'step-1', prompt: 'What has she mentioned wanting lately?', opensFrom: '2027-02-21' },
        complete: false,
        landedOn: null,
      },
    ],
  };
}

export function occasionsStateResponse(): OperatorMethodOutput<'occasions.state'> {
  return {
    path: '/tmp/e2e/occasions-state.json',
    acknowledgements: 1,
    giftRecords: 2,
    openItems: 1,
    interviews: 1,
    mirrors: 0,
    reconciledOpenItems: 0,
    lastSweep: {
      sweptAt: 1_753_700_000_000,
      expiredAcknowledgements: 0,
      orphanedRecords: 0,
      expiredOpenItems: 0,
      agedGiftRecords: 0,
      droppedInterviews: 0,
      staleMirrors: 0,
    },
    corruption: null,
  };
}

export function occasionsGiftsResponse(occasionId: string): OperatorMethodOutput<'occasions.gifts'> {
  return {
    occasionId,
    gifts: occasionId === 'occ-e2e-2'
      ? [{ occasionId, occurrence: '2025-11-02', recordedAt: 1_753_600_000_000, landedOn: 'A framed photo', notes: 'He mentioned this last year.' }]
      : [],
  };
}

/** The honest not-available refusal, matching mail/calendar's shape for a brand-new
 * verb family that may not be wired on every daemon build yet. */
export const OCCASIONS_NOT_INVOKABLE_BODY = { error: 'Gateway method is cataloged but not invokable through method dispatch', code: 'METHOD_NOT_INVOKABLE' };

/** A tiny valid SVG for the knowledge map render proof. */
export function knowledgeMapResponse() {
  return {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#0a0a14"/><circle cx="60" cy="60" r="18" fill="#00ffff"/><circle cx="150" cy="40" r="14" fill="#ff00ff"/><line x1="60" y1="60" x2="150" y2="40" stroke="#8ab" stroke-width="2"/><text x="40" y="100" fill="#cde" font-size="10">knowledge map</text></svg>',
    nodes: [{ id: 'n1', label: 'session-spine' }, { id: 'n2', label: 'daemon' }],
    jobs: [],
  };
}

// ─── Fleet / approvals / watchers (WEBUI-FLEET-DEPTH) ─────────────────────────
//
// fleet.snapshot's node ids/kinds mirror the SDK's real fleet.snapshot shape
// (see src/lib/goodvibes.ts's FleetProcessNode). FLEET_AGENT_NODE.sessionRef.sessionId
// deliberately equals STEERABLE_SESSION.id so the steer/detach/"approve from the tree"
// proofs exercise the SAME seeded session the hero journey
// (hero-steer-from-phone.e2e.ts) already steers, and PENDING_APPROVAL.sessionId
// matches it too, so lib/fleet.ts's approvalsForNode correlation fires for real.

export const FLEET_AGENT_NODE: WithRequired<FleetProcessNode, 'sessionRef'> = {
  id: 'agent-42',
  kind: 'agent',
  label: 'Refactor the session spine',
  state: 'executing-tool',
  elapsedMs: 12_000,
  startedAt: 100,
  costUsd: 0.08,
  costState: 'priced',
  // Provenance on the wire: this node's dollars were priced from the catalog,
  // dated, the node's PriceSourceNote renders "catalog price, as of Jul 1, 2026".
  costSource: 'catalog',
  pricingAsOf: '2026-07-01T00:00:00.000Z',
  model: 'claude-3-5-haiku',
  provider: 'anthropic',
  capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
  usage: { inputTokens: 200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 3, turnCount: 2, toolCallCount: 4 },
  sessionRef: { sessionId: STEERABLE_SESSION.id, agentId: 'agent-42' },
  // Read-model tells (rounds 4-6): the derived one-line headline (replaced in
  // place on task/phase transitions) and the stall tell (pure timestamp
  // comparison on a live node) ride the snapshot nodes.
  headline: { text: 'Migrating the session spine to the new store', updatedAt: 110 },
  stall: { since: 1_700_000_000_000, quietForMs: 6 * 60_000 },
};

export const FLEET_WATCHER_NODE: FleetProcessNode = {
  id: 'watcher-docs',
  kind: 'watcher',
  label: 'Docs watcher',
  state: 'idle',
  elapsedMs: 0,
  costState: 'unpriced',
  capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
};

// A node the daemon flagged as blocked on the operator (needsAttention). Its
// startedAt is the OLDEST of the roots so the attention-first sibling sort has
// something to prove, despite being oldest it floats to the top. Deliberately a
// distinct session with no pending approval so it does not correlate with
// PENDING_APPROVAL (the reason is 'input', not 'approval'). This node is also the
// needs-input deep-link target (fleet-focus-link).
export const FLEET_BLOCKED_NODE: WithRequired<FleetProcessNode, 'sessionRef' | 'needsAttention'> = {
  id: 'agent-blocked-7',
  kind: 'agent',
  label: 'Waiting on your answer',
  state: 'awaiting-approval',
  elapsedMs: 3000,
  startedAt: 50,
  costState: 'unpriced',
  capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
  needsAttention: { reason: 'input', detail: 'Which migration should I run?' },
  sessionRef: { sessionId: 'session-blocked', agentId: 'agent-blocked-7' },
};

// A node that does NOT exist in the baseline snapshot, the mock daemon adds it
// only AFTER a fleet event has been delivered over the subscription (see
// installMockDaemon's fleetEvents option), so an e2e can prove the subscription
// drove a live tree update rather than a poll.
export const FLEET_EVENT_NODE: FleetProcessNode = {
  id: 'agent-live-99',
  kind: 'agent',
  label: 'Started via a fleet event',
  state: 'thinking',
  elapsedMs: 0,
  startedAt: 900,
  costState: 'unpriced',
  capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
};

// 'pick' and 'conflict' (SDK 1.8.0), the SAME waiting-on-human class as 'input' above,
// with their own reason-specific label. A ready best-of-N group and a merge-conflicted
// work item, respectively. Both started BEFORE FLEET_BLOCKED_NODE (startedAt 50) so the
// existing "blocked node floats to the top" proof still holds: among attention-tied
// siblings the newest-started wins the tie-break, and blocked stays newest of the three.
export const FLEET_PICK_NODE: FleetProcessNode = {
  id: 'group:contract-pick-3:g1',
  kind: 'contract-group',
  label: 'Ready to pick a winner',
  state: 'idle',
  elapsedMs: 0,
  startedAt: 30,
  costState: 'unpriced',
  capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  needsAttention: { reason: 'pick' },
};

export const FLEET_CONFLICT_NODE: FleetProcessNode = {
  id: 'unit:contract-conflict-4:u1',
  kind: 'contract-unit',
  label: 'Merge conflict in the checkout flow',
  state: 'stalled',
  elapsedMs: 0,
  startedAt: 20,
  costState: 'unpriced',
  capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  needsAttention: { reason: 'conflict', detail: 'merge conflict in src/checkout.ts' },
};

// The one workstream node whose id matches mock-daemon.ts's FLEET_GRAPH_WORKSTREAM_ID
// ('contract-e2e:g1', kept as a literal here rather than imported to avoid a cycle,
// mock-daemon.ts imports FROM this module), opening it in WorkstreamView/FleetView
// triggers fleet.graph.get for an id the mock actually answers (the representative
// fleetGraphResponse() fixture), proving the task-graph panel end to end.
export const FLEET_GRAPH_WORKSTREAM_NODE: FleetProcessNode = {
  id: 'group:contract-e2e:g1',
  kind: 'contract-group',
  label: 'Fix findings from the review',
  state: 'executing-tool',
  elapsedMs: 60000,
  startedAt: 600,
  costUsd: 0.3,
  costState: 'priced',
  capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 3, turnCount: 3, toolCallCount: 4 },
};

// Observed foreign agents (SDK 1.8.0's read-only externally-launched coding-agent
// visibility), an `observed-external` node goodvibes did not spawn or host. Two
// shapes, matching the SDK's own adaptObservedAgent: a steerable one (a genuine tmux
// channel) and a no-channel one (the daemon's own honest reason, never a dead button).
// Never killable/interruptible/pausable/resumable, and excluded from the toolbar's
// own-agent counts (lib/fleet.ts's activeCount/ownNodeCount/observedNodeCount).
export const FLEET_OBSERVED_STEERABLE_NODE: WithRequired<FleetProcessNode, 'observed'> = {
  id: 'observed:4242',
  kind: 'observed-external',
  label: 'Claude Code (external)',
  task: '/home/user/project',
  state: 'executing-tool',
  elapsedMs: 60000,
  startedAt: 500,
  costState: 'unpriced',
  capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: true },
  observed: {
    externalKind: 'claude-code',
    pid: 4242,
    cwd: '/home/user/project',
    liveness: { state: 'active', cpuSeconds: 12.5, detail: 'CPU time advanced since the last check' },
    steer: { kind: 'tmux', paneId: '%3', tty: '/dev/pts/4' },
    steerDrillInOnly: true,
  },
};

export const FLEET_OBSERVED_NO_CHANNEL_NODE: WithRequired<FleetProcessNode, 'observed'> = {
  id: 'observed:9001',
  kind: 'observed-external',
  label: 'Codex (external)',
  task: '/home/user/other',
  state: 'idle',
  elapsedMs: 30000,
  startedAt: 400,
  costState: 'unpriced',
  capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  observed: {
    externalKind: 'codex',
    pid: 9001,
    cwd: '/home/user/other',
    liveness: {
      state: 'quiet', cpuSeconds: 3.1,
      detail: 'No CPU time observed since the last check. This does not prove the agent is idle',
    },
    steer: { kind: 'none', reason: FLEET_OBSERVED_NO_CHANNEL_REASON },
    steerDrillInOnly: true,
  },
};

export const FLEET_SNAPSHOT = {
  capturedAt: 1000,
  truncated: false,
  totalCount: 8,
  nodes: [
    FLEET_AGENT_NODE, FLEET_WATCHER_NODE, FLEET_BLOCKED_NODE, FLEET_PICK_NODE, FLEET_CONFLICT_NODE,
    FLEET_OBSERVED_STEERABLE_NODE, FLEET_OBSERVED_NO_CHANNEL_NODE, FLEET_GRAPH_WORKSTREAM_NODE,
  ],
};

export const PENDING_APPROVAL = {
  id: 'appr-e2e-1',
  callId: 'call-e2e-1',
  sessionId: STEERABLE_SESSION.id,
  status: 'pending',
  request: {
    callId: 'call-e2e-1',
    tool: 'bash',
    args: { commands: ['bun test --isolate'] },
    category: 'shell',
    analysis: {
      classification: 'command',
      riskLevel: 'medium',
      summary: 'Run the full test suite before merging',
      reasons: ['Modifies test fixtures'],
    },
    // The SDK's buildRememberOptions output for one exec command, labels and
    // details render VERBATIM in the card's remember picker.
    rememberOptions: [
      { tier: 'session', label: 'for the rest of this session', detail: 'in-memory only; forgotten on restart' },
      { tier: 'exact', label: 'this exact command', detail: 'bun test --isolate' },
      { tier: 'command-class', label: 'every bun command', detail: 'bun ...' },
      { tier: 'tool', label: 'always for the bash tool in this project', detail: 'every bash call, any arguments' },
    ],
  },
  createdAt: 500,
  updatedAt: 500,
  metadata: {},
};

// A SECOND pending ask in the same command class (same tool), approving the
// first at the command-class tier must sweep this one at mock level, proving
// the "granted at a tier suppresses the next identical ask" journey.
export const PENDING_APPROVAL_SAME_CLASS = {
  id: 'appr-e2e-2',
  callId: 'call-e2e-2',
  sessionId: STEERABLE_SESSION.id,
  status: 'pending',
  request: {
    callId: 'call-e2e-2',
    tool: 'bash',
    args: { commands: ['bun run typecheck'] },
    category: 'shell',
    analysis: {
      classification: 'command',
      riskLevel: 'medium',
      summary: 'Typecheck the workspace',
      reasons: ['Read-only check'],
    },
    rememberOptions: [
      { tier: 'session', label: 'for the rest of this session', detail: 'in-memory only; forgotten on restart' },
      { tier: 'exact', label: 'this exact command', detail: 'bun run typecheck' },
      { tier: 'command-class', label: 'every bun command', detail: 'bun ...' },
      { tier: 'tool', label: 'always for the bash tool in this project', detail: 'every bash call, any arguments' },
    ],
  },
  createdAt: 520,
  updatedAt: 520,
  metadata: {},
};

// A running command blocked on its own terminal, the exec PTY prompt-answer
// path (tool 'exec:prompt', attribution kind 'exec-prompt'). The card renders
// as ANSWERABLE: the typed reply rides the approve decision's
// modifiedArgs.answer into the waiting run.
export const EXEC_PROMPT_APPROVAL = {
  id: 'appr-exec-prompt-1',
  callId: 'exec-prompt-a1b2c3d4',
  sessionId: STEERABLE_SESSION.id,
  status: 'pending',
  request: {
    callId: 'exec-prompt-a1b2c3d4',
    tool: 'exec:prompt',
    args: {
      command: 'ssh deploy@staging.internal',
      prompt: "The authenticity of host 'staging.internal' can't be established. Continue connecting (yes/no)?",
      recentOutput: "ED25519 key fingerprint is SHA256:9f2ab8.\nThe authenticity of host 'staging.internal' can't be established. Continue connecting (yes/no)?",
    },
    category: 'execute',
    analysis: {
      classification: 'exec-terminal-prompt',
      riskLevel: 'medium',
      summary: "A running command is waiting on its terminal: The authenticity of host 'staging.internal' can't be established. Continue connecting (yes/no)?",
      reasons: ['The command is blocked until this prompt is answered or the run is stopped'],
    },
    attribution: {
      kind: 'exec-prompt',
      command: 'ssh deploy@staging.internal',
      prompt: "The authenticity of host 'staging.internal' can't be established. Continue connecting (yes/no)?",
    },
  },
  createdAt: 530,
  updatedAt: 530,
  metadata: { source: 'exec-prompt', command: 'ssh deploy@staging.internal' },
};

// A pending CI "fix this?" offer, the red-run fix-session ask the ci-watch
// service raises through the approval broker (tool 'ci:fix-session'). Accepting
// it spawns a fix session whose id the broker stamps onto the resolved APPROVED
// record (SDK 1d6a85e2), the mock daemon mirrors that stamp on approve.
export const CI_FIX_OFFER_APPROVAL = {
  id: 'appr-ci-fix-1',
  callId: 'ci-fix-e2e1',
  status: 'pending',
  request: {
    callId: 'ci-fix-e2e1',
    tool: 'ci:fix-session',
    args: { repo: 'acme/example', ref: 'main', failingJobs: ['lint'] },
    category: 'delegate',
    analysis: {
      classification: 'ci-fix-session',
      riskLevel: 'medium',
      summary: 'CI went red on acme/example (main): start a fix session for lint?',
      reasons: [
        'The watched CI run on acme/example reached a failed verdict.',
        "Accepting starts an isolated fix session seeded with the failing jobs' logs; declining leaves the red run untouched.",
      ],
    },
  },
  createdAt: 540,
  updatedAt: 540,
  metadata: { source: 'ci-watch', repo: 'acme/example' },
};

// One pre-seeded durable rule for the permissions-rules view proofs.
export const SEEDED_PERMISSION_RULE = {
  id: 'rule-seeded-1',
  effect: 'allow',
  tier: 'path',
  tool: 'edit',
  description: 'edits under src/**',
  createdAt: 400,
};
