import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import { activateAgentWorkspaceSelection } from '../../input/agent-workspace-activation.ts';
import type {
  AgentWorkspaceAction,
  AgentWorkspaceActionResult,
  AgentWorkspaceCategory,
  AgentWorkspaceFocusPane,
  AgentWorkspaceLocalEditor,
  AgentWorkspaceLocalEditorKind,
  AgentWorkspaceLocalLibraryItem,
  AgentWorkspaceLocalOperation,
} from '../../input/agent-workspace-types.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

const ROOT = join(import.meta.dir, '../../..');

interface WorkspaceCoverage {
  readonly commandRoots: ReadonlySet<string>;
  readonly actionIds: ReadonlySet<string>;
  readonly categoryIds: ReadonlySet<string>;
  readonly editorKinds: ReadonlySet<string>;
}

interface CoverageRequirement {
  readonly commandRoots?: readonly string[];
  readonly actionIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly editorPrefixes?: readonly string[];
}

function parseCliCommands(): readonly string[] {
  const source = readFileSync(join(ROOT, 'src/cli/types.ts'), 'utf-8');
  const unionMatch = source.match(/export type GoodVibesCliCommand =([\s\S]*?);/);
  if (!unionMatch) return [];
  return [...unionMatch[1]!.matchAll(/\|\s*'([^']+)'/g)].map((match) => match[1]!).sort();
}

function commandRoot(command: string): string {
  return command.trim().replace(/^\//, '').split(/\s+/)[0] ?? '';
}

function makeCommandContext(): CommandContext {
  return {
    executeCommand: async () => true,
    print: () => {},
  } as unknown as CommandContext;
}

function makeRegisteredCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry;
}

function collectWorkspaceCoverage(): WorkspaceCoverage {
  const commandRoots = new Set<string>();
  const actionIds = new Set<string>();
  const categoryIds = new Set<string>();
  const editorKinds = new Set<string>();

  for (const category of AGENT_WORKSPACE_CATEGORIES) {
    categoryIds.add(category.id);
    for (const action of category.actions) {
      actionIds.add(action.id);
      if (action.command) commandRoots.add(commandRoot(action.command));
      if (action.editorKind) editorKinds.add(action.editorKind);
    }
  }

  return { commandRoots, actionIds, categoryIds, editorKinds };
}

function hasCoverage(coverage: WorkspaceCoverage, requirement: CoverageRequirement): boolean {
  for (const root of requirement.commandRoots ?? []) {
    if (coverage.commandRoots.has(root)) return true;
  }
  for (const id of requirement.actionIds ?? []) {
    if (coverage.actionIds.has(id)) return true;
  }
  for (const id of requirement.categoryIds ?? []) {
    if (coverage.categoryIds.has(id)) return true;
  }
  for (const prefix of requirement.editorPrefixes ?? []) {
    for (const kind of coverage.editorKinds) {
      if (kind.startsWith(prefix)) return true;
    }
  }
  return false;
}

