import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { NativeHostedSessionLookup } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import type { ComponentProps } from 'react';
import type { NativeIntakeForm } from '../work/NativeIntakeForm';
import { getClientLifetime, invalidateClientLifetime } from '../../lib/client-lifetime';
import { nativeSelectedDiffRevision } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { parseUnifiedDiff } from '../../lib/unified-diff';

let discovered: () => Promise<NativeHostedSessionLookup>;
const discoveries: string[] = [];
const nativeForms: ComponentProps<typeof NativeIntakeForm>[] = [];
mock.module('../../lib/native-session', () => ({ inspectNativeSession: (_lifetime: unknown, sessionId: string) => { discoveries.push(sessionId); return discovered(); } }));
mock.module('../work/NativeIntakeForm', () => ({ NativeIntakeForm: (props: ComponentProps<typeof NativeIntakeForm>) => { nativeForms.push(props); return <div data-native-form="" />; } }));
const { SessionHunkComment } = await import('./SessionHunkComment');
const roots: { root: Root; container: HTMLElement }[] = [];
const original = 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n--- old heading\n+++ new heading\n';
const originalRevision = await nativeSelectedDiffRevision(original);
const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 0)); flushSync(() => {}); } };
function render(overrides: Partial<ComponentProps<typeof SessionHunkComment>> = {}) {
  const file = parseUnifiedDiff(original)[0];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); roots.push({ root, container });
  let cancel = 0, sent = 0;
  const props: ComponentProps<typeof SessionHunkComment> = {
    open: true, sessionId: 'native-session', closed: false, filePath: file.path, hunk: file.hunks[0],
    capturedLabel: 'Session-stamped checkpoints', mode: 'steer', pending: false,
    selection: { kind: 'session', unifiedDiff: original, revision: originalRevision, fileIndex: 0, hunkIndex: 0 },
    onCancel: () => { cancel++; flushSync(() => root.render(null)); }, onSubmit: () => { sent++; }, ...overrides,
  };
  flushSync(() => root.render(<SessionHunkComment {...props} />));
  return { root, props, cancel: () => cancel, sent: () => sent };
}
beforeEach(() => {
  discovered = async () => ({ kind: 'native', sessionId: 'native-session', projectId: 'native-project', busy: false });
  discoveries.length = 0; nativeForms.length = 0;
});
afterEach(() => { for (const { root, container } of roots.splice(0)) { flushSync(() => root.unmount()); container.remove(); } });

test('native sheet binds the exact full selection separately and never mounts the legacy composer', async () => {
  render(); await tick();
  expect(discoveries).toEqual(['native-session']);
  expect(document.querySelector('.hunk-sheet__input')).toBeNull();
  expect(document.querySelector('[aria-label="Selected change"]')?.textContent).toBe(original);
  expect(nativeForms.at(-1)).toEqual({ lifetime: getClientLifetime(), continuationSessionId: 'native-session', projectId: 'native-project', closed: false,
    selectedDiff: { kind: 'session', revision: await nativeSelectedDiffRevision(original), fileIndex: 0, hunkIndex: 0 } });
});

test('only explicit legacy discovery mounts the unchanged trimmed comment composer', async () => {
  discovered = async () => ({ kind: 'legacy' }); const view = render(); await tick();
  expect(nativeForms).toHaveLength(0);
  expect(document.querySelector('.hunk-sheet__input')).not.toBeNull();
  expect(view.sent()).toBe(0);
});

test('failed classification never falls back and Close fences late native verification', async () => {
  discovered = async () => { throw new Error('Pairing owner changed'); };
  const failed = render(); await tick();
  expect(document.body.textContent).toContain('Pairing owner changed');
  expect(document.querySelector('.hunk-sheet__input')).toBeNull();
  expect(nativeForms).toHaveLength(0);
  flushSync(() => failed.root.render(null));
  const wait = pending<NativeHostedSessionLookup>(); discovered = () => wait.promise;
  const view = render();
  const close = [...document.querySelectorAll('button')].find(button => button.textContent === 'Close')!;
  flushSync(() => close.click());
  wait.resolve({ kind: 'native', sessionId: 'native-session', projectId: 'native-project', busy: false }); await tick();
  expect(view.cancel()).toBe(1); expect(nativeForms).toHaveLength(0); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('connection replacement closes the old boundary and refuses to adopt its selected diff', async () => {
  const wait = pending<NativeHostedSessionLookup>(); discovered = () => wait.promise;
  render(); flushSync(() => invalidateClientLifetime()); await tick();
  wait.resolve({ kind: 'legacy' }); await tick();
  expect(document.querySelector('.hunk-sheet__input')).toBeNull(); expect(nativeForms).toHaveLength(0);
  expect(document.body.textContent).toContain('select the change again');
  expect(discoveries).toHaveLength(1);
});

test('workspace fallback keeps its distinct baseline and closed state', async () => {
  render({ closed: true, selection: { kind: 'workspace', baselineId: 'checkpoint-base', unifiedDiff: original, revision: originalRevision, fileIndex: 0, hunkIndex: 0 } }); await tick();
  expect(nativeForms.at(-1)).toMatchObject({ closed: true, selectedDiff: { kind: 'workspace', baselineId: 'checkpoint-base' } });
});

test('native preparation refuses a mismatched display or incomplete hunk rather than sending manufactured context', async () => {
  render({ filePath: 'wrong.txt' }); await tick();
  expect(nativeForms).toHaveLength(0); expect(document.body.textContent).toContain('Nothing was sent');
  expect(document.body.textContent).toContain('no longer matches');
});

test('complete selected native hunk remains visible beyond the legacy forty-line excerpt cap', async () => {
  const large = `diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -0,0 +1,80 @@\n${Array.from({ length: 80 }, (_, i) => `+unique line ${i + 1}`).join('\n')}\n`;
  const file = parseUnifiedDiff(large)[0];
  render({ filePath: file.path, hunk: file.hunks[0], selection: { kind: 'session', unifiedDiff: large, revision: await nativeSelectedDiffRevision(large), fileIndex: 0, hunkIndex: 0 } }); await tick();
  expect(document.querySelector('[aria-label="Selected change"]')?.textContent).toBe(large);
  expect(nativeForms).toHaveLength(1);
  expect(document.body.textContent).not.toContain('truncated');
});

test('selection stays exact for an early hunk after a binary file and a later hunk', async () => {
  const binary = 'diff --git a/picture.png b/picture.png\nBinary files a/picture.png and b/picture.png differ\n';
  const multiple = binary + original + '@@ -10 +10 @@\n-later old\n+later new\n';
  const file = parseUnifiedDiff(multiple)[1];
  render({ filePath: file.path, hunk: file.hunks[0], selection: { kind: 'session', unifiedDiff: multiple, revision: await nativeSelectedDiffRevision(multiple), fileIndex: 1, hunkIndex: 0 } }); await tick();
  expect(nativeForms.at(-1)?.selectedDiff).toMatchObject({ fileIndex: 1, hunkIndex: 0 });
  expect(document.querySelector('[aria-label="Selected change"]')?.textContent).toBe(original);
});

test('a native host that cannot identify the selected diff never receives a fabricated revision', async () => {
  render({ selection: { kind: 'session', unifiedDiff: original, fileIndex: 0, hunkIndex: 0 } }); await tick();
  expect(document.body.textContent).toContain('host did not provide a source revision');
  expect(nativeForms).toHaveLength(0);
  expect(document.querySelector('.hunk-sheet__input')).toBeNull();
});
