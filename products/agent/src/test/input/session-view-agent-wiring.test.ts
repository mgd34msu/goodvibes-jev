/**
 * The Agent's own entry points into agent and process views, and what the
 * status line says the next Esc does.
 *
 *   - Enter on a row of the process monitor opens that process full screen and
 *     closes the monitor the way Esc would (one modal-stack level); without
 *     the view it still opens the live tail.
 *   - In a process view r says restart is not available, and ctrl+x stops
 *     only on the second press.
 *   - The status line always names the next Esc: back to the parent, clear
 *     input, close search; on main's busy line, clear input while the
 *     composer has text and interrupt only when it is empty.
 */
import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { handleProcessModalToken } from '../../input/handler-picker-routes.ts';
import { handleSessionViewToken, type SessionViewRouteState } from '../../input/handler-session-view-route.ts';
import type { ProcessEntry } from '../../renderer/process-modal.ts';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { makeViewScene, type ViewScene } from '../helpers/session-view-scenes.ts';

const key = (name: string, mods: { ctrl?: boolean } = {}): InputToken => ({ type: 'key', logicalName: name, ctrl: mods.ctrl ?? false, meta: false, shift: false } as InputToken);
const text = (value: string): InputToken => ({ type: 'text', value } as InputToken);
const route = (scene: ViewScene, prompt = ''): SessionViewRouteState => ({ controls: scene.views, prompt, cursorPos: prompt.length, commandMode: false, saveUndoState: () => {}, requestRender: () => {} });

function monitorState(openProcessView?: (id: string) => boolean) {
  const entry: ProcessEntry = { id: 'bg-1', label: 'bun run dev', type: 'exec', status: 'running', elapsedMs: 1000 };
  const calls: string[] = [];
  const state = {
    processModal: {
      active: true,
      moveUp: () => {}, moveDown: () => {},
      getSelected: () => entry,
      close: () => { calls.push('close'); state.processModal.active = false; },
      open: () => {},
      stopSelected: () => { calls.push('stop'); return true; },
      refresh: () => {},
    },
    liveTailModal: { open: (e: ProcessEntry) => { calls.push(`tail:${e.id}`); } },
    modalOpened: (name: string) => { calls.push(`opened:${name}`); },
    requestRender: () => {},
    handleEscape: () => { calls.push('escape'); },
    openProcessView,
  };
  return { state, calls };
}

/** The status line (the footer's last row) as text. */
function statusRow(scene: ViewScene, prompt = ''): string {
  scene.setPrompt(prompt);
  const frame = scene.views.frame(120)!;
  const lines = buildShellFooter({
    width: 120, promptText: prompt, promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
    runningAgentCount: 1, runningProcessCount: 1, indicatorFocused: false, view: frame.footer,
  }).lines;
  return lines[lines.length - 1]!.map((c) => c.char).join('');
}

describe('the process monitor opens a process full screen', () => {
  test('Enter opens the process view and closes the monitor through Esc; no live tail, nothing stopped', () => {
    const opened: string[] = [];
    const { state, calls } = monitorState((id) => { opened.push(id); return true; });
    expect(handleProcessModalToken(state, key('enter'))).toBe(true);
    expect(opened).toEqual(['bg-1']);
    expect(calls).toEqual(['escape']);
  });

  test('without the view (or when it cannot open) Enter keeps opening the live tail', () => {
    for (const open of [undefined, () => false]) {
      const { state, calls } = monitorState(open);
      handleProcessModalToken(state, key('enter'));
      expect(calls).toEqual(['opened:liveTail', 'close', 'tail:bg-1']);
    }
  });
});

describe('process view keys', () => {
  test('r says restart is not available and starts nothing', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    handleSessionViewToken(route(scene), text('r'));
    expect(scene.views.frame(120)!.footer.notice?.text).toContain('Restart is not available');
    expect(scene.log.stopped).toEqual([]);
  });

  test('ctrl+x once stops nothing and asks; the second press stops the process', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    handleSessionViewToken(route(scene), key('x', { ctrl: true }));
    expect(scene.log.stopped).toEqual([]);
    expect(statusRow(scene)).toContain('Press ctrl+x again to stop bun run dev');
    handleSessionViewToken(route(scene), key('x', { ctrl: true }));
    expect(scene.log.stopped).toEqual(['bg-1']);
  });
});

describe('the status line names the next Esc', () => {
  test('in an agent view: back to main, or clear input while the composer has text', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'eng' });
    expect(statusRow(scene)).toMatch(/esc +back to main/);
    expect(statusRow(scene, 'draft')).toMatch(/esc +clear input/);
    expect(statusRow(scene)).toContain('◐ main · working');
  });

  test('in a child agent: back to the agent that started it', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'tester' });
    expect(statusRow(scene)).toMatch(/esc +back to engineer/);
  });

  test('in a process view with a search open: close search', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    scene.views.startSearch();
    expect(statusRow(scene)).toMatch(/esc +close search/);
  });

  test('on main\'s busy line: interrupt with an empty composer, clear input with text', () => {
    const row = (promptText: string): string => {
      const lines = buildShellFooter({ width: 120, promptText, promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0, runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false, turnRunning: true }).lines;
      return lines[lines.length - 1]!.map((c) => c.char).join('');
    };
    expect(row('')).toMatch(/esc +interrupt/);
    expect(row('draft')).toMatch(/esc +clear input/);
    expect(row('draft')).not.toMatch(/esc +interrupt/);
  });
});
