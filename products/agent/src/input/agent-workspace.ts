import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import { submitProtectedAgentResearchReport } from './agent-workspace-research-report-editor.ts';
import { WorkspaceEditorMessage } from './agent-workspace-editor-message.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import type { AgentConfigSetting } from '../config/settings-catalog.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type { CommandContext } from './command-registry.ts';
import { AgentNoteRegistry } from '../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import type { AgentRuntimeProfileInfo } from '../agent/runtime-profile.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { activateAgentWorkspaceSelection } from './agent-workspace-activation.ts';
import { AGENT_WORKSPACE_CATEGORIES } from './agent-workspace-categories.ts';
import { buildAgentWorkspaceCommandEditorSubmission, isAgentWorkspaceCommandEditorKind } from './agent-workspace-command-editor.ts';
import { createDeleteEditor, editorCategoryId } from './agent-workspace-editors.ts';
import { submitAgentWorkspaceLocalRegistryEditor } from './agent-workspace-local-editor-submission.ts';
import { clampAgentWorkspaceLocalLibrarySelection, moveAgentWorkspaceLocalLibraryItemSelection, selectedAgentWorkspaceLocalLibraryItem, type AgentWorkspaceLocalSelectionIndexes } from './agent-workspace-local-selection.ts';
import { applyAgentWorkspaceLocalLibraryOperation } from './agent-workspace-local-operations.ts';
import { deleteAgentWorkspaceMemoryEditor, submitAgentWorkspaceMemoryEditor } from './agent-workspace-memory-editor.ts';
import { jumpAgentWorkspaceSelection, moveAgentWorkspaceSelection, selectAgentWorkspaceCategory } from './agent-workspace-navigation.ts';
import { appendAgentWorkspaceActionSearchText, backspaceAgentWorkspaceActionSearch, beginAgentWorkspaceActionSearch, clearAgentWorkspaceActionSearch, commitAgentWorkspaceActionSearchSelection, searchAgentWorkspaceActions } from './agent-workspace-search.ts';
import { applyAgentWorkspaceSetupCheckpointAction } from './agent-workspace-setup-checkpoint-action.ts';
import { agentWorkspaceSettingSchema, applyAgentWorkspaceSettingValue, buildAgentWorkspaceSettingActionDisplay, buildAgentWorkspaceSettingActionEffect, importAgentWorkspaceTuiSettings, isAgentWorkspaceActionVisible, type AgentWorkspaceSettingActionDisplay } from './agent-workspace-settings.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import { syncAgentWorkspaceLiveCounters } from './agent-workspace-live-counters.ts';
import { trySubmitDirectHostActionEditor } from './agent-workspace-direct-editor-submission.ts';
import { submitAgentWorkspaceLocalDeleteEditor, submitAgentWorkspaceMemoryDeleteEditor, type AgentWorkspaceDeleteSubmissionHost } from './agent-workspace-delete-submission.ts';
import type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryGroup, AgentWorkspaceCommandDispatcher, AgentWorkspaceEditorField, AgentWorkspaceFocusPane, AgentWorkspaceLocalEditor, AgentWorkspaceLocalEditorKind, AgentWorkspaceLocalLibraryItem, AgentWorkspaceLocalOperation, AgentWorkspacePromptDispatcher, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
import { ONBOARDING_COMPLETE_SYNTHETIC_ACTION, shouldShowOnboardingFinishFooter } from './agent-workspace-onboarding-finish.ts';
import { completeOnboardingAction, onSubscriptionLoginSuccessAction } from './agent-workspace-onboarding-actions.ts';
import { computeOnboardingStateFromSnapshot, deriveOnboardingEntry, updateRevealedOnboardingCategories } from './agent-workspace-onboarding-state.ts';
import type { OnboardingState } from '../runtime/onboarding/onboarding-state.ts';

