import { randomUUID } from 'node:crypto';

/** Preserve native UUID entropy without introducing card-shaped digit runs into
 * identifiers that become complete model evidence. Never encodes caller data. */
export function agentRecordNonce(): string {
  return randomUUID().replace(/-/g, '').replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}
