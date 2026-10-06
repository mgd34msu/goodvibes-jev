import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';

// Agent delivery chooses the namespace in the server route. Neither source
// text, transcript history nor a caller-supplied surface is a public input.
const original: OperatorMethodInput<'workLedger.turn.startAgent'> = {
  projectId: 'project', inputId: 'original-input', sourceRevision: 'original-revision',
};
const status: OperatorMethodInput<'workLedger.turn.status'> = original;
const cancel: OperatorMethodInput<'workLedger.turn.cancel'> = original;
const invalid: OperatorMethodInput<'workLedger.turn.startAgent'> = {
  ...original,
  // @ts-expect-error A surface cannot be forged through the native delivery body.
  originSurface: 'webui',
};
function inspect(value: OperatorMethodOutput<'workLedger.turn.startAgent'>): string | null {
  return 'kind' in value ? null : value.correlationId;
}
void status; void cancel; void invalid; void inspect;
