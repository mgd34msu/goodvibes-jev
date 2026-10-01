import type {
  AgentWorkspace,
  AgentWorkspaceAction,
  AgentWorkspaceCategory,
  AgentWorkspaceLocalEditor,
  AgentWorkspaceRuntimeSnapshot,
} from '../input/agent-workspace.ts';
import type { AgentWorkspaceEditorKind } from '../input/agent-workspace-types.ts';
import type { AgentWorkspaceSetupChecklistItem } from '../input/agent-workspace-setup.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { wrapText } from '../utils/terminal-width.ts';
import { GLYPHS } from './ui-primitives.ts';
import {
  getFullscreenWorkspaceMetrics,
  padDisplay,
  renderFullscreenWorkspace,
  stableWindow,
  WORKSPACE_PALETTE as PALETTE,
  type WorkspaceRow,
} from './fullscreen-workspace.ts';
import {
  buildActionResultRows,
  reserveForResult,
  settleResultScroll,
  windowResultRows,
} from './agent-workspace-result-rows.ts';

/**
 * Rows the actions pane spends on things that are not action items or result
 * lines: its column header, the blank separator, the status line, and the two
 * possible more-above/more-below markers. Counted so the split does not promise
 * the result room that the chrome has already taken, getting this wrong is
 * what let the result be squeezed out of a short pane entirely.
 */
const ACTION_CHROME_ROWS = 5;

/**
 * The subset of the workspace palette the result block draws with, read per
 * call so it follows the active theme (PALETTE itself is rebuilt in place).
 */
function resultPalette(): { text: string; good: string; muted: string; dim: string } {
  return {
    text: PALETTE.text,
    good: PALETTE.good,
    muted: PALETTE.muted,
    dim: PALETTE.dim,
  };
}
import { actionResultColor, type AgentWorkspaceContextLine as ContextLine } from './agent-workspace-style.ts';
import { buildEditorRows } from './agent-workspace-editor-rows.ts';
import { compactText, reviewerReadinessContextLines, snapshotLines } from './agent-workspace-context-lines.ts';
import { ONBOARDING_COMPLETE_SYNTHETIC_ACTION, ONBOARDING_CRITICAL_STEP_IDS } from '../input/agent-workspace-onboarding-finish.ts';

function onboardingCategoryReadiness(
  category: AgentWorkspaceCategory,
  checklist: readonly AgentWorkspaceSetupChecklistItem[],
): 'ready' | 'attention' | 'optional' {
  const CATEGORY_CHECKLIST_MAP: Record<string, readonly string[]> = {
    'setup': ['provider-model', 'connected-host-auth', 'runtime'],
    'account-model': ['provider-model', 'subscriptions'],
    'assistant-behavior': [],
    'tools-permissions': [],
    'onboarding-display': [],
    'onboarding-channels': ['channels'],
    'onboarding-voice-media': ['voice-media'],
    'onboarding-context': ['agent-knowledge', 'persona', 'skills', 'routines', 'memory', 'notes', 'profile'],
    'onboarding-automation': [],
  };
  const itemIds = CATEGORY_CHECKLIST_MAP[category.id];
  if (!itemIds || itemIds.length === 0) return 'optional';
  const mapped = itemIds.map((id) => checklist.find((item) => item.id === id));
  if (mapped.every((item) => item?.status === 'ready')) return 'ready';
  if (mapped.some((item) => item?.status === 'blocked' || item?.status === 'recommended')) return 'attention';
  return 'optional';
}

function buildLeftRows(workspace: AgentWorkspace, height: number): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  let selectedRenderedIndex = 0;
  let lastGroup = '';
  const checklist = workspace.runtimeSnapshot?.setupChecklist ?? [];

  workspace.categories.forEach((category, index) => {
    if (category.group !== lastGroup) {
      rows.push({ text: category.group, kind: 'group', bold: true });
      lastGroup = category.group;
    }
    const selected = index === workspace.selectedCategoryIndex;
    if (selected) selectedRenderedIndex = rows.length;
    const marker = selected ? GLYPHS.navigation.selected : ' ';
    let readinessGlyph = '';
    let readinessFg: string | undefined;
    if (isOnboardingCategory(category)) {
      const readiness = onboardingCategoryReadiness(category, checklist);
      if (readiness === 'ready') {
        readinessGlyph = GLYPHS.status.success;
        readinessFg = PALETTE.good;
      } else if (readiness === 'attention') {
        readinessGlyph = '!';
        readinessFg = PALETTE.warn;
      }
    }
    const readinessMark = readinessGlyph ? `${readinessGlyph} ` : '  ';
    rows.push({
      text: `  ${marker} ${readinessMark}${category.label}`,
      selected: selected && workspace.focusPane === 'categories',
      kind: 'item',
      fg: selected ? PALETTE.text : readinessFg ?? PALETTE.muted,
      bold: selected,
    });
  });

  const visible = Math.max(1, height);
  const window = stableWindow(rows.length, selectedRenderedIndex, visible);
  const visibleRows = rows.slice(window.start, window.end);
  if (window.start > 0 && visibleRows.length > 0) {
    visibleRows[0] = { text: `${GLYPHS.navigation.moreAbove} ${window.start} more`, kind: 'more', fg: PALETTE.dim, dim: true };
  }
  if (window.end < rows.length && visibleRows.length > 0) {
    visibleRows[visibleRows.length - 1] = { text: `${GLYPHS.navigation.moreBelow} ${rows.length - window.end} more`, kind: 'more', fg: PALETTE.dim, dim: true };
  }
  while (visibleRows.length < height) visibleRows.push({ text: '', kind: 'empty' });
  return visibleRows.slice(0, height);
}

