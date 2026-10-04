/** Consumer-vantage pin for the narrow browser-safe submission subpath. */
import {
  createOperatorNativeWorkSubmissionClient,
  type NativeWorkSubmissionRequest,
  type NativeWorkSubmissionResult,
  type NativeWorkSubmissionLookupResult,
  type OperatorNativeWorkSubmissionClient,
  type OperatorNativeWorkSubmissionOptions,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/contracts/generated/foundation-client-types';

declare const operator: Pick<OperatorRemoteClient, 'invoke'>;
declare const request: NativeWorkSubmissionRequest;
const options: OperatorNativeWorkSubmissionOptions = { signal: new AbortController().signal };
const client: OperatorNativeWorkSubmissionClient = createOperatorNativeWorkSubmissionClient(operator, 'selected-host-project');
const result: Promise<NativeWorkSubmissionResult> = client.submit(request, options);
const lookup: Promise<NativeWorkSubmissionLookupResult> = client.get({ requestId: request.requestId }, options);
const wireInput: OperatorMethodInput<'workLedger.submit'> = request;
declare const clientResult: NativeWorkSubmissionResult;
const compatibleResult: OperatorMethodOutput<'workLedger.submit'> = clientResult;
declare const clientLookup: NativeWorkSubmissionLookupResult;
const compatibleLookup: OperatorMethodOutput<'workLedger.submission.get'> = clientLookup;
// Generated arrays are readonly; compare both contracts with the same readonly
// view so neither missing fields nor widened source versions can pass unnoticed.
type DeepReadonly<T> = T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ExactRequest = Assert<Equal<DeepReadonly<NativeWorkSubmissionRequest>, DeepReadonly<OperatorMethodInput<'workLedger.submit'>>>>;
type ExactResult = Assert<Equal<DeepReadonly<NativeWorkSubmissionResult>, DeepReadonly<OperatorMethodOutput<'workLedger.submit'>>>>;
type ExactLookupResult = Assert<Equal<DeepReadonly<NativeWorkSubmissionLookupResult>, DeepReadonly<OperatorMethodOutput<'workLedger.submission.get'>>>>;
declare const exactTypes: [ExactRequest, ExactResult, ExactLookupResult];
void exactTypes;
void result; void lookup; void wireInput; void compatibleResult; void compatibleLookup;
client.dispose();
// @ts-expect-error Project selection is owned by the host, not the request.
client.submit({ ...request, projectId: 'injected' });
// @ts-expect-error Model-generated criteria are not accepted by this explicit-source boundary.
client.submit({ ...request, generateCriteria: true });
// @ts-expect-error Submission never grants or invokes execution authority.
client.start(request);
// @ts-expect-error Receipt lookup cannot select a source or session.
client.get({ requestId: request.requestId, sessionId: 'injected' });
