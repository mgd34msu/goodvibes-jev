import { describe, it, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

// ---------------------------------------------------------------------------
// Tool preview tests
// ---------------------------------------------------------------------------

describe('tool preview truncation', () => {
  it('UIFactory.createToolPreviewRow draws the tool preview as one row (the spinner lives on the status line)', () => {
    const width = 80;
    const toolPreview = 'read_file({"path":"/home/user/test.ts"})';
    const row = UIFactory.createToolPreviewRow(width, toolPreview);
    expect(row).toHaveLength(width);
    const text = row.map((c) => c.char).join('');
    expect(text).toContain('read_file');
  });

  it('tool preview display width does not exceed terminal width', () => {
    const width = 40;
    const longPreview = 'some_tool(' + 'a'.repeat(100) + ')';
    const previewLine = UIFactory.createToolPreviewRow(width, longPreview);
    // The preview line should not exceed width cells
    expect(previewLine).toHaveLength(width);
    // Compute display width of non-space content
    const text = previewLine.map((c) => c.char).join('');
    const displayW = getDisplayWidth(text.trimEnd());
    expect(displayW).toBeLessThanOrEqual(width);
  });
});
