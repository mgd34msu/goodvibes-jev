import { expect } from 'bun:test';
import { DEFAULT_CONFIG } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

const publicFields = new Set(['ENOENT', 'cls', 'confidence', 'error', 'held', 'id', 'importedLinks', 'importedRecords', 'judgment', 'path', 'projectRoot', 'ready', 'reason', 'report', 'reviewState', 'skippedRecords', 'sourceId']);
const contentFields = new Set(['error', 'reason', 'report']);
const privacyBatteries = new Set(['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.export.credential', 'engine.redaction.residual-credential', 'engine.redaction.profile-distinctive']);

/** Only the isolated authored public DTOs in this test lane use these readings. */
export function nativeMemoryWorkPrivacy(delegate: JudgmentPort) {
  const privacy = fakePort((name, question, state) => {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid authored memory/work privacy state');
    if (name === 'kind' && question.type === 'choice' && typeof state.field === 'string' && publicFields.has(state.field)) return choiceAnswer(question, contentFields.has(state.field) ? 'content' : 'other', 0.999);
    if (question.type === 'noul' && ['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted native memory/work privacy question ${name}`);
  });
  const port: JudgmentPort = { model: delegate.model, ask(request) {
    return privacyBatteries.has(request.context?.battery ?? '') ? privacy.port.ask(request) : delegate.ask(request);
  } };
  return { port, privacyRequests: privacy.requests };
}

/** Exact synthetic local-write admission roles, recorded through the native gate. */
export function nativeMemoryWorkAdmission(delegate?: JudgmentPort, kind: 'read' | 'write' = 'write') {
  const readings = fakePort((name, question) => {
    if (question.type === 'choice') {
      const label = name === 'disposition' ? 'act' : name === 'kind' ? kind : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (label) return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul' && ['mutates', 'outward', 'secrets', 'catastrophic', 'cardDetails', 'irreversible', 'beyondProject', 'weakensSecurity', 'refused'].includes(name)) return noulAnswer(name === 'mutates' && kind === 'write' ? 0.999 : 0.001);
    throw new Error(`Unscripted native memory/work admission question ${name}`);
  });
  const gates = new Set(['engine.gate.side-effect', 'engine.gate.risk-family', 'engine.gate.boundary', 'engine.gate.autonomous-disposition', 'engine.gate.autonomous-refusal']);
  const port: JudgmentPort = { model: readings.port.model, ask(request) {
    if (gates.has(request.context?.battery ?? '')) return readings.port.ask(request);
    if (delegate) return delegate.ask(request);
    throw new Error(`Unscripted native memory/work battery ${request.context?.battery}`);
  } };
  return { ...nativeMemoryWorkPrivacy(port), admissionRequests: readings.requests };
}

export function nativeMemoryWorkRegistry(directory: string, register: (registry: ToolRegistry) => void) {
  const permissions = (): ReturnType<PermissionConfigReader['getSnapshot']>['permissions'] => ({ ...DEFAULT_CONFIG.permissions, mode: 'prompt' });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); register(registry);
  return { manager, registry };
}

export async function executeNativeMemoryWork(registry: ToolRegistry, manager: PermissionManager, id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const projected = await registry.projectCall(id, name, args, { signal });
  try {
    const call = await registry.prepareCall(id, name, projected.args, { signal });
    const admission = await manager.admitAutonomous(id, name, call.args, {
      sourceOf: () => ({ goal: 'Verify native Agent memory and work capture with isolated authored sources', criteria: ['Only the disposable local store and intercepted gateway under test'] }),
      signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    return await registry.executePrepared(call, admission);
  } finally { await registry.releaseProjected(projected); }
}
