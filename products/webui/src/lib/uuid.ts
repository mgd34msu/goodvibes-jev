/**
 * uuid.ts, UUIDv4 minting that works on EVERY origin this UI serves from.
 *
 * crypto.randomUUID exists only in secure contexts (https, localhost), and the
 * plain-HTTP LAN origin is a first-class deployment for this UI (the whole
 * pairing.posture surface exists to label it honestly). crypto.getRandomValues
 * carries no such restriction, so the fallback assembles the v4 UUID from it
 * with the version and variant bits RFC 4122 requires.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
