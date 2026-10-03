import { describe, expect, mock, test } from 'bun:test';
import { handleBlockSave } from '../../input/handler-content-actions.ts';
import type { ConversationManager } from '../../core/conversation.ts';
import type { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';

describe('block save Agent policy', () => {
  test('blocks implicit Ctrl-S file writes and does not call saveToFile', () => {
    const logged: string[] = [];
    const conversationManager = {
      getBlockContentAtLine: () => 'assistant block content',
      log: (message: string) => {
        logged.push(message);
      },
    } as unknown as ConversationManager;
    const saveToFile = mock(() => '/tmp/should-not-exist.md');
    const bookmarkManager = {
      toggle: () => true,
      isBookmarked: () => false,
      list: () => [],
      clear: () => {},
      saveToFile,
      listSavedFiles: () => [],
      loadSavedFile: () => null,
    } as unknown as BookmarkManager;
    const requestRender = mock(() => {});

    handleBlockSave(conversationManager, () => 0, requestRender, bookmarkManager);

    expect(saveToFile).toHaveBeenCalledTimes(0);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(logged.join('\n')).toContain('Block file save is disabled in GoodVibes Agent');
    expect(logged.join('\n')).toContain('/export markdown <path> --yes');
    expect(logged.join('\n')).not.toContain('/share');
  });
});
