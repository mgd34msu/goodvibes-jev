/**
 * installMockDaemon, the hermetic seam for the Playwright harness.
 *
 * Intercepts every `/api/**` request in the browser and answers it from the in-memory
 * seed (support/seed.ts). NO real daemon is ever contacted, not 3421, not 4444, not
 * any port. The vite dev server the tests run against proxies `/api` to a dead
 * localhost target that is never reached, because these routes short-circuit the
 * request in-page before it leaves the browser.
 *
 * Streams (Accept: text/event-stream) are, by default, left hanging (a "connecting"
 * EventSource that never errors) so the live-updates layer reports neither connected
 * nor paused, a clean baseline. Pass `dropStreams: true` to instead close them
 * immediately, which drives the reconnect/paused honesty (used by the chat
 * degraded-state proof).
 */

import type { Page, Route } from '@playwright/test';
import { createECDH } from 'node:crypto';
import { recordRequests, type RecordedRequest } from './requests';
import {
  wakeClassifierFixture,
  wakeEmbeddingFixture,
  wakeNoticeFixture,
  type WakeModelFixture,
} from './onnx-fixture';
import type { OperatorMethodInput, OperatorMethodOutput } from '../../src/lib/goodvibes';
import { WEBUI_METHOD_SAMPLES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import {
  accountsSnapshotResponse,
  CALENDAR_NOT_CONFIGURED_BODY,
  calendarEventDetailResponse,
  calendarEventsResponse,
  configGetResponse,
  emailInboxResponse,
  emailMessageDetailResponse,
  EMAIL_NOT_CONFIGURED_BODY,
  EMAIL_NOT_INVOKABLE_BODY,
  FLEET_SNAPSHOT,
  FLEET_EVENT_NODE,
  knowledgeCandidateDecideResponse,
  knowledgeCandidatesResponse,
  knowledgeMapResponse,
  knowledgePacketResponse,
  memoryRecordWire,
  messagesResponse,
  modelsCurrentResponse,
  OCCASIONS_NOT_INVOKABLE_BODY,
  occasionsGiftsResponse,
  occasionsListResponse,
  occasionsPendingResponse,
  occasionsPlansListResponse,
  occasionsStateResponse,
  PENDING_APPROVAL,
  providersResponse,
  sessionRecord,
  SEED_MEMORY_RECORDS,
  SEED_SESSIONS,
  unionListResponse,
  type SeedMemoryRecord,
  type SeedSession,
} from './seed';

/**
 * The wire shape of one memory record, the single definition the in-memory store,
 * the add handler, and the review handler all agree on. Sourced from
 * memoryRecordWire() in seed.ts so it cannot drift from the seed.
 */
export type MemoryRecordWire = ReturnType<typeof memoryRecordWire>;

/**
 * Element types for the mutable in-memory lists installMockDaemon keeps, taken from
 * the SAME generated operator contract the views read (CiWatchesView, CheckInView and
 * PrincipalsView each derive their own row type from these exact method outputs).
 *
 * Without these annotations each list's element type was inferred from its single
 * seed literal, `as const` and all, so `lastOverall` was the literal 'passed',
 * `outcome` the literal 'skipped-quiet-hours', and `channelId`/`prNumber`/`provider`
 * did not exist at all. Every handler that appended a row with a different state, or
 * read an optional field, was writing against a type that could not describe the
 * mock's own behavior.
 */
type MockCiWatch = OperatorMethodOutput<'ci.watches.list'>['watches'][number];
type MockCheckinReceipt = OperatorMethodOutput<'checkin.receipts.list'>['receipts'][number];
type MockChannelBinding = OperatorMethodOutput<'channels.profiles.list'>['bindings'][number];

const MEMORY_SCOPES: readonly string[] = ['session', 'project', 'team'];
const MEMORY_REVIEW_STATES: readonly string[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

/**
 * The add/review handlers below take their values from an arbitrary request body,
 * so they must narrow those values to the enumerations the real daemon's
 * MEMORY_RECORD_SCHEMA accepts before storing them. Without this the store would
 * happily hold a record with, say, scope 'banana', a state no real daemon can
 * produce, which would make a test pass against a fiction.
 */
function asMemoryScope(value: unknown): SeedMemoryRecord['scope'] {
  return typeof value === 'string' && MEMORY_SCOPES.includes(value)
    ? (value as SeedMemoryRecord['scope'])
    : 'project';
}

function asMemoryReviewState(
  value: unknown,
  fallback: SeedMemoryRecord['reviewState'],
): SeedMemoryRecord['reviewState'] {
  return typeof value === 'string' && MEMORY_REVIEW_STATES.includes(value)
    ? (value as SeedMemoryRecord['reviewState'])
    : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asProvenanceArray(value: unknown): { kind: string; ref: string; label?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { kind: string; ref: string; label?: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.kind !== 'string' || typeof record.ref !== 'string') continue;
    out.push({
      kind: record.kind,
      ref: record.ref,
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
    });
  }
  return out;
}

/**
 * describeOriginPostureForMock, a byte-for-byte mirror of the daemon's own
 * describeOriginPosture (packages/sdk/src/platform/pairing/origin-posture.ts): the ONE
 * honest plain-http-on-LAN notice line, and per-capability "needs https, available via
 * tailscale" labels, so an e2e test at a simulated private-range origin sees EXACTLY the
 * wording a real daemon would send, never a placeholder the fixture invented.
 */
const LAN_PLAIN_HTTP_NOTICE_MOCK =
  'Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.';
const NEEDS_HTTPS_REASON_MOCK = 'needs https, available via tailscale';
const BROWSER_GATED_CAPABILITIES_MOCK = ['service-worker', 'push', 'microphone'] as const;

function isLoopbackHostMock(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.') || host.endsWith('.localhost');
}

function isPrivateNetworkHostMock(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHostMock(host)) return true;
  if (host.endsWith('.local')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function describeOriginPostureForMock(origin: string): {
  origin: string;
  scheme: string;
  privateNetwork: boolean;
  secureContext: boolean;
  notice?: string;
  capabilities: { capability: string; available: boolean; reason?: string }[];
} {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {
      origin,
      scheme: 'other',
      privateNetwork: false,
      secureContext: false,
      capabilities: BROWSER_GATED_CAPABILITIES_MOCK.map((capability) => ({
        capability, available: false, reason: 'origin is not a valid URL',
      })),
    };
  }
  const scheme = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : 'other';
  const privateNetwork = isPrivateNetworkHostMock(parsed.hostname);
  const secureContext = scheme === 'https' || (scheme === 'http' && isLoopbackHostMock(parsed.hostname));
  const capabilities = BROWSER_GATED_CAPABILITIES_MOCK.map((capability) => (
    secureContext ? { capability, available: true } : { capability, available: false, reason: NEEDS_HTTPS_REASON_MOCK }
  ));
  const plainHttpLan = scheme === 'http' && privateNetwork && !secureContext;
  return {
    origin: parsed.origin,
    scheme,
    privateNetwork,
    secureContext,
    ...(plainHttpLan ? { notice: LAN_PLAIN_HTTP_NOTICE_MOCK } : {}),
    capabilities,
  };
}

/**
 * Shared, mutable pairing-token state for pairing.tokens.*, a plain object
 * (not per-call closure state) so TWO installMockDaemon calls (two Playwright
 * pages/contexts, standing in for two devices) can be pointed at the SAME
 * store and observe each other's writes: revoke one device's token from page A
 * and page B's next request, bearing that same token, genuinely 401s,
 * proving revoke actually signs the device out, while page A's own (different)
 * token keeps working untouched. Create with createMockPairingStore(); pass to
 * installMockDaemon via { pairingStore }.
 */
export interface MockPairingStore {
  tokens: { id: string; name: string; token: string; createdAt: number; lastSeenAt?: number }[];
  legacySharedRevoked: boolean;
  /** Raw token VALUES (not ids) that pairing.tokens.delete has revoked, checked on every request. */
  revokedTokenValues: Set<string>;
}

export function createMockPairingStore(
  seed: readonly { id: string; name: string; token: string; createdAt: number; lastSeenAt?: number }[] = [],
): MockPairingStore {
  return { tokens: [...seed], legacySharedRevoked: false, revokedTokenValues: new Set() };
}

export interface MockDaemonOptions {
  /** Seed a stored token so the app boots signed-in. Default true. */
  signedIn?: boolean;
  /** When true, close SSE streams immediately (drives reconnect/paused states). */
  dropStreams?: boolean;
  /** When false, the sessions.delete capability probe 404s (Delete unavailable). */
  deleteAvailable?: boolean;
  /**
   * GET /config/credentials behavior, the admin-scoped credential-status
   * read (credentials.get). 'available' (default) answers the honest
   * configured/usable list; 'store-unavailable' answers the daemon's real
   * 503 CREDENTIAL_STORE_UNAVAILABLE shape; 'admin-required' answers the
   * real 403 admin-scope refusal shape (control-plane.ts requireAdmin).
   */
  credentials?: 'available' | 'store-unavailable' | 'admin-required';
  /** When false, every /api/memory/* route 404s with the honest
   * `{ code: 'METHOD_NOT_FOUND' }` shape, the "this daemon does not serve memory"
   * degrade MemoryView renders. Default true. */
  memoryAvailable?: boolean;
  /** When true, a semantic memory.records.search request falls back to a literal scan
   * with a stated `indexUnavailableReason`, the honest degraded-search proof.
   * Default false (a semantic request succeeds as semantic). */
  memoryIndexUnavailable?: boolean;
  /**
   * memory.consolidation.receipts (SDK 1.8.0) behavior. 'available' (default) answers
   * one seeded run with a pending contradiction proposal referencing two real seeded
   * memory record ids (mem-fact-1, mem-review-1, both already in the mock review
   * queue), proving the receipts-are-actionable round trip end to end. 'unavailable'
   * answers the daemon's own honest 501 (no consolidation scheduler wired, distinct
   * from memoryAvailable:false's 404, which means the memory.* family itself is
   * absent). 'empty' answers zero receipts and zero pending proposals, the genuinely
   * different "nothing has run yet" honest state.
   */
  consolidationReceipts?: 'available' | 'unavailable' | 'empty';
  /**
   * calendar.* handler behavior. 'configured' (default) answers the honest seeded
   * event fixtures for every calendar.* route. 'unconfigured' answers the daemon's
   * real 412 CALENDAR_NOT_CONFIGURED shape (caldav-client.ts's resolveCalDavConfig
   * refusal) for every calendar.* route, proving the honest bring-your-own-CalDAV
   * state instead of a fabricated empty calendar.
   */
  calendar?: 'configured' | 'unconfigured';
  /**
   * email.* handler behavior. Defaults to 'not-available' ON PURPOSE, because that is
   * what every real daemon build answers today: the four email verbs ship
   * `invokable: false` and the daemon serves no /api/email route at any prefix, so a
   * 501 is the truthful baseline and any test that wants a working inbox has to ask
   * for it explicitly rather than inheriting a fiction. 'configured' answers the
   * seeded inbox fixtures; 'unconfigured' answers the 412 precondition refusal (the
   * handler exists, no account has been brought).
   */
  email?: 'configured' | 'unconfigured' | 'not-available';
  /**
   * occasions.* handler behavior (docs/occasions.md, the dates panel). 'available'
   * (default) answers the honest seeded fixtures for every occasions.* route, unlike
   * calendar.* and email.*, occasions.* ships `invokable: true` from day one in the
   * installed operator-contract.json (it is a builtin daemon feature, not a
   * bring-your-own-account integration), so 'available' is the truthful baseline here.
   * 'not-available' answers the honest 501 every occasions.* route gives on a daemon
   * build that predates this SDK's occasions composition, the same not-wired-yet
   * state calendar/email answer by default, proved so DatesView's notAvailableNote()
   * has a real state to render against.
   */
  occasions?: 'available' | 'not-available';
  /**
   * GET/POST /config behavior (config.get/config.set, the Settings modal and
   * ModelWorkspaceModal's helper/tool/tts/embeddings targets). 'ok' (default)
   * answers a real, mutable config.get()/config.set() round-trip seeded from
   * configGetResponse(); 'admin-required' answers the daemon's real 403
   * admin-scope refusal (system-routes.ts's requireAdmin), matching
   * credentials' 'admin-required' shape.
   */
  config?: 'ok' | 'admin-required';
  /**
   * knowledge.packet response shape. 'complete' (default) answers a real, untruncated
   * packet (truncated: false, droppedCount: 0, budgetExhausted: false), the every-
   * candidate-fit case. 'truncated' answers the final SDK's real truncation field
   * shape (truncated/totalCandidates/droppedCount/droppedForBudget/budgetExhausted all
   * populated, some candidates dropped for the token budget specifically), proving the
   * KnowledgePacketPanel disclosure renders from a genuine post-1.2.0 wire shape rather
   * than only the hand-authored optional subset.
   */
  packet?: 'complete' | 'truncated';
  /**
   * Fleet runtime events to emit over the multiplexed control-plane subscription
   * (the `?domains=…,fleet` stream FleetView now rides). When non-empty, the FIRST
   * request for that stream is fulfilled with these frames as SSE (`event: fleet`,
   * one per entry) instead of being left pending, so a test can prove the
   * subscription path is live. Emitting also flips the fleet snapshot to its
   * ENRICHED form (FLEET_EVENT_NODE appended), so the event-driven invalidation
   * surfaces a node that the baseline snapshot did not contain. Default [] (the
   * existing pending-stream baseline, unchanged for every other test).
   */
  fleetEvents?: readonly unknown[];
  /**
   * sessions.permissionMode.get/set + sessions.contextUsage.get (SDK 1.6.1), the
   * session id these two mocked verbs answer for honestly, standing in for "the
   * daemon's own live local runtime". Any OTHER session id (including '' /
   * unselected) gets the real 404 SESSION_NOT_LOCAL the daemon returns for a session
   * it does not host. Defaults to 's-agent-live' (a seeded session, see seed.ts) so
   * a spec that never touches this option gets the honest-available path for that
   * one session. Pass '' to make every session answer SESSION_NOT_LOCAL instead.
   */
  localSessionId?: string;
  /** Initial session-scoped mode, including the read-only custom rule-set state. */
  initialPermissionMode?: OperatorMethodOutput<'sessions.permissionMode.get'>['mode'];
  /**
   * Seed override for the mutable approvals list (default: [PENDING_APPROVAL]).
   * Pass several pending records to prove the queue renders every one, or an
   * exec-prompt ask (EXEC_PROMPT_APPROVAL) to drive the answerable card.
   */
  approvals?: readonly Record<string, unknown>[];
  /**
   * Seed for the durable approval-rule store (permissions.rules.list/.delete).
   * Default []. Approving with a durable rememberTier also appends here, and
   * SWEEPS other pending asks for the same tool, mirroring the broker's
   * remembered-decision sweep so a suppression test is meaningful at mock level.
   */
  permissionRules?: readonly Record<string, unknown>[];
  /**
   * `control.approval_update` SSE frames to emit over the multiplexed control-plane
   * subscription (the `?domains=…,gate` stream ApprovalsTasksView's push path
   * rides). When non-empty, the FIRST request for a stream whose `?domains=` includes
   * `gate` is fulfilled with these frames (`event: approval-update`, one per
   * entry, each `{ approval, createdAt }`) instead of being left pending, so a test
   * can prove the push-consumption path is live, mirroring `fleetEvents` above.
   * Default [] (the existing pending-stream baseline).
   */
  approvalUpdateFrames?: readonly Record<string, unknown>[];
  /**
   * Seed override for the mutable hosted-sessions store (sessions.hosted.*,
   * daemon-hosted sessions). Default: one idle, attachable session (detach policy survive) and one
   * terminated session (reason 'killed'), real content for the includeTerminated
   * toggle and the terminatedReason line to prove against. Pass [] for the genuinely
   * empty "this daemon hosts nothing" state.
   */
  hostedSessions?: readonly Record<string, unknown>[];
  /**
   * Seed for a hosted session's transcript (sessions.hosted.attach's `history`),
   * keyed by hosted session id. Sessions not listed here attach with an empty
   * history, the honest "nothing happened yet" state.
   */
  hostedSessionHistory?: Readonly<Record<string, readonly { role: string; content: string; at?: number }[]>>;
  /**
   * Raw `turn`/`tools`/`hosted-session-update` frames to emit over the hosted
   * session subscription (the `?domains=session,turn,tools` stream
   * useHostedSessionRealtime opens). When non-empty, the FIRST request for that
   * exact stream is fulfilled with these frames (`event: <entry.event>`, one per
   * entry) instead of being left pending, proving a hosted session's attached
   * view actually receives its live output. Default [] (the existing
   * pending-stream baseline), same one-shot-emission shape as fleetEvents/
   * approvalUpdateFrames above.
   */
  hostedStreamFrames?: readonly { event: 'turn' | 'tools' | 'hosted-session-update'; payload: unknown }[];
  /**
   * Seed for the daemon's undelivered receipt queue, handed over ONCE when
   * control.status is called with receipts=consume (GET /status?receipts=consume).
   * Default []. A plain status read never consumes; a second consume returns
   * none, the "shows once, never re-shows" contract.
   */
  daemonReceipts?: readonly { id: string; text: string; at: number }[];
  /**
   * When set, every CI fix-session spawn attempt FAILS with this error: the
   * approve of a ci:fix-session offer stamps fixSessionError on the approved
   * record (never a dead id), and ci.watches.run returns fixSessionError on the
   * verb result, mirroring SDK bb4b9c30's honest-failure path. Default unset
   * (spawns succeed and mint a real, servable session).
   */
  ciFixSessionError?: string;
  /**
   * Seed the in-memory push-subscription store (push.subscriptions.list/reconcile)
   * with existing records, e.g. a stale record for a specific deviceId, so a test
   * can prove the reconcile-on-open flow (usePushSubscriptionReconcile) detects
   * the drift against the served endpointHash and calls push.subscriptions.reconcile
   * to heal it. Default [] (no prior device registration).
   */
  pushSeed?: readonly { id: string; deviceId?: string; endpointOrigin: string; endpointHash: string; createdAt: number }[];
  /**
   * The pairing.tokens.* backing store. Defaults to a fresh, empty
   * createMockPairingStore() private to this installMockDaemon call. Pass the
   * SAME store to two calls (two pages/devices) to prove cross-device revoke,
   * see MockPairingStore's own header comment.
   */
  pairingStore?: MockPairingStore;
  /**
   * Seed for power.status.get / power.keepAwake.set (SDK 1.8.0's host
   * sleep-ownership work). Default: keep-awake off/unheld, work inhibitor not
   * held, the honest baseline (PowerChip renders nothing, PowerSettings shows
   * the toggle off). Pass a partial to prove a held state (danger chip, "held
   * because X") or the honest lid-split note.
   */
  power?: {
    work?: Partial<MockPowerWorkState>;
    keepAwake?: Partial<MockPowerKeepAwakeState>;
  };
  /**
   * Seed for sessions.queuedMessages.list/edit/delete (SDK 1.8.0's
   * interaction-wins round), keyed by sessionId. Default {} (no session has any
   * queued messages).
   */
  queuedMessages?: Readonly<Record<string, readonly { id: string; queuedAt: number; text: string }[]>>;
  /**
   * Seed for fleet.graph.get (SDK 1.8.0's fix-phase workstream rework), keyed by
   * workstreamId. Default: one representative graph under FLEET_GRAPH_WORKSTREAM_ID
   * (see that constant below) with a ready node, a running node, a
   * blocked-dependency node ("waiting on: X"), a stalled node, and an at-cap pool
   * state, proving every state tell the task-graph panel renders. Any OTHER
   * workstreamId 404s (unknown to this daemon), matching the real verb.
   */
  fleetGraph?: Readonly<Record<string, unknown>>;
  /**
   * Seed for tailscale.get / tailscale.serve.run (SDK 1.8.0's LAN-http posture
   * work, the one-action https affordance). Default: tailscale absent
   * (available:false), the honest, quiet baseline (TailscaleSettings renders
   * nothing). Pass a partial to prove the usable-environment panel (available,
   * loggedIn, magicDnsName, httpsUrl) or a seeded prior serve receipt.
   */
  tailscale?: Partial<MockTailscaleState>;
  /**
   * Seed for ops.memory.get (SDK 1.9.0-dev's memory-governance observability).
   * Default: the representative 'elevated' snapshot opsMemoryResponse() answers (one
   * tier above normal so the chip, bar, caches, paused jobs, and tripwire all render
   * meaningfully). Pass a partial to prove other tiers / an armed tripwire.
   * 'unavailable' answers the 404 an older daemon build gives (the verb id absent),
   * proving the honest "does not serve memory diagnostics" state.
   */
  opsMemory?: Partial<ReturnType<typeof opsMemoryResponse>> | 'unavailable';
  /**
   * Seed for voice.local.status / voice.local.install (SDK 1.9.0-dev's managed
   * local-voice provisioning). Default: not-provisioned with a real offer size,
   * the state that renders the size-labeled "Set up local voice" action. install
   * mutates this state to provisioned and answers the receipt, exactly like the
   * real one-act flow. `installOutcome: 'download-failed'` forces the install
   * receipt's TTS engine to the retriable failure instead (state stays
   * unprovisioned). 'unavailable' answers the 404 of an older daemon build.
   */
  voiceLocal?: {
    status?: Partial<ReturnType<typeof voiceLocalStatusResponse>>;
    installOutcome?: 'provisioned' | 'download-failed';
  } | 'unavailable';
  /**
   * Seed for the three browser wake-word verbs (voice.wake.status /
   * voice.wake.provision / voice.wake.model.get). Default: NOT provisioned, so the
   * default state renders the size-labeled download action and starts no detector.
   *
   * `provisioned: true` serves genuinely loadable ONNX fixtures
   * (support/onnx-fixture.ts) with their real sha256, which is what lets a browser
   * actually create an inference session over daemon-served bytes. `chunkBytes`
   * forces a multi-chunk read; `corruptSha` states a pin the bytes do not match, so
   * the tab's verification failure path is reachable.
   */
  voiceWake?: {
    provisioned?: boolean;
    chunkBytes?: number;
    corruptSha?: boolean;
  } | 'unavailable';
}

/**
 * ops.memory.get's real shape (tier/budget/rss/heap/usage + caches + pausedJobs +
 * tripwire + thresholds), at the representative 'elevated' tier. Exported so
 * assert-contract-shape.test.ts can bind it without a Page.
 */
export function opsMemoryResponse() {
  return {
    tier: 'elevated' as 'normal' | 'elevated' | 'high' | 'critical',
    budgetMb: 1024,
    rssMb: 700,
    heapUsedMb: 320,
    heapTotalMb: 512,
    usedPct: 68,
    refusingExpensiveWork: false,
    caches: [
      { id: 'knowledge-embeddings', name: 'Knowledge embeddings', entries: 4200, estimatedBytes: 15_728_640 },
      { id: 'session-index', name: 'Session index', entries: 128, estimatedBytes: 262_144 },
    ],
    pausedJobs: ['knowledge.reindex'],
    tripwire: { armed: false, sustainedSec: 60, rateMbPerSec: 25 },
    thresholds: { elevatedPct: 60, highPct: 80, criticalPct: 95 },
  };
}

/**
 * voice.local.status's real shape at the not-provisioned baseline (a size-labeled
 * offer, STT supported on this linux-x64 fixture host). Exported so
 * assert-contract-shape.test.ts can bind it without a Page.
 */
export type VoiceLocalStatus = ReturnType<typeof voiceLocalStatusResponse>;

export function voiceLocalStatusResponse() {
  return {
    platform: 'linux-x64' as string | null,
    state: 'not-provisioned' as 'not-provisioned' | 'partial' | 'provisioned' | 'unsupported-platform',
    tts: {
      engine: 'piper',
      binaryPresent: false,
      voicePresent: false,
      binaryPath: '/home/e2e/.goodvibes/voice/engines/piper/piper',
      modelPath: '/home/e2e/.goodvibes/voice/models/en_US-lessac-medium.onnx',
    },
    stt: {
      engine: 'whisper-cpp',
      supported: true,
      state: 'not-provisioned' as 'not-provisioned' | 'partial' | 'provisioned' | 'unsupported-platform',
      binaryPresent: false,
      modelPresent: false,
      binaryPath: '/home/e2e/.goodvibes/voice/engines/whisper/whisper-cli',
      modelPath: '/home/e2e/.goodvibes/voice/models/ggml-base.en.bin',
    },
    // `number | null`, not `number`: the daemon reports no offer size on an
    // unsupported platform, and src/lib/voice/voice-local-setup.ts declares
    // `offerBytes: number | null` for exactly that reason. Leaving this inferred
    // as `number` made the unsupported-platform fixture in voice-mock.ts a type
    // error against the very shape it is meant to reproduce.
    offerBytes: 219_152_211 as number | null,
  };
}

/**
 * voice.local.status's shape DURING an active install (SDK 5357f09e): the same
 * resting fields plus the optional installInProgress section, one component done
 * (byte-labeled), one mid-download (pinned total only, bytes land at completion
 * boundaries, never streamed), one extracting. Exported so
 * assert-contract-shape.test.ts can bind it without a Page.
 */
export function voiceLocalStatusInProgressResponse() {
  return {
    ...voiceLocalStatusResponse(),
    installInProgress: {
      startedAt: 1_752_600_000_000,
      components: [
        { component: 'piper-voice-onnx', phase: 'done', message: 'installed', bytesTotal: 63_201_294, bytesDone: 63_201_294 },
        { component: 'piper-engine', phase: 'download', message: 'fetching piper.tar.gz', bytesTotal: 6_942_130 },
        { component: 'whisper-model', phase: 'extract' },
      ],
    },
  };
}

/**
 * voice.local.install's real receipt shape, fully provisioned by default, or the
 * retriable TTS download failure. Exported so assert-contract-shape.test.ts can bind
 * it without a Page.
 */
export function voiceLocalInstallResponse(outcome: 'provisioned' | 'download-failed' = 'provisioned') {
  const base = voiceLocalStatusResponse();
  if (outcome === 'download-failed') {
    return {
      provisioned: false,
      platform: base.platform,
      tts: { engine: 'piper', state: 'download-failed', reason: 'network timeout fetching piper.tar.gz' },
      stt: { engine: 'whisper-cpp', state: 'download-failed', reason: 'skipped after the TTS engine download failed' },
      components: [{ id: 'piper-voice-onnx', state: 'failed', error: 'network timeout fetching piper.tar.gz' }],
      configured: { set: [], skipped: [] },
    };
  }
  return {
    provisioned: true,
    platform: base.platform,
    tts: { engine: 'piper', state: 'provisioned', binaryPath: base.tts.binaryPath, modelPath: base.tts.modelPath },
    stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: base.stt.binaryPath, modelPath: base.stt.modelPath },
    components: [
      { id: 'piper-voice-onnx', state: 'installed', bytes: 63_201_294 },
      { id: 'piper-voice-json', state: 'installed', bytes: 4_882 },
      { id: 'piper-engine', state: 'installed', bytes: 6_942_130 },
      { id: 'whisper-engine', state: 'installed', bytes: 1_121_557 },
      { id: 'whisper-model', state: 'installed', bytes: 147_964_211 },
    ],
    configured: {
      set: [
        { key: 'voice.local.ttsEngine', value: 'piper' },
        { key: 'voice.local.ttsBinary', value: base.tts.binaryPath },
        { key: 'voice.local.ttsModelPath', value: base.tts.modelPath },
      ],
      skipped: [{ key: 'voice.local.sttBinary', reason: 'already set to a custom value' }],
    },
  };
}

// ─── Browser wake-word verbs ─────────────────────────────────────────────────
//
// voice.wake.status / voice.wake.provision / voice.wake.model.get. The last one is
// the reason these need real handlers rather than the catch-all's `{}`: it is a
// CHUNKED BINARY READ whose caller loops on `offset` and then verifies the assembled
// bytes against the sha256 the response states. An empty object is not a truncated
// answer to that, it is an unparseable one.
//
// The bytes served are genuinely loadable ONNX (support/onnx-fixture.ts), so a
// browser really creates an inference session from what the daemon really sent.

export interface MockWakeState {
  provisioned: boolean;
  /** Bytes per chunk. Small values force the multi-chunk path. */
  chunkBytes: number;
  /** State a pin the bytes do not match, so verification must refuse them. */
  corruptSha: boolean;
}

/** Cap the real verb applies per call: 512 kB. */
export const WAKE_MODEL_CHUNK_BYTES = 512 * 1024;

/**
 * Derived from the generated contract, not copied: the daemon's component set
 * grows, and a mock that refuses a valid one would fail a consumer for a reason
 * the real daemon would not.
 */
export type WakeModelComponentId = OperatorMethodInput<'voice.wake.model.get'>['component'];

/**
 * The same set at RUNTIME, for the mock's own validation. The exhaustiveness check
 * below fails to COMPILE when the contract gains a component this list does not
 * cover, which is the only way a runtime list can be kept honest against a type.
 */
export const WAKE_MODEL_COMPONENT_IDS = [
  'classifier',
  'tflite',
  'embedding',
  'notice',
  'embedding-notice',
  'vad',
  'vad-notice',
] as const;
type UncoveredWakeComponent = Exclude<WakeModelComponentId, (typeof WAKE_MODEL_COMPONENT_IDS)[number]>;
const _everyWakeComponentIsCovered: UncoveredWakeComponent extends never ? true : false = true;
void _everyWakeComponentIsCovered;

export function isWakeModelComponentId(value: unknown): value is WakeModelComponentId {
  return typeof value === 'string' && (WAKE_MODEL_COMPONENT_IDS as readonly string[]).includes(value);
}

function wakeFixtureFor(component: WakeModelComponentId): WakeModelFixture {
  if (component === 'classifier') return wakeClassifierFixture();
  // The tflite twin is served from the classifier fixture: it is the same model in
  // another runtime format, and this mock's job is the transfer, not the format.
  if (component === 'tflite') return wakeClassifierFixture();
  if (component === 'embedding') return wakeEmbeddingFixture();
  // The speech gate is served from the classifier fixture: both are single-score
  // models, and this mock's job is the transfer, not the gate's own numbers.
  if (component === 'vad') return wakeClassifierFixture();
  // Every remaining component is an attribution NOTICE, the classifier's, the
  // front end's, and the gate's. All three are text served over the same path.
  return wakeNoticeFixture();
}

/**
 * voice.wake.status's real shape. Not provisioned by default, an always-on
 * microphone's model is fetched on an explicit act, never because a tab opened.
 */
export function wakeStatusResponse(provisioned = false, vadProvisioned = false) {
  const classifier = wakeClassifierFixture();
  const embedding = wakeEmbeddingFixture();
  const notice = wakeNoticeFixture();
  const artifact = (path: string, fixture: WakeModelFixture) => ({
    path,
    verified: provisioned,
    corrupt: false,
    bytes: provisioned ? fixture.bytes.length : 0,
  });
  return {
    ready: provisioned,
    reason: provisioned ? null : 'The pinned wake-word models are not installed yet.',
    classifier: artifact('/home/e2e/.goodvibes/voice/wake/hey_goodvibes.onnx', classifier),
    embedding: artifact('/home/e2e/.goodvibes/voice/wake/embedding_model.onnx', embedding),
    notice: artifact('/home/e2e/.goodvibes/voice/wake/MODEL_NOTICE.md', notice),
    // The tflite twin: provisioned and servable, but outside `ready`, nothing in
    // a browser tab loads it, so a host missing only this one still detects.
    mobileClassifier: artifact('/home/e2e/.goodvibes/voice/wake/hey_goodvibes.tflite', classifier),
    // The front end's own attribution file, on the same terms as the classifier's:
    // both count toward `ready`, because bytes this daemon serves cannot go out
    // without the NOTICE that must travel with them.
    embeddingNotice: artifact('/home/e2e/.goodvibes/voice/wake/EMBEDDING_NOTICE.md', notice),
    // The speech gate is its own artifact with its own verified state: a host can
    // have the wake models and not the gate, which is what makes
    // `voice.wake.vadThreshold` above 0 a blocker rather than a silent no-op.
    vad: {
      path: '/home/e2e/.goodvibes/voice/wake/goodvibes-vad.onnx',
      verified: vadProvisioned,
      corrupt: false,
      bytes: vadProvisioned ? embedding.bytes.length : 0,
    },
    vadNotice: {
      path: '/home/e2e/.goodvibes/voice/wake/goodvibes-vad.NOTICE.txt',
      verified: vadProvisioned,
      corrupt: false,
      bytes: vadProvisioned ? notice.bytes.length : 0,
    },
    vadReady: vadProvisioned,
    downloadBytes: 3_884_142,
    modelVersion: provisioned ? 'hey_goodvibes-e2e-1' : null,
    recallIsSyntheticOnly: true,
  };
}

/** voice.wake.provision's real receipt shape. */
export function wakeProvisionResponse() {
  return {
    ready: true,
    // Reported beside `ready`, never folded into it: the tflite twin is not loaded
    // here and the speech gate is off unless voice.wake.vadThreshold is raised.
    mobileFormatReady: true,
    vadReady: true,
    modelVersion: 'hey_goodvibes-e2e-1',
    noticePath: '/home/e2e/.goodvibes/voice/wake/MODEL_NOTICE.md',
    embeddingNoticePath: '/home/e2e/.goodvibes/voice/wake/EMBEDDING_NOTICE.md',
    recallIsSyntheticOnly: true,
    outcomes: [
      { component: 'embedding' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/embedding_model.onnx', bytes: wakeEmbeddingFixture().bytes.length },
      { component: 'embedding-notice' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/EMBEDDING_NOTICE.md', bytes: wakeNoticeFixture().bytes.length },
      { component: 'classifier' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/hey_goodvibes.onnx', bytes: wakeClassifierFixture().bytes.length },
      { component: 'notice' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/MODEL_NOTICE.md', bytes: wakeNoticeFixture().bytes.length },
      { component: 'vad' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/goodvibes-vad.onnx', bytes: wakeEmbeddingFixture().bytes.length },
      { component: 'vad-notice' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/goodvibes-vad.NOTICE.txt', bytes: wakeNoticeFixture().bytes.length },
      { component: 'mobile-classifier' as const, state: 'installed' as const, path: '/home/e2e/.goodvibes/voice/wake/hey_goodvibes.tflite', bytes: wakeClassifierFixture().bytes.length },
    ],
  };
}

/**
 * One chunk of voice.wake.model.get, exactly as the real verb answers: the slice at
 * `offset`, the whole file's total and PINNED sha256, and `complete` on the last one.
 */
export function wakeModelChunkResponse(
  component: WakeModelComponentId,
  offset: number,
  state: Pick<MockWakeState, 'chunkBytes' | 'corruptSha'>,
) {
  const fixture = wakeFixtureFor(component);
  const start = Math.max(0, Math.min(offset, fixture.bytes.length));
  const slice = fixture.bytes.subarray(start, start + state.chunkBytes);
  return {
    component,
    offset: start,
    bytes: slice.length,
    totalBytes: fixture.bytes.length,
    sha256: state.corruptSha ? 'f'.repeat(64) : fixture.sha256,
    dataBase64: Buffer.from(slice).toString('base64'),
    complete: start + slice.length >= fixture.bytes.length,
  };
}

/** tailscale.get's real shape (see MockDaemonOptions.tailscale above). */
export interface MockTailscaleState {
  available: boolean;
  loggedIn: boolean;
  magicDnsName?: string;
  httpsUrl?: string;
  detail: string;
  lastServe?: { at: number; command: string; ok: boolean; url?: string; detail: string };
  /**
   * Test-only seed knob (never part of the real wire shape, stripped before this
   * daemon answers tailscale.get): forces the NEXT tailscale.serve.run to fail with
   * this detail text even though the environment otherwise reports usable, proves
   * a genuine mid-setup failure (e.g. a permission error) renders the daemon's own
   * receipt detail, not a generic error.
   */
  serveFailsWith?: string;
}

const DEFAULT_TAILSCALE_STATE: MockTailscaleState = {
  available: false,
  loggedIn: false,
  detail: 'tailscale binary not found',
};

/** power.status.get's `work` shape (see MockDaemonOptions.power above). */
export interface MockPowerWorkState {
  held: boolean;
  grantedClasses: readonly string[];
  deniedClasses: readonly string[];
  reasons: readonly string[];
  heldSince: number | null;
  capMinutes: number;
  capExpiresAt: number | null;
  capExpired: boolean;
}

/** power.status.get's `keepAwake` shape (see MockDaemonOptions.power above). */
export interface MockPowerKeepAwakeState {
  enabled: boolean;
  held: boolean;
  grantedClasses: readonly string[];
  deniedClasses: readonly string[];
  note: string | null;
}

const DEFAULT_POWER_WORK_STATE: MockPowerWorkState = {
  held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 0, capExpiresAt: null, capExpired: false,
};
const DEFAULT_POWER_KEEP_AWAKE_STATE: MockPowerKeepAwakeState = {
  enabled: false, held: false, grantedClasses: [], deniedClasses: [], note: null,
};

/**
 * power.status.get/keepAwake.set's real shape (platform + work + keepAwake), with a
 * held-and-refused-lid-switch example, the honest lid-split case, not the all-off
 * default. Exported so assert-contract-shape.test.ts can bind it without a Page.
 */
export function powerStatusResponse() {
  return {
    platform: 'linux',
    work: { held: true, grantedClasses: ['idle', 'sleep'], deniedClasses: [], reasons: ['active turn in session s-agent-live'], heldSince: 1_700_000_000_000, capMinutes: 120, capExpiresAt: 1_700_007_200_000, capExpired: false },
    keepAwake: {
      enabled: true, held: true, grantedClasses: ['idle', 'sleep'], deniedClasses: ['handle-lid-switch'],
      note: 'idle sleep blocked; lid-close suspend is controlled by your OS here',
    },
  };
}

/** The one workstream id the default fleetGraph seed answers for, see MockDaemonOptions.fleetGraph. */
export const FLEET_GRAPH_WORKSTREAM_ID = 'contract-e2e:g1';

/**
 * The default fleet.graph.get fixture: one node per state tell the task-graph
 * panel renders (ready/running/blocked/stalled/done), plus an at-cap pool state
 *, a real, representative graph, not an all-idle stub. Exported so
 * assert-contract-shape.test.ts can bind it without a Page.
 */
export function fleetGraphResponse(workstreamId: string) {
  return {
    workstreamId,
    title: 'Fix findings from the review',
    nodes: [
      { id: 'wi-1', title: 'Fix null-check in session close', state: 'pending', files: ['src/session.ts'], orphaned: false, remainingDepth: 2, stalled: false },
      { id: 'wi-2', title: 'Add regression test for the race', state: 'in-phase', files: ['src/session.test.ts'], orphaned: false, remainingDepth: 1, stalled: false, agentId: 'agent-e2e-1' },
      { id: 'wi-3', title: 'Update the changelog entry', state: 'blocked-dependency', blockedReason: 'waiting on: Fix null-check in session close', files: ['CHANGELOG.md'], orphaned: false, remainingDepth: 0, stalled: false },
      { id: 'wi-4', title: 'Refactor the retry loop', state: 'in-phase', files: ['src/retry.ts'], orphaned: false, remainingDepth: 0, stalled: true, agentId: 'agent-e2e-2' },
      { id: 'wi-5', title: 'Tighten the timeout constant', state: 'passed', files: ['src/config.ts'], orphaned: false, remainingDepth: 0, stalled: false },
    ],
    edges: [{ from: 'wi-3', to: 'wi-1' }],
    pool: { ready: 1, running: 2, atCap: true, capKey: 'fleet.maxSize', maxSize: 2, refusal: 'new spawns wait for a running agent to free a slot' },
  };
}

export interface MockDaemon {
  /** Every steer POST captured, in order: { sessionId, body }. */
  steerRequests: { sessionId: string; body: unknown }[];
  /** Every follow-up POST captured. */
  followUpRequests: { sessionId: string; body: unknown }[];
  /** Every sessions.detach POST captured: { sessionId, surfaceId }. */
  detachRequests: { sessionId: string; surfaceId: string }[];
  /** Every watchers.stop POST captured, by watcherId. */
  watcherStopRequests: string[];
  /** Every approvals.{approve,deny,claim,cancel} POST captured, in order. */
  approvalActions: { approvalId: string; action: 'approve' | 'deny' | 'claim' | 'cancel'; body: unknown }[];
  /** Every power.keepAwake.set POST captured, in order (the `enabled` value sent). */
  keepAwakeSetRequests: boolean[];
  /** Every sessions.toolCalls.cancel POST captured, in order. */
  toolCallCancelRequests: { sessionId: string; callId: string }[];
  /** Every fleet.observed.steer invoke captured, in order. */
  observedSteerRequests: { id: string; text: string }[];
  /** How many times voice.wake.provision was asked for (it must never be automatic). */
  wakeProvisionRequests: number;
  /** Every voice.wake.model.get read captured, in order, proves the chunk loop. */
  wakeModelReads: { component: 'classifier' | 'embedding' | 'notice'; offset: number }[];
  /**
   * Live reference to the mutable hosted-sessions store (sessions.hosted.*), the
   * SAME array create/attach/detach/kill mutate, not a snapshot, so a test can poll
   * it (e.g. `expect.poll(() => daemon.hostedSessions.find(...).status)`) to prove a
   * detach/kill genuinely reached the daemon without depending on a UI refetch.
   */
  hostedSessions: readonly Record<string, unknown>[];
  /** Every daemon-bound request the page sent, in order (support/requests.ts). */
  requests: RecordedRequest[];
  /** The input of every control-plane invoke of a method id, in order. */
  invocations: (methodId: string) => unknown[];
}

const TOKEN_KEY = 'goodvibes.webui.token';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

/**
 * control.methods.get's 200 shape (the daemon's real gateway-method descriptor,
 * `{ method: {...} }`), a hermetic stand-in, not a real registry lookup. Exported so
 * assert-contract-shape.test.ts can bind it to the operator contract without a Page.
 */
export function methodInfoResponse(methodId: string) {
  return {
    method: {
      id: methodId,
      title: methodId,
      description: 'Hermetic e2e mock method descriptor: not a real gateway registry entry.',
      category: methodId.split('.')[0] ?? 'misc',
      source: 'builtin',
      access: 'authenticated',
      transport: ['http'],
      scopes: [],
    },
  };
}

/**
 * sessions.steer / sessions.followUp share this output envelope on the real contract
 * ({ session, message, input, mode, agentId }, all required), a shape wholly
 * different from what this mock used to invent ({ delivered, inputId }). The app
 * (SteerComposer) never reads the resolved body (it only reacts to resolve vs.
 * reject), so this reshape is behavior-neutral for every existing spec while closing
 * the gap a contract change here would otherwise sail through unnoticed.
 * Exported so assert-contract-shape.test.ts can bind it without a Page.
 */
export function dispatchOutcome(session: SeedSession | undefined, intent: 'steer' | 'follow-up', body: string, inputId: string) {
  const now = Date.now();
  const canSteer = Boolean(session?.activeAgentId);
  const mode = intent === 'steer'
    ? (canSteer ? 'continued-live' : 'rejected')
    : 'queued-follow-up';
  return {
    session: session ? sessionRecord(session) : null,
    message: {
      id: `${inputId}-msg`,
      sessionId: session?.id ?? 'unknown',
      role: 'user' as const,
      body,
      createdAt: now,
      metadata: {},
    },
    input: {
      id: inputId,
      sessionId: session?.id ?? 'unknown',
      intent,
      state: intent === 'steer' ? 'delivered' : 'queued',
      correlationId: inputId,
      body,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    },
    mode,
    agentId: session?.activeAgentId ?? null,
  };
}

/** The base synthetic fixture owns no native turn journal; native specs override discovery. */
export function legacySessionDiscoveryResponse(): OperatorMethodOutput<'workLedger.turn.session'> {
  return { kind: 'legacy' };
}

export async function installMockDaemon(page: Page, options: MockDaemonOptions = {}): Promise<MockDaemon> {
  const {
    signedIn = true,
    dropStreams = false,
    deleteAvailable = true,
    credentials = 'available',
    memoryAvailable = true,
    memoryIndexUnavailable = false,
    consolidationReceipts = 'available',
    calendar = 'configured',
    email = 'not-available',
    occasions = 'available',
    config = 'ok',
    packet = 'complete',
    approvalUpdateFrames = [],
    hostedStreamFrames = [],
    fleetEvents = [],
    localSessionId = 's-agent-live',
    pushSeed = [],
  } = options;
  const pairingStore = options.pairingStore ?? createMockPairingStore();
  // sessions.permissionMode.get/set + sessions.contextUsage.get in-memory state, a
  // fresh copy per installMockDaemon call, mutated by set() exactly like the daemon's
  // real single-writer config value.
  let permissionMode: OperatorMethodOutput<'sessions.permissionMode.get'>['mode'] = options.initialPermissionMode ?? 'normal';
  const contextUsageState = { estimatedContextTokens: 4200, contextWindow: 200000 };

  function sessionNotLocal(route: Route, sessionId: string) {
    return json(route, {
      error: `This daemon does not host a live runtime for session ${sessionId}.`,
      code: 'SESSION_NOT_LOCAL',
    }, 404);
  }
  // The multiplexed fleet subscription emits its frames exactly once (the FIRST
  // events-stream request that carries the `fleet` domain); the emission flips the
  // snapshot to its enriched form so the event-driven refetch surfaces a new node.
  let fleetEventsEmitted = false;
  let fleetEnriched = false;
  const requestLog = recordRequests(page);
  const daemon: MockDaemon = {
    requests: requestLog.requests,
    invocations: requestLog.invocations,
    steerRequests: [],
    followUpRequests: [],
    detachRequests: [],
    watcherStopRequests: [],
    approvalActions: [],
    keepAwakeSetRequests: [],
    toolCallCancelRequests: [],
    observedSteerRequests: [],
    wakeProvisionRequests: 0,
    wakeModelReads: [],
    // Replaced below with a live reference once the hosted-sessions store itself is
    // constructed (that store's default seed is assembled further down this
    // function), this placeholder exists only so every MockDaemon field is present
    // from the object literal's own construction.
    hostedSessions: [],
  };
  // power.status.get / power.keepAwake.set in-memory state, a fresh copy per
  // installMockDaemon call, mutated by keepAwake.set exactly like the daemon's
  // real single-writer state.
  const powerState = {
    platform: 'linux',
    work: { ...DEFAULT_POWER_WORK_STATE, ...options.power?.work },
    keepAwake: { ...DEFAULT_POWER_KEEP_AWAKE_STATE, ...options.power?.keepAwake },
  };
  // tailscale.get / tailscale.serve.run in-memory state, a fresh copy per
  // installMockDaemon call, mutated by serve.run exactly like the real daemon's
  // single-writer state (lastServe records the most recent attempt either way).
  const tailscaleState: MockTailscaleState = { ...DEFAULT_TAILSCALE_STATE, ...options.tailscale };
  // ops.memory.get in-memory state, a fresh copy per installMockDaemon call.
  const opsMemoryState = options.opsMemory === 'unavailable'
    ? null
    : { ...opsMemoryResponse(), ...options.opsMemory };
  // voice.local.status / voice.local.install in-memory state, install flips the
  // resting state to provisioned exactly like the real one-act flow (unless the
  // seeded outcome is the retriable download failure, which keeps nothing).
  // Split the 'unavailable' sentinel off the seed OBJECT once, with an explicit
  // annotation, instead of carrying a `'unavailable' | {...} | undefined` union
  // through `in` checks: the union survived those checks, so the spread below was
  // spreading a possible string.
  const voiceLocalOption = options.voiceLocal;
  const voiceLocalUnavailable = voiceLocalOption === 'unavailable';
  const voiceLocalSeed: { status?: Partial<VoiceLocalStatus>; installOutcome?: 'provisioned' | 'download-failed' } =
    voiceLocalOption === undefined || voiceLocalOption === 'unavailable' ? {} : voiceLocalOption;
  const voiceLocalInstallOutcome = voiceLocalSeed.installOutcome ?? 'provisioned';
  let voiceLocalState: VoiceLocalStatus | null = voiceLocalUnavailable
    ? null
    : { ...voiceLocalStatusResponse(), ...voiceLocalSeed.status };
  // voice.wake.* in-memory state. Null is the older-daemon 404 for all three verbs.
  // provision() flips `provisioned`, exactly like the real single-flight act.
  const voiceWakeOption = options.voiceWake;
  const voiceWakeState: MockWakeState | null = voiceWakeOption === 'unavailable'
    ? null
    : {
      provisioned: voiceWakeOption?.provisioned ?? false,
      chunkBytes: voiceWakeOption?.chunkBytes ?? WAKE_MODEL_CHUNK_BYTES,
      corruptSha: voiceWakeOption?.corruptSha ?? false,
    };
  // sessions.queuedMessages.* in-memory store, keyed by sessionId, a fresh copy
  // per installMockDaemon call, mutated by edit/delete.
  const queuedMessagesBySession: Record<string, { id: string; queuedAt: number; text: string }[]> = {};
  for (const [sessionId, messages] of Object.entries(options.queuedMessages ?? {})) {
    queuedMessagesBySession[sessionId] = messages.map((m) => ({ ...m }));
  }
  // fleet.graph.get seed, defaults to the one representative graph fixture.
  const fleetGraphs: Record<string, unknown> = options.fleetGraph
    ? { ...options.fleetGraph }
    : { [FLEET_GRAPH_WORKSTREAM_ID]: fleetGraphResponse(FLEET_GRAPH_WORKSTREAM_ID) };
  // Mutable so approve/deny/claim/cancel genuinely change what a subsequent
  // approvals.list() sees (WEBUI-FLEET-DEPTH), a fresh copy per installMockDaemon
  // call so tests never leak state into each other.
  const approvals: Record<string, unknown>[] = (options.approvals ?? [PENDING_APPROVAL]).map((a) => ({ ...a }));
  // Durable rules (permissions.rules.*), same fresh-copy-per-install policy.
  const permissionRules: Record<string, unknown>[] = (options.permissionRules ?? []).map((r) => ({ ...r }));
  let ruleCounter = 0;

  // Hosted sessions (sessions.hosted.*, daemon-hosted sessions), mutable so
  // create/attach/detach/kill genuinely change what a subsequent
  // sessions.hosted.list() sees, a fresh copy per installMockDaemon call. The
  // default seed carries one idle attachable session (detach policy survive, so
  // detaching it never destroys the fixture a test just attached to) and one
  // already-terminated session with a real terminatedReason, so a test proves
  // both the "attach and view" path and the includeTerminated/terminatedReason
  // honesty line without every spec having to seed its own.
  const DEFAULT_HOSTED_SESSIONS: Record<string, unknown>[] = [
    {
      id: 'hosted-e2e-1', workspaceRoot: '/home/operator/projects/example', title: 'Refactor the parser',
      status: 'idle', detachPolicy: null, effectiveDetachPolicy: 'survive', attachedClients: [],
      providerId: 'anthropic', modelId: 'claude-sonnet', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
      turnCount: 2, messageCount: 4, lastTurnAt: 1_700_000_100_000, restoredFromDisk: false,
    },
    {
      id: 'hosted-e2e-2', workspaceRoot: '/home/operator/projects/archived', title: 'One-off cleanup',
      status: 'terminated', detachPolicy: 'kill', effectiveDetachPolicy: 'kill', attachedClients: [],
      createdAt: 1_699_000_000_000, updatedAt: 1_699_000_050_000, turnCount: 1, messageCount: 2,
      lastTurnAt: 1_699_000_050_000, terminatedAt: 1_699_000_050_000, terminatedReason: 'killed', restoredFromDisk: false,
    },
  ];
  const hostedSessions: Record<string, unknown>[] = (options.hostedSessions ?? DEFAULT_HOSTED_SESSIONS).map((s) => ({ ...s }));
  daemon.hostedSessions = hostedSessions;
  const hostedSessionHistory: Record<string, { role: string; content: string; at?: number }[]> = {
    'hosted-e2e-1': [
      { role: 'user', content: 'Refactor the parser to use a visitor pattern.', at: 1_700_000_050_000 },
      { role: 'assistant', content: 'Sure: starting with the AST node definitions.', at: 1_700_000_060_000 },
    ],
  };
  for (const [sessionId, messages] of Object.entries(options.hostedSessionHistory ?? {})) {
    hostedSessionHistory[sessionId] = messages.map((m) => ({ ...m }));
  }
  let hostedSessionIdCounter = 0;

  // Undelivered daemon receipts, handed over exactly once, on a receipts=consume
  // status read, then marked delivered so a re-consume (e.g. a reconnect) returns none.
  let daemonReceipts: { id: string; text: string; at: number }[] = (options.daemonReceipts ?? []).map((r) => ({ ...r }));

  // In-memory canonical store for this test only, a fresh copy of the seed per
  // installMockDaemon call, mutated by add/delete/update-review exactly like the real
  // daemon-owned single-writer store (never a second copy diverging from what the UI
  // reads back).
  let memoryRecords: MemoryRecordWire[] = SEED_MEMORY_RECORDS.map(memoryRecordWire);
  let memoryIdCounter = 0;

  // Checkpoints (checkpoints.*): one seeded checkpoint so the phone confirm-sheet
  // flow (create/restore routed through ConfirmSheet) has real selected-detail
  // content to prove against, not just the true-empty state phone-smoke covers.
  let checkpointsList = [
    { id: 'wcp_e2e_1', kind: 'manual', label: 'Before the mobile pass', createdAt: 1_700_000_000_000, parentId: null as string | null, retentionClass: 'standard', commit: 'aaaaaaaaaaaa1111', sizeBytes: 4096 },
  ];

  // Fleet archive (fleet.archive/unarchive/archiveFinished/archived.list):
  // node ids the tests have archived, snapshot/list exclude them, archived.list
  // returns them, unarchive releases them.
  const archivedFleetIds = new Set<string>();

  // Principals (principals.*, SDK 1.6.1's initiative family): one seeded principal
  // with a channel identity, plus the shared unknown principal principals.resolve
  // falls back to for an unmapped identity (real daemon behavior, never a guess).
  let principalList = [
    {
      id: 'prin_e2e_1', name: 'Mike', kind: 'user' as const,
      identities: [{ channel: 'slack', value: 'U123ABC' }],
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    },
  ];
  let principalIdCounter = 0;
  const UNKNOWN_PRINCIPAL = { id: 'principal-unknown', name: 'unknown', kind: 'user' as const, identities: [], createdAt: 0, updatedAt: 0 };

  // Channel profiles (channels.profiles.*, SDK 1.6.1's initiative family): one seeded
  // surface-wide binding so a spec has real selected-detail content to prove against.
  let channelProfileList: MockChannelBinding[] = [
    { id: 'cp_e2e_1', surfaceKind: 'slack', model: 'claude-sonnet', permissionMode: 'normal' as const, updatedAt: 1_700_000_000_000 },
  ];
  let channelProfileIdCounter = 0;

  // Check-in (checkin.*, SDK 1.6.1's initiative family): a mutable in-memory config
  // (starts enabled, so the config-display honesty state has real content) plus one
  // seeded receipt for each distinct outcome the wire reports, so ReceiptRow's
  // outcome-label mapping has real content to prove against.
  let checkinConfigState = { enabled: true, cadence: '0 9 * * *', deliveryChannel: 'slack:#daily', quietHours: '22:00-07:00' };
  let checkinReceiptList: MockCheckinReceipt[] = [
    { id: 'ckr_e2e_1', ranAt: 1_700_000_300_000, trigger: 'scheduled' as const, outcome: 'delivered' as const, briefingSummary: 'Three PRs merged, one flaky test flagged.', deliveredMessage: 'Morning update: 3 PRs merged overnight.', deliveryChannel: 'slack:#daily' },
    { id: 'ckr_e2e_2', ranAt: 1_700_000_200_000, trigger: 'scheduled' as const, outcome: 'quiet' as const, briefingSummary: 'Nothing new since the last check-in.', decisionReason: 'No new activity worth surfacing.' },
    { id: 'ckr_e2e_3', ranAt: 1_700_000_100_000, trigger: 'manual' as const, outcome: 'skipped-quiet-hours' as const, briefingSummary: 'Requested during quiet hours.', decisionReason: 'Current time falls within configured quiet hours.' },
  ];
  let checkinReceiptIdCounter = 0;

  // Occasions/plans (occasions.*, docs/occasions.md, the dates panel): mutable
  // in-memory copies of the seeded fixtures so answer/remove/interview/sweep actually
  // change what a subsequent read reports, the same single-writer-store shape the
  // real daemon's OccasionStateStore gives (docs/occasions.md §3.2).
  let occasionsListState = occasionsListResponse();
  let occasionsPlansState = occasionsPlansListResponse();
  let occasionsStateState = occasionsStateResponse();
  // GET /api/occasions/pending reads THIS, not a fresh occasionsPendingResponse() call
  // each time, otherwise answering/closing the seeded interview below would never
  // show up on the next read, same mutable-store shape occasionsListState gives.
  let occasionsPendingState = occasionsPendingResponse();
  let occasionsGiftsByOccasion: Record<string, ReturnType<typeof occasionsGiftsResponse>['gifts']> = {
    'occ-e2e-1': occasionsGiftsResponse('occ-e2e-1').gifts,
    'occ-e2e-2': occasionsGiftsResponse('occ-e2e-2').gifts,
  };
  let occasionsIdCounter = 0;

  // CI watches (ci.watches.*, SDK 1.6.1's initiative family): one seeded watch so a
  // spec has real selected-detail content to prove against, matching the checkpoints
  // seed above. ci.status/ci.watches.run always answer with a real per-job report
  // (two jobs, one continue-on-error), the honesty-bar shape CiWatchesView renders.
  let ciWatchList: MockCiWatch[] = [
    {
      id: 'ciw_e2e_1', repo: 'acme/example', ref: 'main', deliveryChannel: 'slack:#ci',
      triggerFixSession: false, lastOverall: 'passed' as const,
      createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    },
  ];
  let ciWatchIdCounter = 0;
  let ciFixSessionCounter = 0;
  // Companion chat sessions, STATEFUL so a spawned CI fix session becomes a
  // real, servable session: opening it must land on a live session view, not an
  // id the session list has never heard of (App reconciles unknown ids away).
  let companionChatSessions = [
    { id: 'chat-1', sessionId: 'chat-1', title: 'Phone chat', status: 'active' },
    { id: 'chat-2', sessionId: 'chat-2', title: 'Away-from-desk notes', status: 'active' },
  ];
  /**
   * Spawn a CI fix session, mirroring SDK bb4b9c30: success mints a FRESH
   * session that the mock's session store actually serves (a REAL attachable
   * id, never a scheduling handle) and returns { sessionId }; a failure (the
   * ciFixSessionError option) returns the honest { error } and creates nothing.
   */
  function spawnCiFixSession(repo: string): { sessionId: string } | { error: string } {
    if (options.ciFixSessionError) return { error: options.ciFixSessionError };
    ciFixSessionCounter += 1;
    const sessionId = `sess-ci-fix-${ciFixSessionCounter}`;
    companionChatSessions = [
      ...companionChatSessions,
      { id: sessionId, sessionId, title: `CI fix session: ${repo}`, status: 'active' },
    ];
    return { sessionId };
  }
  function ciReportFor(repo: string, ref?: string, prNumber?: number) {
    return {
      repo,
      ...(ref ? { ref } : {}),
      ...(prNumber ? { prNumber } : {}),
      overall: 'failed' as const,
      jobs: [
        { name: 'test', status: 'completed' as const, conclusion: 'success', continueOnError: false, url: 'https://example.com/runs/1' },
        { name: 'lint', status: 'completed' as const, conclusion: 'failure', continueOnError: false, url: 'https://example.com/runs/2' },
        { name: 'optional-check', status: 'completed' as const, conclusion: 'failure', continueOnError: true },
      ],
      violations: ['job "lint" concluded failure'],
      checkedAt: 1_700_000_100_000,
    };
  }

  // Runtime tasks (tasks.*): one cancellable, one retryable, the pair TaskRow's
  // two mutation buttons key off (task.cancellable / a failed/cancelled status),
  // so the phone confirm-sheet flow for cancel/retry has something to act on.
  let taskList = [
    { id: 'task_e2e_1', kind: 'shell', title: 'Run the release checklist', status: 'running', owner: 'operator', cancellable: true, queuedAt: 1_700_000_000_000 },
    { id: 'task_e2e_2', kind: 'shell', title: 'Rebuild the search index', status: 'failed', owner: 'operator', cancellable: false, queuedAt: 1_700_000_000_000, error: 'index build timed out' },
  ];

  function methodNotFound(route: Route) {
    return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
  }

  // Web Push (push.*, SDK 1.1.0), a fresh per-test in-memory subscription store
  // so subscribe -> list -> verify -> delete round-trips honestly. The redacted
  // view only (never the capability URL or key material), exactly like the real
  // daemon. Generate an ephemeral fixture P-256 key and expose only its public
  // bytes. It is never registered with a push service or retained outside this test.
  const pushVapidKey = createECDH('prime256v1').generateKeys().toString('base64url');
  let pushSubscriptions: { id: string; principalId: string; deviceId?: string; endpointOrigin: string; endpointHash: string; createdAt: number }[] =
    pushSeed.map((s) => ({ ...s, principalId: 'operator' }));
  let pushIdCounter = 0;
  let pairingIdCounter = 0;

  // Mutable server-side state for the two round-trip surfaces this brief adds:
  // the current model slot (models.current/models.select) and the config tree
  // (config.get/config.set), a real "select a model, see it reflected" and
  // "save a setting, see it read back" proof, not a static fixture.
  let currentModel = modelsCurrentResponse();
  const configState: Record<string, unknown> = JSON.parse(JSON.stringify(configGetResponse())) as Record<string, unknown>;

  function setDotPath(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
    const parts = dottedKey.split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      const next = cursor[part];
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = value;
  }

  // Mirror the daemon's pricing resolver for fleet nodes: a manual price entry
  // (config pricing.modelPrices["provider:model"]) always wins, so once one is
  // set the node re-prices with costSource:'user' and no catalog as-of date,
  // exactly what a fresh snapshot would carry after the operator sets a price.
  // Nodes without a manual entry keep whatever provenance the fixture stamped.
  function withManualPricing<T extends { provider?: string; model?: string }>(node: T): T {
    if (!node.provider || !node.model) return node;
    const pricing = (configState.pricing ?? {}) as { modelPrices?: Record<string, unknown> };
    const table = pricing.modelPrices ?? {};
    if (!(`${node.provider}:${node.model}` in table)) return node;
    const next: Record<string, unknown> = { ...node, costSource: 'user' };
    delete next.pricingAsOf;
    return next as T;
  }

  if (signedIn) {
    await page.addInitScript(
      ([key, token]) => {
        try {
          window.localStorage.setItem(key, token);
        } catch {
          /* ignore */
        }
      },
      [TOKEN_KEY, 'e2e-operator-token'] as const,
    );
  }

  // credentials.get resolves to GET /config/credentials, note the missing
  // `/api` segment (EXTRA_METHOD_ROUTES in src/lib/goodvibes.ts, matching
  // config.set's `/config`), so it needs its own route registration; the
  // `**/api/**` glob below never matches this path.
  await page.route('**/config/credentials', async (route) => {
    if (credentials === 'admin-required') {
      return json(route, { error: 'Admin role required' }, 403);
    }
    if (credentials === 'store-unavailable') {
      return json(route, { error: 'Shared credential store unavailable', code: 'CREDENTIAL_STORE_UNAVAILABLE' }, 503);
    }
    return json(route, {
      available: true,
      credentials: [
        { key: 'ANTHROPIC_API_KEY', configured: true, usable: true, source: 'env', secure: true },
        { key: 'OPENAI_API_KEY', configured: true, usable: true, source: 'env', secure: true },
        { key: 'GOOGLE_API_KEY', configured: true, usable: false, source: 'env-ref', secure: false },
      ],
    });
  });

  // config.get/config.set resolve to GET/POST /config, no `/api` segment,
  // same reason as credentials above (EXTRA_METHOD_ROUTES in
  // src/lib/goodvibes.ts). A real, mutable round-trip: config.set actually
  // mutates configState, so a subsequent config.get (or the Settings modal's
  // own cache invalidation) reflects the write.
  await page.route('**/config', async (route) => {
    const request = route.request();
    if (config === 'admin-required') {
      return json(route, { error: 'Admin role required' }, 403);
    }
    if (request.method() === 'POST') {
      const body = (request.postDataJSON?.() ?? {}) as { key?: string; value?: unknown };
      if (!body.key) return json(route, { error: 'Missing or invalid key' }, 400);
      setDotPath(configState, body.key, body.value);
      return json(route, { success: true, key: body.key, value: body.value });
    }
    return json(route, configState);
  });

  // The SDK's control.status convenience helper uses the direct `GET /status`
  // route (not the invoke gateway), so it needs its own registration. Without
  // it this was the ONE request that escaped the mock to the dead proxy
  // target: every boot snapshot and the Admin status card ran against a
  // connection-refused health probe, spamming the webServer log with
  // ECONNREFUSED and exercising the app permanently in its daemon-down pulse
  // state. Same answer shape as the invoke-path 'control.status' below.
  // Matches /status AND /status?receipts=consume (control.status is GET /status;
  // the receipts input rides the query string). A consume hands over the queued
  // receipts once and marks them delivered; a plain read is receipt-neutral.
  await page.route(/\/status(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('receipts') === 'consume') {
      const delivered = daemonReceipts;
      daemonReceipts = [];
      return json(route, { ok: true, status: 'running', receipts: delivered });
    }
    return json(route, { ok: true, status: 'running' });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    const accept = request.headers()['accept'] ?? '';

    // A revoked pairing token (pairing.tokens.delete) 401s EVERY request that
    // presents it, immediately, proving revoke actually signs a device out,
    // while a request bearing any OTHER token is untouched. Checked before
    // every other branch below, including the auth probe.
    const revokeGuardAuthz = request.headers()['authorization'] ?? '';
    const revokeGuardBearer = /^Bearer\s+(.+)$/i.exec(revokeGuardAuthz)?.[1]?.trim();
    if (revokeGuardBearer && pairingStore.revokedTokenValues.has(revokeGuardBearer)) {
      return json(route, { error: 'This pairing token has been revoked.', code: 'UNAUTHENTICATED' }, 401);
    }

    // Existing Work proofs do not seed contracts. Keep their absence an honest
    // empty list; contract inspection specs layer a stateful fixture over this.
    if (method === 'GET' && path === '/api/contracts') return json(route, { contracts: [] });

    // Streams: an EventSource/fetch stream (text/event-stream).
    if (accept.includes('text/event-stream') || path.includes('/events')) {
      // Fleet subscription emit: the FIRST request for the multiplexed stream that
      // carries the `fleet` domain gets the seeded fleet frames as SSE, then the
      // snapshot flips to its enriched form so the invalidation that frame triggers
      // surfaces FLEET_EVENT_NODE. Only that one stream (the invalidation feed) is
      // targeted, the session-update stream (?domains=session) never matches.
      const domains = url.searchParams.get('domains') ?? '';
      if (fleetEvents.length > 0 && !fleetEventsEmitted && domains.split(',').includes('fleet')) {
        fleetEventsEmitted = true;
        // Let the view's initial snapshot fetch settle before the frame lands, so the
        // invalidation the frame triggers refetches an idle query (invalidating a query
        // that is still in flight only marks it stale, it will not fire a second
        // fetch). This mirrors real usage, where fleet events arrive after the first
        // snapshot, not simultaneously with it.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        fleetEnriched = true;
        const body = fleetEvents
          .map((event) => `event: fleet\ndata: ${JSON.stringify({ payload: event })}\n\n`)
          .join('');
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
      }
      // Approval-update subscription emit (the approvals push spec): EVERY
      // request for the EXACT `?domains=gate` stream gets the seeded
      // approvalUpdateFrames as SSE (`event: approval-update`, one per entry),
      // so a test can prove ApprovalsTasksView's push path actually receives a
      // frame and reacts to it, distinct from the poll fallback. EXACT match, not
      // "includes gate": useRealtimeInvalidation ALSO opens a multiplexed
      // stream whose `?domains=` includes gate among six other domains,
      // an "includes" check would race that unrelated stream and could hand the
      // frame to a subscriber that silently drops unrecognized wire events, never
      // reaching useApprovalUpdates at all.
      //
      // UNLIKE the fleet block above, this is deliberately NOT gated to "only the
      // first matching request ever": React StrictMode's dev-mode double-invoke
      // mounts, tears down, then remounts every effect once, so the FIRST
      // qualifying stream request is routinely a doomed one whose underlying
      // fetch gets aborted before this handler's delay below elapses, a
      // once-only gate would burn the emission on that doomed request and starve
      // the SURVIVING connection. Emitting to every matching request is safe here
      // because each frame's approval is appended to the live `approvals` store
      // ONLY the first time its id is seen (mirroring a real broker publishing
      // the record and the event together), a repeat emission to a second
      // (surviving) connection re-sends the same frame, which is idempotent, not
      // a duplicate side effect.
      if (approvalUpdateFrames.length > 0 && domains === 'gate') {
        // Let the initial approvals.list() fetch settle first, same rationale as
        // the fleet block above: invalidating a query still in flight only marks
        // it stale, it does not fire a second fetch.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        for (const approval of approvalUpdateFrames) {
          const id = (approval as { id?: unknown }).id;
          if (typeof id === 'string' && !approvals.some((existing) => existing.id === id)) {
            approvals.push({ ...approval });
          }
        }
        const body = approvalUpdateFrames
          .map((approval) => `event: approval-update\ndata: ${JSON.stringify({ approval, createdAt: Date.now() })}\n\n`)
          .join('');
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
      }
      // Hosted session live-output emit (the hosted-sessions attach spec): EVERY
      // request for the EXACT `?domains=session,turn,tools` stream
      // (useHostedSessionRealtime's one stream) gets the seeded hostedStreamFrames
      // as SSE, one per entry, proving a hosted session's attached view actually
      // receives its live turn/tool output. Deliberately not gated to "first
      // request only", same StrictMode double-invoke rationale as the
      // approval-update block above: HostedSessionsView is view-scoped (mounted
      // only while that view is showing, not app-root-mounted like
      // useSessionRealtime/useRealtimeInvalidation), so its double-invoke window
      // lands squarely inside a test's own navigation rather than settling before
      // the test's assertions run.
      if (hostedStreamFrames.length > 0 && domains === 'session,turn,tools') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const body = hostedStreamFrames
          .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.payload)}\n\n`)
          .join('');
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
      }
      if (dropStreams) {
        // Immediately-closed stream → the client sees a terminated feed and enters
        // the reconnect/paused honesty path.
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: ':closed\n\n',
        });
      }
      // Leave it pending: a stream that never opens and never errors, the clean
      // baseline (neither connected nor paused).
      return;
    }

    // ── Auth / health ──────────────────────────────────────────────────────
    if (path === '/api/control-plane/auth') {
      // Authenticated when the app was seeded signed-in OR presents a bearer token
      // (what a QR pairing hand-off produces): the daemon authenticates the presented
      // operator token, so a freshly-paired device with no seeded token still passes.
      const authz = request.headers()['authorization'] ?? '';
      const bearer = /^Bearer\s+(.+)$/i.exec(authz)?.[1]?.trim();
      if (!signedIn && !bearer) return json(route, { error: 'unauthorized' }, 401);
      return json(route, { authenticated: true, username: 'operator', identity: { subject: 'operator' } });
    }
    if (path === '/api/local-auth') {
      return json(route, { ok: true, mode: 'local', authenticated: true });
    }

    // ── Memory governance (ops.memory.get, SDK 1.9.0-dev) ─────────────────
    if (method === 'GET' && path === '/api/ops/memory') {
      if (!opsMemoryState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      return json(route, opsMemoryState);
    }

    // ── Managed local voice (voice.local.status / voice.local.install, SDK 1.9.0-dev) ──
    if (method === 'GET' && path === '/api/voice/local/status') {
      if (!voiceLocalState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      return json(route, voiceLocalState);
    }
    if (method === 'POST' && path === '/api/voice/local/install') {
      if (!voiceLocalState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      const receipt = voiceLocalInstallResponse(voiceLocalInstallOutcome);
      if (receipt.provisioned) {
        // The real one-act flow: a successful install flips the resting status.
        voiceLocalState = {
          ...voiceLocalState,
          state: 'provisioned',
          tts: { ...voiceLocalState.tts, binaryPresent: true, voicePresent: true },
          stt: { ...voiceLocalState.stt, state: 'provisioned', binaryPresent: true, modelPresent: true },
        };
      }
      return json(route, receipt);
    }

    // ── Browser wake word (voice.wake.status / provision / model.get) ─────
    // model.get is a GET whose input rides the query string, which is what the
    // webui client actually sends for a GET-routed verb (invokeOperator -> query).
    if (method === 'GET' && path === '/api/voice/wake/status') {
      if (!voiceWakeState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      return json(route, wakeStatusResponse(voiceWakeState.provisioned));
    }
    if (method === 'POST' && path === '/api/voice/wake/provision') {
      if (!voiceWakeState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      daemon.wakeProvisionRequests += 1;
      voiceWakeState.provisioned = true;
      return json(route, wakeProvisionResponse());
    }
    if (method === 'GET' && path === '/api/voice/wake/model') {
      if (!voiceWakeState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      const params = new URL(request.url()).searchParams;
      const component = params.get('component');
      if (component !== 'classifier' && component !== 'embedding' && component !== 'notice') {
        return json(route, { error: 'component must be classifier, embedding or notice' }, 400);
      }
      const offset = Number(params.get('offset') ?? '0');
      daemon.wakeModelReads.push({ component, offset });
      return json(route, wakeModelChunkResponse(component, Number.isFinite(offset) ? offset : 0, voiceWakeState));
    }

    // ── Power (power.status.get / power.keepAwake.set, SDK 1.8.0) ─────────
    if (method === 'GET' && path === '/api/power/status') {
      return json(route, powerState);
    }
    if (method === 'POST' && path === '/api/power/keep-awake') {
      const body = (request.postDataJSON?.() ?? {}) as { enabled?: boolean };
      const enabled = body.enabled === true;
      daemon.keepAwakeSetRequests.push(enabled);
      powerState.keepAwake = { ...powerState.keepAwake, enabled, held: enabled };
      return json(route, powerState);
    }

    // ── Fleet task graph (fleet.graph.get, SDK 1.8.0's fix-phase workstream rework) ──
    const fleetGraphMatch = path.match(/^\/api\/fleet\/workstreams\/([^/]+)\/graph$/);
    if (method === 'GET' && fleetGraphMatch) {
      const workstreamId = decodeURIComponent(fleetGraphMatch[1]);
      const graph = fleetGraphs[workstreamId];
      if (!graph) return json(route, { error: `workstream ${workstreamId} not found`, code: 'NOT_FOUND' }, 404);
      return json(route, graph);
    }

    // ── Capability probe: sessions.delete (GET /api/control-plane/methods/{id}) ──
    if (method === 'GET' && /\/api\/control-plane\/methods\/[^/]+$/.test(path)) {
      const methodId = decodeURIComponent(path.split('/').pop() ?? '');
      if (methodId === 'sessions.delete' && !deleteAvailable) {
        return json(route, { error: 'Unknown gateway method' }, 404);
      }
      return json(route, methodInfoResponse(methodId));
    }

    // All sessions in this base fixture are synthetic legacy sessions. Native
    // continuation specs install their genuine captured discovery route afterward.
    if (method === 'POST' && path === '/api/work-ledger/turn/session') {
      return json(route, legacySessionDiscoveryResponse());
    }

    // ── Sessions union ─────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/sessions') {
      return json(route, unionListResponse());
    }
    const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (method === 'GET' && messagesMatch) {
      return json(route, messagesResponse(decodeURIComponent(messagesMatch[1])));
    }
    const steerMatch = path.match(/^\/api\/sessions\/([^/]+)\/steer$/);
    if (method === 'POST' && steerMatch) {
      const sessionId = decodeURIComponent(steerMatch[1]);
      const requestBody = request.postDataJSON?.() ?? request.postData();
      daemon.steerRequests.push({ sessionId, body: requestBody });
      const session = SEED_SESSIONS.find((s) => s.id === sessionId);
      const dispatchedBody = typeof requestBody === 'object' && requestBody !== null && 'body' in requestBody
        ? String((requestBody as { body?: unknown }).body ?? '')
        : '';
      return json(route, dispatchOutcome(session, 'steer', dispatchedBody, `in-${daemon.steerRequests.length}`));
    }
    // sessions.toolCalls.cancel (SDK 1.8.0's interaction-wins round), stop one running
    // tool call mid-flight; the turn continues (this mock never ends it).
    const toolCallCancelMatch = path.match(/^\/api\/sessions\/([^/]+)\/tool-calls\/([^/]+)\/cancel$/);
    if (method === 'POST' && toolCallCancelMatch) {
      const sessionId = decodeURIComponent(toolCallCancelMatch[1]);
      const callId = decodeURIComponent(toolCallCancelMatch[2]);
      daemon.toolCallCancelRequests.push({ sessionId, callId });
      return json(route, { sessionId, callId, cancelled: true });
    }

    // sessions.queuedMessages.list/edit/delete (SDK 1.8.0's interaction-wins round),
    // a message posted while a turn is running sits queued until that turn ends;
    // review/edit/drop it before it is ever sent.
    const queuedMessageItemMatch = path.match(/^\/api\/sessions\/([^/]+)\/queued-messages\/([^/]+)$/);
    if (queuedMessageItemMatch) {
      const sessionId = decodeURIComponent(queuedMessageItemMatch[1]);
      const messageId = decodeURIComponent(queuedMessageItemMatch[2]);
      const messages = queuedMessagesBySession[sessionId] ?? [];
      if (method === 'POST') {
        const body = (request.postDataJSON?.() ?? {}) as { text?: string };
        const existing = messages.find((m) => m.id === messageId);
        if (existing) existing.text = body.text ?? existing.text;
        return json(route, { sessionId, id: messageId, text: existing?.text ?? body.text ?? '' });
      }
      if (method === 'DELETE') {
        const index = messages.findIndex((m) => m.id === messageId);
        const deleted = index >= 0;
        if (deleted) messages.splice(index, 1);
        queuedMessagesBySession[sessionId] = messages;
        return json(route, { sessionId, id: messageId, deleted });
      }
    }
    const queuedMessagesListMatch = path.match(/^\/api\/sessions\/([^/]+)\/queued-messages$/);
    if (method === 'GET' && queuedMessagesListMatch) {
      const sessionId = decodeURIComponent(queuedMessagesListMatch[1]);
      return json(route, { sessionId, messages: queuedMessagesBySession[sessionId] ?? [] });
    }

    // sessions.detach (WEBUI-FLEET-DEPTH), remove one participant surfaceId from a
    // session WITHOUT closing/killing it. Idempotent success regardless of whether the
    // surface was actually attached, matching the real verb's own idempotency contract.
    const detachMatch = path.match(/^\/api\/sessions\/([^/]+)\/detach$/);
    if (method === 'POST' && detachMatch) {
      const sessionId = decodeURIComponent(detachMatch[1]);
      const requestBody = (request.postDataJSON?.() ?? {}) as { surfaceId?: string };
      daemon.detachRequests.push({ sessionId, surfaceId: requestBody.surfaceId ?? '' });
      const session = SEED_SESSIONS.find((s) => s.id === sessionId);
      return json(route, { session: session ? sessionRecord(session) : { id: sessionId } });
    }
    const followUpMatch = path.match(/^\/api\/sessions\/([^/]+)\/follow-up$/);
    if (method === 'POST' && followUpMatch) {
      const sessionId = decodeURIComponent(followUpMatch[1]);
      const requestBody = request.postDataJSON?.() ?? request.postData();
      daemon.followUpRequests.push({ sessionId, body: requestBody });
      const session = SEED_SESSIONS.find((s) => s.id === sessionId);
      const dispatchedBody = typeof requestBody === 'object' && requestBody !== null && 'body' in requestBody
        ? String((requestBody as { body?: unknown }).body ?? '')
        : '';
      return json(route, dispatchOutcome(session, 'follow-up', dispatchedBody, `fu-${daemon.followUpRequests.length}`));
    }
    const sessionGetMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionGetMatch) {
      const id = decodeURIComponent(sessionGetMatch[1]);
      return json(route, messagesResponse(id));
    }

    // sessions.permissionMode.get/set (SDK 1.6.1), session-scoped, honest
    // SESSION_NOT_LOCAL for any id other than localSessionId (see that option's
    // header comment above).
    const permissionModeMatch = path.match(/^\/api\/sessions\/([^/]+)\/permission-mode$/);
    if (permissionModeMatch) {
      const sessionId = decodeURIComponent(permissionModeMatch[1]);
      if (sessionId !== localSessionId) return sessionNotLocal(route, sessionId);
      if (method === 'GET') return json(route, { sessionId, mode: permissionMode });
      if (method === 'POST') {
        const body = (request.postDataJSON?.() ?? {}) as { mode?: string };
        const previousMode = permissionMode;
        if (body.mode) permissionMode = body.mode as typeof permissionMode;
        return json(route, { sessionId, mode: permissionMode, previousMode });
      }
    }

    // sessions.contextUsage.get (SDK 1.6.1), same session-scoped honesty as above.
    // The percentage/remaining are derived server-side from the two seeded numbers,
    // mirroring the real daemon's runtime/context-usage.ts helper.
    const contextUsageMatch = path.match(/^\/api\/sessions\/([^/]+)\/context-usage$/);
    if (method === 'GET' && contextUsageMatch) {
      const sessionId = decodeURIComponent(contextUsageMatch[1]);
      if (sessionId !== localSessionId) return sessionNotLocal(route, sessionId);
      const { estimatedContextTokens, contextWindow } = contextUsageState;
      return json(route, {
        sessionId,
        estimatedContextTokens,
        contextWindow,
        contextUsagePct: contextWindow > 0 ? Math.round((estimatedContextTokens / contextWindow) * 100) : 0,
        contextRemainingTokens: Math.max(0, contextWindow - estimatedContextTokens),
        estimated: true,
      });
    }

    // ── Companion chat sessions (carry the sidebar per-row delete control) ──
    // Served from the stateful list so a spawned CI fix session is a live,
    // navigable session, not an unknown id.
    if (method === 'GET' && path === '/api/companion/chat/sessions') {
      return json(route, { sessions: companionChatSessions });
    }
    if (path.startsWith('/api/companion/chat/sessions/')) {
      // messages / close / delete / detail, an honest empty success.
      return json(route, { messages: [], deleted: method === 'DELETE' });
    }

    // ── Providers ──────────────────────────────────────────────────────────
    // providers.get(id) → the single matching provider (wire-true), so the detail +
    // auth-routes panels render that provider's real routes/freshness.
    const providerGetMatch = path.match(/^\/api\/providers\/([^/]+)$/);
    if (method === 'GET' && providerGetMatch) {
      const id = decodeURIComponent(providerGetMatch[1]);
      const found = providersResponse().providers.find((p) => p.providerId === id);
      return json(route, found ?? {});
    }
    // providers.usage.get → GET /api/providers/{id}/usage. Carries pricing
    // provenance the same way cost rows and fleet nodes do: a snapshot-level
    // pricingSource/pricingAsOf plus per-model pricing.source/asOf. Must precede
    // the providers-list startsWith match below (that one would swallow this path).
    const providerUsageMatch = path.match(/^\/api\/providers\/([^/]+)\/usage$/);
    if (method === 'GET' && providerUsageMatch) {
      const id = decodeURIComponent(providerUsageMatch[1]);
      return json(route, {
        providerId: id,
        active: true,
        currentModelRegistryKey: `${id}:claude-3-5-haiku`,
        pricingSource: 'catalog',
        pricingAsOf: '2026-07-01T00:00:00.000Z',
        models: [
          {
            id: 'claude-3-5-haiku',
            registryKey: `${id}:claude-3-5-haiku`,
            displayName: 'Claude 3.5 Haiku',
            selectable: true,
            contextWindow: 200_000,
            tier: 'standard',
            pricing: {
              inputPerMillionTokens: 0.8,
              outputPerMillionTokens: 4,
              currency: 'USD',
              source: 'catalog',
              asOf: '2026-07-01T00:00:00.000Z',
            },
          },
        ],
        usage: {
          streaming: true,
          toolCalling: true,
          parallelTools: true,
          promptCaching: true,
          cost: { source: 'catalog', currency: 'USD', inputPerMillionTokens: 0.8, outputPerMillionTokens: 4 },
          notes: [],
        },
      });
    }
    if (method === 'GET' && path.startsWith('/api/providers')) {
      return json(route, providersResponse());
    }
    if (method === 'GET' && path === '/api/accounts') {
      return json(route, accountsSnapshotResponse());
    }

    // ── Models (models.current/models.select, the "main" target; ModelWorkspaceModal
    // sources its catalog from providers.list above, not this route, since this one
    // never carries tier/pricing on the real wire either, see model-catalog.ts). ──
    if (method === 'GET' && path === '/api/models/current') {
      return json(route, currentModel);
    }
    if (method === 'PATCH' && path === '/api/models/current') {
      const body = (request.postDataJSON?.() ?? {}) as { registryKey?: string };
      const registryKey = body.registryKey ?? '';
      const [provider, ...idParts] = registryKey.split(':');
      currentModel = {
        model: { registryKey, provider: provider ?? '', id: idParts.join(':') },
        configured: true,
        configuredVia: 'subscription',
      };
      return json(route, { ...currentModel, persisted: true });
    }
    if (method === 'GET' && path === '/api/models') {
      return json(route, { providers: [], currentModel: currentModel.model, secretsResolutionSkipped: false });
    }

    // ── Memory (memory.records.* / memory.review-queue, SDK 1.1.0) ─────────
    // Exact-path routes checked BEFORE the /{id} regexes below, since
    // '/api/memory/records/search' would otherwise itself match `records/([^/]+)`
    // with "search" read as an id.
    if (path === '/api/memory/records/search' && method === 'POST') {
      if (!memoryAvailable) return methodNotFound(route);
      const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>;
      let records = memoryRecords.slice();
      if (typeof body.cls === 'string') records = records.filter((r) => r.cls === body.cls);
      if (typeof body.scope === 'string') records = records.filter((r) => r.scope === body.scope);
      if (Array.isArray(body.tags) && body.tags.length) {
        const tags = body.tags as string[];
        records = records.filter((r) => tags.every((tag) => r.tags.includes(tag)));
      }
      if (typeof body.query === 'string' && body.query.trim()) {
        const q = body.query.trim().toLowerCase();
        records = records.filter((r) => r.summary.toLowerCase().includes(q) || (r.detail ?? '').toLowerCase().includes(q));
      }
      const requestedSemantic = body.semantic === true;
      const indexUnavailableReason = requestedSemantic && memoryIndexUnavailable
        ? 'Semantic index unavailable: sqlite-vec extension failed to load, falling back to a literal scan'
        : null;
      const mode: 'literal' | 'semantic' = requestedSemantic && !indexUnavailableReason ? 'semantic' : 'literal';
      const recall = body.recall === true;
      const totalBeforeRecallFilter = records.length;
      // Mirrors the SDK's memory-recall-contract.ts MIN_PROMPT_MEMORY_CONFIDENCE (60),
      // the mock daemon's own confidence-floor check below, and now also promoted onto
      // the wire as `recallFloor` (recallFloor is on the wire per the final SDK's
      // HonestMemorySearchResult), so MemorySearchHonestyNote/MemoryRecordRow's labels
      // read this value instead of a hardcoded percentage.
      const recallFloor = 60;
      let excludedFlaggedCount = 0;
      let excludedBelowFloorCount = 0;
      if (recall) {
        const kept: typeof records = [];
        for (const record of records) {
          if (record.reviewState === 'stale' || record.reviewState === 'contradicted') {
            excludedFlaggedCount += 1;
            continue;
          }
          if (record.confidence < recallFloor) {
            excludedBelowFloorCount += 1;
            continue;
          }
          kept.push(record);
        }
        records = kept;
      }
      return json(route, {
        records,
        mode,
        requestedSemantic,
        indexUnavailableReason,
        caveat: null,
        recallFiltered: recall,
        excludedFlaggedCount,
        excludedBelowFloorCount,
        totalBeforeRecallFilter,
        recallFloor,
      });
    }
    if (path === '/api/memory/records' && method === 'POST') {
      if (!memoryAvailable) return methodNotFound(route);
      const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>;
      memoryIdCounter += 1;
      const now = Date.now();
      const record: MemoryRecordWire = {
        id: `mem-added-${memoryIdCounter}`,
        scope: asMemoryScope(body.scope),
        cls: typeof body.cls === 'string' ? body.cls : '',
        summary: typeof body.summary === 'string' ? body.summary : '',
        ...(typeof body.detail === 'string' && body.detail ? { detail: body.detail } : {}),
        tags: asStringArray(body.tags),
        provenance: asProvenanceArray(body.provenance),
        reviewState: 'fresh',
        confidence: 60,
        createdAt: now,
        updatedAt: now,
      };
      memoryRecords = [record, ...memoryRecords];
      return json(route, { record });
    }
    if (path === '/api/memory/review-queue' && method === 'GET') {
      if (!memoryAvailable) return methodNotFound(route);
      return json(route, { records: memoryRecords.filter((r) => r.confidence < 60 || r.reviewState === 'fresh') });
    }
    const memoryReviewMatch = path.match(/^\/api\/memory\/records\/([^/]+)\/review$/);
    if (method === 'POST' && memoryReviewMatch) {
      if (!memoryAvailable) return methodNotFound(route);
      const id = decodeURIComponent(memoryReviewMatch[1]);
      const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>;
      const index = memoryRecords.findIndex((r) => r.id === id);
      if (index === -1) return json(route, { error: 'Not found' }, 404);
      const now = Date.now();
      memoryRecords[index] = {
        ...memoryRecords[index],
        ...(typeof body.state === 'string'
          ? { reviewState: asMemoryReviewState(body.state, memoryRecords[index].reviewState) }
          : {}),
        ...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
        ...(typeof body.reviewedBy === 'string' ? { reviewedBy: body.reviewedBy } : {}),
        ...(typeof body.staleReason === 'string' ? { staleReason: body.staleReason } : {}),
        reviewedAt: now,
        updatedAt: now,
      };
      return json(route, { record: memoryRecords[index] });
    }
    const memoryRecordMatch = path.match(/^\/api\/memory\/records\/([^/]+)$/);
    if (method === 'GET' && memoryRecordMatch) {
      if (!memoryAvailable) return methodNotFound(route);
      const id = decodeURIComponent(memoryRecordMatch[1]);
      const found = memoryRecords.find((r) => r.id === id);
      if (!found) return json(route, { error: 'Not found' }, 404);
      return json(route, { record: found });
    }
    if (method === 'DELETE' && memoryRecordMatch) {
      if (!memoryAvailable) return methodNotFound(route);
      const id = decodeURIComponent(memoryRecordMatch[1]);
      const before = memoryRecords.length;
      memoryRecords = memoryRecords.filter((r) => r.id !== id);
      // Delete-means-delete: an honest boolean, never a 200 pretending a phantom row
      // was removed.
      return json(route, { id, deleted: memoryRecords.length < before });
    }
    // memory.consolidation.receipts (SDK 1.8.0), the retained consolidation run
    // receipts + pending judgment proposals. 'unavailable' answers the daemon's own
    // honest 501 (no consolidation scheduler wired), DISTINCT from memoryAvailable's
    // 404 (the memory.* family itself absent); both render the same honest "not
    // available" state client-side (ConsolidationReceipts checks both).
    if (path === '/api/memory/consolidation/receipts' && method === 'GET') {
      if (!memoryAvailable) return methodNotFound(route);
      if (consolidationReceipts === 'unavailable') {
        return json(route, { error: 'No memory consolidation scheduler is wired on this runtime', code: 'CONSOLIDATION_UNAVAILABLE' }, 501);
      }
      if (consolidationReceipts === 'empty') {
        return json(route, { receipts: [], pendingProposals: [] });
      }
      const proposal = {
        kind: 'contradiction' as const,
        ids: ['mem-fact-1', 'mem-review-1'],
        route: 'memory action:"curator" query:"consolidation"',
        reason: 'Same-summary records disagree and neither is a clearly-newer verified winner.',
      };
      const receipt = {
        runId: 'mcon-e2e-1',
        ranAt: new Date(1_700_000_100_000).toISOString(),
        trigger: 'idle',
        idle: true,
        scanned: memoryRecords.length,
        merged: [],
        archived: [],
        decayed: [],
        proposed: [proposal],
        usageSignalAvailable: true,
        note: 'Idle consolidation performs only reversible merges (loser marked stale, not deleted) and never-referenced-first decay. New memories and deletes are proposed through the existing confirmation-gated routes, never written silently.',
      };
      return json(route, { receipts: [receipt], pendingProposals: [proposal] });
    }

    // ── Knowledge map / status ─────────────────────────────────────────────
    if (path.includes('/knowledge') || path.includes('knowledge')) {
      return json(route, knowledgeMapResponse());
    }

    // ── Watchers (WEBUI-FLEET-DEPTH, the one fleet-node kind with a real stop verb) ──
    const watcherStopMatch = path.match(/^\/api\/watchers\/([^/]+)\/stop$/);
    if (method === 'POST' && watcherStopMatch) {
      const watcherId = decodeURIComponent(watcherStopMatch[1]);
      daemon.watcherStopRequests.push(watcherId);
      return json(route, { id: watcherId, kind: 'watcher', label: 'Docs watcher', state: 'killed' });
    }

    // ── Approvals (WEBUI-FLEET-DEPTH, approve/deny/claim/cancel, "approve from the
    //    tree" AND the standalone Approvals view share this same mutable list). ──
    if (method === 'GET' && path === '/api/approvals') {
      const pending = approvals.filter((a) => a.status === 'pending').length;
      return json(route, {
        awaitingDecision: pending > 0, mode: 'manual', approvalCount: 0, denialCount: 0,
        cachedChecks: 0, totalChecks: 0, approvals,
      });
    }
    const approvalActionMatch = path.match(/^\/api\/approvals\/([^/]+)\/(approve|deny|claim|cancel)$/);
    if (method === 'POST' && approvalActionMatch) {
      const approvalId = decodeURIComponent(approvalActionMatch[1]);
      const action = approvalActionMatch[2] as 'approve' | 'deny' | 'claim' | 'cancel';
      const requestBody = request.postDataJSON?.() ?? {};
      daemon.approvalActions.push({ approvalId, action, body: requestBody });
      const record = approvals.find((a) => a.id === approvalId);
      // The `recorded` block the daemon now returns: its authoritative report of
      // what the broker did with the forwarded decision fields. Built alongside
      // the decision mutation so it reflects exactly the same outcome.
      let recorded: {
        approved: boolean;
        rememberTier: string | null;
        reasonStored: boolean;
        modifiedArgsDelivered: boolean;
      } | undefined;
      if (record) {
        const body = requestBody as Record<string, unknown>;
        if (action === 'approve') {
          // Mirror the broker's decision record: remember tier and the
          // exec-prompt answer land on decision, and the route forwards them
          // into resolution, the `recorded` block reports what stuck.
          const rememberTier = typeof body.rememberTier === 'string' ? body.rememberTier : undefined;
          const modifiedArgs = body.modifiedArgs && typeof body.modifiedArgs === 'object' ? body.modifiedArgs as Record<string, unknown> : undefined;
          const reason = typeof body.reason === 'string' && body.reason ? body.reason : undefined;
          Object.assign(record, {
            status: 'approved', resolvedAt: Date.now(), resolvedBy: 'operator',
            decision: {
              approved: true,
              ...(body.remember === true ? { remember: true } : {}),
              ...(rememberTier ? { rememberTier } : {}),
              ...(reason ? { reason } : {}),
              ...(modifiedArgs ? { modifiedArgs } : {}),
            },
          });
          recorded = {
            approved: true,
            rememberTier: rememberTier ?? null,
            reasonStored: reason !== undefined,
            // A modifiedArgs answer reaches the run (delivered) when one was sent.
            modifiedArgsDelivered: typeof modifiedArgs?.answer === 'string',
          };
          // An accepted CI "fix this?" offer spawns a fix session whose REAL,
          // attachable session id the broker stamps onto the resolved APPROVED
          // record and publishes live, or, on a failed spawn, the honest
          // fixSessionError instead of a dead id (SDK bb4b9c30). Mirrored here:
          // the stamped record is what the next approvals read serves; the
          // spawned session is servable by the session store; denied records
          // are never stamped.
          if ((record.request as Record<string, unknown>).tool === 'ci:fix-session') {
            const args = (record.request as { args?: Record<string, unknown> }).args ?? {};
            const spawned = spawnCiFixSession(String(args.repo ?? 'unknown/repo'));
            Object.assign(record, 'sessionId' in spawned
              ? { fixSessionId: spawned.sessionId }
              : { fixSessionError: spawned.error });
          }
          // A durable tier persists a rule and SWEEPS queued pending asks for
          // the same tool (the broker's remembered-decision sweep, simplified
          // to tool identity at mock level).
          if (rememberTier && ['exact', 'command-class', 'path', 'tool'].includes(rememberTier)) {
            const request = record.request as Record<string, unknown>;
            ruleCounter += 1;
            permissionRules.push({
              id: `rule-mock-${ruleCounter}`,
              effect: 'allow',
              tier: rememberTier,
              tool: String(request.tool ?? ''),
              description: `remembered ${rememberTier} decision on ${approvalId}`,
              createdAt: Date.now(),
            });
            for (const other of approvals) {
              if (other === record || other.status !== 'pending') continue;
              const otherRequest = other.request as Record<string, unknown>;
              if (otherRequest.tool !== request.tool) continue;
              Object.assign(other, {
                status: 'approved', resolvedAt: Date.now(), resolvedBy: 'operator',
                decision: { approved: true },
                metadata: { ...(other.metadata as Record<string, unknown> ?? {}), sweptBy: approvalId },
              });
            }
          }
        } else if (action === 'deny') {
          const reason = typeof body.reason === 'string' && body.reason ? body.reason : undefined;
          const rememberTier = typeof body.rememberTier === 'string' ? body.rememberTier : undefined;
          Object.assign(record, {
            status: 'denied', resolvedAt: Date.now(), resolvedBy: 'operator',
            decision: {
              approved: false,
              ...(rememberTier ? { rememberTier } : {}),
              ...(reason ? { reason } : {}),
            },
          });
          recorded = {
            approved: false,
            rememberTier: rememberTier ?? null,
            reasonStored: reason !== undefined,
            modifiedArgsDelivered: false,
          };
        } else if (action === 'cancel') Object.assign(record, { status: 'cancelled', resolvedAt: Date.now(), resolvedBy: 'operator' });
        else if (action === 'claim') Object.assign(record, { status: 'claimed', claimedBy: 'operator', claimedAt: Date.now() });
      }
      return json(route, { approval: record ?? {}, ...(recorded ? { recorded } : {}) });
    }

    // ── Generic control-plane invoke (POST .../methods/{id}/invoke) ─────────
    const invokeMatch = path.match(/^\/api\/control-plane\/methods\/([^/]+)\/invoke$/);
    if (method === 'POST' && invokeMatch) {
      const methodId = decodeURIComponent(invokeMatch[1]);
      if (methodId === 'control.status') return json(route, { ok: true, status: 'running' });
      // Durable approval rules (snapshot rounds 4-6). Explicit handlers, the
      // recorded gotcha: an unknown invoke id answering {} crashes views that
      // don't optional-chain; these two now have real shapes AND the views
      // chain defensively anyway.
      if (methodId === 'permissions.rules.list') {
        return json(route, { rules: [...permissionRules].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)) });
      }
      if (methodId === 'permissions.rules.delete') {
        const body = (request.postDataJSON?.() ?? {}) as { body?: { ruleId?: string } };
        const ruleId = body.body?.ruleId;
        const index = permissionRules.findIndex((r) => r.id === ruleId);
        if (index >= 0) permissionRules.splice(index, 1);
        return json(route, { deleted: index >= 0 });
      }
      if (methodId.includes('knowledge')) return json(route, knowledgeMapResponse());
      if (methodId === 'sessions.search') return json(route, unionListResponse());
      if (methodId === 'fleet.snapshot') {
        // Once a fleet event has been emitted over the subscription, the snapshot
        // gains FLEET_EVENT_NODE, the node the event announced. A test asserting
        // this node appears proves the event drove the refetch (it is never in the
        // baseline, and shows up well before the poll fallback would fire).
        const base = fleetEnriched ? [...FLEET_SNAPSHOT.nodes, FLEET_EVENT_NODE] : FLEET_SNAPSHOT.nodes;
        const nodes = base.filter((node) => !archivedFleetIds.has(node.id)).map(withManualPricing);
        return json(route, { ...FLEET_SNAPSHOT, nodes, totalCount: nodes.length });
      }
      if (methodId === 'fleet.list') {
        const base = fleetEnriched ? [...FLEET_SNAPSHOT.nodes, FLEET_EVENT_NODE] : FLEET_SNAPSHOT.nodes;
        const items = base.filter((node) => !archivedFleetIds.has(node.id)).map(withManualPricing);
        return json(route, { items, hasMore: false, capturedAt: FLEET_SNAPSHOT.capturedAt });
      }
      // ── Fleet archive (SDK 1.6.x): stateful enough to prove the archive →
      //    browse → restore round trip honestly. Only terminal nodes archive,
      //    mirroring the daemon's refusal for live subtrees.
      if (methodId === 'fleet.archive') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { id?: string } };
        const id = body.body?.id ?? '';
        const node = FLEET_SNAPSHOT.nodes.find((n) => n.id === id);
        if (!node) return json(route, { archived: false, count: 0, reason: `node ${id} not found` });
        if (!['done', 'failed', 'killed', 'interrupted'].includes(node.state)) {
          return json(route, { archived: false, count: 0, reason: '1 node(s) in the subtree are still active, only finished subtrees can be archived' });
        }
        archivedFleetIds.add(id);
        return json(route, { archived: true, count: 1 });
      }
      if (methodId === 'fleet.unarchive') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { id?: string } };
        const existed = archivedFleetIds.delete(body.body?.id ?? '');
        return json(route, { restored: existed ? 1 : 0 });
      }
      // fleet.observed.steer (SDK 1.8.0): steer an observed foreign-agent row over its
      // genuine channel. Honest refusal for an id this daemon does not know, or one
      // whose steer channel is 'none', mirroring the real verb's own refusal (a
      // client should never call this for a 'none' channel anyway; this mock
      // enforces the same rule so a mistaken call is caught, not silently accepted).
      if (methodId === 'fleet.observed.steer') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { id?: string; text?: string } };
        const id = body.body?.id ?? '';
        const text = body.body?.text ?? '';
        daemon.observedSteerRequests.push({ id, text });
        const node = FLEET_SNAPSHOT.nodes.find((n) => n.id === id) as { observed?: { steer?: { kind?: string } } } | undefined;
        if (!node?.observed) return json(route, { queued: false, reason: `observed node ${id} not found` });
        if (node.observed.steer?.kind !== 'tmux') {
          return json(route, { queued: false, reason: 'no steer channel exists for this observed session' });
        }
        return json(route, { queued: true, messageId: `obs-msg-${daemon.observedSteerRequests.length}` });
      }
      if (methodId === 'fleet.archiveFinished') {
        let archived = 0;
        for (const node of FLEET_SNAPSHOT.nodes) {
          if (['done', 'failed', 'killed', 'interrupted'].includes(node.state) && !archivedFleetIds.has(node.id)) {
            archivedFleetIds.add(node.id);
            archived++;
          }
        }
        return json(route, { archivedCount: archived });
      }
      if (methodId === 'fleet.archived.list') {
        return json(route, {
          capturedAt: FLEET_SNAPSHOT.capturedAt,
          nodes: FLEET_SNAPSHOT.nodes.filter((node) => archivedFleetIds.has(node.id)),
        });
      }
      if (methodId === 'checkpoints.list') return json(route, { checkpoints: checkpointsList });
      if (methodId === 'checkpoints.create') {
        // Same invoke-tunnel wrapper every other checkpoints.* handler above/below
        // unwraps (`body.body?.*`), this one read the top level and so never saw
        // a real caller's label (it was always undefined, silently falling back to
        // the empty string every time).
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { label?: string } };
        const created = {
          id: `wcp_e2e_${checkpointsList.length + 1}`,
          kind: 'manual',
          label: body.body?.label ?? '',
          createdAt: Date.now(),
          parentId: checkpointsList[0]?.id ?? null,
          retentionClass: 'standard',
          commit: 'ffffff000000',
          sizeBytes: 1024,
        };
        checkpointsList = [created, ...checkpointsList];
        return json(route, { checkpoint: created, noop: false });
      }
      if (methodId === 'checkpoints.diff') {
        return json(route, {
          diff: { from: 'wcp_e2e_1', to: 'WORKING', files: ['src/example.ts'], unifiedDiff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n', stat: '1 file changed' },
        });
      }
      // checkpoints.restorePreview (SDK 1.6.1): non-destructive preview + a
      // single-use token the confirm-aware restore consumes. The webui confirm
      // flow calls this before opening the ConfirmSheet.
      if (methodId === 'checkpoints.restorePreview') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { id?: string } };
        const id = body.body?.id ?? 'wcp_e2e_1';
        const checkpoint = checkpointsList.find((c) => c.id === id);
        return json(route, {
          token: `tok_${id}`,
          expiresAt: Date.now() + 120000,
          preview: {
            checkpointId: id,
            label: checkpoint?.label ?? '',
            affectedPathCount: 1,
            affectedPathSample: ['src/example.ts'],
            stat: '1 file changed',
          },
        });
      }
      // checkpoints.restore (SDK 1.6.1): refuses without confirmation. A caller
      // must pass confirm:true or a confirmToken from restorePreview; an
      // unconfirmed call gets the structured, non-destructive refusal body.
      if (methodId === 'checkpoints.restore') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { confirm?: boolean; confirmToken?: string } };
        const confirmed = body.body?.confirm === true || typeof body.body?.confirmToken === 'string';
        if (!confirmed) {
          return json(route, {
            result: null,
            refused: true,
            refusal: {
              reason: 'checkpoints.restore is destructive (a git-backed workspace rewrite) and requires confirmation before it will run.',
              confirmField: 'confirm',
              previewMethod: 'checkpoints.restorePreview',
              options: [
                'Pass confirm:true to acknowledge the destructive restore and execute it immediately.',
                'Call checkpoints.restorePreview for this id, then pass the returned token as confirmToken.',
              ],
            },
          });
        }
        return json(route, {
          result: { checkpointId: 'wcp_e2e_1', safetyCheckpointId: null, restoredFiles: ['src/example.ts'], removedFiles: [] },
          refused: false,
          refusal: null,
        });
      }
      // sessions.changes.get (SDK 1.6.1): the session-scoped aggregate diff, joined
      // over checkpoints stamped with a session's id. localSessionId (default
      // 's-agent-live') is treated as the one session with a stamped checkpoint, the
      // real daemon's join is genuinely session-scoped, not a fixed id-based guess, but
      // for this hermetic mock any OTHER session id gets the honest checkpointCount:0
      // empty result (from/to:"EMPTY"), same as a session that predates sessionId
      // stamping. Reuses the seeded checkpointsList's single entry as the "stamped"
      // checkpoint so the diff content lines up with the workspace-scoped fallback.
      if (methodId === 'sessions.changes.get') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { sessionId?: string } };
        const sessionId = body.body?.sessionId ?? '';
        if (sessionId !== localSessionId || !checkpointsList.length) {
          return json(route, {
            sessionId, checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY',
            files: [], unifiedDiff: '', stat: '',
          });
        }
        const stamped = checkpointsList[0];
        return json(route, {
          sessionId,
          checkpointCount: 1,
          checkpointIds: [stamped.id],
          from: 'EMPTY',
          to: stamped.id,
          files: ['src/example.ts'],
          unifiedDiff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n',
          stat: '1 file changed',
        });
      }
      // cost.attribution.get (SDK 1.6.1): windowed, cache-aware-priced cost attribution
      // grouped by dimension. A real, honest fixture, one priced row plus one unpriced
      // record folded into the totals, so the honest-unpriced labeling has real content
      // to prove against rather than an all-zero stub.
      if (methodId === 'cost.attribution.get') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { window?: string; dimension?: string } };
        const window = body.body?.window ?? '24h';
        const dimension = body.body?.dimension ?? 'session';
        const key = dimension === 'session' ? localSessionId : `${dimension}-e2e-1`;
        const tokens = { inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 2000, cacheWriteTokens: 500 };
        // Provenance rides the wire now: the aggregate spans more than one
        // pricing tier ('mixed'), the single session row was priced from the
        // catalog, both dated. The webui renders these verbatim, never
        // re-deriving a source or inventing an as-of date.
        return json(route, {
          window, windowStartMs: 1_700_000_000_000, dimension,
          totalCostUsd: 0.18, costState: 'estimated', pricedRecordCount: 4, unpricedRecordCount: 1,
          costSource: 'mixed', pricingAsOf: '2026-07-01T00:00:00.000Z',
          tokens,
          rows: [{
            key, costUsd: 0.18, costState: 'estimated', pricedRecordCount: 4, unpricedRecordCount: 1,
            costSource: 'catalog', pricingAsOf: '2026-07-01T00:00:00.000Z', tokens,
          }],
        });
      }
      // ── Web Push (push.*), the PWA subscription lifecycle. ────────────────
      if (methodId === 'push.vapid.get') {
        return json(route, { publicKey: pushVapidKey });
      }
      if (methodId === 'push.subscriptions.create') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { endpoint?: string; deviceId?: string } };
        const endpoint = body.body?.endpoint ?? 'https://push.example/endpoint';
        const deviceId = body.body?.deviceId;
        let origin = 'https://push.example';
        try {
          origin = new URL(endpoint).origin;
        } catch {
          /* keep the fallback origin */
        }
        pushIdCounter += 1;
        const subscription = {
          id: `push_e2e_${pushIdCounter}`,
          principalId: 'operator',
          ...(deviceId ? { deviceId } : {}),
          endpointOrigin: origin,
          endpointHash: `hash-${pushIdCounter}`,
          createdAt: Date.now(),
        };
        // Register-in-place: one subscription per origin, mirroring the real verb.
        pushSubscriptions = [...pushSubscriptions.filter((s) => s.endpointOrigin !== origin), subscription];
        return json(route, { subscription });
      }
      if (methodId === 'push.subscriptions.list') {
        return json(route, { subscriptions: pushSubscriptions });
      }
      if (methodId === 'push.subscriptions.delete') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { subscriptionId?: string } };
        const id = body.body?.subscriptionId ?? '';
        const existed = pushSubscriptions.some((s) => s.id === id);
        if (!existed) return json(route, { error: 'Subscription not found', code: 'SUBSCRIPTION_NOT_FOUND' }, 404);
        pushSubscriptions = pushSubscriptions.filter((s) => s.id !== id);
        return json(route, { subscriptionId: id, deleted: true });
      }
      if (methodId === 'push.subscriptions.verify') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { subscriptionId?: string } };
        const id = body.body?.subscriptionId ?? '';
        const found = pushSubscriptions.find((s) => s.id === id);
        if (!found) return json(route, { error: 'Subscription not found', code: 'SUBSCRIPTION_NOT_FOUND' }, 404);
        return json(route, { receipt: { subscriptionId: id, endpointOrigin: found.endpointOrigin, outcome: 'delivered' } });
      }
      // reconcile (SDK 1.8.0): heal-in-place by deviceId, honestly reporting what
      // drifted, mirrors the real daemon's push/subscription-store.ts reconcile().
      // The mock's endpointHash is a placeholder string (never the real sha256 the
      // client computes), so a reconcilePushSubscriptionOnOpen call against a
      // pushSeed record always reports genuine drift, exactly like a real stale
      // record would, there is no accidental false "unchanged" here.
      if (methodId === 'push.subscriptions.reconcile') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { endpoint?: string; deviceId?: string } };
        const endpoint = body.body?.endpoint ?? 'https://push.example/endpoint';
        const deviceId = body.body?.deviceId ?? '';
        let origin = 'https://push.example';
        try {
          origin = new URL(endpoint).origin;
        } catch {
          /* keep the fallback origin */
        }
        const existingIndex = pushSubscriptions.findIndex((s) => s.deviceId === deviceId);
        pushIdCounter += 1;
        const drift = existingIndex >= 0 ? 'endpoint-updated' : 'created';
        const subscription = {
          id: existingIndex >= 0 ? pushSubscriptions[existingIndex].id : `push_e2e_${pushIdCounter}`,
          principalId: 'operator',
          deviceId,
          endpointOrigin: origin,
          endpointHash: `hash-reconciled-${pushIdCounter}`,
          createdAt: existingIndex >= 0 ? pushSubscriptions[existingIndex].createdAt : Date.now(),
        };
        if (existingIndex >= 0) {
          pushSubscriptions = pushSubscriptions.map((s, i) => (i === existingIndex ? subscription : s));
        } else {
          pushSubscriptions = [...pushSubscriptions, subscription];
        }
        return json(route, { subscription, drift });
      }
      // ── Pairing tokens (pairing.tokens.*, SDK 1.8.0), per-device revocable
      //    tokens. `token` (the literal secret) is stored HERE ONLY (never
      //    reflected back from list/rename/delete, real custody), so a test
      //    can capture it from create/migrate's response and use it as this
      //    "device"'s Authorization bearer on a second page/context. ──────────
      if (methodId === 'pairing.tokens.list') {
        return json(route, {
          tokens: pairingStore.tokens.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
          legacySharedRevoked: pairingStore.legacySharedRevoked,
        });
      }
      if (methodId === 'pairing.tokens.create' || methodId === 'pairing.tokens.migrate') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { name?: string } };
        const name = body.body?.name ?? 'Device';
        pairingIdCounter += 1;
        const minted = {
          id: `pairing_e2e_${pairingIdCounter}`,
          name,
          token: `e2e-pairing-token-${pairingIdCounter}`,
          createdAt: Date.now(),
        };
        pairingStore.tokens = [...pairingStore.tokens, minted];
        return json(route, { token: minted });
      }
      if (methodId === 'pairing.tokens.rename') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { id?: string; name?: string } };
        const id = body.body?.id ?? '';
        const name = body.body?.name ?? '';
        const found = pairingStore.tokens.find((t) => t.id === id);
        if (found) found.name = name;
        return json(route, { id, renamed: Boolean(found) });
      }
      if (methodId === 'pairing.tokens.delete') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { id?: string } };
        const id = body.body?.id ?? '';
        const found = pairingStore.tokens.find((t) => t.id === id);
        if (found) {
          pairingStore.revokedTokenValues.add(found.token);
          pairingStore.tokens = pairingStore.tokens.filter((t) => t.id !== id);
        }
        return json(route, { id, revoked: Boolean(found) });
      }
      if (methodId === 'pairing.tokens.revokeShared') {
        pairingStore.legacySharedRevoked = true;
        return json(route, { legacySharedRevoked: true });
      }
      // ── Pairing hand-off (pairing.handoff.*, SDK 1.8.0), the QR/deep-link
      //    bundle: one token + an offer set (notifications/relay/passkey), each
      //    independently declinable. create mints a token via the SAME store as
      //    pairing.tokens.* above; complete mirrors the real daemon's honest
      //    per-offer status (present in `accept` → completed, omitted or
      //    explicitly false → declined), good enough to prove the client
      //    renders each outcome honestly, without modeling `unavailable`/
      //    `failed` server-side (those are exercised as CLIENT-side ceremony
      //    failures in PairingHandoffOffers.test.tsx). ─────────────────────
      if (methodId === 'pairing.handoff.create') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { name?: string; offers?: string[] } };
        const name = body.body?.name ?? 'Paired device';
        const offers = body.body?.offers ?? ['notifications', 'relay', 'passkey'];
        pairingIdCounter += 1;
        const minted = { id: `pairing_e2e_${pairingIdCounter}`, name, token: `e2e-handoff-token-${pairingIdCounter}`, createdAt: Date.now() };
        pairingStore.tokens = [...pairingStore.tokens, minted];
        return json(route, {
          token: minted,
          offers: offers.map((kind) => (kind === 'notifications' ? { kind, available: true, vapidPublicKey: pushVapidKey } : { kind, available: true })),
          fragment: `pair=${minted.token}&offers=${offers.join(',')}`,
        });
      }
      if (methodId === 'pairing.handoff.complete') {
        const body = (route.request().postDataJSON?.() ?? {}) as {
          body?: { accept?: { notifications?: unknown; relay?: unknown; passkey?: unknown } };
        };
        const accept = body.body?.accept ?? {};
        const results = (['notifications', 'relay', 'passkey'] as const).map((kind) => {
          const offered = accept[kind];
          return offered === undefined || offered === false
            ? { kind, status: 'declined' }
            : { kind, status: 'completed' };
        });
        return json(route, { results });
      }
      // pairing.posture.get (SDK 1.8.0), computed from the SAME algorithm the real
      // daemon runs (describeOriginPostureForMock above), keyed off the origin the
      // caller actually passed (usePairingHandoff/useOriginPosture always pass their
      // OWN window.location.origin) so an e2e test at a simulated private-range origin
      // sees the exact daemon wording, not a fixed placeholder.
      if (methodId === 'pairing.posture.get') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { origin?: string } };
        const origin = body.body?.origin ?? 'http://127.0.0.1:4318';
        return json(route, { posture: describeOriginPostureForMock(origin) });
      }
      // ── Tailscale one-action https (tailscale.get / tailscale.serve.run,
      //    SDK 1.8.0). get is read-only; serve.run is the one state-changing
      //    action, recorded into tailscaleState.lastServe either way, a
      //    genuinely unusable environment (no httpsUrl) answers an honest
      //    failure receipt rather than pretending to serve. ──────────────────
      if (methodId === 'tailscale.get') {
        const { serveFailsWith: _serveFailsWith, ...wireState } = tailscaleState;
        return json(route, wireState);
      }
      if (methodId === 'tailscale.serve.run') {
        const receipt = tailscaleState.serveFailsWith
          ? { at: Date.now(), command: 'tailscale serve --bg 3421', ok: false, detail: tailscaleState.serveFailsWith }
          : tailscaleState.available && tailscaleState.loggedIn && tailscaleState.httpsUrl
            ? { at: Date.now(), command: 'tailscale serve --bg 3421', ok: true, url: tailscaleState.httpsUrl, detail: `tailscale serve is fronting port 3421 at ${tailscaleState.httpsUrl}` }
            : { at: Date.now(), command: 'tailscale serve --bg 3421', ok: false, detail: tailscaleState.detail };
        tailscaleState.lastServe = receipt;
        return json(route, { receipt, publicBaseUrlUpdated: receipt.ok });
      }
      // ── Hosted sessions (sessions.hosted.*, daemon-hosted sessions), a real, stateful
      //    mock: create/attach/detach/kill genuinely mutate the `hostedSessions`
      //    store, so a test can prove the round trip (create it, see it in the
      //    list, attach and see its history, detach and see attachedClients drop,
      //    kill and see status flip to terminated) rather than a static fixture. ──
      if (methodId === 'sessions.hosted.list') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { includeTerminated?: boolean } };
        const includeTerminated = body.body?.includeTerminated === true;
        const rows = hostedSessions
          .filter((s) => includeTerminated || s.status !== 'terminated')
          .slice()
          .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
        return json(route, { sessions: rows });
      }
      if (methodId === 'sessions.hosted.create') {
        const body = (route.request().postDataJSON?.() ?? {}) as {
          body?: { workspaceRoot?: string; title?: string; modelId?: string; detachPolicy?: 'kill' | 'survive'; clientId?: string };
        };
        hostedSessionIdCounter += 1;
        const now = Date.now();
        const detachPolicy = body.body?.detachPolicy ?? null;
        const record: Record<string, unknown> = {
          id: `hosted-e2e-created-${hostedSessionIdCounter}`,
          workspaceRoot: body.body?.workspaceRoot ?? '/home/operator/projects/example',
          title: body.body?.title ?? 'Untitled hosted session',
          status: 'idle',
          detachPolicy,
          effectiveDetachPolicy: detachPolicy ?? 'kill',
          attachedClients: body.body?.clientId ? [body.body.clientId] : [],
          ...(body.body?.modelId ? { modelId: body.body.modelId } : {}),
          createdAt: now,
          updatedAt: now,
          turnCount: 0,
          messageCount: 0,
          restoredFromDisk: false,
        };
        hostedSessions.push(record);
        return json(route, { session: record });
      }
      if (methodId === 'sessions.hosted.attach') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { sessionId?: string; clientId?: string } };
        const sessionId = body.body?.sessionId ?? '';
        const clientId = body.body?.clientId ?? '';
        const record = hostedSessions.find((s) => s.id === sessionId);
        if (!record) {
          return json(route, { error: `Unknown hosted session ${sessionId}`, code: 'NOT_FOUND' }, 404);
        }
        const attached = new Set(Array.isArray(record.attachedClients) ? record.attachedClients as string[] : []);
        if (clientId) attached.add(clientId);
        record.attachedClients = [...attached];
        record.updatedAt = Date.now();
        return json(route, { session: record, history: hostedSessionHistory[sessionId] ?? [] });
      }
      if (methodId === 'sessions.hosted.detach') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { sessionId?: string; clientId?: string } };
        const sessionId = body.body?.sessionId ?? '';
        const clientId = body.body?.clientId ?? '';
        const record = hostedSessions.find((s) => s.id === sessionId);
        if (!record) {
          return json(route, { error: `Unknown hosted session ${sessionId}`, code: 'NOT_FOUND' }, 404);
        }
        const attached = new Set(Array.isArray(record.attachedClients) ? record.attachedClients as string[] : []);
        attached.delete(clientId);
        record.attachedClients = [...attached];
        record.updatedAt = Date.now();
        // The effective policy decides ONLY when this was the last client, mirrors
        // the real daemon's "policy applies when the last client detaches" contract
        // (method-catalog-hosted-sessions.ts's sessions.hosted.detach description).
        if (attached.size === 0 && record.status !== 'terminated' && record.effectiveDetachPolicy === 'kill') {
          record.status = 'terminated';
          record.terminatedAt = Date.now();
          record.terminatedReason = 'detached';
        }
        return json(route, { session: record });
      }
      if (methodId === 'sessions.hosted.kill') {
        const body = (route.request().postDataJSON?.() ?? {}) as { body?: { sessionId?: string } };
        const sessionId = body.body?.sessionId ?? '';
        const record = hostedSessions.find((s) => s.id === sessionId);
        if (!record) {
          return json(route, { error: `Unknown hosted session ${sessionId}`, code: 'NOT_FOUND' }, 404);
        }
        // Killing an already-terminated session returns it unchanged (real verb's
        // own idempotence contract), never overwrite a genuine prior reason.
        if (record.status !== 'terminated') {
          record.status = 'terminated';
          record.terminatedAt = Date.now();
          record.terminatedReason = 'killed';
          record.attachedClients = [];
        }
        return json(route, { session: record });
      }

      // Default: a schema-valid output for any cataloged gateway method the scenario
      // handlers above did not model, seeded from the contract-generated fixtures
      // (WEBUI_METHOD_SAMPLES). This structurally kills the "unknown invoke id answers {}"
      // drift class, an uncataloged id still degrades to {} (an honest empty success),
      // but every real ws-invoke method now gets a shape its view can actually render.
      return json(route, WEBUI_METHOD_SAMPLES[methodId]?.output ?? {});
    }

    // ── Fallback: an honest empty success for any un-modelled surface. Views
    //    render their empty/degraded states rather than hanging. ─────────────
    if (method === 'GET') return json(route, {});
    return json(route, {});
  });

  // ── Knowledge candidates + packet (separate registrations, Playwright runs the
  //    LAST-registered route FIRST, so these override the generic knowledge fallback
  //    above for the specific paths they match, without touching that shared handler.
  //    Kept as their own page.route() calls, per this brief's file-ownership note,
  //    since five concurrent web UI worktrees touch this file. ───────────────────
  // Tracks decide() outcomes in-memory so a refetch after accept/reject/supersede
  // reflects the decision instead of replaying the static pending seed forever,
  // just enough state to prove the decide-then-refresh round trip honestly.
  const decidedCandidates = new Map<string, string>();

  await page.route('**/api/knowledge/candidates**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const decideMatch = path.match(/^\/api\/knowledge\/candidates\/([^/]+)\/decide$/);
    if (method === 'POST' && decideMatch) {
      const id = decodeURIComponent(decideMatch[1]);
      const body = request.postDataJSON?.() ?? {};
      const decision = typeof body === 'object' && body !== null && 'decision' in body ? String((body as { decision?: unknown }).decision ?? '') : '';
      const result = knowledgeCandidateDecideResponse(id, decision);
      decidedCandidates.set(id, result.candidate.status);
      return json(route, result);
    }
    const getMatch = path.match(/^\/api\/knowledge\/candidates\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const found = knowledgeCandidatesResponse().candidates.find((candidate) => candidate.id === id);
      const status = decidedCandidates.get(id);
      return json(route, { candidate: found ? { ...found, ...(status ? { status } : {}) } : null });
    }
    if (method === 'GET' && path === '/api/knowledge/candidates') {
      const withDecisions = knowledgeCandidatesResponse().candidates.map((candidate) => {
        const status = decidedCandidates.get(candidate.id);
        return status ? { ...candidate, status } : candidate;
      });
      return json(route, { candidates: withDecisions });
    }
    return json(route, {});
  });

  await page.route('**/api/knowledge/packet**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return json(route, {});
    const body = request.postDataJSON?.() ?? {};
    const task = typeof body === 'object' && body !== null && 'task' in body ? String((body as { task?: unknown }).task ?? '') : '';
    return json(route, knowledgePacketResponse(task, packet === 'truncated'));
  });

  // ── Calendar (calendar.events.*, calendar.ics.*), a genuinely separate domain
  //    from `/api/knowledge`, so it needs its own registration rather than piggy-
  //    backing on the generic knowledge fallback. `calendar: 'unconfigured'` answers
  //    the real 412 CALENDAR_NOT_CONFIGURED shape for every route, proving the
  //    honest bring-your-own-CalDAV state end to end. ──────────────────────────
  await page.route('**/api/calendar/**', async (route) => {
    if (calendar === 'unconfigured') {
      return json(route, CALENDAR_NOT_CONFIGURED_BODY, 412);
    }
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (method === 'GET' && path === '/api/calendar/events') {
      // Honor the requested window like the daemon does, so what the agenda shows
      // is what a real calendar would return for the selected range.
      const params = new URL(request.url()).searchParams;
      return json(route, calendarEventsResponse({ from: params.get('from'), to: params.get('to') }));
    }
    const eventGetMatch = path.match(/^\/api\/calendar\/events\/([^/]+)$/);
    if (method === 'GET' && eventGetMatch) {
      return json(route, calendarEventDetailResponse(decodeURIComponent(eventGetMatch[1])));
    }
    if (method === 'POST' && path === '/api/calendar/events') {
      return json(route, { eventId: 'ev-new', uid: 'ev-new@goodvibes', createdAt: new Date(0).toISOString() });
    }
    if (method === 'GET' && path === '/api/calendar/ics/export') {
      const params = new URL(request.url()).searchParams;
      return json(route, { icsContent: 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR', eventCount: calendarEventsResponse({ from: params.get('from'), to: params.get('to') }).events.length });
    }
    if (method === 'POST' && path === '/api/calendar/ics/import') {
      return json(route, { imported: 1, eventIds: ['ev-imported'], errors: [] });
    }
    return json(route, {});
  });

  // ── Email (email.inbox.*, email.send, email.draft.create), its own registration
  //    for the same reason calendar has one: a genuinely separate REST domain, not a
  //    knowledge-fallback path. The DEFAULT here is the 501 refusal, matching what a
  //    real daemon answers today (all four verbs ship `invokable: false` and no
  //    /api/email route is served), so the honest not-available state is what a test
  //    sees unless it explicitly asks for a working account. ────────────────────────
  await page.route('**/api/email/**', async (route) => {
    if (email === 'not-available') {
      return json(route, EMAIL_NOT_INVOKABLE_BODY, 501);
    }
    if (email === 'unconfigured') {
      return json(route, EMAIL_NOT_CONFIGURED_BODY, 412);
    }
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (method === 'GET' && path === '/api/email/inbox') {
      return json(route, emailInboxResponse());
    }
    const readMatch = path.match(/^\/api\/email\/inbox\/([^/]+)$/);
    if (method === 'GET' && readMatch) {
      return json(route, emailMessageDetailResponse(Number(decodeURIComponent(readMatch[1]))));
    }
    if (method === 'POST' && path === '/api/email/send') {
      return json(route, { messageId: '<sent-e2e@example.com>', sentAt: new Date(0).toISOString() });
    }
    if (method === 'POST' && path === '/api/email/drafts') {
      return json(route, { uid: 9001, draftId: 'draft-e2e' });
    }
    return json(route, {});
  });

  // ── Occasions/plans (occasions.*, docs/occasions.md, the dates panel). Own
  //    registration, same reason calendar/email/checkin have one: a genuinely
  //    separate REST domain. `occasions: 'not-available'` answers the honest 501
  //    every route gives on a daemon build that predates this SDK's occasions
  //    composition; the default ('available') answers the seeded, mutable fixtures
  //    below so answer/remove/interview/sweep actually change what a subsequent read
  //    reports. ────────────────────────────────────────────────────────────────
  const handleOccasionsRoute = async (route: Route) => {
    if (occasions === 'not-available') {
      return json(route, OCCASIONS_NOT_INVOKABLE_BODY, 501);
    }
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON?.() ?? {}) as Record<string, unknown>;

    if (method === 'GET' && path === '/api/occasions') {
      return json(route, occasionsListState);
    }
    if (method === 'GET' && path === '/api/occasions/pending') {
      return json(route, occasionsPendingState);
    }
    if (method === 'GET' && path === '/api/occasions/plans') {
      return json(route, occasionsPlansState);
    }
    if (method === 'GET' && path === '/api/occasions/state') {
      return json(route, occasionsStateState);
    }
    if (method === 'POST' && path === '/api/occasions/propose') {
      const needsKind = !body.kind;
      return json(route, {
        ok: true,
        reason: null,
        line: `${String(body.title ?? '')} · ${String(body.date ?? '')} · ${String(body.recurrence ?? 'annual')}${body.kind ? ` · ${String(body.kind)}` : ''}`,
        confirmation: `Noted ${String(body.title ?? 'this occasion')} as ${String(body.date ?? '')}, right?`,
        needsKind,
        conflictsWith: [],
      });
    }
    if (method === 'POST' && path === '/api/occasions/confirm') {
      occasionsIdCounter += 1;
      const occasionId = `occ-e2e-new-${String(occasionsIdCounter)}`;
      occasionsListState = {
        ...occasionsListState,
        occasions: [
          ...occasionsListState.occasions,
          {
            occasion: {
              id: occasionId,
              title: String(body.title ?? ''),
              date: { kind: 'recurring' as const, month: 1, day: 1 },
              recurrence: (body.recurrence as 'annual' | 'once') ?? 'annual',
              kind: (body.kind as 'gift-giving' | 'neither' | 'remember-only') ?? 'neither',
              person: String(body.person ?? ''),
              selfDeclared: false,
              subject: 'other' as const,
              leadDays: typeof body.leadDays === 'number' ? body.leadDays : null,
              mirrored: false,
              extras: [],
              lineIndex: occasionsListState.occasions.length,
              text: String(body.title ?? ''),
            },
            nextOccurrence: String(body.date ?? ''),
            daysUntil: 0,
            leadDays: 10,
            inLeadWindow: false,
            answer: null,
            mirrored: false,
          },
        ],
      };
      occasionsGiftsByOccasion = { ...occasionsGiftsByOccasion, [occasionId]: [] };
      return json(route, { ok: true, reason: null, occasionId, disclosure: 'Added to your profile.', droppedRecords: 0 });
    }
    if (method === 'POST' && path === '/api/occasions/remove') {
      const occasionId = String(body.occasionId ?? '');
      const existed = occasionsListState.occasions.some((entry) => entry.occasion.id === occasionId)
        || occasionsPlansState.plans.some((plan) => plan.id === occasionId);
      occasionsListState = { ...occasionsListState, occasions: occasionsListState.occasions.filter((entry) => entry.occasion.id !== occasionId) };
      occasionsPlansState = { ...occasionsPlansState, plans: occasionsPlansState.plans.filter((plan) => plan.id !== occasionId) };
      return json(route, {
        ok: existed,
        reason: existed ? null : `No occasion or plan found with id ${occasionId}`,
        occasionId,
        disclosure: existed ? 'Removed the line and every record against it.' : '',
        droppedRecords: existed ? 1 : 0,
      });
    }
    if (method === 'POST' && path === '/api/occasions/answer') {
      const occasionId = String(body.occasionId ?? '');
      const answer = body.answer as 'yes' | 'no' | 'later';
      occasionsListState = {
        ...occasionsListState,
        occasions: occasionsListState.occasions.map((entry) => (entry.occasion.id === occasionId ? { ...entry, answer } : entry)),
      };
      const existingInterview = occasionsPendingState.interviews.find((iv) => iv.occasionId === occasionId);
      return json(route, {
        ok: true,
        reason: null,
        interview: answer === 'yes' ? (existingInterview ?? null) : null,
      });
    }
    if (method === 'POST' && path === '/api/occasions/gifts') {
      const occasionId = String(body.occasionId ?? '');
      return json(route, { occasionId, gifts: occasionsGiftsByOccasion[occasionId] ?? [] });
    }
    if (method === 'POST' && path === '/api/occasions/sweep') {
      occasionsStateState = {
        ...occasionsStateState,
        lastSweep: {
          sweptAt: Date.now(),
          expiredAcknowledgements: 0,
          orphanedRecords: 0,
          expiredOpenItems: 0,
          agedGiftRecords: 0,
          droppedInterviews: 0,
          staleMirrors: 0,
        },
      };
      return json(route, {
        ranAt: Date.now(),
        today: occasionsListState.today,
        hold: null,
        nudge: null,
        conflictMessages: [],
        resumedInterviews: [],
        delivered: false,
        deliveryChannel: 'telegram',
        deliveryId: null,
        mirrored: 0,
        housekeeping: occasionsStateState.lastSweep,
      });
    }
    if (method === 'POST' && path === '/api/occasions/conflict/resolve') {
      return json(route, { occasionId: String(body.occasionId ?? ''), resolved: true });
    }
    if (method === 'POST' && path === '/api/occasions/interview') {
      const interviewId = String(body.interviewId ?? '');
      const found = occasionsPendingState.interviews.find((iv) => iv.interviewId === interviewId);
      return json(route, { present: Boolean(found), interview: found ?? null });
    }
    if (method === 'POST' && path === '/api/occasions/interview/answer') {
      // The seed interview has exactly one step, so answering it completes the
      // interview, real behavior for a "genuinely short" interview (docs/occasions.md
      // §4.10), never a second implementation of the daemon's own step sequencing.
      const interviewId = String(body.interviewId ?? '');
      let updated = occasionsPendingState.interviews.find((iv) => iv.interviewId === interviewId) ?? null;
      if (updated) {
        updated = { ...updated, nextStep: null, complete: true };
        occasionsPendingState = {
          ...occasionsPendingState,
          interviews: occasionsPendingState.interviews.map((iv) => (iv.interviewId === interviewId ? updated! : iv)),
        };
      }
      return json(route, { present: Boolean(updated), interview: updated });
    }
    if (method === 'POST' && path === '/api/occasions/interview/record') {
      const interviewId = String(body.interviewId ?? '');
      const landedOn = String(body.landedOn ?? '');
      let updated = occasionsPendingState.interviews.find((iv) => iv.interviewId === interviewId) ?? null;
      if (updated) {
        const occasionId = updated.occasionId;
        occasionsGiftsByOccasion = {
          ...occasionsGiftsByOccasion,
          [occasionId]: [
            ...(occasionsGiftsByOccasion[occasionId] ?? []),
            { occasionId, occurrence: updated.occurrence, recordedAt: Date.now(), landedOn },
          ],
        };
        updated = { ...updated, nextStep: null, complete: true, landedOn };
        occasionsPendingState = {
          ...occasionsPendingState,
          interviews: occasionsPendingState.interviews.map((iv) => (iv.interviewId === interviewId ? updated! : iv)),
        };
      }
      return json(route, { present: Boolean(updated), interview: updated });
    }
    if (method === 'POST' && path === '/api/occasions/plans/propose') {
      return json(route, {
        ok: true,
        reason: null,
        line: `${String(body.title ?? '')} · ${String(body.from ?? '')}..${String(body.to ?? '')}`,
        confirmation: `Noted ${String(body.title ?? 'this plan')}, ${String(body.from ?? '')} to ${String(body.to ?? '')}, right?`,
        needsKind: false,
        conflictsWith: [],
      });
    }
    if (method === 'POST' && path === '/api/occasions/plans/confirm') {
      occasionsIdCounter += 1;
      const planId = `plan-e2e-new-${String(occasionsIdCounter)}`;
      occasionsPlansState = {
        ...occasionsPlansState,
        plans: [
          ...occasionsPlansState.plans,
          {
            id: planId,
            title: String(body.title ?? ''),
            from: String(body.from ?? ''),
            to: String(body.to ?? ''),
            away: Boolean(body.away),
            destination: String(body.destination ?? ''),
            extras: [],
            lineIndex: occasionsPlansState.plans.length,
            text: String(body.title ?? ''),
          },
        ],
      };
      return json(route, { ok: true, reason: null, occasionId: planId, disclosure: 'Added to your profile.', droppedRecords: 0 });
    }
    return json(route, {});
  };
  // Two registrations: occasions.list's route is the bare '/api/occasions' with no
  // trailing segment at all (webui-facade's generated route, unlike every other
  // occasions.* row which has one), '**/api/occasions/**' alone does not match a URL
  // with nothing after "occasions", so the exact bare path needs its own registration
  // pointed at the SAME handler rather than a second implementation of it.
  await page.route('**/api/occasions/**', handleOccasionsRoute);
  await page.route('**/api/occasions', handleOccasionsRoute);

  // CI (ci.*, SDK 1.6.1's initiative family), plain REST paths (EXTRA_METHOD_ROUTES
  // in src/lib/goodvibes.ts), same own-registration reason as calendar/tasks above.
  await page.route('**/api/ci/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (method === 'POST' && path === '/api/ci/status') {
      const body = (request.postDataJSON?.() ?? {}) as { repo?: string; ref?: string; prNumber?: number };
      return json(route, { report: ciReportFor(body.repo ?? 'unknown/repo', body.ref, body.prNumber) });
    }
    if (method === 'GET' && path === '/api/ci/watches') {
      return json(route, { watches: ciWatchList });
    }
    if (method === 'POST' && path === '/api/ci/watches') {
      const body = (request.postDataJSON?.() ?? {}) as {
        repo?: string; ref?: string; prNumber?: number; deliveryChannel?: string; triggerFixSession?: boolean;
      };
      ciWatchIdCounter += 1;
      const watch = {
        id: `ciw_e2e_new_${ciWatchIdCounter}`,
        repo: body.repo ?? '',
        ...(body.ref ? { ref: body.ref } : {}),
        ...(body.prNumber ? { prNumber: body.prNumber } : {}),
        deliveryChannel: body.deliveryChannel ?? '',
        triggerFixSession: Boolean(body.triggerFixSession),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      ciWatchList = [...ciWatchList, watch];
      return json(route, { watch });
    }
    const watchRunMatch = path.match(/^\/api\/ci\/watches\/([^/]+)\/run$/);
    if (method === 'POST' && watchRunMatch) {
      const watchId = decodeURIComponent(watchRunMatch[1]);
      const watch = ciWatchList.find((w) => w.id === watchId);
      if (!watch) return json(route, { error: `CI watch not found: ${watchId}`, code: 'NOT_FOUND' }, 404);
      const report = ciReportFor(watch.repo, watch.ref, watch.prNumber);
      ciWatchList = ciWatchList.map((w) => (w.id === watchId ? { ...w, lastOverall: report.overall, updatedAt: Date.now() } : w));
      // A watch that auto-starts a fix session on failure returns the started
      // session's REAL id on the verb result, or the honest fixSessionError
      // when the spawn failed, never a dead id (SDK bb4b9c30). The spawned
      // session is servable by the mock's session store.
      const fixSessionTriggered = Boolean(watch.triggerFixSession) && report.overall === 'failed';
      let fixOutcome: { sessionId: string } | { error: string } | undefined;
      if (fixSessionTriggered) fixOutcome = spawnCiFixSession(watch.repo);
      return json(route, {
        report, notified: true, notificationId: 'ntf-1', fixSessionTriggered,
        ...(fixOutcome && 'sessionId' in fixOutcome ? { fixSessionId: fixOutcome.sessionId } : {}),
        ...(fixOutcome && 'error' in fixOutcome ? { fixSessionError: fixOutcome.error } : {}),
      });
    }
    const watchDeleteMatch = path.match(/^\/api\/ci\/watches\/([^/]+)$/);
    if (method === 'DELETE' && watchDeleteMatch) {
      const watchId = decodeURIComponent(watchDeleteMatch[1]);
      const existed = ciWatchList.some((w) => w.id === watchId);
      ciWatchList = ciWatchList.filter((w) => w.id !== watchId);
      return json(route, { watchId, deleted: existed });
    }
    return json(route, {});
  });

  // Check-in (checkin.*, SDK 1.6.1's initiative family): plain REST paths
  // (EXTRA_METHOD_ROUTES in src/lib/goodvibes.ts), same own-registration reason as
  // calendar/tasks/ci above.
  await page.route('**/api/checkin/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (method === 'GET' && path === '/api/checkin/config') {
      return json(route, { config: checkinConfigState });
    }
    if (method === 'POST' && path === '/api/checkin/config') {
      const body = (request.postDataJSON?.() ?? {}) as Partial<typeof checkinConfigState>;
      checkinConfigState = { ...checkinConfigState, ...body };
      return json(route, { config: checkinConfigState });
    }
    if (method === 'GET' && path === '/api/checkin/receipts') {
      return json(route, { receipts: checkinReceiptList });
    }
    if (method === 'POST' && path === '/api/checkin/run') {
      checkinReceiptIdCounter += 1;
      const outcome = checkinConfigState.enabled ? ('delivered' as const) : ('skipped' as const);
      if (checkinConfigState.enabled) {
        checkinReceiptList = [
          {
            id: `ckr_e2e_run_${checkinReceiptIdCounter}`, ranAt: Date.now(), trigger: 'manual' as const,
            outcome: 'delivered' as const, briefingSummary: 'Manual run: nothing urgent.',
            deliveredMessage: 'Manual check-in: all quiet.', deliveryChannel: checkinConfigState.deliveryChannel,
          },
          ...checkinReceiptList,
        ];
      }
      return json(route, {
        outcome,
        summary: checkinConfigState.enabled ? 'Manual run: nothing urgent.' : 'Check-in is disabled.',
        ...(checkinConfigState.enabled ? { deliveryId: `dlv_e2e_${checkinReceiptIdCounter}` } : {}),
      });
    }
    return json(route, {});
  });

  // Principals (principals.*, SDK 1.6.1's initiative family), plain REST paths
  // (EXTRA_METHOD_ROUTES in src/lib/goodvibes.ts), same own-registration reason as
  // checkin/ci/calendar/tasks above.
  await page.route('**/api/principals**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (method === 'GET' && path === '/api/principals') {
      return json(route, { principals: principalList });
    }
    if (method === 'POST' && path === '/api/principals') {
      const body = (request.postDataJSON?.() ?? {}) as { name?: string; kind?: string; identities?: { channel: string; value: string }[] };
      principalIdCounter += 1;
      const principal = {
        id: `prin_e2e_new_${principalIdCounter}`, name: body.name ?? '', kind: (body.kind ?? 'user') as typeof principalList[number]['kind'],
        identities: body.identities ?? [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      principalList = [...principalList, principal];
      return json(route, { principal });
    }
    if (method === 'POST' && path === '/api/principals/resolve') {
      const body = (request.postDataJSON?.() ?? {}) as { channel?: string; value?: string };
      const match = principalList.find((p) => p.identities.some((i) => i.channel === body.channel && i.value === body.value));
      return json(route, match ? { principal: match, known: true } : { principal: UNKNOWN_PRINCIPAL, known: false });
    }
    const updateMatch = path.match(/^\/api\/principals\/([^/]+)\/update$/);
    if (method === 'POST' && updateMatch) {
      const principalId = decodeURIComponent(updateMatch[1]);
      const body = (request.postDataJSON?.() ?? {}) as { name?: string; kind?: string; identities?: { channel: string; value: string }[] };
      const existing = principalList.find((p) => p.id === principalId);
      if (!existing) return json(route, { error: `Principal not found: ${principalId}`, code: 'NOT_FOUND' }, 404);
      const updated = {
        ...existing,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind as typeof existing.kind } : {}),
        ...(body.identities !== undefined ? { identities: body.identities } : {}),
        updatedAt: Date.now(),
      };
      principalList = principalList.map((p) => (p.id === principalId ? updated : p));
      return json(route, { principal: updated });
    }
    const deleteMatch = path.match(/^\/api\/principals\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      const principalId = decodeURIComponent(deleteMatch[1]);
      const existed = principalList.some((p) => p.id === principalId);
      principalList = principalList.filter((p) => p.id !== principalId);
      return json(route, { principalId, deleted: existed });
    }
    const getMatch = path.match(/^\/api\/principals\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      const principalId = decodeURIComponent(getMatch[1]);
      const found = principalList.find((p) => p.id === principalId);
      if (!found) return json(route, { error: `Principal not found: ${principalId}`, code: 'NOT_FOUND' }, 404);
      return json(route, { principal: found });
    }
    return json(route, {});
  });

  // Channel profiles (channels.profiles.*, SDK 1.6.1's initiative family), plain REST
  // paths (EXTRA_METHOD_ROUTES in src/lib/goodvibes.ts), same own-registration reason.
  await page.route('**/api/channels/profiles**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (method === 'GET' && path === '/api/channels/profiles') {
      return json(route, { bindings: channelProfileList });
    }
    if (method === 'POST' && path === '/api/channels/profiles') {
      const body = (request.postDataJSON?.() ?? {}) as {
        surfaceKind?: string; channelId?: string; model?: string; provider?: string; permissionMode?: string;
      };
      const existing = channelProfileList.find((b) => b.surfaceKind === body.surfaceKind && b.channelId === body.channelId);
      if (existing) {
        const updated = { ...existing, ...body, updatedAt: Date.now() } as typeof existing;
        channelProfileList = channelProfileList.map((b) => (b === existing ? updated : b));
        return json(route, { binding: updated });
      }
      channelProfileIdCounter += 1;
      const binding = {
        id: `cp_e2e_new_${channelProfileIdCounter}`, surfaceKind: body.surfaceKind ?? '',
        ...(body.channelId ? { channelId: body.channelId } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.permissionMode ? { permissionMode: body.permissionMode as 'plan' | 'normal' | 'accept-edits' | 'auto' } : {}),
        updatedAt: Date.now(),
      };
      channelProfileList = [...channelProfileList, binding];
      return json(route, { binding });
    }
    const surfaceMatch = path.match(/^\/api\/channels\/profiles\/([^/]+)$/);
    if (surfaceMatch) {
      const surfaceKind = decodeURIComponent(surfaceMatch[1]);
      const channelId = method === 'GET'
        ? new URL(request.url()).searchParams.get('channelId') ?? undefined
        : (request.postDataJSON?.() as { channelId?: string } | undefined)?.channelId;
      const found = channelProfileList.find((b) => b.surfaceKind === surfaceKind && b.channelId === channelId);
      if (method === 'GET') {
        if (!found) return json(route, { error: `Channel profile not found: ${surfaceKind}`, code: 'NOT_FOUND' }, 404);
        return json(route, { binding: found });
      }
      if (method === 'DELETE') {
        const existed = Boolean(found);
        channelProfileList = channelProfileList.filter((b) => !(b.surfaceKind === surfaceKind && b.channelId === channelId));
        return json(route, { surfaceKind, channelId, deleted: existed });
      }
    }
    return json(route, {});
  });

  // ── Tasks (tasks.*, MOBILE-ADAPT), plain REST paths (EXTRA_METHOD_ROUTES in
  //    src/lib/goodvibes.ts), not the `/api/control-plane/methods/{id}/invoke`
  //    tunnel, so they need their own registration like calendar/knowledge above.
  //    tasks.create posts to the legacy `/task` path with no `/api` segment.
  await page.route('**/task', async (route) => {
    if (route.request().method() !== 'POST') return json(route, {});
    const body = (route.request().postDataJSON?.() ?? {}) as { task?: string };
    const created = {
      id: `task_e2e_${taskList.length + 1}`,
      kind: 'shell',
      title: body.task ?? '',
      status: 'queued',
      owner: 'operator',
      cancellable: true,
      queuedAt: Date.now(),
    };
    taskList = [...taskList, created];
    return json(route, { task: created });
  });

  await page.route('**/api/tasks/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      taskList = taskList.map((t) => (t.id === id ? { ...t, status: 'cancelled', cancellable: false } : t));
      return json(route, { taskId: id, status: 'cancelled' });
    }
    const retryMatch = path.match(/^\/api\/tasks\/([^/]+)\/retry$/);
    if (method === 'POST' && retryMatch) {
      const id = decodeURIComponent(retryMatch[1]);
      taskList = taskList.map((t) => (t.id === id ? { ...t, status: 'queued', error: undefined } : t));
      return json(route, { taskId: id, status: 'queued' });
    }
    return json(route, {});
  });

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'GET') return json(route, {});
    const totals = {
      created: taskList.length,
      completed: taskList.filter((t) => t.status === 'completed').length,
      failed: taskList.filter((t) => t.status === 'failed').length,
      cancelled: taskList.filter((t) => t.status === 'cancelled').length,
    };
    return json(route, {
      queued: taskList.filter((t) => t.status === 'queued').length,
      running: taskList.filter((t) => t.status === 'running').length,
      blocked: taskList.filter((t) => t.status === 'blocked').length,
      totals,
      tasks: taskList,
    });
  });

  return daemon;
}
