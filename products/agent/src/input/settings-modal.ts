/** SettingsModal state for the /settings and /config fullscreen workspace. */

import type { ModelPickerTarget } from './model-picker.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { AGENT_NOTIFICATIONS_METADATA_ONLY_KEY } from '../config/host-settings.ts';
import { getAgentSettingsSchema, type AgentSettingKey } from '../config/settings-catalog.ts';
import { getResolvedSettingLookup } from '@/runtime/index.ts';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import { buildGoodVibesSecretKey, defaultSecretBackedScope, isSecretConfigKey } from '../config/secret-config.ts';
import { routeSettingWriteToConnectedHost } from './settings-modal-daemon-writes.ts';
import {
  getNumericAdjustmentMeta,
  modelPickerLaunchForKey,
  parseNumberEditBuffer,
  roundToPrecision,
} from './settings-modal-behavior.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/sdk/platform/payments';
import {
  setSecretBackedSettingValue,
  type SettingsSecretsManager,
} from './settings-modal-secrets.ts';
import { buildSubscriptionEntries } from './settings-modal-subscriptions.ts';
import { buildMcpEntries } from './settings-modal-mcp-entries.ts';
import { buildFlagEntries } from './settings-modal-flag-entries.ts';
import { buildPaymentsSyntheticEntries } from './payments-config.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagState } from '@/runtime/index.ts';
import { FEATURE_SETTINGS } from '@/runtime/index.ts';
import { isFeatureEnabledInConfig, resolveFeatureEnablementWrite } from '../runtime/feature-enablement.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  CROSS_LISTED_SETTING_ROOTS,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SettingsModalChangeHandler,
  type SettingsModalOpenOptions,
  type SubscriptionEntry,
} from './settings-modal-types.ts';
import { isAgentHiddenSettingKey } from './settings-modal-agent-policy.ts';
import { searchSettingEntries } from './settings-modal-search.ts';
import { getSettingLabel } from '../renderer/settings-modal-helpers.ts';

export {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SettingsModalChange,
  type SettingsModalChangeHandler,
  type SettingsModalChangeResult,
  type SettingsModalOpenOptions,
  type SubscriptionEntry,
} from './settings-modal-types.ts';
export { isAgentHiddenSettingKey } from './settings-modal-agent-policy.ts';

// ---------------------------------------------------------------------------
// SettingsModal
// ---------------------------------------------------------------------------

export class SettingsModal {
  public active = false;

  /** Index into SETTINGS_CATEGORIES. */
  public categoryIndex = 0;

  /** Selected setting index within the current category. */
  public selectedIndex = 0;

  /** Which pane receives up/down navigation and Enter/Space actions. */
  public focusPane: SettingsFocusPane = 'settings';

  /** Whether we're in inline edit mode for the selected string/number setting. */
  public editingMode = false;

  /** Current value of the inline edit buffer. */
  public editBuffer = '';
  /** Server awaiting explicit allow-all confirmation, if any. */
  public mcpAllowAllConfirmationTarget: string | null = null;
  /**
   * Set by activateSelected() when the highlighted setting should open the
   * model picker rather than entering inline text edit mode.
   * Consumed and cleared by the route handler after each Enter/Space action.
   */
  public pendingModelPickerTarget: ModelPickerTarget | null = null;
  /** Set when the highlighted setting should open provider selection before model selection. */
  public pendingProviderModelPickerTarget: ModelPickerTarget | null = null;
  /** Set when a highlighted setting needs an external picker owned by the shell route. */
  public pendingSettingsPickerAction: 'tts-provider' | 'tts-voice' | 'daemon-timezone' | 'theme' | null = null;
  /** Provider awaiting explicit logout confirmation, if any. */
  public subscriptionLogoutConfirmationTarget: string | null = null;

  /** Settings grouped by category. */
  public groups: Map<SettingsCategory, SettingEntry[]> = new Map();

