import { clearSetupWizardCheckpoint, readSetupWizardCheckpoint, saveSetupWizardCheckpoint } from '../agent/setup-wizard-checkpoint.ts';
import type { CommandContext } from './command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

interface AgentWorkspaceSetupCheckpointTarget {
  readonly context: CommandContext | null;
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  readonly setRuntimeSnapshot: (snapshot: AgentWorkspaceRuntimeSnapshot | null) => void;
  readonly setStatus: (status: string) => void;
  readonly setLastActionResult: (result: AgentWorkspaceActionResult) => void;
  readonly clampSelection: () => void;
}

export function applyAgentWorkspaceSetupCheckpointAction(
  target: AgentWorkspaceSetupCheckpointTarget,
  action: AgentWorkspaceAction,
  requestRender?: () => void,
): void {
  const shellPaths = target.context?.workspace?.shellPaths;
  if (!shellPaths || typeof shellPaths.resolveUserPath !== 'function') {
    target.setStatus('Setup checkpoint storage is unavailable.');
    target.setLastActionResult({
      kind: 'error',
      title: 'Setup checkpoint unavailable',
      detail: 'The Agent workspace cannot locate Agent shell paths for setup checkpoint storage.',
      safety: action.safety,
    });
    requestRender?.();
    return;
  }

  const refreshSnapshot = (): void => {
    target.setRuntimeSnapshot(target.context ? buildAgentWorkspaceRuntimeSnapshot(target.context) : target.runtimeSnapshot);
    target.clampSelection();
  };

  try {
    const operation = action.setupCheckpointOperation ?? 'show';
    if (operation === 'show') {
      const checkpoint = readSetupWizardCheckpoint(shellPaths);
      const detail = checkpoint.checkpoint
        ? `Saved setup checkpoint: ${checkpoint.checkpoint.currentStepLabel} (${checkpoint.checkpoint.currentStepId}) at ${checkpoint.checkpoint.savedAt}.`
        : checkpoint.exists
          ? `Saved setup checkpoint could not be read: ${checkpoint.parseError ?? 'invalid checkpoint file'}.`
          : 'No setup wizard checkpoint is saved yet.';
      target.setStatus(checkpoint.checkpoint ? 'Setup checkpoint loaded.' : 'No setup checkpoint saved.');
      target.setLastActionResult({
        kind: checkpoint.exists && !checkpoint.checkpoint ? 'error' : 'guidance',
        title: 'Setup checkpoint',
        detail,
        safety: action.safety,
      });
      requestRender?.();
      return;
    }

    if (operation === 'clear') {
      const before = readSetupWizardCheckpoint(shellPaths);
      const checkpoint = clearSetupWizardCheckpoint(shellPaths);
      refreshSnapshot();
      target.setStatus(before.exists ? 'Setup checkpoint cleared.' : 'No setup checkpoint was saved.');
      target.setLastActionResult({
        kind: 'refreshed',
        title: 'Setup checkpoint cleared',
        detail: before.exists
          ? `Cleared the Agent-owned setup wizard checkpoint at ${checkpoint.path}.`
          : `No Agent-owned setup wizard checkpoint existed at ${checkpoint.path}.`,
        safety: action.safety,
      });
      requestRender?.();
      return;
    }

    const wizard = target.runtimeSnapshot?.setupWizard;
    const current = wizard?.currentStepId
      ? wizard.steps.find((step) => step.id === wizard.currentStepId) ?? null
      : null;
    if (!current) {
      target.setStatus('No current setup wizard step to save.');
      target.setLastActionResult({
        kind: 'guidance',
        title: 'Setup checkpoint not saved',
        detail: 'The setup wizard is complete or unavailable, so there is no current step to resume.',
        safety: action.safety,
      });
      requestRender?.();
      return;
    }
    if (current.sourceStatus === 'ready') {
      target.setStatus('Setup checkpoint not saved.');
      target.setLastActionResult({
        kind: 'guidance',
        title: 'Setup checkpoint not saved',
        detail: `${current.label} is already ready; use the next live setup step instead.`,
        safety: action.safety,
      });
      requestRender?.();
      return;
    }
    const checkpoint = saveSetupWizardCheckpoint(shellPaths, {
      currentStepId: current.id,
      currentStepLabel: current.label,
      source: 'workspace',
      note: 'User-selected setup wizard checkpoint.',
    });
    refreshSnapshot();
    target.setStatus(`Saved setup checkpoint for ${current.label}.`);
    target.setLastActionResult({
      kind: 'refreshed',
      title: 'Setup checkpoint saved',
      detail: `Saved ${current.label} (${current.id}) as the Agent-owned setup resume point at ${checkpoint.path}.`,
      safety: action.safety,
    });
    requestRender?.();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    target.setStatus('Setup checkpoint action failed.');
    target.setLastActionResult({
      kind: 'error',
      title: 'Setup checkpoint action failed',
      detail,
      safety: action.safety,
    });
    requestRender?.();
  }
}