function actionCommand(action: AgentWorkspaceAction): string {
  if (action.kind === 'workspace') return 'open area';
  if (action.kind === 'editor') return action.editorKind ? `edit ${action.editorKind}` : 'edit form';
  if (action.kind === 'setting') return action.settingKey ? `setting ${action.settingKey}` : 'setting';
  if (action.kind === 'settings-import') return 'import GoodVibes settings';
  if (action.kind === 'setup-checkpoint') return action.setupCheckpointOperation ? `setup checkpoint ${action.setupCheckpointOperation}` : 'setup checkpoint';
  if (action.kind === 'model-picker') return action.modelPickerFlow === 'model' ? 'model picker' : 'provider/model picker';
  if (action.kind === 'settings-modal') return action.settingsTarget ? `settings ${action.settingsTarget}` : 'settings';
  if (action.kind === 'local-selection') return action.selectionDelta && action.selectionDelta < 0 ? 'select previous' : 'select next';
  if (action.kind === 'local-operation') return action.localOperation ?? '(local action)';
  if (action.kind === 'onboarding-complete') return 'apply and close';
  return action.command ?? '(guidance)';
}

function isOnboardingCategory(category: AgentWorkspaceCategory): boolean {
  return category.group === 'ONBOARDING';
}

interface OnboardingActionColumns {
  readonly setting: string;
  readonly defaultValue: string;
  readonly currentValue: string;
}

