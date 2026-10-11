import { inboundIntent } from './batteries/conversation-gate.js';
import { assertSynchronousCurrent, daemonReadingPort } from './reading-lifetime.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { CallOptions } from '@goodvibes-jev/judgment/decisions';
/**
 * The conversation-first spawn gate, at the shared surface spawn boundary.
 *
 * Every channel surface adapter converges on ONE construction site for its
 * adapter context (DaemonSurfaceActionHelper.buildSurfaceAdapterContext), and
 * this module is what that site installs in place of a bare spawn. Putting the
 * rule here rather than in an adapter is deliberate: a gate added to ntfy
 * alone would leave Telegram, Slack, and Home Assistant behaving exactly as
 * they did before.
 *
 * The rule: an inbound message gets a conversational reply. If it reads as a
 * work request, the gate PROPOSES a workstream over the channel it arrived on
 * and starts nothing. Agreement (daemon/work-proposal-reply.ts) is what starts
 * the work.
 *
 * Not gated:
 * - goodvibes-tui and other local surfaces, the operator typed it while
 *   sitting in front of the terminal. They never build a surface adapter
 *   context, so they never reach this module.
 * - Pre-authorized work, schedules, triggers, on-exit chains, an agreed
 *   proposal, and the explicit `retry <id>` control command. Those go through
 *   the raw trySpawnAgent, never this wrapper.
 * - Generic webhooks, machine automation, authorized at registration.
 */
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import {
  isGatedSurface,
  readConversationGateConfig,
  renderWorkProposalMessage,
  summarizeWorkRequest,
  type ConversationGateConfigReader,
} from '../agents/conversation-gate.js';
import type { WorkProposalRecord, WorkProposalStore } from '../agents/work-proposal-store.js';
import type { SurfaceNoticeDelivery } from './types.js';
import {
  conversationalTurnCapabilities,
  conversationalTurnConfigReaderFrom,
  conversationalTurnSpawnOptions,
} from '../personal-capture/spawn-contract.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * The identity of the inbound message currently being handled.
 *
 * The adapter context is built once per inbound message, so a cell holding
 * this is scoped to exactly that message. Every adapter runs its ingress
 * policy check before it spawns anything, which is what makes that check the
 * one place the originating channel is still known, by the time the spawn
 * call happens the adapter has thrown the identity away.
 */
export interface SurfaceIngressOrigin {
  readonly surface: string;
  readonly text?: string | undefined;
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly threadId?: string | undefined;
}

export type SpawnInput = Parameters<AgentManager['spawn']>[0];

export interface ConversationGateDeps {
  readonly readingOptions?: CallOptions | undefined;
  readonly captureReadingSource?: ((origin: SurfaceIngressOrigin | null) => () => void) | undefined;
  readonly configManager: ConversationGateConfigReader;
  readonly routeBindings: Pick<RouteBindingManager, 'getBinding' | 'resolve'>;
  readonly sessionBroker: Pick<SharedSessionBroker, 'getSession' | 'bindAgent'>;
  readonly trySpawnAgent: (input: SpawnInput, logLabel?: string, sessionId?: string) => AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: {
      readonly agentId: string;
      readonly task: string;
      readonly agentTask?: string | undefined;
      readonly contractId?: string | undefined;
      readonly sessionId?: string | undefined;
    },
  ) => void;
  readonly workProposals?: WorkProposalStore | undefined;
  readonly deliverSurfaceNotice?:
    | ((binding: AutomationRouteBinding | undefined, text: string) => Promise<SurfaceNoticeDelivery>)
    | undefined;
}

/**
 * Gate one surface spawn.
 *
 * A proposal is returned as a `Response`, which every adapter already
 * early-returns on, so no adapter needs gate-specific code and a new adapter
 * cannot forget to participate.
 */
