/**
 * KeybindingsManager, loads and merges keyboard shortcut configuration.
 *
 * Default bindings are hardcoded here. Users can override any binding by
 * creating ~/.goodvibes/agent/keybindings.json.
 *
 * Config file format example:
 * {
 *   "search": { "key": "g", "ctrl": true },
 *   "block-copy": { "key": "c", "ctrl": true, "alt": true }
 * }
 *
 * Each value is a KeyCombo or an array of KeyCombos for multi-binding support.
 *
 * Action ID backward-compatibility aliases (accepted in keybindings.json):
 *   "panel-picker"    → "workspace-picker"
 *   "panel-close"     → "workspace-close"
 *   "panel-close-all" → "workspace-close-all"
 *   "panel-tab-next"  → "workspace-tab-next"
 *   "panel-tab-prev"  → "workspace-tab-prev"
 *   "sidebar-toggle"  → "activity-open" (the activity sidebar became a modal)
 *
 * These aliases are accepted when loading user-provided keybindings.json
 * override files so existing user configs continue to work without changes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { resolveSurfaceDirectory } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

/** Identifies a specific key press with modifiers. */
export interface KeyCombo {
  /** Logical key name (single char like 'f', or named key like 'r', 'z', 'f2', etc.) */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** All bindable action identifiers. */
export type KeyAction =
  | 'copy-selection'
  | 'clear-cancel'
  | 'screen-clear'
  | 'workspace-picker'
  | 'workspace-close'
  | 'workspace-close-all'
  | 'workspace-tab-next'
  | 'workspace-tab-prev'
  | 'activity-open'
  | 'history-search'
  | 'search'
  | 'block-copy'
  | 'bookmark'
  | 'block-save'
  | 'delete-word'
  | 'line-start'
  | 'next-error-line-end'
  | 'kill-line'
  | 'clear-prompt'
  | 'undo'
  | 'redo'
  | 'paste'
  | 'focus-work-tree';

/** Human-readable description for each action (used in /keybindings display). */
export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = {
  'copy-selection':        'Copy selected text to clipboard',
  'clear-cancel':          'Clear input / cancel generation / exit (double)',
  'screen-clear':          'Repaint the screen',
  'workspace-picker':      'Open the Agent operator workspace',
  'workspace-close':       'Close the Agent workspace',
  'workspace-close-all':   'Close the Agent workspace (alias: also bound to Ctrl+Shift+X)',
  'workspace-tab-next':    'Cycle Agent workspace category forward',
  'workspace-tab-prev':    'Cycle Agent workspace category backward',
  'activity-open':         'Open the Activity modal (running work, needs you, recent)',
  'history-search':        'Reverse input history search',
  'search':                'Toggle conversation search',
  'block-copy':            'Copy nearest block to clipboard',
  'bookmark':              'Bookmark / unbookmark nearest block',
  'block-save':            'Block file save disabled; copy block or export conversation',
  'delete-word':           'Delete word backward',
  'line-start':            'Move to start of line',
  'next-error-line-end':   'Navigate to next error / move to line end',
  'kill-line':             'Kill to end of line',
  'clear-prompt':          'Clear the prompt',
  'undo':                  'Undo last prompt edit',
  'redo':                  'Redo last undone edit',
  'paste':                 'Paste from clipboard (image priority)',
  'focus-work-tree':       'Move the keyboard onto the conversation work tree (arrows move and fold, Enter opens, y copies, Esc returns)',
};

function isKeyAction(action: string): action is KeyAction {
  return Object.hasOwn(ACTION_DESCRIPTIONS, action);
}

function isKeyCombo(value: unknown): value is KeyCombo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('key' in value) || typeof value.key !== 'string' || value.key.length === 0) return false;
  if ('ctrl' in value && value.ctrl !== undefined && typeof value.ctrl !== 'boolean') return false;
  if ('shift' in value && value.shift !== undefined && typeof value.shift !== 'boolean') return false;
  if ('alt' in value && value.alt !== undefined && typeof value.alt !== 'boolean') return false;
  return true;
}

