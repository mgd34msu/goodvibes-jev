import { containsIssuerCredential } from '@goodvibes-jev/engine/sdk/platform/utils';

// Compatibility guards remain until semantic credential screening has a
// protected-input, cancellable contract. They must not be replaced by a
// journal redactor: personal profile values are valid local memory, and a
// remembered journal reading must never authorize a later memory write.
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
  /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S{6,}/i,
];

export function containsSecretLikeText(text: string): boolean {
  return containsIssuerCredential(text) || SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertNoSecretLikeMemoryText(fields: readonly string[]): void {
  if (fields.some((field) => containsSecretLikeText(field))) {
    throw new Error('Agent memory cannot store secret-looking values. Store a secret reference or remove the sensitive text.');
  }
}
