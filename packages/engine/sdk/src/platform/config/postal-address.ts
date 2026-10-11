/** Async address reads are distinct from missing settings and bulk config dumps. */
export const POSTAL_PARTS = ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const;
export type PostalPart = typeof POSTAL_PARTS[number];
export type PostalKind = 'shipping' | 'billing';
export type PostalParts = Readonly<Record<PostalPart, string>>;
export class PostalAddressHeldError extends Error {
  constructor() { super('The stored address needs a current verified reading before it can be used.'); this.name = 'PostalAddressHeldError'; }
}
export interface PreparedPostalAddress {
  readonly value: PostalParts | null;
  /** Restriction only, never permission to disclose or place an order. */
  readonly assertCurrent: () => void;
}
export interface PostalReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export type ProfilePostalReader = (kind: PostalKind, options: PostalReadOptions) => Promise<PreparedPostalAddress>;
export function postalConfigKey(key: string): boolean {
  return (['shipping', 'billing'] as const).some(kind => POSTAL_PARTS.some(part => key === `payments.${kind}Address.${part}`));
}

/** Per-row UI read: a held postal reading never tears down the whole settings surface. */
export function readConfigSettingForDisplay(read: () => unknown): { readonly value: unknown; readonly held?: string | undefined } {
  try { return { value: read() }; }
  catch (error) { if (!(error instanceof PostalAddressHeldError)) throw error; return { value: undefined, held: error.message }; }
}
