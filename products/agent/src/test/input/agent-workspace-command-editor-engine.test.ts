/**
 * Spec-pin tests for the agent-workspace "command editor" domains consolidated onto
 * the shared engine (agent-workspace-command-editor-engine.ts).
 *
 * These pin a representative sample of each of the 12 domains' rendered editor
 * fields/defaults and dispatched command strings so a future change to the shared
 * engine or a domain's data table cannot silently change what gets rendered or what
 * command gets dispatched. Full before/after byte-identity across every kind in every
 * domain (98 kinds x 2 field scenarios) was additionally verified against the
 * pre-consolidation implementation during the migration to the shared engine; this file is the
 * permanent regression guard that lands with it.
 */
import { describe, expect, test } from 'bun:test';
import { createAgentWorkspaceAccessCommandEditor } from '../../input/agent-workspace-access-command-editors.ts';
import { buildAgentWorkspaceAccessCommandEditorSubmission } from '../../input/agent-workspace-access-command-editor-submission.ts';
import { createAgentWorkspaceChannelCommandEditor } from '../../input/agent-workspace-channel-command-editors.ts';
import { buildAgentWorkspaceChannelCommandEditorSubmission } from '../../input/agent-workspace-channel-command-editor-submission.ts';
import { createAgentWorkspaceKnowledgeCommandEditor } from '../../input/agent-workspace-knowledge-command-editors.ts';
import { buildAgentWorkspaceKnowledgeCommandEditorSubmission } from '../../input/agent-workspace-knowledge-command-editor-submission.ts';
import { createAgentWorkspaceLibraryCommandEditor } from '../../input/agent-workspace-library-command-editors.ts';
import { buildAgentWorkspaceLibraryCommandEditorSubmission } from '../../input/agent-workspace-library-command-editor-submission.ts';
import { createAgentWorkspaceMcpCommandEditor } from '../../input/agent-workspace-mcp-command-editors.ts';
import { buildAgentWorkspaceMcpCommandEditorSubmission } from '../../input/agent-workspace-mcp-command-editor-submission.ts';
import { createAgentWorkspaceMediaCommandEditor } from '../../input/agent-workspace-media-command-editors.ts';
import { buildAgentWorkspaceMediaCommandEditorSubmission } from '../../input/agent-workspace-media-command-editor-submission.ts';
import { createAgentWorkspaceMemoryCommandEditor } from '../../input/agent-workspace-memory-command-editors.ts';
import { buildAgentWorkspaceMemoryCommandEditorSubmission } from '../../input/agent-workspace-memory-command-editor-submission.ts';
import { createAgentWorkspaceOperationsCommandEditor } from '../../input/agent-workspace-operations-command-editors.ts';
import { buildAgentWorkspaceOperationsCommandEditorSubmission } from '../../input/agent-workspace-operations-command-editor-submission.ts';
import { createAgentWorkspaceProviderCommandEditor } from '../../input/agent-workspace-provider-command-editors.ts';
import { buildAgentWorkspaceProviderCommandEditorSubmission } from '../../input/agent-workspace-provider-command-editor-submission.ts';
import { createAgentWorkspaceSessionCommandEditor } from '../../input/agent-workspace-session-command-editors.ts';
import { buildAgentWorkspaceSessionCommandEditorSubmission } from '../../input/agent-workspace-session-command-editor-submission.ts';
import { createAgentWorkspaceSkillBundleCommandEditor } from '../../input/agent-workspace-skill-bundle-command-editors.ts';
import { buildAgentWorkspaceSkillBundleCommandEditorSubmission } from '../../input/agent-workspace-skill-bundle-command-editor-submission.ts';
import { createAgentWorkspaceTaskCommandEditor } from '../../input/agent-workspace-task-command-editors.ts';
import { buildAgentWorkspaceTaskCommandEditorSubmission } from '../../input/agent-workspace-task-command-editor-submission.ts';
import { createAgentWorkspaceBasicCommandEditor, buildAgentWorkspaceBasicCommandEditorSubmission } from '../../input/agent-workspace-basic-command-editors.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';

function reader(overrides: Record<string, string>): (fieldId: string) => string {
  return (fieldId) => overrides[fieldId] ?? '';
}

