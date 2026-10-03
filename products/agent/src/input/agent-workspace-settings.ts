import { existsSync, readFileSync } from 'node:fs';
import { getAgentSettingsSchema, readAgentSettingValue, type AgentConfigSetting } from '../config/settings-catalog.ts';
import type { PendingSubscriptionLogin, ProviderSubscription } from '@goodvibes-jev/engine/sdk/platform/config';
import { setHarnessSetting } from '../agent/harness-control.ts';
import { applyThemeModeSettingChange, applyThemeNameSettingChange, THEME_MODE_CONFIG_KEY, THEME_NAME_CONFIG_KEY } from '../renderer/theme-mode-config.ts';
import { listThemeChoices, normalizeThemeName } from '../renderer/theme.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { CommandContext } from './command-registry.ts';
import type {
  AgentWorkspaceAction,
  AgentWorkspaceActionResult,
  AgentWorkspaceLocalEditor,
  AgentWorkspaceRuntimeSnapshot,
} from './agent-workspace-types.ts';

const GOODVIBES_TUI_SURFACE_ROOT = 'tui';

const TUI_IMPORTABLE_SETTING_PREFIXES = [
  'display.',
  'provider.',
  'behavior.',
  'storage.',
  'permissions.',
  'ui.',
  'tts.',
  'surfaces.',
  'helper.',
  'tools.',
  'release.',
  'automation.',
] as const;

type SettingActionEffect =
  | {
    readonly kind: 'result';
    readonly status: string;
    readonly result: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'apply';
    readonly setting: AgentConfigSetting;
    readonly value: unknown;
  }
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly result: AgentWorkspaceActionResult;
  };

export interface SettingMutationOutcome {
  readonly status: string;
  readonly result: AgentWorkspaceActionResult;
}

export interface TuiSettingsImportOutcome extends SettingMutationOutcome {
  readonly runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
}

export interface AgentWorkspaceSettingActionDisplay {
  readonly setting: string;
  readonly defaultValue: string;
  readonly currentValue: string;
}

type TuiImportStatus = 'would_import' | 'unchanged' | 'skipped';

interface TuiSettingsImportSource {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly sourcePackage: string;
  readonly surfaceRoot: string;
  readonly scope: 'user' | 'project';
  readonly ownership: 'source-owned';
  readonly mutatesSource: false;
  readonly status: 'missing' | 'loaded' | 'invalid' | 'error';
  readonly importableSettings: number;
  readonly error?: string;
}

interface GoodVibesSettingsImportSourceCatalogEntry {
  readonly packageId: string;
  readonly surfaceRoot: string;
  readonly scopes: readonly string[];
  readonly status: 'implemented';
  readonly ownership: 'source-owned';
  readonly mutatesSource: false;
}

interface TuiSettingImportPlanEntry {
  readonly key: string;
  readonly source: string;
  readonly value: unknown;
  readonly status: TuiImportStatus;
  readonly current: unknown;
  readonly incoming: unknown;
  readonly reason?: string;
}

interface TuiSubscriptionImportPlanEntry {
  readonly provider?: string;
  readonly kind: 'active' | 'pending';
  readonly status: TuiImportStatus;
  readonly reason?: string;
}

interface TuiSettingsImportPlan {
  readonly sources: readonly TuiSettingsImportSource[];
  readonly settings: readonly TuiSettingImportPlanEntry[];
  readonly subscriptions: readonly TuiSubscriptionImportPlanEntry[];
  readonly parseErrors: readonly string[];
}

export interface TuiSettingsImportPreview {
  readonly summary: {
    readonly settingsToImport: number;
    readonly settingsUnchanged: number;
    readonly settingsSkipped: number;
    readonly activeSubscriptionsToImport: number;
    readonly pendingSubscriptionsToImport: number;
    readonly subscriptionsUnchanged: number;
    readonly subscriptionsSkipped: number;
    readonly parseErrors: number;
  };
  readonly sourceCatalog: readonly GoodVibesSettingsImportSourceCatalogEntry[];
  readonly sources: readonly TuiSettingsImportSource[];
  readonly settings: readonly {
    readonly key: string;
    readonly source: string;
    readonly status: TuiImportStatus;
    readonly current: unknown;
    readonly incoming: unknown;
    readonly reason?: string;
  }[];
  readonly subscriptions: readonly TuiSubscriptionImportPlanEntry[];
  readonly policy: {
    readonly effect: 'read-only' | 'state';
    readonly confirmation: 'required-for-apply';
    readonly boundary: string;
  };
}

