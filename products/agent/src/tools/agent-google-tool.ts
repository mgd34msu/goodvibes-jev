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

import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import {
  beginGoogleConsent,
  openGoogleConnection,
  readClientCredentialsFromJson,
  registerGoogleClient,
  storeClientCredentials,
  summarizeCredentials,
  type GoogleClientRegistration,
  type GoogleConnection,
  type GoogleConnectionSources,
  type GoogleConsentSession,
  type GoogleLoopbackListenerFactory,
} from '@goodvibes-jev/engine/sdk/platform/google';
import { nodeGoogleFilePort } from '@goodvibes-jev/engine/sdk/platform/google/node';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/sdk/platform/google';
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
  'mail.list',
  'mail.read',
  'mail.send',
  'calendar.list',
  'calendar.create',
  'mail.verification',
] as const;

/** Actions that only read. Everything else is an outward effect. */
const READ_ONLY_ACTIONS = new Set<string>(['status', 'mail.list', 'mail.read', 'calendar.list', 'mail.verification']);

/**
 * Actions that register a credential the owner just handed over.
 *
 * Exempt from the confirm:true gate, and the reasoning matters. That gate
 * guards things that leave this machine, a mail send, a calendar write,
 * where content read this turn could have steered the model into acting. A
 * credential write is neither: the values came from the owner's own message in
 * this turn, they go into the local encrypted store, and nothing is
 * transmitted. Asking him to confirm values he just pasted is the second
 * question the zero-friction rule exists to delete, and outward-action
 * approval framing does not apply to a local write of what he typed.
 *
 * They run BEFORE the connection is opened, because their entire purpose is to
 * exist on a machine that has no connection yet.
 */
const CONNECT_ACTIONS = new Set<string>(['connect.client', 'connect.clientFile']);

export interface AgentGoogleToolOptions {
  readonly homeDirectory: string;
  readonly configGet: (key: string) => unknown;
  readonly secretGet: (key: string) => Promise<string | null>;
  /** Injected in tests; production uses the process fetch. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Config and secret WRITES, for registering a client the owner pasted.
   *
   * Absent means this surface cannot complete a connection, and
   * `connect.client` says exactly that rather than reporting a success it did
   * not perform. Optional so narrow compositions and read-only tests can build
   * the tool without a writable store.
   */
  readonly configSet?: ((key: string, value: unknown) => void) | undefined;
  readonly secretSet?: ((key: string, value: string) => Promise<void>) | undefined;
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
  'and when they paste the client id and secret call connect.client to register them and hand back the consent link.',
  'Never tell them to run a command.',
].join(' ');

