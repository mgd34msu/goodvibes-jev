import { describe, expect, test } from 'bun:test';
import { InfiniteBuffer, SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { ConversationManager } from '../../core/conversation.ts';
import { InputHandler } from '../../input/handler.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerHostPairingCommands } from '../../input/commands/host-pairing.ts';
import { wireHostPairingShell } from '../../shell/host-pairing-shell.ts';
import type { HostPairingController } from '../../shell/host-pairing-controller.ts';
import { readTuiHostPairing } from '../../runtime/tui-host-credential-store.ts';
import { interactiveHostPairingFixture, untilPairing } from '../helpers/interactive-host-pairing.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

function shellFixture(options: Parameters<typeof interactiveHostPairingFixture>[0] = {}) {
  const fixture = interactiveHostPairingFixture(options);
  const conversation = new ConversationManager(() => 80);
  conversation.dismissSplash();
  const history = new InfiniteBuffer();
  const registry = new CommandRegistry();
  registerHostPairingCommands(registry);
  let controller: HostPairingController | undefined;
  let present = true;
  let renders = 0;
  let toBottom = 0;
  const scrolls: number[] = [];
  const submissions: string[] = [];
  const render = () => { renders++; controller?.checkPresentation(); };
  const input = new InputHandler(render, new SelectionManager(), () => 0, () => 20, () => history,
    lines => scrolls.push(lines), () => {}, createDefaultUiRuntimeServices());
  input.setContentWidth(80);
  input.conversationManager = conversation;
  const context = {
    platform: { configManager: fixture.configManager },
    workspace: { shellPaths: { homeDirectory: fixture.homeDirectory } },
    print: (text: string) => conversation.logWrapped(text), renderRequest: render,
    submitInput: (text: string) => submissions.push(text),
  } as unknown as CommandContext;
  input.setCommandRegistry(registry, context);
  controller = wireHostPairingShell({ ...fixture.options, input, commandRegistry: registry,
    commandContext: context, conversation, canPresent: () => present, render,
    scroll: lines => scrolls.push(lines), toBottom: () => { toBottom++; },
  });
  const text = () => conversation.getDisplayBlocks().map(line => line.map(cell => cell.char).join('')).join('\n');
  return {
    fixture, input, registry, context, controller, conversation, submissions, scrolls, render, text,
    renders: () => renders, toBottom: () => toBottom,
    setPresent: (value: boolean) => { present = value; },
    phrase() {
      const phrases = [...text().matchAll(/PAIR [0-9a-f]{12}/g)];
      expect(phrases.length).toBeGreaterThan(0);
      return phrases.at(-1)![0];
    },
    async start() { await registry.executeFromOwner('host', ['pair', '--bootstrap-shared', '--apply'], context); },
    async stop() {
      controller!.dispose();
      if (input.lastCtrlCTimeoutId) clearTimeout(input.lastCtrlCTimeoutId);
      fixture.assertPrivateOutput(text());
      await fixture.stop();
    },
  };
}

async function withShell(run: (s: ReturnType<typeof shellFixture>) => Promise<void>, options: Parameters<typeof interactiveHostPairingFixture>[0] = {}) {
  const shell = shellFixture(options);
  try { await run(shell); }
  finally { await shell.stop(); }
}

function expectNoGrant(s: ReturnType<typeof shellFixture>) {
  expect(s.fixture.migrations()).toBe(0);
  expect(readTuiHostPairing(s.fixture.homeDirectory, s.fixture.host).status).toBe('missing');
  expect(s.submissions).toEqual([]);
  expect(s.conversation.getMessagesForLLM()).toEqual([]);
}

describe('host pairing shell over the real InputHandler', () => {
  test('direct slash dispatch tolerates the live commandMode snapshot and wires fresh confirmation', async () => withShell(async s => {
    s.input.feed('/host pair --bootstrap-shared --apply');
    expect(s.input.commandMode).toBe(true);
    s.input.feed('\r');
    await untilPairing(() => /PAIR [0-9a-f]{12}/.test(s.text()), 'wired command confirmation');
    expect(s.input.hostPairing).toBe(s.controller);
    expect(s.controller.active).toBe(true);
    expect(s.input.commandMode).toBe(false);
    expect(s.input.modalStack).toEqual([]);
    expect(s.input.prompt).toBe('');
    expectNoGrant(s);
    s.input.feed(`${s.phrase()}\r`);
    await untilPairing(() => !s.controller.active, 'wired owner confirmation');
    expect(s.fixture.migrations()).toBe(1);
    expect(readTuiHostPairing(s.fixture.homeDirectory, s.fixture.host).status).toBe('paired');
    expect(s.submissions).toEqual([]);
    expect(s.conversation.getMessagesForLLM()).toEqual([]);
    expect(s.renders()).toBeGreaterThan(0);
    expect(s.toBottom()).toBeGreaterThan(0);
  }));

  for (const field of ['bookmarkModal', 'settingsModal', 'mcpWorkspace', 'sessionPickerModal',
    'profilePickerModal', 'configModal', 'contextInspectorModal', 'modelPicker', 'filePicker',
    'blockActionsMenu', 'selectionModal', 'onboardingWizard'] as const) {
    test(`an active ${field} cancels even without a modal-stack entry`, async () => withShell(async s => {
      await s.start();
      const phrase = s.phrase();
      s.input.feed('P');
      expect(s.input.modalStack).toEqual([]);
      s.input[field].active = true;
      s.render();
      expect(s.controller.active).toBe(false);
      expect(s.controller.ownsInput).toBe(true);
      s.input.feed(`${phrase.slice(1)}\r`);
      expect(s.controller.ownsInput).toBe(false);
      expect(s.input[field].active).toBe(true);
      expect(s.input.prompt).toBe('');
      expectNoGrant(s);
    }));
  }

  for (const field of ['helpOverlayActive', 'shortcutsOverlayActive'] as const) {
    test(`a ${field} flag cancels without a modal-stack entry`, async () => withShell(async s => {
      await s.start();
      const phrase = s.phrase();
      s.input.feed('P');
      s.input[field] = true;
      s.render();
      expect(s.controller.active).toBe(false);
      s.input.feed(`${phrase.slice(1)}\r`);
      expect(s.controller.ownsInput).toBe(false);
      expect(s.input[field]).toBe(true);
      expectNoGrant(s);
    }));
  }

  for (const surface of ['modal stack', 'search', 'history search', 'concealed field', 'shell blocker'] as const) {
    test(`${surface} invalidates confirmation and drains its abandoned line`, async () => withShell(async s => {
      await s.start();
      const phrase = s.phrase();
      s.input.feed('P');
      const concealed: string[] = [];
      if (surface === 'modal stack') s.input.modalStack.push('synthetic-prompt');
      if (surface === 'search') s.input.searchManager.open();
      if (surface === 'history search') s.input.historySearch.open('');
      if (surface === 'concealed field') s.input.concealedInput = { onSubmit: value => concealed.push(value) };
      if (surface === 'shell blocker') s.setPresent(false);
      s.render();
      expect(s.controller.active).toBe(false);
      expect(s.controller.ownsInput).toBe(true);
      s.input.feed(`${phrase.slice(1)}\r`);
      expect(s.controller.ownsInput).toBe(false);
      expect(s.input.prompt).toBe('');
      expect(concealed).toEqual([]);
      expectNoGrant(s);
    }));
  }

  test('surface modal receives no abandoned confirmation tokens, then accepts fresh input', async () => withShell(async s => {
    await s.start();
    const phrase = s.phrase();
    s.input.feed('P');
    const received: InputToken[] = [];
    s.input.surfaceModals.push({ name: 'synthetic-takeover', handleToken: token => received.push(token),
      render: () => ({ x: 0, y: 0, lines: [], dim: true }),
    });
    s.render();
    expect(s.controller.active).toBe(false);
    s.input.feed(`${phrase.slice(1)}\r`);
    expect(received).toEqual([]);
    expect(s.controller.ownsInput).toBe(false);
    s.input.feed('y');
    expect(received).toHaveLength(1);
    expectNoGrant(s);
  }));

  test('modalOpened aborts revalidation synchronously before a held host reply', async () => withShell(async s => {
    await s.start();
    s.input.feed(`${s.phrase()}\r`);
    await untilPairing(s.fixture.held, 'held authority');
    s.input.modalOpened('help');
    expect(s.controller.active).toBe(false);
    const beforeRelease = s.text();
    s.fixture.release();
    await untilPairing(() => s.fixture.returned() === 2, 'late authority');
    await Bun.sleep(10);
    expect(s.text()).toBe(beforeRelease);
    expectNoGrant(s);
  }, { holdAuth: 2 }));

  test('beginConcealedInput quarantines pairing bytes before accepting a separate answer', async () => withShell(async s => {
    await s.start();
    const phrase = s.phrase();
    s.input.feed('P');
    const received: string[] = [];
    s.input.beginConcealedInput({ label: 'Synthetic test input', onSubmit: value => received.push(value) });
    expect(s.controller.active).toBe(false);
    s.input.feed(`${phrase.slice(1)}\r`);
    expect(received).toEqual([]);
    expect(s.input.concealedInput).not.toBeNull();
    s.input.feed('fresh-answer\r');
    expect(received).toEqual(['fresh-answer']);
    expectNoGrant(s);
  }));

  test('a voice-like draft replacement preserves the new text while draining abandoned pairing', async () => withShell(async s => {
    await s.start();
    s.input.feed('P');
    const draft = 'A fresh voice draft must remain visible.';
    s.input.prompt = draft; s.input.cursorPos = draft.length;
    s.render();
    expect(s.controller.active).toBe(false);
    expect(s.controller.ownsInput).toBe(true);
    s.input.feed('AIR abandoned\r');
    expect(s.controller.ownsInput).toBe(false);
    expect(s.input.prompt).toBe(draft);
    expect(s.input.cursorPos).toBe(draft.length);
    expectNoGrant(s);
  }));

  test('new pairing input stays visible after a scrolled composer and at narrow width', async () => withShell(async s => {
    s.input.setContentWidth(8);
    s.input.inputScrollTop = 8;
    await s.start();
    expect(s.input.inputScrollTop).toBe(0);
    const phrase = s.phrase();
    s.input.feed(phrase);
    const wrapped = s.input.getWrappedPromptInfo(8);
    expect(wrapped.visibleLines.join('')).toBe(phrase);
    expect(s.input.inputScrollTop).toBe(0);
    s.input.feed('\r');
    await untilPairing(() => !s.controller.active, 'visible narrow-width confirmation');
    expect(s.fixture.migrations()).toBe(1);
  }));

  test('paging and mouse-wheel input are wired to shell scrolling without changing the answer', async () => withShell(async s => {
    await s.start();
    const phrase = s.phrase();
    s.input.feed(phrase.slice(0, 6));
    s.input.feed('\x1b[5~\x1b[6~\x1b[<64;1;1M\x1b[<65;1;1M');
    expect(s.scrolls).toEqual([-5, 5, -3, 3]);
    expect(s.input.prompt).toBe(phrase.slice(0, 6));
    s.input.feed(`${phrase.slice(6)}\r`);
    await untilPairing(() => !s.controller.active, 'confirmation after shell scrolling');
    expect(s.fixture.migrations()).toBe(1);
  }));
});
