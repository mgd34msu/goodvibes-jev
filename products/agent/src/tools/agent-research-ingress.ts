import { types as nodeTypes } from 'node:util';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolInputProjector, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { agentResearchSourceOwner, captureResearchInput, hasPreparedResearchReport, inheritPreparedResearchReport, prepareProtectedResearchReport } from '../agent/protected-research-report.ts';
import { resolveWorkspaceActionDetail } from './agent-harness-workspace-actions.ts';

export function isResearchReportEditor(args: Record<string, unknown>): boolean {
  if (args.mode === 'run_workspace_action') {
    const resolved = resolveWorkspaceActionDetail(args);
    // Other editors can legitimately have a field named sources (for example,
    // browser-history import). Their explicit route retains its own boundary.
    if (resolved?.status === 'found') return resolved.action.editorKind === 'research-report';
  }
  return !!args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
    && ['sources', 'reportMarkdown'].some(key => Object.hasOwn(args.fields as object, key));
}

/** Report fields must be projected before the harness itself becomes a generic reader. */
export function createAgentHarnessResearchProjector(registry: ToolRegistry, isReport = isResearchReportEditor): ToolInputProjector {
  return { async project(request) {
    const args = captureResearchInput(request.args);
    if (!isReport(args)) return { status: 'projected', args, assertRepairedArgs(candidate) {
      if (isReport(candidate)) throw new Error('Research editor input requires fresh protected preparation.');
    } };
    const fields = args.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { status: 'held' };
    const prepared = await prepareProtectedResearchReport(agentResearchSourceOwner(registry), {
      ...args, sources: (fields as Record<string, unknown>).sources,
    }, { signal: request.signal, assertCurrent: request.assertCurrent });
    const { sources: _sources, ...projected } = prepared.args;
    const serialized = JSON.stringify(projected);
    inheritPreparedResearchReport(prepared.args, projected);
    return { status: 'projected', args: projected, assertCurrent: prepared.assertCurrent, release: prepared.release,
      assertRepairedArgs(candidate) {
        prepared.assertCurrent();
        if (JSON.stringify(candidate) !== serialized) throw new Error('Research editor input binding changed.');
        inheritPreparedResearchReport(projected, candidate);
      },
    };
  } };
}

/** Read only routing descriptors; unrelated private setup bodies keep their own boundary. */
function reportRouting(input: Record<string, unknown>): Record<string, unknown> {
  if (nodeTypes.isProxy(input)) throw new Error('Research routing input is unavailable.');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const routing: Record<string, unknown> = {};
  for (const key of ['mode', 'action', 'id', 'actionId', 'workspaceActionId', 'command', 'target', 'query', 'category', 'categoryId']) {
    const descriptor = descriptors[key];
    if (descriptor && !('value' in descriptor)) throw new Error('Research routing input is unavailable.');
    if (descriptor) routing[key] = descriptor.value;
  }
  const fields = descriptors.fields;
  if (fields && !('value' in fields)) throw new Error('Research routing input is unavailable.');
  if (fields?.value && typeof fields.value === 'object') {
    if (nodeTypes.isProxy(fields.value)) throw new Error('Research routing input is unavailable.');
    const fieldDescriptors = Object.getOwnPropertyDescriptors(fields.value);
    routing.fields = Object.fromEntries(['sources', 'reportMarkdown'].filter(key => fieldDescriptors[key]).map(key => [key, '']));
  }
  return routing;
}

/** Raw factory callers retain the same report boundary as registered callers. */
export function protectAgentHarnessResearchTool(tool: Tool, registry: ToolRegistry, isReport = isResearchReportEditor): Tool {
  const execute = tool.execute;
  const projector = createAgentHarnessResearchProjector(registry, isReport);
  return { ...tool, async execute(input, options) {
    if (!isReport(reportRouting(input))) return execute(input, options);
    const args = captureResearchInput(input);
    if (!isReport(args)) return execute(input, options);
    if (hasPreparedResearchReport(input, agentResearchSourceOwner(registry))) return execute(input, options);
    const projected = await projector.project({ callId: 'research-editor-direct', name: tool.definition.name, args,
      signal: options?.signal, assertCurrent: () => { options?.signal?.throwIfAborted(); } });
    try {
      if (projected.status !== 'projected') return { success: false, error: 'Research editor preparation is held.' };
      projected.assertCurrent?.();
      return await execute(projected.args, options);
    } finally { await projected.release?.(); }
  } };
}
