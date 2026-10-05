import {
  createBrowserKnowledgeSdk,
  forSession,
  KNOWLEDGE_BROWSER_ROUTES,
} from '@goodvibes-jev/engine/sdk/browser/knowledge';
import type { BrowserKnowledgeMethodId } from '@goodvibes-jev/engine/sdk/browser/knowledge';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { tokenStore, WEBUI_TOKEN_STORE_KEY } from './client-lifetime';
export { tokenStore, WEBUI_TOKEN_STORE_KEY } from './client-lifetime';
import { isRuntimeEventDomain } from '@goodvibes-jev/engine/contracts';
import { routedFetch } from './relay-connection';
import { readClientCompatibilityFloor, recordObservedClientCompatibilityFloor } from './client-compatibility';
// The union profile.forget accepts as a target (a field id OR a raw line index), named in
// lib/owner-profile.ts beside the readers for the same verbs' output. The generated
// OperatorMethodInput<'profile.forget'> has both properties optional, so this narrower
// type is what stops a caller passing neither. Type-only import: no runtime dependency.
import type { ProfileForgetInput } from './owner-profile';
import type {
  OperatorMethodId,
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
  RuntimeEventDomain,
} from '@goodvibes-jev/engine/contracts';
import type {
  ContractsListInput,
  ContractsListResult,
  ContractRecord,
  CheckpointsCreateInput,
  CheckpointsCreateResult,
  CheckpointsDiffInput,
  CheckpointsDiffResult,
  CheckpointsListInput,
  CheckpointsListResult,
  CheckpointsRestoreInput,
  CheckpointsRestoreResult,
  CheckpointsRestorePreviewInput,
  CheckpointsRestorePreviewResult,
  CheckpointsRevertHunkPreviewInput,
  CheckpointsRevertHunkPreviewResult,
  CheckpointsRevertHunkInput,
  CheckpointsRevertHunkResult,
  CostAttributionGetInput,
  CostAttributionGetResult,
  CostAttributionRow,
  FleetArchivedListResult,
  FleetArchiveFinishedResult,
  FleetArchiveResult,
  FleetAttemptsListInput,
  FleetAttemptsListResult,
  FleetAttemptGroup,
  FleetAttemptCandidate,
  FleetAttemptJudgment,
  FleetAttemptsPickResult,
  FleetAttemptsJudgeResult,
  FleetObservedSteerResult,
  FleetListInput,
  FleetListResult,
  FleetProcessNode,
  FleetSnapshotResult,
  FleetUnarchiveResult,
  RewindPlanInput,
  RewindPlanResult,
  RewindApplyInput,
  RewindApplyResult,
  SessionParticipant,
  SessionsChangesGetInput,
  SessionsChangesGetResult,
  SessionsDetachInput,
  SessionsDetachResult,
  SessionsSearchInput,
  SessionsSearchResult,
  WorkspaceCheckpoint,
  SessionsHostedListInput,
  SessionsHostedListResult,
  HostedSessionRecord,
  SessionsHostedCreateInput,
  SessionsHostedCreateResult,
  SessionsHostedAttachInput,
  SessionsHostedAttachResult,
  HostedSessionHistoryMessage,
  SessionsHostedDetachInput,
  SessionsHostedDetachResult,
  SessionsHostedKillInput,
  SessionsHostedKillResult,
} from './contract-bridge-types';

// Re-exported so existing consumers (lib/fleet.ts, lib/checkpoints.ts, FleetView.tsx,
// WorkstreamView.tsx, CheckpointsView.tsx, ...) keep importing these names from
// './goodvibes' unchanged, the byte-compatible facade covers types, not just the `sdk`
// object. Definitions live in contract-bridge-types.ts (the pin-bump swap seam).
export type {
  ContractsListInput,
  ContractsListResult,
  ContractRecord,
  CheckpointsCreateInput,
  CheckpointsCreateResult,
  CheckpointsDiffInput,
  CheckpointsDiffResult,
  CheckpointsListInput,
  CheckpointsListResult,
  CheckpointsRestoreInput,
  CheckpointsRestoreResult,
  CheckpointsRestorePreviewInput,
  CheckpointsRestorePreviewResult,
  CheckpointsRevertHunkPreviewInput,
  CheckpointsRevertHunkPreviewResult,
  CheckpointsRevertHunkInput,
  CheckpointsRevertHunkResult,
  CostAttributionGetInput,
  CostAttributionGetResult,
  CostAttributionRow,
  FleetArchivedListResult,
  FleetArchiveFinishedResult,
  FleetArchiveResult,
  FleetAttemptsListInput,
  FleetAttemptsListResult,
  FleetAttemptGroup,
  FleetAttemptCandidate,
  FleetAttemptJudgment,
  FleetAttemptsPickResult,
  FleetAttemptsJudgeResult,
  FleetObservedSteerResult,
  FleetListInput,
  FleetListResult,
  FleetProcessNode,
  FleetSnapshotResult,
  FleetUnarchiveResult,
  RewindPlanInput,
  RewindPlanResult,
  RewindApplyInput,
  RewindApplyResult,
  SessionParticipant,
  SessionsChangesGetInput,
  SessionsChangesGetResult,
  SessionsDetachInput,
  SessionsDetachResult,
  SessionsSearchInput,
  SessionsSearchResult,
  WorkspaceCheckpoint,
  SessionsHostedListInput,
  SessionsHostedListResult,
  HostedSessionRecord,
  SessionsHostedCreateInput,
  SessionsHostedCreateResult,
  SessionsHostedAttachInput,
  SessionsHostedAttachResult,
  HostedSessionHistoryMessage,
  SessionsHostedDetachInput,
  SessionsHostedDetachResult,
  SessionsHostedKillInput,
  SessionsHostedKillResult,
};

/**
 * One undelivered daemon receipt, served by control.status only when called
 * with { receipts: 'consume' }. The daemon pre-renders the human line (a crash
 * restart, a self-update, a migration) in `text`; the webui renders it verbatim
 * as a one-line dismissible notice, no client-side kind logic. `at` is the
 * epoch-ms the event happened; `id` is the stable dedupe key.
 */
export interface DaemonReceipt {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

export const WEBUI_SURFACE_KIND = 'webui';
export const WEBUI_SURFACE_ID = 'goodvibes-webui';
// The daemon-served world is one origin: the web UI's own bundle and the API it calls
// are served by the same control-plane listener, whose default port is 3421. A browser
// context always has `window.location.origin`; the 3421 fallback below is reached only
// outside one (tests, SSR-style module evaluation).
export const GOODVIBES_BASE_URL = import.meta.env.VITE_GOODVIBES_BASE_URL
  ?? (typeof window === 'undefined' ? 'http://127.0.0.1:3421' : window.location.origin);

/** This build's own version (vite.config.ts's `define`, from package.json), for
 * comparison against a daemon-announced client-build floor, see client-compatibility.ts.
 * Undefined outside a Vite-built bundle (bun test, a bare module eval). */
export const WEBUI_VERSION: string | undefined = import.meta.env.VITE_WEBUI_VERSION;


type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type JsonRecord = Record<string, unknown>;

interface RouteDefinition {
  method: HttpMethod;
  path: string;
}

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: JsonRecord;
  authenticated?: boolean;
  signal?: AbortSignal;
}

/**
 * The webui's transport layer is GENERATED, not hand-maintained. The mechanical facts,
 * which operator methods carry a plain-REST http binding, at what path, and which are
 * reachable only through the generic gateway-method invoke endpoint, come from the
 * contract-emitted facade artifact (@goodvibes-jev/engine/contracts/generated/webui-facade):
 * WEBUI_METHOD_ROUTES (every REST-routed method id → route). The ergonomic layer below
 * (the sdk.operator.* call shapes, typed I/O, error normalization, auth handling, and the
 * routedFetch relay integration) stays hand-written on top, that split is the design.
 *
 * EXTRA_METHOD_ROUTES is DERIVED (buildExtraMethodRoutes): WEBUI_METHOD_ROUTES minus every
 * id the pinned browser SDK route maps already cover (those resolve natively through
 * scopedSdk.operator.invoke, the no-route fall-through in invokeOperator below). No route
 * path or http method is written by hand here, the drift test in goodvibes.test.ts pins
 * this table against the generated artifact so a hand-written row can never shadow or
 * diverge from a generated one. (Until the 2.0.0 re-pin this table also carried three
 * hand-written models.* rows, models.list/models.current/models.select were absent from
 * the operator contract entirely. The 2.0.0 contract now carries real models.list /
 * models.current.get / models.current.set entries with real REST bindings, so those rows
 * are gone and models.* flows through WEBUI_METHOD_ROUTES like everything else below.)
 *
 * The retirement invariant the previous hand-table documented still holds structurally:
 * sessions.get / steer / followUp / messages.* / inputs.* are covered by the browser SDK
 * (SHARED_BROWSER_ROUTES) and so are subtracted out, they resolve natively, never through
 * a generated REST row (see goodvibes.test.ts's EXTRA_METHOD_ROUTES retirement suite).
 */

// The browser SDK owns these routes natively (its SHARED_BROWSER_ROUTES ∪
// KNOWLEDGE_BROWSER_ROUTES maps, the set scopedSdk is built from). invokeOperator must let
// them fall through to scopedSdk.operator.invoke rather than shadow them with a generated
// REST row (the fall-through carries the scoped transport: relay, auth, observer, SSE).
// KNOWLEDGE_BROWSER_ROUTES is a public runtime export; SHARED_BROWSER_ROUTES is not, so its
// ids are listed here and pinned to the SDK's own BrowserKnowledgeMethodId type by
// SHARED_COVERAGE_IS_COMPLETE below, a pin bump that adds a browser-covered method this
// list has not accounted for stops the build until the list is updated.
const SHARED_BROWSER_METHOD_IDS = [
  'accounts.snapshot',
  'control.auth.current',
  'control.auth.login',
  'control.snapshot',
  'control.status',
  'providers.get',
  'providers.list',
  'providers.usage.get',
  'sessions.create',
  'sessions.followUp',
  'sessions.get',
  'sessions.inputs.cancel',
  'sessions.inputs.list',
  'sessions.list',
  'sessions.messages.create',
  'sessions.messages.list',
  'sessions.steer',
] as const;

type BrowserCoveredMethodId =
  | (typeof SHARED_BROWSER_METHOD_IDS)[number]
  | Extract<keyof typeof KNOWLEDGE_BROWSER_ROUTES, string>;
// Compile-time half of the drift protection: fails to compile if BrowserKnowledgeMethodId
// (the SDK's own SHARED ∪ KNOWLEDGE union) gains a member this module does not subtract,
// otherwise a generated REST row could silently shadow a natively-covered method.
const SHARED_COVERAGE_IS_COMPLETE: [BrowserKnowledgeMethodId] extends [BrowserCoveredMethodId] ? true : never = true;
void SHARED_COVERAGE_IS_COMPLETE;

function buildExtraMethodRoutes(): Record<string, RouteDefinition | undefined> {
  const browserCovered = new Set<string>([
    ...SHARED_BROWSER_METHOD_IDS,
    ...Object.keys(KNOWLEDGE_BROWSER_ROUTES),
  ]);
  const table: Record<string, RouteDefinition> = {};
  for (const [methodId, def] of Object.entries(WEBUI_METHOD_ROUTES)) {
    if (browserCovered.has(methodId)) continue;
    table[methodId] = { method: def.method, path: def.path };
  }
  return table;
}

const EXTRA_METHOD_ROUTES: Record<string, RouteDefinition | undefined> = buildExtraMethodRoutes();

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function buildUrl(path: string, query?: JsonRecord): string {
  const url = new URL(path, `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      }
    } else if (typeof value === 'object') {
      url.searchParams.set(key, JSON.stringify(value));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- value is not an object (handled above), array (handled above), null/undefined/'' (skipped above)
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await tokenStore.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const method = options.method ?? 'GET';
  const headers: HeadersInit = {
    ...(options.authenticated === false ? {} : await authHeaders()),
    ...(method === 'GET' || options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  const url = buildUrl(path, options.query);
  options.signal?.throwIfAborted();
  // routedFetch (not the bare global fetch) so REST-routed methods traverse the relay when
  // the active route is relay, otherwise a mutating call (permission respond, session
  // control) would hit an unreachable direct URL over relay and never reach the daemon's
  // step-up gate. On the direct/LAN route routedFetch IS the plain global fetch (no change).
  const response = await routedFetch(url, {
    method,
    credentials: 'include',
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(method === 'GET' || options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  // Every response, success or failure, is a chance to learn the daemon's current
  // client-build floor (see client-compatibility.ts), recorded here rather than only
  // on one dedicated probe, since this is the one HTTP helper nearly every operator
  // call passes through.
  recordObservedClientCompatibilityFloor(readClientCompatibilityFloor(response.headers));
  const body = await readJson(response);
  options.signal?.throwIfAborted();
  if (!response.ok) {
    throw Object.assign(new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`.trim()), {
      status: response.status,
      url,
      method,
      body,
      category: response.status === 401 ? 'authentication' : 'service',
    });
  }
  return body as T;
}

/**
 * requestStream, a POST whose SUCCESS body is raw bytes, not JSON (voice.tts.stream
 * returns streamed audio). Returns the live Response so the caller can read
 * arrayBuffer()/body without this helper eagerly draining it. On a non-2xx it drains and
 * throws the SAME error shape requestJson does (status/category), so the TTS request
 * policy's transient-429 detection (src/lib/voice/request-policy.ts keys off `status`)
 * works identically on both paths.
 */
async function requestStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: HeadersInit = { ...(await authHeaders()), 'Content-Type': 'application/json' };
  const url = buildUrl(path);
  // routedFetch so this streamed POST also traverses the relay when routed (see requestJson).
  const response = await routedFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  recordObservedClientCompatibilityFloor(readClientCompatibilityFloor(response.headers));
  if (!response.ok) {
    const errBody = await readJson(response).catch(() => null);
    throw Object.assign(new Error(`POST ${path} failed: ${response.status} ${response.statusText}`.trim()), {
      status: response.status,
      url,
      method: 'POST' as HttpMethod,
      body: errBody,
      category: response.status === 401 ? 'authentication' : 'service',
    });
  }
  return response;
}

/**
 * hostedSessionDetachBeacon, best-effort detach for a page teardown (pagehide /
 * visibilitychange-to-hidden, see HostedSessionsView.tsx), for when there is no time
 * left to await the ordinary async sdk.operator.sessions.hosted.detach round trip. Reads
 * the auth token synchronously straight out of localStorage (the browser token store IS
 * localStorage under an async wrapper, createBrowserTokenStore) and fires one `fetch`
 * with `keepalive: true`, so the browser completes the request after the page itself has
 * gone away, the standard beacon pattern, since `navigator.sendBeacon` cannot carry a
 * bearer-token Authorization header.
 *
 * SAME-ORIGIN ONLY: this always targets GOODVIBES_BASE_URL directly, never routedFetch's
 * relay path, a relay round trip involves its own encryption/signing handshake that
 * cannot complete synchronously at teardown either, so a relay-routed session gets no
 * keepalive detach here. That is an accepted, honestly-reported limitation (see this
 * function's callers), not a silent gap: the ordinary async detach still covers every
 * case where the page stays alive long enough for it to settle.
 *
 * Never throws and never rejects visibly, by the time this fires there is often no view
 * left to report a failure to.
 */
export function hostedSessionDetachBeacon(sessionId: string, clientId: string): void {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
  let token: string | null = null;
  try {
    token = window.localStorage.getItem(WEBUI_TOKEN_STORE_KEY);
  } catch {
    // localStorage unavailable (private mode, permissions), proceed unauthenticated.
  }
  try {
    void fetch(buildUrl('/api/control-plane/methods/sessions.hosted.detach/invoke'), {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ body: { sessionId, clientId } }),
    }).catch(() => undefined);
  } catch {
    // A synchronous throw (fetch unavailable, a keepalive body-size limit, ...),
    // nothing more can be done at teardown.
  }
}

function interpolateRoute(route: RouteDefinition, input: unknown): { path: string; rest: JsonRecord } {
  const record = asRecord(input);
  const consumed = new Set<string>();
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = record[key];
    if (value === undefined || value === null || value === '') throw new Error(`Missing route parameter: ${key}`);
    consumed.add(key);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- value is a non-null, non-undefined, non-empty string URL param; the throw guard above rejects undefined/null/'' but does not exclude objects, so String() may yield "[object Object]" for non-primitive route values
    return encodeURIComponent(String(value));
  });
  const rest = Object.fromEntries(Object.entries(record).filter(([key, value]) => !consumed.has(key) && value !== undefined));
  return { path, rest };
}

