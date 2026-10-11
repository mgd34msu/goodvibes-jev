import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Real recorded admission over isolated local files or synthetic gateway methods. */
export async function admitLocalState(register: (registry: ToolRegistry) => void, name: string, args: Record<string, unknown>, options: {
  readonly directory: string;
  readonly mode?: PermissionMode;
  readonly currentMode?: () => PermissionMode;
  readonly signal?: AbortSignal;
  readonly afterCapture?: () => void;
  readonly beforeEffect?: () => void;
}) {
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode: options.currentMode?.() ?? options.mode ?? 'prompt' });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: options.directory }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => options.directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); register(registry);
  const answers = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type === 'choice') {
      const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
        : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (label === undefined || !Object.hasOwn(question.criteria, label)) throw new Error(`Unexpected permission choice ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    throw new Error(`Unexpected permission question ${name}`);
  });
  let previous: JudgmentPort | undefined;
  const composite: JudgmentPort = { model: answers.port.model, ask(request) {
    return Object.hasOwn(request.questions, 'security_code') && previous ? previous.ask(request) : answers.port.ask(request);
  } };
  const log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(composite, log));
  try {
    const id = 'synthetic-local-state';
    const call = await registry.prepareCall(id, name, args, { signal: options.signal });
    options.afterCapture?.();
    const admission = await manager.admitAutonomous(id, name, call.args, {
      sourceOf: () => ({ goal: 'Verify isolated Agent local-state effects', criteria: ['Only disposable local files and synthetic gateway handlers'] }),
      signal: options.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    return await registry.executePrepared(call, admission, { signal: options.signal, assertCurrent: options.beforeEffect });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), callId: 'synthetic-local-state' };
  } finally { installJudgmentPort(previous); log[Symbol.dispose](); }
}
