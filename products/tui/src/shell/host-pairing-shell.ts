import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { InputHandler } from '../input/handler.ts';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { ConversationManager } from '../core/conversation.ts';
import { getActiveModalName } from '../input/handler-ui-state.ts';
import { HostPairingController } from './host-pairing-controller.ts';

/** Composition only: the callback is inaccessible to model/tool approval, and
 * the controller owns input until preview, storage and verification have ended.
 */
export function wireHostPairingShell(options: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly conversation: ConversationManager;
  readonly canPresent: () => boolean;
  readonly render: () => void;
  readonly scroll: (lines: number) => void;
  readonly toBottom: () => void;
}): HostPairingController {
  const { input, commandRegistry, commandContext, conversation, render } = options;
  const controller = new HostPairingController(options, {
    print: text => { options.toBottom(); conversation.logWrapped(text); render(); },
    scroll: lines => { options.scroll(lines); render(); },
    readPrompt: () => input.prompt,
    setPrompt: text => {
      input.prompt = text; input.cursorPos = text.length; input.commandMode = false; input.inputScrollTop = 0;
      input.ensureInputCursorVisible();
      input.autocomplete?.reset(); input.syncFeedContextMutableFields(); render();
    },
    canPresent: () => options.canPresent() && !input.concealedInput
      && !input.surfaceModals.active && input.modalStack.length === 0
      && [null, 'command'].includes(getActiveModalName(input)) && !input.searchManager.active && !input.historySearch.active,
    executeOwnerCommand: line => {
      const [name, ...args] = line.slice(1).trim().split(/\s+/);
      void commandRegistry.executeFromOwner(name!, args, commandContext)
        .catch(() => { conversation.logWrapped('Pairing replacement command failed. Preview pairing again before taking further action.'); render(); });
    },
  });
  input.hostPairing = controller;
  commandContext.beginHostPairing = request => controller.start(request);
  return controller;
}
