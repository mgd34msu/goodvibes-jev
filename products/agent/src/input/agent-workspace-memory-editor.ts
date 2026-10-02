import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryClass, MemoryRecord, MemoryScope } from '@goodvibes-jev/engine/sdk/platform/state';
import { assertNoSecretLikeMemoryText } from '../agent/memory-safety.ts';
import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { splitList } from './agent-workspace-editors.ts';
import { isValidClass, isValidScope } from './commands/recall-shared.ts';

export type AgentWorkspaceEditorFieldReader = (id: string) => string;

export interface AgentWorkspaceMemoryEditorResult {
  readonly record: MemoryRecord;
  readonly verb: 'Created' | 'Updated';
}

export interface AgentWorkspaceMemoryDeleteResult {
  readonly id: string;
  readonly name: string;
}

export async function submitAgentWorkspaceMemoryEditor(
  editor: AgentWorkspaceLocalEditor,
  memory: MemoryApi,
  readField: AgentWorkspaceEditorFieldReader,
): Promise<AgentWorkspaceMemoryEditorResult> {
  if (editor.mode === 'update' && editor.recordId) {
    const scope = parseMemoryScope(readField('scope'));
    const summary = readField('summary');
    const detail = readField('detail');
    const tags = splitList(readField('tags'));
    assertNoSecretLikeMemoryText([summary, detail, ...tags]);
    const updated = memory.update(editor.recordId, {
      scope,
      summary,
      detail: detail.length > 0 ? detail : undefined,
      tags,
    });
    if (!updated) throw new Error(`Unknown Agent memory ${editor.recordId}`);
    return { record: updated, verb: 'Updated' };
  }

  const cls = parseMemoryClass(readField('cls'));
  const scope = parseMemoryScope(readField('scope'));
  const summary = readField('summary');
  const detail = readField('detail');
  const tags = splitList(readField('tags'));
  const confidence = parseMemoryConfidence(readField('confidence'));
  assertNoSecretLikeMemoryText([summary, detail, ...tags]);
  const record = await memory.add({
    cls,
    scope,
    summary,
    detail: detail.length > 0 ? detail : undefined,
    tags,
    review: {
      state: 'fresh',
      confidence,
    },
  });
  return { record, verb: 'Created' };
}

export function deleteAgentWorkspaceMemoryEditor(
  editor: AgentWorkspaceLocalEditor,
  confirmedId: string,
  memory: MemoryApi,
): AgentWorkspaceMemoryDeleteResult | null {
  const expectedId = editor.recordId ?? '';
  if (!expectedId || confirmedId !== expectedId) return null;
  const removed = memory.delete(expectedId);
  if (!removed) throw new Error(`Unknown Agent memory ${expectedId}`);
  return { id: expectedId, name: expectedId };
}

function parseMemoryClass(value: string): MemoryClass {
  if (!isValidClass(value)) throw new Error(`Invalid memory class "${value}".`);
  return value;
}

function parseMemoryScope(value: string): MemoryScope {
  if (!isValidScope(value)) throw new Error(`Invalid memory scope "${value}".`);
  return value;
}

function parseMemoryConfidence(value: string): number {
  const parsed = value.trim().length === 0 ? 80 : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) throw new Error('Memory confidence must be an integer from 0 to 100.');
  return parsed;
}