describe('Agent workspace command parity', () => {
  test('unsupported editor kinds fail closed instead of falling back to a local editor', () => {
    const malformedAction = {
      id: 'bad-editor',
      label: 'Bad editor',
      detail: 'This malformed action should never open a fallback editor.',
      editorKind: 'unknown-editor' as unknown as AgentWorkspaceAction['editorKind'],
      kind: 'editor',
      safety: 'safe',
    } satisfies AgentWorkspaceAction;
    const category: AgentWorkspaceCategory = {
      id: 'bad-category' as unknown as AgentWorkspaceCategory['id'],
      group: 'START', // test fixture, real group not needed for this structural test
      label: 'Bad Category',
      summary: 'Malformed test category.',
      detail: 'Malformed test category.',
      actions: [malformedAction],
    };
    const host = {
      categories: [category],
      selectedCategory: category,
      selectedAction: malformedAction,
      runtimeSnapshot: null,
      localEditor: null as AgentWorkspaceLocalEditor | null,
      focusPane: 'actions' as AgentWorkspaceFocusPane,
      selectedCategoryIndex: 0,
      selectedActionIndex: 0,
      status: '',
      lastActionResult: null as AgentWorkspaceActionResult | null,
      submitEditorFieldOrForm: () => {},
      focusActions: () => {},
      clampSelection: () => {},
      moveLocalLibraryItemSelection: (_kind: AgentWorkspaceLocalEditorKind, _delta: number) => {},
      selectedLocalLibraryItem: (_kind: AgentWorkspaceLocalEditorKind): AgentWorkspaceLocalLibraryItem | null => null,
      applyLocalLibraryOperation: (_operation: AgentWorkspaceLocalOperation) => {},
      hasCommandDispatch: () => true,
      dispatchWorkspaceCommand: (_command: string, _behavior?: 'inline' | 'compose' | 'exit') => {},
      commitActionSearchSelection: () => true,
    };

    activateAgentWorkspaceSelection(host as unknown as Parameters<typeof activateAgentWorkspaceSelection>[0]);

    expect(host.localEditor).toBeNull();
    expect(host.status).toBe('Editor unavailable: unknown-editor.');
    expect(host.lastActionResult).toEqual({
      kind: 'error',
      title: 'Editor unavailable',
      detail: 'No Agent workspace editor exists for unknown-editor.',
      safety: 'safe',
    });
  });

  test('workspace actions point to registered commands, real categories, and concrete editors', () => {
    const registry = makeRegisteredCommands();
    const categoryIds = new Set(AGENT_WORKSPACE_CATEGORIES.map((category) => category.id));
    const seenActionIds = new Set<string>();
    const failures: string[] = [];

    for (const category of AGENT_WORKSPACE_CATEGORIES) {
      for (let actionIndex = 0; actionIndex < category.actions.length; actionIndex += 1) {
        const action = category.actions[actionIndex]!;
        const actionRef = `${category.id}/${action.id}`;

        if (seenActionIds.has(action.id)) failures.push(`${actionRef}: duplicate action id`);
        seenActionIds.add(action.id);

        if (action.command) {
          const root = commandRoot(action.command);
          if (registry.get(root) === undefined) failures.push(`${actionRef}: unregistered command root ${root}`);
          if (/<[^>\s]+(?:\s+[^>]*)?>/.test(action.command)) failures.push(`${actionRef}: template command ${action.command}`);
        }
        if (action.targetCategoryId && !categoryIds.has(action.targetCategoryId)) {
          failures.push(`${actionRef}: unknown target category ${action.targetCategoryId}`);
        }
        if (action.kind === 'editor') {
          if (!action.editorKind) {
            failures.push(`${actionRef}: editor action has no editorKind`);
            continue;
          }
          const workspace = new AgentWorkspace();
          workspace.open(makeCommandContext(), () => {}, category.id);
          workspace.selectedActionIndex = workspace.actions.findIndex((entry) => entry.id === action.id);
          if (workspace.selectedActionIndex < 0) {
            failures.push(`${actionRef}: editor action is not visible`);
            continue;
          }
          workspace.activateSelected();
          if (!workspace.localEditor) {
            failures.push(`${actionRef}: did not open an editor`);
          } else {
            if (workspace.localEditor.kind !== action.editorKind) {
              failures.push(`${actionRef}: opened ${workspace.localEditor.kind} instead of ${action.editorKind}`);
            }
            if (workspace.localEditor.fields.length === 0) {
              failures.push(`${actionRef}: opened editor without fields`);
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test('product CLI commands have TUI workspace coverage unless they are pure shell utilities', () => {
    const coverage = collectWorkspaceCoverage();
    // Shell-only: no TUI workspace action makes sense for these.
    // compat/doctor/pair have no workspace actions in the current build.
    // import is a one-shot CLI migration utility (goodvibes-agent import openclaw)
    // with no TUI workspace editor; it writes through the existing registries.
    // workspaces (owner ruling, 2026-07-10) is a narrow, rarely-used admin
    // surface, register/unregister the checkpoint-gating workspace list, with
    // no TUI workspace editor yet, same shape as compat/doctor/pair above.
    // fleet (SDK 1.6.1 best-of-N attempts: list/pick/judge held-merge groups)
    // is the same kind of narrow admin surface, this Agent's own
    // orchestration engine state, not a connected-host call, with no TUI
    // workspace editor yet.
    // relay (SDK 1.6.1 outbound zero-knowledge relay): reports the connected
    // host's imported relay.* configuration and always honestly refuses to
    // mint a pairing payload (see relay-command.ts), a diagnostics/refusal
    // surface with no mutating action a TUI workspace editor would expose,
    // same shape as compat/doctor/pair above.
    // browser is a scriptable mirror of the `browser` MODEL TOOL, which is how
    // the capability is reached in a conversation. The CLI exists so a binary
    // install can be diagnosed and repaired from a shell without a model turn
    // (agent 1.18.1 shipped a broken browser and there was no way to ask the
    // binary anything), a diagnostics surface with no mutating setting a TUI
    // workspace editor would expose, same shape as compat/doctor/pair/relay.
    const shellOnlyCommands = new Set(['browser', 'completion', 'compat', 'doctor', 'fleet', 'help', 'import', 'pair', 'relay', 'tui', 'unknown', 'version', 'workspaces']);
    const requirements: Record<string, CoverageRequirement> = {
      ask: { categoryIds: ['knowledge'], editorPrefixes: ['knowledge-ask'] },
      auth: { editorPrefixes: ['auth-'] },
      bundle: { editorPrefixes: ['support-bundle-', 'trust-bundle-', 'auth-bundle-', 'subscription-bundle-'] },
      'channel-profiles': { commandRoots: ['channel-profiles'] },
      'owner-profile': { categoryIds: ['owner-profile'], editorPrefixes: ['owner-profile-'] },
      ci: { commandRoots: ['ci'] },
      delegate: { actionIds: ['delegate-task'], editorPrefixes: ['delegate-'] },
      knowledge: { categoryIds: ['knowledge'] },
      memory: { categoryIds: ['memory'], editorPrefixes: ['memory'] },
      models: { categoryIds: ['account-model'], actionIds: ['mode-preset', 'account-reasoning'] },
      onboarding: { categoryIds: ['setup'] },
      personas: { categoryIds: ['personas'], editorPrefixes: ['persona'] },
      principals: { commandRoots: ['principals'] },
      profiles: { categoryIds: ['profiles'], editorPrefixes: ['profile'] },
      providers: { actionIds: ['provider-use', 'provider-remove'], editorPrefixes: ['provider-'] },
      routines: { categoryIds: ['routines'], editorPrefixes: ['routine'] },
      run: { actionIds: ['chat'] },
      search: { categoryIds: ['knowledge'], editorPrefixes: ['knowledge-search'] },
      secrets: { editorPrefixes: ['secret-'] },
      sessions: { editorPrefixes: ['conversation-', 'session-'] },
      skills: { categoryIds: ['skills'], editorPrefixes: ['skill'] },
      status: { actionIds: ['health-repair'] },
      subscription: { editorPrefixes: ['subscription-'] },
      tasks: { actionIds: ['tasks-filter', 'task-show', 'task-output'] },
    };

    const missing = parseCliCommands()
      .filter((command) => !shellOnlyCommands.has(command))
      .filter((command) => !hasCoverage(coverage, requirements[command] ?? {}));

    expect(missing).toEqual([]);
  });
});
