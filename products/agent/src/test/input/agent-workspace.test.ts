import { describe, expect, test } from 'bun:test';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA, SubscriptionManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { AgentWorkspace, buildAgentWorkspaceRuntimeSnapshot, handleAgentWorkspaceToken } from '../../input/agent-workspace.ts';
import { readLiveAgentMemoryCounters } from '../../input/agent-workspace-snapshot.ts';
import { describeMemoryPromptEligibility } from '../../agent/memory-prompt.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { SETTINGS_CATEGORIES, CROSS_LISTED_SETTING_ROOTS } from '../../input/settings-modal-types.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { registerAgentWorkspaceRuntimeCommands } from '../../input/commands/agent-workspace-runtime.ts';
import { registerAgentRuntimeProfileRuntimeCommands } from '../../input/commands/agent-runtime-profile-runtime.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { readSetupWizardCheckpoint } from '../../agent/setup-wizard-checkpoint.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { createAgentRuntimeProfile, getAgentRuntimeProfilesRoot, listAgentRuntimeProfiles, readAgentRuntimeProfileSelection, setAgentRuntimeProfileSelection } from '../../agent/runtime-profile.ts';
import { renderAgentWorkspace } from '../../renderer/agent-workspace.ts';
import { renderAgentWorkspaceLayer } from '../../renderer/conversation-overlays.ts';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';
import { parseSlashCommand } from '../../input/slash-command-parser.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { readOnboardingCheckMarker, readOnboardingCompletionMarker, writeOnboardingCheckMarker } from '../../runtime/onboarding/index.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { ConfigManager } from '../../config/index.ts';
import { THEME_MODE_CONFIG_KEY } from '../../renderer/theme-mode-config.ts';
import { getActiveThemeMode, getActiveThemeName, listThemeChoices, normalizeThemeName, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { isAgentHiddenSettingKey } from '../../config/agent-settings-policy.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** The workspace modal's text (a kit layer), or plain lines' text. */
function linesText(source: SurfaceLayer | readonly Line[]): string {
  const lines = 'lines' in source ? source.lines : source;
  return lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

function feedWorkspaceToken(workspace: AgentWorkspace, token: InputToken): void {
  handleAgentWorkspaceToken(workspace, token, () => undefined, () => undefined);
}

function feedText(workspace: AgentWorkspace, value: string): void {
  feedWorkspaceToken(workspace, { type: 'text', value });
}

function feedKey(workspace: AgentWorkspace, logicalName: string): void {
  feedWorkspaceToken(workspace, { type: 'key', name: logicalName, logicalName, ctrl: false, shift: false, meta: false });
}

function clearEditorField(workspace: AgentWorkspace): void {
  while (workspace.localEditor?.fields[workspace.localEditor.selectedFieldIndex]?.value) {
    feedKey(workspace, 'backspace');
  }
}

function commandContext(calls: string[] = []): CommandContext {
  return {
    executeCommand: async (name: string, args: string[]) => {
      calls.push([name, ...args].join(' '));
      return true;
    },
    print: (text: string) => {
      calls.push(`print:${text}`);
    },
  } as unknown as CommandContext;
}

function persistentConfigContext(): {
  readonly context: CommandContext;
  readonly configManager: ConfigManager;
  readonly shellPaths: ReturnType<typeof createShellPathService>;
} {
  const root = makeProjectTempDir('goodvibes-agent-workspace-config');
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const configManager = new ConfigManager({
    homeDir: homeDirectory,
    workingDir: workingDirectory,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  return {
    shellPaths,
    configManager,
    context: {
      ...commandContext(),
      workspace: { shellPaths },
      platform: { configManager },
    } as unknown as CommandContext,
  };
}

function savedAgentSetting(shellPaths: ReturnType<typeof createShellPathService>, key: string): unknown {
  const raw = readFileSync(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json'), 'utf-8');
  return key.split('.').reduce<unknown>((cursor, part) => (
    cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[part] : undefined
  ), JSON.parse(raw) as Record<string, unknown>);
}

/** Read a key out of the DAEMON's own settings store (the single home of every daemon-owned key). */
function savedDaemonSetting(shellPaths: ReturnType<typeof createShellPathService>, key: string): unknown {
  const raw = readFileSync(shellPaths.resolveUserPath('daemon', 'settings.json'), 'utf-8');
  return key.split('.').reduce<unknown>((cursor, part) => (
    cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[part] : undefined
  ), JSON.parse(raw) as Record<string, unknown>);
}

function routineWorkspaceContext(): CommandContext {
  const root = makeProjectTempDir('goodvibes-agent-workspace-routine-form');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name: 'Daily Brief',
    description: 'Summarize operator state.',
    steps: 'Review current tasks, approvals, and Agent Knowledge status first.',
    enabled: true,
  });
  return {
    ...commandContext(),
    workspace: { shellPaths },
  } as unknown as CommandContext;
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: 'mem-preference',
    scope: 'project',
    cls: 'fact',
    summary: 'Prefers concise operator briefings',
    detail: 'Use short summaries before action.',
    tags: ['preference'],
    provenance: [],
    reviewState: 'fresh',
    confidence: 82,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setupReceiptArtifact(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly metadata: Record<string, unknown>;
}): ArtifactDescriptor {
  return {
    id: input.id,
    kind: 'data',
    mimeType: 'application/json',
    filename: `${input.id}.json`,
    sizeBytes: 256,
    sha256: `sha-${input.id}`,
    createdAt: input.createdAt,
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: input.metadata,
  };
}

function vectorStats() {
  return {
    backend: 'sqlite-vec' as const,
    enabled: false,
    available: false,
    path: '',
    dimensions: 0,
    indexedRecords: 0,
    embeddingProviderId: 'none',
    embeddingProviderLabel: 'None',
  };
}

const ALLOWED_ONBOARDING_READONLY_GUIDANCE = new Set([
  'account-route-readiness',
  'account-local-server-health',
  'account-local-benchmark-evidence',
  'context-vibe-status',
  'context-project-files',
  'context-project-file',
  'context-prompt-context',
  'channel-safety',
  'voice-workflow-posture',
  'device-capability-map',
  // setup-skip-to-chat: guidance row that instructs Escape/close; safe to skip setup.
  'setup-skip-to-chat',
  // account-advanced-separator: read-only separator that labels the advanced routes section.
  'account-advanced-separator',
]);

const ALLOWED_ONBOARDING_READONLY_COMMANDS = new Set<string>([
  // Read-only connected-host admin listings on the Messaging page: the
  // principal identity registry and per-channel session profile bindings.
  // Both dispatch list-only slash commands; mutations go through the same
  // commands' --yes-gated subcommands, never from a workspace row.
  'principals-list',
  'channel-profiles-list',
]);

function memoryApi(records: MemoryRecord[] = [memoryRecord()]): MemoryApi {
  return {
    add: async (input) => {
      const record = memoryRecord({
        id: `mem-${records.length + 1}`,
        scope: input.scope ?? 'project',
        cls: input.cls,
        summary: input.summary,
        detail: input.detail,
        tags: [...(input.tags ?? [])],
        provenance: [...(input.provenance ?? [])],
        reviewState: input.review?.state ?? 'fresh',
        confidence: input.review?.confidence ?? 80,
      });
      records.unshift(record);
      return record;
    },
    search: async () => records,
    searchSemantic: async () => [],
    vectorStats,
    rebuildVectors: vectorStats,
    rebuildVectorsAsync: async () => vectorStats(),
    doctor: async () => ({
      vector: vectorStats(),
      embeddings: {
        activeProviderId: 'none',
        providers: [],
        asyncProviders: [],
        syncProviders: [],
        warnings: [],
      },
      checkedAt: Date.now(),
    }),
    reviewQueue: async () => records.slice(0, 100),
    exportBundle: () => ({
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: 'all',
      recordCount: records.length,
      linkCount: 0,
      records,
      links: [],
    }),
    importBundle: async () => ({ importedRecords: 0, skippedRecords: 0, importedLinks: 0 }),
    get: (id) => records.find((record) => record.id === id) ?? null,
    getAll: () => records,
    link: async () => null,
    linksFor: () => [],
    update: (id, patch) => {
      const index = records.findIndex((record) => record.id === id);
      const current = records[index];
      if (!current) return null;
      const updated: MemoryRecord = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
      records[index] = updated;
      return updated;
    },
    review: (id, patch) => {
      const index = records.findIndex((record) => record.id === id);
      const current = records[index];
      if (!current) return null;
      const updated: MemoryRecord = {
        ...current,
        reviewState: patch.state ?? current.reviewState,
        confidence: patch.confidence ?? current.confidence,
        reviewedBy: patch.reviewedBy ?? current.reviewedBy,
        reviewedAt: Date.now(),
        staleReason: patch.staleReason,
        updatedAt: Date.now(),
      };
      records[index] = updated;
      return updated;
    },
    delete: (id) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    explain: async () => ({ injections: [], prompt: null }),
  };
}

describe('AgentWorkspace', () => {
  test('parses quoted workspace slash commands for schedule promotion', () => {
    const parsed = parseSlashCommand('/schedule promote-routine daily-brief --cron "0 9 * * *" --delivery-channel "slack:ops alerts" --yes');

    expect(parsed.name).toBe('schedule');
    expect(parsed.args).toEqual([
      'promote-routine',
      'daily-brief',
      '--cron',
      '0 9 * * *',
      '--delivery-channel',
      'slack:ops alerts',
      '--yes',
    ]);
  });

  test('all workspace slash command actions resolve through the Agent command registry', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const missingCommands = AGENT_WORKSPACE_CATEGORIES.flatMap((category) => (
      category.actions.flatMap((action) => {
        const command = action.command?.trim();
        if (!command?.startsWith('/')) return [];
        const root = command.slice(1).split(/\s+/)[0];
        return root && !registry.get(root)
          ? [`${category.id}/${action.id}: ${command}`]
          : [];
      })
    ));

    expect(missingCommands).toEqual([]);
  });

  test('workspace category group labels are meaningful shared sections', () => {
    const groups = AGENT_WORKSPACE_CATEGORIES.map((category) => category.group);
    const uniqueGroups = [...new Set(groups)];
    const singletonGroups = uniqueGroups.filter((group) => groups.filter((candidate) => candidate === group).length < 2);
    const repeatedAfterChange = groups.filter((group, index) => (
      index > 0
      && group !== groups[index - 1]
      && groups.slice(0, index).includes(group)
    ));
    const categoryLabels = AGENT_WORKSPACE_CATEGORIES.map((category) => category.label);
    const duplicateCategoryLabels = [...new Set(categoryLabels)]
      .filter((label) => categoryLabels.filter((candidate) => candidate === label).length > 1);

    expect(uniqueGroups).toEqual([
      'START',
      'ONBOARDING',
      'DAY-TO-DAY',
      'CAPABILITIES',
      'LOCAL BEHAVIOR',
      'OPERATIONS',
      'FINISH',
    ]);
    expect(singletonGroups).toEqual(['START', 'FINISH']);
    expect(AGENT_WORKSPACE_CATEGORIES.at(-1)?.group).toBe('FINISH');
    expect(repeatedAfterChange).toEqual([]);
    expect(duplicateCategoryLabels).toEqual([]);
  });

  // DELETED: 'first-class product commands have Agent workspace access'
  // action.command is gone; command coverage is now validated by agent-workspace-command-parity.test.ts.

  test('opens as an operator workspace and keeps guidance actions local', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    expect(workspace.active).toBe(true);
    expect(workspace.selectedCategory.label).toBe('Home');
    expect(workspace.categories.at(-1)?.id).toBe('finish');
    expect(workspace.selectedAction?.label).toBe('Just start typing');

    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.status).toContain('Close this workspace and ask for anything');
  });

  test('finishes onboarding by writing the user marker and closing the workspace', () => {
    const root = makeProjectTempDir('goodvibes-agent-onboarding-finish');
    const shellPaths = createShellPathService({
      workingDirectory: join(root, 'workspace'),
      homeDirectory: join(root, 'home'),
    });
    const workspace = new AgentWorkspace();
    let dismissed = false;
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
      dismissAgentWorkspace: () => {
        dismissed = true;
        workspace.close();
        return true;
      },
    } as unknown as CommandContext;

    workspace.open(ctx, () => undefined, 'finish');
    expect(workspace.selectedCategory.id).toBe('finish');
    expect(workspace.selectedAction?.label).toBe('Apply & close');

    // First activate: writes markers, shows recap, defers dismiss.
    workspace.activateSelected();

    const checkMarker = readOnboardingCheckMarker(shellPaths, 'user');
    const completionMarker = readOnboardingCompletionMarker(shellPaths, 'user');
    expect(checkMarker.exists).toBe(true);
    expect(completionMarker.exists).toBe(true);
    expect(completionMarker.payload?.source).toBe('wizard');
    expect(completionMarker.payload?.mode).toBe('new');
    expect(completionMarker.payload?.workspaceRoot).toBe(shellPaths.workingDirectory);
    expect(workspace.lastActionResult?.kind).toBe('recap');
    expect(workspace.active).toBe(true); // still open showing recap

    // Second activate: confirms recap and dismisses.
    workspace.activateSelected();

    expect(dismissed).toBe(true);
    expect(workspace.active).toBe(false);
  });

  // DELETED: 'dispatches command actions through the shell-owned callback', action 'model' removed.
  // DELETED: 'dispatches operator briefing from the home workspace', action 'brief' removed.
  // DELETED: 'exposes doctor diagnostics from the home workspace', action 'doctor' removed.
  // DELETED: 'exposes connected-host compatibility from the home workspace', action 'compat' removed.
  // DELETED: 'sets interaction mode from home workspace forms', action 'mode-show' removed; mode-preset is now an editor action.

  test('opens shared provider model picker from account onboarding actions', () => {
    const opened: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open({
      ...commandContext(),
      openProviderModelPickerWithTarget: (target: string) => {
        opened.push(`provider:${target}`);
        return true;
      },
      openModelPickerWithTarget: (target: string) => {
        opened.push(`model:${target}`);
        return true;
      },
    } as unknown as CommandContext, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'account-model');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'provider-use');
    workspace.activateSelected();
    expect(workspace.lastActionResult?.title).toBe('Opening Choose provider and model');

    expect(opened).toEqual(['provider:main']);
  });

  test('opens direct Agent workspace categories and reports unknown targets', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command), 'voice-media');

    expect(workspace.active).toBe(true);
    expect(workspace.selectedCategory.id).toBe('onboarding-voice-media');
    expect(workspace.selectedCategory.detail).toContain('Voice, TTS, image input, media generation, and telephony live on this one page.');
    expect(workspace.selectedCategory.detail).not.toContain('Service management');
    expect(workspace.focusPane).toBe('actions');
    expect(workspace.lastActionResult).toBeNull();

    workspace.open(commandContext(), (command) => dispatched.push(command), 'not-real');

    expect(workspace.selectedCategory.id).toBe('onboarding-voice-media');
    expect(workspace.status).toContain('Unknown Agent workspace area: not-real');
    expect(workspace.lastActionResult).toMatchObject({
      kind: 'guidance',
      title: 'Unknown Agent workspace area',
      safety: 'safe',
    });
    expect(workspace.lastActionResult?.detail).toContain('knowledge');
    expect(workspace.lastActionResult?.detail).toContain('work');
    expect(dispatched).toEqual([]);
  });

  // DELETED: 'searches workspace actions from the TUI and dispatches the selected result'
  // action 'doctor' was removed from the home workspace.

  test('search opens cross-category actions without making users know slash commands', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    feedText(workspace, '/');
    feedText(workspace, 'agent knowledge reindex');
    expect(workspace.actionSearchActive).toBe(true);
    expect(workspace.selectedAction?.id).toBe('knowledge-reindex');

    feedKey(workspace, 'enter');

    expect(workspace.actionSearchActive).toBe(false);
    expect(workspace.selectedCategory.id).toBe('knowledge');
    expect(workspace.localEditor?.kind).toBe('knowledge-reindex');
    expect(dispatched).toEqual([]);
  });

  // DELETED: 'search accepts tokenizer space keys for multi-word queries'
  // action 'knowledge-status' was removed from the workspace.

  test('search no-match and escape stay inside the workspace', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    feedText(workspace, '/');
    feedText(workspace, 'not a real operator action');
    expect(workspace.actionSearchActive).toBe(true);
    expect(workspace.actions).toHaveLength(0);

    feedKey(workspace, 'enter');
    expect(workspace.actionSearchActive).toBe(true);
    expect(workspace.lastActionResult?.title).toBe('No action selected');
    expect(dispatched).toEqual([]);

    feedKey(workspace, 'escape');
    expect(workspace.active).toBe(true);
    expect(workspace.actionSearchActive).toBe(false);
    expect(workspace.status).toBe('Action search cleared.');
  });

  test('canceling action search resets the action highlight instead of misreading a stale cross-category index', () => {
    // Repro: begin search from "setup", move the highlight to a result that
    // belongs to a DIFFERENT category ("account-model"), then cancel with
    // Escape. Before the fix, clearAgentWorkspaceActionSearch reinterpreted
    // the leftover search-result index against "setup"'s own (unrelated)
    // action list, silently landing the highlight on setup.actions[4]
    // ("Import GoodVibes settings"), an action the user never looked at.
    // The honest fix resets to the top of the list on cancel.
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    workspace.focusPane = 'actions';
    expect(workspace.selectedCategory.id).toBe('setup');
    expect(workspace.actions[0]?.id).toBe('use-local-model');
    expect(workspace.actions[4]?.id).toBe('import-goodvibes-tui-settings');

    feedText(workspace, '/');
    feedText(workspace, 'model');
    expect(workspace.actionSearchActive).toBe(true);
    workspace.selectedActionIndex = 4;
    expect(workspace.selectedActionSearchResult?.category.id).toBe('account-model');
    expect(workspace.selectedActionSearchResult?.action.id).toBe('account-tts-llm-provider');

    feedKey(workspace, 'escape');

    expect(workspace.actionSearchActive).toBe(false);
    expect(workspace.selectedCategory.id).toBe('setup');
    expect(workspace.selectedActionIndex).toBe(0);
    expect(workspace.selectedAction?.id).toBe('use-local-model');
  });

  test('opens host task inspection from workspace forms without mutating tasks', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'tasks-filter');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('task-list-filter');
    feedText(workspace, 'running');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/tasks list running');
    expect(workspace.lastActionResult?.safety).toBe('read-only');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'task-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('task-show');
    feedText(workspace, 'task-123');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/tasks show task-123');
    expect(workspace.lastActionResult?.safety).toBe('read-only');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'task-output');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('task-output');
    feedText(workspace, 'task-123');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/tasks output task-123');

    expect(dispatched).not.toContain('/tasks cancel task-123');
    expect(dispatched).not.toContain('/tasks retry task-123');
  });

  // DELETED: 'exports conversation and manages saved session continuity from work workspace forms'
  // conversation-review/composer/hotspots/next-event/prev-event/restore/events/groups/find and
  // session-save/load/graph/export/search/delete action IDs were all removed from the workspace.

  test('opens local persona library workspace from memory', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas');

    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.selectedCategory.id).toBe('personas');
    expect(workspace.status).toContain('Opened Personas');
  });

  test('opens local skill library workspace from memory', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills');

    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.selectedCategory.id).toBe('skills');
    expect(workspace.status).toContain('Opened Skills');
  });

  test('opens local routine library workspace from memory', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines');

    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.selectedCategory.id).toBe('routines');
    expect(workspace.status).toContain('Opened Routines');
  });

  // DELETED: 'dispatches channel pairing through the command router'
  // pair action ID was removed from the workspace; onboarding-channels now exposes setting actions only.

  test('messaging onboarding exposes channel settings instead of companion command shortcuts', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');

    expect(workspace.actions.some((action) => action.id === 'onboarding-pair-companion')).toBe(false);
    expect(workspace.actions.some((action) => action.id === 'channel-ntfy-enabled' && action.kind === 'setting')).toBe(true);
    expect(workspace.actions.some((action) => action.id === 'telephony-enabled' && action.kind === 'setting')).toBe(false);
    expect(dispatched).toEqual([]);
  });

  test('home assistant setup lane jumps directly into setup without dispatching a command', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'assistant-setup-lane');

    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.selectedCategory.id).toBe('setup');
    expect(workspace.focusPane).toBe('actions');
    expect(workspace.lastActionResult?.kind).toBe('refreshed');
    expect(workspace.status).toContain('Opened Start');
  });

  test('onboarding pages use concrete setting editor command or completion actions', () => {
    const onboarding = AGENT_WORKSPACE_CATEGORIES.filter((category) => category.group === 'ONBOARDING' || category.id === 'finish');
    const filler = onboarding.flatMap((category) => category.actions
      .filter((action) => (
        action.kind === 'workspace'
        || (
          action.kind === 'guidance'
          && !ALLOWED_ONBOARDING_READONLY_GUIDANCE.has(action.id)
          && (action.safety !== 'read-only' && action.safety !== 'blocked')
        )
      ))
      .map((action) => `${category.id}/${action.id}`));
    expect(filler).toEqual([]);
  });

  test('onboarding setting actions persist live config and saved Agent settings', async () => {
    const { context, configManager, shellPaths } = persistentConfigContext();
    const workspace = new AgentWorkspace();
    workspace.open(context, () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'assistant-behavior');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'behavior-hitl-mode');
    workspace.activateSelected();
    expect(configManager.get('behavior.hitlMode')).toBe('operator');
    expect(savedAgentSetting(shellPaths, 'behavior.hitlMode')).toBe('operator');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-display');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'display-collapse-threshold');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('setting-set');
    clearEditorField(workspace);
    feedText(workspace, '88');
    feedKey(workspace, 'enter');
    expect(configManager.get('display.collapseThreshold')).toBe(88);
    expect(savedAgentSetting(shellPaths, 'display.collapseThreshold')).toBe(88);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'setup-save-history');
    const previousSaveHistory = Boolean(configManager.get('behavior.saveHistory'));
    workspace.activateSelected();
    expect(configManager.get('behavior.saveHistory')).toBe(!previousSaveHistory);
    expect(savedAgentSetting(shellPaths, 'behavior.saveHistory')).toBe(!previousSaveHistory);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-ntfy-enabled');
    // `surfaces.*` is DAEMON-owned, so this write is routed to whichever runtime
    // owns the key rather than applied inline, it needs a tick to settle. The
    // agent-owned settings above are still observable synchronously.
    workspace.activateSelected();
    await Promise.resolve();
    expect(configManager.get('surfaces.ntfy.enabled')).toBe(true);
    // And it does NOT land in the agent's own settings file. That store is not
    // the one the daemon reads, which is why setting a channel here used to
    // report success and configure nothing.
    expect(savedAgentSetting(shellPaths, 'surfaces.ntfy.enabled')).toBeUndefined();
    expect(savedDaemonSetting(shellPaths, 'surfaces.ntfy.enabled')).toBe(true);
    expect(workspace.actions.some((action) => action.id === 'channel-ntfy-base-url')).toBe(true);
  });

  test('workspace Interface page discovers and cycles the shared theme-mode setting', async () => {
    const { context, configManager } = persistentConfigContext();
    const workspace = new AgentWorkspace();
    workspace.open(context, () => undefined);

    try {
      workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-display');
      expect(workspace.selectedCategory.label).toBe('Interface');
      const action = workspace.actions.find((entry) => entry.id === 'display-theme-mode');
      expect(action).toBeDefined();
      expect(action!.kind).toBe('setting');
      expect(action!.settingKey).toBe(THEME_MODE_CONFIG_KEY);

      workspace.selectedActionIndex = workspace.actions.findIndex((entry) => entry.id === 'display-theme-mode');

      workspace.activateSelected(); // auto -> dark, applied now through the shared apply hook
      await Promise.resolve();
      await Promise.resolve();
      expect(configManager.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('dark');
      expect(getActiveThemeMode()).toBe('dark');
      expect(workspace.status).toContain('applied now');

      workspace.activateSelected(); // dark -> light
      await Promise.resolve();
      await Promise.resolve();
      expect(configManager.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('light');
      expect(getActiveThemeMode()).toBe('light');
      expect(workspace.status).toContain('applied now');

      workspace.activateSelected(); // light -> auto (wraps); only takes effect at next launch
      await Promise.resolve();
      await Promise.resolve();
      expect(configManager.get(THEME_MODE_CONFIG_KEY as ConfigKey)).toBe('auto');
      expect(getActiveThemeMode()).toBe('light'); // unchanged now, auto only re-probes at startup
      expect(workspace.status).toContain('next startup');
    } finally {
      setActiveThemeMode('dark'); // restore the shared test-process default
    }
  });

  test('workspace Interface page cycles the theme through the selectable themes and applies it now', async () => {
    const { context, configManager } = persistentConfigContext();
    const workspace = new AgentWorkspace();
    workspace.open(context, () => undefined);

    try {
      workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-display');
      workspace.selectedActionIndex = workspace.actions.findIndex((entry) => entry.id === 'display-theme');
      expect(workspace.actions[workspace.selectedActionIndex]?.settingKey).toBe('display.theme');

      const names = listThemeChoices().map((choice) => choice.name);
      expect(names).not.toContain('vaporwave');
      const start = names.indexOf(normalizeThemeName(configManager.get('display.theme')));
      const visited: string[] = [];
      for (let step = 0; step < names.length; step++) {
        workspace.activateSelected();
        // The write goes through setHarnessSetting (async): let it settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const stored = String(configManager.get('display.theme' as ConfigKey));
        visited.push(stored);
        expect(getActiveThemeName()).toBe(stored);
        expect(workspace.status).toContain('applied now');
      }
      // One full lap from the default: every selectable theme once, never the legacy alias.
      expect(visited).toEqual([...names.slice(start + 1), ...names.slice(0, start + 1)]);
    } finally {
      setActiveThemeName('goodvibes');
    }
  });

  test('import GoodVibes settings imports provider subscriptions into Agent state', async () => {
    const { context, shellPaths, configManager } = persistentConfigContext();
    const subscriptionManager = new SubscriptionManager(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'subscriptions.json'));
    subscriptionManager.saveSubscription({
      provider: 'agent-only',
      accessToken: 'agent-token',
      tokenType: 'Bearer',
      authMode: 'oauth',
      overrideAmbientApiKeys: false,
      createdAt: 1,
      updatedAt: 1,
    });
    mkdirSync(shellPaths.resolveUserPath('tui'), { recursive: true });
    writeFileSync(shellPaths.resolveUserPath('tui', 'subscriptions.json'), JSON.stringify({
      version: 1,
      subscriptions: {
        openai: {
          provider: 'openai',
          accessToken: 'tui-openai-token',
          refreshToken: 'tui-refresh-token',
          tokenType: 'Bearer',
          expiresAt: 4_102_444_800_000,
          scopes: ['openid', 'profile'],
          authMode: 'oauth',
          overrideAmbientApiKeys: true,
          createdAt: 2,
          updatedAt: 3,
        },
      },
      pending: {
        anthropic: {
          provider: 'anthropic',
          state: 'pending-state',
          verifier: 'pending-verifier',
          redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
          createdAt: 4,
        },
      },
    }, null, 2));
    const workspace = new AgentWorkspace();
    workspace.open({
      ...context,
      platform: { configManager, subscriptionManager },
    } as unknown as CommandContext, () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'import-goodvibes-tui-settings');
    workspace.activateSelected();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(subscriptionManager.get('agent-only')?.accessToken).toBe('agent-token');
    expect(subscriptionManager.get('openai')).toEqual(expect.objectContaining({
      provider: 'openai',
      accessToken: 'tui-openai-token',
      refreshToken: 'tui-refresh-token',
      overrideAmbientApiKeys: true,
    }));
    expect(subscriptionManager.getPending('anthropic')).toEqual(expect.objectContaining({
      provider: 'anthropic',
      verifier: 'pending-verifier',
    }));
    expect(workspace.lastActionResult?.title).toBe('GoodVibes settings imported');
    expect(workspace.lastActionResult?.detail).toContain('Imported active subscription(s): openai.');
    expect(workspace.lastActionResult?.detail).toContain('Imported pending subscription(s): anthropic.');
  });

  test('Start workspace persists and clears setup wizard checkpoints', () => {
    const { context, shellPaths } = persistentConfigContext();
    const workspace = new AgentWorkspace();
    workspace.open(context, () => undefined, 'setup');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'setup-checkpoint-mark-current');
    workspace.activateSelected();

    const saved = readSetupWizardCheckpoint(shellPaths);
    expect(saved.exists).toBe(true);
    expect(saved.checkpoint?.currentStepId).toBe(workspace.runtimeSnapshot!.setupWizard.currentStepId as string | undefined);
    expect(saved.checkpoint?.source).toBe('workspace');
    expect(workspace.lastActionResult?.title).toBe('Setup checkpoint saved');
    expect(workspace.runtimeSnapshot!.setupWizard._diagnostic.checkpoint!.status).toBe('available');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'setup-checkpoint-show');
    workspace.activateSelected();
    expect(workspace.lastActionResult?.title).toBe('Setup checkpoint');
    expect(workspace.lastActionResult?.detail).toContain(saved.checkpoint?.currentStepLabel ?? '');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'setup-checkpoint-clear');
    workspace.activateSelected();
    const cleared = readSetupWizardCheckpoint(shellPaths);
    expect(cleared.exists).toBe(false);
    expect(cleared.checkpoint).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Setup checkpoint cleared');
    expect(workspace.runtimeSnapshot?.setupWizard._diagnostic.checkpoint.status).toBe('none');
  });

  test('onboarding has no verify page and routes schema-backed Agent settings', () => {
    expect(AGENT_WORKSPACE_CATEGORIES.some((category) => (category.id as string) === 'onboarding-verify')).toBe(false);

    const covered = new Set<string>([
      'provider.model',
      'helper.globalProvider',
      'helper.globalModel',
      'tools.llmProvider',
      'tools.llmModel',
      'tts.llmProvider',
      'tts.llmModel',
    ]);
    for (const category of AGENT_WORKSPACE_CATEGORIES) {
      if (category.group !== 'ONBOARDING') continue;
      for (const action of category.actions) {
        if (action.settingKey) covered.add(action.settingKey);
        if (action.kind === 'command') {
          expect(action.safety).toBe('read-only');
          expect(ALLOWED_ONBOARDING_READONLY_COMMANDS.has(action.id)).toBe(true);
        }
        if (action.kind === 'guidance') {
          // Safe guidance rows must be explicitly allowlisted (e.g. skip-to-chat instructions).
          // Read-only and blocked guidance rows are accepted broadly.
          if (action.safety === 'safe') {
            expect(
              ALLOWED_ONBOARDING_READONLY_GUIDANCE.has(action.id),
              `Guidance row ${action.id} with safety 'safe' must be in ALLOWED_ONBOARDING_READONLY_GUIDANCE`,
            ).toBe(true);
          } else {
            expect(['read-only', 'blocked']).toContain(action.safety);
            if (action.safety === 'read-only') {
              expect(ALLOWED_ONBOARDING_READONLY_GUIDANCE.has(action.id)).toBe(true);
            }
          }
        }
      }
    }

    // A key is reachable when its root names a category, or when the root has
    // no category of its own and is cross-listed under one that does.
    const settingsCategoryRoots = new Set<string>([
      ...SETTINGS_CATEGORIES,
      ...Object.keys(CROSS_LISTED_SETTING_ROOTS),
    ]);
    const missing = CONFIG_SCHEMA
      .map((setting) => setting.key)
      .filter((key) => !isAgentHiddenSettingKey(key) && !covered.has(key) && !settingsCategoryRoots.has(key.split('.')[0] ?? ''));
    expect(missing).toEqual([]);
  });

  test('home safety lane opens Tools and onboarding tools opens concrete MCP setup', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');
    expect(workspace.selectedCategory.id).toBe('tools');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools-permissions');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'onboarding-mcp-server');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('mcp-server');
    expect(dispatched).toEqual([]);
  });

  // DELETED: 'opens the fullscreen MCP workspace', mcp-workspace action removed.
  // DELETED: 'tools workspace exposes trust and security review', trust-review, security-review,
  // security-attack-paths, security-tokens action IDs were all removed from the workspace.

  test('renders local persona skill and routine library workspaces from live Agent state', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-local-libraries');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const persona = AgentPersonaRegistry.fromShellPaths(shellPaths).create({
      name: 'Household Operator',
      description: 'Coordinates home, schedule, and device requests.',
      body: 'Prefer concise proactive execution with explicit approval for external sends.',
      tags: ['home'],
    });
    AgentPersonaRegistry.fromShellPaths(shellPaths).setActive(persona.id);
    AgentSkillRegistry.fromShellPaths(shellPaths).create({
      name: 'Trip Prep',
      description: 'Prepare reusable travel checklists and reminders.',
      procedure: 'Gather dates, destination, reservations, packing, and reminders.',
      tags: ['travel'],
      enabled: true,
    });
    AgentRoutineRegistry.fromShellPaths(shellPaths).create({
      name: 'Morning Brief',
      description: 'Review calendar, weather, work plan, and pending approvals.',
      steps: 'Check calendar, weather, work plan, approvals, and reminders.',
      triggers: ['weekday'],
      enabled: true,
    });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(ctx);

    expect(snapshot.localPersonas[0]?.name).toBe('Household Operator');
    expect(snapshot.localPersonas[0]?.active).toBe(true);
    expect(snapshot.localSkills[0]?.enabled).toBe(true);
    expect(snapshot.localRoutines[0]?.name).toBe('Morning Brief');

    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    expect(linesText(renderAgentWorkspace(workspace, 140, 44))).toContain('Household Operator');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    expect(linesText(renderAgentWorkspace(workspace, 140, 44))).toContain('Trip Prep');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    expect(linesText(renderAgentWorkspace(workspace, 140, 44))).toContain('Morning Brief');
  });

  test('renders Agent-owned memory in the workspace without default knowledge fallback', () => {
    let reviewReads = 0;
    const ctx = {
      ...commandContext(),
      clients: {
        agentKnowledgeApi: {
          memory: { ...memoryApi([
            memoryRecord({
              id: 'mem-source-policy',
              cls: 'constraint',
              scope: 'project',
              summary: 'Never fallback to non-Agent knowledge segments',
              detail: 'Agent Knowledge and local memory are separate Agent-owned surfaces.',
              reviewState: 'reviewed',
              confidence: 100,
            }),
          ]), reviewQueue: async () => { reviewReads += 1; return []; } },
        },
      },
    } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');

    const output = linesText(renderAgentWorkspace(workspace, 150, 42));

    expect(workspace.runtimeSnapshot?.localMemoryCount).toBe(1);
    expect(workspace.runtimeSnapshot?.localMemoryPromptActiveCount).toBe(1);
    // Canonical review ranks all candidates, including reviewed records. Paint
    // uses the capped cardinality and never starts that async semantic ranking.
    expect(workspace.runtimeSnapshot?.localMemoryReviewQueueCount).toBe(1);
    expect(reviewReads).toBe(0);
    expect(output).toContain('Memory: 1; prompt 1; queue 1; session 0.');
    expect(output).toContain('Never fallback to non-Agent knowledge segments');
    expect(output).toContain('project/constraint');
    expect(output).not.toContain('default knowledge');
  });

  test('memory items carry describeMemoryPromptEligibility\'s own reason: no locally invented "not reviewed"/"outside prompt limit" paraphrase', () => {
    const eligible = memoryRecord({
      id: 'mem-eligible',
      reviewState: 'fresh',
      confidence: 60,
      summary: 'Eligible at the store-default confidence floor.',
    });
    const ineligible = memoryRecord({
      id: 'mem-ineligible',
      reviewState: 'reviewed',
      confidence: 40,
      summary: 'Explicitly below the recall floor.',
    });
    const ctx = {
      ...commandContext(),
      clients: {
        agentKnowledgeApi: { memory: memoryApi([eligible, ineligible]) },
      },
    } as unknown as CommandContext;

    const counters = readLiveAgentMemoryCounters(ctx);
    const eligibleItem = counters.items.find((item) => item.id === 'mem-eligible');
    const ineligibleItem = counters.items.find((item) => item.id === 'mem-ineligible');

    expect(eligibleItem?.promptEligible).toBe(true);
    expect(eligibleItem?.promptEligibilityReason).toBe(describeMemoryPromptEligibility(eligible).reason);
    expect(ineligibleItem?.promptEligible).toBe(false);
    expect(ineligibleItem?.promptEligibilityReason).toBe(describeMemoryPromptEligibility(ineligible).reason);
    // Neither the old coarse wording nor a locally re-derived guess, the exact honest
    // reason string, same wording source as prompt-context-receipts.ts.
    expect(ineligibleItem?.promptEligibilityReason).toContain('confidence');
    expect(ineligibleItem?.promptEligibilityReason).not.toBe('not reviewed');
    expect(ineligibleItem?.promptEligibilityReason).not.toBe('outside prompt limit');
  });

  test('temporal validity (validFrom/validUntil) is visible, not silent: expired/pending records stay stored but stop counting as prompt-active', () => {
    const now = Date.now();
    const active = memoryRecord({ id: 'mem-active', reviewState: 'reviewed', confidence: 90 });
    const pending = memoryRecord({ id: 'mem-pending', reviewState: 'reviewed', confidence: 90, validFrom: now + 60_000 });
    const expired = memoryRecord({ id: 'mem-expired', reviewState: 'reviewed', confidence: 90, validUntil: now - 60_000 });
    const ctx = {
      ...commandContext(),
      clients: {
        agentKnowledgeApi: { memory: memoryApi([active, pending, expired]) },
      },
    } as unknown as CommandContext;

    const counters = readLiveAgentMemoryCounters(ctx);

    // Still stored (counted in `count`), just not prompt-injected.
    expect(counters.count).toBe(3);
    expect(counters.temporallyPendingCount).toBe(1);
    expect(counters.temporallyExpiredCount).toBe(1);
    expect(counters.promptActiveCount).toBe(1);

    expect(counters.items.find((item) => item.id === 'mem-active')?.temporalStatus).toBe('active');
    expect(counters.items.find((item) => item.id === 'mem-pending')?.temporalStatus).toBe('pending');
    expect(counters.items.find((item) => item.id === 'mem-expired')?.temporalStatus).toBe('expired');

    // The catalog/status surfaces pass the same counts through, not a re-derived guess.
    const snapshot = buildAgentWorkspaceRuntimeSnapshot(ctx);
    expect(snapshot.localMemoryTemporallyPendingCount).toBe(1);
    expect(snapshot.localMemoryTemporallyExpiredCount).toBe(1);
  });

  test('library workspace actions open editors and dispatch only concrete commands', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    // personas-list was removed; first dispatch is now personas-search
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-search');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('persona-search');
    feedText(workspace, 'research');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/personas search research');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('persona-show');
    feedText(workspace, 'research-analyst');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/personas show research-analyst');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-create');
    workspace.activateSelected();
    expect(dispatched).toEqual(['/personas search research', '/personas show research-analyst']);
    expect(workspace.localEditor?.kind).toBe('skill');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-search');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-search');
    feedText(workspace, 'briefing');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/skills search briefing');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-show');
    feedText(workspace, 'briefing');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/skills show briefing');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-search');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('routine-search');
    feedText(workspace, 'daily');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/routines search daily');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('routine-show');
    feedText(workspace, 'daily-brief');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/routines show daily-brief');

    // routines-receipts was removed; next is routines-receipt
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-receipt');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('routine-receipt');
    feedText(workspace, 'receipt-123');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/routines receipt receipt-123');
  });

  test('workspace editors preserve multiline paste only on multiline fields', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-create');
    workspace.activateSelected();
    feedText(workspace, 'Briefing\nAssistant');
    expect(workspace.localEditor?.fields[0]?.value).toBe('Briefing Assistant');

    feedKey(workspace, 'enter');
    feedText(workspace, 'One line\r\nTwo line');
    expect(workspace.localEditor?.fields[1]?.value).toBe('One line Two line');

    feedKey(workspace, 'enter');
    feedText(workspace, 'Step one\r\nStep two');
    feedWorkspaceToken(workspace, { type: 'key', name: 'j', logicalName: 'j', ctrl: true, shift: false, meta: false });
    feedText(workspace, 'Step three');
    expect(workspace.localEditor?.fields[2]?.value).toBe('Step one\nStep two\nStep three');
  });

  test('creates local skill routine and persona records from workspace editors', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-editor');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(ctx, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-create');
    workspace.activateSelected();
    feedText(workspace, 'Briefing');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Summarize state before action.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Check connected-host status, work plan, approvals, and Agent Knowledge first.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'briefing,setup');
    feedKey(workspace, 'enter');
    feedText(workspace, 'ops');
    feedKey(workspace, 'enter');
    feedText(workspace, 'GOODVIBES_AGENT_TEST_MISSING_TOKEN');
    feedKey(workspace, 'enter');
    feedText(workspace, 'definitely-missing-goodvibes-agent-test-bin');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const skillSnapshot = AgentSkillRegistry.fromShellPaths(shellPaths).snapshot();
    expect(skillSnapshot.enabledSkills[0]?.name).toBe('Briefing');
    expect(skillSnapshot.enabledSkills[0]?.requirements.map((requirement) => `${requirement.kind}:${requirement.name}`)).toEqual([
      'env:GOODVIBES_AGENT_TEST_MISSING_TOKEN',
      'command:definitely-missing-goodvibes-agent-test-bin',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Created skill');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-create');
    workspace.activateSelected();
    feedText(workspace, 'Daily Brief');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Review the operator state.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Check calendar, tasks, approvals, and channels.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'weekday');
    feedKey(workspace, 'enter');
    feedText(workspace, 'home');
    feedKey(workspace, 'enter');
    feedText(workspace, 'GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN');
    feedKey(workspace, 'enter');
    feedText(workspace, 'definitely-missing-goodvibes-agent-routine-bin');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const routineSnapshot = AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot();
    expect(routineSnapshot.enabledRoutines[0]?.name).toBe('Daily Brief');
    expect(routineSnapshot.enabledRoutines[0]?.requirements.map((requirement) => `${requirement.kind}:${requirement.name}`)).toEqual([
      'env:GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN',
      'command:definitely-missing-goodvibes-agent-routine-bin',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Created routine');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-create');
    workspace.activateSelected();
    feedText(workspace, 'Research Analyst');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Source-backed answers.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Prefer checked sources and clear unknowns.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'research');
    feedKey(workspace, 'enter');
    feedText(workspace, 'research');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const personaSnapshot = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
    expect(personaSnapshot.activePersona?.name).toBe('Research Analyst');
    expect(workspace.lastActionResult?.title).toBe('Created persona');
    expect(dispatched).toEqual([]);
  });

  test('captures learned behavior as local skill routine or persona without dispatching commands', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-learned-behavior');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(ctx, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'learned-behavior');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('learned-behavior');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Meeting Followup');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Follow up after meetings.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Capture decisions, owners, due dates, and unanswered questions.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'meeting,followup');
    feedKey(workspace, 'enter');
    feedText(workspace, 'learned,ops');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const skill = AgentSkillRegistry.fromShellPaths(shellPaths).get('meeting-followup');
    expect(skill?.enabled).toBe(true);
    expect(skill?.source).toBe('agent');
    expect(skill?.provenance).toBe('agent-workspace-learned-behavior');
    expect(skill?.procedure).toContain('Capture decisions');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'learned-behavior');
    workspace.activateSelected();
    clearEditorField(workspace);
    feedText(workspace, 'routine');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Weekly Reset');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Review open loops weekly.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Review tasks, stale memory, approvals, and local routines.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'weekly,reset');
    feedKey(workspace, 'enter');
    feedText(workspace, 'learned,review');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).get('weekly-reset');
    expect(routine?.enabled).toBe(true);
    expect(routine?.source).toBe('agent');
    expect(routine?.provenance).toBe('agent-workspace-learned-behavior');
    expect(routine?.steps).toContain('stale memory');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'learned-behavior');
    workspace.activateSelected();
    clearEditorField(workspace);
    feedText(workspace, 'persona');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Concise Operator');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Prefer short action-first replies.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Answer with status first, then actions.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'status,concise');
    feedKey(workspace, 'enter');
    feedText(workspace, 'learned,style');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const personaSnapshot = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
    expect(personaSnapshot.activePersona?.name).toBe('Concise Operator');
    expect(personaSnapshot.activePersona?.source).toBe('agent');
    expect(personaSnapshot.activePersona?.provenance).toBe('agent-workspace-learned-behavior');
    expect(personaSnapshot.activePersona?.body).toContain('status first');
    expect(dispatched).toEqual([]);
  });

  test('rejects learned behavior target outside local behavior registries', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-learned-reject');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'learned-behavior');

    workspace.activateSelected();
    clearEditorField(workspace);
    feedText(workspace, 'habit');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Bad Target');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Should not save.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Do not create records for unsupported targets.');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    expect(workspace.localEditor?.kind).toBe('learned-behavior');
    expect(workspace.localEditor?.message).toBe('Behavior type must be skill, routine, or persona.');
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).snapshot().skills).toHaveLength(0);
    expect(AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot().routines).toHaveLength(0);
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().personas).toHaveLength(0);
  });

  test('creates skill bundles from an in-workspace form with concrete skill ids', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-create-bundle');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle');
    feedText(workspace, 'Daily Ops');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Daily operations bundle');
    feedKey(workspace, 'enter');
    feedText(workspace, 'briefing,calendar-review');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/skills bundle create --name "Daily Ops" --description "Daily operations bundle" --skills briefing,calendar-review --enabled',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening skill bundle creation');
  });

  test('manages skill bundles from in-workspace lifecycle forms', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-search-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-search');
    feedText(workspace, 'daily');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-show-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-show');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-update-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-update');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Daily Ops');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Updated operations bundle');
    feedKey(workspace, 'enter');
    feedText(workspace, 'briefing,calendar-review');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/skills bundle search daily',
      '/skills bundle show bundle-daily',
    ]);
    expect(workspace.localEditor?.message).toContain('not confirmed');
    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-enable-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-enable');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-disable-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-disable');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-review-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-review');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-stale-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-stale');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Needs provider setup review');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-delete-bundle');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('skill-bundle-delete');
    feedText(workspace, 'bundle-daily');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/skills bundle search daily',
      '/skills bundle show bundle-daily',
      '/skills bundle update bundle-daily --name "Daily Ops" --description "Updated operations bundle" --skills briefing,calendar-review',
      '/skills bundle enable bundle-daily',
      '/skills bundle disable bundle-daily',
      '/skills bundle review bundle-daily',
      '/skills bundle stale bundle-daily "Needs provider setup review"',
      '/skills bundle delete bundle-daily --yes',
    ]);
  });

  test('exposes Agent support bundle export inspect and import from the host workspace', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-support-bundle-export');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('support-bundle-export');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual(['/bundle export goodvibes-agent-bundle.json --yes']);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent support bundle export');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-support-bundle-inspect');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('support-bundle-inspect');
    clearEditorField(workspace);
    feedText(workspace, 'support/review.json');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/bundle export goodvibes-agent-bundle.json --yes',
      '/bundle inspect support/review.json',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent support bundle inspection');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-support-bundle-import');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('support-bundle-import');
    clearEditorField(workspace);
    feedText(workspace, 'support/review.json');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/bundle export goodvibes-agent-bundle.json --yes',
      '/bundle inspect support/review.json',
    ]);
    expect(workspace.localEditor?.message).toContain('not confirmed');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/bundle export goodvibes-agent-bundle.json --yes',
      '/bundle inspect support/review.json',
      '/bundle import support/review.json --yes',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent support bundle import');
  });

  test('adds removes and inspects providers from workspace forms with confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-provider-detail');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('provider-inspect');
    feedText(workspace, 'openai-subscriber');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-provider-routes');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('provider-routes');
    feedText(workspace, 'openai-subscriber');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-provider-repair');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('provider-account-repair');
    feedText(workspace, 'openai-subscriber');
    feedKey(workspace, 'enter');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'provider-add');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('provider-add');
    feedText(workspace, 'local_llm');
    feedKey(workspace, 'enter');
    feedText(workspace, 'http://127.0.0.1:8000/v1');
    feedKey(workspace, 'enter');
    feedText(workspace, 'sk-local-provider-token');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/accounts show openai-subscriber',
      '/accounts routes openai-subscriber',
      '/accounts repair openai-subscriber',
    ]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/accounts show openai-subscriber',
      '/accounts routes openai-subscriber',
      '/accounts repair openai-subscriber',
      '/provider add local_llm http://127.0.0.1:8000/v1 sk-local-provider-token --yes',
    ]);
    expect(workspace.lastActionResult?.command).toBe('/provider add local_llm http://127.0.0.1:8000/v1 <redacted-api-key> --yes');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'account-model');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'provider-remove');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('provider-remove');
    feedText(workspace, 'local_llm');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/accounts show openai-subscriber',
      '/accounts routes openai-subscriber',
      '/accounts repair openai-subscriber',
      '/provider add local_llm http://127.0.0.1:8000/v1 sk-local-provider-token --yes',
      '/provider remove local_llm --yes',
    ]);
  });

  test('starts finishes and logs out provider subscriptions from workspace services', async () => {
    const dispatched: string[] = [];
    const serviceOauth = {
      authUrl: 'https://auth.example.test/oauth',
      tokenUrl: 'https://auth.example.test/token',
      clientId: 'test-client',
      redirectUri: 'http://localhost:1455/auth/callback',
      manualRedirectUri: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: ['profile'],
      usePkce: true,
      overrideAmbientApiKeys: true,
    };
    const calls: string[] = [];
    const pending = new Map<string, { provider: string; state: string; verifier: string; redirectUri: string; createdAt: number }>();
    const subscriptions = new Map<string, {
      provider: string;
      accessToken: string;
      tokenType: string;
      authMode: 'oauth';
      overrideAmbientApiKeys: boolean;
      createdAt: number;
      updatedAt: number;
    }>();
    const subscriptionManager = {
      list: () => [...subscriptions.values()],
      listPending: () => [...pending.values()],
      get: (provider: string) => subscriptions.get(provider) ?? null,
      getPending: (provider: string) => pending.get(provider) ?? null,
      beginOAuthLogin: async (provider: string, config: typeof serviceOauth) => {
        calls.push(`begin:${provider}:${config.redirectUri}`);
        const record = { provider, state: 'state-1', verifier: 'verifier-1', redirectUri: config.redirectUri, createdAt: Date.now() };
        pending.set(provider, record);
        return { authorizationUrl: `https://auth.example.test/start?provider=${provider}`, pending: record };
      },
      completeOAuthLogin: async (provider: string, config: typeof serviceOauth, code: string) => {
        calls.push(`finish:${provider}:${code}:${config.redirectUri}`);
        const now = Date.now();
        const record = {
          provider,
          accessToken: `token-${code}`,
          tokenType: 'Bearer',
          authMode: 'oauth' as const,
          overrideAmbientApiKeys: config.overrideAmbientApiKeys ?? true,
          createdAt: subscriptions.get(provider)?.createdAt ?? now,
          updatedAt: now,
        };
        subscriptions.set(provider, record);
        pending.delete(provider);
        return record;
      },
      logout: (provider: string) => {
        calls.push(`logout:${provider}`);
        const existed = subscriptions.delete(provider) || pending.delete(provider);
        return existed;
      },
    };
    const serviceRegistry = {
      get: (provider: string) => provider === 'test-oauth'
        ? {
          name: 'test-oauth',
          authType: 'oauth',
          tokenKey: 'TEST_OAUTH_TOKEN',
          providerId: 'test-oauth',
          oauth: serviceOauth,
        }
        : null,
      getAll: () => ({
        'test-oauth': {
          name: 'test-oauth',
          authType: 'oauth',
          tokenKey: 'TEST_OAUTH_TOKEN',
          providerId: 'test-oauth',
          oauth: serviceOauth,
        },
      }),
    };
    const workspace = new AgentWorkspace();
    workspace.open({
      ...commandContext(),
      platform: { subscriptionManager, serviceRegistry },
    } as unknown as CommandContext, (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'subscription-login-start');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-login-start');
    clearEditorField(workspace);
    feedText(workspace, 'test-oauth');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(workspace.localEditor?.message).toContain('not confirmed');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toEqual([]);
    expect(calls).toEqual(['begin:test-oauth:urn:ietf:wg:oauth:2.0:oob']);
    expect(workspace.lastActionResult?.title).toBe('Subscription login started');
    expect(pending.has('test-oauth')).toBe(true);

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'subscription-login-finish');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-login-finish');
    clearEditorField(workspace);
    feedText(workspace, 'test-oauth');
    feedKey(workspace, 'enter');
    feedText(workspace, 'http://localhost/callback?code=abc-code');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(workspace.localEditor?.message).toContain('not confirmed');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toEqual([]);
    expect(calls).toEqual([
      'begin:test-oauth:urn:ietf:wg:oauth:2.0:oob',
      'finish:test-oauth:abc-code:urn:ietf:wg:oauth:2.0:oob',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Subscription session saved');
    expect(subscriptions.get('test-oauth')?.accessToken).toBe('token-abc-code');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'subscription-logout');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-logout');
    clearEditorField(workspace);
    feedText(workspace, 'test-oauth');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(workspace.localEditor?.message).toContain('not confirmed');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(calls).toEqual([
      'begin:test-oauth:urn:ietf:wg:oauth:2.0:oob',
      'finish:test-oauth:abc-code:urn:ietf:wg:oauth:2.0:oob',
      'logout:test-oauth',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Subscription session removed');
    expect(subscriptions.has('test-oauth')).toBe(false);
  });

  test('exposes auth trust subscription and voice bundles from workspace forms', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-auth-detail');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('auth-show');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-auth-repair');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('auth-repair');
    clearEditorField(workspace);
    feedText(workspace, 'anthropic');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-auth-bundle-export');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('auth-bundle-export');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual(['/auth show openai', '/auth repair anthropic']);
    expect(workspace.localEditor?.message).toContain('not confirmed');
    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-auth-bundle-inspect');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('auth-bundle-inspect');
    clearEditorField(workspace);
    feedText(workspace, 'auth/custom.json');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-subscription-bundle-export');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-bundle-export');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-subscription-bundle-inspect');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-bundle-inspect');
    feedKey(workspace, 'enter');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'trust-bundle-export');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('trust-bundle-export');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'trust-bundle-inspect');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('trust-bundle-inspect');
    feedKey(workspace, 'enter');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-voice-media');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'voice-enable');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('voice-enable');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'voice-disable');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('voice-disable');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'voice-bundle-export');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('voice-bundle-export');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'voice-bundle-inspect');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('voice-bundle-inspect');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/auth show openai',
      '/auth repair anthropic',
      '/auth bundle export auth-review-bundle.json --yes',
      '/auth bundle inspect auth/custom.json',
      '/subscription bundle export subscription-bundle.json --yes',
      '/subscription bundle inspect subscription-bundle.json',
      '/trust bundle export trust-review-bundle.json --yes',
      '/trust bundle inspect trust-review-bundle.json',
      '/voice enable --yes',
      '/voice disable --yes',
      '/voice bundle export voice-bundle.json --yes',
      '/voice bundle inspect voice-bundle.json',
    ]);
  });

  test('adds MCP servers from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mcp-add-server');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('mcp-server');
    feedText(workspace, 'filesystem');
    feedKey(workspace, 'enter');
    feedText(workspace, 'bunx');
    feedKey(workspace, 'enter');
    feedText(workspace, '-y @modelcontextprotocol/server-filesystem .');
    feedKey(workspace, 'enter');
    feedText(workspace, 'project');
    feedKey(workspace, 'enter');
    feedText(workspace, 'filesystem');
    feedKey(workspace, 'enter');
    feedText(workspace, 'constrained');
    feedKey(workspace, 'enter');
    feedText(workspace, 'FS_TOKEN=goodvibes://secrets/mcp/FS_TOKEN');
    feedKey(workspace, 'enter');
    feedText(workspace, '/home/buzzkill/Projects');
    feedKey(workspace, 'enter');
    feedText(workspace, 'docs.example.test');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/mcp add filesystem bunx -y @modelcontextprotocol/server-filesystem . --scope project --role filesystem --trust constrained --env FS_TOKEN=goodvibes://secrets/mcp/FS_TOKEN --path /home/buzzkill/Projects --host docs.example.test --yes',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening MCP server add/update');
  });

  test('opens MCP server-specific tools and repair guidance from workspace forms', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mcp-tools-server');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('mcp-tools-server');
    feedText(workspace, 'filesystem');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mcp-repair');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('mcp-repair');
    feedText(workspace, 'browser-tools');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/mcp tools filesystem', '/mcp repair browser-tools']);
    expect(workspace.lastActionResult?.safety).toBe('read-only');
  });

  test('stores links tests and deletes secrets from confirmed workspace forms without rendering raw values', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'secret-set');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('secret-set');
    feedText(workspace, 'OPENAI_API_KEY');
    feedKey(workspace, 'enter');
    feedText(workspace, 'sk-test-secret-value');
    feedKey(workspace, 'enter');
    feedText(workspace, 'project');
    feedKey(workspace, 'enter');
    feedText(workspace, 'secure');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual(['/secrets set OPENAI_API_KEY sk-test-secret-value --project --secure --yes']);
    expect(workspace.lastActionResult?.command).toBe('/secrets set OPENAI_API_KEY <redacted> --project --secure --yes');
    expect(workspace.lastActionResult?.command).not.toContain('sk-test-secret-value');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'secret-link');
    workspace.activateSelected();
    feedText(workspace, 'SLACK_BOT_TOKEN');
    feedKey(workspace, 'enter');
    feedText(workspace, 'goodvibes://secrets/env/SLACK_BOT_TOKEN');
    feedKey(workspace, 'enter');
    feedText(workspace, 'user');
    feedKey(workspace, 'enter');
    feedText(workspace, 'secure');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/secrets link SLACK_BOT_TOKEN goodvibes://secrets/env/SLACK_BOT_TOKEN --user --secure --yes');
    expect(workspace.lastActionResult?.command).toBe('/secrets link SLACK_BOT_TOKEN <secret-ref> --user --secure --yes');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'secret-test');
    workspace.activateSelected();
    feedText(workspace, 'goodvibes://secrets/env/SLACK_BOT_TOKEN');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/secrets test goodvibes://secrets/env/SLACK_BOT_TOKEN');
    expect(workspace.lastActionResult?.command).toBe('/secrets test <secret-ref>');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'secret-delete');
    workspace.activateSelected();
    feedText(workspace, 'OPENAI_API_KEY');
    feedKey(workspace, 'enter');
    feedText(workspace, 'project');
    feedKey(workspace, 'enter');
    feedText(workspace, 'secure');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/secrets delete OPENAI_API_KEY --project --secure --yes');
    expect(workspace.lastActionResult?.title).toBe('Opening secret deletion');
  });

  test('adds notification webhook targets from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'notification-add-webhook');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('notify-webhook');
    feedText(workspace, 'https://ntfy.sh/goodvibes-agent-alerts');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/notify add https://ntfy.sh/goodvibes-agent-alerts --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening notification webhook add');
  });

  test('opens channel diagnostics from workspace forms without sending messages', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('channel-show');
    feedText(workspace, 'telegram');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/channels show telegram');
    expect(workspace.lastActionResult?.safety).toBe('read-only');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-doctor');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('channel-doctor');
    feedText(workspace, 'slack');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/channels doctor slack');
    expect(workspace.lastActionResult?.title).toBe('Opening channel doctor');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-setup');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('channel-setup');
    feedText(workspace, 'discord');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/channels setup discord');

    expect(dispatched).not.toContain('/channels send telegram');
    expect(dispatched.join('\n')).not.toContain('/notify test');
  });

  test('sends channel delivery messages from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-send');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('channel-send');
    feedText(workspace, 'Review the approvals');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Approvals');
    feedKey(workspace, 'enter');
    feedText(workspace, 'slack:ops:Ops');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/channels send --title Approvals --channel slack:ops:Ops --message "Review the approvals" --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening channel delivery');
  });

  test('removes notification webhook targets from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'notification-remove-webhook');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('notify-webhook-remove');
    feedText(workspace, 'https://ntfy.sh/goodvibes-agent-alerts');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/notify remove https://ntfy.sh/goodvibes-agent-alerts --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening notification webhook remove');
  });

  test('clears notification webhook targets from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'notification-clear-webhooks');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('notify-webhook-clear');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/notify clear --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening notification webhook clear');
  });

  test('tests notification webhook targets from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'notification-test-webhooks');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('notify-webhook-test');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/notify test --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening notification webhook test');
  });

  test('sends notification webhook messages from the workspace only after typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'notification-send');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('notify-send');
    feedText(workspace, 'Review the new approvals');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/notify send "Review the new approvals" --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening notification send');
  });

  // DELETED: 'discovers and imports local skill/persona/routine files from the workspace after confirmation'
  // skills-discover, skills-import-discovered, personas-discover, personas-import-discovered,
  // routines-discover, routines-import-discovered action IDs were all removed from the workspace.

  test('creates reviews marks stale and deletes Agent memory from workspace editors', async () => {
    const records: MemoryRecord[] = [];
    const ctx = {
      ...commandContext(),
      workspace: {
        shellPaths: createShellPathService({
          workingDirectory: makeProjectTempDir('goodvibes-agent-memory-workspace'),
          homeDirectory: makeProjectTempDir('goodvibes-agent-memory-home'),
        }),
      },
      clients: {
        agentKnowledgeApi: {
          memory: memoryApi(records),
        },
      },
    } as unknown as CommandContext;
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(ctx, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-create');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Prefers concise briefings');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Summarize before action.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'preference');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    await Promise.resolve();
    await Promise.resolve();

    expect(records[0]?.summary).toBe('Prefers concise briefings');
    expect(records[0]?.confidence).toBe(80);
    expect(workspace.lastActionResult?.title).toBe('Created memory');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-review');
    workspace.activateSelected();
    expect(records[0]?.reviewState).toBe('reviewed');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-stale');
    workspace.activateSelected();
    expect(records[0]?.reviewState).toBe('stale');
    expect(records[0]?.staleReason).toContain('Agent workspace');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-delete');
    workspace.activateSelected();
    expect(workspace.localEditor?.title).toBe('Delete Memory');
    feedText(workspace, records[0]?.id ?? '');
    feedKey(workspace, 'enter');

    expect(records).toHaveLength(0);
    expect(dispatched).toEqual([]);
  });

  test('opens read-only Agent memory command forms from the workspace', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-search');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('memory-search');
    feedText(workspace, 'release blocker');
    feedKey(workspace, 'enter');
    feedText(workspace, 'project');
    feedKey(workspace, 'enter');
    feedText(workspace, 'risk');
    feedKey(workspace, 'enter');
    feedText(workspace, '5');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/memory search "release blocker" --scope project --cls risk --limit 5 --semantic']);
    expect(workspace.localEditor).toBeNull();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-get');
    workspace.activateSelected();
    feedText(workspace, 'mem-123');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-explain');
    workspace.activateSelected();
    feedText(workspace, 'Prepare release notes');
    feedKey(workspace, 'enter');
    feedText(workspace, 'project, team');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-handoff-inspect');
    workspace.activateSelected();
    feedKey(workspace, 'enter');

    // memory-vector-status was removed
    expect(dispatched).toEqual([
      '/memory search "release blocker" --scope project --cls risk --limit 5 --semantic',
      '/memory get mem-123',
      '/memory explain "Prepare release notes" --scope project team',
      '/memory handoff-inspect agent-memory-handoff.json',
    ]);
  });

  test('requires confirmation before Agent memory maintenance workspace actions', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-promote');
    workspace.activateSelected();
    feedText(workspace, 'mem-1');
    feedKey(workspace, 'enter');
    feedText(workspace, 'team');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-link');
    workspace.activateSelected();
    feedText(workspace, 'mem-1');
    feedKey(workspace, 'enter');
    feedText(workspace, 'mem-2');
    feedKey(workspace, 'enter');
    feedText(workspace, 'supports');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-export');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedText(workspace, 'project');
    feedKey(workspace, 'enter');
    feedText(workspace, 'fact');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-import');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-handoff-export');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-handoff-import');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-vector-rebuild');
    workspace.activateSelected();
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/memory promote mem-1 team --yes',
      '/memory link mem-1 mem-2 supports --yes',
      '/memory export agent-memory-bundle.json --scope project --cls fact --yes',
      '/memory import agent-memory-bundle.json --yes',
      '/memory handoff-export agent-memory-handoff.json --scope team --yes',
      '/memory handoff-import agent-memory-handoff.json --yes',
      '/memory vector rebuild',
    ]);
  });

  test('rejects secret-looking Agent memory from the workspace editor', async () => {
    const records: MemoryRecord[] = [];
    const ctx = {
      ...commandContext(),
      clients: {
        agentKnowledgeApi: {
          memory: memoryApi(records),
        },
      },
    } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-create');
    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'api_key=sk-secretsecretsecretsecret');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    await Promise.resolve();

    expect(records).toHaveLength(0);
    expect(workspace.localEditor?.message).toContain('cannot store secret-looking values');
  });

  test('operates on selected local library records without dispatching commands', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-selected-library');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    personaRegistry.create({
      name: 'Home Operator',
      description: 'Home posture.',
      body: 'Coordinate home tasks.',
    });
    personaRegistry.create({
      name: 'Research Analyst',
      description: 'Research posture.',
      body: 'Check sources.',
    });
    const skillRegistry = AgentSkillRegistry.fromShellPaths(shellPaths);
    skillRegistry.create({
      name: 'Briefing',
      description: 'Summarize before action.',
      procedure: 'Inspect state first.',
    });
    skillRegistry.create({
      name: 'Travel Prep',
      description: 'Prepare travel workflow.',
      procedure: 'Check itinerary and packing.',
    });
    const routineRegistry = AgentRoutineRegistry.fromShellPaths(shellPaths);
    routineRegistry.create({
      name: 'Daily Brief',
      description: 'Daily operator summary.',
      steps: 'Review current state.',
    });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(ctx, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-next');
    workspace.activateSelected();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-use');
    workspace.activateSelected();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-review');
    workspace.activateSelected();

    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().activePersona?.name).toBe('Research Analyst');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).get('research-analyst')?.reviewState).toBe('reviewed');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-next');
    workspace.activateSelected();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-enable');
    workspace.activateSelected();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-review');
    workspace.activateSelected();

    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('travel-prep')?.enabled).toBe(true);
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get('travel-prep')?.reviewState).toBe('reviewed');

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-start');
    workspace.activateSelected();

    const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).get('daily-brief');
    expect(routine?.startCount).toBe(0);
    expect(dispatched).toEqual(['/routines start daily-brief']);
    expect(workspace.lastActionResult?.title).toBe('Opening routine Daily Brief');
  });

  test('edits selected local library records from workspace editors without dispatching commands', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-edit-library');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    const persona = personaRegistry.create({
      name: 'Home Operator',
      description: 'Home posture.',
      body: 'Coordinate home tasks.',
      tags: ['home'],
      triggers: ['house'],
    });
    personaRegistry.setActive(persona.id);
    const skillRegistry = AgentSkillRegistry.fromShellPaths(shellPaths);
    const skill = skillRegistry.create({
      name: 'Briefing',
      description: 'Summarize before action.',
      procedure: 'Inspect state first.',
      enabled: true,
    });
    const routineRegistry = AgentRoutineRegistry.fromShellPaths(shellPaths);
    const routine = routineRegistry.create({
      name: 'Daily Brief',
      description: 'Daily operator summary.',
      steps: 'Review current state.',
      enabled: true,
    });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(ctx, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-edit');
    workspace.activateSelected();
    expect(workspace.localEditor?.title).toBe('Edit Persona');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, ' Include errands.');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    const updatedPersona = AgentPersonaRegistry.fromShellPaths(shellPaths).get(persona.id);
    expect(updatedPersona?.body).toContain('Include errands.');
    expect(updatedPersona?.reviewState).toBe('fresh');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().activePersonaId).toBe(persona.id);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-edit');
    workspace.activateSelected();
    expect(workspace.localEditor?.recordId).toBe(skill.id);
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, ' Then summarize risks.');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    const updatedSkill = AgentSkillRegistry.fromShellPaths(shellPaths).get(skill.id);
    expect(updatedSkill?.procedure).toContain('Then summarize risks.');
    expect(updatedSkill?.enabled).toBe(true);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-edit');
    workspace.activateSelected();
    expect(workspace.localEditor?.recordId).toBe(routine.id);
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, ' Report blockers.');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    const updatedRoutine = AgentRoutineRegistry.fromShellPaths(shellPaths).get(routine.id);
    expect(updatedRoutine?.steps).toContain('Report blockers.');
    expect(updatedRoutine?.enabled).toBe(true);
    expect(dispatched).toEqual([]);
  });

  test('deletes selected local library records only after exact typed confirmation', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-delete-library');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    const persona = personaRegistry.create({
      name: 'Temporary Persona',
      description: 'Temporary posture.',
      body: 'Temporary guidance.',
    });
    personaRegistry.setActive(persona.id);
    const skill = AgentSkillRegistry.fromShellPaths(shellPaths).create({
      name: 'Temporary Skill',
      description: 'Temporary procedure.',
      procedure: 'Temporary steps.',
    });
    const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).create({
      name: 'Temporary Routine',
      description: 'Temporary workflow.',
      steps: 'Temporary routine steps.',
    });
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(ctx, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-delete');
    workspace.activateSelected();
    feedText(workspace, 'wrong-id');
    feedKey(workspace, 'enter');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).get(persona.id)).toEqual(expect.objectContaining({
      id: persona.id,
    }));
    expect(workspace.localEditor?.message).toContain('Deletion not confirmed');
    while (workspace.localEditor?.fields[0]?.value) feedKey(workspace, 'backspace');
    feedText(workspace, persona.id);
    feedKey(workspace, 'enter');
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).get(persona.id)).toBeNull();
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().activePersonaId).toBeNull();

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-delete');
    workspace.activateSelected();
    feedText(workspace, skill.id);
    feedKey(workspace, 'enter');
    expect(AgentSkillRegistry.fromShellPaths(shellPaths).get(skill.id)).toBeNull();

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-delete');
    workspace.activateSelected();
    feedText(workspace, routine.id);
    feedKey(workspace, 'enter');
    expect(AgentRoutineRegistry.fromShellPaths(shellPaths).get(routine.id)).toBeNull();
    expect(dispatched).toEqual([]);
  });

  test('keeps channel delivery safety guidance local', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-safety');

    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.lastActionResult?.kind).toBe('guidance');
    expect(workspace.status).toContain('delivered silently');
  });

  test('summarizes channel readiness without exposing secret config values', () => {
    const configValues = new Map<string, unknown>([
      ['surfaces.slack.enabled', true],
      ['surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN'],
      ['surfaces.slack.signingSecret', 'goodvibes://secrets/goodvibes/SLACK_SIGNING_SECRET'],
      ['surfaces.slack.defaultChannel', '#ops'],
      ['surfaces.discord.enabled', true],
      ['surfaces.discord.botToken', 'goodvibes://secrets/goodvibes/DISCORD_BOT_TOKEN'],
    ]);
    const snapshot = buildAgentWorkspaceRuntimeSnapshot({
      ...commandContext(),
      platform: {
        configManager: {
          get: (key: string) => configValues.get(key),
        },
      },
    } as unknown as CommandContext);

    const slack = snapshot.channels.find((channel) => channel.id === 'slack');
    const discord = snapshot.channels.find((channel) => channel.id === 'discord');

    expect(snapshot.channels).toHaveLength(14);
    expect(slack?.ready).toBe(true);
    expect(slack?.defaultTarget).toBe('configured');
    expect(slack?.delivery).toBe('default-ready');
    expect(discord?.ready).toBe(false);
    expect(discord?.missingConfigCount).toBe(2);
    expect(snapshot.channelSetupGuide.status).toBe('attention');
    expect(snapshot.channelSetupGuide.currentChannelId).toBe('discord');
    expect(snapshot.channelSetupGuide.currentStepId).toBe('inspect-setup-schema');
    expect(snapshot.channelSetupGuide.steps.map((step) => step.id)).toContain('review-policy');
    expect(snapshot.channelSetupGuide.steps.map((step) => step.id)).toContain('send-explicit-test');
    expect(JSON.stringify(snapshot.channels)).not.toContain('SLACK_BOT_TOKEN');
    expect(JSON.stringify(snapshot.channels)).not.toContain('DISCORD_BOT_TOKEN');
    expect(JSON.stringify(snapshot.channelSetupGuide)).not.toContain('SLACK_BOT_TOKEN');
    expect(JSON.stringify(snapshot.channelSetupGuide)).not.toContain('DISCORD_BOT_TOKEN');
  });

  test('channels command prints read-only readiness without secret values', async () => {
    const printed: string[] = [];
    const configValues = new Map<string, unknown>([
      ['surfaces.slack.enabled', true],
      ['surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN'],
      ['surfaces.slack.signingSecret', 'goodvibes://secrets/goodvibes/SLACK_SIGNING_SECRET'],
      ['surfaces.slack.defaultChannel', '#ops'],
      ['surfaces.telegram.enabled', true],
      ['surfaces.telegram.botToken', 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN'],
    ]);
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    await registry.execute('channels', [], {
      ...commandContext(),
      print: (text: string) => printed.push(text),
      platform: {
        configManager: {
          get: (key: string) => configValues.get(key),
        },
      },
    } as unknown as CommandContext);

    const output = printed.join('\n');
    expect(output).toContain('Channel Readiness');
    expect(output).toContain('ready: 2/14');
    expect(output).toContain('Slack: ready ready=yes delivery=default-ready risk=group');
    expect(output).toContain('Telegram: needs-target ready=yes delivery=explicit-target risk=dm');
    expect(output).toContain('policy: read-only inspection');
    expect(output).toContain('sends require explicit user action');
    expect(output).not.toContain('SLACK_BOT_TOKEN');
    expect(output).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  test('builds a first-run setup checklist from live Agent state', () => {
    const configValues = new Map<string, unknown>([
      ['controlPlane.host', '127.0.0.1'],
      ['controlPlane.port', 3421],
      ['surfaces.slack.enabled', true],
      ['surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN'],
      ['surfaces.slack.signingSecret', 'goodvibes://secrets/goodvibes/SLACK_SIGNING_SECRET'],
      ['surfaces.slack.defaultChannel', '#ops'],
    ]);
    const snapshot = buildAgentWorkspaceRuntimeSnapshot({
      ...commandContext(),
      session: {
        runtime: {
          model: 'openai:gpt-5.5',
          provider: 'openai-subscriber',
          sessionId: 'agent-session-1',
        },
        sessionMemoryStore: { list: () => [{ id: 'mem-1' }] },
      },
      platform: {
        configManager: {
          get: (key: string) => configValues.get(key),
        },
      },
      clients: {
        agentKnowledgeApi: {
          memory: memoryApi([
            memoryRecord({
              id: 'mem-setup',
              summary: 'Configured durable Agent memory',
              reviewState: 'reviewed',
            }),
          ]),
        },
      },
    } as unknown as CommandContext);
    const byId = new Map(snapshot.setupChecklist.map((item) => [item.id, item]));

    expect(byId.get('runtime')?.status).toBe('ready');
    expect(byId.get('connected-host-auth')?.status).toBe('recommended');
    expect(byId.get('connected-host-auth')?.breadcrumb).toBe('Connected Host');
    expect(byId.get('provider-model')?.status).toBe('ready');
    expect(byId.get('agent-knowledge')?.status).toBe('recommended');
    expect(byId.get('memory')?.status).toBe('ready');
    expect(byId.get('channels')?.status).toBe('ready');
    expect(byId.get('agent-knowledge')?.breadcrumb).toBe('Knowledge');
    expect(byId.get('profile')?.breadcrumb).toBe('Profiles');
    expect(byId.get('persona')?.breadcrumb).toBe('Personas');
    expect(byId.get('skills')?.breadcrumb).toBe('Skills');
    expect(byId.get('routines')?.breadcrumb).toBe('Routines');
    expect(byId.get('memory')?.breadcrumb).toBe('Memory');
    expect(byId.get('channels')?.breadcrumb).toBe('Messaging');
    expect(byId.get('voice-media')?.breadcrumb).toBe('Voice & Media');
    expect(JSON.stringify(snapshot.setupChecklist)).not.toContain('SLACK_BOT_TOKEN');
  });

  test('promotes setup checklist rows from durable setup receipt artifacts', () => {
    const configValues = new Map<string, unknown>([
      ['controlPlane.host', '127.0.0.1'],
      ['controlPlane.port', 3421],
      ['web.enabled', true],
      ['web.publicBaseUrl', 'http://127.0.0.1:3421/app'],
    ]);
    const artifacts: readonly ArtifactDescriptor[] = [
      setupReceiptArtifact({
        id: 'setup-auth-ready',
        createdAt: 3_000,
        metadata: {
          purpose: 'connected-host-setup-receipt',
          setupStepId: 'connected-host-auth',
          receiptId: 'auth-ready',
          receiptStatus: 'authenticated',
          recordedAt: '1970-01-01T00:00:03.000Z',
          summary: 'Operator auth token validated by connected host.',
        },
      }),
      setupReceiptArtifact({
        id: 'setup-smoke-ready',
        createdAt: 4_000,
        metadata: {
          purpose: 'agent-setup-receipt',
          setupStepId: 'install-smoke',
          receiptId: 'smoke-ready',
          receiptStatus: 'ready',
          recordedAt: '1970-01-01T00:00:04.000Z',
          summary: 'Setup smoke completed with first assistant turn.',
        },
      }),
      setupReceiptArtifact({
        id: 'setup-browser-ready',
        createdAt: 5_000,
        metadata: {
          purpose: 'connected-host-browser-pwa-receipt',
          methodId: 'browser.pwa.firstRun',
          receiptId: 'browser-ready',
          receiptStatus: 'published',
          recordedAt: '1970-01-01T00:00:05.000Z',
          summary: 'Browser/PWA first-run completed.',
        },
      }),
    ];

    const snapshot = buildAgentWorkspaceRuntimeSnapshot({
      ...commandContext(),
      session: {
        runtime: {
          model: 'openai:gpt-5.5',
          provider: 'openai-subscriber',
          sessionId: 'agent-session-1',
        },
      },
      platform: {
        configManager: {
          get: (key: string) => configValues.get(key),
        },
        artifactStore: {
          list: () => artifacts,
        },
      },
    } as unknown as CommandContext);
    const byId = new Map(snapshot.setupChecklist.map((item) => [item.id, item]));

    expect(byId.get('connected-host-auth')?.status).toBe('ready');
    expect(byId.get('connected-host-auth')?.detail).toContain('Durable connected-host auth receipt is ready');
    expect(snapshot.setupWizard._diagnostic.stepHistory.filter((entry) => entry.kind === 'durable-receipt')).toHaveLength(3);
    expect(snapshot.setupWizard._diagnostic.receiptGaps.map((gap) => gap.stepId)).toEqual(['runtime']);
  });

  test('promotes setup checklist rows from live daemon setup receipt read models', () => {
    const configValues = new Map<string, unknown>([
      ['controlPlane.host', '127.0.0.1'],
      ['controlPlane.port', 3421],
      ['web.enabled', true],
      ['web.publicBaseUrl', 'http://127.0.0.1:3421/app'],
    ]);

    const snapshot = buildAgentWorkspaceRuntimeSnapshot({
      ...commandContext(),
      session: {
        runtime: {
          model: 'openai:gpt-5.5',
          provider: 'openai-subscriber',
          sessionId: 'agent-session-1',
        },
      },
      platform: {
        configManager: {
          get: (key: string) => configValues.get(key),
        },
        readModels: {
          setup: {
            receipts: {
              getSnapshot: () => ({
                receipts: {
                  auth: {
                    setupStepId: 'connected-host-auth',
                    receiptId: 'live-auth-ready',
                    receiptStatus: 'authenticated',
                    recordedAt: '1970-01-01T00:00:03.000Z',
                    summary: 'Operator auth token=super-secret was validated by connected host.',
                  },
                  smoke: {
                    setupStepId: 'install-smoke',
                    receiptId: 'live-smoke-ready',
                    status: 'ready',
                    recordedAt: '1970-01-01T00:00:04.000Z',
                    summary: 'Live setup smoke completed with first assistant turn.',
                    inspectRoute: 'setup action:"item" setupItemId:"install-smoke" includeParameters:true',
                  },
                  browser: {
                    methodId: 'browser.pwa.firstRun',
                    receiptId: 'live-browser-ready',
                    state: 'published',
                    timestamp: '1970-01-01T00:00:05.000Z',
                    summary: 'Browser/PWA first-run completed from browser runtime.',
                  },
                },
              }),
            },
          },
        },
      },
    } as unknown as CommandContext);
    const byId = new Map(snapshot.setupChecklist.map((item) => [item.id, item]));
    const wizardSteps = new Map(snapshot.setupWizard.steps.map((step) => [step.id, step]));

    expect(byId.get('connected-host-auth')?.status).toBe('ready');
    expect(wizardSteps.get('connected-host-auth')?.detail).toContain('live-auth-ready');
    expect(wizardSteps.get('connected-host-auth')?.detail).not.toContain('super-secret');
    const durableHistory = snapshot.setupWizard._diagnostic.stepHistory.filter((entry) => entry.kind === 'durable-receipt');
    expect(durableHistory).toHaveLength(3);
    expect(durableHistory.every((entry) => entry.source === 'context.platform.readModels.setup.receipts')).toBe(true);
    expect(durableHistory.find((entry) => entry.receiptId === 'live-auth-ready')?.summary).toContain('token=<redacted>');
    expect(snapshot.setupWizard._diagnostic.receiptGaps.map((gap) => gap.stepId)).toEqual(['runtime']);
  });

  // DELETED: 'exposes Agent Knowledge review queue and list views without default knowledge fallback'
  // knowledge-sources, knowledge-nodes, knowledge-issues, knowledge-review-queue action IDs were all removed.

  test('ingests Agent Knowledge URLs from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-ingest-url');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-url');
    expect(dispatched).toEqual([]);
    feedText(workspace, 'https://example.com/agent-guide?topic=operator&mode=full');
    feedKey(workspace, 'enter');
    feedText(workspace, 'docs,agent');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Research Sources/Agent Guides');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/knowledge ingest-url "https://example.com/agent-guide?topic=operator&mode=full" --tags docs,agent --folder "Research Sources/Agent Guides" --yes',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('ingests Agent Knowledge files from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-ingest-file');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-file');
    expect(dispatched).toEqual([]);
    feedText(workspace, './docs/agent-guide.md');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Agent Guide');
    feedKey(workspace, 'enter');
    feedText(workspace, 'docs,agent');
    feedKey(workspace, 'enter');
    feedText(workspace, 'guides');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/knowledge ingest-file ./docs/agent-guide.md --title "Agent Guide" --tags docs,agent --folder guides --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('imports Agent Knowledge URL lists from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-import-urls');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-urls');
    expect(dispatched).toEqual([]);
    feedText(workspace, './agent sources.txt');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/knowledge import-urls "./agent sources.txt" --allow-private-hosts --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('imports browser history into Agent Knowledge from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-import-browser-history');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-browser-history');
    expect(dispatched).toEqual([]);
    feedText(workspace, 'chrome,firefox');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, '100');
    feedKey(workspace, 'enter');
    feedText(workspace, '30');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/knowledge import-browser-history --browsers chrome,firefox --sources history,bookmark --limit 100 --since-days 30 --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('ingests connector input into Agent Knowledge from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-ingest-connector');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-connector-ingest');
    expect(dispatched).toEqual([]);
    feedText(workspace, 'url');
    feedKey(workspace, 'enter');
    feedText(workspace, 'https://example.com/reference');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/knowledge ingest-connector url --input https://example.com/reference --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('inspects Agent Knowledge connectors from workspace actions', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');

    // knowledge-connectors (list) was removed; connector-show and connector-doctor remain
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-connector-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-connector-show');
    feedText(workspace, 'url');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/knowledge connectors url');
    expect(workspace.lastActionResult?.safety).toBe('read-only');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-connector-doctor');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-connector-doctor');
    feedText(workspace, 'browser-history');
    feedKey(workspace, 'enter');
    expect(dispatched.at(-1)).toBe('/knowledge connectors doctor browser-history');
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.safety).toBe('read-only');
  });

  test('queries Agent Knowledge from workspace forms without placeholder commands', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-search');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-search');
    feedText(workspace, 'GoodVibes Agent setup');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual(['/knowledge search "GoodVibes Agent setup"']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.safety).toBe('read-only');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-ask');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-ask');
    feedText(workspace, 'What should Agent remember?');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/knowledge search "GoodVibes Agent setup"',
      '/knowledge ask "What should Agent remember?"',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.status).toBe('Opening Agent Knowledge ask.');
  });

  test('reviews and maintains Agent Knowledge from workspace forms', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-get');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-get');
    feedText(workspace, 'issue-1');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-map');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-map');
    feedText(workspace, 'setup');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, '25');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-review-issue');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-review-issue');
    feedText(workspace, 'issue-1');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'accept');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, '{"title":"Agent setup"}');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/knowledge get issue-1',
      '/knowledge map setup --limit 25',
    ]);
    expect(workspace.localEditor?.message).toContain('not confirmed');
    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-packet');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-packet');
    feedText(workspace, 'Prepare a setup brief');
    feedKey(workspace, 'enter');
    feedText(workspace, 'docs,setup');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-explain');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-explain');
    feedText(workspace, 'Explain setup memory');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-consolidate');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('knowledge-consolidate');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/knowledge get issue-1',
      '/knowledge map setup --limit 25',
      '/knowledge review-issue issue-1 accept --reviewer agent --value "{\\"title\\":\\"Agent setup\\"}" --yes',
      '/knowledge packet "Prepare a setup brief" --scope docs --scope setup',
      '/knowledge explain "Explain setup memory"',
      '/knowledge consolidate light --yes',
    ]);
  });

  test('imports Agent Knowledge bookmarks from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-import-bookmarks');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-bookmarks');
    feedText(workspace, './exports/browser bookmarks.html');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/knowledge import-bookmarks "./exports/browser bookmarks.html" --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('reindexes Agent Knowledge only from a confirmed workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-reindex');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('knowledge-reindex');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('Confirm is required');

    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/knowledge reindex --yes']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('does not import Agent Knowledge bookmarks without typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-import-bookmarks');

    workspace.activateSelected();
    feedText(workspace, './exports/bookmarks.html');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.kind).toBe('knowledge-bookmarks');
    expect(workspace.status).toBe('Agent Knowledge bookmark import not confirmed.');
  });

  test('summarizes voice and media provider coverage in the runtime snapshot', () => {
    const keys = ['ELEVENLABS_API_KEY', 'XI_API_KEY', 'FAL_KEY', 'FAL_API_KEY'] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]] as const));
    for (const key of keys) delete process.env[key];
    try {
      const snapshot = buildAgentWorkspaceRuntimeSnapshot({
        ...commandContext(),
        platform: {
          configManager: {
            get: (key: string) => new Map<string, unknown>([
              ['tts.provider', 'elevenlabs'],
              ['tts.voice', 'voice-operator'],
              ['tts.llmProvider', 'openai-subscriber'],
              ['tts.llmModel', 'gpt-5.5'],
              ['ui.voiceEnabled', true],
              ['web.enabled', true],
              ['web.publicBaseUrl', 'https://agent.example.test'],
            ]).get(key),
          },
          voiceProviderRegistry: {
            list: () => [
              { id: 'elevenlabs', label: 'ElevenLabs', capabilities: ['tts-stream', 'stt', 'realtime'] },
              { id: 'deepgram', label: 'Deepgram', capabilities: ['stt'] },
            ],
          },
          mediaProviderRegistry: {
            list: () => [
              { id: 'builtin:image-understanding', label: 'Image Understanding', capabilities: ['understand'] },
              { id: 'fal', label: 'Fal', capabilities: ['generate'] },
            ],
          },
        },
      } as unknown as CommandContext);

      expect(snapshot.voiceProviderCount).toBe(2);
      expect(snapshot.voiceStreamingProviderCount).toBe(1);
      expect(snapshot.voiceSttProviderCount).toBe(2);
      expect(snapshot.voiceRealtimeProviderCount).toBe(1);
      expect(snapshot.ttsProvider).toBe('elevenlabs');
      expect(snapshot.ttsVoice).toBe('voice-operator');
      expect(snapshot.ttsResponseModel).toBe('openai-subscriber/gpt-5.5');
      expect(snapshot.voiceSurfaceEnabled).toBe(true);
      expect(snapshot.mediaProviderCount).toBe(2);
      expect(snapshot.mediaUnderstandingProviderCount).toBe(1);
      expect(snapshot.mediaGenerationProviderCount).toBe(1);
      expect(snapshot.voiceMediaReadiness.readyVoiceProviderCount).toBe(0);
      expect(snapshot.voiceMediaReadiness.readyMediaProviderCount).toBe(1);
      expect(snapshot.voiceMediaReadiness.selectedTtsProviderStatus).toBe('needs-secret');
      expect(snapshot.voiceMediaReadiness.selectedTtsProviderLabel).toBe('ElevenLabs');
      expect(snapshot.voiceMediaReadiness.ttsVoiceConfigured).toBe(true);
      expect(snapshot.voiceMediaReadiness.ttsResponseRouteConfigured).toBe(true);
      expect(snapshot.voiceMediaReadiness.browserToolState).toBe('public-url');
      expect(snapshot.voiceMediaReadiness.voiceProviders[0]?.missingSecretKeyOptions).toEqual(['ELEVENLABS_API_KEY', 'XI_API_KEY']);
      expect(snapshot.voiceMediaReadiness.mediaProviders[1]?.missingSecretKeyOptions).toEqual(['FAL_KEY', 'FAL_API_KEY']);
      expect(snapshot.browserToolExposureEnabled).toBe(true);
      expect(snapshot.browserToolPublicBaseUrl).toBe('https://agent.example.test');
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('opens voice media forms and dispatches concrete commands', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-voice-media');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'tts-speak');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('tts-prompt');
    feedText(workspace, 'Read the morning brief');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual(['/tts "Read the morning brief"']);

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'image-attach');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('image-input');
    feedText(workspace, './screenshots/dashboard.png');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Summarize the visible errors');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'media-generate');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('media-generate');
    feedText(workspace, 'Create a clean dashboard hero image');
    feedKey(workspace, 'enter');
    feedText(workspace, 'fal');
    feedKey(workspace, 'enter');
    feedText(workspace, 'fast-sdxl');
    feedKey(workspace, 'enter');
    feedText(workspace, 'image/png');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/tts "Read the morning brief"',
      '/image ./screenshots/dashboard.png "Summarize the visible errors"',
      '/media generate --provider fal --model fast-sdxl --mime image/png "Create a clean dashboard hero image" --yes',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.title).toBe('Opening media generation');
  });

  test('summarizes isolated Agent profile posture', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-profiles');
    const profile = createAgentRuntimeProfile(root, 'household');
    setAgentRuntimeProfileSelection(root, 'household');
    const snapshot = buildAgentWorkspaceRuntimeSnapshot({
      ...commandContext(),
      workspace: {
        shellPaths: {
          workingDirectory: root,
          homeDirectory: root,
        },
      },
      platform: {
        configManager: {
          get: () => undefined,
        },
      },
    } as unknown as CommandContext);

    expect(snapshot.activeRuntimeProfile).toBe('(default home)');
    expect(snapshot.selectedRuntimeProfile).toBe('household');
    expect(snapshot.selectedRuntimeProfileExists).toBe(true);
    expect(snapshot.runtimeProfileCount).toBe(1);
    expect(snapshot.runtimeProfileRoot).toBe(getAgentRuntimeProfilesRoot(root));
    expect(snapshot.runtimeStarterTemplateCount).toBeGreaterThan(4);
    expect(snapshot.localStarterTemplateCount).toBe(0);

    const profileSnapshot = buildAgentWorkspaceRuntimeSnapshot({
      ...commandContext(),
      workspace: {
        shellPaths: {
          workingDirectory: root,
          homeDirectory: profile.homeDirectory,
        },
      },
      platform: {
        configManager: {
          get: () => undefined,
        },
      },
    } as unknown as CommandContext);

    expect(profileSnapshot.activeRuntimeProfile).toBe('household');
    expect(profileSnapshot.selectedRuntimeProfile).toBe('household');
    expect(profileSnapshot.runtimeProfileCount).toBe(1);
    expect(profileSnapshot.runtimeProfileRoot).toBe(getAgentRuntimeProfilesRoot(root));
  });

  test('agent profile command guides starter authoring and imports local starters', async () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-starter-author');
    const starterPath = join(root, 'starter.json');
    mkdirSync(join(root, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(root, '.goodvibes', 'agent', 'skills', 'briefing'), { recursive: true });
    mkdirSync(join(root, '.goodvibes', 'agent', 'routines'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'agent', 'personas', 'research.md'), [
      '---',
      'name: Research Operator',
      '---',
      'Prefer checked sources and clear unknowns.',
    ].join('\n'));
    writeFileSync(join(root, '.goodvibes', 'agent', 'skills', 'briefing', 'SKILL.md'), [
      '---',
      'name: Daily Brief Skill',
      '---',
      'Review work plans, approvals, routines, and Agent Knowledge before summarizing.',
    ].join('\n'));
    writeFileSync(join(root, '.goodvibes', 'agent', 'routines', 'evening.md'), [
      '---',
      'name: Evening Review',
      '---',
      'Review work plan, approvals, routines, and Agent Knowledge status.',
    ].join('\n'));
    const calls: string[] = [];
    const registry = new CommandRegistry();
    registerAgentRuntimeProfileRuntimeCommands(registry);
    const ctx = {
      ...commandContext(),
      print: (text: string) => calls.push(text),
      workspace: {
        shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
      },
    } as unknown as CommandContext;

    expect(await registry.execute('agent-profile', ['guide'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Agent Starter Authoring Guide');
    expect(calls.at(-1)).toContain('/agent-profile template export research');

    expect(await registry.execute('agent-profile', ['template', 'export', 'research', './starter.json', '--yes'], ctx)).toBe(true);
    const exported = JSON.parse(readFileSync(starterPath, 'utf-8')) as {
      template: {
        id: string;
        name: string;
        description: string;
      };
    };
    exported.template.id = 'lab-operator';
    exported.template.name = 'Lab Operator';
    exported.template.description = 'Custom lab operator profile starter.';
    writeFileSync(starterPath, `${JSON.stringify(exported, null, 2)}\n`, 'utf-8');

    expect(await registry.execute('agent-profile', ['template', 'import', './starter.json', '--yes'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Agent starter template imported: lab-operator');
    expect(await registry.execute('agent-profile', ['templates'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('lab-operator');
    expect(calls.at(-1)).toContain('[local');

    expect(await registry.execute('agent-profile', ['create', 'lab', '--template', 'lab-operator', '--yes'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Agent profile created: lab');
    expect(calls.at(-1)).toContain('starter: lab-operator');
    expect(await registry.execute('agent-profile', ['show', 'lab'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Agent profile: lab');
    expect(calls.at(-1)).toContain('starter: lab-operator');
    expect(await registry.execute('agent-profile', ['use', 'lab'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('without --yes');
    expect(readAgentRuntimeProfileSelection(root)).toBeNull();
    expect(await registry.execute('agent-profile', ['use', 'lab', '--yes'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Default Agent profile selected: lab');
    expect(readAgentRuntimeProfileSelection(root)?.id).toBe('lab');
    expect(await registry.execute('agent-profile', ['default'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Default Agent profile: lab');
    expect(await registry.execute('agent-profile', ['list'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('starter=lab-operator');
    expect(calls.at(-1)).toContain('default: lab');

    expect(await registry.execute('agent-profile', ['template', 'from-discovered', 'research-desk', '--name', 'Research Desk', '--yes'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Agent starter template created from discovered behavior: research-desk');
    expect(await registry.execute('agent-profile', ['create', 'desk', '--template', 'research-desk', '--yes'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('starter: research-desk');

    expect(await registry.execute('agent-profile', ['create-from-discovered', 'field-desk', '--template-id', 'field-desk-starter', '--name', 'Field Desk', '--yes'], ctx)).toBe(true);
    expect(calls.at(-1)).toContain('Agent profile created from discovered behavior: field-desk');
    expect(calls.at(-1)).toContain('starter: field-desk-starter');
  });

  test('exports and imports profile starter templates from in-workspace forms', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-export');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile-template-export');
    feedText(workspace, 'operations');
    feedKey(workspace, 'enter');
    feedText(workspace, './ops-starter.json');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/agent-profile template export operations ./ops-starter.json --yes']);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent starter template export');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-import');
    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile-template-import');
    feedText(workspace, './ops-starter.json');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/agent-profile template export operations ./ops-starter.json --yes',
      '/agent-profile template import ./ops-starter.json --yes',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent starter template import');
  });

  test('previews starter templates shows profiles and deletes profiles from workspace forms', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('profile-template-show');
    feedText(workspace, 'operations');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-show');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('profile-show');
    feedText(workspace, 'household');
    feedKey(workspace, 'enter');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-delete');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('profile-delete');
    feedText(workspace, 'old-profile');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([
      '/agent-profile template show operations',
      '/agent-profile show household',
    ]);
    expect(workspace.status).toContain('not confirmed');

    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/agent-profile template show operations',
      '/agent-profile show household',
      '/agent-profile delete old-profile --yes',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent profile deletion');
  });

  test('dispatches default profile selection from the workspace form after confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-default');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile-default');
    feedText(workspace, 'household');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(workspace.status).toContain('not confirmed');

    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/agent-profile use household --yes']);
    expect(workspace.lastActionResult?.title).toBe('Opening default Agent profile selection');
  });

  test('dispatches default profile clearing from the workspace form after confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-clear-default');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile-default-clear');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(workspace.status).toContain('not confirmed');

    clearEditorField(workspace);
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/agent-profile default clear --yes']);
    expect(workspace.lastActionResult?.title).toBe('Opening default Agent profile clear');
  });

  test('dispatches profile starter creation from discovered behavior through workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-from-discovered');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile-template-from-discovered');
    feedText(workspace, 'research-desk');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Research Desk');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Imported starter for research operations.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Research Operator');
    feedKey(workspace, 'enter');
    feedText(workspace, 'all');
    feedKey(workspace, 'enter');
    feedText(workspace, 'all');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/agent-profile template from-discovered research-desk --name "Research Desk" --description "Imported starter for research operations." --persona "Research Operator" --skills all --routines all --yes',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent starter-from-discovered creation');
  });

  test('dispatches profile creation from discovered behavior through workspace form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-from-discovered');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile-from-discovered');
    feedText(workspace, 'research-desk');
    feedKey(workspace, 'enter');
    feedText(workspace, 'research-desk-starter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Research Desk');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Imported profile for research operations.');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Research Operator');
    feedKey(workspace, 'enter');
    feedText(workspace, 'all');
    feedKey(workspace, 'enter');
    feedText(workspace, 'all');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/agent-profile create-from-discovered research-desk --template-id research-desk-starter --name "Research Desk" --description "Imported profile for research operations." --persona "Research Operator" --skills all --routines all --yes',
    ]);
    expect(workspace.lastActionResult?.title).toBe('Opening Agent profile-from-discovered creation');
  });

  test('keeps profile starter template forms local until typed confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-import');

    workspace.activateSelected();
    feedText(workspace, './starter.json');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.kind).toBe('profile-template-import');
    expect(workspace.status).toContain('not confirmed');
  });

  // DELETED: 'dispatches starter authoring guide from the workspace'
  // runtime-profile-guide action ID was removed from the workspace.

  test('creates an isolated Agent profile from the workspace form', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-profile-form');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open({
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext, (command) => dispatched.push(command));

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-create');
    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('profile');
    expect(workspace.localEditor?.fields.find((field) => field.id === 'template')?.value).toBe('research');

    feedText(workspace, 'research desk');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    const profiles = listAgentRuntimeProfiles(root);
    expect(dispatched).toEqual([]);
    expect(profiles.map((profile) => profile.id)).toContain('research-desk');
    expect(profiles.find((profile) => profile.id === 'research-desk')?.starterTemplateId).toBe('research');
    expect(workspace.lastActionResult?.detail).toContain('goodvibes-agent --agent-profile research-desk');
    expect(workspace.runtimeSnapshot?.runtimeProfileCount).toBe(1);
  });

  test('refuses to overwrite an existing Agent profile from the workspace form', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-profile-duplicate');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    createAgentRuntimeProfile(root, 'research-desk', { templateId: 'research' });
    const workspace = new AgentWorkspace();
    workspace.open({
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext, () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-create');
    workspace.activateSelected();
    feedText(workspace, 'research-desk');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');

    expect(workspace.localEditor?.kind).toBe('profile');
    expect(workspace.localEditor?.message).toContain('Agent profile already exists: research-desk');
    expect(workspace.lastActionResult?.kind).toBe('error');
    expect(listAgentRuntimeProfiles(root)).toHaveLength(1);
  });

  test('automation workspace dispatches routine promotion receipt review', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-setup-path');
    workspace.activateSelected();
    expect(dispatched).toEqual([]);
    expect(workspace.lastActionResult?.kind).toBe('guidance');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-delivery-targets');
    workspace.activateSelected();
    // schedule-delivery-targets navigates to onboarding-channels (renamed from 'channels')
    expect(workspace.selectedCategory.id).toBe('onboarding-channels');
    expect(dispatched).toEqual([]);

    // schedule-receipts was removed; navigate back to automation for schedule-receipt
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-receipt');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('schedule-receipt');
    feedText(workspace, 'receipt-456');
    feedKey(workspace, 'enter');

    expect(dispatched.at(-1)).toBe('/schedule receipt receipt-456');
    expect(workspace.lastActionResult?.safety).toBe('read-only');
  });

  // DELETED: 'automation workspace dispatches routine schedule reconciliation'
  // schedule-reconcile action ID was removed from the workspace.

  test('automation workspace opens health repair guidance from a domain form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'health-repair');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('health-repair');
    clearEditorField(workspace);
    feedText(workspace, 'accounts');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/health repair accounts']);
    expect(workspace.lastActionResult?.safety).toBe('read-only');
  });

  test('automation workspace creates a confirmed reminder schedule through a form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-reminder');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('reminder-schedule');

    feedText(workspace, 'Follow up on the report');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, '2026-06-01T09:00:00-05:00');
    feedKey(workspace, 'enter');
    feedText(workspace, 'America/Chicago');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Report follow-up');
    feedKey(workspace, 'enter');
    feedText(workspace, 'slack:ops-alerts:Ops');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/schedule remind --message "Follow up on the report" --at 2026-06-01T09:00:00-05:00 --timezone America/Chicago --name "Report follow-up" --delivery-channel slack:ops-alerts:Ops --yes',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('automation workspace does not create reminder schedule without confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-reminder');

    workspace.activateSelected();
    feedText(workspace, 'Follow up on the report');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, '2026-06-01T09:00:00-05:00');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.kind).toBe('reminder-schedule');
    expect(workspace.status).toContain('not confirmed');
  });

  test('automation workspace promotes selected routine through a confirmed form', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(routineWorkspaceContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-promote-routine');

    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('routine-schedule');
    expect(workspace.localEditor?.fields.find((field) => field.id === 'routineId')?.value).toBe('daily-brief');

    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, '0 9 * * *');
    feedKey(workspace, 'enter');
    feedText(workspace, 'America/Chicago');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'slack:ops-alerts:Ops');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/schedule promote-routine daily-brief --cron "0 9 * * *" --timezone America/Chicago --name "Daily Brief" --delivery-channel slack:ops-alerts:Ops --yes',
    ]);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('automation workspace does not dispatch routine schedule promotion without confirmation', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(routineWorkspaceContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-promote-routine');

    workspace.activateSelected();
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, '0 9 * * *');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.kind).toBe('routine-schedule');
    expect(workspace.status).toContain('not confirmed');
  });

  test('keeps copied runner controls out of the build delegation workspace', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');

    const actionIds = workspace.actions.map((action) => action.id);

    // delegation-status was removed; delegate-task remains as the primary delegation entry point
    expect(dispatched).toEqual([]);
    expect(actionIds).toContain('delegate-task');
    expect(actionIds).not.toContain('delegation-status');
    expect(actionIds).not.toContain('remote-runner');
  });

  test('delegates build work from a confirmed workspace form without default WRFC', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'delegate-task');

    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('delegate-task');
    expect(workspace.localEditor?.fields.map((field) => field.id)).toEqual([
      'task',
      'reason',
      'success',
      'workspace',
      'priority',
      'review',
      'confirm',
    ]);
    feedText(workspace, 'Fix the installer crash and add a regression test');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    expect(dispatched).toEqual([]);
    expect(workspace.localEditor?.message).toContain('not confirmed');

    feedKey(workspace, 'backspace');
    feedKey(workspace, 'backspace');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/delegate "Fix the installer crash and add a regression test"']);
    expect(workspace.localEditor).toBeNull();
    expect(workspace.lastActionResult?.safety).toBe('delegates');
  });

  test('delegation workspace carries structured handoff context into the command', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'delegate-task');

    workspace.activateSelected();

    feedText(workspace, 'Stabilize remote artifact import');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Needs isolated GoodVibes TUI verification');
    feedKey(workspace, 'enter');
    feedText(workspace, 'Diff plus regression test output');
    feedKey(workspace, 'enter');
    feedText(workspace, 'goodvibes-tui worktree');
    feedKey(workspace, 'enter');
    feedText(workspace, 'release blocker');
    feedKey(workspace, 'enter');
    feedText(workspace, 'no');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual([
      '/delegate --reason "Needs isolated GoodVibes TUI verification" --success "Diff plus regression test output" --workspace "goodvibes-tui worktree" --priority "release blocker" "Stabilize remote artifact import"',
    ]);
  });

  test('delegation workspace requests WRFC only when explicitly selected', () => {
    const dispatched: string[] = [];
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), (command) => dispatched.push(command));
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'delegate-task');

    workspace.activateSelected();

    feedText(workspace, 'Review the release workflow implementation');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');
    feedText(workspace, 'yes');
    feedKey(workspace, 'enter');

    expect(dispatched).toEqual(['/delegate --review "Review the release workflow implementation"']);
  });

  test('refresh key rereads the live runtime snapshot', () => {
    const workspace = new AgentWorkspace();
    const runtime = {
      model: 'openai:gpt-5.5',
      provider: 'openai-subscriber',
      sessionId: 'session-1',
      debugMode: false,
      systemPrompt: '',
      reasoningEffort: 'medium',
    };
    const ctx = {
      executeCommand: async () => true,
      print: () => undefined,
      session: {
        runtime,
        sessionMemoryStore: { list: () => [] },
      },
      provider: {
        providerRegistry: {
          getCurrentModel: () => ({
            id: 'gpt-5.5',
            provider: runtime.provider,
            displayName: runtime.model,
            registryKey: runtime.model,
            contextWindow: 256000,
          }),
        },
      },
    } as unknown as CommandContext;

    workspace.open(ctx, () => undefined);
    expect(workspace.runtimeSnapshot?.model).toBe('openai:gpt-5.5');

    runtime.model = 'anthropic:claude-sonnet-4.5';
    handleAgentWorkspaceToken(workspace, { type: 'text', value: 'r' }, () => undefined, () => undefined);

    expect(workspace.runtimeSnapshot?.model).toBe('anthropic:claude-sonnet-4.5');
    expect(workspace.status).toContain('refreshed');
    expect(workspace.lastActionResult?.kind).toBe('refreshed');
  });

  test('token routing supports pane focus and navigation', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);

    handleAgentWorkspaceToken(workspace, { type: 'key', name: 'left', logicalName: 'left', ctrl: false, meta: false, shift: false }, () => undefined, () => undefined);
    expect(workspace.focusPane).toBe('categories');

    handleAgentWorkspaceToken(workspace, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, meta: false, shift: false }, () => undefined, () => undefined);
    expect(workspace.selectedCategory.label).toBe('Start');

    handleAgentWorkspaceToken(workspace, { type: 'key', name: 'right', logicalName: 'right', ctrl: false, meta: false, shift: false }, () => undefined, () => undefined);
    expect(workspace.focusPane).toBe('actions');
  });

  test('registers /agent, /home, and /operator aliases', async () => {
    const registry = new CommandRegistry();
    registerAgentWorkspaceRuntimeCommands(registry);
    const opened: string[] = [];
    const ctx = {
      openAgentWorkspace: (categoryId?: string) => opened.push(categoryId ? `agent:${categoryId}` : 'agent'),
      print: (text: string) => opened.push(`print:${text}`),
    } as unknown as CommandContext;

    expect(await registry.execute('agent', [], ctx)).toBe(true);
    expect(await registry.execute('home', [], ctx)).toBe(true);
    expect(await registry.execute('operator', [], ctx)).toBe(true);
    expect(opened).toEqual(['agent', 'agent', 'agent']);
  });

  test('opens the Agent workspace directly to a requested category', async () => {
    const registry = new CommandRegistry();
    registerAgentWorkspaceRuntimeCommands(registry);
    const opened: string[] = [];
    const ctx = {
      openAgentWorkspace: (categoryId?: string) => opened.push(categoryId ? `agent:${categoryId}` : 'agent'),
      print: (text: string) => opened.push(`print:${text}`),
    } as unknown as CommandContext;

    expect(await registry.execute('agent', ['voice-media'], ctx)).toBe(true);
    expect(await registry.execute('operator', ['Channels'], ctx)).toBe(true);
    expect(opened).toEqual(['agent:voice-media', 'agent:Channels']);
  });

  test('selects Agent workspace categories by id or label', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined, 'voice-media');
    expect(workspace.selectedCategory.id).toBe('onboarding-voice-media');

    expect(workspace.selectCategory('Channels')).toBe(true);
    expect(workspace.selectedCategory.id).toBe('onboarding-channels');

    expect(workspace.selectCategory('not-a-category')).toBe(false);
    expect(workspace.selectedCategory.id).toBe('onboarding-channels');
  });

  test('Enter on the sticky Finish setup row triggers completeOnboarding when prerequisites are met', () => {
    // Use a persistent context so shellPaths are available for completeOnboarding
    const { context } = persistentConfigContext();
    const workspace = new AgentWorkspace();
    const dispatched: string[] = [];
    workspace.open(context, (command) => dispatched.push(command));

    // Navigate to a non-finish ONBOARDING category that has no onboarding-complete action of its own
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    workspace.clampSelection();

    // The synthetic Finish setup row is appended last by workspace.actions
    workspace.selectedActionIndex = workspace.actions.length - 1;
    expect(workspace.selectedAction?.kind).toBe('onboarding-complete');

    // Activate it, should call completeOnboarding and not dispatch any command
    workspace.activateSelected();

    expect(dispatched).toEqual([]);
    expect(workspace.lastActionResult?.kind).toBe('recap');
    // After writing the completion marker, phase becomes 'complete', so the headline is the
    // phase-derived completion headline from deriveRecap (not the generic fallback).
    expect(workspace.lastActionResult?.title).toBe("You're set up. Here's what you can do now.");
  });

  // Test A: inline command behavior drives through handler.dispatchAgentWorkspaceCommand end-to-end
  test('activating a kind:command action with commandBehavior:inline does NOT close the workspace and captures output', async () => {
    const printedByContext: string[] = [];
    const ctx: CommandContext = {
      executeCommand: async (name: string, args: string[]) => {
        // Simulate a command that produces output via context.print (which is intercepted inline)
        ctx.print(`captured line 1 from ${[name, ...args].join(' ')}`);
        ctx.print('captured line 2');
        return true;
      },
      print: (text: string) => {
        printedByContext.push(text);
      },
    } as unknown as CommandContext;

    const workspace = new AgentWorkspace();
    const renders: number[] = [];

    // Build a minimal context that exercises the real dispatchAgentWorkspaceCommand without
    // constructing a full InputHandler (which requires UiRuntimeServices).
    // The inline branch only accesses this.agentWorkspace and this.requestRender, so we bind
    // the prototype method onto a minimal stub with exactly those two fields.
    const { InputHandler: HandlerClass } = await import('../../input/handler.ts');
    const stub = { agentWorkspace: workspace, requestRender: () => renders.push(Date.now()) };
    const dispatchInline = HandlerClass.prototype.dispatchAgentWorkspaceCommand.bind(stub);

    workspace.open(
      ctx,
      (command, behavior) => dispatchInline(command, ctx, behavior),
    );

    // Dispatch an inline command through the real handler method
    dispatchInline('/help', ctx, 'inline');

    // Inline does NOT close the workspace, active must remain true
    expect(workspace.active).toBe(true);

    // The print interceptor is active during executeCommand; wait for the microtask to settle
    await Promise.resolve();

    // lastActionResult must be populated with dispatched kind
    expect(workspace.lastActionResult).toBeDefined();
    expect(workspace.lastActionResult?.kind).toBe('dispatched');

    // detail must contain BOTH captured lines
    expect(workspace.lastActionResult?.detail).toContain('captured line 1 from help');
    expect(workspace.lastActionResult?.detail).toContain('captured line 2');

    // context.print must be restored (not the intercepted version)
    ctx.print('after dispatch');
    expect(printedByContext).toContain('after dispatch');
  });

  // Test A (supplemental): inline branch with executeCommand undefined yields an error result without clobbering context.print
  test('inline branch with no executeCommand sets an error result and does not clobber context.print', async () => {
    const printedByContext: string[] = [];
    const ctx: CommandContext = {
      // No executeCommand intentionally
      print: (text: string) => {
        printedByContext.push(text);
      },
    } as unknown as CommandContext;

    const workspace = new AgentWorkspace();
    const renders: number[] = [];

    const { InputHandler: HandlerClass } = await import('../../input/handler.ts');
    const stub = { agentWorkspace: workspace, requestRender: () => renders.push(Date.now()) };
    const dispatchInline = HandlerClass.prototype.dispatchAgentWorkspaceCommand.bind(stub);

    workspace.open(ctx, (command, behavior) => dispatchInline(command, ctx, behavior));
    dispatchInline('/help', ctx, 'inline');

    // Should be an error result, not dispatched
    expect(workspace.lastActionResult?.kind).toBe('error');
    expect(workspace.lastActionResult?.detail).toContain('No command dispatcher');

    // context.print must NOT be clobbered, it must still route to printedByContext
    ctx.print('still works');
    expect(printedByContext).toContain('still works');
  });

  // Test B: first-run launch shows ONBOARDING categories only; HOME hidden until completion marker
  test('first-run launch shows ONBOARDING categories only; HOME hidden until completion marker exists', () => {
    const workspace = new AgentWorkspace();

    // Open with onlyGroup: ONBOARDING (first-run mode)
    workspace.open(commandContext(), () => undefined, undefined, undefined, 'ONBOARDING');

    // All categories must be ONBOARDING group
    expect(workspace.categories.every((category) => category.group === 'ONBOARDING')).toBe(true);

    // The 'home' category must not appear
    expect(workspace.categories.some((category) => category.id === 'home')).toBe(false);

    // Close and reopen without onlyGroup (post-completion behavior)
    workspace.close();
    workspace.open(commandContext(), () => undefined);

    // Full category list is present
    expect(workspace.categories.length).toBeGreaterThan(workspace.categories.filter((c) => c.group === 'ONBOARDING').length);

    // The 'home' category is now present
    expect(workspace.categories.some((category) => category.id === 'home')).toBe(true);
  });

  // Test C (integration): open() in ONBOARDING mode with an in-progress user whose first non-ready
  // blocker maps to a non-setup category (provider-model blocked → resume target 'account-model').
  // Verifies that the real open() navigation path lands on the resume category, not 'setup'.
  // This is the regression test for the original bug: updateRevealedOnboardingCategories did NOT
  // reveal the resume target (a non-ready blocker), so open() silently stayed on 'setup' while
  // the status line claimed 'Picking up where you left off: Provider and model'.
  test('open() in ONBOARDING mode with in-progress user (provider-model blocked) navigates to account-model category', () => {
    // Set up a temp directory with shellPaths.
    const root = makeProjectTempDir('gv-onboarding-resume-nav');
    const workingDirectory = join(root, 'ws');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory });

    // Write a readable connected-host operator token so that connected-host-auth resolves to
    // 'ready' in buildAgentWorkspaceSetupChecklist. Without this, connected-host-auth is also
    // blocked and becomes the resume target (category 'setup'), not provider-model.
    const tokenDir = join(homeDirectory, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(connectedHostOperatorTokenPath(homeDirectory), JSON.stringify({ token: 'test-operator-token' }), 'utf-8');

    // Write the check marker (no completion marker) → phase becomes 'in-progress'.
    writeOnboardingCheckMarker(shellPaths);

    // Build a context that open() will feed into buildAgentWorkspaceRuntimeSnapshot.
    // No session.runtime.provider → provider === 'unknown' → provider-model is 'blocked'.
    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;

    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined, undefined, undefined, 'ONBOARDING');

    // The resume target must be 'account-model', not 'setup'.
    // Before the fix, updateRevealedOnboardingCategories did not reveal the non-ready blocker,
    // so categories.findIndex('account-model') returned -1 and selectedCategoryIndex stayed at 0 (setup).
    expect(workspace.selectedCategory.id).toBe('account-model');

    // The status line must reflect the resume narrative.
    expect(workspace.status).toContain('Picking up where you left off');
  });

  // Test D: after subscription-login-finish completes in ONBOARDING mode,
  // the workspace navigates to account-model and shows a plain success + next-step status.
  test('subscription-login-finish in ONBOARDING mode navigates to account-model and shows signed-in next-step', async () => {
    // Set up a real temp directory so shellPaths + onboarding markers work.
    const root = makeProjectTempDir('gv-onboarding-login-finish');
    const workingDirectory = join(root, 'ws');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
    // Write the operator token so connected-host-auth is 'ready', leaving provider-access as the blocker.
    const tokenDir = join(homeDirectory, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(connectedHostOperatorTokenPath(homeDirectory), JSON.stringify({ token: 'test-operator-token' }), 'utf-8');
    // Write check marker so phase becomes 'in-progress' rather than 'fresh'.
    writeOnboardingCheckMarker(shellPaths);

    // Minimal service-based OAuth provider mock.
    const serviceOauth = {
      authUrl: 'https://auth.example.test/oauth',
      tokenUrl: 'https://auth.example.test/token',
      clientId: 'test-client',
      redirectUri: 'http://localhost:1455/auth/callback',
      manualRedirectUri: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: ['profile'],
      usePkce: true,
      overrideAmbientApiKeys: false,
    };
    const pending = new Map<string, { provider: string; state: string; verifier: string; redirectUri: string; createdAt: number }>();
    const subscriptions = new Map<string, { provider: string; accessToken: string; tokenType: string; authMode: 'oauth'; overrideAmbientApiKeys: boolean; createdAt: number; updatedAt: number }>();
    const subscriptionManager = {
      list: () => [...subscriptions.values()],
      listPending: () => [...pending.values()],
      get: (provider: string) => subscriptions.get(provider) ?? null,
      getPending: (provider: string) => pending.get(provider) ?? null,
      beginOAuthLogin: async (provider: string, config: typeof serviceOauth) => {
        const record = { provider, state: 'state-1', verifier: 'verifier-1', redirectUri: config.redirectUri, createdAt: Date.now() };
        pending.set(provider, record);
        return { authorizationUrl: `https://auth.example.test/start?provider=${provider}`, pending: record };
      },
      completeOAuthLogin: async (provider: string, config: typeof serviceOauth, code: string) => {
        const now = Date.now();
        const record = { provider, accessToken: `token-${code}`, tokenType: 'Bearer', authMode: 'oauth' as const, overrideAmbientApiKeys: false, createdAt: now, updatedAt: now };
        subscriptions.set(provider, record);
        pending.delete(provider);
        return record;
      },
      logout: (_provider: string) => false,
    };
    const serviceRegistry = {
      get: (provider: string) => provider === 'test-oauth'
        ? { name: 'test-oauth', authType: 'oauth', tokenKey: 'TEST_OAUTH_TOKEN', providerId: 'test-oauth', oauth: serviceOauth }
        : null,
      getAll: () => ({ 'test-oauth': { name: 'test-oauth', authType: 'oauth', tokenKey: 'TEST_OAUTH_TOKEN', providerId: 'test-oauth', oauth: serviceOauth } }),
    };

    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
      platform: { subscriptionManager, serviceRegistry },
    } as unknown as CommandContext;

    const workspace = new AgentWorkspace();
    // Open in ONBOARDING mode, account-model not yet revealed (provider-access blocked)
    workspace.open(ctx, () => undefined, undefined, undefined, 'ONBOARDING');
    expect(workspace.selectedCategory.id).toBe('account-model'); // provider-access blocker resumes here

    // Run subscription-login-start.
    workspace.selectedCategoryIndex = workspace.categories.findIndex((c) => c.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((a) => a.id === 'subscription-login-start');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-login-start');
    clearEditorField(workspace);
    feedText(workspace, 'test-oauth');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'no'); // openBrowser = no
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'yes'); // confirm
    feedKey(workspace, 'enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspace.lastActionResult?.title).toBe('Subscription login started');

    // Run subscription-login-finish.
    workspace.selectedCategoryIndex = workspace.categories.findIndex((c) => c.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((a) => a.id === 'subscription-login-finish');
    workspace.activateSelected();
    expect(workspace.localEditor?.kind).toBe('subscription-login-finish');
    clearEditorField(workspace);
    feedText(workspace, 'test-oauth');
    feedKey(workspace, 'enter');
    feedText(workspace, 'auth-code-123');
    feedKey(workspace, 'enter');
    clearEditorField(workspace);
    feedText(workspace, 'yes'); // confirm
    feedKey(workspace, 'enter');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // (a) Result confirms success.
    expect(workspace.lastActionResult?.title).toBe('Subscription session saved');
    // (b) Status gives plain success + derived next-step, 'choose your model' is gone; derived from state.
    expect(workspace.status).toContain('Signed in.');
    expect(workspace.status).not.toContain('choose your model');
    // (c) Workspace navigated to account-model so the user can pick a model.
    expect(workspace.selectedCategory.id).toBe('account-model');
  });

  // Test D (part 2): onSubscriptionLoginSuccess() when refreshed state is readyToChat=true
  // (provider-access satisfied by subscription), status must reflect ready-to-chat, NOT 'choose your model'.
  test('onSubscriptionLoginSuccess() with readyToChat=true status reflects ready-to-chat, not choose-your-model', () => {
    // Set up temp directory for shellPaths.
    const root = makeProjectTempDir('gv-onboarding-login-ready');
    const workingDirectory = join(root, 'ws');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory });

    // Write operator token so connected-host-auth resolves to ready.
    const tokenDir = join(homeDirectory, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(connectedHostOperatorTokenPath(homeDirectory), JSON.stringify({ token: 'test-operator-token' }), 'utf-8');

    // Write check marker so phase is 'in-progress' (non-fresh), not 'complete'.
    writeOnboardingCheckMarker(shellPaths);

    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;

    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined, undefined, undefined, 'ONBOARDING');

    // Inject a runtime snapshot where all wizard steps are 'ready' (provider-access satisfied),
    // so computeOnboardingStateFromSnapshot inside onSubscriptionLoginSuccess returns readyToChat=true.
    const readyStep = {
      id: 'provider-access',
      label: 'Provider and model',
      status: 'done' as const,
      sourceStatus: 'ready' as const,
      detail: '',
      userRoute: '',
      modelRoute: '',
      actionId: '',
      backtrackRoute: null,
    };
    workspace.runtimeSnapshot = {
      ...workspace.runtimeSnapshot!,
      setupWizard: {
        available: true,
        status: 'complete' as const,
        completedSteps: 1,
        totalSteps: 1,
        currentStepId: null,
        currentStepLabel: null,
        progressLabel: 'All steps complete',
        next: '',
        reviewRoute: '',
        steps: [readyStep],
        _diagnostic: workspace.runtimeSnapshot!.setupWizard._diagnostic,
      },
    };

    workspace.onSubscriptionLoginSuccess();

    // Status must contain 'ready to chat' or 'Apply & close', NOT 'choose your model'.
    expect(workspace.status).toContain('Signed in.');
    expect(workspace.status).toContain('ready to chat');
    expect(workspace.status).not.toContain('choose your model');
  });

  // Test E (MINOR 2 regression): onSubscriptionLoginSuccess() must navigate to a lane
  // that was NOT revealed before sign-in (the stale-index window fix).
  //
  // Setup:
  //   - phase 'in-progress' (check marker written), connected-host-auth ready,
  //     provider-access blocked (no model), resume target is account-model.
  //   - account-model is revealed at open() because the resume target is added
  //     by updateRevealedOnboardingCategories, but selectedCategory lands on it.
  //
  // The stale-window: before the fix, the action received a categories list derived
  // from the PRE-update _onboardingState.  After sign-in the injected snapshot keeps
  // provider-access as the currentStep, so deriveOnboardingEntry returns
  // categoryId='account-model'.  With the old code that index was resolved against
  // the OLD categories (before _onboardingState was updated), which could be -1 if
  // the reveal set hadn't been refreshed yet.  With the fix the index is resolved
  // after the reveal-set update, guaranteeing the lane is present.
  test('onSubscriptionLoginSuccess() navigates to newly-revealed account-model lane (stale-index fix)', () => {
    const root = makeProjectTempDir('gv-onboarding-stale-index');
    const workingDirectory = join(root, 'ws');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory });

    // Write operator token so connected-host-auth is 'ready'.
    const tokenDir = join(homeDirectory, '.goodvibes', 'daemon');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(connectedHostOperatorTokenPath(homeDirectory), JSON.stringify({ token: 'test-operator-token' }), 'utf-8');

    // Write check marker, phase becomes 'in-progress'; provider-access is the
    // resume target (account-model category), connected-host-auth is ready.
    writeOnboardingCheckMarker(shellPaths);

    const ctx = {
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext;

    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined, undefined, undefined, 'ONBOARDING');

    // After open(): resume target is account-model (provider-access blocked).
    // Verify the pre-sign-in state: account-model is in categories (resume target
    // is always revealed) and is the selected category.
    expect(workspace.categories.some((c) => c.id === 'account-model')).toBe(true);
    expect(workspace.selectedCategory.id).toBe('account-model');

    // Navigate away to 'setup' to simulate the user browsing, so we can confirm
    // onSubscriptionLoginSuccess() navigates back to account-model explicitly.
    workspace.selectedCategoryIndex = workspace.categories.findIndex((c) => c.id === 'setup');
    expect(workspace.selectedCategory.id).toBe('setup');

    // Inject a post-sign-in snapshot: same steps, provider-access still the current
    // step (in-progress), so deriveOnboardingEntry returns categoryId='account-model'.
    // The stale-index window would manifest here: if categories was resolved against
    // the OLD _onboardingState (before updating the reveal set), findIndex could
    // return -1 and selectedCategoryIndex would stay on 'setup'.
    const blockedStep = {
      id: 'provider-access',
      label: 'Provider and model',
      status: 'pending' as const,
      sourceStatus: 'blocked' as const,
      detail: '',
      userRoute: '',
      modelRoute: '',
      actionId: '',
      backtrackRoute: null,
    };
    workspace.runtimeSnapshot = {
      ...workspace.runtimeSnapshot!,
      setupWizard: {
        ...workspace.runtimeSnapshot!.setupWizard,
        steps: [blockedStep],
        currentStepId: 'provider-access',
        currentStepLabel: 'Provider and model',
      },
    };

    workspace.onSubscriptionLoginSuccess();

    // After sign-in: must navigate to account-model (the resume target),
    // proving the index was resolved against the FRESH categories list.
    expect(workspace.selectedCategory.id).toBe('account-model');
    expect(workspace.status).toContain('Signed in.');
  });
});

