/**
 * merchant-judge-model.ts, the judgement, read by Jev.
 *
 * ══ The last link in "determine if it is reputable" ═══════════════════════
 *
 * `merchant-recourse.ts` owns the policy and the composition rules; it does
 * not make the call. This is the call, and it is deliberately the smallest
 * module in the capability: one Jev reading over one domain
 * (`engine.payments.merchant`, batteries/merchant.ts), composed into a
 * verdict. It replaces a free-form prompt to the configured chat model and a
 * JSON parse of its answer, whose `confident` flag was the model's own claim
 * about itself; confidence is now the reading's band.
 *
 * ══ One field goes in, and that is the whole safety argument ══════════════
 *
 * The reading's state is `input.registrableDomain`, which code computed from
 * a URL that already passed `validateLinkTarget`, and nothing else. No page
 * title, no seller name, no review count, no product description, no trust
 * badge, nothing the merchant controls. Every one of those is free text
 * written by the party whose trustworthiness is the question, and a judgement
 * made over them is a judgement the attacker writes.
 *
 * There is a test asserting the port is called with the key set
 * `['registrableDomain']` and nothing more, so widening the input breaks a
 * test rather than quietly widening the attack surface.
 *
 * ══ How the two readings compose ══════════════════════════════════════════
 *
 * The judgement is confident only when both readings act. It qualifies only
 * when `qualifies` is a yes and the recourse kind names some recourse; a yes
 * with no recourse named is a contradiction and reads as not confident.
 * `classifyMerchant` turns anything not confident into an approval window
 * where silence denies: being unsure about a legitimate small retailer costs
 * the owner one question, and treating an unjudged domain as established
 * costs them a silent purchase from a storefront nobody vouched for.
 *
 * An empty domain is not asked about; there is nothing to read.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { merchantReading, merchantView, type RecourseKind } from './batteries/merchant.js';
import type { MarketplaceKind, MerchantJudgeInput, MerchantJudgePort, MerchantJudgement } from './merchant-recourse.js';

/** The decision site the merchant reading is logged under. */
export const MERCHANT_SITE = 'payments.merchant-judge';

/** What the owner reads for each recourse kind, on their phone, in plain words. */
const RECOURSE_PHRASES: Readonly<Record<RecourseKind, string>> = {
  retailer: 'an established retailer that stands behind its sales with a returns process',
  'buyer-protection': 'a marketplace whose buyer protection covers the purchase',
  'per-seller': 'a marketplace where recourse depends on the individual seller',
  none: 'no accountable business or buyer protection I can identify',
};

const MARKETPLACE_KINDS: Readonly<Record<RecourseKind, MarketplaceKind>> = {
  retailer: 'none',
  'buyer-protection': 'buyer-protection',
  'per-seller': 'per-seller',
  none: 'none',
};

/** Judge one validated registrable domain through the installed judgment port. */
export async function judgeMerchant(input: MerchantJudgeInput): Promise<MerchantJudgement> {
  const domain = input.registrableDomain.trim().toLowerCase();
  if (domain.length === 0) {
    return { qualifies: false, confident: false, recourse: 'I could not establish which domain this checkout is on' };
  }
  const run = await merchantReading.run(judgmentPort(MERCHANT_SITE), merchantView(domain), { site: MERCHANT_SITE });
  const { qualifies, recourse } = run.readings;
  const recourseKind = recourse.choice as RecourseKind;
  const bothAct = qualifies.outcome === 'act' && recourse.outcome === 'act';
  const contradiction = qualifies.verdict === 'yes' && recourseKind === 'none';
  const confident = bothAct && !contradiction;
  const judgement: MerchantJudgement = {
    qualifies: qualifies.verdict === 'yes' && recourseKind !== 'none',
    confident,
    recourse: RECOURSE_PHRASES[recourseKind],
    // The marketplace kind decides whether the owner's marketplace policy and
    // the per-seller listing bar apply, so it is taken only from a reading
    // that acts.
    ...(recourse.outcome === 'act' ? { marketplace: MARKETPLACE_KINDS[recourseKind] } : {}),
  };
  run.recordAction(confident ? (judgement.qualifies ? 'qualifies' : 'does not qualify') : 'not confident');
  return judgement;
}

/** The merchant judge port backed by the Jev reading. */
export function createJevMerchantJudge(): MerchantJudgePort {
  return { judge: judgeMerchant };
}