function editorPurposeLabel(editorKind: AgentWorkspaceEditorKind): string {
  switch (editorKind) {
    case 'mcp-server': return 'Edit MCP server';
    case 'mcp-tools-server': return 'Edit MCP tools server';
    case 'mcp-repair': return 'Repair MCP connection';
    case 'secret-link': return 'Link secret reference';
    case 'secret-set': return 'Store secret';
    case 'secret-test': return 'Test secret reference';
    case 'secret-delete': return 'Delete secret';
    case 'subscription-login-start': return 'Sign in to provider';
    case 'subscription-login-finish': return 'Finish provider sign-in';
    case 'subscription-logout': return 'Sign out of provider';
    case 'subscription-inspect': return 'Inspect subscription';
    case 'provider-add': return 'Add custom provider';
    case 'provider-remove': return 'Remove custom provider';
    case 'provider-use': return 'Choose provider';
    case 'provider-inspect': return 'Inspect provider';
    case 'provider-routes': return 'Edit provider routes';
    case 'provider-account-repair': return 'Repair provider account';
    case 'memory': return 'Edit memory';
    case 'memory-search': return 'Search memory';
    case 'memory-get': return 'Get memory record';
    case 'memory-explain': return 'Explain memory';
    case 'memory-promote': return 'Promote memory';
    case 'memory-link': return 'Link memory';
    case 'memory-export': return 'Export memory';
    case 'memory-import': return 'Import memory';
    case 'memory-handoff-export': return 'Export memory handoff';
    case 'memory-handoff-inspect': return 'Inspect memory handoff';
    case 'memory-handoff-import': return 'Import memory handoff';
    case 'memory-vector-rebuild': return 'Rebuild memory vectors';
    case 'note': return 'Edit note';
    case 'persona': return 'Edit persona';
    case 'persona-search': return 'Search personas';
    case 'persona-show': return 'Show persona';
    case 'persona-discovery-import': return 'Import persona files';
    case 'skill': return 'Edit skill';
    case 'skill-search': return 'Search skills';
    case 'skill-show': return 'Show skill';
    case 'skill-discovery-import': return 'Import skill files';
    case 'skill-standard-import': return 'Import shared skill';
    case 'skill-standard-export': return 'Export skill to share';
    case 'routine': return 'Edit routine';
    case 'routine-search': return 'Search routines';
    case 'routine-show': return 'Show routine';
    case 'routine-discovery-import': return 'Import routine files';
    case 'profile': return 'Edit profile';
    case 'profile-from-discovered': return 'Create profile from files';
    case 'profile-show': return 'Show profile';
    case 'profile-default': return 'Set default profile';
    case 'profile-default-clear': return 'Clear default profile';
    case 'profile-delete': return 'Delete profile';
    case 'profile-template-export': return 'Export profile template';
    case 'profile-template-import': return 'Import profile template';
    case 'profile-template-show': return 'Show profile template';
    case 'profile-template-from-discovered': return 'Create template from files';
    case 'knowledge-url': return 'Ingest URL';
    case 'knowledge-urls': return 'Ingest URLs';
    case 'knowledge-file': return 'Ingest file';
    case 'knowledge-bookmarks': return 'Import bookmarks';
    case 'knowledge-browser-history': return 'Import browser history';
    case 'knowledge-connector-ingest': return 'Run connector ingest';
    case 'knowledge-connector-show': return 'Show connector';
    case 'knowledge-connector-doctor': return 'Check connector health';
    case 'knowledge-reindex': return 'Reindex knowledge';
    case 'knowledge-search': return 'Search knowledge';
    case 'knowledge-ask': return 'Ask knowledge';
    case 'knowledge-get': return 'Get knowledge record';
    case 'knowledge-map': return 'Map knowledge';
    case 'knowledge-review-issue': return 'Review knowledge issue';
    case 'knowledge-consolidate': return 'Consolidate knowledge';
    case 'knowledge-packet': return 'Build knowledge packet';
    case 'knowledge-explain': return 'Explain knowledge';
    case 'delegate-task': return 'Delegate build task';
    case 'document-browse': return 'Browse documents';
    case 'document-show': return 'Show document';
    case 'document-create': return 'Create document';
    case 'document-update': return 'Revise document';
    case 'document-review': return 'Review document';
    case 'document-comment': return 'Add comment';
    case 'document-resolve-comment': return 'Resolve comment';
    case 'document-suggest': return 'Propose suggestion';
    case 'document-accept-suggestion': return 'Accept suggestion';
    case 'document-reject-suggestion': return 'Reject suggestion';
    case 'document-insert-artifact': return 'Insert artifact';
    case 'document-attach-artifact': return 'Attach artifact';
    case 'document-export': return 'Export document';
    case 'document-reviewer-readiness': return 'Review readiness preflight';
    case 'document-review-packet-wizard': return 'Run packet wizard';
    case 'document-review-packet-preset': return 'Save packet preset';
    case 'document-review-packet-preset-refresh': return 'Refresh packet preset';
    case 'document-review-packet-share': return 'Share review packet';
    case 'model-compare': return 'Compare models';
    case 'model-compare-review': return 'Review comparison';
    case 'model-compare-handoff-diff': return 'Diff reviewer handoffs';
    case 'model-compare-judge': return 'Judge comparison';
    case 'model-compare-apply': return 'Apply comparison winner';
    case 'model-compare-route-decision': return 'Record route decision';
    case 'model-compare-export': return 'Export comparison';
    case 'model-compare-analytics': return 'View comparison analytics';
    case 'local-model-benchmark': return 'Run local benchmark';
    case 'auth-show': return 'Show auth status';
    case 'auth-repair': return 'Repair auth';
    case 'auth-bundle-export': return 'Export auth bundle';
    case 'auth-bundle-inspect': return 'Inspect auth bundle';
    case 'trust-bundle-export': return 'Export trust bundle';
    case 'trust-bundle-inspect': return 'Inspect trust bundle';
    case 'support-bundle-export': return 'Export support bundle';
    case 'support-bundle-inspect': return 'Inspect support bundle';
    case 'support-bundle-import': return 'Import support bundle';
    case 'subscription-bundle-export': return 'Export subscription bundle';
    case 'subscription-bundle-inspect': return 'Inspect subscription bundle';
    case 'voice-enable': return 'Enable voice';
    case 'voice-disable': return 'Disable voice';
    case 'voice-bundle-export': return 'Export voice bundle';
    case 'voice-bundle-inspect': return 'Inspect voice bundle';
    case 'tts-prompt': return 'Test TTS prompt';
    case 'image-input': return 'Attach image';
    case 'artifact-browser': return 'Browse artifacts';
    case 'artifact-show': return 'Show artifact';
    case 'artifact-export-file': return 'Export artifact to file';
    case 'artifact-export-package': return 'Export artifact package';
    case 'artifact-promote-knowledge': return 'Promote artifact to knowledge';
    case 'media-generate': return 'Generate media';
    case 'conversation-export': return 'Export conversation';
    case 'conversation-events': return 'Show conversation events';
    case 'conversation-groups': return 'Show conversation groups';
    case 'conversation-find': return 'Find conversation';
    case 'effort-level': return 'Set effort level';
    case 'channel-show': return 'Show channel';
    case 'channel-doctor': return 'Check channel health';
    case 'channel-setup': return 'Set up channel';
    case 'channel-send': return 'Send to channel';
    case 'session-save': return 'Save session';
    case 'session-load': return 'Load session';
    case 'session-rename': return 'Rename session';
    case 'session-resume': return 'Resume session';
    case 'session-info': return 'Inspect session';
    case 'session-export-saved': return 'Export saved session';
    case 'session-search': return 'Search sessions';
    case 'session-delete': return 'Delete session';
    case 'session-fork': return 'Fork session';
    case 'session-graph': return 'Inspect session graph';
    case 'owner-profile-read': return 'Read your profile';
    case 'owner-profile-get': return 'Show a profile field';
    case 'owner-profile-person': return 'Look up one person';
    case 'owner-profile-provenance': return 'Trace where a fact came from';
    case 'owner-profile-set': return 'Correct a profile fact';
    case 'owner-profile-forget': return 'Forget a profile fact';
    case 'owner-profile-forget-note': return 'Forget a note or person';
    case 'owner-profile-status': return 'Check profile status';
    case 'task-list-filter': return 'Filter task list';
    case 'task-show': return 'Show task';
    case 'task-output': return 'View task output';
    case 'plan-seed': return 'Seed plan';
    case 'plan-show': return 'Show plan';
    case 'plan-approve': return 'Approve plan';
    case 'plan-override': return 'Override plan';
    case 'plan-clear': return 'Clear plan';
    case 'health-repair': return 'Repair health issue';
    case 'approval-review': return 'Review approval';
    case 'approval-approve': return 'Approve request';
    case 'approval-deny': return 'Deny request';
    case 'approval-cancel': return 'Cancel approval';
    case 'automation-job-run': return 'Run automation job';
    case 'automation-job-pause': return 'Pause automation job';
    case 'automation-job-resume': return 'Resume automation job';
    case 'automation-run-cancel': return 'Cancel automation run';
    case 'automation-run-retry': return 'Retry automation run';
    case 'schedule-run': return 'Run schedule';
    case 'schedule-edit': return 'Edit schedule';
    case 'routine-receipt': return 'View routine receipt';
    case 'schedule-receipt': return 'View schedule receipt';
    case 'mode-preset': return 'Set mode preset';
    case 'mode-domain': return 'Set mode domain';
    case 'setting-set': return 'Set setting';
    case 'model-pin': return 'Pin model';
    case 'model-unpin': return 'Unpin model';
    case 'workplan-add': return 'Add work item';
    case 'workplan-show': return 'Show work plan';
    case 'workplan-status': return 'Check work plan status';
    case 'workplan-delete': return 'Delete work item';
    case 'workplan-clear-completed': return 'Clear completed items';
    case 'routine-schedule': return 'Schedule routine';
    case 'reminder-schedule': return 'Schedule reminder';
    case 'skill-bundle': return 'Edit skill bundle';
    case 'skill-bundle-search': return 'Search skill bundles';
    case 'skill-bundle-show': return 'Show skill bundle';
    case 'skill-bundle-update': return 'Update skill bundle';
    case 'skill-bundle-enable': return 'Enable skill bundle';
    case 'skill-bundle-disable': return 'Disable skill bundle';
    case 'skill-bundle-review': return 'Review skill bundle';
    case 'skill-bundle-stale': return 'Mark bundle stale';
    case 'skill-bundle-delete': return 'Delete skill bundle';
    case 'learned-behavior': return 'Review learned behavior';
    case 'web-research': return 'Run web research';
    case 'web-fetch': return 'Fetch from web';
    case 'research-run': return 'Run research';
    case 'research-source': return 'Manage research source';
    case 'research-report': return 'Show research report';
    case 'notify-webhook': return 'Add notification webhook';
    case 'notify-webhook-remove': return 'Remove notification webhook';
    case 'notify-webhook-clear': return 'Clear notification webhooks';
    case 'notify-webhook-test': return 'Test notification webhook';
    case 'notify-send': return 'Send notification';
    default: return `Edit ${editorKind}`;
  }
}

