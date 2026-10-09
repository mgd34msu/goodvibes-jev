/**
 * /payments, enter the payment instrument and the two addresses at the
 * agent's own terminal.
 *
 * Mirrors the TUI's commands/payment-card-intake.ts deliberately: the owner
 * asked for payment entry on both surfaces ("and in the agent - basically ui
 * should expose it in both"), and two surfaces that ask for a card in two
 * different shapes is how one of them ends up with a weaker rule than the
 * other. Same subcommands, same field order, same concealed-input mechanism,
 * same daemon-scoped storage. What differs is only this surface's identity,
 * `agent-terminal` rather than `tui`, and the guided address flow below,
 * which this surface adds.
 *
 * ── Card material: masked, and stored where the daemon can read it ───────
 *
 * Card number, expiry, CVV and cardholder name are secret-tier (see
 * config/secret-config.ts's SECRET_CONFIG_KEYS). Each is entered through one
 * masked concealed-input prompt in turn and stored via
 * persistSecretBackedConfigValue: the raw value goes to the secret manager at
 * `scope: 'daemon'`, and only a `goodvibes://secrets/...` reference is written
 * to config. The plaintext never reaches the transcript, the input history
 * file, or a log line, only a redacted confirmation is printed after each
 * field.
 *
 * `scope: 'daemon'` is the whole point, not a detail. The DAEMON completes an
 * unattended purchase, and it does so with every surface closed, this program
 * not running at all. A card that only this process can resolve is the feature
 * not working. The config reference half lands in the daemon-owned tier for
 * the same reason: `payments.` is one of the SDK's DAEMON_OWNED_CONFIG_PREFIXES,
 * so ConfigManager routes it to the daemon's own settings file, visible to the
 * daemon, the TUI and the webui alike. See input/payments-config.ts.
 *
 * ── Addresses: real schema keys, entered in the clear, same command ──────
 *
 * `payments.billingAddress.*` and `payments.shippingAddress.*` are fourteen
 * real CONFIG_SCHEMA string keys. They are entered through a guided chain on
 * this same command (`/payments address billing`), and they are NOT masked. A
 * postal address is not a credential: it is printed on every parcel, it is
 * already visible in the settings modal, and masking it would teach the reflex
 * that bullets mean "safe to type anywhere", the opposite of what the card
 * fields need bullets to mean. They still land at daemon scope, by the same
 * `payments.` prefix rule, so the daemon has an address to ship to.
 *
 * ── Where card details may be typed at all ───────────────────────────────
 *
 * Gated on the SDK's own allowlist (platform/payments/entry-surface.ts), never
 * on a literal decided here. Card material may be TYPED only on `tui`,
 * `agent-terminal` or `webui`, never over Telegram, ntfy, Discord, Slack,
 * WhatsApp, Signal, a webhook, or any other remote messaging surface. A card
 * number typed into a hosted chat sits on that provider's servers, in history
 * this program cannot erase, and it passed through their infrastructure before
 * reaching us; encrypting it here afterwards does nothing for a value already
 * copied elsewhere.
 *
 * That is a SEPARATE question from which surfaces may APPROVE or VETO a
 * purchase, every command-authority channel still can, and the two checks are
 * never merged. See the SDK module's header.
 *
 * This command always runs in the agent's own composer, which the allowlist
 * accepts, so the gate changes nothing about today's behavior. What it buys is
 * that the refusal already exists the moment a shared command registry ever
 * grows a path that reaches `/payments card` from somewhere else: the check is
 * real and SDK-driven, not an implicit "this is a terminal so it's fine".
 */

import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import type { ConfigKey } from '../../config/index.ts';
import { describeCardEntryRefusal, mayOfferCardEntryFlow } from '@goodvibes-jev/engine/sdk/platform/payments';
import {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
  PAYMENTS_ADDRESS_FIELD_SUFFIXES,
  paymentsAddressConfigKey,
  type PaymentsAddressKind,
} from '../payments-config.ts';