  /** Feature entries grouped by settings domain (populated when the features tab is active). */
  public flagEntries: FlagEntry[] = [];
  /** MCP server trust entries (populated when mcp tab is active). */
  public mcpEntries: McpEntry[] = [];
  /** Provider subscription entries (populated when subscriptions tab is active). */
  public subscriptionEntries: SubscriptionEntry[] = [];

  public lastSettingEffectMessage: string | null = null;
  /** The always-live search row: a non-empty query lists ranked matches from every category. */
  public searchQuery = '';
  public searchResults: SettingEntry[] = [];
  get searchFocused(): boolean { return this.searchQuery.length > 0; }
  /** Rows the selected setting's documentation is scrolled (PgUp/PgDn); reset when the selection moves. */
  public contextScroll = 0;
  scrollContext(delta: number): void { this.contextScroll = Math.max(0, this.contextScroll + delta); }

  private configManager: ConfigManager | null = null;
  private unsubscribeHostSetting: (() => void) | null = null;
  private requestHostSettingRender: (() => void) | null = null;
  private secretsManager: SettingsSecretsManager | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null = null;
  private onSettingApplied: SettingsModalChangeHandler | null = null;

  /**
   * Open the modal, loading current config values from configManager.
   *
   * @param configManager - Config manager instance for reading/writing settings.
   * @param featureFlagManager - Feature flag manager for the flags tab.
   */
  open(
    configManager: ConfigManager,
    featureFlagManager: FeatureFlagManager,
    subscriptionManager: SubscriptionManager,
    serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>,
    mcpRegistry?: McpRegistry,
    secretsManager?: SettingsSecretsManager,
    options?: SettingsModalOpenOptions,
  ): void {
    this.unsubscribeHostSetting?.();
    this.unsubscribeHostSetting = null;
    this.requestHostSettingRender = options?.requestRender ?? null;
    this.configManager = configManager;
    this.secretsManager = secretsManager ?? null;
    this.featureFlagManager = featureFlagManager;
    this.subscriptionManager = subscriptionManager;
    this.serviceRegistry = serviceRegistry;
    this.mcpRegistry = mcpRegistry ?? null;
    this.onSettingApplied = options?.onSettingApplied ?? null;
    this._loadGroups(configManager);
    this._loadFlagEntries();
    this._loadMcpEntries();
    this._loadSubscriptionEntries();
    this.categoryIndex = 0;
    this.selectedIndex = 0;
    this.focusPane = 'categories';
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSettingEffectMessage = null;
    this.clearSearch();
    this.active = true;
    if (configManager.getHostSettingsSchema?.().some((setting) => setting.key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY)) {
      this.unsubscribeHostSetting = configManager.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).subscribe(() => {
        if (!this.active || this.configManager !== configManager) return;
        for (const entries of this.groups.values()) {
          for (const entry of entries) this._refreshHostEntry(entry);
        }
        this.requestHostSettingRender?.();
      });
    }
  }

  /** Replace the search query and recompute the ranked results (an empty query clears the search). */
  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.searchResults = query.trim().length === 0 ? [] : searchSettingEntries(query, this.groups, getSettingLabel);
    this.selectedIndex = 0;
    this.contextScroll = 0;
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.searchResults = [];
  }

  close(): void {
    this.active = false;
    this.unsubscribeHostSetting?.();
    this.unsubscribeHostSetting = null;
    this.requestHostSettingRender = null;
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSettingEffectMessage = null;
    this.serviceRegistry = null;
    this.secretsManager = null;
    this.onSettingApplied = null;
    this.focusPane = 'settings';
  }

  /** Cycle to the next category (Tab). */
  nextCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex + 1) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    } else if (this.currentCategory === 'mcp') {
      this._loadMcpEntries();
    } else if (this.currentCategory === 'subscriptions') {
      this._loadSubscriptionEntries();
    }
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    } else if (this.currentCategory === 'mcp') {
      this._loadMcpEntries();
    } else if (this.currentCategory === 'subscriptions') {
      this._loadSubscriptionEntries();
    }
  }

  focusCategories(): void {
    if (this.editingMode) return;
    this.focusPane = 'categories';
  }

  focusSettings(): void {
    if (this.editingMode) return;
    this.focusPane = 'settings';
  }

  toggleFocusPane(): void {
    if (this.editingMode) return;
    this.focusPane = this.focusPane === 'settings' ? 'categories' : 'settings';
  }

  moveFocusedUp(): void {
    if (this.focusPane === 'categories') this.prevCategory();
    else this.moveUp();
  }

  moveFocusedDown(): void {
    if (this.focusPane === 'categories') this.nextCategory();
    else this.moveDown();
  }

  moveUp(): void {
    if (this.editingMode) return;
    this.contextScroll = 0;
    const items = this.searchFocused ? this.searchResults : this._currentItems();
    if (this.searchFocused && items.length === 0) return;
    if (items.length === 0) {
      if (this.currentCategory === 'flags' && this.flagEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.flagEntries.length) % this.flagEntries.length;
      } else if (this.currentCategory === 'mcp' && this.mcpEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.mcpEntries.length) % this.mcpEntries.length;
      } else if (this.currentCategory === 'subscriptions' && this.subscriptionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.subscriptionEntries.length) % this.subscriptionEntries.length;
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
    this.subscriptionLogoutConfirmationTarget = null;
  }

  moveDown(): void {
    if (this.editingMode) return;
    this.contextScroll = 0;
    const items = this.searchFocused ? this.searchResults : this._currentItems();
    if (this.searchFocused && items.length === 0) return;
    if (items.length === 0) {
      if (this.currentCategory === 'flags' && this.flagEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.flagEntries.length;
      } else if (this.currentCategory === 'mcp' && this.mcpEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.mcpEntries.length;
      } else if (this.currentCategory === 'subscriptions' && this.subscriptionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.subscriptionEntries.length;
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex + 1) % items.length;
    this.subscriptionLogoutConfirmationTarget = null;
  }

  getSelected(): SettingEntry | null {
    const items = this.searchFocused ? this.searchResults : this._currentItems();
    if (items.length === 0) return null;
    return items[Math.max(0, Math.min(items.length - 1, this.selectedIndex))] ?? null;
  }

  /** Get the currently selected flag entry (flags tab only). */
  getSelectedFlag(): FlagEntry | null {
    if (this.currentCategory !== 'flags') return null;
    if (this.flagEntries.length === 0) return null;
    return this.flagEntries[Math.max(0, Math.min(this.flagEntries.length - 1, this.selectedIndex))] ?? null;
  }

  getSelectedMcp(): McpEntry | null {
    if (this.currentCategory !== 'mcp') return null;
    if (this.mcpEntries.length === 0) return null;
    return this.mcpEntries[Math.max(0, Math.min(this.mcpEntries.length - 1, this.selectedIndex))] ?? null;
  }

  getSelectedSubscription(): SubscriptionEntry | null {
    if (this.currentCategory !== 'subscriptions') return null;
    if (this.subscriptionEntries.length === 0) return null;
    return this.subscriptionEntries[Math.max(0, Math.min(this.subscriptionEntries.length - 1, this.selectedIndex))] ?? null;
  }

  get currentCategory(): SettingsCategory {
    return SETTINGS_CATEGORIES[this.categoryIndex];
  }

  get currentItems(): SettingEntry[] {
    return this._currentItems();
  }

  selectTarget(target?: string): void {
    const normalized = target?.trim();
    if (!normalized) return;

    const categoryIndex = SETTINGS_CATEGORIES.indexOf(normalized as SettingsCategory);
    if (categoryIndex >= 0) {
      this.categoryIndex = categoryIndex;
      this.selectedIndex = 0;
      this.focusPane = 'settings';
      return;
    }

    for (let index = 0; index < SETTINGS_CATEGORIES.length; index += 1) {
      const category = SETTINGS_CATEGORIES[index]!;
      const entries = this.groups.get(category) ?? [];
      const entryIndex = entries.findIndex((entry) => entry.setting.key === normalized);
      if (entryIndex >= 0) {
        this.categoryIndex = index;
        this.selectedIndex = entryIndex;
        this.focusPane = 'settings';
        return;
      }
    }
  }

  /**
   * Toggle boolean or begin cycling enum values, or enter edit mode for string/number.
   */
  activateSelected(): void {
    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry) return;
      this.editingMode = true;
      this.editBuffer = entry.trustMode;
      this.mcpAllowAllConfirmationTarget = null;
      return;
    }

    if (this.currentCategory === 'subscriptions') {
      const entry = this.getSelectedSubscription();
      if (!entry) return;
      if (entry.state === 'active' || entry.state === 'pending') {
        if (this.subscriptionLogoutConfirmationTarget !== entry.provider) {
          this.subscriptionLogoutConfirmationTarget = entry.provider;
          return;
        }
        this.subscriptionManager?.logout(entry.provider);
        this._loadSubscriptionEntries();
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }

    if (!this._canEditSettings()) return;
    const entry = this.getSelected();
    if (!entry || !this.configManager) return;

    const { setting } = entry;

    // Delegate provider/model picker settings to the model picker UI
    if (setting.key === 'tts.provider') {
      this.pendingSettingsPickerAction = 'tts-provider';
      return;
    }
    if (setting.key === 'tts.voice') {
      this.pendingSettingsPickerAction = 'tts-voice';
      return;
    }
    if (setting.key === 'daemon.timezone') {
      this.pendingSettingsPickerAction = 'daemon-timezone';
      return;
    }
    // The theme row opens a picker with live preview instead of cycling values.
    if (setting.key === 'display.theme') {
      this.pendingSettingsPickerAction = 'theme';
      return;
    }

    const pickerLaunch = modelPickerLaunchForKey(setting.key);
    if (pickerLaunch !== null) {
      if (pickerLaunch.flow === 'providerModel') {
        this.pendingProviderModelPickerTarget = pickerLaunch.target;
      } else {
        this.pendingModelPickerTarget = pickerLaunch.target;
      }
      return;
    }

    if (setting.type === 'boolean') {
      const newVal = !entry.currentValue;
      this._setValue(setting.key, newVal);
    } else if (setting.type === 'enum' && setting.enumValues) {
      const idx = setting.enumValues.indexOf(entry.currentValue as string);
      const nextIdx = (idx + 1) % setting.enumValues.length;
      this._setValue(setting.key, setting.enumValues[nextIdx]);
    } else if (setting.type === 'string' || setting.type === 'number') {
      // Enter inline edit mode
      this.editingMode = true;
      this.editBuffer = String(entry.currentValue ?? '');
    }
  }

  adjustSelected(direction: 'left' | 'right', step = 1): void {
    if (this.editingMode) return;

    if (this.currentCategory === 'flags') {
      const flagEntry = this.getSelectedFlag();
      if (!flagEntry || flagEntry.state === 'killed' || !this.configManager) return;
      const targetState: FlagState = direction === 'right' ? 'enabled' : 'disabled';
      if (flagEntry.state !== targetState) this._setSelectedFlagState(flagEntry, targetState);
      return;
    }

    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry || !this.mcpRegistry) return;
      const modes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
      const currentIndex = Math.max(0, modes.indexOf(entry.trustMode));
      const nextIndex = direction === 'right'
        ? (currentIndex + 1) % modes.length
        : (currentIndex - 1 + modes.length) % modes.length;
      this.mcpRegistry.setServerTrustMode(entry.name, modes[nextIndex]!);
      this._loadMcpEntries();
      this.mcpAllowAllConfirmationTarget = null;
      return;
    }

    if (!this._canEditSettings()) return;
    const entry = this.getSelected();
    if (!entry || !this.configManager) return;
    const { setting } = entry;

    if (setting.type === 'boolean') {
      this._setValue(setting.key, direction === 'right');
      return;
    }

    if (setting.type === 'enum' && setting.enumValues && setting.enumValues.length > 0) {
      const currentIndex = Math.max(0, setting.enumValues.indexOf(String(entry.currentValue)));
      const nextIndex = direction === 'right'
        ? (currentIndex + 1) % setting.enumValues.length
        : (currentIndex - 1 + setting.enumValues.length) % setting.enumValues.length;
      this._setValue(setting.key, setting.enumValues[nextIndex]!);
      return;
    }

    if (setting.type === 'number') {
      const currentNumber = Number(entry.currentValue ?? 0);
      if (!Number.isFinite(currentNumber)) return;
      const adjustment = getNumericAdjustmentMeta(setting);
      const delta = adjustment.step * step;
      const rounded = roundToPrecision(currentNumber + (direction === 'right' ? delta : -delta), adjustment.precision);
      const nextValue = Math.min(
        adjustment.max ?? rounded,
        Math.max(adjustment.min ?? rounded, rounded),
      );
      if (setting.validate && !setting.validate(nextValue)) return;
      this._setValue(setting.key, nextValue);
    }
  }

  /**
   * Toggle the currently selected feature by writing its enablement domain
   * settings key (there is no separate enablement namespace). The live
   * settings bridge propagates the change into the gate manager; features
   * that require a restart record an honest pending-restart state instead.
   *
   * Killed features cannot be toggled. Always-available features (constant
   * enablement) refuse with guidance naming their real settings keys.
   */
  toggleSelectedFlag(): void {
    const flagEntry = this.getSelectedFlag();
    if (!flagEntry || !this.configManager) return;

    // Killed features are blocked
    if (flagEntry.state === 'killed') return;

    const newState: FlagState = flagEntry.state === 'enabled' ? 'disabled' : 'enabled';

    this._setSelectedFlagState(flagEntry, newState);
  }

  private _setSelectedFlagState(flagEntry: FlagEntry, newState: FlagState): void {
    if (!this.configManager || !this._canEditSettings()) return;
    if (newState === 'killed') return;
    const feature = flagEntry.feature;

    try {
      const write = resolveFeatureEnablementWrite(feature.id, newState === 'enabled' ? 'enabled' : 'disabled');
      this.configManager.setDynamic(write.key, write.value);
      this._loadFlagEntries();
      this.lastSettingEffectMessage = feature.restartRequired
        ? `${write.key} = ${String(write.value)} saved; takes effect on the next launch.`
        : `${write.key} = ${String(write.value)}`;
    } catch (e) {
      logger.error('SettingsModal: failed to set feature enablement', { feature: feature.id, error: summarizeError(e) });
      this.lastSettingEffectMessage = `Save failed: ${summarizeError(e)}`;
    }
  }

  /**
   * Commit the current editBuffer to the config.
   * Returns true on success, false if validation failed.
   */
  commitEdit(): boolean {
    if (!this.editingMode) return false;

    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry || !this.mcpRegistry) return false;
      if (this.mcpAllowAllConfirmationTarget) {
        const expected = `ALLOW ALL ${this.mcpAllowAllConfirmationTarget}`;
        if (this.editBuffer.trim() !== expected) {
          return false;
        }
        this.mcpRegistry.setServerTrustMode(entry.name, 'allow-all');
        this._loadMcpEntries();
        this.editingMode = false;
        this.editBuffer = '';
        this.mcpAllowAllConfirmationTarget = null;
        return true;
      }

      const nextMode = this.editBuffer.trim() as McpEntry['trustMode'];
      const validModes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
      if (!validModes.includes(nextMode)) {
        this.editingMode = false;
        this.editBuffer = '';
        this.mcpAllowAllConfirmationTarget = null;
        return false;
      }
      if (nextMode === 'allow-all' && entry.trustMode !== 'allow-all') {
        this.mcpAllowAllConfirmationTarget = entry.name;
        this.editBuffer = '';
        return false;
      }
      this.mcpRegistry.setServerTrustMode(entry.name, nextMode);
      this._loadMcpEntries();
      this.editingMode = false;
      this.editBuffer = '';
      this.mcpAllowAllConfirmationTarget = null;
      return true;
    }

    if (!this._canEditSettings()) return false;
    const entry = this.getSelected();
    if (!entry || !this.configManager) return false;

    const { setting } = entry;
    let parsed: unknown = this.editBuffer;

    if (setting.type === 'number') {
      parsed = parseNumberEditBuffer(this.editBuffer);
      if (parsed === null) {
        this.editingMode = false;
        this.editBuffer = '';
        return false;
      }
    }

    if (setting.validate && !setting.validate(parsed)) {
      this.editingMode = false;
      this.editBuffer = '';
      return false;
    }

    if (setting.type === 'string' && isSecretConfigKey(setting.key)) {
      setSecretBackedSettingValue({
        key: setting.key,
        value: String(parsed ?? ''),
        configManager: this.configManager,
        secretsManager: this.secretsManager,
        setConfigValue: (key, value) => this._setValue(key, value),
        onWriteReported: (report) => {
          this.lastSettingEffectMessage = report.message;
        },
      });
    } else {
      this._setValue(setting.key, parsed);
    }
    this.editingMode = false;
    this.editBuffer = '';
    return true;
  }

  /** Cancel inline edit without saving. */
  cancelEdit(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.mcpAllowAllConfirmationTarget = null;
  }

  resetSelected(): { key: AgentSettingKey; value: unknown } | null {
    if (this.editingMode || !this.configManager) return null;
    if (!this._canEditSettings()) return null;
    const entry = this.getSelected();
    if (!entry) return null;
    const key = entry.setting.key;
    const applied = this._setValue(key, entry.setting.default);
    if (key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY) return applied ? { key, value: entry.setting.default } : null;
    if (isSecretConfigKey(key) && this.secretsManager) {
      // Same scope the value was WRITTEN at (defaultSecretBackedScope), or the
      // reset clears nothing: an email.* / calendar.* / surfaces.* / payments.*
      // secret lives in the daemon tier, and deleting the user-tier copy would
      // leave the real one in place while the UI reported the setting reset.
      void this.secretsManager.delete(buildGoodVibesSecretKey(key), { scope: defaultSecretBackedScope(key) }).catch((error) => {
        logger.error('SettingsModal: failed to clear secret while resetting setting', { key, error: summarizeError(error) });
      });
    }
    return { key, value: entry.setting.default };
  }

  /** Handle a keystroke in edit mode: regular chars appended, Backspace removes last char. */
  editChar(char: string): void {
    if (!this.editingMode) return;
    this.editBuffer += char;
  }

  editBackspace(): void {
    if (!this.editingMode) return;
    this.editBuffer = this.editBuffer.slice(0, -1);
  }

  // ── Private helpers ────────────────────────────────────────────

  private _loadGroups(configManager: ConfigManager): void {
    // Pure host metadata must run before the legacy builtin lookup, whose
    // malformed-policy recovery can otherwise erase evidence of unknown locks.
    const policyError = this._hostPolicyMetadataError();
    this.groups.clear();
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') continue; // flags tab handled separately
      this.groups.set(cat, []);
    }

    for (const setting of getAgentSettingsSchema(configManager)) {
      if (isAgentHiddenSettingKey(setting.key)) continue;
      const rawCat = setting.key.split('.')[0] as string;
      const cat = rawCat as SettingsCategory;
      const currentValue = setting.kind === 'host' ? configManager.getHostBooleanSetting(setting.key).get() : configManager.get(setting.key);
      const resolved = setting.kind === 'host' || policyError ? undefined : getResolvedSettingLookup(configManager, setting.key)?.entry;
      const entry: SettingEntry = {
        setting,
        currentValue,
        isDefault: currentValue === setting.default,
        effectiveSource: policyError ? 'unavailable' : resolved?.effectiveSource,
        metadataUnavailable: policyError,
        // `locked`/`lockReason` now come only from a genuine higher-priority
        // config layer. The blanket host-owned lock that used to force them here
        // is gone, those keys route to the daemon that owns them.
        locked: resolved?.locked,
        conflict: resolved?.conflict,
        sourceLabel: resolved?.sourceLabel,
        lockReason: resolved?.lockReason,
      };
      this._refreshHostEntry(entry);
      if (this.groups.has(cat)) this.groups.get(cat)!.push(entry);
      // A root with no category of its own is listed where it belongs instead
      // of being dropped, see CROSS_LISTED_SETTING_ROOTS.
      const crossListed = CROSS_LISTED_SETTING_ROOTS[rawCat];
      if (crossListed !== undefined && this.groups.has(crossListed)) {
        this.groups.get(crossListed)!.push(entry);
      }
    }

    // Inject the four card-material fields (number, expiry, CVV, cardholder
    // name). They are synthetic because CONFIG_SCHEMA deliberately carries no
    // scalar entry for card material, it lives write-only in the daemon
    // secret store and config holds only a goodvibes:// reference. Listing
    // them here is what gives the settings modal a visible "set / not set"
    // row for each and a masked edit path; the primary entry point remains
    // the guided `/payments card` flow. See input/payments-config.ts.
    const paymentsEntries = this.groups.get('payments');
    if (paymentsEntries) {
      for (const entry of buildPaymentsSyntheticEntries(configManager)) {
        if (!paymentsEntries.some((existing) => existing.setting.key === entry.setting.key)) {
          paymentsEntries.push(entry);
        }
      }
    }
    if (policyError) {
      for (const entries of this.groups.values()) for (const entry of entries) {
        Object.assign(entry, { effectiveSource: 'unavailable', metadataUnavailable: policyError,
          locked: undefined, conflict: undefined, sourceLabel: undefined, lockReason: undefined });
      }
    }

    const uiEntries = this.groups.get('ui');
    if (uiEntries) {
      const uiPriority: Record<string, number> = {
        'ui.systemMessages': 0,
        'ui.operationalMessages': 1,
        'ui.voiceEnabled': 2,
      };
      uiEntries.sort((a, b) => (uiPriority[a.setting.key] ?? 99) - (uiPriority[b.setting.key] ?? 99));
    }
    if (this.searchQuery) this.searchResults = searchSettingEntries(this.searchQuery, this.groups, getSettingLabel);
  }

  /**
   * Load or refresh the features tab from FEATURE_SETTINGS, grouped by
   * settings domain. State prefers the live gate manager (kill-switch and
   * pending-restart aware); without a manager it derives from the feature's
   * bound domain settings key.
   */
  private _loadFlagEntries(): void {
    this.flagEntries = buildFlagEntries(this.configManager, this.featureFlagManager);
  }

  private _loadMcpEntries(): void {
    this.mcpEntries = buildMcpEntries(this.mcpRegistry);
  }

  private _loadSubscriptionEntries(): void {
    this.subscriptionEntries = buildSubscriptionEntries(this.subscriptionManager, this.serviceRegistry);
  }

  /** Returns [] for the flags category (flags use flagEntries instead). */
  private _currentItems(): SettingEntry[] {
    if (this.currentCategory === 'flags' || this.currentCategory === 'mcp' || this.currentCategory === 'subscriptions') return [];
    return this.groups.get(this.currentCategory) ?? [];
  }

  private _refreshAllEntries(): void {
    if (!this.configManager) return;
    for (const entries of this.groups.values()) {
      for (const entry of entries) {
        if (entry.setting.kind === 'host') { this._refreshHostEntry(entry); continue; }
        entry.currentValue = this.configManager.get(entry.setting.key);
        entry.isDefault = entry.currentValue === entry.setting.default;
        this._refreshHostEntry(entry);
      }
    }
  }

  /** Keep the registered host row's canonical source/lock metadata live too. */
  private _refreshHostEntry(entry: SettingEntry): void {
    if (!this.configManager || entry.setting.kind !== 'host') return;
    const handle = this.configManager.getHostBooleanSetting(entry.setting.key);
    entry.currentValue = handle.get();
    entry.isDefault = entry.currentValue === entry.setting.default;
    try {
      const resolved = handle.getResolved();
      Object.assign(entry, {
        effectiveSource: resolved.source, locked: resolved.managedLock !== null,
        metadataUnavailable: undefined, conflict: undefined, sourceLabel: undefined,
        lockReason: resolved.managedLock ? `${resolved.managedLock.source}: ${resolved.managedLock.reason}` : undefined,
      });
    } catch (error) {
      Object.assign(entry, { effectiveSource: 'unavailable', metadataUnavailable: summarizeError(error),
        locked: undefined, conflict: undefined, sourceLabel: undefined, lockReason: undefined });
    }
  }

  private _setValue(key: AgentSettingKey, value: unknown): boolean {
    if (!this.configManager) return false;
    if (!this._canEditSettings()) return false;
    if (key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY) {
      try {
        const handle = this.configManager.getHostBooleanSetting(key);
        handle.getResolved(); // Unknown policy metadata must never be presented as editable.
        if (typeof value !== 'boolean') throw new Error(`${key} requires a literal boolean.`);
        handle.set(value);
        this.lastSettingEffectMessage = null;
        this._refreshAllEntries();
        return true;
      } catch (error) {
        this.lastSettingEffectMessage = `Save failed: ${summarizeError(error)}`;
        for (const entries of this.groups.values()) for (const entry of entries) this._refreshHostEntry(entry);
        return false;
      }
    }
    const previousValue = this.configManager.get(key);
    // A setting the DAEMON acts on is written where it is acted on. Writing it
    // into this process's own store is the defect this routing exists to end:
    // the modal accepted the value, reported success, and configured nothing,
    // because the runtime that reads the key reads a different file.
    //
    // This runs before the local write and returns instead of it, so a
    // daemon-owned key never has two writers. The modal cannot await from a
    // keystroke handler, so the outcome lands on `lastSettingEffectMessage` a
    // moment later, including the refusal, which is the message that matters.
    const routed = routeSettingWriteToConnectedHost(key, value, (update) => {
      this.lastSettingEffectMessage = update.message;
      if (update.ok) this._refreshAllEntries();
    });
    if (routed) return true;
    try {
      this.configManager.setDynamic(key, value);
      for (const entries of this.groups.values()) {
        const entry = entries.find((candidate) => candidate.setting.key === key);
        if (entry) {
          entry.currentValue = this.configManager!.get(key);
          entry.isDefault = entry.currentValue === entry.setting.default;
          this._refreshHostEntry(entry);
        }
      }
      if (previousValue !== value && this.onSettingApplied) {
        const result = this.onSettingApplied({ key, previousValue, value });
        this.lastSettingEffectMessage = result?.message ?? null;
        this._refreshAllEntries();
      }
      // The SDK's own trade-off wording, shown at the moment of selection, not
      // authored here, and never shown against the 'stored' default.
      if (key === 'payments.cvvHandling' && value === 'prompt') {
        this.lastSettingEffectMessage = CVV_PROMPT_TRADEOFF_WARNING;
      } else if (key === 'payments.cvvHandling' && this.lastSettingEffectMessage === CVV_PROMPT_TRADEOFF_WARNING) {
        this.lastSettingEffectMessage = null;
      }
      return true;
    } catch (e) {
      logger.error('SettingsModal: failed to set config value', { key, error: summarizeError(e) });
      this.lastSettingEffectMessage = `Save failed: ${summarizeError(e)}`;
      return false;
    }
  }

  private _hostPolicyMetadataError(): string | undefined {
    const config = this.configManager;
    if (!config?.getHostSettingsSchema?.().some(setting => setting.key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY)) return undefined;
    try { config.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).getResolved(); return undefined; }
    catch (error) { return summarizeError(error); }
  }

  private _canEditSettings(): boolean {
    if (!this.configManager) return false;
    const error = this._hostPolicyMetadataError();
    if (error) {
      for (const entries of this.groups.values()) for (const entry of entries) {
        Object.assign(entry, { effectiveSource: 'unavailable', metadataUnavailable: error,
          locked: undefined, conflict: undefined, sourceLabel: undefined, lockReason: undefined });
      }
      this.lastSettingEffectMessage = `Editing unavailable: ${error}`;
      return false;
    }
    if ([...this.groups.values()].some(entries => entries.some(entry => entry.metadataUnavailable))) this._loadGroups(this.configManager);
    return true;
  }

}
