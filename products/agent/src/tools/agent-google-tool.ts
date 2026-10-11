/**
 * The `google` tool: Gmail and Google Calendar, natively, in this process.
 *
 * Why this exists rather than a daemon operator method: `email.send`,
 * `email.inbox.list` and `calendar.events.list` are cataloged in the operator
 * contract with `invokable: false`, they advertise routes no daemon dispatch
 * chain serves. A capability declared against one of those is unreachable by
 * construction, and no amount of configuration changes that, which is why
 * setting `email.smtpHost` or adopting credentials moved nothing. Declaring the
 * capability against a permanently un-invokable method is the same defect class
 * as a module with no importer.
 *
 * So the capability index points at this tool instead. It is served here, in
 * this process, by the connector that already had a working `sendMessage`,
 * `listEvents` and OAuth refresh, nothing to install, nothing to configure by
 * hand, and no MCP server.
 *
 * Two boundaries are structural rather than advisory:
 *
 *   - Reading mail records an untrusted ingest, exactly as loading a web page
 *     does. Mail is written by whoever knows the address.
 *   - Sending mail and writing calendar events are outward effects, refused
 *     when their own content derives from what was read this turn. Content
 *     cannot cause a send.
 *
 * ── What this tool got wrong, and what it cost ────────────────────────────
 *
 * The owner asked for one mail to his own address to prove the connection
 * worked. The agent listed his inbox first, the obvious way to demonstrate
 * that reading works, and what it does unprompted when asked to prove the
 * connection, and the send was refused because of the listing. Three faults
 * here compounded, and each is worth naming because each looks harmless alone:
 *
 *   - The ingests recorded the ORIGIN but not the TEXT. Without the text there
 *     is nothing to compare an outgoing message against, so every send fell to
 *     the coarse "did this process read anything" rule, which in a tool people
 *     use to read mail is permanently yes.
 *   - The outward calls named no fields, so even retained text would not have
 *     been consulted. Two halves of one check, neither wired.
 *   - `mail.list` recorded exposure BEFORE testing whether anything matched.
 *     Listing an empty inbox therefore refused every later send in the turn,
 *     exposure invented out of a result set with nothing in it. A read that
 *     read nothing is not exposure, and the ordering is the whole difference.
 *
 * The shape to keep in mind: a guard that cannot answer the narrow question
 * does not become safe by refusing everything. It becomes a guard people route
 * around, and then there is no guard.
 */

import { assertCurrentToolEffect, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { retainSurfaceMethods } from './agent-surface-effect.ts';
import { captureStrictJudgmentJson, snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { isDeepStrictEqual } from 'node:util';
import { CardMaterialRefusedError, screenOutboundForCardMaterial } from '../agent/payments-channel-guard.ts';
import { assertDeliveryCurrent } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  beginGoogleConsent,
  openGoogleConnection,
  summarizeCredentials,
  type GoogleConnectionSources,
  type GoogleConsentSession,
  type GoogleLoopbackListenerFactory,
  type GoogleConsentCompletion,
} from '@goodvibes-jev/engine/sdk/platform/google';
import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createGoogleSettingsProjector, commitGoogleSettings, retainGoogleConnectionOwners, retainGooglePreparedEffectSource, type GooglePendingCredential } from './agent-google-admission.ts';
import { nodeGoogleFilePort } from '@goodvibes-jev/engine/sdk/platform/google/node';
import { GOOGLE_CONFIG_KEYS } from '@goodvibes-jev/engine/sdk/platform/google';
import {
  evaluateOutwardEffect,
  getSessionUntrustedContentLedger,
  originOf,
} from '../trust/untrusted-content.ts';
import {
  isSendToOwnerOnly,
  resolveOwnerAddresses,
  type OwnerApprovalStore,
  type TaintOptions,
} from '@goodvibes-jev/engine/sdk/platform/security';
import { rememberRefusedOutwardAction } from '../trust/outward-approvals.ts';
import type { GoogleApiFailure, GoogleApiResult } from '@goodvibes-jev/engine/sdk/platform/google';
import { getSessionExpectationBook } from '../agent/signup/session-expectations.ts';
import { deliveryEvidenceFromMessage, describeDeliveryEvidence, NO_ALIAS_MAILBOXES } from '@goodvibes-jev/engine/sdk/platform/google';
import { extractVerification } from '@goodvibes-jev/engine/sdk/platform/google';

