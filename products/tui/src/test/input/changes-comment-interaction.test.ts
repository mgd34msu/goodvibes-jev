import { describe, test, expect } from 'bun:test';
import { ChangesModal } from '../../input/changes-modal.ts';
import { parseChanges } from '../../input/changes-model.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts', '+++ b/src/app.ts',
  '@@ -10,3 +10,4 @@ function greet() {',
  ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;',
  '@@ -40,2 +41,2 @@ function bye() {', ' keep();', '-old();', '+neo();', '',
].join('\n');
const ENTER = { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false } as const;
function fixture(mode: 'workspace' | 'preview' = 'workspace', withSubmit = true) {
  const host = new SurfaceModalHost();
  const sent: Array<{ text: string; hostActive: boolean }> = [];
  const modal = new ChangesModal({
    workingDirectory: '/nonexistent/changes-public-interaction-fixture',
    getSessionFiles: () => [],
    requestRender: () => {},
    submitInput: withSubmit ? (text) => sent.push({ text, hostActive: host.active }) : undefined,
  }, mode);
  // Existing golden tests use these public data fields. No reload, git, private API, or semantic parser.
  modal.files = parseChanges(DIFF);
  modal.source = 'session';
  modal.label = 'this session · 1 file vs HEAD';
  host.push(modal);
  const text = (value: string) => host.handleToken({ type: 'text', value });
  const attach = (value: string) => { text('c'); text(value); host.handleToken(ENTER); };
  return { host, modal, sent, text, attach };
}

