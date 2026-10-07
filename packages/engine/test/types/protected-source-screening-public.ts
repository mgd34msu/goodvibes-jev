/** Consumer-vantage opaque source/receipt and existing mapper compatibility. */
import { createProtectedSourceOwner, SOURCE_SCREENING_LIMITS,
  type ProtectedSourceOwnerOptions, type ProtectedSource, type SourceScreeningReceipt,
} from '@goodvibes-jev/engine/sdk/platform/security';
import { createProtectedInboxMapper, type ProtectedInboxPreviewInput, type ProtectedInboxPreviewFields } from '@goodvibes-jev/engine/sdk/platform/intake';
declare const options: ProtectedSourceOwnerOptions;
declare const input: ProtectedInboxPreviewInput;
const owner = createProtectedSourceOwner(options);
const source: ProtectedSource = owner.capture(['exact original']);
const mapper = createProtectedInboxMapper(owner);
const result: Promise<ProtectedInboxPreviewFields | null> = mapper(input, options.authority.signal);
const close: Promise<void> = owner.close();
// @ts-expect-error A structural empty object is not an owned source handle.
const forgedSource: ProtectedSource = {};
// @ts-expect-error A structural empty object is not a settled screening receipt.
const forgedReceipt: SourceScreeningReceipt = {};
export { source, result, close, forgedSource, forgedReceipt, SOURCE_SCREENING_LIMITS };
