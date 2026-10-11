/** Exact sandbox-plan admission. This never widens the plan or changes its argv. */
import { randomUUID } from 'node:crypto';
import { captureAutonomousSource } from '../../permissions/autonomous.js';
import { autonomousSourceRevision } from '../../permissions/autonomous-protocol-binding.js';
import { admitExternalRequest } from '../../permissions/external-request.js';
import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
import type { SandboxEscalationExecution, SandboxEscalationPermit, SandboxEscalationRequest } from '../../tools/exec/sandbox.js';

export async function admitSandboxEscalation(host: AutonomousToolPromptHost, input: SandboxEscalationRequest,
  execution?: SandboxEscalationExecution): Promise<SandboxEscalationPermit | false> {
  const operation = currentExternalOperationSource();
  if (!operation || !execution || !host.port.recorder || host.workspaceTrust === undefined) return false;
  const workspaceTrust = host.workspaceTrust;
  const prepareTrust = workspaceTrust?.prepareAutonomousConstraint;
  if (workspaceTrust !== null && typeof prepareTrust !== 'function') return false;
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  const signal = AbortSignal.any([host.signal, invalidation.signal, ...(execution.signal ? [execution.signal] : []), ...(operation.signal ? [operation.signal] : [])]);
  let admission: Awaited<ReturnType<typeof admitExternalRequest>> | undefined;
  let transferred = false;
  try {
    const assertTrust = await prepareTrust?.call(workspaceTrust, 'execute', signal);
    const sourceRevision = autonomousSourceRevision(captureAutonomousSource(operation.sourceOf()));
    let closed = false;
    const assertCurrent = () => {
      if (closed) throw new Error('Sandbox escalation admission closed');
      signal.throwIfAborted(); execution.assertCurrent(); operation.assertCurrent(); assertTrust?.();
      if (host.workspaceTrust !== workspaceTrust || workspaceTrust?.prepareAutonomousConstraint !== prepareTrust) throw new Error('Workspace trust capability changed');
      if (autonomousSourceRevision(operation.sourceOf()) !== sourceRevision) throw new Error('Sandbox operation source changed');
    };
    assertCurrent();
    admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: 'owned-exec-sandbox', signal, assertCurrent }, operation, {
      tool: 'exec', args: { commands: [{ cmd: input.command, cwd: input.workingDirectory }], sandboxEscalation: input },
    });
    assertCurrent();
    if (admission.result.autonomousDecision?.outcome !== 'act') return false;
    const owned = admission;
    transferred = true;
    return Object.freeze({ signal, assertCurrent, claim() { assertCurrent(); owned.claim(); },
      close() { if (!closed) { closed = true; owned.close(); unsubscribe(); } } });
  } catch { return false; }
  finally { if (!transferred) { admission?.close(); unsubscribe(); } }
}
