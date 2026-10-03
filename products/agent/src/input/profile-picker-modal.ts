/**
 * ProfilePickerModal, state management for the Agent profile picker modal.
 *
 * Lists profiles from ProfileManager.list(), tracks selected index,
 * and handles load actions.
 */

import type { ProfileInfo, ProfileData, ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

/** Known display setting keys (subset of ConfigKey that maps to display.*). */
const DISPLAY_KEYS: ConfigKey[] = [
  'display.stream', 'display.lineNumbers', 'display.collapseThreshold',
  'display.theme', 'display.showThinking', 'display.showReasoningSummary',
  'display.showTokenSpeed', 'display.showToolPreview',
] as const;

/** Known behavior setting keys (subset of ConfigKey that maps to behavior.*). */
const BEHAVIOR_KEYS: ConfigKey[] = [
  'behavior.autoApprove', 'behavior.autoCompactThreshold',
  'behavior.saveHistory', 'behavior.notifyOnComplete',
] as const;

function configProfileDeletionDisabledMessage(name: string): string {
  return `Config-profile deletion is disabled in Agent for ${name}. Open Agent Workspace -> Profiles for isolated Agent profile homes.`;
}

function configProfileSavingDisabledMessage(name: string): string {
  return `Config-profile saving is disabled in Agent for ${name}. Open Agent Workspace -> Profiles to create isolated Agent homes.`;
}

export function renderProfilePickerStatePackageText(): string {
  return [
    'Profile name cannot be empty',
    'Loaded profile',
    'Saved profile',
    'Error',
    configProfileDeletionDisabledMessage('<profile>'),
    configProfileSavingDisabledMessage('<profile>'),
  ].join('\n');
}

/**
 * Apply a profile data category to the config manager.
 * Iterates only known/valid keys rather than open-ended Object.entries.
 */
function applyProfileCategory(
  cm: ConfigManager,
  data: object,
  keys: ConfigKey[],
): void {
  for (const key of keys) {
    const field = key.split('.')[1];
    if (field && Object.hasOwn(data, field)) {
      try {
        cm.setDynamic(key, Reflect.get(data, field));
      } catch (e) { logger.debug('applyProfileCategory: key set failed', { key, error: summarizeError(e) }); }
    }
  }
}

// ---------------------------------------------------------------------------
// ProfilePickerModal
// ---------------------------------------------------------------------------

export class ProfilePickerModal {
  public active = false;
  public profiles: ProfileInfo[] = [];
  public selectedIndex = 0;
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;

  /** Last status message (success/error feedback). */
  public statusMessage = '';
  /** The always-live search row's query; selectedIndex indexes visibleProfiles. */
  public query = '';

  public constructor(private readonly profileManager: ProfileManager) {}

  /**
   * Open the modal, loading profiles from ProfileManager.
   */
  open(): void {
    this.profiles = this.profileManager.list();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.query = '';
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.query = '';
  }

  /** The profiles the search row lets through, in order. */
  get visibleProfiles(): ProfileInfo[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.profiles;
    return this.profiles.filter((profile) => profile.name.toLowerCase().includes(q));
  }

  /** Replace the query; the selection moves to the first match. */
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.deleteConfirmationTarget = null;
  }

  moveUp(): void {
    const n = this.visibleProfiles.length;
    if (n === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + n) % n;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  moveDown(): void {
    const n = this.visibleProfiles.length;
    if (n === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % n;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }

  getSelected(): ProfileInfo | null {
    return this.visibleProfiles[this.selectedIndex] ?? null;
  }

  /**
   * Load the selected profile into configManager.
   * Returns true on success, false on error.
   */
  loadSelected(configManager: ConfigManager): boolean {
    const profile = this.getSelected();
    if (!profile) return false;

    try {
      const { data } = this.profileManager.load(profile.name);
      // This upstream profile field has no classified writable Jev ConfigKey.
      // Hold the complete load before even unrelated mutations (THE-17/THE-35).
      if (data.behavior && Object.hasOwn(data.behavior, 'notificationsMetadataOnly')) {
        this.statusMessage = 'This profile includes notification privacy settings that this Agent build cannot apply. No settings were changed.';
        return false;
      }

      // Apply display settings using validated key list
      if (data.display) {
        applyProfileCategory(configManager, data.display, DISPLAY_KEYS);
      }

      // Apply provider settings (model + reasoningEffort only)
      if (data.provider) {
        if (data.provider.model !== undefined) {
          try { configManager.set('provider.model', data.provider.model); } catch (e) { logger.debug('profile: model set failed', { error: summarizeError(e) }); }
        }
        if (data.provider.reasoningEffort !== undefined) {
          try { configManager.set('provider.reasoningEffort', data.provider.reasoningEffort); } catch (e) { logger.debug('profile: reasoningEffort set failed', { error: summarizeError(e) }); }
        }
      }

      // Apply behavior settings using validated key list
      if (data.behavior) {
        applyProfileCategory(configManager, data.behavior, BEHAVIOR_KEYS);
      }

      configManager.save();
      this.statusMessage = `Loaded profile ${profile.name}`;
      return true;
    } catch (e) {
      this.statusMessage = `Error ${summarizeError(e)}`;
      return false;
    }
  }

  deleteSelected(): boolean {
    const profile = this.getSelected();
    if (!profile) return false;
    this.deleteConfirmationTarget = null;
    this.statusMessage = configProfileDeletionDisabledMessage(profile.name);
    return false;
  }

  /**
   * Save the current config settings as a new profile under `name`.
   */
  saveCurrentAs(name: string, configManager: ConfigManager): boolean {
    if (!name || !name.trim()) {
      this.statusMessage = 'Profile name cannot be empty';
      return false;
    }
    void configManager;
    this.statusMessage = configProfileSavingDisabledMessage(name);
    return false;
  }

  public saveCurrentAsConfirmed(name: string, configManager: ConfigManager): boolean {
    if (!name || !name.trim()) {
      this.statusMessage = 'Profile name cannot be empty';
      return false;
    }
    try {
      const all = configManager.getAll();
      const data: ProfileData = {
        display: { ...all.display },
        provider: {
          model: all.provider.model,
          reasoningEffort: all.provider.reasoningEffort,
        },
        behavior: { ...all.behavior },
      };

      this.profileManager.save(name, data);

      // Reload list
      this.profiles = this.profileManager.list();
      this.statusMessage = `Saved profile ${name}`;
      this._clampScroll();
      return true;
    } catch (e) {
      this.statusMessage = `Error ${summarizeError(e)}`;
      return false;
    }
  }

  private _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.visibleProfiles.length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