export type { AgentWorkspaceChannelRisk, AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
export type { AgentWorkspaceAction, AgentWorkspaceActionResult, AgentWorkspaceActionSearchResult, AgentWorkspaceCategory, AgentWorkspaceCategoryId, AgentWorkspaceCommandDispatcher, AgentWorkspaceEditorField, AgentWorkspaceFocusPane, AgentWorkspaceLocalEditor, AgentWorkspaceLocalEditorKind, AgentWorkspaceLocalLibraryItem, AgentWorkspaceLocalOperation, AgentWorkspacePromptDispatcher, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';
export { AGENT_WORKSPACE_MODAL_NAME } from './agent-workspace-types.ts';
export { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
export { handleAgentWorkspaceToken } from './agent-workspace-token.ts';

export class AgentWorkspace {
  public active = false;
  public focusPane: AgentWorkspaceFocusPane = 'actions';
  public selectedCategoryIndex = 0;
  public selectedActionIndex = 0;
  public status = 'Ready. Choose an operator flow; ordinary assistant work stays in the main conversation.';
  public runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null = null;
  public lastActionResult: AgentWorkspaceActionResult | null = null;
  private _localEditor: AgentWorkspaceLocalEditor | null = null;
  private researchSubmission: AbortController | null = null;
  private readonly editorMessage = new WorkspaceEditorMessage();
  get editorMessageState() { return this.editorMessage.state; }
  get localEditor(): AgentWorkspaceLocalEditor | null { return this._localEditor; }
  set localEditor(editor: AgentWorkspaceLocalEditor | null) {
    this.researchSubmission?.abort();
    this.researchSubmission = null;
    this._localEditor = editor;
    this.editorMessage.update(editor, () => this.context?.renderRequest?.());
  }
  public actionSearchActive = false;
  public actionSearchQuery = '';
  /** Scroll offset into the action-result block, and the result it belongs to. */
  public resultScroll = 0;
  public workContextScroll = 0;
  public resultScrollFor: AgentWorkspaceActionResult | null = null;
  public readonly selectedLibraryItemIndexes: AgentWorkspaceLocalSelectionIndexes = { memory: 0, note: 0, persona: 0, skill: 0, routine: 0, profile: 0 };
  private context: CommandContext | null = null;
  private dispatchCommand: AgentWorkspaceCommandDispatcher | null = null;
  private dispatchPrompt: AgentWorkspacePromptDispatcher | null = null;
  private _onlyGroup: AgentWorkspaceCategoryGroup | null = null;
  private _onboardingState: OnboardingState | null = null;
  private _revealedOnboardingCategoryIds = new Set<string>(); // monotonic reveal set
  private _awaitingRecapDismiss = false; // true while showing recap before final close

  open(context: CommandContext, dispatchCommand: AgentWorkspaceCommandDispatcher, categoryId?: string, dispatchPrompt?: AgentWorkspacePromptDispatcher, onlyGroup?: AgentWorkspaceCategoryGroup): void {
    this.context?.nativeWorkLedger?.close();
    this.context = context;
    this.workContextScroll = 0;
    context.nativeWorkLedger?.open();
    this.dispatchCommand = dispatchCommand;
    this.dispatchPrompt = dispatchPrompt ?? null;
    this._onlyGroup = onlyGroup ?? null;
    this._awaitingRecapDismiss = false;
    this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(context);
    const shellPaths = context.workspace?.shellPaths;
    this._onboardingState = computeOnboardingStateFromSnapshot(this.runtimeSnapshot, shellPaths);
    if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
    this.active = true;
    this.focusPane = 'actions';
    this.status = 'Ready. Choose an operator flow; ordinary assistant work stays in the main conversation.';
    this.lastActionResult = null;
    this.localEditor = null;
    this.actionSearchActive = false;
    this.actionSearchQuery = '';
    if (!categoryId) {
      this.selectedCategoryIndex = 0;
      this.selectedActionIndex = 0;
    } else if (!this.selectCategory(categoryId)) {
      const normalized = categoryId.trim();
      this.status = `Unknown Agent workspace area: ${normalized}`;
      this.lastActionResult = {
        kind: 'guidance',
        title: 'Unknown Agent workspace area',
        detail: `Use one of ${this.categories.map((category) => category.id).join(', ')}.`,
        safety: 'safe',
      };
    }
    if (onlyGroup === 'ONBOARDING' && this._onboardingState) {
      const entry = deriveOnboardingEntry(this._onboardingState);
      this.status = entry.status;
      if (entry.categoryId) {
        const idx = this.categories.findIndex((c) => c.id === entry.categoryId);
        if (idx >= 0) this.selectedCategoryIndex = idx;
      }
    }
    this.clampSelection();
  }

  reopen(): void {
    this.context?.nativeWorkLedger?.open();
    this.active = true;
    this.clampSelection();
  }

  close(): void {
    this.active = false;
    this.context?.nativeWorkLedger?.close();
    this.localEditor = null;
    this.actionSearchActive = false;
    this.actionSearchQuery = '';
    this._onlyGroup = null;
    this._onboardingState = null;
    this._awaitingRecapDismiss = false;
  }

  get nativeWorkLedgerState(): import('../runtime/native-work-ledger.ts').NativeWorkLedgerState {
    this.context?.nativeWorkLedger?.sync();
    return this.context?.nativeWorkLedger?.state ?? { status: 'unavailable', reason: 'No authenticated daemon work ledger binding is installed.' };
  }

  get categories(): readonly AgentWorkspaceCategory[] {
    if (this._onlyGroup === 'ONBOARDING') {
      // Pure read, reveal set is updated at every _onboardingState assignment
      // (open, onSubscriptionLoginSuccess), not here. Recompute is O(categories)
      // and intentionally simple; the list is small and no caching is needed.
      const onboarding = AGENT_WORKSPACE_CATEGORIES.filter((c) => c.group === 'ONBOARDING');
      if (this._onboardingState) {
        return onboarding.filter((c) => this._revealedOnboardingCategoryIds.has(c.id));
      }
      return onboarding;
    }
    if (this._onlyGroup) {
      return AGENT_WORKSPACE_CATEGORIES.filter((category) => category.group === this._onlyGroup);
    }
    return AGENT_WORKSPACE_CATEGORIES;
  }

  get selectedCategory(): AgentWorkspaceCategory {
    return this.categories[this.selectedCategoryIndex] ?? this.categories[0]!;
  }

  get actions(): readonly AgentWorkspaceAction[] {
    if (this.actionSearchActive) return this.actionSearchResults.map((result) => result.action);
    const base = this.selectedCategory.actions.filter((action) => isAgentWorkspaceActionVisible(this.context, action));
    if (shouldShowOnboardingFinishFooter(this.selectedCategory, base, this._onlyGroup === 'ONBOARDING' ? this._onboardingState?.readyToChat : undefined)) {
      return [...base, ONBOARDING_COMPLETE_SYNTHETIC_ACTION];
    }
    return base;
  }

  get selectedAction(): AgentWorkspaceAction | null {
    return this.actions[this.selectedActionIndex] ?? null;
  }

  get selectedActionCategory(): AgentWorkspaceCategory {
    if (this.actionSearchActive) return this.selectedActionSearchResult?.category ?? this.selectedCategory;
    return this.selectedCategory;
  }

  get actionSearchResults(): readonly AgentWorkspaceActionSearchResult[] {
    if (!this.actionSearchActive) return [];
    const categories = this.categories.map((category) => ({
      ...category,
      actions: category.actions.filter((action) => isAgentWorkspaceActionVisible(this.context, action)),
    }));
    return searchAgentWorkspaceActions(categories, this.actionSearchQuery);
  }

  get selectedActionSearchResult(): AgentWorkspaceActionSearchResult | null {
    if (!this.actionSearchActive) return null;
    return this.actionSearchResults[this.selectedActionIndex] ?? null;
  }

  selectCategory(categoryIdOrLabel: string): boolean {
    return selectAgentWorkspaceCategory(this, categoryIdOrLabel);
  }

  cycleCategory(direction: 'next' | 'prev'): void {
    const total = this.categories.length;
    if (total === 0) return;
    const delta = direction === 'next' ? 1 : -1;
    this.selectedCategoryIndex = (this.selectedCategoryIndex + delta + total) % total;
    this.selectedActionIndex = 0;
    this.focusPane = 'actions';
    this.clampSelection();
    this.status = `Agent workspace category: ${this.selectedCategory.label}.`;
  }

  selectedLocalLibraryItem(kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null {
    return selectedAgentWorkspaceLocalLibraryItem(this.runtimeSnapshot, this.selectedLibraryItemIndexes, kind);
  }

  settingActionDisplay(action: AgentWorkspaceAction): AgentWorkspaceSettingActionDisplay | null {
    return buildAgentWorkspaceSettingActionDisplay(this.context, action);
  }

  focusCategories(): void {
    this.focusPane = 'categories';
  }

  focusActions(): void {
    this.focusPane = 'actions';
  }

  toggleFocusPane(): void {
    this.focusPane = this.focusPane === 'categories' ? 'actions' : 'categories';
  }

  /** Scroll the action-result block; the renderer clamps and resets it. */
  scrollActionResult(delta: number): void {
    this.resultScroll = Math.max(0, this.resultScroll + delta);
  }

  moveUp(): void { moveAgentWorkspaceSelection(this, -1); }
  moveDown(): void { moveAgentWorkspaceSelection(this, 1); }
  jumpHome(): void { jumpAgentWorkspaceSelection(this, 'home'); }
  jumpEnd(): void { jumpAgentWorkspaceSelection(this, 'end'); }

  refreshRuntimeSnapshot(): void {
    if (this.selectedActionCategory.id === 'work') this.context?.nativeWorkLedger?.open();
    if (!this.context) {
      this.status = 'Runtime context is unavailable.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Context refresh failed',
        detail: 'The Agent workspace has no command context to inspect.',
      };
      return;
    }
    this.runtimeSnapshot = buildAgentWorkspaceRuntimeSnapshot(this.context);
    this.status = 'Runtime context refreshed.';
    this.lastActionResult = { kind: 'refreshed', title: 'Runtime context refreshed', detail: 'Provider, model, session, local memory, runtime endpoint, and Agent knowledge route posture were re-read from the live command context.' };
  }

  /** Render-path live counter mirror (see syncAgentWorkspaceLiveCounters). */ syncLiveCountersForRender(): void { syncAgentWorkspaceLiveCounters({ context: this.context, runtimeSnapshot: this.runtimeSnapshot, setRuntimeSnapshot: (snapshot) => { this.runtimeSnapshot = snapshot; }, clampSelection: () => this.clampSelection() }); }

  cancelLocalEditor(): void {
    if (!this.localEditor) return;
    const title = this.localEditor.title;
    this.localEditor = null;
    this.status = `${title} cancelled.`;
    this.lastActionResult = {
      kind: 'guidance',
      title: `${title} cancelled`,
      detail: 'No Agent-local registry changes were written.',
    };
  }

  beginActionSearch(): void {
    beginAgentWorkspaceActionSearch(this);
  }

  appendActionSearchText(text: string): void {
    appendAgentWorkspaceActionSearchText(this, text);
  }

  actionSearchBackspace(): void {
    backspaceAgentWorkspaceActionSearch(this);
  }

  clearActionSearch(): void {
    clearAgentWorkspaceActionSearch(this);
  }

  commitActionSearchSelection(): boolean {
    return commitAgentWorkspaceActionSearchSelection(this, this.selectedActionSearchResult);
  }

  moveEditorField(delta: number): void {
    const editor = this.localEditor;
    if (!editor) return;
    const nextIndex = Math.max(0, Math.min(editor.fields.length - 1, editor.selectedFieldIndex + delta));
    this.localEditor = { ...editor, selectedFieldIndex: nextIndex };
  }

  appendEditorText(text: string): void {
    const editor = this.localEditor;
    if (!editor || text.length === 0) return;
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field) return;
    this.replaceEditorField(editor.selectedFieldIndex, `${field.value}${field.multiline ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]+/g, ' ')}`, editor.message);
  }

  appendEditorNewline(): void {
    const editor = this.localEditor;
    if (!editor) return;
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field || !field.multiline) {
      this.moveEditorField(1);
      return;
    }
    this.replaceEditorField(editor.selectedFieldIndex, `${field.value}\n`, editor.message);
  }

  editorBackspace(): void {
    const editor = this.localEditor;
    if (!editor) return;
    const field = editor.fields[editor.selectedFieldIndex];
    if (!field || field.value.length === 0) return;
    const characters = Array.from(field.value);
    characters.pop();
    this.replaceEditorField(editor.selectedFieldIndex, characters.join(''), editor.message);
  }

  submitEditorFieldOrForm(requestRender?: () => void): void {
    const editor = this.localEditor;
    if (!editor) return;
    if (editor.selectedFieldIndex < editor.fields.length - 1) {
      this.moveEditorField(1);
      return;
    }
    this.submitLocalEditor(requestRender);
  }

  activateSelected(requestRender?: () => void): void {
    activateAgentWorkspaceSelection(this, requestRender);
  }

  hasCommandDispatch(): boolean {
    return Boolean(this.context?.executeCommand && this.dispatchCommand);
  }

  hasPromptDispatch(): boolean {
    return Boolean(this.context?.submitInput && this.dispatchPrompt);
  }

  dispatchWorkspaceCommand(command: string, behavior?: 'inline' | 'compose' | 'exit'): void {
    this.dispatchCommand?.(command, behavior);
  }

  dispatchWorkspacePrompt(prompt: string): void {
    this.dispatchPrompt?.(prompt);
  }

  clampSelection(): void {
    this.selectedCategoryIndex = Math.max(0, Math.min(this.selectedCategoryIndex, this.categories.length - 1));
    this.selectedActionIndex = Math.max(0, Math.min(this.selectedActionIndex, this.actions.length - 1));
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, 'memory');
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, 'note');
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, 'persona');
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, 'skill');
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, 'routine');
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, 'profile');
  }

  moveLocalLibraryItemSelection(kind: AgentWorkspaceLocalEditorKind, delta: number): void {
    moveAgentWorkspaceLocalLibraryItemSelection(this, kind, delta);
  }

  applyLocalLibraryOperation(operation: AgentWorkspaceLocalOperation): void {
    applyAgentWorkspaceLocalLibraryOperation(this, operation, {
      shellPaths: () => this.context?.workspace?.shellPaths,
      selectedItemForOperation: (selectedOperation) => this.selectedItemForOperation(selectedOperation),
      memoryApi: () => this.memoryApi(),
      finishLocalOperation: (kind, title, detail) => this.finishLocalOperation(kind, title, detail),
      openDeleteEditor: (kind, selected) => this.openDeleteEditor(kind, selected),
    });
  }

  completeOnboarding(): void {
    const result = completeOnboardingAction({
      awaitingRecapDismiss: this._awaitingRecapDismiss,
      runtimeSnapshot: this.runtimeSnapshot,
      shellPaths: this.context?.workspace?.shellPaths,
      dismissAgentWorkspace: this.context?.dismissAgentWorkspace,
      close: () => this.close(),
    });
    if (result.dismissed) return;
    this._awaitingRecapDismiss = result.awaitingRecapDismiss;
    this.status = result.status;
    this.lastActionResult = result.lastActionResult;
  }

  onSubscriptionLoginSuccess(): void {
    const result = onSubscriptionLoginSuccessAction({
      onlyGroup: this._onlyGroup,
      runtimeSnapshot: this.runtimeSnapshot,
      shellPaths: this.context?.workspace?.shellPaths,
    });
    if (this._onlyGroup !== 'ONBOARDING') return;
    // Update _onboardingState and reveal set FIRST so that this.categories
    // reflects any newly-unlocked lane (e.g. account-model after sign-in)
    // before we try to resolve the target index against the fresh list.
    this._onboardingState = result.onboardingState;
    if (!result.onboardingState) return;
    if (this._onboardingState) updateRevealedOnboardingCategories(this._onboardingState, this._revealedOnboardingCategoryIds);
    if (result.targetCategoryId) {
      const idx = this.categories.findIndex((c) => c.id === result.targetCategoryId);
      if (idx >= 0) this.selectedCategoryIndex = idx;
    }
    this.status = result.status;
  }

  openModelPickerAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    const target = action.modelPickerTarget ?? 'main';
    const opened = action.modelPickerFlow === 'model'
      ? this.context?.openModelPickerWithTarget?.(target)
      : this.context?.openProviderModelPickerWithTarget?.(target);
    if (!opened) {
      this.status = 'Model picker is unavailable.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Model picker unavailable',
        detail: 'This runtime cannot open the model picker from Agent workspace.',
        safety: action.safety,
      };
      requestRender?.();
      return;
    }
    this.status = `Opening ${action.label}.`;
    this.lastActionResult = {
      kind: 'dispatched',
      title: `Opening ${action.label}`,
      detail: 'Opened the shared provider/model picker for this setup target.',
      safety: action.safety,
    };
    requestRender?.();
  }

  openSettingsModalAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    if (!this.context?.openSettingsModal) {
      this.status = 'Settings are unavailable.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Settings unavailable',
        detail: 'This runtime cannot open settings from Agent workspace.',
        safety: action.safety,
      };
      requestRender?.();
      return;
    }
    this.context.openSettingsModal(action.settingsTarget);
    this.status = `Opening ${action.label}.`;
    this.lastActionResult = {
      kind: 'dispatched',
      title: `Opening ${action.label}`,
      detail: 'Opened the shared settings surface for this setup area.',
      safety: action.safety,
    };
    requestRender?.();
  }

  applySettingAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    const effect = buildAgentWorkspaceSettingActionEffect(this.context, action);
    if (effect.kind === 'result') {
      this.status = effect.status;
      this.lastActionResult = effect.result;
      return;
    }
    if (effect.kind === 'editor') {
      this.localEditor = effect.editor;
      this.status = effect.status;
      this.lastActionResult = effect.result;
      return;
    }
    void this.applySettingValue(effect.setting, effect.value, requestRender);
  }

  importTuiSettings(requestRender?: () => void): void {
    void this.importTuiSettingsAsync(requestRender);
  }

  applySetupCheckpointAction(action: AgentWorkspaceAction, requestRender?: () => void): void {
    applyAgentWorkspaceSetupCheckpointAction({
      context: this.context,
      runtimeSnapshot: this.runtimeSnapshot,
      setRuntimeSnapshot: (snapshot) => {
        this.runtimeSnapshot = snapshot;
      },
      setStatus: (status) => {
        this.status = status;
      },
      setLastActionResult: (result) => {
        this.lastActionResult = result;
      },
      clampSelection: () => this.clampSelection(),
    }, action, requestRender);
  }

  private selectedItemForOperation(operation: AgentWorkspaceLocalOperation): AgentWorkspaceLocalLibraryItem | null {
    if (operation.startsWith('memory-')) return this.selectedLocalLibraryItem('memory');
    if (operation.startsWith('note-')) return this.selectedLocalLibraryItem('note');
    if (operation.startsWith('persona-')) return this.selectedLocalLibraryItem('persona');
    if (operation.startsWith('skill-')) return this.selectedLocalLibraryItem('skill');
    return this.selectedLocalLibraryItem('routine');
  }

  private async applySettingValue(setting: AgentConfigSetting, value: unknown, requestRender?: () => void): Promise<void> {
    const outcome = await applyAgentWorkspaceSettingValue(this.context, setting, value);
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    this.clampSelection();
    this.status = outcome.status;
    this.lastActionResult = outcome.result;
    requestRender?.();
  }

  private async importTuiSettingsAsync(requestRender?: () => void): Promise<void> {
    const outcome = await importAgentWorkspaceTuiSettings(this.context);
    this.runtimeSnapshot = outcome.runtimeSnapshot ?? this.runtimeSnapshot;
    this.clampSelection();
    this.status = outcome.status;
    this.lastActionResult = outcome.result;
    requestRender?.();
  }

  private memoryApi(): MemoryApi {
    const memory = this.context?.clients?.agentKnowledgeApi?.memory;
    if (!memory) throw new Error('Agent Memory API is unavailable; refusing default knowledge or non-Agent fallback.');
    return memory;
  }

  private learnedBehaviorTarget(): Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'> {
    const target = this.editorField('target').trim().toLowerCase();
    if (target === 'persona' || target === 'skill' || target === 'routine') return target;
    throw new Error('Behavior type must be skill, routine, or persona.');
  }

  private finishLocalOperation(kind: AgentWorkspaceLocalEditorKind, title: string, detail: string): void {
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    clampAgentWorkspaceLocalLibrarySelection(this.runtimeSnapshot, this.selectedLibraryItemIndexes, kind);
    this.status = title;
    this.lastActionResult = {
      kind: 'refreshed',
      title,
      detail,
      safety: 'safe',
    };
  }

  private openDeleteEditor(kind: AgentWorkspaceLocalEditorKind, selected: AgentWorkspaceLocalLibraryItem): void {
    this.localEditor = createDeleteEditor(kind, selected);
    this.status = `Confirm deletion for ${selected.name}.`;
    this.lastActionResult = {
      kind: 'guidance',
      title: this.localEditor.title,
      detail: this.localEditor.message,
      safety: 'safe',
    };
  }

  private replaceEditorField(index: number, value: string, message: string): void {
    const editor = this.localEditor;
    if (!editor) return;
    const fields = editor.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, value } : field);
    this.localEditor = { ...editor, fields, message };
  }

  private editorField(id: string): string {
    const editor = this.localEditor;
    return editor?.fields.find((field) => field.id === id)?.value.trim() ?? '';
  }

  private missingEditorField(): AgentWorkspaceEditorField | null {
    const editor = this.localEditor;
    if (!editor) return null;
    return editor.fields.find((field) => field.required && field.value.trim().length === 0) ?? null;
  }

  private submitLocalEditor(requestRender?: () => void): void {
    const editor = this.localEditor;
    if (!editor) return;
    const missing = this.missingEditorField();
    if (missing) {
      const missingIndex = editor.fields.findIndex((field) => field.id === missing.id);
      this.localEditor = {
        ...editor,
        selectedFieldIndex: Math.max(0, missingIndex),
        message: `${missing.label} is required before saving.`,
      };
      this.status = `${missing.label} is required.`;
      return;
    }
    if (trySubmitDirectHostActionEditor(this, editor, this.context, (id) => this.editorField(id), requestRender)) return;
    if (editor.kind === 'research-report') {
      if (!this.researchSubmission) void this.submitResearchReport(editor, requestRender).catch(() => {});
      return;
    }
    if (isAgentWorkspaceCommandEditorKind(editor.kind)) {
      this.submitCommandEditor(editor);
      requestRender?.();
      return;
    }
    if (editor.kind === 'setting-set') {
      const setting = editor.recordId ? agentWorkspaceSettingSchema(this.context, editor.recordId) : null;
      if (!setting) {
        this.localEditor = { ...editor, message: 'Unknown setting; cannot save.' };
        this.status = 'Unknown setting; cannot save.';
        requestRender?.();
        return;
      }
      const value = this.editorField('value');
      this.localEditor = null;
      void this.applySettingValue(setting, value, requestRender);
      return;
    }
    if (editor.kind === 'memory') {
      if (editor.mode === 'delete') {
        try {
          this.submitMemoryDeleteEditor(editor);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.localEditor = { ...editor, message: detail };
          this.status = detail;
          this.lastActionResult = {
            kind: 'error',
            title: `${editor.title} failed`,
            detail,
          };
        }
        requestRender?.();
        return;
      }
      void this.submitMemoryEditor(editor).finally(() => requestRender?.());
      return;
    }
    const shellPaths = this.context?.workspace?.shellPaths;
    if (!shellPaths) {
      this.localEditor = { ...editor, message: 'Cannot save because Agent shell paths are unavailable.' };
      this.status = 'Cannot save Agent-local registry item without shell paths.';
      this.lastActionResult = {
        kind: 'error',
        title: 'Local registry unavailable',
        detail: 'The Agent workspace cannot locate the Agent-local registry files for this runtime.',
      };
      return;
    }
    try {
      submitAgentWorkspaceLocalRegistryEditor(shellPaths, editor, {
        readField: (id) => this.editorField(id),
        learnedBehaviorTarget: () => this.learnedBehaviorTarget(),
        submitDeleteEditor: () => this.submitLocalDeleteEditor(shellPaths, editor),
        finishLocalEditor: (kind, id, name, verb) => this.finishLocalEditor(kind, id, name, verb),
        finishProfileEditor: (profile) => this.finishProfileEditor(profile),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.localEditor = { ...editor, message: detail };
      this.status = detail;
      this.lastActionResult = {
        kind: 'error',
        title: `${editor.title} failed`,
        detail,
      };
    }
  }

  private async submitResearchReport(editor: AgentWorkspaceLocalEditor, requestRender?: () => void): Promise<void> {
    const controller = new AbortController();
    this.researchSubmission = controller;
    const context = this.context;
    const dispatch = this.dispatchPrompt;
    const fields = Object.freeze(Object.fromEntries(editor.fields.map(field => [field.id, field.value])));
    const assertCurrent = () => {
      if (controller.signal.aborted || this.researchSubmission !== controller || !this.active
        || this.localEditor !== editor || this.context !== context || this.dispatchPrompt !== dispatch
        || editor.fields.some(field => fields[field.id] !== field.value)) throw new Error('Research editor changed.');
    };
    this.status = 'Preparing research report privately...'; requestRender?.();
    try {
      await submitProtectedAgentResearchReport(editor, fields, this.hasPromptDispatch(),
        agentResearchSourceOwner(context?.extensions?.toolRegistry), { signal: controller.signal, assertCurrent }, result => {
          assertCurrent();
          // Detach this operation before the editor setter invalidates edits.
          this.researchSubmission = null;
          this.localEditor = result.kind === 'editor' ? result.editor : null;
          this.status = result.status;
          if (result.actionResult) this.lastActionResult = result.actionResult;
          if (result.kind === 'prompt') dispatch?.(result.prompt);
          requestRender?.();
        });
    } finally {
      if (this.researchSubmission === controller) this.researchSubmission = null;
    }
  }

  private submitCommandEditor(editor: AgentWorkspaceLocalEditor): void {
    const result = buildAgentWorkspaceCommandEditorSubmission(editor, (fieldId) => this.editorField(fieldId), this.hasCommandDispatch(), this.hasPromptDispatch());
    if (result.kind === 'editor') {
      this.localEditor = result.editor;
      this.status = result.status;
      if (result.actionResult) this.lastActionResult = result.actionResult;
      return;
    }

    this.localEditor = null;
    this.status = result.status;
    this.lastActionResult = result.actionResult;
    if (result.kind === 'prompt') {
      this.dispatchWorkspacePrompt(result.prompt);
      return;
    }
    this.dispatchWorkspaceCommand(result.command);
  }

  private submitLocalDeleteEditor(shellPaths: ShellPathService, editor: AgentWorkspaceLocalEditor): void {
    submitAgentWorkspaceLocalDeleteEditor(this.deleteHost(), shellPaths, editor);
  }

  private submitMemoryDeleteEditor(editor: AgentWorkspaceLocalEditor): void {
    submitAgentWorkspaceMemoryDeleteEditor(this.deleteHost(), editor);
  }

  /**
   * The narrow surface the delete submitters need. The accessors write straight
   * back to this workspace, so an extracted submitter still refuses and reports
   * exactly where the inline one did.
   */
  private deleteHost(): AgentWorkspaceDeleteSubmissionHost {
    const workspace = this;
    return {
      get localEditor() { return workspace.localEditor; },
      set localEditor(value: AgentWorkspaceLocalEditor | null) { workspace.localEditor = value; },
      get status() { return workspace.status; },
      set status(value: string) { workspace.status = value; },
      editorField: (id) => workspace.editorField(id),
      memoryApi: () => workspace.memoryApi(),
      finishLocalDelete: (kind, id, name) => { workspace.finishLocalDelete(kind, id, name); },
    };
  }
  private async submitMemoryEditor(editor: AgentWorkspaceLocalEditor): Promise<void> {
    try {
      this.status = 'Saving Agent memory...';
      const result = await submitAgentWorkspaceMemoryEditor(editor, this.memoryApi(), (id) => this.editorField(id));
      this.finishMemoryEditor(result.record, result.verb);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.localEditor = { ...editor, message: detail };
      this.status = detail;
      this.lastActionResult = {
        kind: 'error',
        title: `${editor.title} failed`,
        detail,
      };
    }
  }

  private finishMemoryEditor(record: MemoryRecord, verb: 'Created' | 'Updated'): void {
    this.localEditor = null;
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    const categoryIndex = this.categories.findIndex((category) => category.id === 'memory');
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = 0;
    }
    this.status = `${verb} memory ${record.summary}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `${verb} memory`,
      detail: `${record.summary} (${record.id}) was saved to Agent-owned memory only.`,
      safety: 'safe',
    };
    this.clampSelection();
  }

  private finishLocalEditor(kind: AgentWorkspaceLocalEditorKind, id: string, name: string, verb: 'Created' | 'Updated'): void {
    this.localEditor = null;
    const categoryId = editorCategoryId(kind);
    const categoryIndex = this.categories.findIndex((category) => category.id === categoryId);
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = 0;
    }
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    this.status = `${verb} ${kind} ${name}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `${verb} ${kind}`,
      detail: `${name} (${id}) was saved to the Agent-local ${categoryId} registry.`,
      safety: 'safe',
    };
    this.clampSelection();
  }

  private finishProfileEditor(profile: AgentRuntimeProfileInfo): void {
    this.localEditor = null;
    const categoryIndex = this.categories.findIndex((category) => category.id === 'profiles');
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = this.categories[categoryIndex]?.actions.findIndex((action) => action.id === 'runtime-profile-create') ?? 0;
      if (this.selectedActionIndex < 0) this.selectedActionIndex = 0;
    }
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    const starter = profile.starterTemplateId ? ` from ${profile.starterTemplateId}` : '';
    this.status = `Created Agent profile ${profile.id}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: 'Created Agent profile',
      detail: `Created isolated Agent profile ${profile.id}${starter}. Launch it with goodvibes-agent --agent-profile ${profile.id}. The current Agent session was not switched.`,
      safety: 'safe',
    };
    this.clampSelection();
  }

  private finishLocalDelete(kind: AgentWorkspaceLocalEditorKind, id: string, name: string): void {
    this.localEditor = null;
    const categoryId = editorCategoryId(kind);
    const categoryIndex = this.categories.findIndex((category) => category.id === categoryId);
    if (categoryIndex >= 0) {
      this.selectedCategoryIndex = categoryIndex;
      this.selectedActionIndex = 0;
    }
    this.runtimeSnapshot = this.context ? buildAgentWorkspaceRuntimeSnapshot(this.context) : this.runtimeSnapshot;
    this.status = `Deleted ${kind} ${name}.`;
    this.lastActionResult = {
      kind: 'refreshed',
      title: `Deleted ${kind}`,
      detail: `${name} (${id}) was removed from the Agent-local ${categoryId} registry.`,
      safety: 'safe',
    };
    this.clampSelection();
  }
}
