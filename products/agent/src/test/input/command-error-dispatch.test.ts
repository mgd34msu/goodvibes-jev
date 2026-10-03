import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { handleCommandModeToken, type CommandModeRouteState } from '../../input/handler-command-route.ts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';

function makeEnterToken(): InputToken {
  return { type: 'key', logicalName: 'enter', raw: '\r', modifiers: {} } as unknown as InputToken;
}

function makeState(prompt: string, out: string[], registry: CommandRegistry): CommandModeRouteState {
  let rendered = 0;
  const logs: { text: string; color?: string }[] = [];
  return {
    commandMode: true,
    prompt,
    cursorPos: prompt.length,
    autocomplete: null,
    modalStack: ['command'],
    commandRegistry: registry,
    commandContext: {
      print: (text: string) => out.push(text),
      platform: {} as never,
      workspace: {} as never,
      session: {} as never,
      provider: {} as never,
      ops: {} as never,
      extensions: {} as never,
    } as never,
    conversationManager: {
      log: (text: string, opts?: { fg?: string }) => {
        logs.push({ text, color: opts?.fg });
        out.push(text);
      },
    } as never,
    requestRender: () => { rendered += 1; },
    handleEscape: () => {},
    projectRoot: '/tmp',
    pasteRegistry: new Map(),
    imageRegistry: new Map(),
    nextPasteId: 0,
    nextImageId: 0,
    saveUndoState: () => {},
    ensureInputCursorVisible: () => {},
  };
}

describe('command dispatch error boundary', () => {
  test('handler that throws produces a user-visible error message via conversationManager.log', async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'throws',
      description: 'always throws',
      async handler(_args, _ctx) {
        throw new Error('catastrophic failure');
      },
    });

    const out: string[] = [];
    const state = makeState('/throws', out, registry);

    handleCommandModeToken(state, makeEnterToken());

    // Give the promise microtask queue time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(out.length).toBeGreaterThan(0);
    const combined = out.join('\n');
    expect(combined).toContain('catastrophic failure');
  });

  test('handler that throws does NOT leave the conversation silent', async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'explodes',
      description: 'always throws TypeError',
      async handler(_args, _ctx) {
        throw new TypeError('cannot read property of undefined');
      },
    });

    const out: string[] = [];
    const state = makeState('/explodes', out, registry);

    handleCommandModeToken(state, makeEnterToken());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(out.join('\n')).toContain('cannot read property of undefined');
  });
});
