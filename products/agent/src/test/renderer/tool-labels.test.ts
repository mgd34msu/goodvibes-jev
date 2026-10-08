import { describe, expect, test } from 'bun:test';
import { friendlyToolLabel, TOOL_LABELS_CATALOG } from '../../renderer/tool-labels.ts';

describe('tool label selection', () => {
  test('uses the registered label for both local and namespaced tool IDs', () => {
    for (const [id, label] of Object.entries(TOOL_LABELS_CATALOG)) {
      expect(friendlyToolLabel(id)).toBe(label);
      expect(friendlyToolLabel(`mcp__fixture__${id}`)).toBe(label);
    }
  });

  test.each([
    ['some_new_uncurated_tool', 'Some new uncurated tool'],
    ['agent_new-tool', 'New tool'],
    ['mcp__fixture__unknown_tool', 'Unknown tool'],
  ])('humanizes the unregistered tool ID %s', (id, label) => {
    expect(friendlyToolLabel(id)).toBe(label);
  });
});
