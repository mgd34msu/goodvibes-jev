/**
 * payments-channel-guard.ts, card material never leaves this program toward a
 * remote messaging channel.
 *
 * ── What this app can and cannot enforce ────────────────────────────────
 *
 * This program is adopt-only: it never subscribes to a channel feed, polls a
 * bot's updates, or runs an inbox loop, and there is a regression guard that
 * fails the build if that ever changes (test/runtime/no-inbound-consumers.test.ts).
 * So an INBOUND Telegram message carrying a card number is not something this
 * process can intercept, that gate belongs to the daemon, which is the
 * process that actually receives it.
 *
 * What this process does own is the OUTBOUND funnel. Every channel send in the
 * agent goes through deliverAgentChannelMessage (agent/channel-delivery.ts),
 * and that is a real path by which card material could reach Telegram from
 * here: a model composing a message, a routine, or a person answering a prompt
 * in the wrong place. This module is the gate on that funnel.
 *
 * ── The rule ────────────────────────────────────────────────────────────
 *
 * Card details may be TYPED only on `tui`, `agent-terminal` or `webui`, an
 * SDK allowlist (platform/payments/entry-surface.ts), never a list restated
 * here. Anything else is refused. A card number sent to a hosted chat is
 * stored on that provider's servers in history nobody here can erase, and it
 * travelled through their infrastructure on the way; encrypting our copy
 * afterwards does not undo that.
 *
 * This says nothing about APPROVING a purchase. Every command-authority
 * channel, Telegram included, may still approve or veto. Answering a
 * question about money and entering the instrument are different axes and are
 * never merged into one check. See the SDK module's header.
 *
 * ── The refusal never quotes what it refused ────────────────────────────
 *
 * The refusal text comes from the SDK's describeCardEntryRefusal and is built
 * from the SURFACE NAME and the matched SHAPES only. It never contains, masks,
 * partially masks or summarizes the value. A masked echo is still an echo, and
 * a refusal that quoted the number would put it in the very place, the error
 * string, the log line, the outgoing reply, that this exists to keep it out
 * of. `matched` carries kinds ('card-number' | 'expiry' | 'cvv'), not text.
 */

import {
  evaluateCardEntry,
  isRemoteMessageSurface,
  mayEnterCardDetails,
} from '@goodvibes-jev/engine/sdk/platform/payments';

/** The shapes the SDK scanner reports. Never accompanied by the matching text. */
export type CardDetailShape = 'card-number' | 'expiry' | 'cvv';

export interface CardMaterialRefusal {
  /** The surface the send was aimed at, for the message and the audit line. */
  readonly surface: string;
  /** Which shapes matched. Kinds only, never the values. */
  readonly matched: readonly CardDetailShape[];
  /** The SDK's refusal wording. Contains no part of the refused text. */
  readonly reason: string;
}

/**
 * Thrown instead of delivering. Its `message` is the SDK refusal text, so
 * every layer that surfaces an error, the transcript, a log line, a tool
 * result handed back to a model, gets wording that is already safe to print.
 */
export class CardMaterialRefusedError extends Error {
  readonly surface: string;
  readonly matched: readonly CardDetailShape[];

  constructor(refusal: CardMaterialRefusal) {
    super(refusal.reason);
    this.name = 'CardMaterialRefusedError';
    this.surface = refusal.surface;
    this.matched = refusal.matched;
  }
}

/**
 * The surface name to check a delivery target against.
 *
 * A `surface` target names its own kind (telegram, slack, ntfy, ...). A
 * webhook or a link target has no surfaceKind, so its `kind` is used: a
 * webhook posts to somebody else's server, which is exactly the exposure the
 * rule is about.
 *
 * Falls back to 'unknown-channel' rather than to something permissive. The
 * allowlist is closed, so an unnameable target is refused for card-shaped
 * content, the correct direction to fail when the question is whether a card
 * number is about to leave the machine.
 */
export function resolveDeliverySurfaceName(target: {
  readonly kind?: string;
  readonly surfaceKind?: string;
}): string {
  const named = target.surfaceKind ?? (target.kind === 'surface' ? undefined : target.kind);
  const trimmed = named?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'unknown-channel';
}

/**
 * Screen an outbound message for card material.
 *
 * Returns null when the send may proceed, either because the destination is
 * an entry surface, or because nothing card-shaped is present. Returns a
 * refusal otherwise.
 *
 * Both the body and the title are scanned. A title is a message too, it is
 * rendered by every provider, and it would be an obvious hole to leave open.
 */
export async function screenOutboundForCardMaterial(input: {
  readonly surface: string;
  readonly message: string;
  readonly title?: string;
}): Promise<CardMaterialRefusal | null> {
  if (mayEnterCardDetails(input.surface)) return null;

  const parts = [input.message, input.title ?? ''];
  const matched = new Set<CardDetailShape>();
  let reason: string | null = null;

  for (const part of parts) {
    if (part.length === 0) continue;
    // The allowed:true branch is unreachable here, mayEnterCardDetails already
    // returned above for every surface that would produce it, so this reads
    // only `matched` and `reason`, which is what evaluateCardEntry yields for a
    // non-entry surface.
    //
    // expectingCvv is deliberately NOT set: a bare three-digit outbound message
    // is meaningless out of context, and refusing every "123" the agent ever
    // sends would make the channel unusable. A CVV typed as part of real card
    // entry arrives alongside a PAN or an expiry, which do match.
    const decision = await evaluateCardEntry({ surface: input.surface, text: part });
    for (const shape of decision.matched) matched.add(shape);
    if (decision.reason !== null) reason = decision.reason;
  }

  if (reason === null || matched.size === 0) return null;
  return { surface: input.surface, matched: [...matched], reason };
}

/**
 * Whether a card-entry PROMPT may be offered toward this destination.
 *
 * Separate from screening a message, because the prompt is itself the harm: a
 * surface that cannot accept the answer must never ask the question. Asking
 * "what is your card number?" over Telegram is an invitation to type it there,
 * and the invitation is what puts the number on someone else's server.
 * Refusing the answer afterwards is too late.
 */
export function mayOfferCardEntryOnDelivery(target: {
  readonly kind?: string;
  readonly surfaceKind?: string;
}): boolean {
  return mayEnterCardDetails(resolveDeliverySurfaceName(target));
}

/** Re-exported so callers name remote surfaces through the SDK, not a local list. */
export { isRemoteMessageSurface };