/**
 * This surface's identity in the SDK's card-entry allowlist.
 *
 * `agent-terminal`, not `tui`: they are different surfaces with different
 * command registries, and naming this one honestly is what lets the allowlist
 * be the authority instead of each surface assuming it qualifies. Exported so
 * tests assert the real constant rather than a copy of the string.
 */
export const CARD_ENTRY_SURFACE = 'agent-terminal';

interface CardField {
  readonly key: ConfigKey;
  readonly label: string;
  readonly placeholder: string;
}

/** Order matters only for the guided prompt sequence, not for storage. */
const CARD_SECRET_FIELDS: readonly CardField[] = [
  { key: PAYMENTS_CARD_NUMBER_CONFIG_KEY, label: 'Card number', placeholder: '4242424242424242' },
  { key: PAYMENTS_CARD_EXPIRY_CONFIG_KEY, label: 'Expiry (MM/YY)', placeholder: '12/34' },
  { key: PAYMENTS_CARD_CVV_CONFIG_KEY, label: 'CVV', placeholder: '123' },
  { key: PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY, label: 'Cardholder name', placeholder: 'as printed on the card' },
];

interface AddressField {
  readonly key: ConfigKey;
  readonly label: string;
  readonly placeholder: string;
}

const ADDRESS_FIELD_LABELS: Readonly<Record<string, { label: string; placeholder: string }>> = {
  name: { label: 'Recipient name', placeholder: 'Jane Doe' },
  line1: { label: 'Address line 1', placeholder: '123 Main St' },
  line2: { label: 'Address line 2', placeholder: 'Apt 4B, blank if none' },
  city: { label: 'City', placeholder: 'Springfield' },
  region: { label: 'State / region', placeholder: 'IL' },
  postalCode: { label: 'Postal code', placeholder: '62704' },
  country: { label: 'Country', placeholder: 'US' },
};

function addressFields(kind: PaymentsAddressKind): readonly AddressField[] {
  return PAYMENTS_ADDRESS_FIELD_SUFFIXES.map((field) => {
    const meta = ADDRESS_FIELD_LABELS[field] ?? { label: field, placeholder: '' };
    return { key: paymentsAddressConfigKey(kind, field), label: meta.label, placeholder: meta.placeholder };
  });
}

