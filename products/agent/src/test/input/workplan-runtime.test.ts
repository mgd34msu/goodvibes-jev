import { expect, test } from 'bun:test';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createAgentWorkspaceBasicCommandEditor } from '../../input/agent-workspace-basic-command-editors.ts';
import { buildAgentWorkspaceWorkPlanEditorSubmission } from '../../input/agent-workspace-workplan-editor-submission.ts';
import { parseSlashCommand } from '../../input/slash-command-parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const store = new WorkPlanStore({ homeDirectory: makeProjectTempDir('workplan-command'), surfaceRoot: '.agent', projectId: 'project', projectRoot: '/tmp/project' });
  const registry = new CommandRegistry(); registerBuiltinCommands(registry);
  const printed: string[] = [], nativeCalls: string[] = [];
  const ctx = { workspace: { workPlanStore: store }, print: (text: string) => printed.push(text), nativeWorkLedger: {
    submitFile: async (path: string) => { nativeCalls.push(`submit:${path}`); return { status: 'unavailable', message: 'Fixture has no owner pairing; no submission.' }; },
    submissionStatus: async () => { nativeCalls.push('status'); return { status: 'unknown', message: 'Retained original identity is unresolved.' }; },
    retrySubmission: async () => { nativeCalls.push('retry'); return { status: 'unavailable', message: 'Fixture cannot recover.' }; },
    execute: async () => { throw new Error('Local todos and source submission must not execute native work'); },
  } } as unknown as CommandContext;
  const run = async (command: string) => { const parsed = parseSlashCommand(command); expect(await registry.execute(parsed.name, [...parsed.args], ctx)).toBe(true); };
  const edit = async (kind: Parameters<typeof createAgentWorkspaceBasicCommandEditor>[0], fields: Record<string, string>) => {
    const editor = createAgentWorkspaceBasicCommandEditor(kind);
    const result = buildAgentWorkspaceWorkPlanEditorSubmission(editor, id => fields[id] ?? '');
    expect(result.kind).toBe('dispatch');
    if (result.kind === 'dispatch') await run(result.command);
  };
  return { store, printed, nativeCalls, run, edit };
}

test('workspace editors reach registered local commands without creating or executing native work', async () => {
  const f = fixture();
  await f.edit('workplan-add', { title: 'Check "quoted" item\nsecond line', owner: 'Mike', source: 'manual', notes: 'Keep original notes' });
  const item = f.store.listItems()[0]!;
  expect(item.title).toBe('Check "quoted" item\nsecond line'); expect(item.status).toBe('pending');
  expect(item.notes).toBe('Keep original notes');
  for (const status of ['start', 'blocked', 'done']) await f.edit('workplan-status', { id: item.id, status });
  expect(f.store.listItems()[0]?.status).toBe('done');
  await f.edit('workplan-show', {}); await f.edit('workplan-show', { format: 'markdown' });
  expect(f.printed.join('\n')).toContain('local done is not native verified completion');
  expect(f.nativeCalls).toEqual([]);
  await f.edit('workplan-clear-completed', { confirm: 'yes' }); expect(f.store.listItems()).toEqual([]);
  await f.edit('workplan-add', { title: 'Second todo' });
  await f.edit('workplan-delete', { id: f.store.listItems()[0]!.id, confirm: 'yes' });
  expect(f.store.listItems()).toEqual([]); expect(f.nativeCalls).toEqual([]);
});

test('native owner aliases share source-file and journal routes, never todo labels or execution', async () => {
  const f = fixture();
  await f.run('/workplan add "Untrusted title" --owner owner --source direct-owner');
  const before = f.store.listItems();
  await f.run('/workplan submit-file "exact source.json"');
  await f.run('/workplan submission-status'); await f.run('/workplan submission-retry');
  expect(f.nativeCalls).toEqual(['submit:exact source.json', 'status', 'retry']);
  expect(f.store.listItems()).toEqual(before);
  expect(f.printed.join('\n')).toContain('no owner pairing');
  expect(f.printed.join('\n')).toContain('unresolved');
});

test('malformed and unconfirmed commands have no effects', async () => {
  const f = fixture();
  await f.run('/workplan add Existing'); const before = f.store.listItems();
  for (const command of ['add Bad --execute yes', 'add Bad --owner x --owner y', 'add Bad --notes', 'remove '+before[0]!.id, 'clear-completed', 'done '+before[0]!.id+' extra', 'dispatch_agents', 'submit-file', 'submission-retry extra']) await f.run('/workplan '+command);
  expect(f.store.listItems()).toEqual(before); expect(f.nativeCalls).toEqual([]);
});
