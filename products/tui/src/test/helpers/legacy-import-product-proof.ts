/** Actual product entry surface, without starting unrelated full-screen services. */
import { strict as assert } from 'node:assert';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { IMPORT_FIXTURE_TOKEN } from './legacy-import-host-fixture.ts';
import { beginTuiHostPairing, completeTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { CommandRegistry as TuiRegistry, type CommandContext as TuiContext } from '../../input/command-registry.ts';
import { registerTuiLegacyImportCommands } from '../../input/commands/legacy-work-ledger-import-runtime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';

export interface ImportProofSelection { home: string; workspace: string; baseUrl: string }
export async function pairImportProofHost(selection: ImportProofSelection): Promise<void> {
  const attemptId = crypto.randomUUID(); const name = 'Owned legacy import product fixture';
  assert.deepEqual(await beginTuiHostPairing(selection.home, selection.baseUrl, { attemptId, name, startedAt: 1 }), { status: 'begun' });
  assert.deepEqual(await completeTuiHostPairing(selection.home, selection.baseUrl, attemptId, { token: IMPORT_FIXTURE_TOKEN, tokenId: 'synthetic-paired-owner', name, createdAt: 2 }), { status: 'paired' });
}
function context(selection: ImportProofSelection, print: (line: string) => void) {
  return { print, platform: { configManager: { get(key: string) {
    const url = new URL(selection.baseUrl);
    return key === 'daemon.connectedHost.enabled' || key === 'daemon.enabled' ? true : key === 'controlPlane.host' ? url.hostname : key === 'controlPlane.port' ? Number(url.port) : key === 'controlPlane.publicBaseUrl' ? selection.baseUrl : undefined;
  } } }, workspace: { get shellPaths() { return createShellPathService({ workingDirectory: selection.workspace, homeDirectory: selection.home }); } } };
}
export async function runTuiImportProof(selection: ImportProofSelection, args: string[], route: 'keyboard' | 'registry' = 'keyboard'): Promise<string> {
  const registry = new TuiRegistry(); registerTuiLegacyImportCommands(registry);
  const lines: string[] = []; const commandContext = context(selection, line => lines.push(line)) as unknown as TuiContext;
  if (route === 'registry') { assert.equal(await registry.execute('work-import', args, commandContext), true); return lines.join('\n'); }
  let rendered!: () => void; const done = new Promise<void>(resolve => { rendered = resolve; });
  const state: CommandModeRouteState = { commandMode: true, prompt: `/work-import ${args.join(' ')}`, cursorPos: 0, autocomplete: null, modalStack: ['command'], commandRegistry: registry, commandContext,
    conversationManager: null, requestRender: rendered, handleEscape() {}, projectRoot: selection.workspace, pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 1, nextImageId: 1, saveUndoState() {}, ensureInputCursorVisible() {} };
  assert.equal(handleCommandModeToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false }), true);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([done, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('TUI import command did not render completion')), 10_000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(state.commandMode, false); assert.deepEqual(state.modalStack, []);
  return lines.join('\n');
}
