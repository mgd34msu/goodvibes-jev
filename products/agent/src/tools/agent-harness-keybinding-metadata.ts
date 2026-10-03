import { existsSync, readFileSync, renameSync } from 'node:fs';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { writeStoreJson } from '@/utils/store-file.ts';
import type { CommandContext } from '../input/command-registry.ts';
import {
  ACTION_DESCRIPTIONS,
  DEFAULT_KEYBINDINGS,
  type KeyAction,
  type KeyCombo,
  type KeybindingsManager,
} from '../input/keybindings.ts';

const FIXED_SHORTCUTS: readonly Record<string, string>[] = [
  { key: 'Enter', description: 'Send prompt' },
  { key: 'Shift+Enter / Ctrl+J', description: 'Insert newline' },
  { key: 'Up / Down', description: 'Navigate input history, lists, and scrollable overlays' },
  { key: 'Tab', description: 'Autocomplete slash command or file mention' },
  { key: 'Esc', description: 'Close overlays, pickers, and transient input modes' },
  { key: '? / F1', description: 'Toggle help overlay' },
  { key: 'F2', description: 'Open runtime activity monitor' },
  { key: '/shortcuts', description: 'Open keyboard shortcut reference' },
  { key: '/keybindings', description: 'List configurable keybindings and config path' },
];

interface HarnessKeybindingArgs {
  readonly query?: unknown;
  readonly actionId?: unknown;
  readonly target?: unknown;
  readonly key?: unknown;
  readonly fields?: unknown;
  readonly combo?: unknown;
  readonly combos?: unknown;
  readonly value?: unknown;
  readonly limit?: unknown;
}

type KeybindingOperationEffect =
  | 'shell-action'
  | 'visible-ui-navigation'
  | 'visible-ui-interaction'
  | 'prompt-editor-state'
  | 'clipboard-selection'
  | 'reserved'
  | 'disabled';

interface KeybindingOperationRoute {
  readonly supported: boolean;
  readonly effect: KeybindingOperationEffect;
  readonly confirmation: string;
  readonly preferredMode?: 'run_keybinding' | 'open_ui_surface' | 'run_command' | 'direct-user-interaction';
  readonly surfaceId?: string;
  readonly command?: string;
  readonly note: string;
}

type KeybindingsOverrideFile = Record<string, unknown>;
type KeybindingEntry = { readonly action: KeyAction; readonly description: string; readonly combos: KeyCombo[] };

interface KeybindingLookup {
  readonly source: 'actionId' | 'target' | 'key' | 'query';
  readonly input: string;
  readonly resolvedBy: 'action' | 'case-insensitive-action' | 'search';
}

type KeybindingResolution =
  | {
    readonly status: 'found';
    readonly action: KeyAction;
    readonly lookup: KeybindingLookup;
  }
  | {
    readonly status: 'ambiguous';
    readonly input: string;
    readonly candidates: readonly Record<string, unknown>[];
  };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

function requireKeybindingsManager(context: CommandContext): KeybindingsManager {
  const manager = context.workspace.keybindingsManager;
  if (!manager) throw new Error('workspace.keybindingsManager is unavailable in this Agent runtime');
  return manager;
}

function readKeybindingsManager(context: CommandContext): KeybindingsManager | null {
  return context.workspace.keybindingsManager ?? null;
}

function defaultKeybindingEntries(): KeybindingEntry[] {
  return (Object.entries(DEFAULT_KEYBINDINGS) as [KeyAction, KeyCombo[]][])
    .map(([action, combos]) => ({
      action,
      description: ACTION_DESCRIPTIONS[action],
      combos: combos.map((combo) => ({ ...combo })),
    }));
}

function isKeyAction(action: string): action is KeyAction {
  return Object.hasOwn(ACTION_DESCRIPTIONS, action);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeCombo(value: unknown): KeyCombo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const key = readString(raw.key);
  if (!key) return null;
  const combo: KeyCombo = { key };
  const ctrl = readBoolean(raw.ctrl);
  const shift = readBoolean(raw.shift);
  const alt = readBoolean(raw.alt);
  if (ctrl !== undefined) combo.ctrl = ctrl;
  if (shift !== undefined) combo.shift = shift;
  if (alt !== undefined) combo.alt = alt;
  return combo;
}

