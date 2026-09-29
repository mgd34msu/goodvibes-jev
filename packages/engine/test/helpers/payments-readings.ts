/**
 * A fake judgment port for the payments readings (merchant, recurring charge,
 * cart line, shipping tiers, approval and veto replies, order mail and its
 * facts, security-code reply), so tests of the sites that ask them run
 * without a model. Every other question goes to the security fake port
 * (content taint, card talk, link hosts), since the payments flow asks those
 * too.
 *
 * The default answers are stand-ins for what the model would say on the plain
 * cases tests use; they are not the rule the product follows, which is the
 * model's reading. A test that is about a specific answer overrides it.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { EntryType, JudgmentPort, JudgmentRequest, Question, Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { securityPort, type FakeVerdict, type SecurityAnswers } from './security-readings.ts';

type RecourseKind = 'retailer' | 'buyer-protection' | 'per-seller' | 'none';
type Candidate = { readonly id: string; readonly content: Record<string, unknown> };

export interface PaymentsAnswers extends SecurityAnswers {
  readonly merchant?: (domain: string) => { readonly qualifies: FakeVerdict; readonly recourse: RecourseKind; readonly unsure?: boolean };
  readonly recurring?: (orderSummary: string) => FakeVerdict;
  /** Which requested item (by index) a cart line is, or null. */
  readonly cartLine?: (cartLabel: string, requested: readonly string[]) => number | null;
  /** Which option (by index into what was offered) is the tier, null for none, or 'unsure' for a reading that does not act. */
  readonly shipping?: (tier: 'standard' | 'fast' | 'fastest', options: readonly { readonly label: string; readonly cost: number }[]) => number | null | 'unsure';
  readonly approvalReply?: (reply: string, notice: string) => 'approve' | 'deny' | 'unclear';
  readonly vetoReply?: (reply: string, notice: string) => 'acknowledge' | 'object' | 'unclear';
  readonly orderMail?: (mail: { readonly subject: string; readonly body: string }, purchase: { readonly item: string; readonly placed_at: string }) => FakeVerdict;
  /** Which candidate token is the order number or tracking reference, or null. */
  readonly identifier?: (kind: 'order-number' | 'tracking-reference', candidates: readonly { readonly token: string; readonly around: string }[]) => string | null;
  /** YYYY-MM-DD the mail says the order ships or arrives, or null. */
  readonly shipDate?: (body: string) => string | null;
  /** Sees the reply with its digits masked as `#`. */
  readonly securityCodeReply?: (masked: string) => FakeVerdict;
}

const APPROVE = new Set(['yes', 'y', 'ok', 'okay', 'approve', 'approved', 'go', 'buy it', 'go ahead']);
const DENY = new Set(['no', 'n', 'deny', 'denied', 'cancel', 'stop', "don't", 'dont']);
const ACK = new Set(['go', 'ok', 'okay', 'yes', 'y', 'approve', 'buy it', 'send it', 'go ahead']);
const OBJECT = new Set(['stop', 'no', 'n', 'cancel', 'wait', "don't", 'dont', 'hold']);
const said = (reply: string): string => reply.trim().toLowerCase().replace(/[.!?,]+$/, '');
const label = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const KNOWN: Readonly<Record<string, RecourseKind>> = {
  'bestbuy.com': 'retailer', 'microcenter.com': 'retailer', 'amazon.com': 'retailer', 'target.com': 'retailer',
  'walmart.com': 'retailer', 'redbubble.com': 'retailer', 'etsy.com': 'buyer-protection', 'ebay.com': 'per-seller',
};

