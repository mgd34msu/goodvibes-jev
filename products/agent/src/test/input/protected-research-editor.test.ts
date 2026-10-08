import { afterAll, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import { createAgentResearchReportEditor } from '../../input/agent-workspace-research-report-editor.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';
afterAll(cleanupResearchScreeningFixtures);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { for (let i = 0; i < 400 && !predicate(); i++) await Bun.sleep(5); expect(predicate()).toBe(true); }
function workspaceFixture(owner?: ReturnType<typeof researchScreeningFixture>['owner']) {
  const root = makeProjectTempDir('protected-research-editor');
  const registry = new ToolRegistry(); if (owner) bindAgentResearchSourceOwner(registry, owner);
  const context = { workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    extensions: { toolRegistry: registry }, submitInput() {}, platform: {} } as unknown as CommandContext;
  const workspace = new AgentWorkspace(), prompts: string[] = [];
  workspace.open(context, () => {}, undefined, prompt => { prompts.push(prompt); });
  const original = createAgentResearchReportEditor();
  const fields: Record<string, string> = { title: 'Report', question: 'What is supported?', summary: 'Before synthetic-private after [S1].', sources: 'Source | https://example.test/doc?id=123#anchor | high | Ordinary first line.', confirm: 'yes' };
  const editor = { ...original, selectedFieldIndex: original.fields.length - 1, fields: original.fields.map(field => ({ ...field, value: fields[field.id] ?? field.value })) };
  workspace.localEditor = editor;
  return { workspace, prompts, context, editor };
}

test('real workspace awaits immutable screening and repeated Submit dispatches once', async () => {
  const started = deferred(), gate = deferred();
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private']), beforeProposal: async () => { started.resolve(); await gate.promise; } });
  const { workspace, prompts } = workspaceFixture(f.owner);
  workspace.submitEditorFieldOrForm(); await started.promise;
  workspace.submitEditorFieldOrForm();
  expect(prompts).toEqual([]); expect(f.calls).toHaveLength(1);
  gate.resolve(); await until(() => prompts.length === 1);
  expect(prompts[0]).not.toContain('synthetic-private'); expect(prompts[0]).toContain('Before [redacted] after [S1]');
  expect(prompts[0]).toContain('https://example.test/doc?id=123#anchor'); expect(workspace.localEditor).toBeNull();
});

for (const change of ['edit', 'cancel', 'close', 'reopen', 'replace-editor'] as const) {
  test(`pending research ${change} cannot dispatch or restore stale editor state`, async () => {
    const started = deferred(), gate = deferred();
    const f = researchScreeningFixture({ beforeProposal: async () => { started.resolve(); await gate.promise; } });
    const { workspace, prompts, context } = workspaceFixture(f.owner);
    workspace.submitEditorFieldOrForm(); await started.promise;
    if (change === 'edit') workspace.appendEditorText(' changed');
    if (change === 'cancel') workspace.cancelLocalEditor();
    if (change === 'close') workspace.close();
    if (change === 'reopen') workspace.open({ ...context }, () => {}, undefined, prompt => prompts.push(prompt));
    if (change === 'replace-editor') workspace.localEditor = createAgentResearchReportEditor();
    const editorAfter = workspace.localEditor, statusAfter = workspace.status;
    gate.resolve(); await Bun.sleep(75);
    expect(prompts).toEqual([]); expect(workspace.localEditor).toBe(editorAfter); expect(workspace.status).toBe(statusAfter);
  });
}

test('no live owner produces a useful held editor without dispatch', async () => {
  const { workspace, prompts } = workspaceFixture(); workspace.submitEditorFieldOrForm();
  await until(() => workspace.status.includes('trusted local screening owner'));
  expect(prompts).toEqual([]); expect(workspace.localEditor?.kind).toBe('research-report');
});