describe('command-editor engine: access domain', () => {
  test('auth-show renders a single required provider field', () => {
    const editor = createAgentWorkspaceAccessCommandEditor('auth-show');
    expect(editor.mode).toBe('create');
    expect(editor.title).toBe('Inspect Provider Auth');
    expect(editor.fields).toEqual([
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Provider id, such as openai.' },
    ]);
  });

  test('auth-show dispatches a read-only /auth show command', () => {
    const editor = createAgentWorkspaceAccessCommandEditor('auth-show');
    const submission = buildAgentWorkspaceAccessCommandEditorSubmission(editor, reader({ provider: 'anthropic' }));
    expect(submission).toEqual({
      kind: 'dispatch',
      command: '/auth show anthropic',
      status: 'Opening provider auth inspection.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening provider auth inspection',
        detail: 'The workspace handed a read-only provider auth inspection command to the shell-owned command router.',
        command: '/auth show anthropic',
        safety: 'read-only',
      },
    });
  });

  test('voice-enable and voice-disable share one dynamic spec but differ in wording', () => {
    const enable = createAgentWorkspaceAccessCommandEditor('voice-enable');
    const disable = createAgentWorkspaceAccessCommandEditor('voice-disable');
    expect(enable.title).toBe('Enable Voice Interaction');
    expect(disable.title).toBe('Disable Voice Interaction');
    expect(enable.fields[0]?.hint).toBe('Type yes to run /voice enable with --yes.');
    expect(disable.fields[0]?.hint).toBe('Type yes to run /voice disable with --yes.');
  });

  test('auth-bundle-export blocks on an unconfirmed field (access uses the full-message echo convention: status equals the in-editor message, unlike memory/provider below)', () => {
    const editor = createAgentWorkspaceAccessCommandEditor('auth-bundle-export');
    const submission = buildAgentWorkspaceAccessCommandEditorSubmission(editor, reader({ path: 'out.json' }));
    expect(submission.kind).toBe('editor');
    expect(submission.status).toBe('Auth review bundle export not confirmed. Type yes, then press Enter.');
  });
});

describe('command-editor engine: memory domain', () => {
  test('memory-search builds optional flags only when fields are filled', () => {
    const editor = createAgentWorkspaceMemoryCommandEditor('memory-search');
    const blank = buildAgentWorkspaceMemoryCommandEditorSubmission(editor, reader({}));
    expect(blank.kind === 'dispatch' && blank.command).toBe('/memory search');

    const filled = buildAgentWorkspaceMemoryCommandEditorSubmission(
      editor,
      reader({ query: 'hello', scope: 'project', class: 'fact', limit: '5', semantic: 'yes' }),
    );
    expect(filled.kind === 'dispatch' && filled.command).toBe('/memory search hello --scope project --cls fact --limit 5 --semantic');
  });

  test('memory-promote requires confirmation before dispatching', () => {
    const editor = createAgentWorkspaceMemoryCommandEditor('memory-promote');
    const unconfirmed = buildAgentWorkspaceMemoryCommandEditorSubmission(editor, reader({ id: 'm1', scope: 'team' }));
    expect(unconfirmed.kind).toBe('editor');
    expect(unconfirmed.status).toBe('Memory promotion not confirmed.');

    const confirmed = buildAgentWorkspaceMemoryCommandEditorSubmission(editor, reader({ id: 'm1', scope: 'team', confirm: 'yes' }));
    expect(confirmed.kind === 'dispatch' && confirmed.command).toBe('/memory promote m1 team --yes');
  });
});

describe('command-editor engine: provider domain (redacted-secret exception)', () => {
  test('provider-add dispatches the real key but redacts it in the actionResult.command', () => {
    const editor = createAgentWorkspaceProviderCommandEditor('provider-add');
    const submission = buildAgentWorkspaceProviderCommandEditorSubmission(
      editor,
      reader({ name: 'local', baseUrl: 'http://localhost:8000/v1', apiKey: 'sk-super-secret', confirm: 'yes' }),
    );
    expect(submission.kind).toBe('dispatch');
    if (submission.kind !== 'dispatch') throw new Error('unreachable');
    expect(submission.command).toBe('/provider add local http://localhost:8000/v1 sk-super-secret --yes');
    expect(submission.actionResult.command).toBe('/provider add local http://localhost:8000/v1 <redacted-api-key> --yes');
  });
});

describe('command-editor engine: mcp domain (construction delegated out of the basic assembler)', () => {
  test('mcp-server construction and submission round-trip through the dedicated mcp module', () => {
    const editor = createAgentWorkspaceMcpCommandEditor('mcp-server');
    expect(editor.title).toBe('Add MCP Server');
    const submission = buildAgentWorkspaceMcpCommandEditorSubmission(
      editor,
      reader({ name: 'fs', command: 'bunx', confirm: 'yes' }),
    );
    expect(submission.kind === 'dispatch' && submission.command).toBe('/mcp add fs bunx --yes');
  });

  test('the basic assembler still delegates mcp-server construction to the mcp module (no regression from the extraction)', () => {
    const viaBasic = createAgentWorkspaceBasicCommandEditor('mcp-server');
    const viaMcp = createAgentWorkspaceMcpCommandEditor('mcp-server');
    expect(viaBasic).toEqual(viaMcp);
  });
});

