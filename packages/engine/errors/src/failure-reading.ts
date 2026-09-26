import {
  defineBattery,
  oneOf,
  STAKES_BANDS,
  yesNo,
  type ChoiceReading,
  type YesNoReading,
} from '@goodvibes-jev/judgment';
import type { DaemonErrorCategory } from './daemon-error-contract.js';
import { judgmentPort } from './judgment-port.js';

/**
 * What an error's wording says about the failure, read by Jev in place of the
 * regex phrase lists that used to guess it (types/errors.ts inferErrorCategory,
 * isBillingOrCreditError, isRateLimitOrQuotaError, isContextSizeExceededError,
 * isTransportFailureMessage, isNonTransientProviderFailure; utils/error-display.ts
 * inferCategory and inferSource; daemon-sdk error-response.ts inferCategory and
 * inferCategoryFromMessage). Status codes and structured error codes stay code;
 * only the meaning of the message text is read here.
 *
 * Every question is asked about one error in a single request. Retry, backoff
 * and failover choices are reversible and cheap to get wrong once, so the
 * bands are the low-stakes ones.
 */
const LOW = STAKES_BANDS.low;

/** The categories a message can put a failure in; the rest of DaemonErrorCategory comes only from structure. */
const CATEGORY_OPTIONS = {
  authentication: 'Credentials were missing, invalid or expired (API key, token, login)',
  authorization: 'The caller is known but not allowed: forbidden, access denied, no access to this model',
  billing: 'The account cannot pay: credit balance too low, credits or funds exhausted, payment required, plan quota spent',
  rate_limit: 'Too many requests or a temporary usage limit; waiting and retrying would succeed',
  timeout: 'The request or connection timed out or passed a deadline',
  network: 'The connection failed: refused, reset, host not found, DNS, TLS or certificate trouble, fetch failed',
  not_found: 'The model, endpoint or resource does not exist or is not supported',
  bad_request: 'The request itself was invalid: malformed input, bad argument, unsupported parameter, schema violation',
  protocol: 'The response was incomplete or unreadable: invalid JSON, stream ended early, no response body',
  service: 'The server failed or is overloaded or temporarily unavailable',
  unknown: 'None of these, or the message does not say',
} as const;

export type FailureCategory = keyof typeof CATEGORY_OPTIONS & DaemonErrorCategory;

