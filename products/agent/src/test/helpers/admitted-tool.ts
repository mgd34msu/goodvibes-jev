import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DEFAULT_CONFIG, type ConfigManager, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry, type ToolExecuteOptions, type ToolRegistrationOptions } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

const workspaces = new WeakMap<Tool, string>();
export function admittedToolWorkspace(tool: Tool, directory: string): Tool { workspaces.set(tool, directory); return tool; }

/** Synthetic readings are recorded through the real admission and execution boundary. */
export async function executeAdmitted(tool: Tool, args: Record<string, unknown>, options: {
  readonly directory?: string;
  readonly mode?: PermissionMode;
  readonly currentMode?: () => PermissionMode;
  readonly signal?: AbortSignal;
  readonly beforeEffect?: (effectiveArgs?: Record<string, unknown>) => void;
  readonly registration?: ToolRegistrationOptions;
  readonly configManager?: ConfigManager;
} = {}) {
  if (!['agent_artifacts', 'agent_documents', 'agent_review_packet_presets', 'agent_review_packet_share', 'google', 'agent_notify', 'agent_media_generate'].includes(tool.definition.name)) throw new Error('This synthetic admission fixture is restricted to the named document and external delivery tools under test.');
  const directory = options.directory ?? workspaces.get(tool) ?? process.cwd();
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode: options.currentMode?.() ?? options.mode ?? 'prompt' });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => directory,
  };
  if (options.configManager && options.mode) options.configManager.set('permissions.mode', options.mode);
  const manager = new PermissionManager(undefined,
    options.configManager ? createPermissionConfigReader(options.configManager) : reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  registry.register(tool, options.registration);
  const answers = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    if (question.type === 'choice') {
      const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
        : name === 'family' || name === 'capability' ? 'generic' : name === 'hazard' && tool.definition.name === 'google' ? 'none' : undefined;
      if (label === undefined || !Object.hasOwn(question.criteria, label)) throw new Error(`Unexpected synthetic permission choice ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    throw new Error(`Unexpected synthetic permission question ${name}`);
  });
  let previous: JudgmentPort | undefined;
  const composite: JudgmentPort = {
    model: answers.port.model,
    ask(request) {
      if (previous && ['derives', 'reply_derives', 'boilerplate_only', 'card_field', 'security_code', 'expiry', 'lookalike', 'shortener'].some(name => Object.hasOwn(request.questions, name))) return previous.ask(request);
      return answers.port.ask(request);
    },
  };
  const log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(composite, log));
  try {
    const id = 'synthetic-artifact-operation';
    const call = await registry.prepareCall(id, tool.definition.name, args, { signal: options.signal });
    const admission = await manager.admitAutonomous(id, tool.definition.name, call.args, {
      sourceOf: () => ({ goal: 'Verify isolated local artifact and document effects with synthetic admission', criteria: ['No external account actions'] }),
      signal: options.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    const execution: ToolExecuteOptions = { signal: options.signal, assertCurrent: options.beforeEffect };
    return await registry.executePrepared(call, admission, execution);
  } finally {
    installJudgmentPort(previous); log[Symbol.dispose]();
  }
}