/**
 * True when a method resolves via a hand-written EXTRA_METHOD_ROUTES row rather than
 * natively through scopedSdk.operator.invoke. Exported so the retirement contract is
 * test-enforced: sessions.get/steer/followUp must be native (false); sessions.close /
 * reopen must still be table-routed (true).
 */
export function isExtraRoutedMethod(methodId: string): boolean {
  return Boolean(EXTRA_METHOD_ROUTES[methodId]);
}

/**
 * The resolved REST route for a table-routed method id, or undefined when the method falls
 * through to the browser SDK / generic invoke path. Exported for the drift test that pins
 * this derived table against the generated WEBUI_METHOD_ROUTES artifact, proving no
 * hand-written row shadows or diverges from a generated one.
 */
export function webuiRouteFor(methodId: string): RouteDefinition | undefined {
  return EXTRA_METHOD_ROUTES[methodId];
}

/**
 * invokeOperator, the single dispatcher for every operator method id, contract-typed.
 *
 * Overload 1 covers every id in the installed `OperatorMethodId` union (every row in
 * EXTRA_METHOD_ROUTES except models.*, see overload 2, plus every sessions.* id that
 * falls through to scopedSdk.operator.invoke below). The `input` parameter is typed
 * `OperatorMethodInput<TMethodId>` DIRECTLY, which is the whole point: an earlier
 * signature took a free `TInput` type parameter defaulting to that same type, and a
 * default is not a constraint, TypeScript infers it from the argument whenever one is
 * passed, so the generated shape was discarded and any object compiled. Two breaking
 * contract changes reached this app through that gap without producing one type error.
 * `TOutput` keeps its default because an output override never weakens a request.
 *
 * A caller whose body genuinely cannot be checked against the generated input uses
 * `invokeOperatorUncheckedInput` instead, named, documented, and enumerable, rather than
 * every call site in this file opting out in silence.
 *
 * Overload 2 is the untyped fallback `invokeOperatorUncheckedInput` casts through for the
 * ids listed in its own header comment (calendar.*, email.*, memory.*, stepup.credentials.
 * register, approvals.approve). Historically models.list/current/select ALSO went through
 * this fallback, they were not in the OperatorMethodId union at all (operator-method-
 * ids.ts had no "models.*" entries). The 2.0.0 re-pin adds real models.list /
 * models.current.get / models.current.set entries, so models.* now calls overload 1 like
 * fleet.* and checkpoints.* do, this is no longer a standing gap. Flag it again if a
 * future contracts generation ever drops coverage for these ids.
 */
async function invokeOperator<
  TMethodId extends OperatorMethodId,
  TOutput = OperatorMethodOutput<TMethodId>,
>(methodId: TMethodId, input?: OperatorMethodInput<TMethodId>): Promise<TOutput>;
async function invokeOperator(methodId: string, input?: unknown): Promise<unknown>;
async function invokeOperator(methodId: string, input?: unknown): Promise<unknown> {
  const route = EXTRA_METHOD_ROUTES[methodId];
  if (!route) {
    // The one unavoidable escape hatch: every methodId that reaches this branch (no
    // EXTRA_METHOD_ROUTES row) is, by construction, a member of BrowserKnowledgeMethodId
    // (SHARED_BROWSER_ROUTES ∪ KNOWLEDGE_BROWSER_ROUTES), a runtime invariant the type
    // system cannot see through a string-keyed table lookup. isExtraRoutedMethod's test
    // coverage below is what actually enforces it, not this cast.
    return scopedSdk.operator.invoke(
      methodId as BrowserKnowledgeMethodId,
      input as OperatorMethodInput<BrowserKnowledgeMethodId>,
    );
  }
  const { path, rest } = interpolateRoute(route, input);
  if (route.method === 'GET') return requestJson(path, { method: route.method, query: rest });
  if (route.method === 'DELETE' && !Object.keys(rest).length) return requestJson(path, { method: route.method });
  return requestJson(path, { method: route.method, body: rest });
}

// ---------------------------------------------------------------------------
// Compile-time conformance for the profile write bodies.
//
// `profile.forget` is the one profile verb whose body is a local type rather than the
// generated input (the generated one makes fieldId, section and text all optional, so it
// cannot express "a target is required"). These two guards close the gap that let two
// breaking changes land silently:
//
//   * OnlyDeclaredKeys catches a property we send that the contract does not declare,
//     which is exactly how the retired `lineIndex` would have surfaced, and how a future
//     retirement will. Assignability alone does NOT catch this: excess properties are
//     only rejected on fresh object literals, and these bodies are built as variables.
//   * The assignment below catches the other direction, a required property we omit,
//     which is how the newly-required `authority` would have surfaced.
//
// AllKeys distributes over the union so each member's keys are checked, not just the
// keys the members share (plain `keyof` on a union yields only the common ones).
//
// DO NOT REPLACE THIS WITH "just type the parameter". Measured against a closed union
// parameter type, tsc rejects a stale property in only two of the four ways a body gets
// built:
//
//   fresh literal, stale field written inline ......... rejected (excess-property check)
//   spread + stale field written inline ............... rejected (same check still applies)
//   built as a variable ............................... SLIPS THROUGH
//   stale field carried in by the spread .............. SLIPS THROUGH
//
// The last two rows are the ones that matter here, because `profile.forget`'s body IS a
// spread-built literal: `{ ...forgetTargetInput(target), authority }`. If a retired
// property returns to the spread SOURCE's type, no amount of parameter typing at the call
// site sees it, and rewriting the call into branched fresh literals does not help either,
// since the spread still carries it.
//
// This guard covers both of them, measured rather than assumed. Seeding the retired
// `lineIndex` back onto ProfileForgetTarget fails HERE, at this assertion, and does so
// identically whether the body is spread-built or assigned to a variable first: the guard
// reads the DECLARED type and never looks at a call site, so how the body is constructed
// cannot affect it.
//
// What it deliberately does not cover: a key invented at one call site and never declared
// anywhere. That is not contract drift, it is a typo, and the runtime conformance test in
// hooks/useOwnerProfile.test.tsx catches it by checking each sent body against the
// contract's own inputSchema, verified, four failures. So the division is:
// this guard catches the TYPE going stale, that test catches a body going rogue.
// ---------------------------------------------------------------------------
type AllKeys<T> = T extends unknown ? keyof T : never;

type OnlyDeclaredKeys<TMethodId extends OperatorMethodId, TBody> =
  [Exclude<AllKeys<TBody>, keyof OperatorMethodInput<TMethodId>>] extends [never] ? true : never;

const PROFILE_FORGET_SENDS_ONLY_DECLARED_KEYS: OnlyDeclaredKeys<'profile.forget', ProfileForgetInput> = true;
void PROFILE_FORGET_SENDS_ONLY_DECLARED_KEYS;

const PROFILE_FORGET_BODY_IS_ACCEPTED: OperatorMethodInput<'profile.forget'> = {} as ProfileForgetInput;
void PROFILE_FORGET_BODY_IS_ACCEPTED;

/**
 * invokeOperatorUncheckedInput, the ONE deliberate way to send a body the generated
 * input type cannot check, and the visible inventory of which ids need it.
 *
 * Every other call goes through `invokeOperator`, whose `input` parameter is typed
 * `OperatorMethodInput<TMethodId>` directly. That matters: an earlier signature took a
 * free `TInput` type parameter DEFAULTING to the generated input, and a default is not a
 * constraint, TypeScript infers it from the argument whenever one is passed, so the
 * generated shape was discarded and any object compiled. Two breaking contract changes
 * reached this app through that gap (a required `authority`, and `profile.forget` moving
 * from `lineIndex` to `section`+`text`), neither of which produced a single type error.
 *
 * Two distinct reasons an id lands here, and they are worth telling apart:
 *
 *  1. THE GENERATED INPUT IS A CATCH-ALL. calendar.*, email.* and memory.* generate as
 *     `{ readonly [key: string]: unknown }`, which declares nothing and which a local
 *     interface cannot satisfy anyway (TypeScript gives interfaces no implicit index
 *     signature). The hand-authored input types at these call sites are strictly MORE
 *     precise than the contract, so nothing is lost by not checking against it, but the
 *     list below is then an honest inventory of where the contract says nothing useful.
 *  2. THE GENERATED INPUT IS WRONG. stepup.credentials.register and approvals.approve
 *     both carry real, tested divergences the generated map does not reflect (see their
 *     own section comments). These are the ones to re-check on every pin bump: when the
 *     contract catches up, the call moves back to `invokeOperator` and the divergence
 *     comment goes with it.
 *
 * The single `as` here is the price of the escape, paid once in one named place instead
 * of silently at every call site in the file.
 */
async function invokeOperatorUncheckedInput<TOutput>(
  methodId: OperatorMethodId,
  input: unknown,
): Promise<TOutput> {
  return await invokeOperator(methodId as string, input) as TOutput;
}

/**
 * invokeGatewayMethod, typed direct call to the generic invoke-by-id endpoint
 * (POST /api/control-plane/methods/{methodId}/invoke), mirroring the SDK's
 * own `invokeVerb` test helper (test/w3-s2-fleet-checkpoints-search.test.ts).
 *
 * WHY THIS EXISTS: fleet.*, checkpoints.*, and sessions.search are
 * registered with `transport: ['ws']` and NO `http` route binding
 * (method-catalog-fleet.ts / session-search.ts), they are reachable ONLY through this
 * generic invoke mechanism, not through scopedSdk.operator.invoke (which resolves
 * against the fixed SHARED_BROWSER_ROUTES/KNOWLEDGE_BROWSER_ROUTES tables baked into the
 * browser SDK build and has no entries for these verbs) and not through
 * EXTRA_METHOD_ROUTES (built for REST-shaped path-param routes, which these verbs don't
 * have).
 *
 * TYPED BY THE CONTRACT ID: `methodId: TMethodId extends OperatorMethodId`, these ids
 * ARE in the installed union (operator-method-ids.ts lists fleet.*, checkpoints.*,
 * sessions.search, sessions.detach). `body` is constrained to
 * `OperatorMethodInput<TMethodId>`.
 *
 * WHAT THAT CONSTRAINT MEANS CHANGED AT THE 1.19.1 RE-PIN, and this comment used to
 * say the opposite. It read: "`OperatorMethodInput<TMethodId>` today resolves to the
 * generic `{ [k: string]: unknown }` fallback for this family (no
 * `OperatorMethodInputMap` entry yet), every bridge input type is a plain object with
 * an optional-properties shape, which IS assignable to that index signature, so no cast
 * is needed at any call site." That fallback is gone. `OperatorMethodInput` is now a
 * plain indexed access, `OperatorMethodInputMap[TMethodId]`, every catalogued verb has
 * a rendered entry, and those entries carry their real `required` arrays.
 *
 * Measured against the installed 1.19.1 rather than estimated: this function is called
 * with 41 distinct method ids, and 25 of them now enforce at least one field that was
 * previously unenforced (checkpoints.create's `kind`, rewind.apply/plan's `sessionId`
 * and `scope`, push.subscriptions.reconcile's `deviceId`/`endpoint`/`keys`, and so on).
 * No call site needed a fix and no bridge type needed widening, because the bridge
 * types in contract-bridge-types.ts are already aliases OF `OperatorMethodInput<...>`
 * rather than hand-written optional-field copies, so the newly-required fields arrived
 * through them automatically, and every wrapper below already supplies them (mostly by
 * taking them as mandatory function parameters). That is a property worth stating
 * because it is not obvious from the diff: the re-pin was silent here on purpose, not
 * by luck, and the way to keep it silent is to keep those bridges as aliases.
 *
 * TOutput still has no useful default for the ids whose OutputMap entry is `unknown`,
 * so most call sites below supply the real result shape explicitly.
 */