function parseComboLabel(value: string): KeyCombo | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.at(-1);
  if (!key) return null;
  const combo: KeyCombo = { key: key.length === 1 ? key.toLowerCase() : key.toLowerCase() };
  for (const part of parts.slice(0, -1)) {
    const normalized = part.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control') combo.ctrl = true;
    else if (normalized === 'shift') combo.shift = true;
    else if (normalized === 'alt' || normalized === 'option') combo.alt = true;
    else return null;
  }
  return combo;
}

function combosFromArgs(args: HarnessKeybindingArgs): KeyCombo[] {
  if (Array.isArray(args.combos)) {
    const combos = args.combos.map(normalizeCombo);
    if (combos.every((combo): combo is KeyCombo => combo !== null)) return combos;
    throw new Error('set_keybinding combos must be objects with key and optional boolean ctrl/shift/alt fields.');
  }
  const combo = normalizeCombo(args.combo);
  if (combo) return [combo];
  const fields = readFieldMap(args.fields);
  const fieldCombo = normalizeCombo(fields);
  if (fieldCombo) return [fieldCombo];
  const labelCombo = parseComboLabel(readString(args.value));
  if (labelCombo) return [labelCombo];
  throw new Error('set_keybinding requires combo, combos, fields.key, or a value such as "Ctrl+G".');
}

function comboFingerprint(combo: KeyCombo): string {
  return `${combo.key}:${combo.ctrl ? 1 : 0}:${combo.shift ? 1 : 0}:${combo.alt ? 1 : 0}`;
}