function localOperationLabel(localOperation: string): string {
  switch (localOperation) {
    case 'routine-start': return 'Start routine';
    case 'persona-activate':
    case 'persona-use': return 'Activate persona';
    case 'persona-clear': return 'Deactivate persona';
    case 'persona-edit': return 'Edit persona';
    case 'persona-review': return 'Review persona';
    case 'persona-delete': return 'Delete persona';
    case 'memory-edit': return 'Edit memory';
    case 'memory-review': return 'Review memory';
    case 'memory-stale': return 'Mark memory stale';
    case 'memory-delete': return 'Delete memory';
    case 'note-edit': return 'Edit note';
    case 'note-review': return 'Review note';
    case 'note-stale': return 'Mark note stale';
    case 'note-delete': return 'Delete note';
    case 'note-promote-memory': return 'Promote note to memory';
    case 'note-promote-persona': return 'Promote note to persona';
    case 'note-promote-skill': return 'Promote note to skill';
    case 'note-promote-routine': return 'Promote note to routine';
    case 'note-promote-knowledge-url': return 'Promote note to knowledge';
    case 'skill-edit': return 'Edit skill';
    case 'skill-enable': return 'Enable skill';
    case 'skill-disable': return 'Disable skill';
    case 'skill-review': return 'Review skill';
    case 'skill-delete': return 'Delete skill';
    case 'routine-edit': return 'Edit routine';
    case 'routine-enable': return 'Enable routine';
    case 'routine-disable': return 'Disable routine';
    case 'routine-review': return 'Review routine';
    case 'routine-delete': return 'Delete routine';
    default: return 'Apply local action';
  }
}

