import { createHash } from 'node:crypto';

/** Preserve all SHA-256 bits with a bijective alphabet that cannot resemble a PAN. */
export function knowledgeContentHash(value: string, length = 64): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}