function combosEqual(left: readonly KeyCombo[], right: readonly KeyCombo[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((combo, index) => comboFingerprint(combo) === comboFingerprint(right[index]));
}

function formatCombo(manager: KeybindingsManager | null, combo: KeyCombo): string {
  if (manager) return manager.formatCombo(combo);
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join('+');
}

function describeCombo(manager: KeybindingsManager | null, combo: KeyCombo): Record<string, unknown> {
  return {
    key: combo.key,
    ctrl: combo.ctrl === true,
    shift: combo.shift === true,
    alt: combo.alt === true,
    label: formatCombo(manager, combo),
  };
}

function keybindingLookupFromArgs(args: HarnessKeybindingArgs): { readonly source: KeybindingLookup['source']; readonly input: string } | null {
  const actionId = readString(args.actionId);
  if (actionId) return { source: 'actionId', input: actionId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const key = readString(args.key);
  if (key) return { source: 'key', input: key };
  const query = readString(args.query);
  if (query) return { source: 'query', input: query };
  return null;
}

function bindingSearchText(manager: KeybindingsManager | null, entry: KeybindingEntry): string {
  return [
    entry.action,
    entry.description,
    ...entry.combos.map((combo) => comboFingerprint(combo)),
    ...entry.combos.map((combo) => formatCombo(manager, combo)),
  ].join('\n').toLowerCase();
}

function bindingCandidate(manager: KeybindingsManager | null, entry: KeybindingEntry): Record<string, unknown> {
  return {
    action: entry.action,
    description: entry.description,
    labels: entry.combos.map((combo) => formatCombo(manager, combo)),
    modelRoute: keybindingModelRoute(entry.action),
    inspectRoute: `agent_harness mode:"keybinding" actionId:"${entry.action}"`,
  };
}

function bindingMatches(manager: KeybindingsManager | null, entry: KeybindingEntry, query: string): boolean {
  if (!query) return true;
  return bindingSearchText(manager, entry).includes(query.toLowerCase());
}

function resolveHarnessKeybinding(context: CommandContext, args: HarnessKeybindingArgs): KeybindingResolution | null {
  const manager = readKeybindingsManager(context);
  const lookup = keybindingLookupFromArgs(args);
  if (!lookup) return null;
  const entries = manager?.getAll() ?? defaultKeybindingEntries();
  if (isKeyAction(lookup.input)) return { status: 'found', action: lookup.input, lookup: { ...lookup, resolvedBy: 'action' } };
  const inputLower = lookup.input.toLowerCase();
  const ciActions = entries.filter((entry) => entry.action.toLowerCase() === inputLower);
  if (ciActions.length === 1) return { status: 'found', action: ciActions[0]!.action, lookup: { ...lookup, resolvedBy: 'case-insensitive-action' } };
  if (ciActions.length > 1) return { status: 'ambiguous', input: lookup.input, candidates: ciActions.map((entry) => bindingCandidate(manager, entry)).slice(0, 8) };
  const matches = entries.filter((entry) => bindingMatches(manager, entry, lookup.input));
  if (matches.length === 1) return { status: 'found', action: matches[0]!.action, lookup: { ...lookup, resolvedBy: 'search' } };
  if (matches.length > 1) return { status: 'ambiguous', input: lookup.input, candidates: matches.map((entry) => bindingCandidate(manager, entry)).slice(0, 8) };
  return null;
}

function keybindingModelRoute(action: KeyAction): string {
  const route = keybindingOperationRoute(action);
  if (route.preferredMode === 'run_keybinding') return `workspace action:"run_keybinding" actionId:"${action}"`;
  if (route.preferredMode === 'open_ui_surface' && route.surfaceId) return `workspace action:"open" surfaceId:"${route.surfaceId}"`;
  if (route.preferredMode === 'open_ui_surface') return 'workspace action:"open"';
  if (route.preferredMode === 'run_command' && route.command) return `workspace action:"run_command" command:"${route.command}"`;
  if (route.preferredMode === 'run_command') return 'workspace action:"run_command"';
  return 'direct-user-interaction';
}

function keybindingModelAccess(action: KeyAction, operation: KeybindingOperationRoute): Record<string, unknown> {
  return {
    inspect: `agent_harness mode:"keybinding" actionId:"${action}"`,
    run: operation.supported ? `agent_harness mode:"run_keybinding" actionId:"${action}" confirm:true explicitUserRequest:"..."` : 'not exposed',
    set: `agent_harness mode:"set_keybinding" actionId:"${action}" combo:{...} confirm:true explicitUserRequest:"..."`,
    reset: `agent_harness mode:"reset_keybinding" actionId:"${action}" confirm:true explicitUserRequest:"..."`,
    preferred: keybindingModelRoute(action),
    directInspect: `workspace action:"keybinding" actionId:"${action}"`,
    directRun: operation.supported ? `workspace action:"run_keybinding" actionId:"${action}" confirm:true explicitUserRequest:"..."` : 'not exposed',
    directSet: `workspace action:"set_keybinding" actionId:"${action}" combo:{...} confirm:true explicitUserRequest:"..."`,
    directReset: `workspace action:"reset_keybinding" actionId:"${action}" confirm:true explicitUserRequest:"..."`,
  };
}

function describeBinding(manager: KeybindingsManager | null, action: KeyAction, combos: KeyCombo[], lookup?: KeybindingLookup): Record<string, unknown> {
  const defaults = DEFAULT_KEYBINDINGS[action];
  const customized = !combosEqual(combos, defaults);
  const modelOperation = keybindingOperationRoute(action);
  return {
    action,
    description: ACTION_DESCRIPTIONS[action],
    ...(lookup ? { lookup } : {}),
    bindings: combos.map((combo) => describeCombo(manager, combo)),
    labels: combos.map((combo) => formatCombo(manager, combo)),
    defaultBindings: defaults.map((combo) => describeCombo(manager, combo)),
    customized,
    source: manager ? (customized ? 'custom' : 'default') : 'default-fallback',
    modelRoute: keybindingModelRoute(action),
    inspectRoute: `agent_harness mode:"keybinding" actionId:"${action}"`,
    modelAccess: keybindingModelAccess(action, modelOperation),
    modelOperation,
  };
}

function keybindingOperationRoute(action: KeyAction): KeybindingOperationRoute {
  switch (action) {
    case 'clear-cancel':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Runs the available cancel-generation route. Prompt clearing and double-press exit remain direct user interaction.',
      };
    case 'screen-clear':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Runs the available clear-screen route.',
      };
    case 'activity-open':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        confirmation: 'Direct user interaction only.',
        note: 'Opens the Activity modal (running work, what needs you, what is coming up, recent activity).',
      };
    case 'workspace-picker':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'agent-workspace',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Opens the Agent workspace home.',
      };
    case 'workspace-close':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Dismisses the Agent workspace.',
      };
    case 'workspace-close-all':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Dismisses the Agent workspace (alias chord: Ctrl+Shift+X has the same effect as Ctrl+X).',
      };
    case 'history-search':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'prompt-history-search',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Opens the visible prompt-history search overlay; optional search text may be supplied with value.',
      };
    case 'search':
      return {
        supported: true,
        effect: 'visible-ui-navigation',
        preferredMode: 'run_keybinding',
        surfaceId: 'conversation-search',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Opens the visible conversation search overlay; optional search text may be supplied with value.',
      };
    case 'paste':
      return {
        supported: true,
        effect: 'shell-action',
        preferredMode: 'run_keybinding',
        command: '/paste',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Runs the paste route and reports whether text, image, or nothing was pasted.',
      };
    case 'block-copy':
    case 'bookmark':
    case 'block-save':
      return {
        supported: true,
        effect: 'visible-ui-interaction',
        preferredMode: 'run_keybinding',
        surfaceId: 'block-actions',
        confirmation: 'agent_harness mode:"run_keybinding" requires confirm:true and explicitUserRequest.',
        note: 'Opens the visible nearest-block actions surface. The exact block action remains an interactive visible-shell selection because it depends on cursor/scroll position.',
      };
    case 'workspace-tab-next':
    case 'workspace-tab-prev':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'open_ui_surface',
        surfaceId: 'agent-workspace',
        confirmation: 'Use open_ui_surface with confirm:true and an explicit categoryId/target instead of cycling hidden UI state.',
        note: 'Category cycling depends on the live workspace focus position. The model should open the intended Agent workspace category directly.',
      };
    case 'copy-selection':
      return {
        supported: false,
        effect: 'clipboard-selection',
        preferredMode: 'direct-user-interaction',
        confirmation: 'No model operation is exposed.',
        note: 'Terminal text selection is outside the Agent command context. Use transcript/session export or a content-specific model route when a concrete artifact is needed.',
      };
    case 'delete-word':
    case 'line-start':
    case 'next-error-line-end':
    case 'kill-line':
    case 'clear-prompt':
    case 'undo':
    case 'redo':
      return {
        supported: false,
        effect: 'prompt-editor-state',
        preferredMode: 'direct-user-interaction',
        confirmation: 'No model operation is exposed.',
        note: 'This shortcut mutates live prompt-buffer cursor/edit state that is not part of the model tool contract.',
      };
    case 'focus-work-tree':
      return {
        supported: false,
        effect: 'visible-ui-navigation',
        preferredMode: 'direct-user-interaction',
        confirmation: 'Direct user interaction only.',
        note: 'Moves the keyboard onto the conversation work tree: arrows move and fold, Enter opens a tool call, y copies, Esc returns to the composer.',
      };
  }
}