export function createAgentGoogleTool(options: AgentGoogleToolOptions): Tool {
  const sources: GoogleConnectionSources = {
    files: nodeGoogleFilePort,
    homeDirectory: options.homeDirectory,
    configGet: options.configGet,
    secretGet: options.secretGet,
  };
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const fetchPort = { fetch: fetchImpl };

  /** Opened per call: credentials can be connected mid-session. */
  async function connect(): Promise<GoogleConnection | null> {
    return openGoogleConnection(sources, { fetch: fetchPort });
  }

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
      // The `google` tool only ever runs inside a turn the owner started,
      // it is not reachable from a schedule or a channel, so a refusal here
      // must not tell him to go and ask the owner. He is the owner and he
      // already asked.
      requestedBy: 'owner-direct',
      ...(options.approvals === undefined
        ? {}
        : {
          ownerRemedy: {
            gesture: options.approvalGesture
              ?? 'answer the approval prompt this raises, which asks about this exact message.',
          },
        }),
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
    return failure(`${decision.reason} ${decision.fix}`);
  }

  /**
   * The owner's own addresses, from configuration only.
   *
   * Read per call because he can connect a mailbox mid-session. Never from a
   * header, a sender, or anything else a message can influence, see the SDK's
   * security/owner-identity.ts for what an attacker would have to control.
   */
  function ownerAddresses(): ReadonlySet<string> {
    return resolveOwnerAddresses(options.configGet);
  }


  /**
   * The consent in flight, if one is.
   *
   * Held so a second `connect.client` in the same session releases the first
   * listener rather than leaving a bound port behind. One connection at a time
   * is the only sensible reading anyway: a second paste replaces the first.
   */
  let pendingConsent: GoogleConsentSession | null = null;

  /** Registration + the consent link, in one answer. */
  async function registerClient(action: string, rawArgs: Record<string, unknown>): Promise<ToolOutput> {
    const configSet = options.configSet;
    const secretSet = options.secretSet;
    const loopback = options.loopback;
    if (configSet === undefined || secretSet === undefined || loopback === undefined) {
      // A surface with no writable store says so rather than reporting a
      // success it did not perform, the same rule the approval path follows.
      return failure(
        'This surface cannot register a Google client: it was built without a writable credential store. '
        + 'The values you pasted were not stored anywhere.',
      );
    }

    const config = { get: options.configGet, set: configSet };
    const secrets = { get: options.secretGet, set: secretSet };

    let registration: GoogleClientRegistration;
    if (action === 'connect.clientFile') {
      const path = readString(rawArgs.path);
      if (!path) return failure('google action:"connect.clientFile" needs the path the user named.');
      const raw = nodeGoogleFilePort.readText(path);
      if (raw === null) return failure(`There is no readable file at ${path}. Check the path and tell me the right one.`);
      const parsed = readClientCredentialsFromJson(raw);
      if (!parsed.ok) return failure(`${parsed.problem} ${parsed.fix}`);
      registration = await storeClientCredentials({ config, secrets }, parsed.credentials);
    } else {
      const clientId = readString(rawArgs.clientId);
      const clientSecret = readString(rawArgs.clientSecret);
      if (!clientId || !clientSecret) {
        return failure('google action:"connect.client" needs both clientId and clientSecret, as the user pasted them.');
      }
      const result = await registerGoogleClient({ config, secrets }, { clientId, clientSecret });
      if (!result.ok) return failure(`${result.problem} ${result.fix}`);
      registration = result;
    }

    // Continue the flow rather than stopping at "registered". Stopping here is
    // what produced the instruction to go and run another command.
    const storedClientId = readString(options.configGet(GOOGLE_CONFIG_KEYS.oauthClientId));
    const storedSecret = await options.secretGet(GOOGLE_SECRET_KEYS.oauthClientSecret);
    if (!storedClientId || !storedSecret) {
      return failure('The client was written but could not be read back, so no consent link was started.');
    }

    pendingConsent?.cancel();
    const loginHint = readString(options.configGet('email.username'))
      || readString(options.configGet('email.fromAddress'));
    const session = beginGoogleConsent({
      clientId: storedClientId,
      clientSecret: storedSecret,
      config,
      secrets,
      loopback,
      fetchPort,
      ...(loginHint ? { loginHint } : {}),
    });
    pendingConsent = session;
    // The exchange finishes whenever the person approves. Nothing awaits it
    // here: this answer is due now, and a turn that blocked for the length of
    // a consent screen would look broken.
    void session.completed.then((outcome) => {
      if (session === pendingConsent) pendingConsent = null;
      return outcome;
    });

    return ok([
      `Registered the OAuth client ending ${registration.clientIdTail}. The secret went straight into the encrypted store and is not shown again.`,
      '',
      'Open this link and approve it, it asks for mail and calendar together, so one approval covers both:',
      session.consentUrl,
      '',
      ...(loginHint ? [`Approve as ${loginHint}, not a personal account.`] : []),
      'Google will warn that the app is unverified; that is expected for a client you created yourself. Once you approve, the credential lands here on its own.',
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n'));
  }

  return {
    definition: {
      name: 'google',
      description:
        'Read and send Gmail; read and write Google Calendar. '
        + 'When the user pastes a Google OAuth client id and secret, call connect.client with them, that is the '
        + 'continuation of the setup walkthrough, and it returns the consent link to hand back. When they name a path '
        + 'to a client JSON, call connect.clientFile.',
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
          clientSecret: { type: 'string', description: 'Pasted client secret for connect.client; stored encrypted, never echoed.' },
          path: { type: 'string', description: 'Path to an OAuth client JSON the user named, for connect.clientFile.' },
          confirm: { type: 'boolean', description: 'Required true for mail.send and calendar.create.' },
        },
        required: ['action'],
      },
    },
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolOutput> => {
      const requested = readString(rawArgs.action);
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
      if (CONNECT_ACTIONS.has(action)) return await registerClient(action, rawArgs);

      const connection = await connect();
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

      // Confirmation is required before anything leaves this machine.
      if (!READ_ONLY_ACTIONS.has(action) && rawArgs.confirm !== true) {
        return failure(`google action:"${action}" changes something outside this machine. Re-issue it with confirm:true once the user has asked for it.`);
      }

      if (action === 'mail.list') {
        const result = await client.listMessages({
          query: readString(rawArgs.query) || undefined,
          maxResults: readNumber(rawArgs.maxResults, 10),
        });
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
        const id = readString(rawArgs.id);
        if (!id) return failure('google action:"mail.read" needs the message id, from mail.list.');
        const result = await client.getMessage(id);
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
        const id = readString(rawArgs.id);
        if (!id) return failure('google action:"mail.verification" needs the message id, from mail.list.');
        const result = await client.getMessage(id);
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
        const to = readString(rawArgs.to);
        const subject = readString(rawArgs.subject);
        const body = readString(rawArgs.body);
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
        if (!isSendToOwnerOnly(to, ownerAddresses())) {
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
            },
          );
          if (refused !== null) return refused;
        }

        const result = await client.sendMessage({ to, subject, body });
        if (isFailure(result)) return describeFailure(result);
        return ok(`Sent to ${to} (message ${result.value.id}).`);
      }

      if (action === 'calendar.list') {
        const result = await client.listEvents({
          timeMin: readString(rawArgs.timeMin) || undefined,
          timeMax: readString(rawArgs.timeMax) || undefined,
          maxResults: readNumber(rawArgs.maxResults, 10),
        });
        if (isFailure(result)) return describeFailure(result);
        if (result.value.length === 0) return ok('No events in that range.');
        return ok(result.value.map((event) => `${event.start}  ${event.summary}${event.location ? ` (${event.location})` : ''}`).join('\n'));
      }

      const summaryText = readString(rawArgs.summary);
      const start = readString(rawArgs.start);
      const end = readString(rawArgs.end);
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
          location: readString(rawArgs.location) || undefined,
          description: readString(rawArgs.description) || undefined,
        },
      );
      if (refusedEvent !== null) return refusedEvent;

      const created = await client.createEvent({
        summary: summaryText,
        start,
        end,
        ...(readString(rawArgs.location) ? { location: readString(rawArgs.location) } : {}),
        ...(readString(rawArgs.description) ? { description: readString(rawArgs.description) } : {}),
      });
      if (isFailure(created)) return describeFailure(created);
      return ok(`Created "${created.value.summary}" starting ${created.value.start}.`);
    },
  };
}

export function registerAgentGoogleTool(registry: ToolRegistry, options: AgentGoogleToolOptions): void {
  if (!registry.has('google')) registry.register(createAgentGoogleTool(options));
}
