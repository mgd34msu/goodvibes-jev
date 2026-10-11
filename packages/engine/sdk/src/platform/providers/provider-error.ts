/**
 * Shared provider-error helpers.
 *
 * Consolidated from three verbatim copies in lm-studio-helpers.ts,
 * llama-cpp.ts, and ollama.ts into a single definition.
 */

import { captureJudgmentPort, categoryForCode, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { captureNormalizationSource, readNormalizedError, toProviderError } from '../utils/error-display.js';
import type { ProviderError } from '../types/errors.js';
import { readsAsAlternateApi } from '../routing/provider-readings.js';
import { JudgmentInputError } from '../gate/judgment-input.js';

/**
 * Extract an HTTP status code from an error object.
 * Checks `.status` before `.statusCode` to preserve provider-error convention.
 */
export function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.statusCode === 'number') return record.statusCode;
  }
  return undefined;
}

/**
 * Wrap an error into a ProviderError, attaching the HTTP status if present.
 */
export function normalizeProviderError(
  err: unknown,
  provider: string,
  operation: string,
  phase = 'request',
): ProviderError {
  const status = getErrorStatus(err);
  return toProviderError(err, {
    ...(status !== undefined ? { statusCode: status } : {}),
    provider,
    operation,
    phase,
  });
}

/** Statuses that say the endpoint itself is missing or refuses the method: the other API decides on its own. */
const OTHER_API_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

/**
 * Whether a local server's failure on one of its APIs means the same request
 * should go through its other API (Ollama native chat or OpenAI-compatible;
 * LM Studio native, responses or OpenAI-compatible). A missing endpoint's
 * status decides in code, as does a connection errno, which no other API on
 * the same server would fix; the wording of anything else is read by
 * routing.alternate-api.
 */
export async function shouldUseOtherApi(err: unknown, site: string, options: JudgmentReadingOptions = {}): Promise<boolean> {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const prototype: unknown = Object.getPrototypeOf(options);
  if (typeof site !== 'string' || !site.trim() || (prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(options).length || Object.values(descriptors).some((field) => !('value' in field)))
    throw new JudgmentInputError('unsupported-input');
  const sourceCurrent = captureNormalizationSource(err, options);
  sourceCurrent();
  const status = getErrorStatus(err);
  if (status !== undefined && OTHER_API_STATUSES.has(status)) { sourceCurrent(); return true; }
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
  if (categoryForCode(code) !== undefined) { sourceCurrent(); return false; }
  sourceCurrent();
  const owner = captureJudgmentPort(site, { ...options, assertCurrent: sourceCurrent });
  owner.assertCurrent();
  const normalized = await readNormalizedError(err, { ...options, site, source: 'provider', signal: owner.signal,
    assertCurrent: owner.assertCurrent });
  owner.assertCurrent();
  const message = normalized.message;
  if (!message.trim() || message === '[REDACTED]') return false;
  const result = await readsAsAlternateApi({ status, message }, site, { ...options, signal: owner.signal,
    assertCurrent: owner.assertCurrent });
  owner.assertCurrent();
  return result;
}