// LIVE DISK MIRROR. Before this fix, `runtimeSnapshot` was built once
// at open()/action-completion time and cached on the AgentWorkspace instance;
// an external mutation (another shell deleting a memory, a CLI `routines
// start` invocation bumping a start count) left the in-UI counters showing a
// stale point-in-time snapshot until the user happened to trigger a workspace
// action. These tests reproduce the dogfood repro against the REAL render
// entry point (renderAgentWorkspaceLayer, the only production call site for
// renderAgentWorkspace, see renderer/conversation-overlays.ts) rather than only unit
// testing the new method in isolation.
describe('AgentWorkspace live disk-mirror counters', () => {
  test('memory count mirrors an external delete on the next repaint, not just after a workspace action', () => {
    const records = [
      memoryRecord({ id: 'mem-a', summary: 'First fact' }),
      memoryRecord({ id: 'mem-b', summary: 'Second fact' }),
    ];
    const ctx = {
      ...commandContext(),
      clients: { agentKnowledgeApi: { memory: memoryApi(records) } },
    } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');
    expect(workspace.runtimeSnapshot?.localMemoryCount).toBe(2);
    expect(linesText(renderAgentWorkspace(workspace, 160, 40))).toContain('Memory: 2;');

    // Simulate an external process (another shell, another Agent session)
    // deleting a memory record on disk. No workspace action is taken here,
    // the cached runtimeSnapshot on this instance is untouched.
    records.length = 1;

    // The real render entry point must mirror disk on this repaint.
    renderAgentWorkspaceLayer(workspace, 160, 40);
    expect(workspace.runtimeSnapshot?.localMemoryCount).toBe(1);
    const output = linesText(renderAgentWorkspace(workspace, 160, 40));
    expect(output).toContain('Memory: 1;');
    expect(output).not.toContain('Memory: 2;');
  });

  test('routine start count mirrors an external `routines start` bump (reproduces, then fixes, the routine-starts sub-claim)', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-live-routine');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const created = AgentRoutineRegistry.fromShellPaths(shellPaths).create({
      name: 'Morning Brief',
      description: 'Summarize overnight activity.',
      steps: 'Check the queue, then report.',
      enabled: true,
    });
    const ctx = { ...commandContext(), workspace: { shellPaths } } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');

    const beforeExternalStart = workspace.runtimeSnapshot?.localRoutines.find((item) => item.id === created.id);
    expect(beforeExternalStart?.startCount).toBe(0);

    // REPRO: a separate process (the CLI `routines start` path, or another
    // Agent session) marks the routine started directly against the on-disk
    // store, this workspace instance's cached runtimeSnapshot is untouched.
    AgentRoutineRegistry.fromShellPaths(shellPaths).markStarted(created.id);
    const stillCachedAtZero = workspace.runtimeSnapshot?.localRoutines.find((item) => item.id === created.id);
    expect(stillCachedAtZero?.startCount).toBe(0);

    // FIX: the real render entry point mirrors disk on the next repaint,
    // no manual refresh action required.
    renderAgentWorkspaceLayer(workspace, 160, 40);
    const afterRepaint = workspace.runtimeSnapshot?.localRoutines.find((item) => item.id === created.id);
    expect(afterRepaint?.startCount).toBe(1);
    expect(linesText(renderAgentWorkspace(workspace, 160, 40))).toContain('starts 1');
  });

  test('an external routine deletion is also mirrored, and clampSelection keeps the selected index in range', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-live-routine-delete');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const registry = AgentRoutineRegistry.fromShellPaths(shellPaths);
    const first = registry.create({ name: 'Alpha', description: 'A.', steps: 'Do A.', enabled: true });
    registry.create({ name: 'Beta', description: 'B.', steps: 'Do B.', enabled: true });
    const ctx = { ...commandContext(), workspace: { shellPaths } } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    expect(workspace.runtimeSnapshot?.localRoutineCount).toBe(2);

    // External delete of both routines (simulating another process/CLI).
    registry.deleteRoutine(first.id);
    registry.deleteRoutine('beta');

    expect(() => renderAgentWorkspaceLayer(workspace, 160, 40)).not.toThrow();
    expect(workspace.runtimeSnapshot?.localRoutineCount).toBe(0);
    expect(workspace.selectedLibraryItemIndexes.routine).toBe(0);
  });

  test('a live-read failure keeps the previous counters and labels them honestly as refreshing, instead of asserting a wrong number', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-live-routine-failure');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    AgentRoutineRegistry.fromShellPaths(shellPaths).create({
      name: 'Morning Brief',
      description: 'Summarize overnight activity.',
      steps: 'Check the queue, then report.',
      enabled: true,
    });
    const ctx = { ...commandContext(), workspace: { shellPaths } } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    expect(workspace.runtimeSnapshot?.localRoutineCount).toBe(1);
    expect(workspace.runtimeSnapshot?.liveCountersStale).toBe(false);

    // Corrupt the on-disk routine store to force the live re-read to throw
    // (AgentRoutineRegistry.readStore() throws on a JSON parse failure)
    // instead of silently returning an empty/zero count.
    const storePath = shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'routines.json');
    writeFileSync(storePath, '{ not valid json', 'utf-8');

    expect(() => renderAgentWorkspaceLayer(workspace, 160, 40)).not.toThrow();

    // The previous, still-accurate count is kept -- NOT silently zeroed --
    // and the snapshot is flagged stale so the render path can say so.
    expect(workspace.runtimeSnapshot?.localRoutineCount).toBe(1);
    expect(workspace.runtimeSnapshot?.liveCountersStale).toBe(true);
    const output = linesText(renderAgentWorkspace(workspace, 160, 40));
    expect(output).toContain('Routines: 1; enabled: 1 (refreshing...)');
  });
});
