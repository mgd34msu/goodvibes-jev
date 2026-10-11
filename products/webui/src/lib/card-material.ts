/** Exact material fields declared by the card-entry contract. Unknown names require a canonical reading. */
const DECLARED_CARD_MATERIAL_KEYS: ReadonlySet<string> = new Set([
  'payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName',
]);

/** Structural exclusions cannot be cleared by a semantic answer. No value is inspected here. */
export function isDeclaredCardMaterialKey(key: string): boolean {
  return DECLARED_CARD_MATERIAL_KEYS.has(key);
}

/** @deprecated Only declared keys are synchronous facts. Unknown keys must be excluded until a current canonical reading settles. */
export function isCardMaterialKey(key: string): boolean {
  return isDeclaredCardMaterialKey(key);
}