const GOODVIBES_SETTINGS_IMPORT_SOURCE_CATALOG: readonly GoodVibesSettingsImportSourceCatalogEntry[] = [
  {
    packageId: 'goodvibes-tui',
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    scopes: ['user-settings', 'project-settings', 'provider-subscriptions'],
    status: 'implemented',
    ownership: 'source-owned',
    mutatesSource: false,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function readNestedSettingValue(record: Record<string, unknown>, key: string): unknown {
  let cursor: unknown = record;
  for (const part of key.split('.')) {
    if (!isRecord(cursor) || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function canImportTuiSetting(key: string): boolean {
  // The allowlist below is the whole filter. This also used to exclude
  // host-owned keys, which never changed the outcome: no locked domain
  // (`relay.`, `danger.`) appears in TUI_IMPORTABLE_SETTING_PREFIXES.
  return TUI_IMPORTABLE_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSecretLikeSettingKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase();
  if (normalized.endsWith('secret.policy')) return false;
  return /(?:secret|token|password|api[-_.]?key|api\.key|signing)/i.test(normalized);
}

function compactSettingValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return '(unset)';
  if (isSecretLikeSettingKey(key)) return value === '' ? '(empty)' : '(secret)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '(invalid)';
  if (typeof value === 'string') {
    if (value.length === 0) return '(empty)';
    if (value.startsWith('goodvibes://secrets/')) return '(secret)';
    return value.length > 36 ? `${value.slice(0, 33)}...` : value;
  }
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  if (isRecord(value)) return '{...}';
  return String(value);
}

function redactImportValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value) return value;
  if (isSecretLikeSettingKey(key)) {
    return value.startsWith('goodvibes://secrets/') ? '<secret-ref>' : '<redacted>';
  }
  return value;
}

function readRecordMap(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return isRecord(value) ? Object.values(value) : [];
}

function isProviderSubscription(value: unknown): value is ProviderSubscription {
  return isRecord(value)
    && typeof value.provider === 'string'
    && typeof value.accessToken === 'string'
    && typeof value.tokenType === 'string'
    && value.authMode === 'oauth'
    && typeof value.overrideAmbientApiKeys === 'boolean'
    && typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number';
}

function isPendingSubscriptionLogin(value: unknown): value is PendingSubscriptionLogin {
  return isRecord(value)
    && typeof value.provider === 'string'
    && typeof value.state === 'string'
    && typeof value.verifier === 'string'
    && typeof value.redirectUri === 'string'
    && typeof value.createdAt === 'number';
}

function planTuiSubscriptions(context: CommandContext, parseErrors: string[]): readonly TuiSubscriptionImportPlanEntry[] {
  const shellPaths = context.workspace.shellPaths;
  const manager = context.platform.subscriptionManager;
  const result: TuiSubscriptionImportPlanEntry[] = [];
  if (!shellPaths || !manager) return result;

  const sourcePath = shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'subscriptions.json');
  try {
    const store = readJsonRecord(sourcePath);
    if (!store) return result;
    for (const entry of readRecordMap(store, 'subscriptions')) {
      if (!isProviderSubscription(entry)) {
        result.push({ kind: 'active', status: 'skipped', reason: 'active subscription with invalid shape' });
        continue;
      }
      if (valuesMatch(manager.get(entry.provider), entry)) {
        result.push({ provider: entry.provider, kind: 'active', status: 'unchanged' });
        continue;
      }
      result.push({ provider: entry.provider, kind: 'active', status: 'would_import' });
    }
    for (const entry of readRecordMap(store, 'pending')) {
      if (!isPendingSubscriptionLogin(entry)) {
        result.push({ kind: 'pending', status: 'skipped', reason: 'pending subscription with invalid shape' });
        continue;
      }
      if (valuesMatch(manager.getPending(entry.provider), entry)) {
        result.push({ provider: entry.provider, kind: 'pending', status: 'unchanged' });
        continue;
      }
      result.push({ provider: entry.provider, kind: 'pending', status: 'would_import' });
    }
  } catch (error) {
    parseErrors.push(`subscriptions: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

function applyTuiSubscriptions(context: CommandContext, parseErrors: string[]): {
  readonly importedActive: string[];
  readonly importedPending: string[];
  readonly unchangedActive: string[];
  readonly unchangedPending: string[];
  readonly skipped: string[];
} {
  const shellPaths = context.workspace.shellPaths;
  const manager = context.platform.subscriptionManager;
  const result = {
    importedActive: [] as string[],
    importedPending: [] as string[],
    unchangedActive: [] as string[],
    unchangedPending: [] as string[],
    skipped: [] as string[],
  };
  if (!shellPaths || !manager) return result;

  const sourcePath = shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'subscriptions.json');
  try {
    const store = readJsonRecord(sourcePath);
    if (!store) return result;
    for (const entry of readRecordMap(store, 'subscriptions')) {
      if (!isProviderSubscription(entry)) {
        result.skipped.push('active subscription with invalid shape');
        continue;
      }
      if (valuesMatch(manager.get(entry.provider), entry)) {
        result.unchangedActive.push(entry.provider);
        continue;
      }
      manager.saveSubscription(entry);
      result.importedActive.push(entry.provider);
    }
    for (const entry of readRecordMap(store, 'pending')) {
      if (!isPendingSubscriptionLogin(entry)) {
        result.skipped.push('pending subscription with invalid shape');
        continue;
      }
      if (valuesMatch(manager.getPending(entry.provider), entry)) {
        result.unchangedPending.push(entry.provider);
        continue;
      }
      manager.savePending(entry);
      result.importedPending.push(entry.provider);
    }
  } catch (error) {
    parseErrors.push(`subscriptions: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

export function agentWorkspaceSettingSchema(context: CommandContext | null, key: string): AgentConfigSetting | null {
  const config = context?.platform?.configManager;
  return config ? getAgentSettingsSchema(config).find(setting => setting.key === key) ?? null : null;
}

export function isAgentWorkspaceActionVisible(context: CommandContext | null, action: AgentWorkspaceAction): boolean {
  const key = action.visibleWhenSettingKey?.trim();
  if (!key) return true;
  const configManager = context?.platform?.configManager;
  if (!configManager) return false;
  const setting = agentWorkspaceSettingSchema(context, key);
  return setting !== null && readAgentSettingValue(configManager, setting) === action.visibleWhenSettingValue;
}

export function buildAgentWorkspaceSettingActionEffect(
  context: CommandContext | null,
  action: AgentWorkspaceAction,
): SettingActionEffect {
  const settingKey = action.settingKey?.trim();
  const configManager = context?.platform?.configManager;
  if (!settingKey || !configManager) {
    return {
      kind: 'result',
      status: 'Setting is unavailable in this runtime.',
      result: {
        kind: 'error',
        title: 'Setting unavailable',
        detail: action.detail,
        safety: action.safety,
      },
    };
  }
  const setting = agentWorkspaceSettingSchema(context, settingKey);
  if (!setting) {
    return {
      kind: 'result',
      status: `Unknown setting: ${settingKey}`,
      result: {
        kind: 'error',
        title: 'Unknown setting',
        detail: `No Agent setting exists for ${settingKey}.`,
        safety: action.safety,
      },
    };
  }

  if (action.settingValueHint !== undefined) {
    return { kind: 'apply', setting, value: action.settingValueHint };
  }

  const currentValue = readAgentSettingValue(configManager, setting);
  // The theme cycles through the selectable themes ('system', then the
  // bundled catalog), not the raw schema enum, which also carries the legacy
  // 'vaporwave' alias of goodvibes-neon.
  if (String(setting.key) === THEME_NAME_CONFIG_KEY) {
    const names = listThemeChoices().map((choice) => choice.name);
    const currentIndex = Math.max(0, names.indexOf(normalizeThemeName(currentValue)));
    return { kind: 'apply', setting, value: names[(currentIndex + 1) % names.length]! };
  }
  if (setting.type === 'boolean') {
    return { kind: 'apply', setting, value: !Boolean(currentValue) };
  }
  if (setting.type === 'enum' && setting.enumValues && setting.enumValues.length > 0) {
    const currentIndex = Math.max(0, setting.enumValues.indexOf(String(currentValue)));
    return { kind: 'apply', setting, value: setting.enumValues[(currentIndex + 1) % setting.enumValues.length]! };
  }

  return {
    kind: 'editor',
    editor: createSettingEditor(setting, String(currentValue ?? ''), action),
    status: `Editing ${setting.key}.`,
    result: {
      kind: 'guidance',
      title: `Edit ${setting.key}`,
      detail: setting.description,
      safety: action.safety,
    },
  };
}

export function buildAgentWorkspaceSettingActionDisplay(
  context: CommandContext | null,
  action: AgentWorkspaceAction,
): AgentWorkspaceSettingActionDisplay | null {
  const settingKey = action.settingKey?.trim();
  const configManager = context?.platform?.configManager;
  if (!settingKey || !configManager) return null;

  const setting = agentWorkspaceSettingSchema(context, settingKey);
  if (!setting) return null;
  const currentValue = readAgentSettingValue(configManager, setting);

  return {
    setting: action.label || settingKey,
    defaultValue: compactSettingValue(settingKey, setting.default),
    currentValue: compactSettingValue(settingKey, currentValue),
  };
}

export async function applyAgentWorkspaceSettingValue(
  context: CommandContext | null,
  setting: AgentConfigSetting,
  value: unknown,
): Promise<SettingMutationOutcome> {
  const configManager = context?.platform?.configManager;
  if (!configManager) {
    return {
      status: 'Setting is unavailable in this runtime.',
      result: {
        kind: 'error',
        title: `${setting.key} update failed`,
        detail: 'The Agent workspace has no config manager for this runtime.',
        safety: 'safe',
      },
    };
  }
  if (String(setting.key) === THEME_NAME_CONFIG_KEY) {
    try {
      // Written through the same path as every other key, then applied to
      // this process now (palettes rebuild, full repaint); this surface has no
      // onSettingApplied hook, so it runs the shared apply hook directly.
      const written = await setHarnessSetting(configManager, context?.platform?.secretsManager, setting.key, value);
      const { message } = applyThemeNameSettingChange(written.current, () => context?.clearScreen?.());
      return {
        status: message,
        result: {
          kind: 'refreshed',
          title: `${setting.key} updated`,
          detail: message,
          safety: 'safe',
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: detail,
        result: {
          kind: 'error',
          title: `${setting.key} update failed`,
          detail,
          safety: 'safe',
        },
      };
    }
  }
  if (setting.key === THEME_MODE_CONFIG_KEY) {
    try {
      // display.themeMode is a real CONFIG_SCHEMA entry now (SDK 2.0+), so
      // this branch is no longer working around a missing schema key, the
      // direct setDynamic write below is the same round-trip every other
      // client-owned key would get, and this key isn't daemon-owned or
      // secret-backed, so there is no ownership routing to gain by going
      // through setHarnessSetting instead. What still makes this key special
      // is the live single-process side effect below: the classic settings
      // modal wires onSettingApplied (ui-openers.ts) to flip the active
      // render mode and repaint; this workspace surface has no equivalent
      // hook, so it runs the ONE shared apply hook directly, forced
      // dark/light flips the active mode now with a full repaint; auto only
      // re-probes at startup, stated honestly in the returned message.
      configManager.setDynamic(setting.key, value);
      const { message } = applyThemeModeSettingChange(value, () => context?.clearScreen?.());
      return {
        status: message,
        result: {
          kind: 'refreshed',
          title: `${setting.key} updated`,
          detail: message,
          safety: 'safe',
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: detail,
        result: {
          kind: 'error',
          title: `${setting.key} update failed`,
          detail,
          safety: 'safe',
        },
      };
    }
  }
  try {
    const result = await setHarnessSetting(configManager, context?.platform?.secretsManager, setting.key, value);
    return {
      status: `${result.key} set.`,
      result: {
        kind: 'refreshed',
        title: `${result.key} updated`,
        detail: `Current value: ${String(result.current)}`,
        safety: 'safe',
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: detail,
      result: {
        kind: 'error',
        title: `${setting.key} update failed`,
        detail,
        safety: 'safe',
      },
    };
  }
}

function buildTuiSettingsImportPlan(context: CommandContext | null): TuiSettingsImportPlan | null {
  const shellPaths = context?.workspace?.shellPaths;
  const configManager = context?.platform?.configManager;
  if (!context || !shellPaths || !configManager) return null;

  const sourceInputs: readonly Omit<TuiSettingsImportSource, 'status' | 'importableSettings' | 'error'>[] = [
    {
      id: 'goodvibes-tui:user-settings',
      label: 'goodvibes-tui user settings',
      path: shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'settings.json'),
      sourcePackage: 'goodvibes-tui',
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      scope: 'user',
      ownership: 'source-owned',
      mutatesSource: false,
    },
    {
      id: 'goodvibes-tui:project-settings',
      label: 'goodvibes-tui project settings',
      path: shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'settings.json'),
      sourcePackage: 'goodvibes-tui',
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      scope: 'project',
      ownership: 'source-owned',
      mutatesSource: false,
    },
  ];
  const values = new Map<string, { readonly value: unknown; readonly source: string }>();
  const parseErrors: string[] = [];
  const sources: TuiSettingsImportSource[] = [];
  for (const source of sourceInputs) {
    if (!existsSync(source.path)) {
      sources.push({ ...source, status: 'missing', importableSettings: 0 });
      continue;
    }
    try {
      const record = readJsonRecord(source.path);
      if (!record) {
        const message = `${source.label}: settings store is not an object`;
        parseErrors.push(message);
        sources.push({ ...source, status: 'invalid', importableSettings: 0, error: message });
        continue;
      }
      let importableSettings = 0;
      for (const setting of configManager.getSchema()) {
        if (!canImportTuiSetting(setting.key)) continue;
        const value = readNestedSettingValue(record, setting.key);
        if (value === undefined) continue;
        importableSettings += 1;
        values.set(setting.key, { value, source: source.id });
      }
      sources.push({ ...source, status: 'loaded', importableSettings });
    } catch (error) {
      const message = `${source.label}: ${error instanceof Error ? error.message : String(error)}`;
      parseErrors.push(message);
      sources.push({ ...source, status: 'error', importableSettings: 0, error: message });
    }
  }

  const settings: TuiSettingImportPlanEntry[] = [];
  for (const [key, entry] of values) {
    const setting = agentWorkspaceSettingSchema(context, key);
    if (!setting || setting.kind === 'host') continue;
    const current = configManager.get(setting.key);
    const status: TuiImportStatus = valuesMatch(current, entry.value) ? 'unchanged' : 'would_import';
    settings.push({
      key: setting.key,
      source: entry.source,
      value: entry.value,
      status,
      current: redactImportValue(setting.key, current),
      incoming: redactImportValue(setting.key, entry.value),
    });
  }
  const subscriptions = planTuiSubscriptions(context, parseErrors);
  return { sources, settings, subscriptions, parseErrors };
}

export function previewAgentWorkspaceTuiSettingsImport(context: CommandContext | null): TuiSettingsImportPreview | null {
  const plan = buildTuiSettingsImportPlan(context);
  if (!plan) return null;
  return {
    summary: {
      settingsToImport: plan.settings.filter((entry) => entry.status === 'would_import').length,
      settingsUnchanged: plan.settings.filter((entry) => entry.status === 'unchanged').length,
      settingsSkipped: plan.settings.filter((entry) => entry.status === 'skipped').length,
      activeSubscriptionsToImport: plan.subscriptions.filter((entry) => entry.kind === 'active' && entry.status === 'would_import').length,
      pendingSubscriptionsToImport: plan.subscriptions.filter((entry) => entry.kind === 'pending' && entry.status === 'would_import').length,
      subscriptionsUnchanged: plan.subscriptions.filter((entry) => entry.status === 'unchanged').length,
      subscriptionsSkipped: plan.subscriptions.filter((entry) => entry.status === 'skipped').length,
      parseErrors: plan.parseErrors.length,
    },
    sourceCatalog: GOODVIBES_SETTINGS_IMPORT_SOURCE_CATALOG,
    sources: plan.sources,
    settings: plan.settings.map((entry) => ({
      key: entry.key,
      source: entry.source,
      status: entry.status,
      current: entry.current,
      incoming: entry.incoming,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
    subscriptions: plan.subscriptions,
    policy: {
      effect: 'read-only',
      confirmation: 'required-for-apply',
      boundary: 'Preview does not mutate state. Apply imports only Agent-owned settings and provider subscriptions from published GoodVibes platform sources.',
    },
  };
}

export async function importAgentWorkspaceTuiSettings(context: CommandContext | null): Promise<TuiSettingsImportOutcome> {
  const shellPaths = context?.workspace?.shellPaths;
  const configManager = context?.platform?.configManager;
  if (!context || !shellPaths || !configManager) {
    return {
      status: 'GoodVibes settings import is unavailable in this runtime.',
      runtimeSnapshot: null,
      result: {
        kind: 'error',
        title: 'Import unavailable',
        detail: 'The workspace cannot locate shell paths or the Agent config manager.',
        safety: 'safe',
      },
    };
  }

  const plan = buildTuiSettingsImportPlan(context);
  const values = plan?.settings ?? [];
  const subscriptionParseErrors: string[] = [];
  const subscriptions = applyTuiSubscriptions(context, subscriptionParseErrors);
  const parseErrors: string[] = [...new Set([...(plan?.parseErrors ?? []), ...subscriptionParseErrors])];
  const subscriptionImports = subscriptions.importedActive.length + subscriptions.importedPending.length;
  const subscriptionUnchanged = subscriptions.unchangedActive.length + subscriptions.unchangedPending.length;

  if (values.length === 0 && subscriptionImports === 0 && subscriptionUnchanged === 0 && subscriptions.skipped.length === 0) {
    const detail = parseErrors.length > 0
      ? `No importable settings or subscriptions found. ${parseErrors.join('; ')}`
      : 'No GoodVibes settings or subscription store with importable Agent-owned state was found.';
    return {
      status: 'No GoodVibes settings imported.',
      runtimeSnapshot: null,
      result: {
        kind: parseErrors.length > 0 ? 'error' : 'guidance',
        title: 'Nothing imported',
        detail,
        safety: 'safe',
      },
    };
  }

  const imported: string[] = [];
  const unchanged: string[] = [];
  const skipped: string[] = [];
  for (const entry of values) {
    const setting = agentWorkspaceSettingSchema(context, entry.key);
    if (!setting || setting.kind === 'host') continue;
    if (entry.status === 'unchanged' || valuesMatch(configManager.get(setting.key), entry.value)) {
      unchanged.push(setting.key);
      continue;
    }
    try {
      await setHarnessSetting(configManager, context?.platform?.secretsManager, setting.key, entry.value);
      imported.push(`${setting.key} (${entry.source})`);
    } catch (error) {
      skipped.push(`${setting.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  skipped.push(...subscriptions.skipped);
  const changedCount = imported.length + subscriptionImports;
  const unchangedCount = unchanged.length + subscriptionUnchanged;

  return {
    status: changedCount > 0 ? `Imported ${changedCount} GoodVibes settings item(s).` : 'No GoodVibes settings changed.',
    runtimeSnapshot: context ? buildAgentWorkspaceRuntimeSnapshot(context) : null,
    result: {
      kind: skipped.length > 0 && changedCount === 0 ? 'error' : changedCount > 0 ? 'refreshed' : 'guidance',
      title: changedCount > 0 ? 'GoodVibes settings imported' : 'No settings changed',
      detail: [
        imported.length > 0 ? `Imported: ${imported.slice(0, 10).join(', ')}${imported.length > 10 ? `, +${imported.length - 10} more` : ''}.` : '',
        subscriptions.importedActive.length > 0 ? `Imported active subscription(s): ${subscriptions.importedActive.join(', ')}.` : '',
        subscriptions.importedPending.length > 0 ? `Imported pending subscription(s): ${subscriptions.importedPending.join(', ')}.` : '',
        unchangedCount > 0 ? `${unchangedCount} item(s) already matched.` : '',
        skipped.length > 0 ? `Skipped: ${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? `; +${skipped.length - 5} more` : ''}.` : '',
        parseErrors.length > 0 ? `Parse issues: ${parseErrors.join('; ')}.` : '',
      ].filter((line) => line.length > 0).join(' '),
      safety: 'safe',
    },
  };
}

function createSettingEditor(setting: AgentConfigSetting, currentValue: string, action: AgentWorkspaceAction): AgentWorkspaceLocalEditor {
  const valueHint = setting.type === 'number'
    ? 'Enter a number.'
    : setting.type === 'string'
      ? 'Enter a value. Leave empty to clear it.'
      : setting.enumValues
        ? `Allowed values: ${setting.enumValues.join(', ')}.`
        : action.detail;
  return {
    kind: 'setting-set',
    mode: 'update',
    recordId: setting.key,
    title: `Set ${setting.key}`,
    selectedFieldIndex: 0,
    message: action.detail,
    fields: [
      {
        id: 'value',
        label: setting.key,
        value: currentValue,
        required: false,
        multiline: false,
        hint: action.settingValueHint ?? valueHint,
        redact: /(?:secret|token|password|api[-_.]?key|signing)/i.test(setting.key),
      },
    ],
  };
}