export const DEFAULT_PAYMENTS_ANSWERS: Required<Omit<PaymentsAnswers, keyof SecurityAnswers>> = {
  merchant: (domain) => {
    const kind = KNOWN[domain];
    return kind === undefined ? { qualifies: false, recourse: 'none' } : { qualifies: true, recourse: kind };
  },
  recurring: (summary) => /subscri|recurring|auto-?renew|renews|per (month|year)|monthly|free trial|for future/i.test(summary),
  cartLine: (cart, requested) => {
    const index = requested.findIndex((entry) => label(entry) === label(cart));
    return index === -1 ? null : index;
  },
  shipping: (tier, options) => {
    const byCost = options.map((option, index) => ({ ...option, index })).sort((a, b) => a.cost - b.cost);
    if (tier === 'standard') return byCost[0]?.index ?? null;
    return byCost[byCost.length - 1]?.index ?? null;
  },
  approvalReply: (reply) => {
    const text = said(reply);
    const first = text.split(/\s+/)[0] ?? '';
    if (APPROVE.has(text) || APPROVE.has(first)) return 'approve';
    if (DENY.has(text) || DENY.has(first)) return 'deny';
    return 'unclear';
  },
  vetoReply: (reply) => {
    const text = said(reply);
    const first = text.split(/\s+/)[0] ?? '';
    if (ACK.has(text) || ACK.has(first)) return 'acknowledge';
    if (OBJECT.has(text) || OBJECT.has(first)) return 'object';
    return 'unclear';
  },
  orderMail: (mail, purchase) => `${mail.subject} ${mail.body}`.toLowerCase().includes(purchase.item.toLowerCase()),
  identifier: (kind, candidates) => {
    const word = kind === 'order-number' ? /order|confirmation/i : /track/i;
    return candidates.find((candidate) => {
      const before = candidate.around.slice(0, Math.max(0, candidate.around.indexOf(candidate.token)));
      return word.test(before.slice(-30)) && (kind === 'tracking-reference' || !/track/i.test(before.slice(-30)));
    })?.token ?? null;
  },
  shipDate: () => null,
  securityCodeReply: (masked) => /^\s*#{3,4}\s*$/.test(masked) || /(cvv|cvc|code|it'?s)\s*#{3,4}\b/i.test(masked),
};

const probability = (verdict: FakeVerdict): number => (verdict === 'unsure' ? 0.5 : verdict ? 0.97 : 0.03);

/** A selection's two question kinds: the pick over ids plus none, and the fit per candidate. */
function selectionAnswer(name: string, question: Question, candidates: readonly Candidate[], chosen: string | null, confidence = 0.95): unknown {
  if (name === 'pick') return choiceAnswer(question, chosen ?? 'none', confidence);
  const index = Number(name.slice('fits_'.length));
  return noulAnswer(candidates[index]?.id === chosen ? 0.97 : 0.03);
}

const DATE_NONE: Readonly<Record<string, string>> = { mode: 'none', month: 'none', day: 'none', year: 'none', day_anchor: 'none', weekday: 'none', week_offset: 'none' };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateAnswer(name: string, question: Question, date: string | null): unknown {
  if (date === null) return choiceAnswer(question, DATE_NONE[name] ?? 'none', 0.95);
  const [year, month, day] = date.split('-');
  const parts: Record<string, string> = {
    mode: 'absolute', month: MONTH_NAMES[Number(month) - 1]!, day: String(Number(day)), year: year!,
    day_anchor: 'none', weekday: 'none', week_offset: 'none',
  };
  return choiceAnswer(question, parts[name]!, 0.95);
}

