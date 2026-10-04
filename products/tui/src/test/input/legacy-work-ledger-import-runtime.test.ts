import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTuiLegacyImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';

test('actual TUI keyboard route and direct tool registry both permit protected read status', async () => {
  const lines: string[] = []; const calls: string[] = []; const registry = new CommandRegistry();
  registerTuiLegacyImportCommands(registry, undefined, async () => ({
    binding: { endpoint: 'http://synthetic-host', projectId: 'project', workspaceId: '/workspace', principalKind: 'user', principalId: 'authenticated' },
    status: async () => { calls.push('status'); return null; },
    prepare: async () => ({ kind: 'blocked', code: 'invalid-source', reason: 'Synthetic test does not prepare' }), dispose() {},
  }));
  const context = { print: (line: string) => lines.push(line), workspace: {} } as unknown as CommandContext;
  await registry.execute('work-import', ['status', 'project'], context); expect(lines[0]).toContain('No saved legacy import for selected project.');
  expect(lines[0]?.split('\n')[0]).toBe('No saved legacy import for selected project.');
  const state: CommandModeRouteState = { commandMode: true, prompt: '/work-import status project', cursorPos: 0, autocomplete: null, modalStack: ['command'], commandRegistry: registry, commandContext: context, conversationManager: null, requestRender() {}, handleEscape() {}, projectRoot: '/workspace', pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 1, nextImageId: 1, saveUndoState() {}, ensureInputCursorVisible() {} };
  expect(handleCommandModeToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false })).toBe(true);
  const deadline = Date.now() + 2000; while (lines.length < 2 && Date.now() < deadline) await Bun.sleep(1);
  expect(lines[1]).toContain('No saved legacy import for selected project.'); expect(calls).toEqual(['status', 'status']);
});