describe('Changes review comments through the public modal host', () => {
  test('Enter attaches and exits composer; second Enter submits after close', () => {
    const { host, modal, sent, attach } = fixture();
    attach('rename b');
    expect([...modal.comments.values()].map(c => ({ text: c.text, sent: c.sent }))).toEqual([{ text: 'rename b', sent: false }]);
    // This is the intended public flow, not an assertion accepting the observed bug.
    expect(modal.composing).toBeNull();
    host.handleToken(ENTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.hostActive).toBe(false);
    expect(sent[0]!.text).toContain('rename b');
  });

  test('second Enter must reach submitInput without an extra Escape', () => {
    const { host, sent, attach } = fixture();
    attach('rename b');
    host.handleToken(ENTER);
    expect(sent).toHaveLength(1);
    expect(host.active).toBe(false);
  });

  test('public Enter supports batched send and duplicate suppression', () => {
    const { host, modal, sent, text, attach } = fixture();
    attach('first');
    text(']');
    attach('second');
    expect([...modal.comments.values()].map(c => c.sent)).toEqual([false, false]);
    host.handleToken(ENTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.hostActive).toBe(false);
    expect(sent[0]!.text).toContain('2 hunks');
    expect(sent[0]!.text).toContain('first');
    expect(sent[0]!.text).toContain('second');
    expect(sent[0]!.text).toContain('src/app.ts');
    expect(sent[0]!.text).toContain('lines 10-13');
    expect(sent[0]!.text).toContain('lines 41-42');
    expect([...modal.comments.values()].map(c => c.sent)).toEqual([true, true]);
    host.push(modal); // production retains the same workspace modal across close/open
    host.handleToken(ENTER);
    expect(sent).toHaveLength(1);
    expect(modal.status?.text).toContain('No comments to send');
  });

  test('rendered view uses canonical source; submitted message retains exact loaded source label', () => {
    const { host, modal, sent, attach } = fixture();
    expect(layerTextBlock(modal.render(120, 40))).toContain('this session');
    attach('source proof');
    host.handleToken(ENTER);
    expect(sent[0]!.text).toContain('this session · 1 file vs HEAD');
    expect(sent[0]!.text).toContain('source proof');
  });

  test('empty loaded label uses selected source label in submitted message', () => {
    const { host, modal, sent, attach } = fixture();
    modal.label = '';
    modal.source = 'working';
    expect(layerTextBlock(modal.render(120, 40))).toContain('not staged');
    attach('fallback proof');
    host.handleToken(ENTER);
    expect(sent[0]!.text).toContain('not staged');
  });

  test('sending keeps comments unsent and the modal open', () => {
    const { host, modal, sent, attach } = fixture('workspace', false);
    attach('keep me');
    host.handleToken(ENTER);
    expect(sent).toHaveLength(0);
    expect(host.active).toBe(true);
    expect([...modal.comments.values()].map(c => c.sent)).toEqual([false]);
    expect(modal.status?.text).toContain('No session is wired');
  });

  test('comment and send commands are deliberately unavailable', () => {
    const { host, modal, sent, text } = fixture('preview');
    text('c');
    host.handleToken(ENTER);
    expect(modal.composing).toBeNull();
    expect(modal.comments.size).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

test('rapid text and repeated Enter retain modal keyboard ownership and submit once', () => {
  const { host, modal, sent, text } = fixture();
  text('c'); text('j'); text('k'); text(']'); text('rapid');
  expect(modal.selected).toBe(0); expect(modal.hunkIndex).toBe(0);
  expect(modal.composing).toBe('jk]rapid');
  expect(host.handleToken(ENTER)).toBe(true);
  expect(sent).toHaveLength(0); expect(host.active).toBe(true);
  expect(host.handleToken(ENTER)).toBe(true);
  expect(sent).toHaveLength(1); expect(sent[0]?.text).toContain('jk]rapid');
  expect(host.handleToken(ENTER)).toBe(false);
  expect(sent).toHaveLength(1);
});

test('Escape cancels only the draft, then closes; reopening cannot send cancelled text', () => {
  const { host, modal, sent, text } = fixture();
  text('c'); text('cancel this');
  expect(host.escape()).toBe(true);
  expect(modal.composing).toBeNull(); expect(host.active).toBe(true);
  expect(modal.comments.size).toBe(0);
  expect(host.escape()).toBe(true); expect(host.active).toBe(false);
  host.push(modal); host.handleToken(ENTER);
  expect(sent).toHaveLength(0); expect(host.active).toBe(true);
});

test('re-editing one attached hunk replaces its draft and close/reopen preserves one pending comment', () => {
  const { host, modal, sent, text, attach } = fixture();
  attach('first'); text('c');
  for (let i = 0; i < 5; i++) host.handleToken({ ...ENTER, name: 'backspace', logicalName: 'backspace' });
  text('replacement'); host.handleToken(ENTER);
  expect(modal.comments.size).toBe(1);
  expect(host.escape()).toBe(true); expect(host.active).toBe(false);
  host.push(modal); host.handleToken(ENTER);
  expect(sent).toHaveLength(1); expect(sent[0]?.text).toContain('replacement');
  expect(sent[0]?.text).not.toContain('first');
  host.push(modal); host.handleToken(ENTER); expect(sent).toHaveLength(1);
});

test('blank comment commits no attachment and exits text entry without sending', () => {
  const { host, modal, sent, attach } = fixture();
  attach('  '); expect(modal.composing).toBeNull(); expect(modal.comments.size).toBe(0);
  host.handleToken(ENTER); expect(sent).toHaveLength(0); expect(host.active).toBe(true);
});

test('the shared text-entry helper completes a cancelled commit prompt once without a git mutation', async () => {
  const host = new SurfaceModalHost();
  const confirmations: string[] = [];
  const modal = new ChangesModal({
    workingDirectory: '/nonexistent/changes-commit-confirm-fixture', getSessionFiles: () => [], requestRender: () => {},
    confirm: async (options) => { confirmations.push(options.body ?? ''); return false; },
  });
  modal.summary = { branch: 'fixture', staged: 1, unstaged: 0 };
  host.push(modal);
  host.handleToken({ type: 'text', value: 'C' });
  host.handleToken({ type: 'text', value: 'synthetic commit' });
  host.handleToken(ENTER); host.handleToken(ENTER);
  await Promise.resolve();
  expect(confirmations).toEqual(['synthetic commit']);
  expect(modal.commitDraft).toBeNull();
  expect(modal.status?.text).toContain('Commit cancelled');
  expect(host.active).toBe(true);
});