function onboardingActionLabel(workspace: AgentWorkspace, action: AgentWorkspaceAction): string {
  if (action.kind === 'settings-import') return 'Import GoodVibes preferences';
  if (action.kind === 'setup-checkpoint') {
    if (action.setupCheckpointOperation === 'show') return 'Review saved progress';
    if (action.setupCheckpointOperation === 'mark-current') return 'Save progress';
    if (action.setupCheckpointOperation === 'clear') return 'Clear saved progress';
    return 'Review setup progress';
  }
  if (action.kind === 'model-picker') return action.modelPickerFlow === 'model' ? 'Choose model' : 'Choose provider and model';
  if (action.kind === 'settings-modal') return 'Open settings';
  if (action.kind === 'workspace') {
    if (action.targetCategoryId) {
      const target = workspace.categories.find((c) => c.id === action.targetCategoryId);
      const label = target ? target.label : action.targetCategoryId;
      return `Switch to ${label}`;
    }
    return 'Switch to setup area';
  }
  if (action.kind === 'editor') return action.editorKind ? editorPurposeLabel(action.editorKind) : 'Open form';
  if (action.kind === 'local-selection') return 'Move selection';
  if (action.kind === 'local-operation') return action.localOperation ? localOperationLabel(action.localOperation) : 'Apply local action';
  if (action.kind === 'onboarding-complete') return 'Finish setup';
  if (action.kind === 'command') {
    const cmd = action.command ?? '';
    return action.commandBehavior === 'inline' ? `Run: ${cmd}` : `Open: ${cmd}`;
  }
  if (action.safety === 'read-only') return 'Review';
  if (action.safety === 'blocked') return 'Unavailable in this setup step';
  return 'Open';
}

function onboardingActionColumns(workspace: AgentWorkspace, action: AgentWorkspaceAction): OnboardingActionColumns {
  if (action.kind === 'setting') {
    return workspace.settingActionDisplay(action) ?? {
      setting: action.label,
      defaultValue: '(unknown)',
      currentValue: '(unknown)',
    };
  }
  // Non-setting rows keep the 3-column layout but use placeholders for Default and Current,
  // since those concepts only make sense for actual settings. The action label carries
  // the meaning of the row.
  return {
    setting: action.label,
    defaultValue: '—',
    currentValue: '—',
  };
}

function actionChange(workspace: AgentWorkspace, category: AgentWorkspaceCategory, action: AgentWorkspaceAction): string {
  // Always show the action label via onboardingActionColumns for consistency across categories.
  return onboardingActionColumns(workspace, action).setting;
}

function actionMetaLine(workspace: AgentWorkspace, category: AgentWorkspaceCategory, action: AgentWorkspaceAction): ContextLine {
  // Same About-style detail line on every category.
  return {
    text: `About: ${compactText(action.detail, 100)}`,
    fg: action.safety === 'blocked' ? PALETTE.warn : PALETTE.muted,
  };
}

function shouldRenderOnboardingSettingsTable(actions: readonly AgentWorkspaceAction[]): boolean {
  // Always use the Setting/Default/Current 3-column layout on ONBOARDING pages so the
  // user gets a consistent visual structure across every category, even ones that mix
  // settings with editors, guidance, or pickers. Non-setting rows fill Default/Current
  // with placeholders via onboardingActionColumns().
  const nonFinish = actions.filter((a) => a.kind !== 'onboarding-complete');
  return nonFinish.length > 0;
}