describe('command-editor engine: basic assembler own-kind data table', () => {
  test('knowledge-bookmarks (a basic-owned kind, not a delegated domain) still round-trips', () => {
    const editor = createAgentWorkspaceBasicCommandEditor('knowledge-bookmarks');
    expect(editor.title).toBe('Import Bookmarks into Agent Knowledge');
    const submission = buildAgentWorkspaceBasicCommandEditorSubmission(
      editor,
      reader({ path: 'bookmarks.html', confirm: 'yes' }),
      true,
    );
    expect(submission.kind === 'dispatch' && submission.command).toBe('/knowledge import-bookmarks bookmarks.html --yes');
  });

  test('command-dispatch-unavailable gate still short-circuits before the own-kind table', () => {
    const editor = createAgentWorkspaceBasicCommandEditor('knowledge-bookmarks');
    const submission = buildAgentWorkspaceBasicCommandEditorSubmission(editor, reader({}), false);
    expect(submission.kind).toBe('editor');
    expect(submission.status).toBe('Command dispatch unavailable.');
  });

  test('model-pin and model-unpin share one dynamic spec/handler pair', () => {
    const pin = createAgentWorkspaceBasicCommandEditor('model-pin');
    const unpin = createAgentWorkspaceBasicCommandEditor('model-unpin');
    expect(pin.title).toBe('Pin Model');
    expect(unpin.title).toBe('Unpin Model');
    const pinSubmission = buildAgentWorkspaceBasicCommandEditorSubmission(pin, reader({ model: 'openai:gpt-5.5' }), true);
    const unpinSubmission = buildAgentWorkspaceBasicCommandEditorSubmission(unpin, reader({ model: 'openai:gpt-5.5' }), true);
    expect(pinSubmission.kind === 'dispatch' && pinSubmission.command).toBe('/pin openai:gpt-5.5');
    expect(unpinSubmission.kind === 'dispatch' && unpinSubmission.command).toBe('/unpin openai:gpt-5.5');
  });
});

describe('command-editor engine: remaining domains render and dispatch', () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly editor: AgentWorkspaceLocalEditor;
    readonly submit: (editor: AgentWorkspaceLocalEditor, readField: (id: string) => string) => { kind: string; command?: string };
    readonly fields: Record<string, string>;
    readonly expectCommand: string;
  }> = [
    {
      label: 'channel-doctor',
      editor: createAgentWorkspaceChannelCommandEditor('channel-doctor'),
      submit: buildAgentWorkspaceChannelCommandEditorSubmission,
      fields: { channel: 'slack' },
      expectCommand: '/channels doctor slack',
    },
    {
      label: 'knowledge-get',
      editor: createAgentWorkspaceKnowledgeCommandEditor('knowledge-get'),
      submit: buildAgentWorkspaceKnowledgeCommandEditorSubmission,
      fields: { id: 'k1' },
      expectCommand: '/knowledge get k1',
    },
    {
      label: 'skill-search',
      editor: createAgentWorkspaceLibraryCommandEditor('skill-search'),
      submit: buildAgentWorkspaceLibraryCommandEditorSubmission,
      fields: { query: 'deploy' },
      expectCommand: '/skills search deploy',
    },
    {
      label: 'media-generate',
      editor: createAgentWorkspaceMediaCommandEditor('media-generate'),
      submit: buildAgentWorkspaceMediaCommandEditorSubmission,
      fields: { prompt: 'a cat', confirm: 'yes' },
      expectCommand: '/media generate "a cat" --yes',
    },
    {
      label: 'plan-seed',
      editor: createAgentWorkspaceOperationsCommandEditor('plan-seed'),
      submit: buildAgentWorkspaceOperationsCommandEditorSubmission,
      fields: { goal: 'ship it' },
      expectCommand: '/plan "ship it"',
    },
    {
      label: 'session-rename',
      editor: createAgentWorkspaceSessionCommandEditor('session-rename'),
      submit: buildAgentWorkspaceSessionCommandEditorSubmission,
      fields: { name: 'renamed' },
      expectCommand: '/session rename renamed',
    },
    {
      label: 'skill-bundle-show',
      editor: createAgentWorkspaceSkillBundleCommandEditor('skill-bundle-show'),
      submit: buildAgentWorkspaceSkillBundleCommandEditorSubmission,
      fields: { id: 'b1' },
      expectCommand: '/skills bundle show b1',
    },
    {
      label: 'task-output',
      editor: createAgentWorkspaceTaskCommandEditor('task-output'),
      submit: buildAgentWorkspaceTaskCommandEditorSubmission,
      fields: { taskId: 't1' },
      expectCommand: '/tasks output t1',
    },
  ];

  for (const testCase of cases) {
    test(`${testCase.label} dispatches the expected command`, () => {
      const submission = testCase.submit(testCase.editor, reader(testCase.fields));
      expect(submission.kind).toBe('dispatch');
      expect(submission.command).toBe(testCase.expectCommand);
    });
  }
});