const GOOGLE_ACTIONS = [
  'status',
  // The two that let a conversation FINISH a connection instead of handing
  // the owner a command. Before these existed the guided path had no honest
  // ending: it had walked him to a dialog holding a client id and a secret,
  // and the only thing it could say was "now go and type /google client ...".
  'connect.client',
  'connect.clientFile',
  'connect.complete',
  'mail.list',
  'mail.read',
  'mail.send',
  'calendar.list',
  'calendar.create',
  'mail.verification',
] as const;

/** Actions that only read. Everything else is an outward effect. */
const READ_ONLY_ACTIONS = new Set<string>(['status', 'mail.list', 'mail.read', 'calendar.list', 'mail.verification']);

/** Native setup resolves protected credential sources before ordinary Google calls. */
const CONNECT_ACTIONS = new Set<string>(['connect.client', 'connect.clientFile']);

export interface AgentGoogleToolOptions {
  readonly homeDirectory: string;
  readonly configGet: (key: string) => unknown;
  readonly secretGet: (key: string) => Promise<string | null>;
  /** Injected in tests; production uses the process fetch. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Binds the local port Google redirects back to after consent. Injected
   * because binding a port is real machine I/O, the whole exchange runs
   * against a fake listener in tests.
   */
  readonly loopback?: GoogleLoopbackListenerFactory | undefined;
  /**
   * Where approvals the owner has answered are held, when this surface has an
   * approval prompt wired.
   *
   * Absent means no path is wired here, and the refusal says exactly that
   * rather than inventing a remedy, which is how the owner came to be told to
   * reply "send it now" to a mechanism that did not exist.
   */
  readonly approvals?: OwnerApprovalStore | undefined;
  /**
   * The gesture that answers an approval prompt on this surface, in the
   * owner's words. Only meaningful alongside `approvals`.
   */
  readonly approvalGesture?: string | undefined;
  /** Native configuration and physical credential observation; an added restriction only. */
  readonly captureConnectionCurrent?: (() => () => void) | undefined;
  readonly configManager?: ConfigManager | undefined;
  readonly secretsManager?: SecretsManager | undefined;
}

type ToolOutput = { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string };

function failure(message: string): ToolOutput {
  return { success: false, error: message };
}

