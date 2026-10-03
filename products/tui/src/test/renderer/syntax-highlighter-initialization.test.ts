import { expect, spyOn, test } from 'bun:test';
import { TreeSitterService } from '@goodvibes-jev/engine/sdk/platform/intelligence';
import { SyntaxHighlighter } from '../../renderer/syntax-highlighter.ts';
import { syntaxStyles } from '../../renderer/syntax-theme.ts';

test('settling a cold highlighter waits for initialization before loading or parsing', async () => {
  // Warm the shared WASM runtime but hold the new service's own parser. The
  // grammar can then load while initialization is pending, reproducing the
  // startup race without depending on machine speed or a timed sleep.
  const bootstrap = new TreeSitterService();
  await bootstrap.initialize();
  const realInitialize = TreeSitterService.prototype.initialize;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const initialization = new Map<TreeSitterService, Promise<void>>();
  const initialize = spyOn(TreeSitterService.prototype, 'initialize').mockImplementation(function (this: TreeSitterService) {
    let pending = initialization.get(this);
    if (!pending) {
      pending = gate.then(() => realInitialize.call(this));
      initialization.set(this, pending);
    }
    return pending;
  });
  const loadLanguage = spyOn(TreeSitterService.prototype, 'loadLanguage');
  const parse = spyOn(TreeSitterService.prototype, 'parse');
  const highlighter = new SyntaxHighlighter();
  const code = ['export interface RetryOptions { attempts: number; }', 'export const retries = 3;'];
  let ready = 0;
  const off = highlighter.onReady(() => { ready++; });
  let settled = false;
  for (const block of code) expect(highlighter.highlight(block, 'ts')).toBeNull();
  const settling = highlighter.settle().then(() => { settled = true; });
  try {
    // Cross the render's microtask turn; there is deliberately no elapsed-time
    // requirement. Pending initialization must block grammar loading itself.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(loadLanguage).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    release();
    await settling;
    expect(highlighter.cacheSize).toBe(2);
    expect(ready).toBe(2);
    const tokens = highlighter.highlight(code[0]!, 'ts');
    expect(tokens).not.toBeNull();
    expect(tokens![0]!.map((token) => token.text).join('')).toBe(code[0]);
    expect(tokens![0]!.find((token) => token.text === 'export')?.fg).toBe(syntaxStyles().keyword.fg);
    // The space whose missing foreground broke the open-bead golden is plain.
    expect(tokens![0]!.find((token) => token.text === ' ')?.fg).toBe(syntaxStyles().plain.fg);
    const misses = highlighter.missCount;
    for (const block of code) expect(highlighter.highlight(block, 'ts')).not.toBeNull();
    await highlighter.settle();
    expect(highlighter.missCount).toBe(misses);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(ready).toBe(2);
  } finally {
    release();
    await settling;
    await Promise.all(initialization.values());
    off();
    initialize.mockRestore();
    loadLanguage.mockRestore();
    parse.mockRestore();
    for (const service of initialization.keys()) service.dispose();
    bootstrap.dispose();
  }
});

test('initialization rejection settles to fallback without rescheduling the failed block', async () => {
  const initialize = spyOn(TreeSitterService.prototype, 'initialize').mockRejectedValue(new Error('initialization unavailable'));
  const loadLanguage = spyOn(TreeSitterService.prototype, 'loadLanguage');
  const highlighter = new SyntaxHighlighter();
  try {
    highlighter.highlight('export const unavailable = 1;', 'ts');
    await highlighter.settle();
    expect(loadLanguage).not.toHaveBeenCalled();
    expect(highlighter.cacheSize).toBe(0);
    const misses = highlighter.missCount;
    expect(highlighter.highlight('export const unavailable = 1;', 'ts')).toBeNull();
    await highlighter.settle();
    expect(highlighter.missCount).toBe(misses);
    expect(highlighter.generation).toBe(0);
  } finally {
    initialize.mockRestore();
    loadLanguage.mockRestore();
  }
});

test('an unavailable grammar still settles to fallback without repeated parse attempts', async () => {
  const highlighter = new SyntaxHighlighter();
  const code = 'fn main() {}'; // supported fence, but no embedded Rust grammar
  highlighter.highlight(code, 'rust');
  await highlighter.settle();
  const misses = highlighter.missCount;
  expect(highlighter.highlight(code, 'rust')).toBeNull();
  await highlighter.settle();
  expect(highlighter.cacheSize).toBe(0);
  expect(highlighter.missCount).toBe(misses);
});
