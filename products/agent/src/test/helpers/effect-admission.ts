import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry, type ToolRegistrationOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Synthetic recorded decisions exercise the real permission manager and registry. */
export function effectAdmissionFixture(mode: PermissionMode = 'prompt', configReader?: PermissionConfigReader) {
  let incarnation = 0;
  let source = { goal: 'Exercise this synthetic comparison or research fixture', criteria: ['Use isolated temporary state and synthetic providers only'] };
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const config: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: '/synthetic/agent-effects', incarnation }),
    getSnapshot: () => ({ permissions: permissions() }), getWorkingDirectory: () => '/synthetic/agent-effects', isAutoApproveEnabled: () => false,
  };
  const manager = new PermissionManager(undefined, configReader ?? config, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  let sequence = 0;
  const port = fakePort((name, question, state) => {
    if (question.type === 'noul') {
      // Exact synthetic fixture answers; this is no semantic classification service.
      const judgment = state && typeof state === 'object' && !Array.isArray(state) ? state.judgment : undefined;
      const reasons = judgment && typeof judgment === 'object' && !Array.isArray(judgment) ? judgment.reasons : undefined;
      const positive = name === 'actionable' && reasons === 'Candidate B was more concrete.'
        || name === 'clarity' && reasons === 'Candidate A was easier to scan.';
      return noulAnswer(positive ? 0.999 : 0.001);
    }
    if (question.type !== 'choice') throw new Error(`Unexpected synthetic effect question ${name}`);
    const labels = Object.keys(question.criteria);
    const modelSetting = name === 'hazard' && state && typeof state === 'object' && !Array.isArray(state) && state.key === 'provider.model';
    const label = modelSetting && labels.includes('none') ? 'none'
      : name === 'disposition' ? labels.includes('act') ? 'act' : 'reject'
      : name === 'kind' && labels.includes('read') ? 'read'
      : labels.includes('generic') ? 'generic' : labels[0];
    if (!label) throw new Error('Synthetic effect question has no choices');
    return choiceAnswer(question, label, 0.999);
  });
  async function run(tool: Tool, args: Record<string, unknown>, options?: Parameters<Tool['execute']>[1]) {
    const log = new SqliteDecisionLog(':memory:');
    const previous = installJudgmentPort(withDecisionLog(port.port, log));
    try {
      if (!registry.has(tool.definition.name)) registry.register(tool);
      const id = `synthetic-effect-${++sequence}`;
      const call = await registry.prepareCall(id, tool.definition.name, args, options);
      const admission = await manager.admitAutonomous(id, tool.definition.name, call.args, {
        sourceOf: () => source, signal: options?.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      const result = await registry.executePrepared(call, admission);
      return result;
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { installJudgmentPort(previous); log[Symbol.dispose](); }
  }
  function tool(raw: Tool, registration?: ToolRegistrationOptions): Tool {
    registry.register(raw, registration);
    return { definition: raw.definition, execute: (args, options) => run(raw, args, options) };
  }
  return { registry, manager, run, tool, port,
    revoke() { incarnation++; }, setMode(next: PermissionMode) { mode = next; incarnation++; },
    replaceSource() { source = { ...source, goal: 'Changed synthetic source' }; },
  };
}