export const failureReading = defineBattery({
  name: 'engine.failure-reading',
  version: 1,
  description: 'What an error message says about the failure: its category, and whether it is a spent account, a rate limit, an over-long context, a transient network fault, a provider that cannot serve, or a failure before any response.',
  accuracyFloor: 0.9,
  items: {
    category: oneOf('Which kind of failure does this error describe?', CATEGORY_OPTIONS, LOW.confidence),
    billing: yesNo('Does this error say the account cannot pay for the request, such as a credit balance too low, credits or funds exhausted, payment required, or a plan quota used up?', LOW.yesNo),
    rate_limited: yesNo('Does this error say requests are being rate limited or throttled, or that a usage quota or credits have run out?', LOW.yesNo),
    context_exceeded: yesNo('Does this error say the prompt, input or conversation is too long for the model\'s context window?', LOW.yesNo),
    transient_network: yesNo('Does this error describe a network or connection failure, such as a refused, reset or dropped connection, a DNS failure, a closed socket, or a network timeout?', LOW.yesNo),
    provider_unusable: yesNo('Does this error show the provider cannot serve requests as configured: credentials rejected, no credit, access denied, or the service cannot be reached at all?', LOW.yesNo),
    before_response: yesNo('Did the request fail before any response came back from the server, as a network or fetch failure does, rather than the server answering with an error?', LOW.yesNo),
  },
  fixtures: [
    {
      name: 'anthropic credit balance on a 400',
      state: 'HTTP status: 400\nMessage: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      expect: { category: 'billing', billing: 'yes', context_exceeded: 'no', transient_network: 'no', provider_unusable: 'yes', before_response: 'no' },
    },
    {
      name: 'openai insufficient_quota on a 429',
      state: 'HTTP status: 429\nMessage: You exceeded your current quota, please check your plan and billing details. insufficient_quota',
      expect: { category: 'billing', billing: 'yes', rate_limited: 'yes', transient_network: 'no' },
    },
    {
      name: 'per-minute rate limit',
      state: 'HTTP status: 429\nMessage: Rate limit reached for requests per minute. Please try again in 20s.',
      expect: { category: 'rate_limit', billing: 'no', rate_limited: 'yes', context_exceeded: 'no', provider_unusable: 'no', before_response: 'no' },
    },
    {
      name: 'anthropic prompt too long',
      state: 'HTTP status: 400\nMessage: prompt is too long: 210000 tokens > 200000 maximum',
      expect: { category: 'bad_request', billing: 'no', rate_limited: 'no', context_exceeded: 'yes', transient_network: 'no' },
    },
    {
      name: 'openai maximum context length',
      state: "Message: This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
      expect: { context_exceeded: 'yes', billing: 'no', provider_unusable: 'no' },
    },
    {
      name: 'fetch failed',
      state: 'Error type: TypeError\nMessage: fetch failed',
      expect: { category: 'network', transient_network: 'yes', before_response: 'yes', context_exceeded: 'no', billing: 'no' },
    },
    {
      name: 'socket hang up',
      state: 'Message: socket hang up',
      expect: { category: 'network', transient_network: 'yes', before_response: 'yes', rate_limited: 'no' },
    },
    {
      name: 'connection refused',
      state: 'Message: connect ECONNREFUSED 127.0.0.1:11434',
      expect: { category: 'network', transient_network: 'yes', provider_unusable: 'yes', before_response: 'yes' },
    },
    {
      name: 'invalid api key',
      state: 'HTTP status: 401\nMessage: Incorrect API key provided: sk-...abcd. You can find your API key at https://platform.openai.com/account/api-keys.',
      expect: { category: 'authentication', provider_unusable: 'yes', transient_network: 'no', billing: 'no', before_response: 'no' },
    },
    {
      name: 'no model access',
      state: 'HTTP status: 403\nMessage: Your organization does not have access to this model.',
      expect: { category: 'authorization', provider_unusable: 'yes', rate_limited: 'no' },
    },
    {
      name: 'unknown model',
      state: 'HTTP status: 404\nMessage: The model `gpt-9-turbo` does not exist or you do not have access to it.',
      expect: { category: 'not_found', transient_network: 'no', context_exceeded: 'no' },
    },
    {
      name: 'unsupported parameter',
      state: "HTTP status: 400\nMessage: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      expect: { category: 'bad_request', billing: 'no', context_exceeded: 'no', rate_limited: 'no' },
    },
    {
      name: 'truncated stream',
      state: 'Message: Unexpected end of JSON input while reading the response stream',
      expect: { category: 'protocol', billing: 'no', context_exceeded: 'no' },
    },
    {
      name: 'overloaded',
      state: 'HTTP status: 529\nMessage: Overloaded',
      expect: { category: 'service', billing: 'no', context_exceeded: 'no' },
    },
    {
      name: 'request timed out',
      state: 'Message: Request timed out after 60000ms',
      expect: { category: 'timeout', transient_network: 'yes', billing: 'no' },
    },
    {
      name: 'tool failure unrelated to transport',
      state: 'Message: File not writable: /etc/hosts is owned by root',
      expect: { transient_network: 'no', before_response: 'no', rate_limited: 'no', provider_unusable: 'no' },
    },
  ],
});

export type FailureQuestion = keyof typeof failureReading.items;

/** The error evidence a reading is about. Only text and fixed fields; no object graph. */
export interface FailureEvidence {
  readonly message: string;
  readonly status?: number | undefined;
  /** A structured code the error carries (an errno name, a provider error code). */
  readonly code?: string | undefined;
  /** The error's class name, e.g. TypeError. */
  readonly errorName?: string | undefined;
}

export interface FailureConclusions {
  /** The category the wording supports; 'unknown' unless the reading is strong enough to act on. */
  readonly category: FailureCategory;
  readonly billing: boolean;
  readonly rateLimited: boolean;
  readonly contextExceeded: boolean;
  readonly transientNetwork: boolean;
  readonly providerUnusable: boolean;
  readonly beforeResponse: boolean;
  readonly readings: {
    readonly category: ChoiceReading<FailureCategory>;
  } & { readonly [K in Exclude<FailureQuestion, 'category'>]: YesNoReading };
}

/** Long provider bodies say what they mean in their opening; the rest is request echo. */
const MAX_MESSAGE_CHARS = 2_000;

/** The state Jev reads: one labelled line per piece of evidence. */
export function failureState(evidence: FailureEvidence): string {
  const lines: string[] = [];
  if (evidence.status !== undefined) lines.push(`HTTP status: ${evidence.status}`);
  if (evidence.code !== undefined && evidence.code.length > 0) lines.push(`Error code: ${evidence.code}`);
  if (evidence.errorName !== undefined && evidence.errorName !== 'Error') lines.push(`Error type: ${evidence.errorName}`);
  lines.push(`Message: ${evidence.message.slice(0, MAX_MESSAGE_CHARS)}`);
  return lines.join('\n');
}

