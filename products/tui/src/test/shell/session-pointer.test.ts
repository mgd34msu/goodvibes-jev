import { afterEach, expect, test } from 'bun:test';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { makeViewScene, type ViewScene } from '../helpers/session-view-scenes.ts';
import { SurfacePointer } from '../../input/surface-pointer.ts';
import { beginModal, finishModal } from '../../renderer/surface-kit.ts';
import { drawList } from '../../renderer/surface-kit-list.ts';
import { BeadContentCache } from '../../core/bead-content-cache.ts';
import { InfiniteBuffer, SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InputHandler } from '../../input/handler.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { ConfirmDialog } from '../../input/confirm-dialog.ts';
import { renderStatusLine } from '../../renderer/status-line.ts';
import { footerTargetRows, resolveFooterTarget, tagFooterLine } from '../../renderer/footer-targets.ts';

disposeTestRuntimeServicesAfterAll();
const scenes: ViewScene[] = [];
afterEach(() => { for (const scene of scenes.splice(0)) scene.views.dispose(); });
const mouse = (row: number, col: number, action: 'press' | 'release' = 'press', button = 0): InputToken & { type: 'mouse' } => ({ type: 'mouse', row, col, action, button });
const chars = (line: readonly { char: string }[]) => line.map(c => c.char).join('');

test('visible session chips and breadcrumbs switch view; the wheel scrolls that agent', () => {
  const scene = makeViewScene({ withProcess: false }); scenes.push(scene);
  const views = scene.views;
  const chips = chars(views.chips(160)!);
  const col = chips.indexOf('engineer');
  views.handleMouse(mouse(1, col)); views.handleMouse(mouse(1, col, 'release'));
  expect(views.focus.current).toEqual({ kind: 'agent', id: 'eng' });
  const frame = views.frame(160)!;
  views.chips(160); frame.body(8);
  expect(views.handleMouse(mouse(4, 20, 'press', 64))).toBe(true);
  expect(views.scrolledBack()).toBe(true);
  const mainCol = chars(frame.header).indexOf('main');
  views.handleMouse(mouse(0, mainCol)); views.handleMouse(mouse(0, mainCol, 'release'));
  expect(views.kind).toBe('main');
  expect(scene.log.killed).toEqual([]);
  expect(scene.log.steers).toEqual([]);
});

test('modal hit regions follow wrapped rows and do not activate after a drag or click through', () => {
  const pointer = new SurfacePointer();
  const frame = beginModal(80, 18, { title: 'Agents' });
  drawList(frame.canvas, { mouseNavigation: true, rows: [
    { header: 'Running' }, { label: 'first', selected: true },
    { label: 'second', desc: 'a long agent task '.repeat(6) },
  ], top: frame.top, bottom: frame.bottom, x0: frame.l, x1: frame.r });
  const layer = finishModal(frame); pointer.layers = [layer];
  const hit = layer.hitTargets!.find(h => h.id.includes('second'))!;
  const row = layer.y + hit.y, col = layer.x + hit.x;
  expect(hit.height).toBeGreaterThan(1);
  expect(pointer.route(mouse(row, col))).toEqual([]);
  expect(pointer.route(mouse(row, col, 'release'))).toMatchObject([{ type: 'key', logicalName: 'down' }]);
  pointer.route(mouse(row, col));
  expect(pointer.route(mouse(row + 1, col, 'release'))).toEqual([]);
  expect(pointer.route(mouse(1, 1))).toEqual([]);
  const escape = layer.hitTargets!.find(h => h.id === 'escape')!;
  pointer.route(mouse(layer.y + escape.y, layer.x + escape.x));
  expect(pointer.route(mouse(layer.y + escape.y, layer.x + escape.x, 'release'))).toMatchObject([{ type: 'key', logicalName: 'escape' }]);
});

test('tool parsing is reused across cloned snapshots and invalidated by changed output or arguments', () => {
  const cache = new BeadContentCache();
  const call = { id: 'call', name: 'read', arguments: { files: [{ path: 'file.ts' }] } };
  const content = JSON.stringify({ success: true, files: [{ path: 'file.ts', content: '1 | const a = 1;', lineCount: 1 }] });
  cache.begin(); const first = cache.read('call', call, 'ok', content); cache.end();
  cache.begin(); expect(cache.read('call', structuredClone(call), 'ok', content)).toBe(first); cache.end();
  cache.begin(); const changed = cache.read('call', call, 'ok', content.replace('a = 1', 'a = 2')); cache.end();
  expect(changed).not.toBe(first);
  expect(JSON.stringify(changed.body)).toContain('a = 2');
  cache.begin(); expect(cache.read('call', { ...call, arguments: { files: [{ path: 'other.ts' }] } }, 'ok', content)).not.toBe(first); cache.end();
  cache.begin(); cache.end();
  cache.begin(); expect(cache.read('call', call, 'ok', content)).not.toBe(first); cache.end();
  const exec = { id: 'exec', name: 'exec', arguments: { command: 'false' } };
  const failure = JSON.stringify({ commands: [{ exit_code: 1, stdout: '', stderr: '' }] });
  cache.begin(); cache.read('exec', exec, 'err', failure); cache.end();
  expect(cache.needsAttention('exec', exec, failure)).toBe(true);
  expect(cache.needsAttention('exec', exec, failure.replace('"exit_code":1', '"exit_code":0'))).toBe(false);
});

test('real SGR mouse input reaches the top dialog, and keyboard editing still works afterwards', () => {
  const input = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => new InfiniteBuffer(), () => {}, () => {}, createDefaultUiRuntimeServices());
  let answer: boolean | undefined;
  const dialog = new ConfirmDialog({ title: 'Stop agent?', body: 'The agent is still running.', confirmLabel: 'Stop', tone: 'danger' }, result => { answer = result; });
  input.surfaceModals.push(dialog);
  const layer = dialog.render(100, 30);
  input.surfacePointer.layers = [layer];
  const cancel = layer.hitTargets!.find(h => h.id === 'cancel')!;
  const col = layer.x + cancel.x + 1, row = layer.y + cancel.y + 1;
  input.feed(`\x1b[<0;${col};${row}M\x1b[<0;${col};${row}m`);
  expect(answer).toBe(false);
  expect(input.surfaceModals.active).toBe(false);
  input.surfacePointer.layers = [];
  input.feed('hello'); input.feed('\x1b[D'); input.feed('!');
  expect(input.prompt).toBe('hell!o');
});

test('footer clicks distinguish agents, menu, and usage at terminal coordinates', () => {
  const line = tagFooterLine(renderStatusLine({ width: 180, background: { agents: 3, processes: 0, focused: false }, cost: '$0.02' }), 'usage');
  const text = chars(line);
  const rows = footerTargetRows([line], 30);
  expect(resolveFooterTarget(rows, 30, text.indexOf('3 agents'))).toBe('agents');
  expect(resolveFooterTarget(rows, 30, text.indexOf('menu'))).toBe('commands');
  expect(resolveFooterTarget(rows, 30, text.indexOf('$0.02'))).toBe('usage');
});
