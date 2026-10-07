/** Consumer-vantage opaque source/receipt and existing mapper compatibility. */
import { createProtectedSourceOwner, SOURCE_SCREENING_LIMITS,
  type ProtectedSourceOwnerOptions, type ProtectedSource, type SourceScreeningReceipt,
  type ProtectedResearchReference, type ResearchReferenceScreeningReceipt, type ResearchReferenceScreeningResult,
  type ResearchReferenceProjection,
} from '@goodvibes-jev/engine/sdk/platform/security';
import { createProtectedInboxMapper, type ProtectedInboxPreviewInput, type ProtectedInboxPreviewFields } from '@goodvibes-jev/engine/sdk/platform/intake';
declare const options: ProtectedSourceOwnerOptions;
declare const input: ProtectedInboxPreviewInput;
const owner = createProtectedSourceOwner(options);
const source: ProtectedSource = owner.capture(['exact original']);
const reference: ProtectedResearchReference = owner.captureResearchReference('https://example.test/?id=public#section');
const referenceResult: Promise<ResearchReferenceScreeningResult> = owner.screenResearchReference(reference);
declare const referenceReceipt: ResearchReferenceScreeningReceipt;
declare const sourceReceipt: SourceScreeningReceipt;
const referenceProjection: ResearchReferenceProjection = owner.projectResearchReference(referenceReceipt);
// @ts-expect-error A query-role-only handle cannot enter the full display-preview reader.
owner.screen(reference);
// @ts-expect-error A display-preview handle is not a declared research URL.
owner.screenResearchReference(source);
// @ts-expect-error Query-role clearance is not full display-preview clearance.
owner.project(referenceReceipt);
// @ts-expect-error A display-preview receipt does not classify URL parameter roles.
owner.projectResearchReference(sourceReceipt);
const mapper = createProtectedInboxMapper(owner);
const result: Promise<ProtectedInboxPreviewFields | null> = mapper(input, options.authority.signal);
const close: Promise<void> = owner.close();
// @ts-expect-error A structural empty object is not an owned source handle.
const forgedSource: ProtectedSource = {};
// @ts-expect-error A structural empty object is not a settled screening receipt.
const forgedReceipt: SourceScreeningReceipt = {};
export { source, result, close, forgedSource, forgedReceipt, reference, referenceResult, referenceProjection, SOURCE_SCREENING_LIMITS };