async function invokeGatewayMethod<TMethodId extends OperatorMethodId, TOutput = OperatorMethodOutput<TMethodId>>(
  methodId: TMethodId,
  body?: OperatorMethodInput<TMethodId>,
): Promise<TOutput> {
  return requestJson<TOutput>(`/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    body: { body: body ?? {} },
  });
}

/** Read-only, cancellable contract requests use the generated REST binding. */
async function readContractMethod<M extends 'contracts.list' | 'contracts.get'>(
  methodId: M,
  input: OperatorMethodInput<M>,
  signal?: AbortSignal,
): Promise<OperatorMethodOutput<M>> {
  const route = webuiRouteFor(methodId);
  if (route?.method !== 'GET') throw new Error('Contract inspection is unavailable.');
  const { path, rest } = interpolateRoute(route, input);
  return requestJson(path, { method: route.method, query: rest, signal });
}

// ─── Approvals (approvals.*, per-hunk selection) ─────────────────────
//
// UNLIKE fleet.*/checkpoints.* (contract-bridge-types.ts), approvals.* HAS real,
// generated OperatorMethodInputMap/OutputMap coverage today (foundation-client-
// types.ts), every interface below was cross-checked field-by-field against
// OperatorMethodOutputMap['approvals.list'/'approvals.approve'] and is a safe
// SUPERSET or an intentional, permanent (not pin-bump-pending) divergence from it:
//   - `status`/`request.category`/etc. are kept as open `string`s here rather than
//     the contract's closed literal unions, the same defensive-parsing stance
//     lib/fleet.ts documents for kind/state ("a daemon newer than this client may
//     introduce a value we have never seen. Render it verbatim, never drop it").
//   - `ApprovalRecord.audit` stays OPTIONAL here (the contract requires it), this
//     client never runtime-validates the wire response (see `invokeOperator`), so
//     a mixed-version/pre-audit record may genuinely omit it; approvals.test.ts
//     pins a fixture that omits `audit` on purpose.
//   - `ApprovalDecision.modifiedArgs` and `ApprovalApproveInput.selectedHunks` are
//     real per-hunk-apply wire fields the generated 0.38 maps do not cover.
// Because of these deliberate divergences, invokeOperator's approvals.* calls
// below pass explicit TOutput/TInput overrides rather than the contract defaults.

/**
 * One edit hunk of an `edit`-tool approval's `request.args.edits` array.
 * Mirrors the SDK's EditHunkLike (approval-hunk-apply.ts), path/find/replace
 * plus an optional stable id. Read defensively (see lib/approvals.ts): a
 * request whose args are not edit-shaped simply has no hunks to render.
 */
export interface ApprovalEditHunk {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly id?: string;
}

export interface ApprovalAnalysis {
  readonly classification: string;
  readonly riskLevel: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly target?: string;
  readonly targetKind?: string;
  readonly surface?: string;
  readonly blastRadius?: string;
  readonly sideEffects?: readonly string[];
  readonly host?: string;
}

/**
 * Attribution for a permission ask that did not originate from the foreground
 * turn loop, the SDK's `PermissionAttribution` discriminated union (platform/
 * permissions/prompt.ts). Populated when a background/subagent tool call, an
 * MCP server's elicitation request, or a sandboxed exec's host-access
 * escalation brokers an ask, so a surface can render "who/what is asking"
 * instead of an anonymous prompt. Absent on foreground asks (the common case).
 *
 * Not in the generated OperatorMethodOutputMap['approvals.list'/'approve']
 * shape (the operator contract's PERMISSION_PROMPT_REQUEST_SCHEMA is a stale,
 * closed `additionalProperties: false` doc that predates this field), but the
 * daemon's `/api/approvals*` routes serialize the ApprovalBroker's
 * SharedApprovalRecord directly (`Response.json({ approval })` /
 * `Response.json({ approvals })`, no schema-driven stripping), so a real
 * `request.attribution` genuinely reaches this client when the daemon
 * populates one. Same known-divergence pattern as `ApprovalDecision.
 * modifiedArgs` above.
 */
export type ApprovalAttribution =
  | BackgroundAgentAttribution
  | McpServerAttribution
  | SandboxEscalationAttribution
  | ExecPromptAttribution;

/** A background/subagent tool call brokered an ask on behalf of a spawned agent. */
export interface BackgroundAgentAttribution {
  readonly kind: 'background-agent';
  readonly agentId: string;
  readonly template?: string;
}

/** An MCP server's `elicitation/create` request, routed through the approval broker. */
export interface McpServerAttribution {
  readonly kind: 'mcp-server';
  readonly serverName: string;
}

/** A sandboxed exec's ask for host access it would not otherwise have (e.g. network). */
export interface SandboxEscalationAttribution {
  readonly kind: 'sandbox-escalation';
  readonly sandbox: string;
  readonly escalations: readonly string[];
}

/**
 * A RUNNING command blocked on its own terminal (host-key confirm, credential
 * ask, an interactive installer). The SDK's exec PTY prompt-answer path
 * (exec-prompt-wiring.ts) turns the detected prompt into an ordinary broker
 * ask with tool 'exec:prompt' and this attribution; an approval whose
 * decision carries `modifiedArgs.answer` (a string) feeds that text to the
 * waiting child, a deny (or an answer-less approve) stops the run honestly
 * with the prompt text on the result.
 */
export interface ExecPromptAttribution {
  readonly kind: 'exec-prompt';
  readonly command: string;
  readonly prompt: string;
}

/**
 * One remember-tier choice offered on an ask, buildRememberOptions
 * (approval-rules.ts) generates label/detail from the concrete tool+args, so
 * a surface renders them verbatim rather than re-deriving policy language.
 * Tiers: 'session' (in-memory) | 'exact' | 'command-class' | 'path' | 'tool'
 * (the four durable ones persist as permissions.rules.* records).
 */
export interface ApprovalRememberOption {
  readonly tier: string;
  readonly label: string;
  readonly detail: string;
}

export interface ApprovalRequest {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly category: string;
  readonly analysis: ApprovalAnalysis;
  readonly workingDirectory?: string;
  readonly attribution?: ApprovalAttribution;
  /** Remember-tier choices for this ask (PERMISSION_PROMPT_REQUEST_SCHEMA's
   * rememberOptions). Absent on records from a daemon predating the tiers. */
  readonly rememberOptions?: readonly ApprovalRememberOption[];
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly remember?: boolean;
  /** How far the decision reached ('session'|'exact'|'command-class'|'path'|'tool').
   * Stamped on the resolved record by the broker. The UI reports remembering
   * from the response's `recorded` block (below), which the daemon now returns
   * authoritatively, this decision snapshot is the back-compat fallback. */
  readonly rememberTier?: string;
  /** Free-text feedback; on a deny it rides the structured user-declined result. */
  readonly reason?: string;
  readonly modifiedArgs?: Record<string, unknown>;
}

/**
 * The `recorded` block a resolve response now carries: the daemon's own report
 * of what its broker actually did with the decision fields the route forwarded.
 * This is the authoritative signal the UI trusts, not what the client sent,
 * and not an inference off the returned record. Optional only for back-compat
 * with a daemon predating the block (then the UI falls back to the decision
 * snapshot). Mirrors approvals.approve/deny's contract output `recorded`:
 *   - `rememberTier`, the tier the broker recorded, or null if none.
 *   - `reasonStored`, a deny/approve reason was persisted with the decision.
 *   - `modifiedArgsDelivered`, modifiedArgs (e.g. an exec-prompt answer) reached the run.
 */
export interface ApprovalRecordedOutcome {
  readonly approved: boolean;
  readonly rememberTier: string | null;
  readonly reasonStored: boolean;
  readonly modifiedArgsDelivered: boolean;
}

export type ApprovalStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired';

/**
 * One entry in an approval's decision trail, the SDK's SharedApprovalAuditRecord
 * (packages/sdk/src/platform/control-plane/approval-broker.ts). Appended on every
 * lifecycle transition (created/claimed/approved/denied/cancelled/expired/updated),
 * so a resolved approval's `audit` array is the honest provenance of who did what,
 * from where, and when, not just the final `decision`/`resolvedBy` snapshot.
 */
export interface ApprovalAuditRecord {
  readonly id: string;
  readonly action: 'created' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'updated';
  readonly actor: string;
  readonly actorSurface?: string;
  readonly createdAt: number;
  readonly note?: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly callId: string;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly status: ApprovalStatus;
  readonly request: ApprovalRequest;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly claimedBy?: string;
  readonly claimedAt?: number;
  readonly resolvedAt?: number;
  readonly resolvedBy?: string;
  readonly decision?: ApprovalDecision;
  /**
   * The session an ACCEPTED ask spawned: a CI "fix this?" offer that was
   * approved gets the started fix-session's REAL, attachable session id (never
   * an internal scheduling handle, SDK bb4b9c30) stamped onto the resolved
   * APPROVED record by the broker and published live through the broker-update
   * path, so the accepting surface can open the session. Mutually exclusive
   * with fixSessionError; never present on denied records; absent until the
   * spawn completes.
   */
  readonly fixSessionId?: string;
  /**
   * The honest failure when the accepted ask's spawn did NOT produce an
   * attachable session (SDK bb4b9c30): stamped on the approved record instead
   * of a dead id. Mutually exclusive with fixSessionId.
   */
  readonly fixSessionError?: string;
  readonly metadata: Record<string, unknown>;
  /**
   * The full decision trail. Optional in this client-side type (rather than
   * mirroring the SDK's required field) because this client reads the wire
   * response as-is with no runtime schema validation (see `invokeOperator`
   * below), a mixed-version or pre-audit daemon record may genuinely omit
   * it. Treat absence as "no trail recorded", never as an error.
   */
  readonly audit?: readonly ApprovalAuditRecord[];
}

export interface ApprovalSnapshotResult {
  readonly awaitingDecision: boolean;
  readonly mode: string;
  readonly approvalCount: number;
  readonly denialCount: number;
  readonly cachedChecks: number;
  readonly totalChecks: number;
  readonly approvals: readonly ApprovalRecord[];
}

export interface ApprovalActionResult {
  readonly approval: ApprovalRecord;
  /** The daemon's authoritative report of what it recorded (see
   * ApprovalRecordedOutcome). Absent only from a daemon predating the block. */
  readonly recorded?: ApprovalRecordedOutcome;
}

/**
 * Optional per-hunk selection for `approvals.approve`. Omitting
 * `selectedHunks` approves the whole request (back-compat); when present the
 * DAEMON filters the approval's own edit list to those indices server-side
 * (approval-hunk-apply.ts) so every surface (TUI, webui) produces identical
 * modified-edit args, the webui only ever sends indices, never a computed diff.
 */
export interface ApprovalApproveInput {
  readonly selectedHunks?: readonly number[];
  readonly note?: string;
  readonly remember?: boolean;
  /** Requested remember tier. The HTTP approval route now forwards it into the
   * same broker resolution the in-process path uses, and reports what it did in
   * the response's `recorded` block, the UI reads remembering from there. */
  readonly rememberTier?: string;
  /** Exec-prompt answer path: `{ answer: string }` feeds the waiting command.
   * The route forwards it and reports delivery via `recorded.modifiedArgsDelivered`. */
  readonly modifiedArgs?: Record<string, unknown>;
}

/** Optional deny payload: `note` rides the audit trail; `reason` is the
 * broker's structured user-declined feedback field. The route now forwards
 * both and reports persistence via `recorded.reasonStored`. */
export interface ApprovalDenyInput {
  readonly note?: string;
  readonly reason?: string;
}

/** One durable approval rule (permissions.rules.list), a remembered decision
 * at a generalizing tier, project-scoped, write-only from decisions (never
 * minted over the wire). Deleting a grant makes matching asks prompt again. */
export interface PermissionRuleRecord {
  readonly id: string;
  readonly effect: 'allow' | 'deny';
  readonly tier: string;
  readonly tool: string;
  readonly description?: string;
  readonly createdAt: number;
}

// ─── Tasks (tasks.*) ─────────────────────────────────────────────────────────
//
// tasks.create/cancel/retry have no known divergence from the generated contract
// (ApprovalsTasksView.test.tsx exercises them without relying on any field the
// contract omits), so their input/output alias OperatorMethodInput/Output directly.
// tasks.list's item shape needs one addition the generated map does not carry,
// `cancellable` (ApprovalsTasksView.tsx reads it to gate the Cancel button; the
// contract's tasks.list item omits it even though tasks.cancel/get's richer task
// shape does not carry it either), so RuntimeTaskSummary/TaskSnapshotResult stay
// local, with the divergence named here rather than silently re-added.

export interface RuntimeTaskSummary {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly owner: string;
  /** Not in OperatorMethodOutputMap['tasks.list']'s item shape, a known, tested
   * client-side addition (ApprovalsTasksView.test.tsx: "cancel is offered only for
   * a cancellable task"). */
  readonly cancellable?: boolean;
  readonly parentTaskId?: string;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
}

export interface TaskSnapshotResult {
  readonly queued: number;
  readonly running: number;
  readonly blocked: number;
  readonly totals: {
    readonly created: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
  };
  readonly tasks: readonly RuntimeTaskSummary[];
}

export type TaskActionResult = OperatorMethodOutput<'tasks.cancel'>;
export type TaskCreateInput = OperatorMethodInput<'tasks.create'>;
export type TaskCreateResult = OperatorMethodOutput<'tasks.create'>;

// ─── Watchers (watchers.stop only, WEBUI-FLEET-DEPTH) ────────────────────────
// CORRECTED AT THE 1.19.1 RE-PIN: this comment used to say watchers.stop "has no
// OperatorMethodInputMap/OutputMap entry in the installed contracts package". It has
// one now, every catalogued verb does, and the entry confirms what was hand-authored
// here: id/kind/label/state, all four required, `kind` and `state` as open strings.
//
// Kept as a hand-written SUBSET rather than aliased to OperatorMethodOutput<'watchers.stop'>
// because the contract's shape carries much more (source, metadata, intervalMs,
// heartbeat and lag fields) and FleetView reads exactly these four. Typing only what a
// caller uses is this file's existing stance, and unlike the email/calendar shapes
// below there is no field here whose absence hid information from a view. If FleetView
// ever needs the rest, alias the contract type instead of extending this by hand.
export interface WatcherActionResult {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly state: string;
}

/**
 * Calendar (calendar.*, SDK 1.1.0).
 *
 * CORRECTED AT THE 1.19.1 RE-PIN. This comment used to claim these ids have "NO
 * OperatorMethodInputMap/OutputMap entry in the installed contracts package (verified:
 * grepping the generated foundation-client-types.d.ts for 'calendar' returns nothing)"
 * and concluded the hand-authored shapes were "a permanent divergence (no generated map
 * to converge with)". Both halves are now false: the installed map carries
 * calendar.events.create/get/list and calendar.ics.export/import.
 *
 * The result shapes below are now derived from the contract. The INPUT shapes for the
 * two writes are not, and deliberately: the contract types their `confirm` field as
 * `boolean`, while this client types it as literal `true` so a caller cannot satisfy
 * the type with `confirm: false` and meet the daemon's refusal at runtime instead. That
 * is a narrowing of the contract, which is safe, rather than a divergence from it.
 */
export type CalendarEventsListResult = OperatorMethodOutput<'calendar.events.list'>;
export type CalendarEventSummary = CalendarEventsListResult['events'][number];
export type CalendarEventsListInput = OperatorMethodInput<'calendar.events.list'>;

export interface CalendarEventDetail extends CalendarEventSummary {
  readonly uid: string;
  readonly recurrence?: string;
}

/**
 * `confirm` is required AND literal-true, which is deliberately stricter than the
 * contract. OperatorMethodInput<'calendar.events.create'> types it `confirm: boolean`,
 * so aliasing this type to the contract would let a caller pass `confirm: false` and
 * meet the type while the daemon refuses the write. Same stance as EmailSendInput
 * below. Every other field here is field-for-field the contract's own; only the
 * narrowing is ours.
 */
export interface CalendarEventCreateInput {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
  readonly location?: string;
  readonly calendarId?: string;
  readonly confirm: true;
}

export type CalendarEventCreateResult = OperatorMethodOutput<'calendar.events.create'>;

export interface CalendarIcsImportInput {
  readonly icsContent: string;
  readonly calendarId?: string;
  readonly confirm: true;
}

export type CalendarIcsImportResult = OperatorMethodOutput<'calendar.ics.import'>;

export interface CalendarIcsExportInput {
  readonly calendarId?: string;
  readonly from?: string;
  readonly to?: string;
}

export type CalendarIcsExportResult = OperatorMethodOutput<'calendar.ics.export'>;

/**
 * Email (email.*), the daemon's IMAP/SMTP verbs.
 *
 * NO LONGER HAND-AUTHORED, as of the 1.19.1 re-pin. These shapes used to be transcribed
 * field-by-field from the SDK's catalog because, as the comment here put it, the ids
 * "have no OperatorMethodInputMap/OutputMap entry, so OperatorMethodInput/Output<'email.*'>
 * would degrade to the generic fallback". They have entries now, so the types below are
 * derived from the contract and the transcription cannot drift from it.
 *
 * The transcription HAD already drifted, in a way that reached the UI: the hand-written
 * inbox-list result declared `messages` and `total` and stopped there, while the
 * contract also carries `unreadable`, the messages the account returned that the daemon
 * could not parse, each with its own reason. MailView could not render what it could not
 * see, so a window in which every message failed to parse displayed as a normal empty
 * inbox. MailView renders that list now (see UnreadableNote there).
 *
 * CAPABILITY REALITY (the reason every view over these renders a not-available state
 * as a first-class outcome rather than an error): all four ship `invokable: false`,
 * and the SDK catalog's own comment states there is no /api/email surface on the
 * daemon router at any prefix yet. Cataloged, not served. Identical to how calendar.*
 * shipped, and the honest states are what makes that shippable rather than a dead end.
 */
export type EmailInboxListInput = OperatorMethodInput<'email.inbox.list'>;
export type EmailInboxListResult = OperatorMethodOutput<'email.inbox.list'>;
export type EmailInboxMessage = EmailInboxListResult['messages'][number];
/**
 * Messages the daemon could not read, each with the reason. Optional on the
 * wire, and the hand-written EmailInboxListResult this replaced omitted it
 * entirely, so the Mail view had no way to tell an operator that part of the
 * inbox failed to load. MailView renders it now.
 */
export type EmailUnreadableMessage = NonNullable<EmailInboxListResult['unreadable']>[number];
export type EmailMessageDetail = OperatorMethodOutput<'email.inbox.read'>;
export type EmailAttachment = NonNullable<EmailMessageDetail['attachments']>[number];

/**
 * `confirm` is required and literal-true: the SDK marks email.send `dangerous: true`
 * with the description "Irreversible external send; requires confirm: true and
 * explicit user review of recipients and body." Typing it as the literal rather than
 * `boolean` means a caller cannot forget it or pass false and discover the refusal at
 * runtime, and the view pairs it with a real confirmation sheet, so the flag is
 * never set on the operator's behalf without them having seen the recipients.
 */
export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly confirm: true;
}

export interface EmailSendResult {
  readonly messageId: string;
  readonly sentAt: string;
}

/** Drafts append to the IMAP Drafts folder, distinct from the local channel draft
 * store, and notably NOT gated on a `confirm` flag (nothing leaves the account). */
export interface EmailDraftCreateInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}

export interface EmailDraftCreateResult {
  readonly uid: number;
  readonly draftId: string;
}

/**
 * SessionDeleteResult, the honest hard-delete outcome shape shared by
 * `operator.sessions.delete` and `chat.sessions.delete`: `deleted: true` means the
 * record and its messages/inputs were actually removed, not merely closed. Neither
 * `sessions.delete` (union) nor a truly-deleting `companion.chat.sessions.delete` has a
 * generated OperatorMethodOutputMap entry in the installed 0.38 contracts yet, so this
 * is a hand-authored local shape, not a contract re-export.
 */
export interface SessionDeleteResult {
  readonly sessionId: string;
  readonly deleted: boolean;
}

/**
 * The honest-lineage result of `chat.messages.retry` (regenerate). The prior assistant
 * response, and any turns after it, are SUPERSEDED, retained in the message list and on
 * disk, flagged with `supersededAt`/`supersededReason`, never deleted, and a fresh turn
 * re-runs from the preceding user message. `supersededMessageIds` is the retained-history
 * set the UI surfaces as viewable prior versions; `turnStarted` says whether a new turn
 * is now streaming back. Hand-authored: companion.chat.messages.retry has no generated
 * OperatorMethodOutputMap entry in the installed contracts (its id IS in the union, but
 * the I/O map is not), cross-checked against the SDK's method-catalog-control-companion.
 */
export interface CompanionRegenerateResult {
  readonly sessionId: string;
  readonly regeneratedFrom: string;
  readonly supersededMessageIds: readonly string[];
  readonly turnStarted: boolean;
}

/**
 * The honest-lineage result of `chat.messages.edit` (edit-and-branch). The edited user
 * message, and everything after it, are SUPERSEDED (retained history), and a NEW user
 * message carrying `revisionOf` back to the original is appended before a fresh turn
 * answers it. `editedFrom` is the original id (now retained history); `messageId` is the
 * new active user message. Same generated-map gap as CompanionRegenerateResult.
 */
export interface CompanionEditResult {
  readonly sessionId: string;
  readonly editedFrom: string;
  readonly messageId: string;
  readonly supersededMessageIds: readonly string[];
  readonly turnStarted: boolean;
}

/** Input for `chat.messages.edit`, the user message to edit plus its replacement text. */
export interface CompanionEditInput {
  readonly content: string;
  readonly attachments?: readonly { artifactId: string; label?: string }[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * Explicit capped-exponential reconnect policy for every SSE consumer. Without it the
 * SDK falls back to its own defaults and a dropped stream can appear "live"; with it a
 * dropped stream reconnects with backoff and, once attempts are exhausted, degrades to
 * the honest "SSE error/off" strip state and the 15s health-probe fallback.
 */
export const DEFAULT_SSE_RECONNECT = {
  enabled: true,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  maxAttempts: 10,
} as const;

// ─── Memory (memory.records.*, memory.review-queue) ───────────────────────────
//
// The canonical, daemon-owned cross-surface memory store's wire shapes, hand-authored
// because none of these six ids has a generated OperatorMethodInputMap/OutputMap entry
// yet (see the EXTRA_METHOD_ROUTES comment above). Every field name and requiredness
// below is cross-checked against the daemon's own schema definitions
// (operator-contract-schemas-runtime.js: MEMORY_RECORD_SCHEMA,
// MEMORY_RECORD_SEARCH_OUTPUT_SCHEMA, MEMORY_RECORD_DELETE_OUTPUT_SCHEMA), not guessed.

export type MemoryScope = 'session' | 'project' | 'team';
export type MemoryClass =
  | 'decision' | 'constraint' | 'incident' | 'pattern' | 'fact' | 'risk' | 'runbook' | 'architecture' | 'ownership';
export type MemoryReviewState = 'fresh' | 'reviewed' | 'stale' | 'contradicted';
export type MemoryProvenanceKind = 'session' | 'turn' | 'task' | 'event' | 'file';

/** VIBE.md persona/preference lines are constraint records tagged with this, see the
 * SDK's vibe-projection.ts (VIBE_PERSONA_TAG). There is no `memory.fold`/projection verb
 * on the wire ("fold is NOT on the wire", the brief this view was built from), so this
 * client replicates the same cls+tag test locally rather than deep-importing an
 * internal, non-exported SDK module path. See memory-helpers.ts's isPersonaRecord. */
export const VIBE_PERSONA_TAG = 'vibe';

export interface MemoryProvenanceLink {
  readonly kind: MemoryProvenanceKind;
  readonly ref: string;
  readonly label?: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly cls: MemoryClass;
  readonly summary: string;
  readonly detail?: string;
  readonly tags: readonly string[];
  readonly provenance: readonly MemoryProvenanceLink[];
  readonly reviewState: MemoryReviewState;
  readonly confidence: number;
  readonly reviewedAt?: number;
  readonly reviewedBy?: string;
  readonly staleReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryRecordEntityResult {
  readonly record: MemoryRecord;
}

/**
 * The honest search envelope (memory-recall-contract.ts's HonestMemorySearchResult,
 * promoted onto the wire verbatim by memory.records.search). `mode` is the path that
 * ACTUALLY ran ('literal' even when semantic was requested but the index could not be
 * consulted); `indexUnavailableReason` is non-null only in that fallback case and MUST
 * be shown verbatim, never swallowed into a silent empty result. `caveat` is the
 * softer "ran on the hashed-only fallback provider" note. `recallFiltered` /
 * `excludedFlaggedCount` / `excludedBelowFloorCount` / `totalBeforeRecallFilter` are the
 * honesty receipt for the recall-injection contract (only populated when the caller
 * opted into `recall: true`). `recallFloor` is the store's configured recall confidence
 * floor (MIN_PROMPT_MEMORY_CONFIDENCE) this result was judged against, carried on the
 * wire so a surface can state the floor in a label without hardcoding a number that
 * could silently go stale if the store's floor is retuned.
 */
export interface MemorySearchResult {
  readonly records: readonly MemoryRecord[];
  readonly mode: 'literal' | 'semantic';
  readonly requestedSemantic: boolean;
  readonly indexUnavailableReason: string | null;
  readonly caveat: string | null;
  readonly recallFiltered: boolean;
  readonly excludedFlaggedCount: number;
  readonly excludedBelowFloorCount: number;
  readonly totalBeforeRecallFilter: number;
  readonly recallFloor: number;
}

/** Delete-means-delete: an honest boolean, never a 200 that pretends a phantom row was
 * removed (MEMORY_RECORD_DELETE_OUTPUT_SCHEMA, `deleted: false` when nothing existed). */
export interface MemoryRecordDeleteResult {
  readonly id: string;
  readonly deleted: boolean;
}

export interface MemoryReviewQueueResult {
  readonly records: readonly MemoryRecord[];
}

// ─── Memory consolidation receipts (memory.consolidation.receipts, SDK 1.8.0's
// consolidation-reaches-the-review-queue work) ──────────────────────────────────
//
// What each idle/scheduled consolidation pass scanned, merged, archived, decayed,
// and, the judgment calls it never makes unilaterally, PROPOSED. A proposal names
// the record ids it concerns; those records are already marked into the review
// queue (reviewState set to 'fresh' or 'contradicted' by the pass itself, see
// packages/sdk/src/platform/state/memory-consolidation.ts), so "route to review"
// here means finding those same ids in the existing review queue, not a separate
// resolution path. `route` is an internal agent-tool invocation string
// (`memory action:"curator" ...`), not a browser route, never rendered as a link.
// A runtime without the consolidation scheduler answers an honest 501
// (isMethodUnavailableError), which the panel renders as an honest unavailable state.
export interface MemoryConsolidationProposal {
  readonly kind: 'contradiction' | 'cross-scope-duplicate' | 'stale-delete';
  readonly ids: readonly string[];
  readonly route: string;
  readonly reason: string;
}
export interface MemoryConsolidationRunReceipt {
  readonly runId: string;
  readonly ranAt: string;
  readonly trigger: string;
  readonly idle: boolean;
  readonly scanned: number;
  readonly merged: readonly { readonly survivorId?: string; readonly duplicateIds?: readonly string[] }[];
  readonly archived: readonly { readonly id?: string; readonly reason?: string }[];
  readonly decayed: readonly { readonly id?: string; readonly fromConfidence?: number; readonly toConfidence?: number }[];
  readonly proposed: readonly MemoryConsolidationProposal[];
  readonly usageSignalAvailable: boolean;
  readonly note: string;
}
export interface MemoryConsolidationReceiptsResult {
  readonly receipts: readonly MemoryConsolidationRunReceipt[];
  readonly pendingProposals: readonly MemoryConsolidationProposal[];
}

export interface MemorySearchInput {
  readonly scope?: MemoryScope;
  readonly cls?: MemoryClass;
  readonly tags?: readonly string[];
  readonly query?: string;
  readonly semantic?: boolean;
  readonly since?: number;
  readonly reviewState?: readonly MemoryReviewState[];
  readonly minConfidence?: number;
  readonly provenanceKinds?: readonly MemoryProvenanceKind[];
  readonly staleOnly?: boolean;
  readonly limit?: number;
  /** Apply the recall-injection contract server-side (exclude flagged records outright,
   * drop sub-floor records, count every exclusion). Off by default, a browse/review
   * caller wants to SEE flagged and low-confidence records too. */
  readonly recall?: boolean;
}

export interface MemoryAddReviewInput {
  readonly state?: MemoryReviewState;
  readonly confidence?: number;
  readonly reviewedBy?: string;
  readonly staleReason?: string;
}

export interface MemoryAddInput {
  readonly cls: MemoryClass;
  readonly summary: string;
  readonly scope?: MemoryScope;
  readonly detail?: string;
  readonly tags?: readonly string[];
  readonly provenance?: readonly MemoryProvenanceLink[];
  readonly review?: MemoryAddReviewInput;
}

export interface MemoryUpdateReviewInput {
  readonly state?: MemoryReviewState;
  readonly confidence?: number;
  readonly reviewedBy?: string;
  readonly staleReason?: string;
}

export interface MemoryReviewQueueInput {
  readonly limit?: number;
  readonly scope?: MemoryScope;
}

// ─── Web Push (push.*, SDK 1.1.0) ────────────────────────────────────
//
// The push.* verbs are registered ws-only with NO REST http binding (SDK
// method-catalog-push.ts), exactly like fleet.*/checkpoints.*/sessions.search,
// so they are reachable ONLY through the generic invoke-by-id endpoint
// (invokeGatewayMethod), never through scopedSdk.operator.invoke or an
// EXTRA_METHOD_ROUTES row. push.* IS in the installed 1.1.0 OperatorMethodId
// union (OPERATOR_METHOD_IDS), so the method-id strings below typecheck; the
// generated I/O maps are the generic `unknown` fallback for this family (no
// OperatorMethodInputMap entry yet), so every call supplies its explicit
// TOutput shape, cross-checked field-by-field against the SDK's own
// method-catalog-push.ts outputSchema/inputSchema.
//
// CUSTODY: the daemon never returns a subscription's capability URL (endpoint)
// or its key material over the wire, the read shape is the redacted
// PublicPushSubscription (origin + short hash only). The VAPID private key
// never leaves the daemon at all. These local types mirror that redaction; the
// browser holds the full endpoint/keys only transiently, from its own
// PushManager, to hand to push.subscriptions.create.

/** The endpoint's browser-supplied key material (base64url), sent to subscribe. */
export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

/** The redacted, wire-safe view of a stored subscription (no capability URL, no keys). */
export interface PublicPushSubscription {
  readonly id: string;
  readonly principalId: string;
  /** The device identity this record is reconciled on, when known (SDK 1.8.0). */
  readonly deviceId?: string;
  readonly endpointOrigin: string;
  /**
   * Short, stable hash of the full endpoint (SDK 1.8.0). A client compares this
   * against its own live endpoint's hash to detect that the daemon holds a stale
   * one (drift), see reconcilePushSubscriptionOnOpen in push-client.ts.
   */
  readonly endpointHash: string;
  readonly createdAt: number;
  readonly lastDeliveryAt?: number;
  readonly lastOutcome?: string;
  readonly consecutiveFailures?: number;
}

/** An honest per-subscription delivery receipt from a verify/test push. */
export interface PushDeliveryReceipt {
  readonly subscriptionId: string;
  readonly endpointOrigin: string;
  readonly outcome: 'delivered' | 'pruned' | 'failed' | 'skipped';
  readonly httpStatus?: number;
  readonly detail?: string;
}

export interface PushVapidKeyResult {
  readonly publicKey: string;
}
// Plainly an interface again. It was a `type` alias, with an eslint-disable, because
// invokeGatewayMethod's input constraint used to be the permissive
// `{ readonly [k: string]: unknown }` fallback: an object-literal type alias carries an
// implicit index signature and satisfies that, an interface does not. The 1.19.1 re-pin
// removed the fallback, the parameter is now the contract's own concrete shape for
// this id, which an interface satisfies, so both the alias and the suppression were
// scaffolding for a constraint that no longer exists. Verified by compiling it as an
// interface before changing it, not assumed from reading the type.
export interface PushSubscriptionCreateInput {
  /** Stable per-install device identity (SDK 1.8.0); absent falls back to the legacy endpoint-keyed record. */
  readonly deviceId?: string;
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
}
export interface PushSubscriptionCreateResult {
  readonly subscription: PublicPushSubscription;
}
export interface PushSubscriptionListResult {
  readonly subscriptions: readonly PublicPushSubscription[];
}
export interface PushSubscriptionDeleteResult {
  readonly subscriptionId: string;
  readonly deleted: boolean;
}
export interface PushVerifyResult {
  readonly receipt: PushDeliveryReceipt;
}

// push.subscriptions.reconcile (SDK 1.8.0): the reconcile-on-open self-heal verb.
// Unlike subscribe/create (register-or-refresh), reconcile REQUIRES deviceId, it
// is the verb a client calls when it already knows its own device identity and
// wants the daemon's record healed to match its current live endpoint/keys,
// reporting what (if anything) had drifted.
// An interface for the same reason PushSubscriptionCreateInput is one again; see there.
export interface PushSubscriptionReconcileInput {
  readonly deviceId: string;
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
}
/** Whether reconcile changed the daemon's record for this device, and how. */
export type PushReconcileDrift = 'created' | 'endpoint-updated' | 'keys-updated' | 'unchanged';
export interface PushSubscriptionReconcileResult {
  readonly subscription: PublicPushSubscription;
  readonly drift: PushReconcileDrift;
}

// ─── Pairing (pairing.tokens.*, pairing.handoff.*, SDK 1.8.0) ─────────
//
// See the sdk.operator.pairing facade block below for the custody/transport
// notes; these are the wire shapes it types against.

/** The redacted, wire-safe view of a pairing token, never the secret itself. */
export interface PublicPairingToken {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number;
}
export interface PairingTokensListResult {
  readonly tokens: readonly PublicPairingToken[];
  /** Whether the legacy single shared token has been revoked (a one-way action). */
  readonly legacySharedRevoked: boolean;
}
/** A freshly minted token. CUSTODY: `token` is the literal secret, shown exactly once. */
export interface MintedPairingToken {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly createdAt: number;
}
export interface PairingTokensCreateResult {
  readonly token: MintedPairingToken;
}
export interface PairingTokensRenameResult {
  readonly id: string;
  readonly renamed: boolean;
}
export interface PairingTokensDeleteResult {
  readonly id: string;
  readonly revoked: boolean;
}
export interface PairingTokensRevokeSharedResult {
  readonly legacySharedRevoked: boolean;
}

// ─── Origin posture (pairing.posture.get, SDK 1.8.0's LAN-http posture work) ──
//
// The honest TLS/capability posture of a web origin: plain http on a private-network
// origin (LAN IP, .local, localhost) is a supported posture, reported with ONE honest
// notice line (LAN_PLAIN_HTTP_NOTICE_TEXT below, stated once at pairing, never a nag);
// each browser-gated capability (service worker/PWA install, push, microphone) is
// labeled available or with the daemon's OWN "needs https, available via tailscale"
// wording, never a client-fabricated guess. Mirrors
// packages/sdk/src/platform/pairing/origin-posture.ts's ORIGIN_POSTURE_SCHEMA exactly.
export type BrowserGatedCapability = 'service-worker' | 'push' | 'microphone';
export interface OriginCapability {
  readonly capability: string;
  readonly available: boolean;
  /** Present when unavailable: the label a surface renders instead of a dead button. */
  readonly reason?: string;
}
export interface OriginPosture {
  readonly origin: string;
  readonly scheme: string;
  readonly privateNetwork: boolean;
  readonly secureContext: boolean;
  /** Present only for the plain-http-on-LAN posture; absent when already a secure context. */
  readonly notice?: string;
  readonly capabilities: readonly OriginCapability[];
}
export interface PairingPostureGetInput {
  /** This surface's own current origin. Omit to read the daemon's configured web origin. */
  readonly origin?: string;
}
export interface PairingPostureGetResult {
  readonly posture: OriginPosture;
}

/** The set-up steps a pairing hand-off can offer. Each is independently declinable. */
export type PairingHandoffOfferKind = 'notifications' | 'relay' | 'passkey';
export interface PairingHandoffOffer {
  readonly kind: string;
  readonly available: boolean;
  /** Present only for the 'notifications' offer when it is available. */
  readonly vapidPublicKey?: string;
}
export interface PairingHandoffCreateResult {
  readonly token: MintedPairingToken;
  readonly offers: readonly PairingHandoffOffer[];
  /** The `#pair=<token>&offers=<kinds>` fragment content, see lib/pairing.ts. */
  readonly fragment: string;
  /** The fragment prefixed with a known web origin, when the daemon knows one. */
  readonly deepLink?: string;
  /** The origin's honest TLS/capability posture, present when the daemon knows a web origin. */
  readonly posture?: OriginPosture;
}
export interface PairingHandoffCompleteNotificationsAccept {
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
  readonly deviceId?: string;
}
export interface PairingHandoffCompletePasskeyAccept {
  readonly rpId: string;
  readonly origin: string;
  readonly credentialId: string;
  readonly publicKeyCose: string;
}
export interface PairingHandoffCompleteInput {
  readonly accept?: {
    readonly notifications?: PairingHandoffCompleteNotificationsAccept;
    readonly relay?: boolean;
    readonly passkey?: PairingHandoffCompletePasskeyAccept;
  };
}
/** Honest per-offer outcome, never silently half-applied. */
export interface PairingHandoffOutcome {
  readonly kind: string;
  readonly status: string;
  readonly detail?: string;
}
export interface PairingHandoffCompleteResult {
  readonly results: readonly PairingHandoffOutcome[];
}

// ─── Tailscale one-action https (tailscale.get / tailscale.serve.run, SDK 1.8.0's
// LAN-http posture work) ────────────────────────────────────────────────────────
//
// The one confirmed action behind a "needs https, available via tailscale" label,
// reachable from the browser instead of only the TUI. tailscale.get is a READ-ONLY
// probe (binary present, logged in, MagicDNS name, the https URL `tailscale serve`
// would yield, and the most recent serve receipt if any), surfaces offer the
// affordance ONLY when this reports a usable environment (available && loggedIn &&
// httpsUrl); absence is quiet, never a nag or a dead button. tailscale.serve.run is
// the ONE state-changing tailscale command the daemon ever runs, and only from this
// explicit user-initiated verb; the attempt is recorded with an honest receipt
// either way, and on success the daemon's web.publicBaseUrl updates to the same
// https URL. Both ids carry no REST route binding (transport: ws-only), so they
// resolve through invokeGatewayMethod exactly like fleet.*/permissions.rules.*.
// Mirrors packages/sdk/src/platform/remote-access/tailscale.ts exactly.
export interface TailscaleServeReceipt {
  readonly at: number;
  readonly command: string;
  readonly ok: boolean;
  /** The https MagicDNS URL now fronting the daemon, present only on success. */
  readonly url?: string;
  readonly detail: string;
}
export interface TailscaleGetResult {
  readonly available: boolean;
  readonly loggedIn: boolean;
  readonly magicDnsName?: string;
  readonly httpsUrl?: string;
  readonly detail: string;
  readonly lastServe?: TailscaleServeReceipt;
}
export interface TailscaleServeRunResult {
  readonly receipt: TailscaleServeReceipt;
  readonly publicBaseUrlUpdated: boolean;
}

// ─── WebAuthn step-up (stepup.*) ──────────────────────────────────────
//
// The step-up verbs are REST-routed in the generated webui facade
// (WEBUI_METHOD_ROUTES: stepup.challenge.mint → POST /api/stepup/challenge,
// stepup.credentials.register → POST /api/stepup/credentials), so they resolve
// through invokeOperator/EXTRA_METHOD_ROUTES with no hand-written route. Both ids
// ARE in the OperatorMethodId union and carry generated I/O maps, so these are
// normal typed invokeOperator calls. The mint challenge is the bootstrap the relay
// gate exempts from its own step-up requirement; register is a local/admin ceremony.

/** A minted, short-lived, single-use challenge for navigator.credentials.get. */
export interface StepUpMintChallengeResult {
  readonly challengeId: string;
  /** base64url challenge bytes. */
  readonly challenge: string;
  readonly expiresAt: number;
}

/** Input to register a passkey the daemon will verify step-up assertions against. */
export interface StepUpRegisterCredentialInput {
  readonly rpId: string;
  readonly origin: string | readonly string[];
  readonly credentialId: string;
  readonly publicKeyCose: string;
  readonly signCount?: number;
  readonly userVerification?: 'required' | 'preferred' | 'discouraged';
  readonly label?: string;
}

/** A public (no key material) summary of the registered credential. */
export interface StepUpRegisterCredentialResult {
  readonly credential: {
    readonly credentialId: string;
    readonly label?: string;
    readonly createdAt: number;
    readonly signCount: number;
  };
}

/**
 * config.set's write outcome. See the `config.set` comment below for why this
 * exists rather than relying on the pinned contracts package's generated
 * OperatorMethodOutput<'config.set'> as-is.
 */
export interface ConfigSetOutcome {
  readonly success: boolean;
  readonly key: string;
  readonly value?: unknown;
  /** Absolute path (or daemon base URL, if landed remotely) the value actually landed in. */
  readonly persistedTo?: string;
  /** Mirrors the SDK's ConfigKeyTier (platform/config/manager-key-source.ts). */
  readonly tier?: 'daemon' | 'shared' | 'project' | 'global' | 'default';
  /** True when the daemon, not this client, is the writer/reader-of-record for this key. */
  readonly daemonOwned?: boolean;
}

/**
 * A stored card as every surface is allowed to see it: METADATA ONLY.
 *
 * There is no field here for the number, the expiry as typed, the CVV or the
 * cardholder name, and that is the point, the daemon has no method that
 * returns them. `last4` and `materialComplete` exist so a surface can render
 * "Visa ···4242, security code set" without the daemon ever emitting a value.
 *
 * Derived from the contract's own payments.cards.list output rather than
 * hand-written, so it cannot drift from what the daemon actually sends. The
 * hand-written version this replaced had already drifted in the direction that
 * matters least visibly: it was a faithful copy of the card object, but the
 * result type it sat inside omitted the sibling `defaultCardId` field, so no
 * caller could see which card the daemon would actually charge.
 *
 * Field notes worth keeping, since a derived type carries no comments of its
 * own: `issuerCapMinorUnits` is declared by the owner, unverifiable by us, and
 * never treated as an enforcement layer; `materialComplete` says whether every
 * required secret field is present, never which, and never the values.
 */
export type PaymentCardMetadata = OperatorMethodOutput<'payments.cards.list'>['cards'][number];

/**
 * What `payments.cards.create` accepts. Card material goes IN through here and
 * never comes back out; see the method comment on sdk.operator.payments.
 */
export interface PaymentCardCreateRequest {
  readonly label: string;
  readonly kind: 'virtual' | 'real';
  readonly number: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly cvv: string;
  readonly cardholderName: string;
  readonly issuerCapMinorUnits: number | null;
}

const scopedSdk = createBrowserKnowledgeSdk({
  baseUrl: GOODVIBES_BASE_URL,
  tokenStore,
  // routedFetch (lib/relay-connection.ts) is the plain global fetch whenever no relay
  // pairing exists or the direct path is reachable, this is a no-op for the common
  // LAN/co-located case. It only diverts to the relay-tunneled fetch once
  // useDaemonHealth's probe has determined the direct path is genuinely down AND a
  // relay pairing is stored. Stream requests are tunnelled too (the relay carries event
  // streams now), and a mutating call gated by the daemon's step-up requirement triggers
  // the inline passkey ceremony and is retried with the assertion attached (see that
  // file's header).
  fetch: routedFetch,
  realtime: {
    sseReconnect: DEFAULT_SSE_RECONNECT,
  },
});

export const sdk = {
  auth: {
    current: () => scopedSdk.auth.current(),
    getToken: () => tokenStore.getToken(),
    setToken: (token: string | null) => scopedSdk.auth.setToken(token),
    clearToken: () => scopedSdk.auth.clearToken(),
  },
  operator: {
    invoke: invokeOperator,
    control: {
      // A plain status read is receipt-NEUTRAL (never consumes). Pass
      // { receipts: 'consume' }, done exactly once per daemon connect, not per
      // poll, to receive undelivered update/crash/migration receipts and mark
      // them delivered; the daemon returns each such receipt exactly once.
      status: (input?: { receipts?: 'consume' }) => scopedSdk.operator.invoke('control.status', input ?? {}),
      snapshot: () => scopedSdk.operator.invoke('control.snapshot', {}),
      // methodInfo: an honest, read-only capability probe. 'control.methods.get'
      // IS in the installed 0.38 OperatorMethodId union with a real generated I/O map
      // (foundation-client-types.ts), so this is a normal typed invokeOperator call, not
      // a bridge, the METHOD BEING CHECKED (its `methodId` argument) can be any string,
      // including one this daemon build has never heard of, which is the whole point:
      // an unregistered id 404s with `{error: 'Unknown gateway method'}` rather than
      // pretending. Callers use this to decide whether to offer a not-yet-available
      // capability (e.g. sessions.delete) rather than rendering it and letting it fail.
      methodInfo: (methodId: string) => invokeOperator('control.methods.get', { methodId }),
    },
    accounts: {
      snapshot: () => scopedSdk.operator.invoke('accounts.snapshot', {}),
    },
    providers: {
      list: () => scopedSdk.operator.invoke('providers.list', {}),
      get: (providerId: string) => scopedSdk.operator.invoke('providers.get', { providerId }),
      usage: (providerId: string) => scopedSdk.operator.invoke('providers.usage.get', { providerId }),
    },
    credentials: {
      // Cross-surface secret-free credential status (see the 1.0.1 entry in
      // CHANGELOG.md). The browser reaches the shared store only over the
      // daemon. Status only, never bytes.
      get: () => invokeOperator('credentials.get'),
    },
    // stepup.*, the WebAuthn step-up ceremony's two server verbs. mintChallenge is the
    // bootstrap call the relay gate exempts from step-up (it is the prerequisite for
    // producing an assertion); registerCredential persists this device's passkey public
    // key so the daemon can verify later assertions. Both are REST-routed (see the
    // StepUpMintChallengeResult comment above) and resolve through invokeOperator.
    stepup: {
      mintChallenge: (input?: { rendezvousId?: string; sessionId?: string; ttlMs?: number }) =>
        invokeOperator<'stepup.challenge.mint', StepUpMintChallengeResult>('stepup.challenge.mint', input ?? {}),
      registerCredential: (input: StepUpRegisterCredentialInput) =>
        invokeOperatorUncheckedInput<StepUpRegisterCredentialResult>(
          'stepup.credentials.register',
          input,
        ),
    },
    // config.*, like models.*, no OperatorMethodId coverage in the pinned
    // browser SDK route maps, so both resolve through EXTRA_METHOD_ROUTES.
    // get() returns the daemon's FULL config tree unredacted (configManager.
    // getAll(), verified against system-routes.ts). Two consumers: the voice
    // surface reads the SHARED tts.provider/tts.voice defaults so the browser
    // speaks in the same voice as the TUI and agent; the model/config
    // workspace browses the same snapshot, callers there MUST run it through
    // src/lib/config-redaction.ts before rendering, never display it raw.
    // set() writes one key at a time (the daemon's real /config contract). The
    // explicit ConfigSetOutcome override widens the pinned contracts package's
    // generated OperatorMethodOutput<'config.set'> (just { success, key, value }
    // plus an open index signature) to the persistedTo/tier/daemonOwned fields
    // the daemon's postConfig route now reports (system-routes.ts), the
    // generated type already permits them at runtime via its index signature,
    // this just gives callers a typed shape instead of casting per call site.
    config: {
      get: () => invokeOperator('config.get'),
      set: (key: string, value: unknown) =>
        invokeOperator<'config.set', ConfigSetOutcome>('config.set', { key, value }),
    },
    // payments.cards.*, the ONLY path card material takes off this surface.
    //
    // create() carries the number, expiry, CVV and cardholder name to the
    // daemon, which puts them in its own secret store encrypted at rest, under
    // keys derived from the config path, daemon scope, so the daemon can read
    // them for an unattended purchase with every surface closed. That is the
    // owner's standing rule: anything configured on a surface stays available
    // to the daemon after that surface is gone.
    //
    // Both methods are REST-routed by the pinned contracts facade
    // (WEBUI_METHOD_ROUTES already carries payments.cards.*), so they resolve
    // through EXTRA_METHOD_ROUTES with no hand-written row, and create()'s
    // route is POST, which is what puts the card in the request BODY.
    // invokeOperator sends a GET method's input as a query string; a route
    // flipped to GET would therefore put a card number in a URL, in browser
    // history and in every server log along the way. payments-cards.test.ts
    // asserts the method stays POST for exactly that reason.
    //
    // There is deliberately NO read method for card material. list() answers
    // with metadata only (id, label, brand, last four, kind, expiry month/year,
    // declared issuer cap, and a materialComplete flag), and create()'s own
    // response is that same metadata, it never echoes what was submitted,
    // because an echo would be a read path and no read path exists.
    payments: {
      cards: {
        // No hand-supplied TInput/TOutput on any of the three: invokeOperator no
        // longer takes a TInput type argument at all (it types `input` as
        // OperatorMethodInput<TMethodId> directly), and all three ids carry real
        // generated OperatorMethodInputMap/OutputMap entries, so the defaults ARE
        // the contract. The hand-written triples these replaced were written when
        // the third type argument still existed; one of them had already drifted,
        // it declared list's result as `{ cards: PaymentCardMetadata[] }` and so
        // hid `defaultCardId`, which the daemon has been returning all along.
        list: () => invokeOperator<'payments.cards.list'>('payments.cards.list', {}),
        create: (input: PaymentCardCreateRequest) => invokeOperator<'payments.cards.create'>('payments.cards.create', input),
        delete: (id: string) => invokeOperator<'payments.cards.delete'>('payments.cards.delete', { id }),
      },
    },
    // Power (power.status.get / power.keepAwake.set, SDK 1.8.0's host sleep-ownership
    // work): both carry real generated OperatorMethodInputMap/OutputMap entries and a
    // real `http` route binding (GET /api/power/status, POST /api/power/keep-awake,
    // read:health / write:config), so both resolve through EXTRA_METHOD_ROUTES with no
    // bridge override needed, like channels.profiles.* above. status/keepAwake.set
    // return the SAME shape: `work` (the automatic inhibitor, held, grantedClasses,
    // deniedClasses, live "held because X" reasons, cap/expiry) and `keepAwake` (the
    // owner toggle, enabled, held, grantedClasses/deniedClasses, and an honest `note`
    // when part of the requested coverage was refused, e.g. lid-close suspend the OS
    // controls directly). Both emit runtime.ops OPS_POWER_STATE_CHANGED, which
    // useRealtimeInvalidation invalidates queryKeys.power on, see that hook's
    // DOMAIN_INVALIDATIONS map.
    power: {
      status: () => invokeOperator('power.status.get', {}),
      setKeepAwake: (enabled: boolean) => invokeOperator('power.keepAwake.set', { enabled }),
    },
    // Memory governance (ops.memory.get, SDK 1.9.0-dev's memory-relay-voice-hardening
    // work): the MemoryGovernor's own observability snapshot, current pressure tier,
    // budget vs RSS/heap, per-cache footprints the governor can shrink, paused
    // deferrable jobs, and the leak-tripwire state. Carries a real generated
    // OperatorMethodInputMap/OutputMap entry and a real `http` route binding (GET
    // /api/ops/memory, read:health), so it resolves through EXTRA_METHOD_ROUTES with no
    // bridge override needed, same as power.* above. OPS_MEMORY_PRESSURE rides the 'ops'
    // runtime domain (see useRealtimeInvalidation's DOMAIN_INVALIDATIONS map), the same
    // domain OPS_POWER_STATE_CHANGED already rides.
    ops: {
      memory: {
        get: () => invokeOperator('ops.memory.get', {}),
      },
    },
    // Voice (SDK 1.1.0). status/providers/voices are read:voice; stt/tts are write:voice.
    // ttsStream returns the RAW streamed-audio Response (not JSON), the Web Audio player
    // reads its bytes. All resolve through EXTRA_METHOD_ROUTES (except ttsStream, which is
    // a raw fetch) and carry the real generated I/O types.
    voice: {
      status: () => invokeOperator('voice.status', {}),
      providers: () => invokeOperator('voice.providers.list', {}),
      voices: (providerId?: string) =>
        invokeOperator('voice.voices.list', providerId ? { providerId } : {}),
      stt: (input: OperatorMethodInput<'voice.stt'>) => invokeOperator('voice.stt', input),
      tts: (input: OperatorMethodInput<'voice.tts'>) => invokeOperator('voice.tts', input),
      ttsStream: (input: OperatorMethodInput<'voice.tts.stream'>, signal?: AbortSignal) =>
        requestStream('/api/voice/tts/stream', input, signal),
      // Managed local-voice provisioning (voice.local.status / voice.local.install, SDK
      // 1.9.0-dev). Both carry real generated OperatorMethodInputMap/OutputMap entries
      // and real `http` route bindings (GET /api/voice/local/status, read:health; POST
      // /api/voice/local/install, write:config), so both resolve through
      // EXTRA_METHOD_ROUTES with no bridge override needed. install() is a single
      // request/response call, the wire contract has NO streamed per-component
      // progress today (the provisioner's internal onProgress callback is never wired
      // to a runtime event or a chunked response; see this round's adoption notes),
      // callers only ever get the final receipt, never intermediate ticks.
      local: {
        status: () => invokeOperator('voice.local.status', {}),
        install: () => invokeOperator('voice.local.install', {}),
      },
      // Wake-word detection in the browser tab (voice.wake.status /
      // voice.wake.provision / voice.wake.model). All three carry real generated
      // OperatorMethodInputMap/OutputMap entries and real `http` route bindings
      // (GET /api/voice/wake/status, POST /api/voice/wake/provision, GET
      // /api/voice/wake/model), so they resolve through EXTRA_METHOD_ROUTES the
      // same way voice.local.* does, no bridge override needed.
      //
      // `model.get` exists because a browser tab CANNOT fetch the pinned release
      // assets directly: they answer without an access-control-allow-origin
      // header, so the browser refuses the response before the bytes arrive. The
      // daemon already holds and verifies the files, so it serves them in 512 kB
      // chunks; a caller loops on `offset` until `complete` and verifies the
      // assembled bytes against the returned (pinned) sha256 before creating an
      // inference session. `provision` is an explicit act, ~3.7 MB, single-flight,
      // never automatic.
      wake: {
        status: () => invokeOperator('voice.wake.status', {}),
        provision: () => invokeOperator('voice.wake.provision', {}),
        // Nested to mirror the verb id exactly (`voice.wake.model.get`, whose tail is
        // a verb, the core-verbs conformance gate rejects a noun there), the same way
        // `voice.local.status` nests under `local`.
        model: {
          get: (input: OperatorMethodInput<'voice.wake.model.get'>) => invokeOperator('voice.wake.model.get', input),
        },
      },
    },
    // models.* (2.0.0 re-pin): real OperatorMethodId coverage and real REST bindings
    // (GET /api/models, GET /api/models/current, PATCH /api/models/current), see
    // invokeOperator's doc comment. `current` nests get/set to mirror the real verb ids
    // (models.current.get / models.current.set) exactly, the same way `wake.model.get`
    // nests above.
    models: {
      list: () => invokeOperator('models.list'),
      current: {
        get: () => invokeOperator('models.current.get'),
        // `effort` rides the same verb (sdk adds it alongside registryKey; the
        // generated input type here lags one pin behind, hence the unchecked
        // call for the effort-carrying variant). null CLEARS the persisted
        // level back to the provider default; omission leaves it untouched.
        set: (registryKey: string, effort?: string | null) =>
          effort === undefined
            ? invokeOperator('models.current.set', { registryKey })
            : invokeOperatorUncheckedInput('models.current.set', { registryKey, effort }),
      },
    },
    tasks: {
      // Local TaskSnapshotResult diverges from OperatorMethodOutput<'tasks.list'> only
      // by adding `cancellable` (see the Tasks section comment), explicit override.
      list: () => invokeOperator<'tasks.list', TaskSnapshotResult>('tasks.list'),
      create: (input: TaskCreateInput) => invokeOperator('tasks.create', input),
      cancel: (taskId: string) => invokeOperator('tasks.cancel', { taskId }),
      retry: (taskId: string) => invokeOperator('tasks.retry', { taskId }),
    },
    // Calendar (calendar.*, see the EXTRA_METHOD_ROUTES header comment above for the
    // invokable-false/501/404 honesty caveat). Every call site here is explicitly typed
    // against the hand-authored shapes above (no generated I/O map exists for this
    // family), see that section's header comment.
    calendar: {
      events: {
        list: (input?: CalendarEventsListInput) =>
          invokeOperatorUncheckedInput<CalendarEventsListResult>(
            'calendar.events.list',
            input ?? {},
          ),
        get: (eventId: string, calendarId?: string) =>
          invokeOperator<'calendar.events.get', CalendarEventDetail>(
            'calendar.events.get',
            { eventId, ...(calendarId ? { calendarId } : {}) },
          ),
        create: (input: CalendarEventCreateInput) =>
          invokeOperatorUncheckedInput<CalendarEventCreateResult>(
            'calendar.events.create',
            input,
          ),
      },
      ics: {
        export: (input?: CalendarIcsExportInput) =>
          invokeOperatorUncheckedInput<CalendarIcsExportResult>(
            'calendar.ics.export',
            input ?? {},
          ),
        import: (input: CalendarIcsImportInput) =>
          invokeOperatorUncheckedInput<CalendarIcsImportResult>(
            'calendar.ics.import',
            input,
          ),
      },
    },
    // Email (email.*). Routed entirely by the generated WEBUI_METHOD_ROUTES rows that
    // EXTRA_METHOD_ROUTES derives itself, this block adds no route and no transport,
    // only the ergonomic + typing layer over invokeOperator, exactly as calendar.* does.
    // Explicit type params throughout because this family has no generated I/O map (see
    // the EmailInboxMessage section header above for the transcription provenance).
    email: {
      inbox: {
        list: (input?: EmailInboxListInput) =>
          invokeOperatorUncheckedInput<EmailInboxListResult>(
            'email.inbox.list',
            input ?? {},
          ),
        read: (uid: number) =>
          invokeOperator<'email.inbox.read', EmailMessageDetail>('email.inbox.read', { uid }),
      },
      send: (input: EmailSendInput) =>
        invokeOperatorUncheckedInput<EmailSendResult>('email.send', input),
      draft: {
        create: (input: EmailDraftCreateInput) =>
          invokeOperatorUncheckedInput<EmailDraftCreateResult>(
            'email.draft.create',
            input,
          ),
      },
    },
    // Occasions and plans (occasions.*, docs/occasions.md). Real generated I/O maps
    // throughout, no bridge overrides needed, same as checkin/principals above (unlike
    // calendar.*/email.* just above, which predate a generated map for their family).
    // Sixteen verbs, every one a real REST route (table-routed through
    // EXTRA_METHOD_ROUTES, same as checkin.*/ci.*/principals.*): occasions.confirm,
    // occasions.plans.confirm and occasions.remove write to the owner's profile and take
    // `authority`, callers pass the SAME WEBUI_PROFILE_AUTHORITY/WEBUI_PROFILE_SURFACE
    // owner-profile.ts exports (docs/occasions.md §7: these three verbs "write to the
    // owner's profile ... go through the profile's own write gate", the identical gate
    // profile.set/append/forget/undo answer to). Nothing here computes a proximity word,
    // a lead-time adjustment or a nudge date, every one of those stays server-side
    // (docs/occasions.md §7's own governing line: "a consumer that computed anything
    // beyond calling these and rendering the answers would be a second implementation of
    // a rule that lives in the daemon").
    occasions: {
      list: () => invokeOperator('occasions.list', {}),
      pending: () => invokeOperator('occasions.pending', {}),
      propose: (input: OperatorMethodInput<'occasions.propose'>) => invokeOperator('occasions.propose', input),
      confirm: (input: OperatorMethodInput<'occasions.confirm'>) => invokeOperator('occasions.confirm', input),
      remove: (input: OperatorMethodInput<'occasions.remove'>) => invokeOperator('occasions.remove', input),
      answer: (input: OperatorMethodInput<'occasions.answer'>) => invokeOperator('occasions.answer', input),
      gifts: (occasionId: string) => invokeOperator('occasions.gifts', { occasionId }),
      sweep: () => invokeOperator('occasions.sweep', {}),
      state: () => invokeOperator('occasions.state', {}),
      conflict: {
        resolve: (occasionId: string) => invokeOperator('occasions.conflict.resolve', { occasionId }),
      },
      interview: {
        get: (interviewId: string) => invokeOperator('occasions.interview.get', { interviewId }),
        answer: (input: OperatorMethodInput<'occasions.interview.answer'>) =>
          invokeOperator('occasions.interview.answer', input),
        record: (input: OperatorMethodInput<'occasions.interview.record'>) =>
          invokeOperator('occasions.interview.record', input),
      },
      plans: {
        list: () => invokeOperator('occasions.plans.list', {}),
        propose: (input: OperatorMethodInput<'occasions.plans.propose'>) =>
          invokeOperator('occasions.plans.propose', input),
        confirm: (input: OperatorMethodInput<'occasions.plans.confirm'>) =>
          invokeOperator('occasions.plans.confirm', input),
      },
    },
    // Channel profiles (channels.profiles.*, SDK 1.6.1). Real generated I/O maps
    // throughout, no bridge overrides needed, unlike Approvals/Tasks above.
    channels: {
      profiles: {
        list: () => invokeOperator('channels.profiles.list', {}),
        get: (surfaceKind: string, channelId?: string) =>
          invokeOperator('channels.profiles.get', channelId ? { surfaceKind, channelId } : { surfaceKind }),
        set: (input: OperatorMethodInput<'channels.profiles.set'>) => invokeOperator('channels.profiles.set', input),
        delete: (surfaceKind: string, channelId?: string) =>
          invokeOperator('channels.profiles.delete', channelId ? { surfaceKind, channelId } : { surfaceKind }),
      },
    },
    // Check-in (checkin.*, SDK 1.6.1): the proactive-contact configuration, its run
    // receipts, and a manual run-now trigger. Real generated I/O maps throughout.
    checkin: {
      config: {
        get: () => invokeOperator('checkin.config.get', {}),
        set: (input: OperatorMethodInput<'checkin.config.set'>) => invokeOperator('checkin.config.set', input),
      },
      receipts: {
        list: (limit?: number) => invokeOperator('checkin.receipts.list', limit ? { limit } : {}),
      },
      run: () => invokeOperator('checkin.run', {}),
    },
    // Principals (principals.*, SDK 1.6.1): the named-identity registry. Real generated
    // I/O maps throughout.
    //
    // On the `{ id, ...input }` spread form used here and by sessions.steer / followUp /
    // messages.create: a property arriving THROUGH a spread is not excess-property
    // checked, so a stale key in the spread source compiles clean no matter how the
    // parameter is typed (measured, see the guard block above invokeOperatorUncheckedInput).
    // These four are safe for a structural reason rather than a checked one: every spread
    // source is DERIVED from the contract (OperatorMethodInput<…>, or an Omit of it), so it
    // cannot hold a key the contract does not, and a retirement removes it from both sides
    // in the same regeneration. Replace any of these sources with a hand-authored type and
    // that protection is gone silently, such a type needs its own OnlyDeclaredKeys guard,
    // which is exactly why profile.forget has one.
    principals: {
      list: () => invokeOperator('principals.list', {}),
      get: (principalId: string) => invokeOperator('principals.get', { principalId }),
      create: (input: OperatorMethodInput<'principals.create'>) => invokeOperator('principals.create', input),
      update: (principalId: string, input: Omit<OperatorMethodInput<'principals.update'>, 'principalId'>) =>
        invokeOperator('principals.update', { principalId, ...input }),
      delete: (principalId: string) => invokeOperator('principals.delete', { principalId }),
      resolve: (input: OperatorMethodInput<'principals.resolve'>) => invokeOperator('principals.resolve', input),
    },
    // Owner profile (profile.*, docs/owner-profile.md §11.1): the one hand-editable
    // Markdown document at daemon scope holding what the platform knows about the owner
    //, identity, contact, location, commerce, preferences, people, places, work, notes.
    //
    // ROUTING: all nine carry real REST bindings, so they resolve through
    // EXTRA_METHOD_ROUTES with no wiring here, that table is DERIVED from the generated
    // webui-facade artifact and pinned by the drift test, so a hand-written row is neither
    // allowed nor needed. Real generated I/O maps throughout.
    //
    // AUTHORITY AND USER-REQUEST: neither is sent. routes/owner-profile.ts reads an absent
    // `authority` as owner-direct and an absent `explicitUserRequest` as no claim either
    // way, both because no live transport populates them; declaring either from here would
    // be this surface asserting something it cannot know. The gates that do NOT trust the
    // caller's self-description, the derivation check against the untrusted-content
    // ledger, and the requirement that a verbatim owner utterance exists, still run.
    //
    // CONTAINMENT: `person` takes a NAME and there is deliberately no enumerate-all
    // counterpart (§10), `read` returns everything and is for the owner looking at his
    // own profile, never for a composition path assembling outbound content.
    profile: {
      read: () => invokeOperator('profile.read', {}),
      get: (fieldId: string) => invokeOperator('profile.get', { fieldId }),
      person: (name: string) => invokeOperator('profile.person', { name }),
      provenance: (fieldId: string) => invokeOperator('profile.provenance', { fieldId }),
      set: (input: OperatorMethodInput<'profile.set'>) => invokeOperator('profile.set', input),
      append: (input: OperatorMethodInput<'profile.append'>) => invokeOperator('profile.append', input),
      // Narrower than OperatorMethodInput<'profile.forget'>, which still declares the
      // RETIRED lineIndex and makes every property optional: the daemon 400s on a body
      // missing a target, missing an authority, or carrying a lineIndex at all. A prose
      // line is named by its section and exact text, never its position (§9.2).
      forget: (input: ProfileForgetInput) => invokeOperator('profile.forget', input),
      undo: (input: OperatorMethodInput<'profile.undo'>) => invokeOperator('profile.undo', input),
      status: () => invokeOperator('profile.status', {}),
    },
    // CI (ci.*, SDK 1.6.1): per-job CI status polling (never a rollup without the job
    // list, see ci.status's own description) and standing watches. Real generated I/O
    // maps throughout.
    ci: {
      status: (input: OperatorMethodInput<'ci.status'>) => invokeOperator('ci.status', input),
      watches: {
        list: () => invokeOperator('ci.watches.list', {}),
        create: (input: OperatorMethodInput<'ci.watches.create'>) => invokeOperator('ci.watches.create', input),
        delete: (watchId: string) => invokeOperator('ci.watches.delete', { watchId }),
        run: (watchId: string) => invokeOperator('ci.watches.run', { watchId }),
      },
    },
    approvals: {
      // Local ApprovalSnapshotResult/ApprovalRecord diverge from the generated contract
      // (open strings, optional audit, see the Approvals section comment), explicit
      // overrides throughout this group.
      list: () => invokeOperator<'approvals.list', ApprovalSnapshotResult>('approvals.list'),
      // selectedHunks: an index array into the pending approval's own
      // edit list. Omit it to approve the whole request. The daemon computes
      // modifiedArgs server-side, this call never carries a computed diff.
      // selectedHunks is not in OperatorMethodInputMap['approvals.approve'] yet, a
      // real, tested wire field the generated 0.38 map does not cover.
      approve: (approvalId: string, input?: ApprovalApproveInput) =>
        invokeOperatorUncheckedInput<ApprovalActionResult>(
          'approvals.approve',
          { approvalId, ...input },
        ),
      cancel: (approvalId: string) =>
        invokeOperator<'approvals.cancel', ApprovalActionResult>('approvals.cancel', { approvalId }),
      claim: (approvalId: string) =>
        invokeOperator<'approvals.claim', ApprovalActionResult>('approvals.claim', { approvalId }),
      // deny carries the optional reason as BOTH `note` (lands in the audit
      // trail via today's HTTP route) and `reason` (the broker's structured
      // user-declined feedback field), one text, both fields, so whichever
      // the daemon honors, nothing typed is silently dropped. Input override
      // for the same reason approve has one (reason is not in the generated map).
      deny: (approvalId: string, input?: ApprovalDenyInput) =>
        invokeOperator<'approvals.deny', ApprovalActionResult>(
          'approvals.deny',
          { approvalId, ...(input?.note ? { note: input.note } : {}), ...(input?.reason ? { reason: input.reason } : {}) },
        ),
    },
    // Durable approval rules (permissions.rules.*, this snapshot's rounds): the
    // remembered-decision store, listable and revocable. Both ids have real
    // generated I/O maps (foundation-client-types.ts); the explicit output
    // override swaps in PermissionRuleRecord, which keeps `tier` an open string
    // per the same defensive-parsing stance as ApprovalRecord (a newer daemon
    // may add tiers this client has never seen, render, never drop).
    permissions: {
      rules: {
        // transport: ws-only (no REST binding, and not in the scoped browser
        // SDK's entrypoint), generic-invoke-only via invokeGatewayMethod,
        // exactly like fleet.*/checkpoints.*.
        list: () =>
          invokeGatewayMethod<'permissions.rules.list', { rules: readonly PermissionRuleRecord[] }>(
            'permissions.rules.list',
            {},
          ),
        delete: (ruleId: string) =>
          invokeGatewayMethod<'permissions.rules.delete', { deleted: boolean }>(
            'permissions.rules.delete',
            { ruleId },
          ),
      },
    },
    // memory.records.* / memory.review-queue, table-routed via EXTRA_METHOD_ROUTES
    // (real REST bindings, see that table's comment); every I/O shape here is the
    // hand-authored local type above, cross-checked against the daemon's own schema
    // source rather than the (nonexistent, for these six ids) generated maps,
    // explicit TInput/TOutput overrides throughout, same pattern as Approvals/Tasks.
    memory: {
      search: (input?: MemorySearchInput) =>
        invokeOperatorUncheckedInput<MemorySearchResult>(
          'memory.records.search',
          input ?? {},
        ),
      add: (input: MemoryAddInput) =>
        invokeOperatorUncheckedInput<MemoryRecordEntityResult>('memory.records.add', input),
      get: (id: string) =>
        invokeOperator<'memory.records.get', MemoryRecordEntityResult>('memory.records.get', { id }),
      updateReview: (id: string, input: MemoryUpdateReviewInput) =>
        invokeOperator<'memory.records.update-review', MemoryRecordEntityResult>(
          'memory.records.update-review',
          { id, ...input },
        ),
      delete: (id: string) =>
        invokeOperator<'memory.records.delete', MemoryRecordDeleteResult>('memory.records.delete', { id }),
      reviewQueue: (input?: MemoryReviewQueueInput) =>
        invokeOperatorUncheckedInput<MemoryReviewQueueResult>(
          'memory.review-queue',
          input ?? {},
        ),
      // memory.consolidation.receipts (SDK 1.8.0), HAS a real generated I/O map
      // (unlike the six ids above), but the explicit TOutput override keeps the
      // hand-authored, narrower `merged`/`archived`/`decayed` entry shapes above
      // rather than the generated catch-all `{} & Record<string, unknown>`.
      consolidation: {
        receipts: () =>
          invokeOperator<'memory.consolidation.receipts', MemoryConsolidationReceiptsResult>(
            'memory.consolidation.receipts',
            {},
          ),
      },
    },
    // fleet.*/checkpoints.*/sessions.search, generic-invoke-only (see
    // invokeGatewayMethod above); I/O shapes are the contract-bridge-types.ts bridge
    // (real ids, generic generated I/O today, see that module's header for the swap).
    contracts: {
      list: (input: ContractsListInput = {}, signal?: AbortSignal): Promise<ContractsListResult> =>
        readContractMethod('contracts.list', input, signal),
      get: (contractId: string, signal?: AbortSignal): Promise<ContractRecord> =>
        readContractMethod('contracts.get', { contractId }, signal),
      cancel: async (contractId: string, signal: AbortSignal): Promise<OperatorMethodOutput<'contracts.cancel'>> => {
        const route = webuiRouteFor('contracts.cancel');
        if (route?.method !== 'POST') throw new Error('Contract cancellation is unavailable.');
        const input: OperatorMethodInput<'contracts.cancel'> = { contractId, reason: 'Cancelled by the user from WebUI.' };
        const { path, rest } = interpolateRoute(route, input);
        const result = await requestJson(path, { method: route.method, body: rest, signal });
        if (typeof result !== 'object' || result === null || !('cancelled' in result)
          || typeof result.cancelled !== 'boolean' || Object.keys(result).length !== 1) {
          throw new Error('The daemon returned an unreadable cancellation response.');
        }
        return { cancelled: result.cancelled };
      },
    },
    fleet: {
      snapshot: () => invokeGatewayMethod<'fleet.snapshot', FleetSnapshotResult>('fleet.snapshot', {}),
      list: (input?: FleetListInput) => invokeGatewayMethod<'fleet.list', FleetListResult>('fleet.list', input ?? {}),
      archive: (id: string) => invokeGatewayMethod<'fleet.archive', FleetArchiveResult>('fleet.archive', { id }),
      unarchive: (id: string) => invokeGatewayMethod<'fleet.unarchive', FleetUnarchiveResult>('fleet.unarchive', { id }),
      archiveFinished: () => invokeGatewayMethod<'fleet.archiveFinished', FleetArchiveFinishedResult>('fleet.archiveFinished', {}),
      archivedList: () => invokeGatewayMethod<'fleet.archived.list', FleetArchivedListResult>('fleet.archived.list', {}),
      // Best-of-N attempt resolution (SDK 1.6.1, confirm/apply grammar SDK 1.8.0). list is
      // read-only (held-merge candidate groups with per-candidate diffs + any prior judge
      // proposal); judge PROPOSES a winner with reasons, explicitly model judgment
      // (scoredBy:'model'), never an auto-pick; pick is the ONE-ACT verb: confirm defaults
      // to true here because every caller in this app (AttemptComparison's ConfirmSheet)
      // already ran its own human confirmation before calling pick, so the daemon should
      // actually apply, not hand back a preview that needs confirming a second time. Pass
      // confirm:false explicitly to get the structured preview (candidates + diffs + any
      // judge proposal) without applying anything. Output.applied says what really
      // happened, a caller must check it rather than assume confirm:true always merges
      // (a stale/no-longer-ready group can still come back requiresConfirm:true,
      // applied:false). An unknown/not-ready group is a 409 CONFLICT (lib/errors.ts
      // isConflictError), never a partial merge.
      attempts: {
        list: (workstreamId?: string) =>
          invokeGatewayMethod<'fleet.attempts.list', FleetAttemptsListResult>(
            'fleet.attempts.list',
            (workstreamId ? { workstreamId } : {}) as FleetAttemptsListInput,
          ),
        pick: (groupId: string, winnerItemId: string, confirm = true) =>
          invokeGatewayMethod<'fleet.attempts.pick', FleetAttemptsPickResult>(
            'fleet.attempts.pick',
            { groupId, winnerItemId, confirm },
          ),
        judge: (groupId: string) =>
          invokeGatewayMethod<'fleet.attempts.judge', FleetAttemptsJudgeResult>('fleet.attempts.judge', { groupId }),
      },
      // graph.get (SDK 1.8.0's fix-phase workstream rework): the dependency-graph view
      // of one workstream, nodes (id, title, state, cluster, files, merge state,
      // blocked reason, orphaned flag, deepest-remaining-path depth, stalled tell,
      // agent), edges (from depends-on to), and the elastic-pool state (ready/running
      // counts, at-cap, cap key + size, any spawn refusal). Unlike its fleet.* siblings
      // above (ws-only, generic-invoke), this carries a real generated I/O map AND a
      // real `http` route (GET /api/fleet/workstreams/{workstreamId}/graph,
      // read:fleet), resolves through EXTRA_METHOD_ROUTES like power.*/toolCalls.*/
      // queuedMessages.* above, with workstreamId interpolated as a path param. 404s
      // when the workstreamId is unknown to this daemon.
      graph: {
        get: (workstreamId: string) => invokeOperator('fleet.graph.get', { workstreamId }),
      },
      // observed.steer (SDK 1.8.0's read-only foreign-agent visibility): steer an
      // externally-launched coding-agent session over its genuine channel (tmux
      // send-keys). `id` is the OBSERVED NODE's own id (observed:<pid>, not a
      // sessionId, these rows carry no sessionRef). ws-only, generic-invoke, same
      // family as fleet.attempts.* above. Callers must gate this on
      // node.observed.steer.kind === 'tmux' first, a 'none' channel means there is
      // nothing to steer, and the daemon's own honest reason should render instead
      // of ever calling this.
      observed: {
        steer: (id: string, text: string) =>
          invokeGatewayMethod<'fleet.observed.steer', FleetObservedSteerResult>('fleet.observed.steer', { id, text }),
      },
    },
    checkpoints: {
      list: (input?: CheckpointsListInput) => invokeGatewayMethod<'checkpoints.list', CheckpointsListResult>('checkpoints.list', input ?? {}),
      create: (input: CheckpointsCreateInput) => invokeGatewayMethod<'checkpoints.create', CheckpointsCreateResult>('checkpoints.create', input),
      diff: (input: CheckpointsDiffInput) => invokeGatewayMethod<'checkpoints.diff', CheckpointsDiffResult>('checkpoints.diff', input),
      restore: (input: CheckpointsRestoreInput) =>
        invokeGatewayMethod<'checkpoints.restore', CheckpointsRestoreResult>('checkpoints.restore', input),
      restorePreview: (input: CheckpointsRestorePreviewInput) =>
        invokeGatewayMethod<'checkpoints.restorePreview', CheckpointsRestorePreviewResult>('checkpoints.restorePreview', input),
      // revertHunkPreview/revertHunk (SDK 1.6.1): the review-cockpit's REJECT→REVERT flow.
      // preview is read-only (validates the hunk still reverse-applies, mints a ~2min
      // single-use confirmToken, or answers applies:false with a human conflict string and
      // a null token); revertHunk consumes the token to snapshot-then-reverse-apply exactly
      // that one hunk. A stale/drifted hunk is an honest 409 CONFLICT (lib/errors.ts
      // isConflictError), never a partial write; the caller re-reads the diff and retries.
      revertHunkPreview: (input: CheckpointsRevertHunkPreviewInput) =>
        invokeGatewayMethod<'checkpoints.revertHunkPreview', CheckpointsRevertHunkPreviewResult>('checkpoints.revertHunkPreview', input),
      revertHunk: (input: CheckpointsRevertHunkInput) =>
        invokeGatewayMethod<'checkpoints.revertHunk', CheckpointsRevertHunkResult>('checkpoints.revertHunk', input),
    },
    // rewind.plan/apply (SDK 1.6.1): the unified message-anchored rewind, a terraform-style
    // dry-run/apply pair over the platform's history stores. plan previews what restoring
    // files and/or conversation to a turn anchor would change and mints a single-use
    // confirmToken; apply consumes it, records an undo point (a pre-restore safety checkpoint
    // and/or a captured conversation snapshot) so the rewind is itself reversible, and emits
    // REWIND_APPLIED. `transport: ["ws"]` only, generic-invoke-only like checkpoints.* above.
    // The conversation scope may be reported unavailable in the plan's `warnings` on a runtime
    // with no conversation store wired, SessionRewind renders that honestly, never faked.
    rewind: {
      plan: (input: RewindPlanInput) => invokeGatewayMethod<'rewind.plan', RewindPlanResult>('rewind.plan', input),
      apply: (input: RewindApplyInput) => invokeGatewayMethod<'rewind.apply', RewindApplyResult>('rewind.apply', input),
    },
    sessions: {
      list: () => invokeOperator('sessions.list', {}),
      // get/steer/followUp/create/messages.*/inputs.* are native in the 0.38 browser SDK
      // (SHARED_BROWSER_ROUTES), they resolve WITHOUT an EXTRA_METHOD_ROUTES row,
      // through invokeOperator's scopedSdk.operator.invoke fall-through. Routing them
      // through the same typed invokeOperator used everywhere else (rather than calling
      // scopedSdk.operator.invoke directly) means their input/output flow through the
      // REAL generated OperatorMethodInput/Output types with no `as never` cast at any
      // of these call sites, TypeScript rejects a wrong-shaped `input` here at compile
      // time (see goodvibes.test.ts's "wrong-typed steer input is a compile error" case).
      get: (sessionId: string) => invokeOperator('sessions.get', { sessionId }),
      steer: (sessionId: string, input: OperatorMethodInput<'sessions.steer'>) =>
        invokeOperator('sessions.steer', { sessionId, ...input }),
      followUp: (sessionId: string, input: OperatorMethodInput<'sessions.followUp'>) =>
        invokeOperator('sessions.followUp', { sessionId, ...input }),
      create: (input: OperatorMethodInput<'sessions.create'>) => invokeOperator('sessions.create', input),
      close: (sessionId: string) => invokeOperator('sessions.close', { sessionId }),
      reopen: (sessionId: string) => invokeOperator('sessions.reopen', { sessionId }),
      // delete (delete-means-delete): NOT in the installed 0.38 OperatorMethodId
      // union (unlike close/reopen above), see the EXTRA_METHOD_ROUTES header comment.
      // Untyped call site, like models.*, SessionDeleteResult is this module's own
      // honest local shape (`{sessionId, deleted}`), cross-checked against the SDK
      // repo's method-catalog-control-core.ts 'sessions.delete' outputSchema at the time
      // of writing. Requires the session to already be closed (409 SESSION_ACTIVE
      // otherwise), callers close first (see App.tsx / SessionsView.tsx call sites).
      // Callers MUST pair this with a capability check (operator.control.methodInfo) or
      // a proof-of-gone reconcile, never assume a 200 means the record is truly gone
      // on every daemon build.
      //
      // THE CAST BELOW IS NOT REDUNDANT, though tsc stays silent if you delete it.
      // OperatorMethodOutput<'sessions.delete'> is `{sessionId}`, it has no `deleted`.
      // The cast widens the result to this module's `{sessionId, deleted}`, and `deleted`
      // is the entire point of the verb (actually removed, not merely closed). Removing
      // it type-checks clean only because the one test that reads the result compares it
      // with toEqual rather than reading the field, so nothing forces the property to
      // exist, a later `if (result.deleted)` would then fail to compile. Retire the cast
      // when the generated output gains `deleted`, not before.
      delete: (sessionId: string) => invokeOperator('sessions.delete', { sessionId }) as Promise<SessionDeleteResult>,
      // sessions.search (typed-client scaffold, first consumer of the search facade):
      // in the OperatorMethodId union but routeless (no browser/EXTRA_METHOD_ROUTES
      // entry), generic-invoke-only, typed via the contract-bridge-types.ts bridge
      // until real I/O shapes land upstream.
      search: (input?: SessionsSearchInput) => invokeGatewayMethod<'sessions.search', SessionsSearchResult>('sessions.search', input ?? {}),
      messages: {
        create: (sessionId: string, input: OperatorMethodInput<'sessions.messages.create'>) =>
          invokeOperator('sessions.messages.create', { sessionId, ...input }),
        list: (sessionId: string) => invokeOperator('sessions.messages.list', { sessionId }),
      },
      inputs: {
        list: (sessionId: string) => invokeOperator('sessions.inputs.list', { sessionId }),
        cancel: (sessionId: string, inputId: string) => invokeOperator('sessions.inputs.cancel', { sessionId, inputId }),
      },
      // toolCalls.cancel (SDK 1.8.0's interaction-wins round): stop ONE running tool
      // call mid-flight without ending the turn, the turn continues (e.g. the model
      // sees a cancelled tool result and can respond to it), unlike
      // companion.chat.turns.cancel which stops the whole turn. Real generated I/O map
      // (`{sessionId, callId} -> {sessionId, callId, cancelled}`), real `http` route
      // (POST /api/sessions/{sessionId}/tool-calls/{callId}/cancel, write:sessions),
      // resolves through EXTRA_METHOD_ROUTES with both ids interpolated as path params.
      toolCalls: {
        cancel: (sessionId: string, callId: string) => invokeOperator('sessions.toolCalls.cancel', { sessionId, callId }),
      },
      // queuedMessages.list/edit/delete (SDK 1.8.0's interaction-wins round): a message
      // posted while another turn is still running sits queued (not yet delivered to the
      // model) until that turn ends. This lets a caller review, edit, or drop a queued
      // message before it is ever sent, real generated I/O maps and real `http` routes
      // throughout (GET/POST/DELETE /api/sessions/{sessionId}/queued-messages(/{messageId}),
      // read:sessions / write:sessions), all resolving through EXTRA_METHOD_ROUTES.
      queuedMessages: {
        list: (sessionId: string) => invokeOperator('sessions.queuedMessages.list', { sessionId }),
        edit: (sessionId: string, messageId: string, text: string) =>
          invokeOperator('sessions.queuedMessages.edit', { sessionId, messageId, text }),
        delete: (sessionId: string, messageId: string) =>
          invokeOperator('sessions.queuedMessages.delete', { sessionId, messageId }),
      },
      // detach (WEBUI-FLEET-DEPTH): remove ONE participant (surfaceId) from a shared
      // session, WITHOUT closing or killing it, detach != close != kill. Idempotent:
      // detaching an already-detached surface, or detaching from a closed session, is a
      // no-op success (verified against the SDK's own sessions.detach description). Used
      // by FleetView's "detach this browser" action on a session-backed fleet node: stop
      // receiving live updates for a process you're done watching without touching the
      // process itself or any other surface attached to it (e.g. the TUI).
      detach: (sessionId: string, surfaceId: string) =>
        invokeOperator<'sessions.detach', SessionsDetachResult>('sessions.detach', { sessionId, surfaceId }),
      // permissionMode.get/set + contextUsage.get (SDK 1.6.1): session-scoped, real
      // generated I/O maps, typed through the same invokeOperator overload as
      // close/reopen above, no bridge override needed. Both answer honestly only for
      // the daemon's own live local session (404 SESSION_NOT_LOCAL otherwise); callers
      // must check isSessionNotLocalError (lib/errors.ts) rather than assume success.
      permissionMode: {
        get: (sessionId: string) => invokeOperator('sessions.permissionMode.get', { sessionId }),
        set: (sessionId: string, mode: OperatorMethodInput<'sessions.permissionMode.set'>['mode']) =>
          invokeOperator('sessions.permissionMode.set', { sessionId, mode }),
      },
      contextUsage: {
        get: (sessionId: string) => invokeOperator('sessions.contextUsage.get', { sessionId }),
      },
      // changes.get (SDK 1.6.1): the session-scoped aggregate workspace diff, joined
      // over checkpoints stamped with this session's id (`transport: ["ws"]` only, no
      // `http` route, generic-invoke-only like checkpoints.*/sessions.search above, NOT
      // routed through invokeOperator/EXTRA_METHOD_ROUTES). A session with no stamped
      // checkpoints answers honestly with checkpointCount:0 and an empty diff
      // (from/to:"EMPTY") rather than an error, SessionChanges.tsx renders that as an
      // explicit "no captured changes for this session" state with a workspace-scoped
      // fallback, never a blank. Older sessions predate sessionId stamping and always
      // land in that honest-empty branch; the checkpoints.* baseline picker remains the
      // explicit secondary/fallback mode for them.
      changes: {
        get: (sessionId: string) =>
          invokeGatewayMethod<'sessions.changes.get', SessionsChangesGetResult>('sessions.changes.get', { sessionId }),
      },
      // hosted.* (daemon-hosted sessions): a conversation whose loop runs INSIDE the
      // daemon rather than inside this browser tab, create/attach/detach/kill/list the
      // lifecycle; `transport: ["ws"]` only ("ws-invoke" in the generated facade), no
      // `http` route, same generic-invoke-only shape as changes.get above. SWAP applied
      // (2.0.0 pin): these five ids now carry real OperatorMethodInputMap/OutputMap
      // entries (contract-bridge-types.ts), so they call invokeGatewayMethod directly
      // like every other bridged family, no more invokeGatewayMethodUncheckedInput. A
      // hosted session is steered with the ORDINARY sessions.steer/followUp/
      // toolCalls.cancel above, there is no sessions.hosted.steer (see the SDK's
      // method-catalog-hosted-sessions.ts header comment), so none is wired here.
      hosted: {
        list: (input?: SessionsHostedListInput) =>
          invokeGatewayMethod<'sessions.hosted.list', SessionsHostedListResult>('sessions.hosted.list', input ?? {}),
        create: (input: SessionsHostedCreateInput) =>
          invokeGatewayMethod<'sessions.hosted.create', SessionsHostedCreateResult>('sessions.hosted.create', input),
        attach: (sessionId: string, clientId: string) =>
          invokeGatewayMethod<'sessions.hosted.attach', SessionsHostedAttachResult>('sessions.hosted.attach', { sessionId, clientId }),
        detach: (sessionId: string, clientId: string) =>
          invokeGatewayMethod<'sessions.hosted.detach', SessionsHostedDetachResult>('sessions.hosted.detach', { sessionId, clientId }),
        kill: (sessionId: string) =>
          invokeGatewayMethod<'sessions.hosted.kill', SessionsHostedKillResult>('sessions.hosted.kill', { sessionId }),
      },
    },
    // watchers.stop (WEBUI-FLEET-DEPTH): the one fleet-node kill action genuinely
    // backed by a real operator wire verb, see the EXTRA_METHOD_ROUTES comment above.
    // Only `stop` is exposed here; watchers.create/delete/update/run/start are out of
    // scope for the fleet depth this brief asks for (fleet is a live-process READER,
    // not a watcher-authoring surface).
    watchers: {
      stop: (watcherId: string) =>
        invokeOperator<'watchers.stop', WatcherActionResult>('watchers.stop', { watcherId }),
    },
    // push.* (Web Push), generic-invoke-only (see the Web Push section comment
    // above). The PWA reads the public VAPID key, registers/lists/removes its own
    // browser subscription, and can send itself a live test push. Every capability
    // URL / key stays off the wire; the daemon hands back the redacted view.
    push: {
      vapidKey: () => invokeGatewayMethod<'push.vapid.get', PushVapidKeyResult>('push.vapid.get', {}),
      subscribe: (input: PushSubscriptionCreateInput) =>
        invokeGatewayMethod<'push.subscriptions.create', PushSubscriptionCreateResult>('push.subscriptions.create', input),
      list: () =>
        invokeGatewayMethod<'push.subscriptions.list', PushSubscriptionListResult>('push.subscriptions.list', {}),
      unsubscribe: (subscriptionId: string) =>
        invokeGatewayMethod<'push.subscriptions.delete', PushSubscriptionDeleteResult>('push.subscriptions.delete', { subscriptionId }),
      verify: (subscriptionId: string) =>
        invokeGatewayMethod<'push.subscriptions.verify', PushVerifyResult>('push.subscriptions.verify', { subscriptionId }),
      // reconcile (SDK 1.8.0): the reconcile-on-open self-heal call, see
      // reconcilePushSubscriptionOnOpen in lib/push/push-client.ts. Requires
      // deviceId (unlike subscribe, where it is optional) because reconcile's
      // whole point is healing the record already keyed on this device's identity.
      reconcile: (input: PushSubscriptionReconcileInput) =>
        invokeGatewayMethod<'push.subscriptions.reconcile', PushSubscriptionReconcileResult>(
          'push.subscriptions.reconcile',
          input,
        ),
    },
    // ─── Pairing (pairing.tokens.*, pairing.handoff.*, SDK 1.8.0) ───────────
    //
    // Per-device revocable pairing tokens replace the old single shared token:
    // each paired surface (a phone, a second laptop, …) gets its OWN named
    // token, so revoking one device never signs out every other device.
    // Generic-invoke-only (ws transport, no REST route), same family as push.*
    // above, but unlike push.*, these DO carry real generated
    // OperatorMethodInputMap/OutputMap entries (contracts 1.8.0), so the
    // explicit TOutput below is a cross-check, not a required fallback.
    //
    // CUSTODY: the daemon hands back the literal token STRING only once, from
    // tokens.create/tokens.migrate/handoff.create, at mint time, list/rename/
    // delete never see it again (the redacted PublicPairingToken view carries
    // id/name/timestamps only).
    //
    // handoff.* is the QR/deep-link bundle: create mints a per-device token AND
    // an offer set (notifications/relay/passkey, each independently declinable)
    // in one pass; complete drives the accepted offers. See usePairingHandoff
    // (src/hooks/usePairingHandoff.ts) for the client flow.
    pairing: {
      tokens: {
        list: () => invokeGatewayMethod<'pairing.tokens.list', PairingTokensListResult>('pairing.tokens.list', {}),
        create: (name: string) =>
          invokeGatewayMethod<'pairing.tokens.create', PairingTokensCreateResult>('pairing.tokens.create', { name }),
        // migrate: mint a new per-device token for an operator still on the legacy
        // shared token, without yet revoking it, a bridge step before revokeShared.
        migrate: (name: string) =>
          invokeGatewayMethod<'pairing.tokens.migrate', PairingTokensCreateResult>('pairing.tokens.migrate', { name }),
        rename: (id: string, name: string) =>
          invokeGatewayMethod<'pairing.tokens.rename', PairingTokensRenameResult>('pairing.tokens.rename', { id, name }),
        delete: (id: string) =>
          invokeGatewayMethod<'pairing.tokens.delete', PairingTokensDeleteResult>('pairing.tokens.delete', { id }),
        // revokeShared: a one-way action, once every device has its own token,
        // this permanently disables the legacy shared token so it can never sign
        // in again. legacySharedRevoked also comes back on tokens.list, so a
        // caller can render whether this has already happened.
        revokeShared: () =>
          invokeGatewayMethod<'pairing.tokens.revokeShared', PairingTokensRevokeSharedResult>(
            'pairing.tokens.revokeShared',
            {},
          ),
      },
      handoff: {
        create: (name: string, offers?: readonly string[]) =>
          invokeGatewayMethod<'pairing.handoff.create', PairingHandoffCreateResult>(
            'pairing.handoff.create',
            offers && offers.length > 0 ? { name, offers } : { name },
          ),
        complete: (input: PairingHandoffCompleteInput) =>
          invokeGatewayMethod<'pairing.handoff.complete', PairingHandoffCompleteResult>('pairing.handoff.complete', input),
      },
      // posture.get: the same honest TLS/capability read outside a pairing exchange, a
      // surface passes ITS OWN current origin (usePairingHandoff, useOriginPosture pass
      // window.location.origin) so the labels describe wherever it is actually running,
      // not wherever the daemon's configured web origin happens to be.
      posture: {
        get: (origin?: string) =>
          invokeGatewayMethod<'pairing.posture.get', PairingPostureGetResult>(
            'pairing.posture.get',
            (origin ? { origin } : {}) as PairingPostureGetInput,
          ),
      },
    },
    // cost.attribution.get (SDK 1.6.1): windowed (24h/7d), cache-aware-priced cost
    // attribution grouped by a dimension (agent/tool/hook/mcp/model/provider/session).
    // `transport: ["ws"]` only, generic-invoke-only like sessions.changes.get above.
    // Honest-unpriced: a row's costUsd is null when nothing in it could be priced,
    // costState says priced/estimated/unpriced, callers render that state, never treat
    // a null cost as zero. The per-session compact cost line (SessionsView) passes
    // dimension:"session" and reads the row whose key equals the session id.
    cost: {
      attribution: {
        get: (input: CostAttributionGetInput) =>
          invokeGatewayMethod<'cost.attribution.get', CostAttributionGetResult>('cost.attribution.get', input),
      },
    },
    // tailscale.get / tailscale.serve.run (SDK 1.8.0), see the type block above for
    // the full rationale. Neither id has a REST route binding, so both are
    // generic-invoke-only via invokeGatewayMethod.
    tailscale: {
      get: () => invokeGatewayMethod<'tailscale.get', TailscaleGetResult>('tailscale.get', {}),
      serveRun: () => invokeGatewayMethod<'tailscale.serve.run', TailscaleServeRunResult>('tailscale.serve.run', {}),
    },
  },
  chat: {
    sessions: {
      ...scopedSdk.chat.sessions,
      // delete-means-delete: this call site itself is UNCHANGED, the route
      // (DELETE /api/companion/chat/sessions/{sessionId}) already resolves through
      // EXTRA_METHOD_ROUTES either way. What changes is the daemon behind it: an older
      // daemon soft-closes (`{sessionId, status:'closed'}`, file retained); an upgraded
      // one hard-removes (`{sessionId, deleted:true}`, file gone). The static return type
      // here still reflects the installed 0.38 OperatorMethodOutputMap entry
      // (`{sessionId, status}`), the generated contract has not caught up to the
      // hard-delete work's real wire shape yet, so callers must NOT trust this call's
      // return value as proof the record is gone. App.tsx's delete flow never reads
      // this response's fields for that; it reconciles against a real re-fetch
      // (includeClosed:true) instead.
      delete: (sessionId: string) => invokeOperator('companion.chat.sessions.delete', { sessionId }),
      // close: a genuinely NEW, distinct soft-close verb for companion chat
      // (companion.chat.sessions.close), separate from delete, see the
      // EXTRA_METHOD_ROUTES header comment for its capability-availability caveat on an
      // older daemon. Companion delete now requires the session to already be closed
      // (409 SESSION_ACTIVE otherwise), so App.tsx's delete flow calls this first,
      // tolerating a "not available yet" failure (isMethodUnavailableError) rather than
      // treating it as fatal, an older daemon's delete route still works exactly as it
      // always did (soft-close-only), which the reconcile step then honestly reports.
      close: (sessionId: string) => invokeOperator('companion.chat.sessions.close', { sessionId }),
    },
    messages: {
      ...scopedSdk.chat.messages,
      // regenerate (companion.chat.messages.retry): re-run an assistant response
      // honestly. Omit messageId to regenerate the latest assistant reply. The prior
      // response is superseded (retained, flagged), never deleted, and a fresh turn
      // streams back over the same SSE channel. Untyped route (no generated I/O map),
      // CompanionRegenerateResult is this module's hand-authored shape.
      retry: (sessionId: string, input?: { messageId?: string }) =>
        invokeOperator('companion.chat.messages.retry', {
          sessionId,
          ...(input?.messageId ? { messageId: input.messageId } : {}),
        }) as Promise<CompanionRegenerateResult>,
      // edit-and-branch (companion.chat.messages.edit): edit a user message and branch
      // the conversation from it. The original (and everything after) is superseded
      // (retained, flagged); a new user message carrying `revisionOf` is appended and a
      // fresh turn answers it. The daemon route reads the edited text from `content`.
      edit: (sessionId: string, messageId: string, input: CompanionEditInput) =>
        invokeOperator('companion.chat.messages.edit', {
          sessionId,
          messageId,
          content: input.content,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }) as Promise<CompanionEditResult>,
    },
    // Server-side turn stop (companion.chat.turns.cancel, SDK 1.4+). The
    // terminal turn.cancelled event on the session stream is the authoritative
    // signal; treat 404 NO_ACTIVE_TURN as benign and feature-detect older
    // daemons with isMethodUnavailableError.
    turns: scopedSdk.chat.turns,
    events: scopedSdk.chat.events,
  },
  artifacts: scopedSdk.artifacts,
  realtime: {
    viaSse: () => scopedSdk.realtime.viaSse(),
  },
  // Raw event stream escape hatch. The scoped viaSse() per-domain filter DROPS the
  // un-domained `session-update` wire event (browser-scoped.ts), so session liveness
  // must be consumed off the raw control-plane stream instead. Kept confined to
  // useSessionRealtime; the rest of the app uses the typed viaSse facade above.
  streams: {
    open: (
      pathOrUrl: string,
      handlers: RawStreamHandlers,
      options?: RawStreamOptions,
    ) => scopedSdk.streams.open(pathOrUrl, handlers, options),
  },
  knowledge: scopedSdk.knowledge,
};

export type RawStreamHandlers = Parameters<typeof scopedSdk.streams.open>[1];
export type RawStreamOptions = Parameters<typeof scopedSdk.streams.open>[2];

export { forSession };
export type GoodVibesClient = typeof sdk;
export type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput, OperatorTypedMethodId, RuntimeEventDomain };

