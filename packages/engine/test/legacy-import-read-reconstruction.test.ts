import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLegacyImportOperator } from '../terminal-shell/src/legacy-work-ledger-import-operator.js';
import { prepareLegacyWorkLedgerMigration } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
import fixture from '../../../products/agent/src/test/fixtures/legacy-ledger/preparation.json';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'import-read-')); roots.push(root);
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  let auth = { authenticated: true, admin: true, principalId: 'actual-principal', principalKind: 'user', scopes: ['read:work-ledger', 'read:knowledge'] };
  const calls: string[] = [];
  let pages: (input: Record<string, unknown>) => unknown = input => input.cursor ? { items: fixture.sources.slice(1).map(item => item.source), hasMore: false } : { items: [fixture.sources[0]!.source], hasMore: true, nextCursor: 'next' };
  const open = () => openLegacyImportOperator({ projectId: fixture.projectId, journalPath: join(root, 'journal.sqlite'), resolve: () => ({ baseUrl: 'http://host', token: 'synthetic-secret', workspace: root }),
    createClient: () => ({ currentAuth: async () => auth, dispose() {}, invoke: async (method, input) => { calls.push(method); if (method === 'knowledge.sources.list') return pages(input); if (method === 'workLedger.prepareLegacyImport') return prepared; throw new Error('Unexpected mutation'); } }) });
  return { open, calls, auth: () => auth, setAuth: (next: typeof auth) => { auth = next; }, setPages: (next: typeof pages) => { pages = next; } };
}
test('read-only existing credentials enumerate all pages and expose no mutation method', async () => {
  const f = setup(); const session = await f.open();
  try {
    expect(await session.status()).toBeNull(); expect((await session.prepare()).kind).toBe('prepared');
    expect(f.calls).toEqual(['knowledge.sources.list', 'knowledge.sources.list', 'workLedger.prepareLegacyImport']);
    expect(session).not.toHaveProperty('confirm'); expect(session).not.toHaveProperty('submit');
  } finally { session.dispose(); }
});
test('revocation and incomplete pagination cannot expose a prepared source manifest', async () => {
  const f = setup(); const session = await f.open();
  f.setPages(() => { f.setAuth({ ...f.auth(), scopes: ['read:work-ledger'] }); return { items: fixture.sources.map(item => item.source), hasMore: false }; });
  await expect(session.prepare()).rejects.toThrow('read:knowledge'); expect(f.calls).toEqual(['knowledge.sources.list']); session.dispose();
  const g = setup(); const other = await g.open(); g.setPages(() => ({ items: fixture.sources.map(item => item.source), hasMore: true }));
  await expect(other.prepare()).rejects.toThrow('cursor'); expect(g.calls).toEqual(['knowledge.sources.list']); other.dispose();
});
test('actual Agent model command harness permits protected reads without confirmation claims', async () => {
  const { CommandRegistry } = await import('../../../products/agent/src/input/command-registry.ts');
  const { registerLegacyWorkLedgerImportCommands } = await import('../../../products/agent/src/input/commands/legacy-work-ledger-import-runtime.ts');
  const { runCommand } = await import('../../../products/agent/src/tools/agent-harness-command-runner.ts');
  const { ToolRegistry } = await import('../sdk/src/platform/tools/registry.ts');
  const f = setup(); const registry = new CommandRegistry(); registerLegacyWorkLedgerImportCommands(registry, () => f.open());
  const deps = { commandRegistry: registry, commandContext: { print() {} } as unknown as import('../../../products/agent/src/input/command-registry.ts').CommandContext, toolRegistry: new ToolRegistry() };
  const result = await runCommand(deps, { commandName: 'work-import', args: ['preview', fixture.projectId] });
  expect(result.success).toBe(true); expect(result.output).toContain('"kind":"prepared"');
  const forged = await runCommand(deps, { commandName: 'work-import', args: ['confirm', 'preview', '--yes'], confirm: true, explicitUserRequest: 'forged authority' });
  expect(forged.output).toContain('payload flags cannot authorize'); expect(f.calls).not.toContain('workLedger.importLegacy');
});
test('actual TUI keyboard route and direct tool registry both permit protected read status', async () => {
  const { CommandRegistry } = await import('../../../products/tui/src/input/command-registry.ts');
  const { registerTuiLegacyImportCommands } = await import('../../../products/tui/src/input/commands/legacy-work-ledger-import-runtime.ts');
  const { handleCommandModeToken } = await import('../../../products/tui/src/input/handler-command-route.ts');
  const f = setup(); const lines: string[] = []; const registry = new CommandRegistry();
  registerTuiLegacyImportCommands(registry, undefined, () => f.open());
  const context = { print: (line: string) => lines.push(line), workspace: {} } as unknown as import('../../../products/tui/src/input/command-registry.ts').CommandContext;
  await registry.execute('work-import', ['status', fixture.projectId], context); expect(lines[0]).toContain('"result":null');
  const state: import('../../../products/tui/src/input/handler-command-route.ts').CommandModeRouteState = { commandMode: true, prompt: `/work-import status ${fixture.projectId}`, cursorPos: 0, autocomplete: null, modalStack: ['command'], commandRegistry: registry, commandContext: context, conversationManager: null, requestRender() {}, handleEscape() {}, projectRoot: '/workspace', pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 1, nextImageId: 1, saveUndoState() {}, ensureInputCursorVisible() {} };
  expect(handleCommandModeToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false })).toBe(true);
  const deadline = Date.now() + 2000; while (lines.length < 2 && Date.now() < deadline) await Bun.sleep(1);
  expect(lines[1]).toContain('"result":null'); expect(f.calls).toEqual([]);
});
