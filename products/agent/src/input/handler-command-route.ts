import { loadSkillByTrigger } from '@goodvibes-jev/engine/sdk/platform/tools';
import { summarizeCommandError } from './commands/command-error.ts';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { AutocompleteEngine } from './autocomplete.ts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { ClipboardPasteSource } from './handler-content-actions.ts';
import { parseSlashCommand } from './slash-command-parser.ts';
import { activeTokens } from '../renderer/theme.ts';

export type CommandModeRouteState = {
  commandMode: boolean;
  prompt: string;
  cursorPos: number;
  autocomplete: AutocompleteEngine | null;
  modalStack: string[];
  commandRegistry: CommandRegistry | null;
  commandContext?: CommandContext;
  conversationManager: ConversationManager | null;
  requestRender: () => void;
  handleEscape: () => void;
  projectRoot: string;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextPasteId: number;
  nextImageId: number;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  clipboard?: ClipboardPasteSource;
};

export function handleCommandModeToken(state: CommandModeRouteState, token: InputToken): boolean {
  if (!state.commandMode) return false;

  const closeCommandMode = (): void => {
    state.commandMode = false;
    for (let i = state.modalStack.length - 1; i >= 0; i--) {
      if (state.modalStack[i] === 'command') state.modalStack.splice(i, 1);
    }
    state.autocomplete?.reset();
    state.prompt = '';
    state.cursorPos = 0;
  };

  if (token.type !== 'key') return false;

  if (token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }
  if (token.logicalName === 'up') {
    state.autocomplete?.moveUp();
    return true;
  }
  if (token.logicalName === 'down') {
    state.autocomplete?.moveDown();
    return true;
  }
  if (token.logicalName === 'tab') {
    const selected = state.autocomplete?.getSelected();
    if (selected) {
      state.prompt = `/${selected.name} `;
      state.cursorPos = state.prompt.length;
      state.autocomplete?.reset();
    }
    return true;
  }
  if (token.logicalName === 'backspace') {
    if (state.cursorPos > 0) {
      state.prompt = state.prompt.slice(0, state.cursorPos - 1) + state.prompt.slice(state.cursorPos);
      state.cursorPos--;
    }
    if (state.prompt === '') {
      closeCommandMode();
      state.autocomplete?.reset();
    } else {
      const query = state.prompt.startsWith('/') ? state.prompt.slice(1) : '';
      const spaceIdx = query.indexOf(' ');
      if (spaceIdx === -1) state.autocomplete?.update(query);
    }
    return true;
  }
  if (token.logicalName === 'enter') {
    const selectedCmd = state.autocomplete?.isActive ? state.autocomplete.getSelected() : undefined;
    const raw = selectedCmd ? `/${selectedCmd.name}` : state.prompt.trim();
    if (raw.startsWith('/') && state.commandRegistry && state.commandContext) {
      closeCommandMode();
      const { name, args: parsedArgs } = parseSlashCommand(raw);
      const args = [...parsedArgs];
      const ctx = state.commandContext;
      const commandPromise = state.commandRegistry.get(name)
        ? state.commandRegistry.executeFromOwner(name, args, ctx)
        : (ctx.executeCommand?.(name, args) ?? Promise.resolve(false));
      commandPromise.then((handled) => {
        if (handled) {
          state.requestRender();
        } else {
          const shellPaths = state.commandContext?.workspace.shellPaths;
          const skillContent = shellPaths
            ? loadSkillByTrigger('/' + name, {
                workingDirectory: shellPaths.workingDirectory,
                homeDirectory: shellPaths.homeDirectory,
              })
            : null;
          if (skillContent) {
            state.commandContext?.submitInput?.(skillContent);
          } else {
            state.conversationManager?.log(`Unknown command /${name}. Type /help for available commands.`, { fg: activeTokens().error });
            state.requestRender();
          }
        }
      }).catch((error: unknown) => {
        const message = summarizeCommandError(error);
        state.conversationManager?.log(message, { fg: activeTokens().error });
        state.requestRender();
      });
    } else {
      closeCommandMode();
    }
    return true;
  }

  return token.logicalName !== 'left' && token.logicalName !== 'right';
}

