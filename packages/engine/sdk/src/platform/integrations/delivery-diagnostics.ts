import type { FailureClass, FailureTransience, TransienceBasis } from '@goodvibes-jev/engine/errors';

/** Only actual numeric HTTP status, never arbitrary error text or its cause. */
export function deliveryHttpStatus(error: unknown): number | undefined {
  try {
    if (error === null || typeof error !== 'object') return undefined;
    for (const key of ['status', 'statusCode']) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
  } catch { /* Unreadable fields do not become diagnostics. */ }
  return undefined;
}

export function describeStructuralDeliveryError(error: unknown): string {
  const status = deliveryHttpStatus(error);
  return status === undefined ? 'Delivery failed' : `HTTP ${status}`;
}

const BASES: readonly TransienceBasis[] = ['explicit', 'retry-after', 'status', 'errno', 'error-type', 'reading', 'no-wording'];

/** Validate code-owned evidence before retaining it; free-form detail is omitted. */
export function structuralDeliveryEvidence(value: FailureTransience): { readonly failureClass: FailureClass; readonly basis: TransienceBasis } | undefined {
  const failureClass = value.failureClass;
  const basis = value.basis;
  if ((failureClass !== 'retryable' && failureClass !== 'terminal') || !BASES.includes(basis)) return undefined;
  return { failureClass, basis };
}
