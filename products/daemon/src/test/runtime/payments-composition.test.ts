import { expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { GatewayMethodCatalog, type GatewayMethodInvocation } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { ATTACHED_PAYMENTS_METHOD_IDS, CardMaterialRedactor, PaymentReplyInboxClosedError, type CheckoutPageDriver } from '@goodvibes-jev/engine/sdk/platform/payments';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createPaymentsServices } from '../../runtime/payments-composition.js';
import { createBrowserCheckoutSeamHolder } from '../../runtime/browser-checkout-seam-holder.js';
import { createShellPathService } from '../../runtime/index.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture(catalog = new GatewayMethodCatalog()) {
  const root = makeOwnedTempDir('daemon-payments');
  const values: Record<string, unknown> = { 'payments.enabled': true, 'payments.budget.dailyItem': 100, 'payments.budget.dailyOverage': 100, 'payments.budget.perPurchaseCeiling': 100, 'payments.notifyChannels': 'telegram', 'payments.cvvHandling': 'stored' };
  for (const [key, value] of Object.entries({ name: 'Fixture owner', line1: '1 Fixture Street', city: 'Fixture City', region: 'TS', postalCode: '00000', country: 'US' })) values[`payments.shippingAddress.${key}`] = value;
  const secrets = new Map<string, string>();
  const scopes: unknown[] = [];
  const deliveries: unknown[] = [];
  const browser = createBrowserCheckoutSeamHolder();
  let leader = true;
  const options = {
    configManager: { get: (key: string) => values[key] } as Pick<ConfigManager, 'get'>,
    shellPaths: createShellPathService({ workingDirectory: join(root, 'workspace'), homeDirectory: join(root, 'home') }),
    secretsManager: {
      async get(key: string) { return secrets.get(key) ?? null; },
      async set(key: string, value: string, options?: unknown) { scopes.push(options); secrets.set(key, value); },
      async delete(key: string) { secrets.delete(key); },
    },
    gatewayMethods: catalog, isPaymentsLeader: () => leader, checkoutSeam: browser.get,
    channelDeliveryRouter: { async deliver(request: unknown) { deliveries.push(request); return 'fixture-notice'; } },
  };
  const services = createPaymentsServices(options);
  return { root, values, scopes, deliveries, browser, catalog, options, services, setLeader(value: boolean) { leader = value; } };
}

function invoke(catalog: GatewayMethodCatalog, id: string, body: unknown = {}) {
  return catalog.invoke(id, { context: { principalId: 'fixture-owner', metadata: { explicitUserRequest: true } }, body } satisfies GatewayMethodInvocation) as Promise<Record<string, unknown>>;
}

test('real product payments register on the existing catalog and read live owner limits/leadership', async () => {
  const f = fixture();
  try {
    await f.services.ready;
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(true);
    expect(await invoke(f.catalog, 'payments.cards.list')).toMatchObject({ cards: [] });
    expect(await invoke(f.catalog, 'payments.budget.status')).toMatchObject({ isPaymentsLeader: true });
    f.setLeader(false);
    expect(await invoke(f.catalog, 'payments.budget.status')).toMatchObject({ isPaymentsLeader: false });
    f.values['payments.budget.dailyItem'] = 321;
    expect(JSON.stringify(await invoke(f.catalog, 'payments.budget.status'))).toContain('32100');
    expect(f.deliveries).toEqual([]);
    expect(f.scopes).toEqual([]);
  } finally { await f.services.close(); }
  for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
});

test('closing before registration settles cannot leave handlers or an answerable window behind', async () => {
  const f = fixture();
  const waiting = f.services.paymentReplies.waitForAnswer({ kind: 'veto', channels: ['telegram'], notice: 'fixture', deadlineMs: Date.now() + 60_000 });
  const closing = f.services.close();
  expect(f.services.close()).toBe(closing);
  await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  await closing;
  for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
  // Reusing the catalog is safe only after the old close has finished.
  const replacement = createPaymentsServices(f.options);
  try {
    await replacement.ready;
    f.services.unregister();
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(true);
    expect(replacement.paymentReplies).not.toBe(f.services.paymentReplies);
  } finally { await replacement.close(); }
});

