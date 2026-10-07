/** Consumer-vantage opaque source/receipt and existing mapper compatibility. */
import { createProtectedSourceOwner, createFramedResearchReferenceProjector, resolveFramedResearchReference, SOURCE_SCREENING_LIMITS,
  type ProtectedSourceOwnerOptions, type ProtectedSource, type SourceScreeningReceipt,
  type ProtectedResearchReference, type ResearchReferenceScreeningReceipt, type ResearchReferenceScreeningResult,
  type ResearchReferenceProjection, type ResearchReferenceOperation,
} from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolRegistry, type ToolInputProjector, type ProjectedToolCall } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createProtectedInboxMapper, type ProtectedInboxPreviewInput, type ProtectedInboxPreviewFields } from '@goodvibes-jev/engine/sdk/platform/intake';
declare const options: ProtectedSourceOwnerOptions;
declare const input: ProtectedInboxPreviewInput;
const owner = createProtectedSourceOwner(options);
const source: ProtectedSource = owner.capture(['exact original']);
const reference: ProtectedResearchReference = owner.captureResearchReference('https://example.test/?id=public#section');
const referenceResult: Promise<ResearchReferenceScreeningResult> = owner.screenResearchReference(reference);
const operation: ResearchReferenceOperation = { signal: options.authority.signal, assertCurrent: options.authority.assertCurrent };
const fencedReferenceResult: Promise<ResearchReferenceScreeningResult> = owner.screenResearchReference(reference, operation);
const inputProjector: ToolInputProjector = createFramedResearchReferenceProjector(owner);
declare const registry: ToolRegistry;
const projectedCall: Promise<ProjectedToolCall> = registry.projectCall('call', 'framed', { references: [{ id: 'S1', url: 'https://example.test/' }] });
declare const executionContext: object;
declare const executionArgs: Record<string, unknown>;
const exactReference: ResearchReferenceProjection = resolveFramedResearchReference(executionContext, executionArgs, 'S1');
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
export { source, result, close, forgedSource, forgedReceipt, reference, referenceResult, referenceProjection, fencedReferenceResult,
  inputProjector, projectedCall, exactReference, SOURCE_SCREENING_LIMITS };