/** A port answering the payments readings, and the security readings through `securityPort`. */
export function paymentsPort(overrides: PaymentsAnswers = {}): { port: JudgmentPort; requests: JudgmentRequest<Questions>[] } {
  const answers = { ...DEFAULT_PAYMENTS_ANSWERS, ...overrides };
  const security = securityPort(overrides);
  const requests: JudgmentRequest<Questions>[] = [];

  const answerFor = (battery: string, name: string, question: Question, state: EntryType): unknown => {
    const s = state as Record<string, unknown>;
    const candidates = (s['candidates'] ?? []) as readonly Candidate[];
    const context = (s['context'] ?? {}) as Record<string, unknown>;
    switch (battery) {
      case 'engine.payments.merchant': {
        const verdict = answers.merchant(String(s['registrable_domain']));
        if (name === 'qualifies') return noulAnswer(probability(verdict.unsure === true ? 'unsure' : verdict.qualifies));
        return choiceAnswer(question, verdict.recourse, verdict.unsure === true ? 0.5 : 0.95);
      }
      case 'engine.payments.recurring-charge':
        return noulAnswer(probability(answers.recurring(String(s['order_summary']))));
      case 'engine.payments.cart-line': {
        const requested = candidates.map((candidate) => String(candidate.content['requested_item']));
        const index = answers.cartLine(String(context['cart_line']), requested);
        return selectionAnswer(name, question, candidates, index === null ? null : candidates[index]!.id);
      }
      case 'engine.payments.shipping-standard':
      case 'engine.payments.shipping-fast':
      case 'engine.payments.shipping-fastest': {
        const tier = battery.slice('engine.payments.shipping-'.length) as 'standard' | 'fast' | 'fastest';
        const options = candidates.map((candidate) => ({ label: String(candidate.content['label']), cost: Number(candidate.content['cost_minor_units']) }));
        const index = answers.shipping(tier, options);
        if (index === 'unsure') return selectionAnswer(name, question, candidates, null, 0.4);
        return selectionAnswer(name, question, candidates, index === null ? null : candidates[index]!.id);
      }
      case 'engine.payments.approval-reply':
        return choiceAnswer(question, answers.approvalReply(String(s['reply']), String(s['proposal'])), 0.95);
      case 'engine.payments.veto-reply':
        return choiceAnswer(question, answers.vetoReply(String(s['reply']), String(s['proposal'])), 0.95);
      case 'engine.payments.order-mail': {
        const view = state as unknown as { mail: { subject: string; body: string }; purchase: { item: string; placed_at: string } };
        return noulAnswer(probability(answers.orderMail(view.mail, view.purchase)));
      }
      case 'engine.payments.order-number':
      case 'engine.payments.tracking-reference': {
        const kind = battery.slice('engine.payments.'.length) as 'order-number' | 'tracking-reference';
        const token = answers.identifier(kind, candidates.map((candidate) => candidate.content as { token: string; around: string }));
        const chosen = candidates.find((candidate) => candidate.content['token'] === token)?.id ?? null;
        return selectionAnswer(name, question, candidates, chosen);
      }
      case 'engine.payments.ship-date':
        return dateAnswer(name, question, answers.shipDate(String(state)));
      case 'engine.payments.security-code-reply':
        return noulAnswer(probability(answers.securityCodeReply(String(state))));
      default:
        throw new Error(`paymentsPort: no fake answer for ${battery} question "${name}"`);
    }
  };

  const port: JudgmentPort = {
    model: 'jev-1.13.0',
    async ask(request) {
      const battery = request.context?.battery ?? '';
      if (!battery.startsWith('engine.payments.')) {
        const result = await security.port.ask(request);
        requests.push(request as JudgmentRequest<Questions>);
        return result;
      }
      requests.push(request as JudgmentRequest<Questions>);
      const answered = Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => [name, answerFor(battery, name, question as Question, request.state)]),
      );
      return {
        answers: answered as never,
        requestedModel: request.model ?? 'jev-1.13.0',
        model: 'jev-1.13.0',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        requestId: undefined,
      };
    },
  };
  return { port, requests };
}

/**
 * Installs a payments port around every test in the calling file and puts the
 * previous port back afterwards. Returns the live request list.
 */
export function usePaymentsReadings(overrides: PaymentsAnswers = {}): { readonly requests: JudgmentRequest<Questions>[] } {
  const holder: { requests: JudgmentRequest<Questions>[] } = { requests: [] };
  let previous: JudgmentPort | undefined;
  beforeEach(() => {
    const fake = paymentsPort(overrides);
    holder.requests = fake.requests;
    previous = installJudgmentPort(fake.port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return {
    get requests() {
      return holder.requests;
    },
  };
}

/** Runs `body` with a payments port installed, for a test that needs its own answers. */
export async function withPaymentsReadings<T>(overrides: PaymentsAnswers, body: (requests: JudgmentRequest<Questions>[]) => Promise<T>): Promise<T> {
  const fake = paymentsPort(overrides);
  const previous = installJudgmentPort(fake.port);
  try {
    return await body(fake.requests);
  } finally {
    installJudgmentPort(previous);
  }
}
