/**
 * agent-workspace-editor-rows.ts, the rows of an open Agent workspace form:
 * the form's title and message, then each field (label, value, hint, all
 * wrapped in full) windowed by the rows each really takes so the selected
 * field stays in view, with honest more-above / more-below markers.
 */

import type { AgentWorkspaceLocalEditor } from '../input/agent-workspace.ts';
import { wrapText } from '../utils/terminal-width.ts';
import { GLYPHS } from './ui-primitives.ts';
import { WORKSPACE_PALETTE as PALETTE, type WorkspaceRow } from './fullscreen-workspace.ts';

export function buildEditorRows(editor: AgentWorkspaceLocalEditor, width: number, height: number): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [
    { text: editor.title, fg: PALETTE.title, bold: true },
    { text: editor.message, fg: PALETTE.info },
    { text: '' },
  ];
  const footerRows: WorkspaceRow[] = [
    { text: '' },
    { text: 'Enter next/save · Up/Down field · Backspace edit · Ctrl-J newline · Esc cancel', fg: PALETTE.muted },
  ];
  // Window the fields by the rows each really takes (values and hints wrap),
  // keeping the selected field in view and room for the two more markers.
  const fieldRows = editor.fields.map((_, index) => buildEditorFieldRows(editor, index, width));
  const budget = Math.max(1, height - rows.length - footerRows.length - 2);
  let start = Math.min(editor.selectedFieldIndex, Math.max(0, editor.fields.length - 1));
  let used = fieldRows[start]?.length ?? 0;
  let end = start + 1;
  while (end < fieldRows.length && used + fieldRows[end]!.length <= budget) used += fieldRows[end++]!.length;
  while (start > 0 && used + fieldRows[start - 1]!.length <= budget) used += fieldRows[--start]!.length;
  if (start > 0) rows.push({ text: `${GLYPHS.navigation.moreAbove} ${start} more field(s) above`, kind: 'more', fg: PALETTE.dim, dim: true });
  for (let index = start; index < end; index += 1) rows.push(...fieldRows[index]!);
  if (end < editor.fields.length) rows.push({ text: `${GLYPHS.navigation.moreBelow} ${editor.fields.length - end} more field(s) below`, kind: 'more', fg: PALETTE.dim, dim: true });
  rows.push(...footerRows);
  while (rows.length < height) rows.push({ text: '', kind: 'empty' });
  return rows.slice(0, height);
}

function buildEditorFieldRows(editor: AgentWorkspaceLocalEditor, index: number, width: number): WorkspaceRow[] {
  const field = editor.fields[index]!;
  const selected = index === editor.selectedFieldIndex;
  const marker = selected ? GLYPHS.navigation.selected : ' ';
  const required = field.required ? ' *' : '';
  const value = field.value.length > 0
    ? field.redact ? '*'.repeat(Math.min(12, Math.max(6, Array.from(field.value).length))) : field.value
    : '(empty)';
  const color = selected ? PALETTE.text : field.value.length > 0 ? PALETTE.info : PALETTE.muted;
  const rows: WorkspaceRow[] = [{
    text: `${marker} ${field.label}${required}`,
    selected,
    fg: color,
    bold: selected,
  }];
  const valueLines = value.split('\n');
  for (const valueLine of valueLines.slice(0, 4)) {
    for (const wrapped of wrapText(`  ${valueLine}`, Math.max(1, width - 2))) {
      rows.push({ text: wrapped, fg: field.value.length > 0 ? PALETTE.text : PALETTE.dim, dim: field.value.length === 0 });
    }
  }
  if (valueLines.length > 4) rows.push({ text: `  ${valueLines.length - 4} more line(s)`, fg: PALETTE.dim, dim: true });
  for (const hint of wrapText(field.hint, Math.max(1, width - 2))) rows.push({ text: `  ${hint}`, fg: PALETTE.dim, dim: true });
  return rows;
}
