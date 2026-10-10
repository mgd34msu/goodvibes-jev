import type { ProviderResponseIdentity, ProviderResponseIdentityField } from './interface.js';

/** Wire identity is opaque printable ASCII, bounded without truncation or normalization. */
export const MAX_GEMINI_RESPONSE_IDENTITY_LENGTH = 512;

function createFieldAccumulator() {
  let first: string | undefined;
  let invalid = false;
  let conflicting = false;
  return {
    observe(value: unknown): void {
      if (typeof value !== 'string' || value.length === 0
        || value.length > MAX_GEMINI_RESPONSE_IDENTITY_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
        invalid = true;
        return;
      }
      if (first === undefined) first = value;
      else if (first !== value) conflicting = true;
    },
    snapshot(): ProviderResponseIdentityField {
      if (invalid || conflicting) {
        return { status: 'rejected', reasons: [
          ...(invalid ? ['invalid' as const] : []),
          ...(conflicting ? ['conflicting' as const] : []),
        ] };
      }
      return first === undefined ? { status: 'missing' } : { status: 'observed', value: first };
    },
  };
}

/** No raw chunks or rejected values escape; storage is constant-sized per attempt. */
export function createGeminiResponseIdentityAccumulator(requested: ProviderResponseIdentity['requested']) {
  const requestedSnapshot = { provider: requested.provider, adapterKind: requested.adapterKind, model: requested.model };
  let hasUnparsedDataChunks = false;
  const modelVersion = createFieldAccumulator();
  const responseId = createFieldAccumulator();
  return {
    markUnparsedDataChunk(): void { hasUnparsedDataChunks = true; },
    observe(chunk: unknown): void {
      if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return;
      const record = chunk as Record<string, unknown>;
      // Omitted fields are normal between SSE chunks; explicit null/undefined is invalid.
      if (Object.hasOwn(record, 'modelVersion')) modelVersion.observe(record['modelVersion']);
      if (Object.hasOwn(record, 'responseId')) responseId.observe(record['responseId']);
    },
    snapshot(): ProviderResponseIdentity {
      return { requested: { ...requestedSnapshot }, source: 'provider-reported', hasUnparsedDataChunks,
        modelVersion: modelVersion.snapshot(), responseId: responseId.snapshot() };
    },
  };
}