function editorContextLines(editor: AgentWorkspaceLocalEditor, snapshot: AgentWorkspaceRuntimeSnapshot | null): ContextLine[] {
  const selected = editor.fields[editor.selectedFieldIndex];
  const lines: ContextLine[] = [
    { text: editor.title, fg: PALETTE.title, bold: true },
    { text: compactText(editor.message), fg: editor.message.includes('required') || editor.message.includes('cannot') || editor.message.includes('Cannot') ? PALETTE.warn : PALETTE.info },
    { text: 'Enter next/save; Ctrl-J newline; Esc cancel.', fg: PALETTE.muted },
  ];
  if (selected) {
    lines.push(
      { text: `Editing: ${selected.label}${selected.required ? ' (required)' : ''}`, fg: PALETTE.title, bold: true },
      { text: compactText(selected.hint), fg: PALETTE.muted },
    );
  }
  lines.push(...reviewerReadinessContextLines(editor, snapshot));
  if (editor.kind === 'model-compare-handoff-diff') {
    const left = editor.fields.find((field) => field.id === 'leftArtifactId')?.value.trim();
    const right = editor.fields.find((field) => field.id === 'rightArtifactId')?.value.trim();
    lines.push(
      { text: 'Split view: compare left and right reviewer handoff artifacts without changing model routing.', fg: PALETTE.good },
      { text: 'Section jumps: all, metadata, policy, related, comparison.', fg: PALETTE.info },
      left && right
        ? { text: `Current diff: ${left} -> ${right}.`, fg: PALETTE.good }
        : { text: 'No complete handoff pair selected; submitting lists recent saved handoffs.', fg: PALETTE.info },
    );
    if (snapshot?.recentReviewerHandoffArtifacts.length) {
      const choices = snapshot.recentReviewerHandoffArtifacts
        .slice(0, 4)
        .map((artifact) => `${artifact.id} (${artifact.sourceKind}; related ${artifact.relatedArtifactCount})`)
        .join(', ');
      lines.push({ text: `Recent choices: ${choices}.`, fg: PALETTE.muted });
    }
  } else if (editor.kind === 'document-reviewer-readiness') {
    lines.push(
      { text: 'Preflight checks: comments, suggestions, source artifacts, comparison reveal, route decisions, handoff evidence.', fg: PALETTE.info },
      { text: 'Use before export, handoff archive, or applying a comparison winner.', fg: PALETTE.good },
    );
  }
  return lines;
}

function buildContextRows(workspace: AgentWorkspace, category: AgentWorkspaceCategory, action: AgentWorkspaceAction | null, width: number): WorkspaceRow[] {
  const lines: ContextLine[] = [
    { text: category.label, fg: PALETTE.title, bold: true },
    { text: category.summary, fg: PALETTE.subtitle },
    ...(workspace.actionSearchActive ? [
      { text: 'Action Search', fg: PALETTE.title, bold: true },
      {
        text: workspace.actionSearchQuery.length > 0
          ? `Query: ${workspace.actionSearchQuery} (${workspace.actionSearchResults.length} result${workspace.actionSearchResults.length === 1 ? '' : 's'})`
          : 'Type to search every Agent workspace action.',
        fg: workspace.actionSearchQuery.length > 0 && workspace.actionSearchResults.length === 0 ? PALETTE.warn : PALETTE.info,
      },
      { text: 'Enter opens; Esc clears.', fg: PALETTE.muted },
    ] satisfies ContextLine[] : []),
    ...(workspace.localEditor ? editorContextLines(workspace.localEditor, workspace.runtimeSnapshot) : []),
  ];

  const selectedActionLines: ContextLine[] = action
    ? [
      { text: `Selected: ${action.label}`, fg: PALETTE.title, bold: true },
      actionMetaLine(workspace, category, action),
    ]
    : [];
  const snapshotContextLines = snapshotLines(workspace, category, workspace.runtimeSnapshot);
  lines.push(...selectedActionLines, ...snapshotContextLines);

  const onboarding = isOnboardingCategory(category);
  if (workspace.lastActionResult) {
    lines.push(
      { text: onboarding ? 'Result' : 'Action Result', fg: PALETTE.title, bold: true },
      { text: workspace.lastActionResult.title, fg: actionResultColor(workspace.lastActionResult), bold: true },
      { text: compactText(workspace.lastActionResult.detail), fg: PALETTE.text },
    );
    if (!onboarding && workspace.lastActionResult.command) {
      lines.push({ text: `Command: ${workspace.lastActionResult.command}`, fg: PALETTE.muted });
    }
  }

  return lines.flatMap((entry): WorkspaceRow[] => {
    if (entry.text.length === 0) return [{ text: '', kind: 'empty', dim: true }];
    return wrapText(entry.text, Math.max(1, width)).map((text, index): WorkspaceRow => ({
      text,
      fg: entry.fg,
      bold: entry.bold && index === 0,
      dim: entry.dim,
    }));
  });
}

function onboardingFinishPrerequisitesMet(workspace: AgentWorkspace): boolean {
  const checklist = workspace.runtimeSnapshot?.setupChecklist ?? [];
  return ONBOARDING_CRITICAL_STEP_IDS.every((id) => checklist.find((item) => item.id === id)?.status === 'ready');
}