/** A yes/no conclusion code may act on without asking anyone: a yes strong enough to act. */
const holds = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';

/** Readings of the same error wording, so the retry and display paths of one failure ask once. */
const MEMO_LIMIT = 256;
const memo = new Map<string, Promise<FailureConclusions>>();

function remember(state: string, reading: Promise<FailureConclusions>): Promise<FailureConclusions> {
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  memo.set(state, reading);
  reading.catch(() => memo.delete(state));
  return reading;
}

/**
 * Reads what an error's wording says, asking every failure question in one
 * request. `site` names the decision site for the decision log.
 */
export function readFailure(evidence: FailureEvidence, site: string): Promise<FailureConclusions> {
  const state = failureState(evidence);
  const known = memo.get(state);
  if (known !== undefined) return known;
  return remember(state, (async () => {
    const run = await failureReading.run(judgmentPort(site), state, { site });
    const r = run.readings;
    const category = r.category.outcome === 'act' ? r.category.choice : 'unknown';
    return {
      category,
      billing: holds(r.billing),
      rateLimited: holds(r.rate_limited),
      contextExceeded: holds(r.context_exceeded),
      transientNetwork: holds(r.transient_network),
      providerUnusable: holds(r.provider_unusable),
      beforeResponse: holds(r.before_response),
      readings: r,
    };
  })());
}

/**
 * The category an HTTP status fixes on its own. 400 and 429 are provisional:
 * providers report a spent account under both (Anthropic a 400 "credit
 * balance is too low", OpenAI a 429 insufficient_quota), so the wording can
 * still turn them into billing.
 */
export function categoryForStatus(status: number | undefined): DaemonErrorCategory | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'bad_request';
  if (status >= 500) return 'service';
  return undefined;
}

/** Categories fixed by a structured errno code (an error's `code` field, or a message that is exactly the code). */
const CODE_CATEGORIES: ReadonlyMap<string, DaemonErrorCategory> = new Map([
  ['ECONNREFUSED', 'network'],
  ['ENOTFOUND', 'network'],
  ['EAI_AGAIN', 'network'],
  ['EHOSTUNREACH', 'network'],
  ['ECONNRESET', 'network'],
  ['ETIMEDOUT', 'timeout'],
  ['ECONNABORTED', 'timeout'],
]);

export function categoryForCode(code: string | undefined): DaemonErrorCategory | undefined {
  return code === undefined ? undefined : CODE_CATEGORIES.get(code.trim().toUpperCase());
}

/** A status's own category, which a billing reading may replace. */
const PROVISIONAL: Readonly<Record<number, DaemonErrorCategory>> = { 400: 'bad_request', 429: 'rate_limit' };

/**
 * Whether a category is the provisional one of a 400 or 429 from a provider.
 * Only a provider's 400 or 429 can be a spent account; the daemon's own
 * validation 400s mean exactly what their status says.
 */
function provisional(fixed: DaemonErrorCategory | undefined, status: number | undefined, fromProvider: boolean): boolean {
  return fromProvider && status !== undefined && PROVISIONAL[status] === fixed;
}

/**
 * Whether the wording can change the category: nothing structural fixes one,
 * or it is a provider's provisional 400 or 429.
 */
export function categoryDependsOnWording(
  fixed: DaemonErrorCategory | undefined,
  status: number | undefined,
  fromProvider: boolean,
): boolean {
  return fixed === undefined || fixed === 'unknown' || provisional(fixed, status, fromProvider);
}

/**
 * Settles a category from what structure fixed and what the wording says: a
 * billing reading turns a provider's provisional 400 or 429 into billing;
 * otherwise the structural category stands, and the reading fills in only
 * where structure says nothing.
 */
export function settleCategory(
  fixed: DaemonErrorCategory | undefined,
  status: number | undefined,
  fromProvider: boolean,
  failure: FailureConclusions | undefined,
): DaemonErrorCategory {
  if (failure?.billing === true && provisional(fixed, status, fromProvider)) return 'billing';
  if (fixed !== undefined && fixed !== 'unknown') return fixed;
  return failure?.category ?? 'unknown';
}

/** Forgets remembered readings; for tests that swap the judgment port. */
export function forgetFailureReadings(): void {
  memo.clear();
}