export async function invokeMethod<TMethodId extends OperatorTypedMethodId>(
  methodId: TMethodId,
  input?: OperatorMethodInput<TMethodId>,
): Promise<OperatorMethodOutput<TMethodId>> {
  return sdk.operator.invoke(methodId, input);
}

/** Direct authenticated, cancellable call to the generated judgment route. */
export async function runBrowserJudgment(
  input: OperatorMethodInput<'judgment.battery.run'>,
  signal: AbortSignal,
): Promise<OperatorMethodOutput<'judgment.battery.run'>> {
  const route = webuiRouteFor('judgment.battery.run');
  if (route?.method !== 'POST') throw new Error('Command judgment is unavailable.');
  return requestJson(route.path, { method: route.method, body: input, signal });
}

export async function getCurrentAuth(): Promise<unknown> {
  // The daemon's control-plane/auth is a STATUS endpoint: it answers 200 even when
  // the presented token is invalid/expired, carrying the real verdict in the
  // `authenticated` boolean (authMode 'invalid'/'anonymous'). Verified against both
  // real daemons AND an isolated bootDaemon. The signed-in gate (App.tsx) and the
  // health signed-in axis (useDaemonHealth) both key off this call THROWING to detect
  // "signed out", a resolved call is taken as signed-in. So a corrupt/expired token
  // used to leave the operator in the full shell while every data endpoint 401'd,
  // instead of the honest one-shot handoff to sign-in. Reject on `authenticated !==
  // true` with a 401/authentication error (NOT network/status-0, so it is treated as
  // unauthorized, sign-in front door, not as a daemon-unreachable outage).
  const snapshot = await sdk.auth.current();
  const record = asRecord(snapshot);
  if ('authenticated' in record && record.authenticated !== true) {
    throw Object.assign(new Error('Operator token rejected: the daemon reports the session is not authenticated.'), {
      status: 401,
      category: 'authentication',
      authMode: record.authMode,
    });
  }
  return snapshot;
}

