export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
  /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S{6,}/i,
];

export function containsSecretLikeText(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertNoSecretLikeMemoryText(fields: readonly string[]): void {
  if (fields.some((field) => containsSecretLikeText(field))) {
    throw new Error('Agent memory cannot store secret-looking values. Store a secret reference or remove the sensitive text.');
  }
}