/**
 * Preserve an unreadable keybindings file instead of overwriting it: it is
 * renamed to a single fixed `.corrupt` slot, overwritten each time so the
 * quarantine cannot accumulate. Paths and byte counts are logged, never contents.
 */
function quarantineOverrideFile(configPath: string, bytes: number, reason: string): void {
  const quarantinePath = `${configPath}.corrupt`;
  let preserved = false;
  try {
    renameSync(configPath, quarantinePath);
    preserved = true;
  } catch {
    preserved = false;
  }
  logger.error('Keybindings config was unreadable; continuing with no overrides', {
    configPath,
    bytes,
    preserved,
    ...(preserved ? { quarantinePath } : {}),
    reason,
  });
}

/**
 * Read the user's keybinding overrides, degrading to "no overrides" for anything
 * a crash can leave behind, an unreadable file, a zero-byte file, a truncated
 * JSON body, or a body that is not a JSON object. Existence is not validity, and
 * a torn file must not take down every read path that touches keybindings.
 */
function readOverrideFile(configPath: string): KeybindingsOverrideFile {
  if (!existsSync(configPath)) return {};
  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    logger.warn('Keybindings config could not be read; continuing with no overrides', {
      configPath,
      error: summarizeError(error),
    });
    return {};
  }
  if (!raw.trim()) {
    logger.warn('Keybindings config is empty (torn or interrupted write); continuing with no overrides', {
      configPath,
      bytes: Buffer.byteLength(raw, 'utf-8'),
    });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    quarantineOverrideFile(configPath, Buffer.byteLength(raw, 'utf-8'), summarizeError(error));
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    quarantineOverrideFile(configPath, Buffer.byteLength(raw, 'utf-8'), 'keybindings config is not a JSON object');
    return {};
  }
  return parsed as KeybindingsOverrideFile;
}

