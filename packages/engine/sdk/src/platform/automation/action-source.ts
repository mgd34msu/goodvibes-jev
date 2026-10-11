/** Trusted, nonserialized source custody through an automation spawn. */
import type { ExternalOperationSource } from '../permissions/external-request.js';
import { captureAutonomousSource } from '../permissions/autonomous.js';
import { autonomousSourceRevision } from '../permissions/autonomous-protocol-binding.js';
import type { NativePlannerBinding } from '../tools/agent/contract-binding.js';
const owners = new WeakMap<object, NativePlannerBinding>();
export function captureAutomationSource(operation: ExternalOperationSource): ExternalOperationSource {
  operation.assertCurrent(); operation.signal?.throwIfAborted();
  const source = captureAutonomousSource(operation.sourceOf()); const revision = autonomousSourceRevision(source);
  const assertCurrent = () => { operation.assertCurrent(); operation.signal?.throwIfAborted();
    if (autonomousSourceRevision(operation.sourceOf()) !== revision) throw new Error('Automation original source changed'); };
  return { ...operation, assertCurrent, sourceOf: () => { assertCurrent(); return source; } };
}
export function bindAutomationAction<T extends object>(input: T, operation: ExternalOperationSource | undefined): T {
  if (operation) {
    const owner = captureAutomationSource(operation);
    owners.set(input, { autonomousSource: () => { owner.assertCurrent(); return owner.sourceOf(); },
      ...(owner.signal ? { autonomousSignal: owner.signal } : {}) });
  }
  return input;
}
export function automationActionBinding(input: object): NativePlannerBinding | undefined {
  const owner = owners.get(input); owner?.autonomousSource(); return owner;
}