function readConfigString(ctx: CommandContext, key: ConfigKey): string {
  try {
    const raw: unknown = ctx.platform.configManager.get(key);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function fieldConfigured(ctx: CommandContext, key: ConfigKey): boolean {
  return readConfigString(ctx, key).trim().length > 0;
}

/**
 * Status. Card fields report set/not set and NOTHING else, not a last-four,
 * not a masked form. There is no operator path that can return card material,
 * and a status line is not the place to invent one.
 *
 * Address fields DO show their values: they are ordinary config the settings
 * modal already displays, and a shipping address you cannot read back is a
 * shipping address you cannot check before a purchase goes out.
 */
function renderStatus(ctx: CommandContext): string[] {
  const lines = ['Payment card on file:'];
  for (const field of CARD_SECRET_FIELDS) {
    lines.push(`  ${field.label.padEnd(20)} ${fieldConfigured(ctx, field.key) ? 'set' : 'not set'}`);
  }
  for (const kind of ['billing', 'shipping'] as const) {
    lines.push('');
    lines.push(`${kind === 'billing' ? 'Billing' : 'Shipping'} address:`);
    for (const field of addressFields(kind)) {
      const value = readConfigString(ctx, field.key);
      lines.push(`  ${field.label.padEnd(20)} ${value.length > 0 ? value : '(not set)'}`);
    }
  }
  lines.push('');
  lines.push('Run /payments card to enter or replace the card (masked input, chained prompts).');
  lines.push('Run /payments address billing or /payments address shipping to enter an address (chained prompts, shown as typed).');
  lines.push('Budgets, windows, CVV handling and the rest of the payment capability are ordinary config values: set them via /config payments or the Settings > Payments category.');
  return lines;
}

/** Chain a masked prompt for each card secret field, storing each at daemon scope. */
function promptCardFields(ctx: CommandContext, fields: readonly CardField[], index: number): void {
  if (index >= fields.length) {
    ctx.print('\n[payments] Card stored. Run /payments address billing and /payments address shipping if those are not set yet.');
    ctx.renderRequest();
    return;
  }
  const field = fields[index]!;
  if (!ctx.beginConcealedInput) {
    ctx.print('[payments] Concealed input is unavailable on this surface; card entry requires it and cannot fall back to plaintext.');
    return;
  }
  ctx.print(`[payments] Enter ${field.label} (e.g. ${field.placeholder}), masked; Enter to store, Esc to stop.`);
  let cancelled = false;
  let finished = false;
  let submitted = false;
  ctx.beginConcealedInput({
    label: field.label,
    onSubmit: async (value) => {
      if (submitted || cancelled) return;
      submitted = true;
      if (value.length === 0) {
        finished = true;
        ctx.print(`[payments] ${field.label} left unset.`);
        promptCardFields(ctx, fields, index + 1);
        return;
      }
      try {
        await persistSecretBackedConfigValue(
          ctx.platform.configManager,
          ctx.platform.secretsManager,
          field.key,
          value,
          { scope: 'daemon' },
        );
        if (cancelled) return;
        ctx.print(`[payments] ${field.label} stored securely (hidden).`);
      } catch {
        if (cancelled) return;
        // Store failures may quote the input. Only the field label is safe.
        ctx.print(`[payments] Failed to store ${field.label}. Try again.`);
        finished = true;
        promptCardFields(ctx, fields, index);
        return;
      }
      finished = true;
      promptCardFields(ctx, fields, index + 1);
    },
    onCancel: () => {
      if (finished || cancelled) return;
      cancelled = true;
      ctx.print('[payments] Stopped. Re-run /payments card to finish the remaining fields.');
    },
  });
}

/**
 * Start the card-entry flow, gated on the SDK's own entry-surface allowlist
 * rather than an assumption baked into this command. `surface` defaults to this
 * command's real, fixed identity, exposed as a parameter only so tests can
 * drive the refusal path without this program actually being reachable from a
 * remote channel.
 */
export function startCardEntryFlow(ctx: CommandContext, surface: string = CARD_ENTRY_SURFACE): void {
  if (!mayOfferCardEntryFlow(surface)) {
    // The prompt is itself the harm: a surface that cannot accept the answer
    // must never ask the question. Note that nothing is offered here at all,
    // beginConcealedInput is not reached.
    ctx.print(describeCardEntryRefusal(surface));
    return;
  }
  if (!ctx.beginConcealedInput) {
    ctx.print('[payments] Concealed input is unavailable on this surface.');
    return;
  }
  ctx.print(`Entering ${CARD_SECRET_FIELDS.length} card field(s), masked; Esc to stop at any point.`);
  promptCardFields(ctx, CARD_SECRET_FIELDS, 0);
}

/**
 * Chain a plain (unmasked) prompt for each address field.
 *
 * Uses the composer's ordinary submit path via `awaitPlainLine` below rather
 * than the concealed one, see this file's header for why an address is
 * entered in the clear.
 */
function promptAddressFields(
  ctx: CommandContext,
  kind: PaymentsAddressKind,
  fields: readonly AddressField[],
  index: number,
): void {
  if (index >= fields.length) {
    ctx.print(`\n[payments] ${kind === 'billing' ? 'Billing' : 'Shipping'} address saved to the daemon-owned config tier.`);
    ctx.renderRequest();
    return;
  }
  const field = fields[index]!;
  const current = readConfigString(ctx, field.key);
  const currentNote = current.length > 0 ? ` [currently ${current}]` : '';
  ctx.print(`[payments] Enter ${field.label} (e.g. ${field.placeholder})${currentNote}, Enter to save, Esc to stop.`);
  awaitPlainLine(ctx, field, {
    onSubmit: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        ctx.print(`[payments] ${field.label} left as-is.`);
        promptAddressFields(ctx, kind, fields, index + 1);
        return;
      }
      try {
        ctx.platform.configManager.setDynamic(field.key, trimmed);
        ctx.print(`[payments] ${field.label} set to ${trimmed}.`);
      } catch (error: unknown) {
        ctx.print(`[payments] Failed to set ${field.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      promptAddressFields(ctx, kind, fields, index + 1);
    },
    onCancel: () => {
      ctx.print(`[payments] Stopped. Re-run /payments address ${kind} to finish the remaining fields.`);
    },
  });
}

/**
 * One line of ORDINARY composer entry, chained like the concealed flow.
 *
 * Goes through `beginPlainInput`, a genuinely separate composer slot from the
 * masked one, rather than a `conceal: false` flag on ConcealedInputRequest.
 * That flag is the obvious design and is rejected on purpose: a boolean
 * controlling whether a card number is echoed is one wrong default, one
 * refactor or one copied call site away from a PAN on screen, and whoever makes
 * that change will not have read this file first. The masked request type
 * therefore carries no masking flag at all, it is masked by its type. See
 * input/plain-line-input.ts.
 *
 * What this means in practice: address fields ARE echoed while being typed,
 * which is correct, they are ordinary config values, the same as typing them
 * through `/config`. Neither kind of guided answer is added to input history:
 * both are consumed by the composer's line-prompt route before the normal
 * submit path runs, so "62704" does not become a chat-recall entry.
 */
function awaitPlainLine(
  ctx: CommandContext,
  field: AddressField,
  handlers: { onSubmit: (value: string) => void; onCancel: () => void },
): void {
  if (!ctx.beginPlainInput) {
    // Name the real config KEY, not the human label, the label is not
    // something /config accepts, and a hint that does not work is worse than
    // no hint.
    ctx.print(`[payments] Guided entry is unavailable on this surface. Set it directly with /config, key ${field.key}.`);
    return;
  }
  ctx.beginPlainInput({ label: field.label, onSubmit: handlers.onSubmit, onCancel: handlers.onCancel });
}

/** Entry point for `/payments [card|address|status]`, exported so tests can drive it without the registry. */
export function runPaymentsCommand(args: readonly string[], ctx: CommandContext): void {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === '' || sub === 'status') {
    ctx.print(renderStatus(ctx).join('\n'));
    return;
  }
  if (sub === 'card') {
    startCardEntryFlow(ctx);
    return;
  }
  if (sub === 'address') {
    const kind = (args[1] ?? '').toLowerCase();
    if (kind !== 'billing' && kind !== 'shipping') {
      ctx.print('Usage: /payments address <billing|shipping>');
      return;
    }
    startAddressEntryFlow(ctx, kind);
    return;
  }
  ctx.print('Usage: /payments [card|address <billing|shipping>|status]');
}

/** Start the guided address flow for one of the two addresses. */
export function startAddressEntryFlow(ctx: CommandContext, kind: PaymentsAddressKind): void {
  const fields = addressFields(kind);
  ctx.print(`Entering ${fields.length} ${kind} address field(s), Esc to stop at any point. Blank keeps the current value.`);
  promptAddressFields(ctx, kind, fields, 0);
}

/** Card secret fields in prompt order, exported for tests that drive the chain field-by-field. */
export { CARD_SECRET_FIELDS, addressFields };

export function registerPaymentCardCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'payments',
    description: 'Payment card and billing/shipping address for daemon-initiated purchases (card entry is masked input)',
    usage: '/payments [card|address <billing|shipping>|status]',
    argsHint: '[card|address|status]',
    handler(args, ctx) {
      runPaymentsCommand(args, ctx);
    },
  });
}