function writeOverrideFile(configPath: string, overrides: KeybindingsOverrideFile): void {
  writeStoreJson(configPath, overrides);
}

export function totalHarnessKeybindings(context: CommandContext): number {
  return context.workspace.keybindingsManager?.getAll().length ?? Object.keys(DEFAULT_KEYBINDINGS).length;
}

export function totalHarnessShortcuts(context: CommandContext): number {
  return totalHarnessKeybindings(context) + FIXED_SHORTCUTS.length;
}

function fixedShortcutModelRoute(shortcut: Record<string, string>): string {
  if (shortcut.key.includes('/shortcuts')) return 'workspace action:"shortcuts"';
  if (shortcut.key.includes('/keybindings')) return 'workspace action:"keybindings"';
  if (shortcut.key.includes('?') || shortcut.key.includes('F1')) return 'workspace action:"open" surfaceId:"help-overlay"';
  if (shortcut.key.includes('F2')) return 'workspace action:"open" surfaceId:"process-monitor"';
  if (shortcut.key.includes('Esc')) return 'direct-user-interaction';
  if (shortcut.key.includes('Tab')) return 'workspace action:"commands"';
  if (shortcut.key.includes('Enter')) return 'main conversation';
  return 'direct-user-interaction';
}

function describeFixedShortcut(shortcut: Record<string, string>): Record<string, unknown> {
  return {
    ...shortcut,
    source: 'fixed',
    userEditable: false,
    modelRoute: fixedShortcutModelRoute(shortcut),
    modelAccess: {
      inspectShortcuts: 'workspace action:"shortcuts"',
      inspectKeybindings: 'workspace action:"keybindings"',
      preferred: fixedShortcutModelRoute(shortcut),
    },
  };
}

export function listHarnessShortcuts(context: CommandContext, args: HarnessKeybindingArgs): Record<string, unknown> {
  const keybindings = listHarnessKeybindings(context, args);
  const query = readString(args.query).toLowerCase();
  const fixed = FIXED_SHORTCUTS
    .filter((shortcut) => !query || `${shortcut.key}\n${shortcut.description}`.toLowerCase().includes(query))
    .slice(0, readLimit(args.limit, 200))
    .map(describeFixedShortcut);
  const degraded = keybindings.status === 'degraded';
  return {
    status: degraded ? 'degraded' : 'available',
    configPath: keybindings.configPath,
    fixedShortcuts: fixed,
    configurableKeybindings: keybindings.keybindings,
    returned: fixed.length + Number(keybindings.returned ?? 0),
    total: totalHarnessShortcuts(context),
    policy: degraded
      ? 'Fixed shortcuts and default keybindings are available for discovery. Live keybinding execution and mutation require the runtime keybinding manager.'
      : 'Fixed shortcuts are runtime/editor controls. Configurable keybindings can be inspected, supported shell-safe actions can be run with run_keybinding, and bindings can be changed with set_keybinding/reset_keybinding.',
  };
}

export function listHarnessKeybindings(context: CommandContext, args: HarnessKeybindingArgs): Record<string, unknown> {
  const manager = readKeybindingsManager(context);
  const query = readString(args.query);
  const allEntries = manager?.getAll() ?? defaultKeybindingEntries();
  const entries = allEntries
    .filter((entry) => bindingMatches(manager, entry, query))
    .slice(0, readLimit(args.limit, 200))
    .map((entry) => describeBinding(manager, entry.action, entry.combos));
  return {
    status: manager ? 'available' : 'degraded',
    configPath: manager?.getConfigPath() ?? null,
    keybindings: entries,
    returned: entries.length,
    total: allEntries.length,
    policy: manager
      ? 'Reads the live resolved keybindings, including modelOperation route metadata. run_keybinding executes only supported shell-safe actions. set_keybinding/reset_keybinding write the same keybindings.json file the user can edit and reload the runtime manager.'
      : 'Live keybinding manager is unavailable; default keybindings are shown for discovery only. run_keybinding, set_keybinding, and reset_keybinding require a live manager.',
  };
}

