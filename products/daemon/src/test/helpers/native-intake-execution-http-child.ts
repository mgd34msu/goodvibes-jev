/** Owned process: queue a real source2 attempt behind a running native body, then exit without cleanup. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeConversationIntakeLookupResultSchema, type NativeConversationIntakeCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { nativeWorkExecutionSnapshotSchema } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createNativeIntakeExecutionHttpFixture, type NativeIntakeExecutionHttpWire } from './native-intake-execution-http-fixture.js';
import { intakeBarrier } from './native-intake-http-fixture.js';

if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') throw new Error('Only the owned guarded parent can run this fixture child');
const root = process.argv[2], serializedInput = process.argv[3];
if (!root || !serializedInput) throw new Error('Owned root and synthetic source required');
const input = JSON.parse(serializedInput) as NativeConversationIntakeCaptureRequest;
const entered = intakeBarrier();
const f = await createNativeIntakeExecutionHttpFixture({ root, execute: async () => {
  entered.resolve(); return new Promise(() => {});
} });
f.daemon.services.configManager.set('contract.maxActiveContracts', 1);
const parse = (wire: NativeIntakeExecutionHttpWire) => {
  if (wire.status !== 200) throw new Error(`Owned child HTTP failed: ${wire.body}`);
  return JSON.parse(wire.body) as unknown;
};
async function admit(source: NativeConversationIntakeCaptureRequest) {
  const lookupBefore = await f.wire('workLedger.intake.get', { inputId: source.inputId });
  const capture = await f.wire('workLedger.intake.capture', source);
  const captured = nativeConversationIntakeLookupResultSchema.parse(parse(capture));
  if (captured.kind !== 'captured') throw new Error('Owned child expected a new capture');
  const getCaptured = await f.wire('workLedger.intake.get', { inputId: source.inputId });
  const transition = { inputId: source.inputId, sourceRevision: captured.sourceRef.sourceRevision };
  const admission = await f.wire('workLedger.intake.admit', transition);
  const result = nativeConversationIntakeLookupResultSchema.parse(parse(admission));
  if (result.kind !== 'work') throw new Error('Owned child expected source2 admission');
  const identity = { projectId: result.projectId, workId: result.receipt.workId,
    attemptId: result.receipt.attemptId, expectedRevision: result.receipt.expectedRevision };
  const get = await f.wire('workLedger.intake.get', { inputId: source.inputId });
  const notStarted = await f.wire('workLedger.execution.status', identity);
  if (notStarted.status !== 404) throw new Error('Owned child intake unexpectedly started execution');
  return { input: source, lookupBefore, capture, getCaptured, transition, admit: admission, get, identity, notStarted };
}
const occupied = await admit({ ...input, requestId: `${input.requestId}-blocker`, inputId: `${input.inputId}-blocker` });
parse(await f.wire('workLedger.execution.start', occupied.identity));
await entered.promise;
const base = await admit(input);
const auth = await f.wire('control.auth.current'), project = await f.wire('workLedger.project');
const start = await f.wire('workLedger.execution.start', base.identity);
const prepared = nativeWorkExecutionSnapshotSchema.parse(parse(start));
if (prepared.kind !== 'execution' || prepared.state !== 'prepared' || prepared.recovery !== 'available' || !prepared.receipt) throw new Error(`Owned child did not retain a real queued receipt: ${start.body}`);
if (f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself')).length !== 1) throw new Error('Only the slot-occupying first body may have run');
// The token is owned synthetic test state, consumed only by the parent, and is
// deliberately excluded from the exported browser HTTP captures.
writeFileSync(join(root, 'prepared-child-result.json'), JSON.stringify({ paired: f.paired, capture: { ...base, auth, project, start } }));
process.exit(0);
