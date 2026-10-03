/**
 * Routing regression tests for the Agent workspace editor submission layer.
 *
 * These tests guard against three defect classes:
 *  1. A command-editor kind not listed in isAgentWorkspaceCommandEditorKind
 *     silently falling through to the local-registry path (the
 *     `local-model-benchmark` bug fixed in agent-workspace-command-editor.ts).
 *  2. An unhandled kind in submitAgentWorkspaceLocalRegistryEditor silently
 *     writing a routine record instead of surfacing an error.
 *  3. A settingKey used in category actions that is absent from the live schema.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { AgentConfigManager } from '../../config/host-settings.ts';
import { getAgentSettingsSchema } from '../../config/settings-catalog.ts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES } from '../../input/agent-workspace-onboarding-categories.ts';
import { AgentWorkspace, handleAgentWorkspaceToken } from '../../input/agent-workspace.ts';
import { createAgentWorkspaceEditor } from '../../input/agent-workspace-activation.ts';
import { isAgentWorkspaceCommandEditorKind } from '../../input/agent-workspace-command-editor.ts';
import { submitAgentWorkspaceLocalRegistryEditor } from '../../input/agent-workspace-local-editor-submission.ts';
import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpShellPaths() {
  const root = makeProjectTempDir('goodvibes-editor-routing');
  mkdirSync(root, { recursive: true });
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

function makeWorkspaceContext(
  shellPaths: ReturnType<typeof makeTmpShellPaths>,
): CommandContext {
  return {
    executeCommand: async () => true,
    print: () => {},
    submitInput: async () => {},  // required for hasPromptDispatch()
    workspace: { shellPaths },
  } as unknown as CommandContext;
}

function feedToken(workspace: AgentWorkspace, token: InputToken): void {
  handleAgentWorkspaceToken(workspace, token, () => undefined, () => undefined);
}

function feedText(workspace: AgentWorkspace, value: string): void {
  feedToken(workspace, { type: 'text', value });
}

function feedKey(workspace: AgentWorkspace, logicalName: string): void {
  feedToken(workspace, { type: 'key', name: logicalName, logicalName, ctrl: false, shift: false, meta: false });
}

// ---------------------------------------------------------------------------
// Fix 1 + 3(a): local-model-benchmark routes through command editor, not
// local-registry. Submitting it dispatches a prompt and never creates a
// routine record.
// ---------------------------------------------------------------------------

describe('local-model-benchmark editor routing', () => {
  test('isAgentWorkspaceCommandEditorKind returns true for local-model-benchmark', () => {
    const kind: AgentWorkspaceEditorKind = 'local-model-benchmark';
    expect(isAgentWorkspaceCommandEditorKind(kind)).toBe(true);
  });

  test('submitting local-model-benchmark dispatches a prompt and never creates a routine', () => {
    const shellPaths = makeTmpShellPaths();
    const ctx = makeWorkspaceContext(shellPaths);
    const dispatched: string[] = [];

    const workspace = new AgentWorkspace();
    workspace.open(
      ctx,
      () => {},          // command dispatcher
      undefined,         // no category filter
      (prompt) => dispatched.push(prompt), // prompt dispatcher
    );

    // Open the benchmark editor via the workspace action in the account-model category
    const categoryIndex = workspace.categories.findIndex((c) => c.id === 'account-model');
    expect(categoryIndex).toBeGreaterThanOrEqual(0);
    workspace.selectedCategoryIndex = categoryIndex;
    const actionIndex = workspace.actions.findIndex(
      (a) => a.id === 'account-run-local-model-benchmark',
    );
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    workspace.selectedActionIndex = actionIndex;
    workspace.activateSelected();

    expect(workspace.localEditor?.kind).toBe('local-model-benchmark');

    // Navigate to the confirm field and fill it with 'yes'
    const editor = workspace.localEditor!;
    const confirmIdx = editor.fields.findIndex((f) => f.id === 'confirm');
    expect(confirmIdx).toBeGreaterThanOrEqual(0);

    const currentIdx = workspace.localEditor?.selectedFieldIndex ?? 0;
    for (let i = currentIdx; i < confirmIdx; i += 1) {
      feedKey(workspace, 'tab');
    }
    feedText(workspace, 'yes');
    // Submit: enter on the last field submits the form
    feedKey(workspace, 'enter');

    // A prompt must have been dispatched (model compare uses prompt dispatch)
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]).toContain('agent_model_compare');

    // No routine record must have been created
    const routineCount = AgentRoutineRegistry.fromShellPaths(shellPaths).snapshot().routines.length;
    expect(routineCount).toBe(0);

    // Editor must be cleared (submitted successfully)
    expect(workspace.localEditor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 2 + 3(b): unhandled kind in submitAgentWorkspaceLocalRegistryEditor
// must surface a plain-language error, not silently write a routine.
// ---------------------------------------------------------------------------

describe('local-registry submission: unsupported kind returns error', () => {
  test('submitAgentWorkspaceLocalRegistryEditor throws a clear error for a command-editor kind', () => {
    const shellPaths = makeTmpShellPaths();

    const bogusEditor: AgentWorkspaceLocalEditor = {
      kind: 'local-model-benchmark',
      mode: 'create',
      title: 'Test bogus kind',
      selectedFieldIndex: 0,
      message: '',
      fields: [],
    };

    const created: string[] = [];
    expect(() =>
      submitAgentWorkspaceLocalRegistryEditor(shellPaths, bogusEditor, {
        readField: () => '',
        learnedBehaviorTarget: () => 'skill',
        submitDeleteEditor: () => {},
        finishLocalEditor: (kind) => { created.push(kind); },
        finishProfileEditor: () => {},
      }),
    ).toThrow("This form isn't wired to a save action yet");

    // No routine must be created
    const routineCount = AgentRoutineRegistry.fromShellPaths(
      shellPaths,
    ).snapshot().routines.length;
    expect(routineCount).toBe(0);
    expect(created).toHaveLength(0);
  });

  test('the workspace error catch surfaces the error to localEditor.message', () => {
    // Test that when submitAgentWorkspaceLocalRegistryEditor throws,
    // agent-workspace.ts's try/catch populates localEditor.message.
    // We exercise this by routing a kind through the local-registry path
    // (not a command-editor kind, not memory/setting-set/subscription kinds)
    // with invalid state that causes a throw.
    const shellPaths = makeTmpShellPaths();
    const ctx = makeWorkspaceContext(shellPaths);
    const workspace = new AgentWorkspace();
    workspace.open(ctx, () => {});

    // 'note' is a local-registry kind. Use an update mode with a non-existent
    // record, which will throw from the note registry (record not found).
    const brokenEditor: AgentWorkspaceLocalEditor = {
      kind: 'note',
      mode: 'update',
      recordId: 'nonexistent-id-000',
      title: 'Test Error Surface',
      selectedFieldIndex: 0,
      message: '',
      fields: [
        { id: 'title', label: 'Title', value: 'My Note', required: true, multiline: false, hint: '' },
        { id: 'body', label: 'Body', value: 'test', required: false, multiline: true, hint: '' },
        { id: 'sourceUrl', label: 'Source URL', value: '', required: false, multiline: false, hint: '' },
        { id: 'tags', label: 'Tags', value: '', required: false, multiline: false, hint: '' },
      ],
    };

    // Inject the editor into the workspace's localEditor state.
    // Set selectedFieldIndex to the last field so submitEditorFieldOrForm
    // goes straight to submitLocalEditor instead of advancing the field.
    const lastFieldIdx = brokenEditor.fields.length - 1;
    (workspace as unknown as { localEditor: AgentWorkspaceLocalEditor }).localEditor = {
      ...brokenEditor,
      selectedFieldIndex: lastFieldIdx,
    };

    workspace.submitEditorFieldOrForm();

    // The workspace must have caught the error and reflected it in the editor message
    expect(workspace.localEditor).not.toBeNull();
    expect(workspace.localEditor?.message).toBeTruthy();
    expect(workspace.lastActionResult?.kind).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Fix 3(c): Exhaustiveness, every editorKind for which
// createAgentWorkspaceEditor returns non-null must route to a handled path
// (command-editor or local-registry). None must fall through to the routine
// fallback unless kind === 'routine'.
// ---------------------------------------------------------------------------

describe('editor routing exhaustiveness: no kind reaches routine fallback unexpectedly', () => {
  /**
   * All editorKinds for which createAgentWorkspaceEditor returns non-null.
   * Derived from inspection of agent-workspace-activation.ts.
   */
  const ALL_ROUTABLE_KINDS: readonly AgentWorkspaceEditorKind[] = [
    // Local-registry path (submitAgentWorkspaceLocalRegistryEditor)
    'memory', 'note', 'persona', 'skill', 'routine', 'profile', 'learned-behavior',
    // Knowledge local (createLocalEditor path)
    'knowledge-url',
    // Knowledge query (command-editor via buildAgentKnowledgeUrlEditorSubmission /
    // buildAgentKnowledgeQueryEditorSubmission)
    'knowledge-ask', 'knowledge-search',
    // Web (command-editor)
    'web-research', 'web-fetch',
    // Research (command-editor)
    'research-run', 'research-source', 'research-report',
    // Artifact (command-editor)
    'artifact-browser', 'artifact-show', 'artifact-export-file',
    'artifact-export-package', 'artifact-promote-knowledge',
    // Document (command-editor)
    'document-browse', 'document-show', 'document-create', 'document-update',
    'document-review', 'document-comment', 'document-resolve-comment',
    'document-suggest', 'document-accept-suggestion', 'document-reject-suggestion',
    'document-insert-artifact', 'document-attach-artifact', 'document-export',
    'document-reviewer-readiness', 'document-review-packet-wizard',
    'document-review-packet-preset', 'document-review-packet-preset-refresh',
    'document-review-packet-share',
    // Model compare (command-editor), includes local-model-benchmark (the fixed kind)
    'model-compare', 'local-model-benchmark',
    'model-compare-review', 'model-compare-handoff-diff', 'model-compare-judge',
    'model-compare-apply', 'model-compare-route-decision', 'model-compare-export',
    'model-compare-analytics',
    // Scheduling (command-editor)
    'routine-schedule', 'reminder-schedule',
    // Connect wizards (command-editor), email-connect-wizard is NOT here:
    // it is a direct host-action kind (like subscription-login-*), handled by
    // trySubmitDirectHostActionEditor before this exhaustiveness path.
    'calendar-connect',
  ];

  /**
   * Kinds that are exclusively handled by the local-registry path
   * (submitAgentWorkspaceLocalRegistryEditor) or by dedicated memory/profile
   * paths in agent-workspace.ts. These must NOT appear in
   * isAgentWorkspaceCommandEditorKind.
   *
   * Note: knowledge-url IS in isAgentWorkspaceCommandEditorKind
   * (routes to buildAgentKnowledgeUrlEditorSubmission), even though
   * createAgentWorkspaceEditor creates it via createLocalEditor. The
   * command-editor path handles its submission.
   */
  const LOCAL_REGISTRY_EXCLUSIVE_KINDS = new Set<AgentWorkspaceEditorKind>([
    'note', 'persona', 'skill', 'routine', 'profile', 'learned-behavior',
    // 'memory' is handled by a dedicated memory path before local-registry
    // 'knowledge-url' is handled by the command-editor path (not local-registry)
  ]);

  test('createAgentWorkspaceEditor returns non-null for all listed routable kinds', () => {
    const nullKinds: string[] = [];
    for (const kind of ALL_ROUTABLE_KINDS) {
      const editor = createAgentWorkspaceEditor(kind);
      if (editor === null) nullKinds.push(kind);
    }
    expect(nullKinds).toEqual([]);
  });

  test(
    'every command-submittable routable kind is covered by isAgentWorkspaceCommandEditorKind',
    () => {
      const unhandled: string[] = [];
      for (const kind of ALL_ROUTABLE_KINDS) {
        if (LOCAL_REGISTRY_EXCLUSIVE_KINDS.has(kind)) continue;
        if (kind === 'memory') continue; // dedicated memory path
        if (!isAgentWorkspaceCommandEditorKind(kind)) {
          unhandled.push(kind);
        }
      }
      expect(unhandled).toEqual([]);
    },
  );

  test(
    'no local-registry-exclusive kind leaks into the command-editor guard',
    () => {
      const overlap: string[] = [];
      for (const kind of LOCAL_REGISTRY_EXCLUSIVE_KINDS) {
        if (isAgentWorkspaceCommandEditorKind(kind)) {
          overlap.push(kind);
        }
      }
      expect(overlap).toEqual([]);
    },
  );

  test(
    'submitAgentWorkspaceLocalRegistryEditor handles delete-mode for all local-registry kinds without throwing',
    () => {
      // delete-mode calls submitDeleteEditor callback directly, bypassing the
      // kind-specific branches. This verifies the delete path works for all kinds.
      const shellPaths = makeTmpShellPaths();
      const localKinds: readonly AgentWorkspaceEditorKind[] = [
        'note', 'persona', 'skill', 'routine', 'profile', 'learned-behavior',
      ];

      const failures: string[] = [];
      for (const kind of localKinds) {
        const editor: AgentWorkspaceLocalEditor = {
          kind,
          mode: 'delete',
          recordId: 'test-id',
          title: `Delete ${kind}`,
          selectedFieldIndex: 0,
          message: '',
          fields: [
            { id: 'confirm', label: 'Confirm', value: 'test-id', required: true, multiline: false, hint: '' },
          ],
        };

        let deleteCallbackInvoked = false;
        let threw = false;
        try {
          submitAgentWorkspaceLocalRegistryEditor(shellPaths, editor, {
            readField: (id) => editor.fields.find((f) => f.id === id)?.value ?? '',
            learnedBehaviorTarget: () => 'skill',
            submitDeleteEditor: () => { deleteCallbackInvoked = true; },
            finishLocalEditor: () => {},
            finishProfileEditor: () => {},
          });
        } catch {
          threw = true;
        }

        if (threw || !deleteCallbackInvoked) failures.push(kind);
      }

      expect(failures).toEqual([]);
    },
  );

  test(
    'submitAgentWorkspaceLocalRegistryEditor throws for command-editor kinds that reach it',
    () => {
      const shellPaths = makeTmpShellPaths();
      // These are command-editor kinds, they must never reach the local-registry
      // path in normal operation (isAgentWorkspaceCommandEditorKind routes them
      // earlier). If they somehow reach it, the error must be clear, not silent.
      const commandKinds: AgentWorkspaceEditorKind[] = [
        'local-model-benchmark',
        'model-compare',
        'web-research',
        'knowledge-search',
      ];

      for (const kind of commandKinds) {
        const editor: AgentWorkspaceLocalEditor = {
          kind,
          mode: 'create',
          title: 'Bogus',
          selectedFieldIndex: 0,
          message: '',
          fields: [],
        };

        expect(() =>
          submitAgentWorkspaceLocalRegistryEditor(shellPaths, editor, {
            readField: () => '',
            learnedBehaviorTarget: () => 'skill',
            submitDeleteEditor: () => {},
            finishLocalEditor: () => {},
            finishProfileEditor: () => {},
          }),
        ).toThrow("This form isn't wired to a save action yet");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Fix 5: settingKey exhaustiveness, every settingKey used in workspace
// categories must resolve against the actual Agent instance schema.
// ---------------------------------------------------------------------------

describe('settingKey exhaustiveness against the Agent instance schema', () => {
  function collectSettingKeys(
    categories: readonly { readonly actions: readonly { readonly settingKey?: string }[] }[],
  ): string[] {
    const keys: string[] = [];
    for (const category of categories) {
      for (const action of category.actions) {
        if (action.settingKey) keys.push(action.settingKey);
      }
    }
    return keys;
  }

  test(
    'every settingKey in AGENT_WORKSPACE_CATEGORIES resolves in the real Agent instance schema',
    () => {
      const config = new AgentConfigManager({ configDir: makeProjectTempDir('agent-settings-schema'), readOnly: true });
      const schemaKeys = new Set<string>(getAgentSettingsSchema(config).map((s) => s.key));
      const keys = collectSettingKeys(AGENT_WORKSPACE_CATEGORIES);
      const failures = keys.filter(
        (k) => !schemaKeys.has(k),
      );
      expect(failures).toEqual([]);
    },
  );

  test(
    'every settingKey in AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES resolves in the real Agent instance schema',
    () => {
      const config = new AgentConfigManager({ configDir: makeProjectTempDir('agent-settings-schema'), readOnly: true });
      const schemaKeys = new Set<string>(getAgentSettingsSchema(config).map((s) => s.key));
      const keys = collectSettingKeys(AGENT_WORKSPACE_ONBOARDING_DETAIL_CATEGORIES);
      const failures = keys.filter(
        (k) => !schemaKeys.has(k),
      );
      expect(failures).toEqual([]);
    },
  );
});