/** Fixed fixture readings, no inference or external model calls in a unit test. */
function fixturePort(): NonNullable<Parameters<typeof installJudgmentPort>[0]> {
  return {
    model: 'jev-1.13.0',
    async ask(request) {
      const battery = request.context?.battery;
      const allowed = ['engine.security.link-host', 'engine.payments.merchant', 'engine.payments.cart-line', 'engine.payments.recurring-charge', 'engine.payments.shipping-standard', 'engine.payments.shipping-fast', 'engine.payments.shipping-fastest', 'engine.payments.veto-reply'];
      if (!allowed.includes(battery ?? '')) throw new Error(`Unexpected fixture reading: ${battery}`);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        if (question.type === 'noul') return [name, { type: 'noul', noul: ['qualifies', 'fits_0'].includes(name) ? 0.999 : 0.001 }];
        if (question.type !== 'choice') throw new Error('Unexpected fixture question');
        const state = request.state as { candidates?: readonly { id: string }[] };
        const chosen = name === 'recourse' ? 'retailer' : name === 'pick' ? state.candidates?.[0]?.id : 'object';
        if (!chosen || !(chosen in question.criteria)) throw new Error('Unexpected fixture choice');
        return [name, { type: 'choice', choice: chosen, confidence: 0.999, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === chosen ? 0.999 : 0.001 / (Object.keys(question.criteria).length - 1)])) }];
      }));
      return { answers: answers as never, model: 'jev-1.13.0', requestedModel: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0, requestId: undefined };
    },
  };
}

test('the composed notifier waits on the returned ingress inbox and owner veto stops actual gateway checkout', async () => {
  const f = fixture();
  const previous = installJudgmentPort(fixturePort());
  const outward: string[] = [];
  const driver: CheckoutPageDriver = {
    identity: () => ({ sessionId: 'fixture-session', pageId: 'fixture-page' }),
    async url() { return 'https://www.bestbuy.com/checkout'; },
    async fill() { outward.push('fill'); }, async choose() { outward.push('choose'); },
    async fillSecrets() { outward.push('fill-secrets'); return { filledTargets: [], failedTarget: null }; },
    async submitOrder() { outward.push('submit'); return { url: 'https://www.bestbuy.com/done', orderId: null, verified: false }; },
  };
  f.browser.set({ cardFieldGuard: new CardMaterialRedactor(), driverFor: () => driver, armSubmitApproval: async () => {} });
  let opened!: () => void;
  const window = new Promise<void>((resolve) => { opened = resolve; });
  const originalWait = f.services.paymentReplies.waitForAnswer.bind(f.services.paymentReplies);
  const wait = spyOn(f.services.paymentReplies, 'waitForAnswer').mockImplementation((input) => { const pending = originalWait(input); opened(); return pending; });
  try {
    await f.services.ready;
    const card = await f.services.cards.create({ label: 'Fixture-only card', kind: 'virtual', number: '4111111111111111', expiryMonth: 1, expiryYear: 2030, cvv: '123', cardholderName: 'Fixture owner', issuerCapMinorUnits: null });
    expect(f.scopes.every((scope) => JSON.stringify(scope) === JSON.stringify({ scope: 'daemon', medium: 'secure' }))).toBe(true);
    const metadataPath = join(f.root, 'home', '.goodvibes', 'tui', 'control-plane', 'payments-cards.json');
    expect(existsSync(metadataPath)).toBe(true);
    expect(readFileSync(metadataPath, 'utf8')).not.toContain('4111111111111111');
    const identity = { merchantDomain: 'bestbuy.com', item: 'Fixture item' };
    await invoke(f.catalog, 'payments.checkout.approve', { ...identity, amount: '11.00', confirm: true });
    const purchase = invoke(f.catalog, 'payments.checkout.begin', {
      ...identity, requestedMax: '11.00', sessionId: 'fixture-session', pageId: 'fixture-page', checkoutUrl: 'https://www.bestbuy.com/checkout', cardId: card.id,
      requestedLines: [{ label: 'Fixture item', quantity: 1 }], lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }],
      shippingOptions: [{ label: 'Standard', cost: '$0.00' }], cardFields: [{ field: 'number', ref: 'fixture-card' }], placeOrderTarget: 'fixture-submit',
    });
    void purchase.catch(() => {});
    await Promise.race([window, purchase.then((result) => { throw new Error(`Checkout never opened a reply window: ${JSON.stringify(result)}`); })]);
    expect(f.services.paymentReplies.pending).toBe(1);
    expect(f.deliveries).toHaveLength(1);
    expect(await f.services.paymentReplies.offer('telegram', 'stop')).toEqual({ consumed: true, answer: 'object' });
    expect(await purchase).toMatchObject({ outcome: 'cancelled' });
    expect(outward).toEqual([]);
  } finally {
    wait.mockRestore();
    await f.services.close();
    installJudgmentPort(previous);
  }
});


test('legacy unregister reports cleanup failure while awaited close retains the same rejection', async () => {
  const f = fixture();
  await f.services.ready;
  const warnings: unknown[] = [];
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  const register = spyOn(f.catalog, 'register').mockImplementation(() => { throw new Error('fixture-sensitive-path'); });
  try {
    f.services.unregister();
    await expect(f.services.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(f.services.close()).rejects.toThrow('Payment composition did not close cleanly');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('fixture-sensitive-path');
    await expect(f.services.paymentReplies.waitForAnswer({ kind: 'veto', channels: ['telegram'], notice: 'fixture', deadlineMs: Date.now() + 1000 })).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  } finally {
    register.mockRestore();
    warn.mockRestore();
  }
});
