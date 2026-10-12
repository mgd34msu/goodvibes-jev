import { captureStatefulCatalogRequest } from './agent-harness-stateful-catalog-source.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { clearSetupCheckpoint, markSetupCheckpoint, setupCheckpointSummary } from './agent-harness-setup-posture.ts';
import { runLocalWorkspaceAction } from './agent-harness-local-operations.ts';
import { AGENT_WORKSPACE_CATEGORIES, buildWorkspaceEditorContext, createWorkspaceEditor, describeWorkspaceAction, describeWorkspaceCategory, listWorkspaceActions, resolveWorkspaceActionDetail } from './agent-harness-workspace-actions.ts';
import { runTranslatedWorkspaceCommand } from './agent-harness-command-runner.ts';
import { runWorkspaceEditorAction } from './agent-harness-workspace-editor-runner.ts';
import { error, output, readString, requireConfirmedAction } from './agent-harness-tool-utils.ts';
import { executeAdmittedAgentSettingsImport, isAgentSettingsImportMutation } from './agent-settings-import-admission.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { assertModelReadingInputCurrent, captureModelReadingInput, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { capturedHarnessSettingsImportPreview, harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { getOnboardingCheckMarkerPath, getOnboardingCompletionMarkerPath, writeOnboardingCheckMarker, writeOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import { captureHarnessLocalEffect } from './agent-harness-local-effect.ts';

export async function runWorkspaceAction(
  deps: AgentHarnessToolDeps,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const assertExecution = harnessCatalogExecutionGuard(args, options);
  const sourceOwner = agentResearchSourceOwner(deps.toolRegistry);
  const sourceCurrent = () => {
    options?.signal?.throwIfAborted();
    if (agentResearchSourceOwner(deps.toolRegistry) !== sourceOwner) throw new Error('Workspace source owner changed.');
  };
  const retainCurrent = retainHarnessCatalogCurrent(args);
  retainCurrent(sourceCurrent, 'workspace:original-source-owner');
  const request = captureStatefulCatalogRequest(deps.commandContext, args, {
    signal: options?.signal, sourceOwner, retainCurrent,
    assertCurrent: () => { assertExecution(); sourceCurrent(); },
  });
  const effectCatalogOptions = request.options;
  const resolved = await resolveWorkspaceActionDetail(args, effectCatalogOptions);
  request.assertCurrent();
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
    return runTranslatedWorkspaceCommand(deps, args, action.command, options);
  }
  if (action.kind === 'settings-import') {
    if (!isAgentSettingsImportMutation('agent_harness', args)) {
      try {
        const assertOptions = options ? captureCatalogMethods(options, ['signal', 'assertCurrent', 'inputProjectionContext']) : () => {};
        const signal = options?.signal;
        const original = JSON.stringify(captureModelReadingInput(args));
        const assertDeps = captureCatalogMethods(deps, ['commandContext', 'toolRegistry']);
        const assertExecution = harnessCatalogExecutionGuard(args, options);
        signal?.throwIfAborted(); assertExecution();
        const sourceOwner = agentResearchSourceOwner(deps.toolRegistry);
        const capture = capturedHarnessSettingsImportPreview(args, options, deps.commandContext, deps.toolRegistry);
        const assertCurrent = () => {
          assertOptions(); assertDeps(); signal?.throwIfAborted(); assertExecution();
          assertModelReadingInputCurrent(args, original); capture.assertCurrent();
          if (agentResearchSourceOwner(deps.toolRegistry) !== sourceOwner) throw new Error('Settings import reader changed.');
        };
        assertCurrent();
        const retainCurrent = retainHarnessCatalogCurrent(args);
        retainCurrent(capture.assertCurrent, 'settings-import.preview-source');
        return await withModelReadingSource({ preview: capture.preview, sources: capture.sourceViews },
          { signal, sourceOwner, assertCurrent, retainCurrent }, async captured => {
            assertCurrent();
            return output({ status: 'confirmation_required', action: describeWorkspaceAction(category, action, { lookup }),
              preview: captured.preview, next: 'Use action:"import" with current recorded settings admission to apply this source.' });
          });
      } catch { return error('Settings import preview is unavailable or its captured source is no longer current.'); }
    }
    try { return await executeAdmittedAgentSettingsImport(deps.commandContext, args, options); }
    catch { return error('Settings import requires a current recorded effect-owner admission.'); }
  }
  if (action.kind === 'setup-checkpoint') {
    const operation = action.setupCheckpointOperation ?? 'show';
    if (operation === 'show') {
      const checkpoint = await setupCheckpointSummary(deps.commandContext, effectCatalogOptions);
      request.assertCurrent();
      return output({
        status: 'checkpoint_inspected',
        action: describeWorkspaceAction(category, action, { lookup }),
        checkpoint,
      });
    }
    const confirmationError = requireConfirmedAction(args, options, operation === 'clear' ? 'Setup wizard checkpoint clear' : 'Setup wizard checkpoint save');
    if (confirmationError) return error(confirmationError);
    const result = operation === 'clear'
      ? clearSetupCheckpoint(deps.commandContext, args, options)
      : await markSetupCheckpoint(deps.commandContext, args, options);
    return output({
      status: 'checkpoint_action_completed',
      action: describeWorkspaceAction(category, action, { lookup }),
      result,
    });
  }
  if (action.kind === 'editor' && action.editorKind) {
    const editor = createWorkspaceEditor(action.editorKind, buildWorkspaceEditorContext(deps.commandContext, args));
    if (!editor) return error(`No workspace editor route exists for ${action.editorKind}.`);
    return runWorkspaceEditorAction(deps, action, editor, args, options);
  }
  if (action.kind === 'local-selection' || action.kind === 'local-operation') {
    return runLocalWorkspaceAction(deps, action, args, options);
  }
  if (action.kind === 'onboarding-complete') {
    const confirmationError = requireConfirmedAction(args, options, 'Onboarding completion');
    if (confirmationError) return error(confirmationError);
    const explicitUserRequest = readString(args.explicitUserRequest);
    const shellPaths = deps.commandContext.workspace?.shellPaths;
    if (!shellPaths) return error('Onboarding completion requires Agent shell paths.');
    const assertCurrent = captureHarnessLocalEffect(deps.commandContext, args, options, paths => [getOnboardingCheckMarkerPath(paths), getOnboardingCompletionMarkerPath(paths)]);
    const marker = { scope: 'user', source: 'wizard', mode: 'new', workspaceRoot: shellPaths.workingDirectory } as const;
    assertCurrent();
    const checkMarker = writeOnboardingCheckMarker(shellPaths, marker);
    assertCurrent();
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
