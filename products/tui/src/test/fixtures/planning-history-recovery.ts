/** Compiled product-boundary proof; only the selected loopback host is synthetic. */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';
import { handleConfigModalToken } from '../../input/handler-modal-routes.ts';
import { ConfigModal } from '../../input/config-modal.ts';
import { createPlanningModalSurface } from '../../views/modals/planning-modal.ts';
import { createNativeWorkLedgerModalSurface } from '../../views/modals/native-work-ledger-modal.ts';
import { createNativeWorkLedgerHost, registerNativeWorkLedgerCommand } from '../../runtime/native-work-ledger-host.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import type { NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';

const [mode, home, baseUrl, projectId] = process.argv.slice(2);
assert.ok(mode && home && baseUrl && projectId);
const dbPath = join(home, 'history.sqlite'); const journalPath = join(home, 'native.json');
const historicalBytes = readFileSync(dbPath);
const store = new KnowledgeStore({ dbPath }); const service = new ProjectPlanningService(store);
await store.init();
const saved = JSON.stringify(store.listSources(1000));
const judgment = fakePort(() => noulAnswer(0.99)); const previous = installJudgmentPort(judgment.port);
const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? baseUrl : undefined } as unknown as ConfigManager;
const host = createNativeWorkLedgerHost({ configManager, homeDirectory: home, journalPath, workspace: () => home });
host.selectProject(projectId); // Explicit exact host project, never inferred from legacy records.
const history = createPlanningModalSurface({ projectId, service: {
  status: input => service.status(input), getState: input => service.getState(input),
  listDecisions: input => service.listDecisions(input), getLanguage: input => service.getLanguage(input),
} });
const native = createNativeWorkLedgerModalSurface(host.readSelection);
const modal = new ConfigModal(); const opened: string[] = []; const output: string[] = [];
const dispatched: { text: string; requestId: string; inputId: string }[] = [];
const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
registerNativeWorkLedgerCommand(registry, host.selectProject, host.discoverProject, host.submission);
const context = {
  workspace: { projectPlanningService: service, projectPlanningProjectId: projectId },
  nativeConversationIntake: host.intake,
  print: (line: string) => output.push(line),
  openModal(name: string) { opened.push(name); assert.ok(name === history.name || name === native.name); modal.open(name === history.name ? history : native); },
  dispatchNativeIntakeTurn: async (state: NativeConversationIntakeState) => {
    assert.equal(state.result?.kind, 'turn');
    if (state.result?.kind === 'turn') dispatched.push({ text: state.result.text, requestId: state.result.requestId, inputId: state.result.sourceRef.inputId });
  },
} as unknown as CommandContext;
const enter = { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false };
const waitFor = async (condition: () => boolean, label = 'read') => {
  const deadline = Date.now() + 10_000;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Compiled product proof did not settle: ${label}; output ${output.join(' | ')}`); await Bun.sleep(2); }
};
async function command(prompt: string) {
  let done = false;
  const state = { commandMode: true, prompt, cursorPos: prompt.length, commandRegistry: registry, commandContext: context,
    modalStack: ['command'], autocomplete: null, conversationManager: null, requestRender: () => { done = true; },
    handleEscape() {}, projectRoot: home, pasteRegistry: new Map(), imageRegistry: new Map(), nextPasteId: 1, nextImageId: 1,
    saveUndoState() {}, ensureInputCursorVisible() {},
  } as unknown as CommandModeRouteState;
  assert.equal(handleCommandModeToken(state, enter), true);
  await waitFor(() => done, prompt); assert.equal(state.commandMode, false);
}
const text = (surface: typeof history) => surface.buildView().tabs.flatMap(tab => [...(tab.header ?? []), ...tab.rows.map(row => row.label)]).join('\n');
const key = (logicalName: string) => handleConfigModalToken({ configModal: modal, requestRender() {}, handleEscape: () => modal.close() }, { ...enter, logicalName });
async function inspectHistory() {
  await command('/project-plan history'); await waitFor(() => text(history).includes('Preserve synthetic history'));
  assert.deepEqual(history.actions?.map(action => action.id), ['refresh']);
  assert.equal(history.buildView().tabs.flatMap(tab => tab.rows).every(row => row.selectable === false), true);
  assert.ok(text(history).includes('historical approval yes'));
  assert.ok(text(history).includes('Which host?')); assert.ok(text(history).includes('Yes'));
  const rendered = frameFromLayer(renderConfigModal(modal, 180, 45), 180, 45).map(line => line.map(cell => cell.char).join('')).join('\n');
  assert.ok(rendered.includes('Historical planning'));
  key('enter');
  assert.equal(modal.fireAction('a', { print() {}, executeCommand: async () => { throw new Error('Historical approval dispatched'); } }), false);
  key('r'); await waitFor(() => text(history).includes('Preserve synthetic history'));
  key('escape'); assert.equal(modal.active, false);
  assert.deepEqual(readFileSync(dbPath), historicalBytes);
  assert.equal(JSON.stringify(store.listSources(1000)), saved); assert.deepEqual(judgment.requests, []);
}
async function inspectNative() {
  await command('/project-plan'); await waitFor(() => text(native).includes('Legacy done item'));
  assert.ok(text(native).includes('reportedState complete')); assert.ok(text(native).includes('verificationState unverified'));
  assert.deepEqual(native.buildView().tabs.find(tab => tab.id === 'evidence')?.rows, []);
  for (let i = 0; i < 4; i++) key('right');
  assert.equal(modal.getActiveTabId(), 'imports');
  assert.ok(text(native).includes('artifact-external')); assert.ok(text(native).includes('not execution authority'));
  key('escape'); assert.equal(modal.active, false);
}
try {
  await inspectHistory(); await inspectNative();
  if (mode === 'submit') {
    await command('/project-plan   Original owner request\r\n界 e\u0301 😀\t  ');
    assert.equal(dispatched.length, 0);
    const savedJournal = readFileSync(`${journalPath}.intake`);
    await inspectHistory(); await inspectNative();
    assert.deepEqual(readFileSync(`${journalPath}.intake`), savedJournal);
  } else if (mode === 'recover') {
    const savedJournal = readFileSync(`${journalPath}.intake`);
    await command('/work intake-status'); assert.equal(dispatched.length, 0);
    assert.deepEqual(readFileSync(`${journalPath}.intake`), savedJournal);
    await command('/work intake-retry');
    await command('/work intake-resume');
  } else throw new Error(`Unknown proof mode: ${mode}`);
  assert.deepEqual(judgment.requests, []);
  assert.equal(JSON.stringify(store.listSources(1000)), saved);
  assert.deepEqual(readFileSync(dbPath), historicalBytes);
  console.log(JSON.stringify({ mode, opened, output, dispatched, historicalUnchanged: true, judgmentReads: judgment.requests.length }));
} finally {
  modal.close(); host.intake.close(); host.submission.close(); await store.close(); installJudgmentPort(previous);
}