/** Default key bindings for all actions. */
export const DEFAULT_KEYBINDINGS: Record<KeyAction, KeyCombo[]> = {
  'copy-selection':        [{ key: 'c', ctrl: true, shift: true }],
  'clear-cancel':          [{ key: 'c', ctrl: true }],
  'screen-clear':          [{ key: 'l', ctrl: true }],
  'workspace-picker':      [{ key: 'p', ctrl: true }],
  'workspace-close':       [{ key: 'x', ctrl: true }],
  'workspace-close-all':   [{ key: 'x', ctrl: true, shift: true }],
  'workspace-tab-next':    [{ key: ']', ctrl: true }],
  'workspace-tab-prev':    [{ key: '[', ctrl: true }],
  'activity-open':         [{ key: 'o', ctrl: true }],
  'history-search':        [{ key: 'r', ctrl: true }],
  'search':                [{ key: 'f', ctrl: true }],
  'block-copy':            [{ key: 'y', ctrl: true }],
  'bookmark':              [{ key: 'b', ctrl: true }],
  'block-save':            [{ key: 's', ctrl: true }],
  'delete-word':           [{ key: 'w', ctrl: true }],
  'line-start':            [{ key: 'a', ctrl: true }],
  'next-error-line-end':   [{ key: 'e', ctrl: true }],
  'kill-line':             [{ key: 'k', ctrl: true }],
  'clear-prompt':          [{ key: 'u', ctrl: true }],
  'undo':                  [{ key: 'z', ctrl: true }],
  'redo':                  [{ key: 'z', ctrl: true, shift: true }],
  'paste':                 [{ key: 'v', ctrl: true }],
  // Alt+Up and Ctrl+Up: into the work tree from the composer (plain Up keeps input history).
  'focus-work-tree':       [{ key: 'up', alt: true }, { key: 'up', ctrl: true }],
};

/** Resolved overrides type: each key can be a single combo or array. */
type KeybindingsFile = Partial<Record<KeyAction, KeyCombo | KeyCombo[]>>;

export interface KeybindingsManagerOptions {
  readonly configPath?: string;
  readonly userRoot?: string;
  readonly homeDirectory?: string;
  readonly surfaceRoot?: string;
}

function resolveKeybindingsPath(options?: KeybindingsManagerOptions): string {
  if (options?.configPath) {
    return options.configPath;
  }
  const userRoot = options?.userRoot ?? options?.homeDirectory;
  if (!userRoot) {
    throw new Error('KeybindingsManager requires configPath or an explicit userRoot/homeDirectory.');
  }
  if (options?.surfaceRoot) {
    return resolveSurfaceDirectory(userRoot, options.surfaceRoot, 'keybindings.json');
  }
  return join(userRoot, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'keybindings.json');
}

/**
 * KeybindingsManager, owns the resolved keybinding table.
 *
 * Call loadFromDisk() once at startup (in main.ts) to merge user config.
 * Then use matches() anywhere a key token is being evaluated.
 */
export class KeybindingsManager {
  private bindings: Record<KeyAction, KeyCombo[]>;
  private configPath: string;
  /** Inverted lookup map: composite key → KeyAction. Built in buildLookupMap(). */
  private lookupMap = new Map<string, KeyAction>();

  constructor(options: KeybindingsManagerOptions) {
    this.configPath = resolveKeybindingsPath(options);
    // Start with deep copy of defaults
    this.bindings = this.cloneDefaults();
    this.buildLookupMap();
  }

  private cloneDefaults(): Record<KeyAction, KeyCombo[]> {
    const result = {} as Record<KeyAction, KeyCombo[]>;
    for (const [action, combos] of Object.entries(DEFAULT_KEYBINDINGS) as [KeyAction, KeyCombo[]][]) {
      result[action] = combos.map(c => ({ ...c }));
    }
    return result;
  }