export async function gateSurfaceSpawn(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin | null,
  input: SpawnInput,
  logLabel?: string,
  sessionId?: string,
): Promise<AgentRecord | Response> {
  const store = deps.workProposals;
  if (!store) return deps.trySpawnAgent(input, logLabel, sessionId);

  const config = readConversationGateConfig(deps.configManager);
  if (!isGatedSurface(config, origin?.surface)) {
    return deps.trySpawnAgent(input, logLabel, sessionId);
  }

  // Classify the message the OWNER sent, not the enriched prompt the broker
  // built from it, the enrichment adds framing that would read as work.
  const options = deps.readingOptions ?? {};
  const source = JSON.stringify(captureOwnedJson(origin));
  const sourceCurrent = deps.captureReadingSource?.(origin);
  const inputSource = JSON.stringify(captureOwnedJson(input));
  const configSource = JSON.stringify(config);
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    assertSynchronousCurrent(options.beforeAttempt);
    assertSynchronousCurrent(sourceCurrent);
    if (JSON.stringify(origin) !== source || JSON.stringify(input) !== inputSource
      || JSON.stringify(readConversationGateConfig(deps.configManager)) !== configSource) {
      throw new Error('Conversation gate source is no longer current');
    }
  };
  assertCurrent();
  const inboundText = snapshotJudgmentInput(origin?.text ?? input.task ?? '') as string;
  // Also screen the actual task before retaining it in a pending proposal.
  snapshotJudgmentInput(input.task);
  const result = await inboundIntent.read(daemonReadingPort('daemon.inbound-intent', assertCurrent, options.signal), null, inboundText, { ...options, beforeAttempt: assertCurrent });
  assertCurrent();
  if (result.reading.outcome !== 'act') {
    result.recordAction('held: inbound intent unsettled');
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-intent-unsettled' }, { status: 202 });
  }
  const needsAgreement = config.mode === 'confirm-all' || result.reading.choice === 'work';
  result.recordAction(needsAgreement ? 'propose-work' : 'conversational-response');
  assertCurrent();

  if (!needsAgreement) {
    // Conversation still gets a real reply, it just must not become a
    // contract. Keeping the spawn outside every contract is the difference
    // between answering "Testing" and planning and checking work against it.
    //
    // `replyStyle` carries the SAME decision through to the system prompt. The
    // gate had already classified this as conversation and then spawned an
    // agent still under instructions to file a completion report, so "Hey, are
    // you there?" was answered with a Summary/Changes/Decisions form. What the
    // message IS and what the reply should LOOK like are one decision, made
    // here, once.
    return deps.trySpawnAgent(
      {
        ...input,
        ...conversationalFirstTurnOptions(deps, origin, input.tools, sessionId),
        outsideContract: true,
        replyStyle: 'conversational',
      },
      logLabel,
      sessionId,
    );
  }

  const summary = summarizeWorkRequest(inboundText);
  const binding = resolveOriginBinding(deps, origin, sessionId);
  const proposal = store.create({
    surfaceKind: origin?.surface ?? 'unknown',
    task: input.task ?? inboundText ?? '',
    summary,
    ttlMs: config.proposalTtlMs,
    ...(binding?.surfaceId ? { surfaceId: binding.surfaceId } : {}),
    ...(binding?.id ? { routeId: binding.id } : {}),
    ...(binding?.externalId ? { externalId: binding.externalId } : {}),
    ...(origin?.threadId ? { threadId: origin.threadId } : {}),
    ...(origin?.channelId ? { channelId: origin.channelId } : {}),
    ...(origin?.userId ? { userId: origin.userId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });

  // A proposal becomes answerable only once its notice is confirmed on the
  // wire. Until then listPending excludes it, so a message arriving in the
  // meantime is treated as what it is rather than as an answer to something
  // the owner was never shown. Fails closed: any refusal drops the proposal.
  const delivery = await deliverProposalNotice(deps, binding, renderWorkProposalMessage({ summary, expiresInMs: config.proposalTtlMs }));
  try { assertCurrent(); }
  catch (error) { store.markUndeliverable(proposal.id, 'source-invalidated'); throw error; }
  if (!delivery.delivered) {
    store.markUndeliverable(proposal.id, delivery.reason);
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-proposal-undelivered' }, { status: 202 });
  }
  const delivered = store.markDelivered(proposal.id);
  if (!delivered || !store.listPending().includes(delivered)) {
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-proposal-expired' }, { status: 202 });
  }

  logger.info('Conversation gate proposed a workstream instead of starting one', {
    surface: origin?.surface ?? 'unknown',
    proposalId: proposal.id,
    reason: config.mode === 'confirm-all' ? 'confirm-all-mode' : 'jev-work-intent',
  });

  return Response.json({
    acknowledged: true,
    queued: false,
    outcome: 'work-proposed',
    proposalId: proposal.id,
    expiresAt: proposal.expiresAt,
    summary,
    ...(sessionId ? { sessionId } : {}),
  }, { status: 202 });
}

/** Bind the current ingress identity, never another route in the same session. */
function conversationalFirstTurnOptions(
  deps: Pick<ConversationGateDeps, 'configManager'>,
  origin: SurfaceIngressOrigin | null,
  tools: readonly string[] | undefined,
  sessionId: string | undefined,
): Partial<SpawnInput> {
  const channel = {
    routed: true,
    ...(origin?.surface ? { surfaceKind: origin.surface } : {}),
    ...(origin?.channelId ? { address: origin.channelId } : {}),
  };
  const options = { configReader: conversationalTurnConfigReaderFrom(deps.configManager), tools };
  // Even a sessionless or unidentified ingress gets an explicit bound authority;
  // the profile tool's local-owner default must not leak into a channel turn.
  return sessionId
    ? conversationalTurnSpawnOptions({ sessionId, surfaceKind: origin?.surface }, { ...options, channel })
    : conversationalTurnCapabilities(channel, options);
}

/**
 * The route binding for the channel a message arrived on. Prefers a binding
 * already attached to the session (the adapter just upserted it), then falls
 * back to resolving one from the surface identity.
 */
export function resolveOriginBinding(
  deps: Pick<ConversationGateDeps, 'routeBindings' | 'sessionBroker'>,
  origin: SurfaceIngressOrigin | null,
  sessionId?: string,
): AutomationRouteBinding | undefined {
  if (!origin) return undefined;
  if (sessionId) {
    const session = deps.sessionBroker.getSession(sessionId);
    for (const routeId of session?.routeIds ?? []) {
      const binding = deps.routeBindings.getBinding(routeId);
      if (binding?.surfaceKind === origin.surface
        && (binding.channelId ?? binding.externalId) === origin.channelId
        && binding.threadId === origin.threadId) return binding;
    }
  }
  if (!origin.channelId) return undefined;
  const resolved = deps.routeBindings.resolve(
    origin.surface as Parameters<RouteBindingManager['resolve']>[0],
    origin.channelId,
    origin.threadId,
  );
  return resolved?.surfaceKind === origin.surface
    && (resolved.channelId ?? resolved.externalId) === origin.channelId
    && resolved.threadId === origin.threadId ? resolved : undefined;
}

/**
 * Put the proposal on the owner's channel and report whether it got there.
 *
 * The result is the caller's business, not this function's: a proposal whose
 * notice never arrived must not stay answerable, because the owner has not
 * seen it and their NEXT message, whatever it is about, would otherwise be
 * matchable against it. Discarding this outcome is exactly the defect that
 * let an unseen proposal be "accepted".
 */
export async function deliverProposalNotice(
  deps: Pick<ConversationGateDeps, 'deliverSurfaceNotice'>,
  binding: AutomationRouteBinding | undefined,
  message: string,
): Promise<SurfaceNoticeDelivery> {
  const deliver = deps.deliverSurfaceNotice;
  if (!deliver) {
    logger.error('Conversation gate has no surface delivery function; the proposal cannot be shown', {
      surface: binding?.surfaceKind ?? null,
      routeId: binding?.id ?? null,
    });
    return { delivered: false, reason: 'no-deliverable-target' };
  }
  try {
    return await deliver(binding, message);
  } catch (error) {
    const summary = summarizeError(error);
    logger.error('Conversation gate could not deliver the proposal', {
      surface: binding?.surfaceKind ?? null,
      routeId: binding?.id ?? null,
      error: summary,
    });
    return { delivered: false, reason: 'delivery-failed', error: summary };
  }
}

/**
 * Start work the owner just agreed to. Goes through the RAW spawn path: the
 * agreement IS the authorization, so re-gating it here would ask twice.
 */
export async function startAgreedWork(
  deps: ConversationGateDeps,
  proposal: WorkProposalRecord,
  note?: string,
): Promise<void> {
  const task = note ? `${proposal.task}\n\nAdditional direction from the owner: ${note}` : proposal.task;
  const spawned = deps.trySpawnAgent({ mode: 'spawn', task }, 'ConversationGate.startAgreedWork', proposal.sessionId);
  const binding = proposal.routeId ? deps.routeBindings.getBinding(proposal.routeId) : undefined;
  if (spawned instanceof Response) {
    logger.warn('Agreed work could not be started', { proposalId: proposal.id, status: spawned.status });
    await deliverProposalNotice(deps, binding, `Could not start: ${proposal.summary}`);
    return;
  }
  if (proposal.sessionId) {
    await deps.sessionBroker.bindAgent(proposal.sessionId, spawned.id).catch((error: unknown) => {
      logger.warn('Agreed work session binding failed', { proposalId: proposal.id, error: summarizeError(error) });
    });
  }
  deps.queueSurfaceReplyFromBinding(binding, {
    agentId: spawned.id,
    task: proposal.summary,
    ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
    ...(typeof spawned.contractId === 'string' && spawned.contractId.length > 0 ? { contractId: spawned.contractId } : {}),
  });
}
