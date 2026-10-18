import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandPalette } from '../../input/command-palette.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import type { PaletteEntry } from '../../input/command-palette-types.ts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
const entries: PaletteEntry[] = [
  { id: 'compact', title: 'Compact context', description: 'Summarize context to reduce token usage.', category: 'Session', group: 'Session', aliases: [], keywords: [], needsArgs: false },
  { id: 'clear', title: 'Clear conversation', description: 'Delete conversation history.', category: 'Session', group: 'Session', aliases: [], keywords: [], needsArgs: false },
];
let previous: ReturnType<typeof installJudgmentPort>;
const palettes: CommandPalette[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { for (const palette of palettes.splice(0)) palette.onClose(); installJudgmentPort(previous); });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function palette(extra: Partial<ConstructorParameters<typeof CommandPalette>[0]> = {}) {
  const value = new CommandPalette({ entries, onRun: () => {}, ...extra }); palettes.push(value); return value;
}
function selectedPort() {
  return fakePort((name, question) => name === 'pick' ? choiceAnswer(question, 'command_0', 0.99) : noulAnswer(name === 'fits_0' ? 0.99 : 0.01));
}

test('literal results are immediate and make no Jev requests', async () => {
  const fake = selectedPort(); installJudgmentPort(fake.port);
  const p = palette(); p.setQuery('compact');
  expect(p.getSelected()?.id).toBe('compact');
  await wait(300);
  expect(fake.requests).toHaveLength(0);
});

test('typing coalesces into one asynchronous reading and rendering does not issue requests', async () => {
  const fake = selectedPort(); installJudgmentPort(fake.port);
  let updates = 0;
  const p = palette({ onChanged: () => { updates++; } });
  p.setQuery('make the dialogue'); p.setQuery('make the dialogue take less room');
  for (let i = 0; i < 10; i++) p.sections();
  expect(fake.requests).toHaveLength(0);
  expect(p.searching).toBe(true);
  await wait(300);
  expect(fake.requests).toHaveLength(1);
  expect(updates).toBe(1);
  expect(p.getSelected()?.id).toBe('compact');
  p.sections(); p.setQuery(p.query); await wait(300);
  expect(fake.requests).toHaveLength(1);
});

test('a pending semantic search cannot delay literal search or publish after a query change', async () => {
  const fake = selectedPort(); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  installJudgmentPort({ model: fake.port.model, ask: async request => { began(); await blocked; return fake.port.ask(request); } });
  const p = palette(); p.setQuery('make the dialogue take less room');
  await started;
  p.setQuery('clear');
  expect(p.getSelected()?.id).toBe('clear');
  release(); await wait(10);
  expect(p.flat().map(entry => entry.id)).toEqual(['clear']);
});

test('closing cancels scheduled work, and changed command ownership blocks settled suggestions', async () => {
  const fake = selectedPort(); installJudgmentPort(fake.port);
  const closed = palette(); closed.setQuery('make the dialogue take less room'); closed.onClose();
  await wait(300); expect(fake.requests).toHaveLength(0);
  let active = true; const ran: string[] = [];
  const p = palette({ assertCurrent: () => { if (!active) throw new Error('changed'); }, onRun: entry => { ran.push(entry.id); } });
  p.setQuery('make the dialogue take less room'); await wait(300);
  expect(p.getSelected()?.id).toBe('compact');
  active = false;
  const host = new SurfaceModalHost(); host.push(p);
  host.handleToken({ type: 'key', logicalName: 'enter' } as InputToken);
  expect(ran).toEqual([]);
  expect(p.flat()).toEqual([]);
});