function buildActionRows(workspace: AgentWorkspace, width: number, height: number): WorkspaceRow[] {
  if (workspace.localEditor) return buildEditorRows(workspace.localEditor, width, height);
  const category = workspace.selectedActionCategory;
  const onboarding = isOnboardingCategory(category);
  // Apply the consistent Setting/Default/Current 3-column layout to EVERY category, not
  // just the ONBOARDING group. Different layouts across pages were confusing.
  const settingTable = !workspace.actionSearchActive
    && shouldRenderOnboardingSettingsTable(workspace.actions);
  const rows: WorkspaceRow[] = [];
  const valueWidth = settingTable
    ? Math.min(22, Math.max(10, Math.floor(width * 0.18)))
    : 0;
  const labelWidth = settingTable
    ? Math.max(18, width - (valueWidth * 2) - 6)
    : Math.min(34, Math.max(18, Math.floor(width * 0.38)));
  const commandWidth = Math.max(10, width - labelWidth - 6);
  if (workspace.actionSearchActive) {
    rows.push({
      text: `  Search: ${workspace.actionSearchQuery || '(type to filter actions)'}`,
      fg: workspace.actionSearchQuery.length > 0 && workspace.actions.length === 0 ? PALETTE.warn : PALETTE.info,
      bold: true,
    });
  }
  rows.push({
    text: settingTable
      ? `  ${padDisplay(workspace.actionSearchActive ? 'Result' : 'Setting', labelWidth)}  ${padDisplay('Default', valueWidth)}  ${padDisplay('Current', valueWidth)}`
      : `  ${padDisplay(workspace.actionSearchActive ? 'Result' : onboarding ? 'Option' : 'Action', labelWidth)}  ${padDisplay('Does', commandWidth)}`,
    fg: PALETTE.muted,
    bold: true,
  });

  // The finish footer row is appended to workspace.actions by the input layer
  // (shouldShowOnboardingFinishFooter). Detect it here by action id for special styling.
  const allActions = workspace.actions;
  const finishActionIndex = allActions.findIndex((a) => a.id === ONBOARDING_COMPLETE_SYNTHETIC_ACTION.id);

  // The result block is measured before the action list is windowed, so the
  // list gives up the room the result needs instead of the result being cut off
  // the bottom. Anything the result still cannot fit is reachable by scrolling.
  const chromeRows = workspace.actionSearchActive ? 3 : 2;
  const resultRows = workspace.lastActionResult
    ? buildActionResultRows(workspace.lastActionResult, {
      onboarding,
      width,
      titleColor: actionResultColor(workspace.lastActionResult),
      palette: resultPalette(),
      moreAbove: GLYPHS.navigation.moreAbove,
      moreBelow: GLYPHS.navigation.moreBelow,
    })
    : [];
  // Rows the action list and the result share, once the pane's own headers, the
  // blank separator, the status line and the two possible action markers are
  // paid for. Reserving out of this, rather than out of the raw height, is
  // what stops the reservation promising room the chrome has already spent.
  const usableRows = Math.max(0, height - ACTION_CHROME_ROWS);
  const reservedForResult = reserveForResult(resultRows.length, usableRows);
  const resultScroll = settleResultScroll(workspace, workspace.lastActionResult, resultRows.length, reservedForResult);

  const visible = reservedForResult > 0
    ? Math.max(1, height - ACTION_CHROME_ROWS - reservedForResult)
    : Math.max(1, height - chromeRows);
  const window = stableWindow(allActions.length, workspace.selectedActionIndex, visible);
  if (window.start > 0) rows.push({ text: `${GLYPHS.navigation.moreAbove} ${window.start} more action(s) above`, kind: 'more', fg: PALETTE.dim, dim: true });

  for (let index = window.start; index < window.end; index += 1) {
    const action = allActions[index]!;
    const isFinishFooterRow = finishActionIndex >= 0 && index === finishActionIndex;
    const selected = index === workspace.selectedActionIndex;
    const searchResult = workspace.actionSearchActive ? workspace.actionSearchResults[index] : null;
    const actionCategory = searchResult?.category ?? category;
    const label = searchResult ? `${searchResult.category.label} / ${action.label}` : action.label;
    const marker = selected ? GLYPHS.navigation.selected : ' ';

    if (isFinishFooterRow) {
      // Sticky Finish setup footer row
      const prereqsMet = onboardingFinishPrerequisitesMet(workspace);
      const sep = `${GLYPHS.frame.horizontal.repeat(3)} Finish setup ${GLYPHS.frame.horizontal.repeat(3)}`;
      if (!selected) {
        rows.push({
          text: `  ${sep}`,
          kind: 'item',
          fg: PALETTE.dim,
          dim: true,
        });
      }
      const finishDetail = prereqsMet
        ? 'Finish setup'
        : (() => {
          const checklist = workspace.runtimeSnapshot?.setupChecklist ?? [];
          const unmet = [...ONBOARDING_CRITICAL_STEP_IDS]
            .filter((id) => checklist.find((item) => item.id === id)?.status !== 'ready')
            .map((id) => checklist.find((item) => item.id === id)?.label ?? id)
            .join(', ');
          return `Finish needs: ${unmet}`;
        })();
      const text = settingTable
        ? `${marker} ${padDisplay('Finish setup', labelWidth)}  ${padDisplay('', valueWidth)}  ${padDisplay('', valueWidth)}`
        : `${marker} ${padDisplay('Finish setup', labelWidth)}  ${padDisplay(finishDetail, commandWidth)}`;
      rows.push({
        text,
        selected: selected && workspace.focusPane === 'actions',
        fg: prereqsMet ? PALETTE.good : PALETTE.warn,
        bold: selected,
        kind: 'item',
      });
    } else {
      const text = settingTable
        ? (() => {
          const columns = onboardingActionColumns(workspace, action);
          return `${marker} ${padDisplay(columns.setting, labelWidth)}  ${padDisplay(columns.defaultValue, valueWidth)}  ${padDisplay(columns.currentValue, valueWidth)}`;
        })()
        : `${marker} ${padDisplay(label, labelWidth)}  ${padDisplay(actionChange(workspace, actionCategory, action), commandWidth)}`;
      rows.push({
        text,
        selected: selected && workspace.focusPane === 'actions',
        fg: action.safety === 'blocked' ? PALETTE.warn : selected ? PALETTE.text : PALETTE.info,
        bold: selected,
      });
    }
  }

  if (window.end < allActions.length) rows.push({ text: `${GLYPHS.navigation.moreBelow} ${allActions.length - window.end} more action(s) below`, kind: 'more', fg: PALETTE.dim, dim: true });
  rows.push({ text: '' });
  // Wrapped here, where the rows are budgeted, so the result window below
  // accounts for every row the status takes.
  for (const line of wrapText(`Status: ${workspace.status}`, Math.max(1, width))) rows.push({ text: line, fg: PALETTE.muted });
  // `reservedForResult` shrank the action window; this is what is actually left
  // once the headers, markers and status line have taken their rows. Windowing
  // against the real remainder is what keeps the total within the pane, so the
  // final slice can never be the thing that cuts the result.
  const availableForResult = Math.max(0, height - rows.length);
  for (const row of windowResultRows(resultRows, availableForResult, resultScroll, {
    palette: resultPalette(),
    moreAbove: GLYPHS.navigation.moreAbove,
    moreBelow: GLYPHS.navigation.moreBelow,
  })) {
    rows.push(row as WorkspaceRow);
  }

  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

/** Key / action pairs for the keycap hint row (Esc is the title row's keycap). */
function footerText(workspace: AgentWorkspace): string {
  if (workspace.localEditor) {
    return 'Enter next/save · Up/Down field · Backspace edit · Ctrl+J newline · Esc cancel';
  }
  if (workspace.actionSearchActive) {
    return 'Up/Down results · Enter open · Backspace edit search · Esc clear';
  }
  return 'Up/Down move · Left/Right pane · Enter open · / search · Ctrl+] next area · R refresh';
}

export function renderAgentWorkspace(workspace: AgentWorkspace, width: number, height: number): SurfaceLayer {
  const category = workspace.selectedActionCategory;
  const action = workspace.selectedAction;
  const footer = footerText(workspace);
  const baseOptions = {
    width,
    height,
    leftWidth: width < 90 ? undefined : 22,
    contextRatio: 0.4,
    minContextRows: 10,
    footer,
  };
  // The context is built first (it depends only on the width) so its share of
  // the panel can grow to what it needs while the actions keep their minimum.
  const contextWidth = getFullscreenWorkspaceMetrics(baseOptions).contextWidth;
  const contextRows = buildContextRows(workspace, category, action, contextWidth);
  const layoutOptions = { ...baseOptions, contextNeed: contextRows.length };
  const metrics = getFullscreenWorkspaceMetrics(layoutOptions);

  return renderFullscreenWorkspace({
    width,
    height,
    title: 'Agent workspace',
    stateLabel: workspace.localEditor ? `editing ${workspace.localEditor.kind}` : workspace.actionSearchActive ? 'Search' : workspace.focusPane === 'categories' ? 'Categories' : 'Actions',
    leftHeader: 'Operator Areas',
    mainHeader: workspace.actionSearchActive
      ? `Search actions · ${workspace.actions.length} result${workspace.actions.length === 1 ? '' : 's'}`
      : `${category.label} · ${workspace.actions.length} action${workspace.actions.length === 1 ? '' : 's'}`,
    leftRows: buildLeftRows(workspace, metrics.bodyRows),
    contextRows,
    controlRows: buildActionRows(workspace, metrics.contextWidth, metrics.controlRows),
    footer,
    leftWidth: layoutOptions.leftWidth,
    contextRatio: layoutOptions.contextRatio,
    minContextRows: layoutOptions.minContextRows,
    contextNeed: layoutOptions.contextNeed,
  });
}
