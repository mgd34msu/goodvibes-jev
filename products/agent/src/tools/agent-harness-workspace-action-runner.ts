import type { AgentHarnessToolArgs, AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { clearSetupCheckpoint, markSetupCheckpoint, setupCheckpointSummary } from './agent-harness-setup-posture.ts';
import { runLocalWorkspaceAction } from './agent-harness-local-operations.ts';
import { AGENT_WORKSPACE_CATEGORIES, buildWorkspaceEditorContext, createWorkspaceEditor, describeWorkspaceAction, describeWorkspaceCategory, listWorkspaceActions, resolveWorkspaceActionDetail } from './agent-harness-workspace-actions.ts';
import { runCommand } from './agent-harness-command-runner.ts';
import { runWorkspaceEditorAction } from './agent-harness-workspace-editor-runner.ts';
import { error, output, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';
import { importAgentWorkspaceTuiSettings, previewAgentWorkspaceTuiSettingsImport } from '../input/agent-workspace-settings.ts';
import { writeOnboardingCheckMarker, writeOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';

export async function runWorkspaceAction(
  deps: AgentHarnessToolDeps,
  args: AgentHarnessToolArgs,
): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const resolved = resolveWorkspaceActionDetail(args);
  if (resolved?.status === 'ambiguous') return error(`Ambiguous Agent workspace action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved) return error('run_workspace_action requires a valid actionId, command, target, or query. Use mode:"workspace_actions" to inspect available actions.');
  const { category, action, lookup } = resolved;

  if (action.safety === 'blocked') {
    return error(`Workspace action ${action.id} is blocked in Agent: ${action.detail}`);
  }
  if (action.kind === 'guidance') {
    const editorContext = buildWorkspaceEditorContext(deps.commandContext, args);
    return output({
      status: 'guidance',
      action: describeWorkspaceAction(category, action, { includeEditor: true, editorContext, lookup }),
    });
  }
  if (action.kind === 'workspace' && action.targetCategoryId) {
    const target = AGENT_WORKSPACE_CATEGORIES.find((entry) => entry.id === action.targetCategoryId);
    return output({
      status: 'workspace_target',
      action: describeWorkspaceAction(category, action, { lookup }),
      targetCategory: target ? describeWorkspaceCategory(target) : action.targetCategoryId,
      targetActions: target ? target.actions.map((entry) => describeWorkspaceAction(target, entry)).slice(0, 40) : [],
    });
  }
  if (action.kind === 'command' && action.command) {
    if (/<[^>\s]+(?:\s+[^>]*)?>/.test(action.command)) {
      return output({
        status: 'needs_concrete_command',
        action: describeWorkspaceAction(category, action, { lookup }),
        note: 'This workspace action is a command template. Provide concrete values with mode:"run_command" once the exact command is known.',
      });
    }
    return runCommand(deps, { ...args, command: action.command });
  }
  if (action.kind === 'settings-import') {
    const preview = previewAgentWorkspaceTuiSettingsImport(deps.commandContext);
    if (!preview) return error('GoodVibes settings import is unavailable in this runtime.');
    if (args.confirm !== true && !readString(args.explicitUserRequest)) {
      return output({
        status: 'confirmation_required',
        action: describeWorkspaceAction(category, action, { lookup }),
        preview,
        next: 'Run with confirm:true and explicitUserRequest after the user asks to import these settings.',
      });
    }
    const confirmationError = requireConfirmedAction(args, 'GoodVibes settings import');
    if (confirmationError) return error(confirmationError);
    const explicitUserRequest = readString(args.explicitUserRequest);
    const outcome = await importAgentWorkspaceTuiSettings(deps.commandContext);
    return output({
      status: outcome.status,
      action: describeWorkspaceAction(category, action, { lookup }),
      preview,
      actionResult: outcome.result,
      runtimeSnapshot: outcome.runtimeSnapshot,
      policy: {
        effect: 'state',
        confirmation: 'confirmed',
        explicitUserRequest,
        boundary: 'Applied only Agent-owned settings and subscription state from published GoodVibes platform sources; source package stores were not mutated.',
      },
    });
  }
  if (action.kind === 'setup-checkpoint') {
    const operation = action.setupCheckpointOperation ?? 'show';
    if (operation === 'show') {
      return output({
        status: 'checkpoint_inspected',
        action: describeWorkspaceAction(category, action, { lookup }),
        checkpoint: await setupCheckpointSummary(deps.commandContext),
      });
    }
    const confirmationError = requireConfirmedAction(args, operation === 'clear' ? 'Setup wizard checkpoint clear' : 'Setup wizard checkpoint save');
    if (confirmationError) return error(confirmationError);
    const result = operation === 'clear'
      ? clearSetupCheckpoint(deps.commandContext, args)
      : await markSetupCheckpoint(deps.commandContext, args);
    return output({
      status: 'checkpoint_action_completed',
      action: describeWorkspaceAction(category, action, { lookup }),
      result,
    });
  }
  if (action.kind === 'editor' && action.editorKind) {
    const editor = createWorkspaceEditor(action.editorKind, buildWorkspaceEditorContext(deps.commandContext, args));
    if (!editor) return error(`No workspace editor route exists for ${action.editorKind}.`);
    return runWorkspaceEditorAction(deps, action, editor, args);
  }
  if (action.kind === 'local-selection' || action.kind === 'local-operation') {
    return runLocalWorkspaceAction(deps, action, args);
  }
  if (action.kind === 'onboarding-complete') {
    const confirmationError = requireConfirmedAction(args, 'Onboarding completion');
    if (confirmationError) return error(confirmationError);
    const explicitUserRequest = readString(args.explicitUserRequest);
    if (!explicitUserRequest) return error('Onboarding completion requires explicitUserRequest when confirm is true.');
    const shellPaths = deps.commandContext.workspace?.shellPaths;
    if (!shellPaths) return error('Onboarding completion requires Agent shell paths.');
    const marker = { scope: 'user', source: 'wizard', mode: 'new', workspaceRoot: shellPaths.workingDirectory } as const;
    const checkMarker = writeOnboardingCheckMarker(shellPaths, marker);
    const completionMarker = writeOnboardingCompletionMarker(shellPaths, marker);
    return output({
      status: 'onboarding_completed',
      action: describeWorkspaceAction(category, action, { lookup }),
      explicitUserRequest,
      checkMarker: {
        exists: checkMarker.exists,
        path: checkMarker.path,
        updatedAt: checkMarker.payload?.updatedAt ?? null,
        source: checkMarker.payload?.source ?? null,
        mode: checkMarker.payload?.mode ?? null,
      },
      completionMarker: {
        exists: completionMarker.exists,
        path: completionMarker.path,
        updatedAt: completionMarker.payload?.updatedAt ?? null,
        source: completionMarker.payload?.source ?? null,
        mode: completionMarker.payload?.mode ?? null,
      },
      routes: {
        inspectSetup: 'setup action:"status" includeParameters:true',
      },
      policy: {
        effect: 'confirmed-onboarding-marker-write',
        boundary: 'Writes only the user onboarding check and completion markers. It does not mutate provider credentials, connected-host state, channels, schedules, or local behavior.',
      },
    });
  }
  const editorContext = buildWorkspaceEditorContext(deps.commandContext, args);
  return output({
    status: 'no_direct_effect',
    action: describeWorkspaceAction(category, action, { includeEditor: true, editorContext, lookup }),
  });
}