  /**
   * Load user overrides from disk and merge into the binding table.
   * Unknown actions are ignored with a debug log. Malformed entries are skipped.
   * Safe to call multiple times (reloads on each call).
   */
  loadFromDisk(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as KeybindingsFile;
      const validActions = new Set(Object.keys(DEFAULT_KEYBINDINGS) as KeyAction[]);

      // Reset to defaults before applying overrides
      this.bindings = this.cloneDefaults();

      // Backward-compatibility aliases: map old panel-* action ids to workspace-* equivalents.
      const ALIASES: Readonly<Record<string, KeyAction>> = {
        'panel-picker': 'workspace-picker',
        'panel-close': 'workspace-close',
        'panel-close-all': 'workspace-close-all',
        'panel-tab-next': 'workspace-tab-next',
        'panel-tab-prev': 'workspace-tab-prev',
        'sidebar-toggle': 'activity-open',
      };

      for (const [rawAction, combo] of Object.entries(parsed)) {
        const action: string = Object.hasOwn(ALIASES, rawAction) ? ALIASES[rawAction as keyof typeof ALIASES] : rawAction;
        if (!validActions.has(action as KeyAction)) {
          logger.debug('keybindings: unknown action, skipping', { action });
          continue;
        }
        const normalized = Array.isArray(combo) ? combo : [combo];
        if (!this.validateCombos(normalized)) {
          logger.debug('keybindings: invalid combo for action, skipping', { action, combo });
          continue;
        }
        this.bindings[action as KeyAction] = normalized;
      }
      logger.debug('keybindings: loaded overrides from disk', { path: this.configPath });
    } catch (err) {
      logger.debug('keybindings: failed to load config file', { path: this.configPath, err: summarizeError(err) });
    }
    this.buildLookupMap();
  }

  /**
   * buildLookupMap, Rebuild the inverted lookup map from the current bindings table.
   * Called after constructor init and after loadFromDisk().
   * Map key format: "logicalName:ctrl:shift:alt" (booleans as 0/1).
   * Last writer wins for duplicate combos (deterministic: iterate actions in order).
   */
  private buildLookupMap(): void {
    this.lookupMap.clear();
    for (const [action, combos] of Object.entries(this.bindings) as [KeyAction, KeyCombo[]][]) {
      for (const combo of combos) {
        const key = `${combo.key}:${combo.ctrl ? 1 : 0}:${combo.shift ? 1 : 0}:${combo.alt ? 1 : 0}`;
        this.lookupMap.set(key, action);
      }
    }
  }

  /**
   * lookup, O(1) keybinding lookup by token.
   * Returns the matching KeyAction, or null if no binding matches.
   */
  lookup(token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): KeyAction | null {
    if (!token.logicalName) return null;
    const key = `${token.logicalName}:${token.ctrl ? 1 : 0}:${token.shift ? 1 : 0}:${token.alt ? 1 : 0}`;
    return this.lookupMap.get(key) ?? null;
  }

  private validateCombos(combos: unknown[]): combos is KeyCombo[] {
    return combos.every(isKeyCombo);
  }

  /**
   * matches, Check whether a keyboard token matches the given action.
   *
   * @param action  The action to test.
   * @param token   The parsed keyboard token from InputTokenizer.
   *                Expects: { logicalName: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
   */
  matches(
    action: string,
    token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
  ): boolean {
    if (!isKeyAction(action)) return false;
    const combos = this.bindings[action];
    if (!combos) return false;
    return combos.some((combo) => this.comboMatches(combo, token));
  }

  private comboMatches(
    combo: KeyCombo,
    token: { logicalName?: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
  ): boolean {
    if (token.logicalName !== combo.key) return false;
    if (!!combo.ctrl !== !!token.ctrl) return false;
    if (!!combo.shift !== !!token.shift) return false;
    if (!!combo.alt !== !!token.alt) return false;
    return true;
  }

  /**
   * getAll, Return the full resolved binding table for display purposes.
   */
  getAll(): Array<{ action: KeyAction; combos: KeyCombo[]; description: string }> {
    return (Object.keys(this.bindings) as KeyAction[]).map((action) => ({
      action,
      combos: this.bindings[action],
      description: ACTION_DESCRIPTIONS[action],
    }));
  }

  /**
   * getComboLabel, Return a human-readable label for the first combo of an action.
   * Example: { key: 'f', ctrl: true } → "Ctrl+F"
   */
  getComboLabel(action: string): string {
    if (!isKeyAction(action)) return '(unbound)';
    const combos = this.bindings[action];
    if (!combos?.length) return '(unbound)';
    return this.formatCombo(combos[0]);
  }

  /**
   * formatCombo, Format a KeyCombo as a human-readable string.
   */
  formatCombo(combo: KeyCombo): string {
    const parts: string[] = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.alt) parts.push('Alt');
    if (combo.shift) parts.push('Shift');
    parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
    return parts.join('+');
  }

  /** Return the config file path. */
  getConfigPath(): string {
    return this.configPath;
  }
}