function ok(output: string): ToolOutput {
  return { success: true, output };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

/** Render an API failure with its own fix text rather than a bare error. */
function describeFailure(result: GoogleApiFailure): ToolOutput {
  return failure(`${result.problem} ${result.fix}`);
}

function isFailure<T>(result: GoogleApiResult<T>): result is GoogleApiFailure {
  return !result.ok;
}

const NOT_CONNECTED = [
  'No Google account is connected on this machine.',
  'Offer to connect one: work out the shortest route, walk the user through creating an OAuth client if there is none,',
  'Use connect.clientFile with the exact OAuth client JSON they named, or connect.client with their client id and the already configured native client secret.',
  'New secret values require the native secure credential entry. Return the consent link after registration, then use connect.complete after consent.',
].join(' ');

export function createAgentGoogleTool(options: AgentGoogleToolOptions): Tool {
  const captureNativeCurrent = () => options.configManager && options.secretsManager
    ? retainGoogleConnectionOwners({ configManager: options.configManager, secretsManager: options.secretsManager }) : undefined;
  const sources: GoogleConnectionSources = {
    files: nodeGoogleFilePort,
    homeDirectory: options.homeDirectory,
    configGet: options.configGet,
    secretGet: options.secretGet,
  };
  const nativeFetch = fetch;
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => nativeFetch(url, init));

  /**
   * Outward-effect gate.
   *
   * `content` is the fields about to leave the machine. Supplying them is what
   * turns "has this process read anything", permanently yes for anyone who
   * uses the mail tool at all, into "does THIS message repeat what was read",
   * which is answerable and almost always no. Without it the tool took the
   * coarse path and refused every send that followed any read, which is the
   * defect the owner met: he listed his inbox to prove the connection worked,
   * and the send he was proving it with was refused on the strength of the
   * listing.
   */
  async function outwardAllowed(
    action: string,
    description: string,
    content: Readonly<Record<string, string | undefined>>,
    taintOptions?: TaintOptions,
  ): Promise<ToolOutput | null> {
    const decision = await evaluateOutwardEffect({
      request: { toolName: 'google', action, description },
      ledger: getSessionUntrustedContentLedger(),
      content,
      ...(taintOptions === undefined ? {} : { taintOptions }),
      // Spend a matching approval if the owner has already answered a prompt
      // for this exact payload. `take` removes it, so one answered prompt
      // authorizes one send.
      approval: options.approvals?.take({ action, content }) ?? null,
    });
    if (decision.allowed) return null;
    // Record WHAT was refused, so the approval gesture has one specific message
    // to approve rather than acting as a blank cheque over whatever comes next.
    if (options.approvals !== undefined) {
      rememberRefusedOutwardAction({ action, description, content });
    }
    return failure(decision.reason ?? 'Google outbound content was refused.');
  }

  /**
   * The owner's own addresses, from configuration only.
   *
   * Read per call because he can connect a mailbox mid-session. Never from a
   * header, a sender, or anything else a message can influence, see the SDK's
   * security/owner-identity.ts for what an attacker would have to control.
   */

  /**
   * The consent in flight, if one is.
   *
   * Held so a second `connect.client` in the same session releases the first
   * listener rather than leaving a bound port behind. One connection at a time
   * is the only sensible reading anyway: a second paste replaces the first.
   */
  let pendingConsent: GoogleConsentSession | null = null;
  let pendingCredential: GooglePendingCredential | null = null;
  let pendingOutcome: GoogleConsentCompletion | null = null;

  /** Registration + the consent link, in one answer. */
  async function registerClient(rawArgs: Record<string, unknown>, executionOptions: Parameters<Tool['execute']>[1]): Promise<ToolOutput> {
    const loopback = options.loopback;
    if (!options.configManager || !options.secretsManager || loopback === undefined) {
      // A surface with no writable store says so rather than reporting a
      // success it did not perform, the same rule the approval path follows.
      return failure(
        'This surface cannot register a Google client: it was built without a writable credential store. '
        + 'No client configuration or credential was stored.',
      );
    }

    const committed = await commitGoogleSettings(rawArgs, executionOptions);
    if (committed.receipt.status !== 'committed') return failure('Google registration has a partial or unknown storage outcome. No write was retried and no consent was started.');
    if (!committed.sourceCurrent) return failure('The client was stored, but its connection owner changed before consent started. No consent was started.');
    const storedClientId = committed.clientId, storedSecret = committed.clientSecret;
    const config = { get: options.configGet, set: () => { throw new ToolInputProjectionError('held'); } };
    const secrets = { get: options.secretGet, set: async () => { throw new ToolInputProjectionError('held'); } };

    pendingConsent?.cancel();
    pendingOutcome = null;
    const nativeCurrent = options.captureConnectionCurrent?.() ?? captureNativeCurrent();
    const sourceMethods = retainSurfaceMethods(options, ['configGet', 'secretGet', ...(options.fetchImpl ? ['fetchImpl'] : []), ...(options.captureConnectionCurrent ? ['captureConnectionCurrent'] : [])]);
    const credential: GooglePendingCredential = { clientId: storedClientId, clientSecret: storedSecret, refreshToken: null, assertCurrent() {
      executionOptions?.signal?.throwIfAborted(); sourceMethods(); assertDeliveryCurrent({ assertCurrent: nativeCurrent });
      if (!options.fetchImpl && fetch !== nativeFetch) throw new ToolInputProjectionError('stale');
      if (pendingCredential !== credential) throw new ToolInputProjectionError('stale');
    } };
    pendingCredential = credential;
    const loginHint = readString(options.configGet('email.username'))
      || readString(options.configGet('email.fromAddress'));
    const session = beginGoogleConsent({
      clientId: storedClientId,
      clientSecret: storedSecret,
      config,
      secrets,
      loopback,
      fetchPort: { async fetch(url, init) {
        credential.assertCurrent();
        const signal = executionOptions?.signal;
        const response = await fetchImpl(url, { ...init, ...(signal ? { signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal } : {}) });
        credential.assertCurrent(); return response;
      } },
      signal: executionOptions?.signal,
      assertCurrent: credential.assertCurrent,
      receiveRefreshToken(value) { credential.assertCurrent(); credential.refreshToken = value; },
      ...(loginHint ? { loginHint } : {}),
    });
    pendingConsent = session;
    // The exchange finishes whenever the person approves. Nothing awaits it
    // here: this answer is due now, and a turn that blocked for the length of
    // a consent screen would look broken.
    void session.completed.then((outcome) => {
      if (session === pendingConsent) pendingConsent = null;
      if (pendingCredential === credential) pendingOutcome = outcome;
      return outcome;
    });

    return ok([
      `Registered the OAuth client ending ${storedClientId.slice(-12)}. The secret is in the encrypted store and is not shown again.`,
      '',
      'Open this link and approve it, it asks for mail and calendar together, so one approval covers both:',
      session.consentUrl,
      '',
      ...(loginHint ? [`Approve as ${loginHint}, not a personal account.`] : []),
      'Once Google approves, call connect.complete to store the returned credential through its current admitted action.',
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n'));
  }

  const tool: Tool = {
    definition: {
      name: 'google',
      description:
        'Read and send Gmail; read and write Google Calendar. '
        + 'connect.client uses the preconfigured stored OAuth client secret. connect.clientFile uses an exact named client JSON. '
        + 'Both return a consent link. connect.complete stores the returned credential with fresh admission. '
        + 'Inline client secrets must enter through the native secure credential setup.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...GOOGLE_ACTIONS],
            description: 'What to do. status reports the connected account.',
          },
          query: { type: 'string', description: 'Gmail search query for mail.list.' },
          id: { type: 'string', description: 'Message id for mail.read or mail.verification.' },
          to: { type: 'string', description: 'Recipient address for mail.send.' },
          subject: { type: 'string', description: 'Subject for mail.send.' },
          body: { type: 'string', description: 'Plain-text body for mail.send.' },
          summary: { type: 'string', description: 'Event title for calendar.create.' },
          start: { type: 'string', description: 'RFC3339 start time for calendar.create.' },
          end: { type: 'string', description: 'RFC3339 end time for calendar.create.' },
          location: { type: 'string', description: 'Optional event location for calendar.create.' },
          description: { type: 'string', description: 'Optional event description for calendar.create.' },
          timeMin: { type: 'string', description: 'RFC3339 lower bound for calendar.list.' },
          timeMax: { type: 'string', description: 'RFC3339 upper bound for calendar.list.' },
          maxResults: { type: 'number', description: 'How many items to return. Defaults to 10.' },
          clientId: { type: 'string', description: 'OAuth client id the user pasted, for connect.client.' },
          clientSecret: { type: 'string', description: 'Inline secret values are refused at the model boundary; use native secure credential setup or clientSecretRef.' },
          clientSecretRef: { type: 'string', description: 'Stored OAuth client-secret reference for connect.client; defaults to the native Google credential key.' },
          path: { type: 'string', description: 'Path to an OAuth client JSON the user named, for connect.clientFile.' },
          confirm: { type: 'boolean', description: 'Optional historical provenance; does not grant effect authority.' },
        },
        required: ['action'],
      },
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions): Promise<ToolOutput> => {
      const args = captureStrictJudgmentJson(rawArgs); snapshotJudgmentInput(args);
      const requested = readString(args.action);
      if (!requested) return failure(`google needs an action. Use one of: ${GOOGLE_ACTIONS.join(', ')}.`);
      // Matched case-insensitively but resolved to the CANONICAL spelling.
      // Lowercasing in place used to be the whole normalisation, which quietly
      // made every camelCase action unreachable, `connect.clientFile` arrived
      // as `connect.clientfile` and matched nothing.
      const action = GOOGLE_ACTIONS.find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
      if (action === undefined) {
        return failure(`Unknown google action "${requested}". Use one of: ${GOOGLE_ACTIONS.join(', ')}.`);
      }

      // Registration runs BEFORE the connection is opened, because a machine
      // that needs it does not have one yet.
      if (CONNECT_ACTIONS.has(action)) return await registerClient(rawArgs, executionOptions);
      if (action === 'connect.complete') {
        if (!pendingCredential?.refreshToken) return failure(pendingOutcome?.detail ?? 'Google consent is still pending.');
        const committed = await commitGoogleSettings(rawArgs, executionOptions);
        if (committed.receipt.status !== 'committed') return failure('Google credential storage has a partial or unknown outcome. No write was retried.');
        if (!committed.sourceCurrent || pendingCredential !== committed.pending) return failure('Google credential was stored, but the connection owner changed afterward.');
        pendingCredential.refreshToken = null; pendingCredential = null; pendingOutcome = null;
        return ok('Google approved. The credential is in the encrypted store.');
      }

      const effect = !READ_ONLY_ACTIONS.has(action);
      const methods = retainSurfaceMethods(options, ['configGet', 'secretGet', ...(options.fetchImpl ? ['fetchImpl'] : []), ...(options.captureConnectionCurrent ? ['captureConnectionCurrent'] : [])]);
      if (effect && (options.configManager || options.secretsManager) && !(options.configManager && options.secretsManager)) throw new ToolInputProjectionError('held');
      const nativeCurrent = effect && options.configManager && options.secretsManager
        ? retainGooglePreparedEffectSource(rawArgs, executionOptions)
        : options.captureConnectionCurrent?.() ?? captureNativeCurrent();
      const configValues = new Map<string, unknown>();
      const secretValues = new Map<string, string | null>();
      const configGet = options.configGet, secretGet = options.secretGet;
      const ledger = getSessionUntrustedContentLedger();
      const ledgerMethods = retainSurfaceMethods(ledger, ['getPublicationRevision', 'originsThisTurn', 'exposuresThisTurn', 'taintSourcesThisTurn']);
      const ledgerSnapshot = () => JSON.stringify([ledger.getPublicationRevision(), ledger.originsThisTurn(), ledger.exposuresThisTurn(), ledger.taintSourcesThisTurn()]);
      const ledgerVersion = ledgerSnapshot();
      const assertCurrent = () => {
        executionOptions?.signal?.throwIfAborted();
        if (effect && (!assertCurrentToolEffect(rawArgs, executionOptions, 'send')
          || (action === 'calendar.create' && !assertCurrentToolEffect(rawArgs, executionOptions, 'write')))) throw new ToolInputProjectionError('held');
        if (!effect) assertDeliveryCurrent({ assertCurrent: () => executionOptions?.assertCurrent?.(rawArgs) });
        methods(); ledgerMethods(); assertDeliveryCurrent({ assertCurrent: nativeCurrent });
        if (!options.fetchImpl && fetch !== nativeFetch) throw new ToolInputProjectionError('stale');
        for (const [key, value] of configValues) if (!isDeepStrictEqual(captureStrictJudgmentJson({ value: configGet(key) ?? null }), value)) throw new ToolInputProjectionError('stale');
        if (effect && (getSessionUntrustedContentLedger() !== ledger || ledgerSnapshot() !== ledgerVersion)) throw new ToolInputProjectionError('stale');
        methods(); assertDeliveryCurrent({ assertCurrent: nativeCurrent });
      };
      const assertCredentials = async () => {
        assertCurrent();
        for (const [key, value] of secretValues) {
          if (await secretGet(key) !== value) throw new ToolInputProjectionError('stale');
          assertCurrent();
        }
      };
      assertCurrent();
      const guardedSources: GoogleConnectionSources = { ...sources, configGet(key) {
        assertCurrent(); const value = configGet(key); configValues.set(key, captureStrictJudgmentJson({ value: value ?? null })); assertCurrent(); return value;
      }, async secretGet(key) {
        assertCurrent(); const value = await secretGet(key); assertCurrent();
        const previous = secretValues.get(key);
        if (secretValues.has(key) && previous !== value) throw new ToolInputProjectionError('stale');
        secretValues.set(key, value); return value;
      } };
      const connection = await openGoogleConnection(guardedSources, { fetch: { async fetch(url, init) {
        await assertCredentials(); assertCurrent();
        const signal = executionOptions?.signal;
        const result = await fetchImpl(url, { ...init, ...(signal ? { signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal } : {}) });
        await assertCredentials(); assertCurrent(); return result;
      } } });
      assertCurrent();
      if (connection === null) return failure(NOT_CONNECTED);
      const { client } = connection;

      // What the grant actually permits is only knowable AFTER a refresh.
      //
      // A credential read from the encrypted store is constructed with an empty
      // scope list, the store records no scopes, and the real set arrives on
      // the refresh response. Gating on the pre-refresh summary therefore reads
      // an empty list as "no permissions" and refuses mail.send and
      // calendar.create on a perfectly good credential. That was invisible
      // while credentials came off disk carrying their own scope list, and it
      // became every credential's problem the moment the store became the only
      // source. `collectHistoryDelta` already forces this refresh for the same
      // reason; this is the same fix on the tool path.
      const refreshed = await connection.tokens.forceRefresh();
      assertCurrent();
      if (!refreshed.ok) {
        return failure([refreshed.problem, refreshed.fix].filter(Boolean).join(' '));
      }
      const summary = summarizeCredentials(
        { ...connection.credentials, scopes: connection.tokens.scopes() },
        Date.now(),
      );

      if (action === 'status') {
        return ok(
          [
            summary.detail,
            `Send mail: ${summary.canSendMail ? 'permitted' : 'not permitted by the granted scopes'}.`,
            `Read mail: ${summary.canReadMail ? 'permitted' : 'not permitted by the granted scopes'}.`,
            `Calendar: ${summary.canWriteCalendar ? 'read and write' : summary.canReadCalendar ? 'read only' : 'not permitted by the granted scopes'}.`,
          ].join('\n'),
        );
      }

      if (action === 'mail.list') {
        const result = await client.listMessages({
          query: readString(args.query) || undefined,
          maxResults: readNumber(args.maxResults, 10),
        });
        assertCurrent();
        if (isFailure(result)) return describeFailure(result);
        // A listing that matched nothing read nothing, so there is nothing it
        // could have derived an outward action from. Recording an ingest here
        // recorded that a READ HAPPENED rather than that any text arrived, and
        // it refused subsequent sends on the strength of an empty result set,
        // exposure invented out of an empty inbox.
        if (result.value.length === 0) return ok('No messages matched.');
        // Subject lines and sender names are attacker-controlled text, so they
        // are recorded WITH the text. Recording the origin alone left the guard
        // unable to tell a send that repeats a subject line from one that does
        // not, which drops every later send to the coarse refusal.
        getSessionUntrustedContentLedger().record({
          surface: 'email',
          origin: 'gmail',
          at: new Date().toISOString(),
          content: result.value.map((message) => `${message.from} ${message.subject}`).join('\n'),
        });
        return ok(result.value.map((message) => `${message.id}  ${message.from}, ${message.subject}`).join('\n'));
      }

      if (action === 'mail.read') {
        const id = readString(args.id);
        if (!id) return failure('google action:"mail.read" needs the message id, from mail.list.');
        const result = await client.getMessage(id);
        assertCurrent();
        if (isFailure(result)) return describeFailure(result);
        // The whole body is MORE attacker-controlled text than a subject line,
        // not less, so it is what gets retained, the guard can only weigh
        // derivation from text it was given.
        getSessionUntrustedContentLedger().record({
          surface: 'email',
          origin: originOf(`mailto:${result.value.from}`),
          at: new Date().toISOString(),
          content: `${result.value.subject}\n${result.value.body}`.trim(),
        });
        return ok([`From: ${result.value.from}`, `Subject: ${result.value.subject}`, '', result.value.body].join('\n'));
      }

      if (action === 'mail.verification') {
        // The one case where mail may yield something actionable, and only
        // because the agent provoked it. Correlation runs on receiver-written
        // delivery headers; the To: header is never accepted as evidence.
        const id = readString(args.id);
        if (!id) return failure('google action:"mail.verification" needs the message id, from mail.list.');
        const result = await client.getMessage(id);
        assertCurrent();
        if (isFailure(result)) return describeFailure(result);

        const book = getSessionExpectationBook();
        // Gmail files mail under labels, not per-alias mailboxes: a plus-addressed
        // alias still lands in the one INBOX, so no mailbox name here identifies a
        // signup. Gmail's evidence is the receiver-written Delivered-To header,
        // which is what the message carries.
        const deliveredTo = deliveryEvidenceFromMessage(
          { deliveredTo: result.value.deliveredTo },
          NO_ALIAS_MAILBOXES,
        );
        getSessionUntrustedContentLedger().record({
          surface: 'email',
          origin: originOf(`mailto:${result.value.from}`),
          at: new Date().toISOString(),
          content: `${result.value.subject}\n${result.value.body}`.trim(),
        });

        const candidate = {
          messageId: result.value.id,
          from: result.value.from,
          deliveredTo,
          toHeaderClaim: result.value.to,
          subject: result.value.subject,
          body: result.value.body,
        };

        // Inspect without consuming. A signup provokes more than one mail at the
        // minted alias, a welcome note usually arrives before the verification,
        // and consuming on the match alone would spend the fifteen-minute window
        // on whichever landed first, leaving the real verification to be refused
        // as unexpected. The expectation is closed below, once a token is in hand.
        const match = book.matchCandidate(candidate, new Date(), { consume: false });

        if (match.kind !== 'matched') {
          return failure(
            `Not treated as a verification: ${match.reason} (${describeDeliveryEvidence(deliveredTo)}). Nothing was extracted from the message.`,
          );
        }

        const extraction = extractVerification(candidate, match.expectation);
        const artifact = extraction.artifact;
        if (artifact.kind === 'link') {
          // Single-use: the alias has now produced its one token.
          book.closeExpectation(match.expectation.id);
          return ok(`Verification link for ${match.expectation.serviceDomain}: ${artifact.url}`);
        }
        if (artifact.kind === 'code') {
          book.closeExpectation(match.expectation.id);
          return ok(`Verification code for ${match.expectation.serviceDomain}: ${artifact.code}`);
        }
        // Neither refusal closes the expectation. A message pointing at the wrong
        // host is the shape of a forgery, and letting one burn the window would
        // hand an attacker a denial of the real verification for the price of a
        // single mail to a guessed alias.
        if (artifact.kind === 'refused') {
          return failure(artifact.message);
        }
        return failure(`No verification link or code was found in that message: ${artifact.reason}`);
      }

      if (action === 'mail.send') {
        const to = readString(args.to);
        const subject = readString(args.subject);
        const body = readString(args.body);
        if (!to || !subject) return failure('google action:"mail.send" needs to and subject.');
        if (!summary.canSendMail) {
          return failure('The connected Google account was not granted a scope that permits sending mail. Re-authorize with: /google reauthorize');
        }
        // The one exemption: a send whose EVERY recipient is the owner himself.
        //
        // He is the trust root, not a third party, and telling him what arrived
        // is the point of an assistant reading his mail, "what came in
        // overnight" is a summary that necessarily reuses the words of what came
        // in, so without this the feature is refused in its most ordinary use.
        // Deliberately narrow: his configured addresses only, never a domain or
        // a pattern, and a send to him AND anyone else is not exempt. Identity
        // comes from configuration and never from anything a message can
        // influence. This matches the daemon's email.send route, which had the
        // exemption while this path did not, the same defect class on two
        // surfaces, behaving differently.
        if (!isSendToOwnerOnly(to, resolveOwnerAddresses(guardedSources.configGet))) {
          const refused = await outwardAllowed(
            'email.send',
            `sending mail to ${to}`,
            { to, subject, body },
            {
              // Where the mail GOES: length thresholds are the wrong instrument
              // for a field whose whole value is the payload, so it is tested by
              // containment instead.
              exactMatchFields: ['to'],
              // A reply that quotes what it answers repeats it by design.
              stripQuotedFields: ['body'],
              signal: executionOptions?.signal,
            },
          );
          assertCurrent();
          if (refused !== null) return refused;
        }

        const card = await screenOutboundForCardMaterial({ surface: 'email', message: body, title: subject }, { signal: executionOptions?.signal, assertCurrent });
        assertCurrent(); if (card) throw new CardMaterialRefusedError(card);
        let result: Awaited<ReturnType<typeof client.sendMessage>>;
        try { result = await client.sendMessage({ to, subject, body }); assertCurrent(); }
        catch { return failure('The Gmail send request started, but its outcome could not be confirmed. Inspect sent mail before retrying.'); }
        if (isFailure(result)) return describeFailure(result);
        return ok(`Sent to ${to} (message ${result.value.id}).`);
      }

      if (action === 'calendar.list') {
        const result = await client.listEvents({
          timeMin: readString(args.timeMin) || undefined,
          timeMax: readString(args.timeMax) || undefined,
          maxResults: readNumber(args.maxResults, 10),
        });
        assertCurrent();
        if (isFailure(result)) return describeFailure(result);
        if (result.value.length === 0) return ok('No events in that range.');
        return ok(result.value.map((event) => `${event.start}  ${event.summary}${event.location ? ` (${event.location})` : ''}`).join('\n'));
      }

      const summaryText = readString(args.summary);
      const start = readString(args.start);
      const end = readString(args.end);
      if (!summaryText || !start || !end) {
        return failure('google action:"calendar.create" needs summary, start and end.');
      }
      if (!summary.canWriteCalendar) {
        return failure('The connected Google account was not granted a scope that permits writing to the calendar. Re-authorize with: /google reauthorize');
      }
      // An event's title, location and description are what a stranger's text
      // would have to reach in order to plant something on the owner's calendar
      //, an invite, a payment reminder, a link. They are enumerable, so they
      // are enumerated; the start and end times are not text and carry nothing.
      const refusedEvent = await outwardAllowed(
        'calendar.create',
        `creating the event "${summaryText}"`,
        {
          summary: summaryText,
          location: readString(args.location) || undefined,
          description: readString(args.description) || undefined,
        }, { signal: executionOptions?.signal },
      );
      assertCurrent();
      if (refusedEvent !== null) return refusedEvent;

      const card = await screenOutboundForCardMaterial({ surface: 'calendar', message: [readString(args.description), readString(args.location)].join('\n'), title: summaryText }, { signal: executionOptions?.signal, assertCurrent });
      assertCurrent(); if (card) throw new CardMaterialRefusedError(card);
      let created: Awaited<ReturnType<typeof client.createEvent>>;
      try { created = await client.createEvent({
        summary: summaryText,
        start,
        end,
        ...(readString(args.location) ? { location: readString(args.location) } : {}),
        ...(readString(args.description) ? { description: readString(args.description) } : {}),
      }); assertCurrent(); }
      catch { return failure('The Google Calendar write started, but its outcome could not be confirmed. Inspect the calendar before retrying.'); }
      if (isFailure(created)) return describeFailure(created);
      return ok(`Created "${created.value.summary}" starting ${created.value.start}.`);
    },
  };
  if (options.configManager && options.secretsManager) googleProjectors.set(tool, createGoogleSettingsProjector({ configManager: options.configManager, secretsManager: options.secretsManager }, () => pendingCredential));
  return tool;
}

const googleProjectors = new WeakMap<Tool, ReturnType<typeof createGoogleSettingsProjector>>();
export function agentGoogleInputProjector(tool: Tool) { return googleProjectors.get(tool); }
export function registerAgentGoogleTool(registry: ToolRegistry, options: AgentGoogleToolOptions): void {
  if (!registry.has('google')) {
    const tool = createAgentGoogleTool(options);
    registry.register(tool, { inputProjection: agentGoogleInputProjector(tool) });
  }
}