export function describeHarnessKeybinding(context: CommandContext, args: HarnessKeybindingArgs): Record<string, unknown> | null {
  const manager = readKeybindingsManager(context);
  const resolved = resolveHarnessKeybinding(context, args);
  if (resolved?.status === 'ambiguous') return { status: 'ambiguous', input: resolved.input, candidates: resolved.candidates };
  if (!resolved) return null;
  const entries = manager?.getAll() ?? defaultKeybindingEntries();
  const entry = entries.find((candidate) => candidate.action === resolved.action);
  return entry ? {
    status: manager ? 'available' : 'degraded',
    configPath: manager?.getConfigPath() ?? null,
    ...describeBinding(manager, entry.action, entry.combos, resolved.lookup),
    ...(manager ? {} : { note: 'Default keybinding descriptor only; live run/set/reset operations require the runtime keybinding manager.' }),
  } : null;
}

function runUnavailable(action: KeyAction, route: KeybindingOperationRoute, reason?: string): Record<string, unknown> {
  return {
    status: 'keybinding_route_unavailable',
    action,
    modelOperation: route,
    ...(reason ? { reason } : {}),
  };
}

export function runHarnessKeybinding(context: CommandContext, args: HarnessKeybindingArgs): Record<string, unknown> {
  const manager = requireKeybindingsManager(context);
  const resolved = resolveHarnessKeybinding(context, args);
  if (resolved?.status === 'ambiguous') return { status: 'ambiguous', input: resolved.input, candidates: resolved.candidates };
  if (!resolved) throw new Error('run_keybinding requires a valid keybinding action id, target, key, or query.');
  const entry = manager.getAll().find((candidate) => candidate.action === resolved.action);
  if (!entry) throw new Error(`No live keybinding entry found for ${resolved.action}.`);
  const route = keybindingOperationRoute(resolved.action);
  const descriptor = {
    configPath: manager.getConfigPath(),
    ...describeBinding(manager, entry.action, entry.combos, resolved.lookup),
  };
  if (!route.supported) {
    return {
      status: 'unsupported_keybinding_action',
      action: resolved.action,
      keybinding: descriptor,
      modelOperation: route,
    };
  }

  switch (resolved.action) {
    case 'clear-cancel':
      if (!context.cancelGeneration) return runUnavailable(resolved.action, route, 'Cancel-generation route is unavailable.');
      context.cancelGeneration();
      return { status: 'executed', action: resolved.action, effect: 'cancel-generation', keybinding: descriptor };
    case 'screen-clear':
      if (!context.clearScreen) return runUnavailable(resolved.action, route, 'Clear-screen route is unavailable.');
      context.clearScreen();
      return { status: 'executed', action: resolved.action, effect: 'screen-clear', keybinding: descriptor };
    case 'workspace-picker':
      if (context.openWorkspacePicker) {
        context.openWorkspacePicker();
        return { status: 'executed', action: resolved.action, effect: 'agent-workspace-opened', route: 'openWorkspacePicker', keybinding: descriptor };
      }
      if (context.openAgentWorkspace) {
        context.openAgentWorkspace('home');
        return { status: 'executed', action: resolved.action, effect: 'agent-workspace-opened', route: 'openAgentWorkspace', categoryId: 'home', keybinding: descriptor };
      }
      return runUnavailable(resolved.action, route, 'No workspace picker or Agent workspace route is available.');
    case 'workspace-close': {
      const dismissedAgentWorkspace = context.dismissAgentWorkspace?.() ?? false;
      if (dismissedAgentWorkspace) {
        return {
          status: 'executed',
          action: resolved.action,
          effect: 'agent-workspace-dismissed',
          route: 'dismissAgentWorkspace',
          keybinding: descriptor,
        };
      }
      if (!context.focusPrompt) return runUnavailable(resolved.action, route, 'No active Agent workspace or prompt focus route is available.');
      context.focusPrompt();
      context.renderRequest();
      return {
        status: 'executed',
        action: resolved.action,
        effect: 'prompt-focused',
        keybinding: descriptor,
      };
    }
    case 'workspace-close-all': {
      const dismissedAgentWorkspace = context.dismissAgentWorkspace?.() ?? false;
      if (dismissedAgentWorkspace) {
        return {
          status: 'executed',
          action: resolved.action,
          effect: 'agent-workspace-dismissed',
          route: 'dismissAgentWorkspace',
          keybinding: descriptor,
        };
      }
      if (!context.focusPrompt) return runUnavailable(resolved.action, route, 'No active Agent workspace or prompt focus route is available.');
      context.focusPrompt();
      context.renderRequest();
      return {
        status: 'executed',
        action: resolved.action,
        effect: 'prompt-focused',
        keybinding: descriptor,
      };
    }
    case 'history-search': {
      if (!context.openPromptHistorySearch) return runUnavailable(resolved.action, route, 'Prompt history search route is unavailable.');
      const query = readString(args.value);
      context.openPromptHistorySearch(query || undefined);
      return { status: 'executed', action: resolved.action, effect: 'prompt-history-search-opened', query, keybinding: descriptor };
    }
    case 'search': {
      if (!context.openConversationSearch) return runUnavailable(resolved.action, route, 'Conversation search route is unavailable.');
      const query = readString(args.value);
      context.openConversationSearch(query || undefined);
      return { status: 'executed', action: resolved.action, effect: 'conversation-search-opened', query, keybinding: descriptor };
    }
    case 'paste': {
      if (!context.pasteFromClipboard) return runUnavailable(resolved.action, route, 'Paste route is unavailable.');
      const pasted = context.pasteFromClipboard();
      return { status: 'executed', action: resolved.action, effect: 'paste-from-clipboard', pasted, keybinding: descriptor };
    }
    case 'block-copy':
    case 'bookmark':
    case 'block-save': {
      if (!context.openBlockActions) return runUnavailable(resolved.action, route, 'Block action surface route is unavailable.');
      const opened = context.openBlockActions();
      return opened
        ? {
          status: 'visible_interaction_required',
          action: resolved.action,
          effect: 'block-actions-opened',
          keybinding: descriptor,
          note: 'The block action surface is open. Selecting the exact nearest-block action remains visible interactive shell work.',
        }
        : {
          status: 'not_opened',
          action: resolved.action,
          effect: 'block-actions',
          keybinding: descriptor,
          note: 'The current shell did not have an empty prompt plus nearby block required for block actions.',
        };
    }
    default:
      return {
        status: 'unsupported_keybinding_action',
        action: resolved.action,
        keybinding: descriptor,
        modelOperation: route,
      };
  }
}