/**
 * Synchronous best-effort check for a stored token, used ONLY to pick the optimistic
 * first paint (splash while a stored token is validated vs. the signed-out gate shown
 * immediately when there is no token). The async auth.current query remains
 * authoritative; this never asserts the token is valid, only that one is present.
 */
export function hasStoredTokenSync(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(WEBUI_TOKEN_STORE_KEY)?.trim();
    return Boolean(raw && raw !== 'null');
  } catch {
    return false;
  }
}

interface LoginResponse {
  authenticated: boolean;
  token: string;
  username: string;
  expiresAt: number;
}

function buildLoginUrl(): string {
  return `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/login`;
}

function isLoginResponse(value: unknown): value is LoginResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.authenticated === true
    && typeof record.token === 'string'
    && typeof record.username === 'string'
    && typeof record.expiresAt === 'number';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function login(username: string, password: string): Promise<unknown> {
  const url = buildLoginUrl();
  // routedFetch so sign-in works when the daemon is only reachable over the relay; on the
  // direct route this is the plain global fetch.
  const response = await routedFetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw Object.assign(new Error(`Login failed: ${response.status} ${response.statusText}`.trim()), {
      status: response.status,
      url,
      method: 'POST',
      body,
      category: response.status === 401 ? 'authentication' : 'unknown',
      hint: response.status === 401 ? 'Check the username and password stored in local auth.' : undefined,
    });
  }

  if (!isLoginResponse(body)) {
    throw Object.assign(new Error('Login response did not include a browser session token'), {
      status: response.status,
      url,
      method: 'POST',
      body,
      category: 'contract',
    });
  }

  const result = body;
  await tokenStore.setTokenEntry(result.token, result.expiresAt);
  return {
    authenticated: result.authenticated,
    username: result.username,
    expiresAt: result.expiresAt,
  };
}

export async function setExplicitAuthToken(rawToken: string): Promise<unknown> {
  const token = rawToken.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('Token is required');
  await sdk.auth.setToken(token);
  try {
    return await sdk.auth.current();
  } catch (error) {
    await sdk.auth.clearToken();
    throw error;
  }
}

export async function clearStoredAuthToken(): Promise<void> {
  await sdk.auth.clearToken();
}

export function isRuntimeDomain(value: string): value is RuntimeEventDomain {
  return isRuntimeEventDomain(value);
}
