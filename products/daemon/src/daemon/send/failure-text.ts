import { describeStructuralDeliveryError } from '@goodvibes-jev/engine/sdk/platform/integrations';

/** Private provider errors remain retry inputs; only this projection may reach CLI output. */
export function describeSendFailure(error: unknown): string {
  return describeStructuralDeliveryError(error);
}