export function setHarnessKeybinding(context: CommandContext, args: HarnessKeybindingArgs): Record<string, unknown> {
  const manager = requireKeybindingsManager(context);
  const resolved = resolveHarnessKeybinding(context, args);
  if (resolved?.status === 'ambiguous') throw new Error(`Ambiguous keybinding action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved) throw new Error('set_keybinding requires a valid keybinding action id, target, or query.');
  const combos = combosFromArgs(args);
  const configPath = manager.getConfigPath();
  const overrides = readOverrideFile(configPath);
  overrides[resolved.action] = combos.length === 1 ? combos[0] : combos;
  writeOverrideFile(configPath, overrides);
  manager.loadFromDisk();
  return {
    status: 'updated',
    configPath,
    keybinding: describeHarnessKeybinding(context, { actionId: resolved.action }),
    lookup: resolved.lookup,
  };
}

export function resetHarnessKeybinding(context: CommandContext, args: HarnessKeybindingArgs): Record<string, unknown> {
  const manager = requireKeybindingsManager(context);
  const resolved = resolveHarnessKeybinding(context, args);
  if (resolved?.status === 'ambiguous') throw new Error(`Ambiguous keybinding action ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved) throw new Error('reset_keybinding requires a valid keybinding action id, target, or query.');
  const configPath = manager.getConfigPath();
  const overrides = readOverrideFile(configPath);
  delete overrides[resolved.action];
  writeOverrideFile(configPath, overrides);
  manager.loadFromDisk();
  return {
    status: 'reset',
    configPath,
    keybinding: describeHarnessKeybinding(context, { actionId: resolved.action }),
    lookup: resolved.lookup,
  };
}
