import { expect, test } from 'bun:test';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import type { ProductInputContext } from '../../runtime/native-conversation-input.ts';

test('composer transports the exact source separately from expanded derived text', () => {
  const raw = '  Explain !@source.ts [TEXT: p1, 9 lines] [IMAGE: img1, clipboard, 2KB]  ';
  let submitted: { text: string; context?: ProductInputContext } | undefined;
  const state = {
    prompt: raw, cursorPos: raw.length, inputScrollTop: 0, commandMode: false, indicatorFocused: false,
    inputHistory: null, commandContext: { submitInput: (text: string, _content: unknown, context?: ProductInputContext) => { submitted = { text, context }; } },
    expandPrompt: (text: string) => { expect(text).toBe(raw.trim()); return 'derived expansion'; },
    requestRender: () => {},
  } as unknown as KeyRouteState;
  const result = handlePromptKeyToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
  expect(result.prompt).toBe(''); expect(submitted?.text).toBe('derived expansion');
  expect(submitted?.context?.source?.text).toBe(raw);
  expect(submitted?.context?.source?.unsupportedSources.map(ref => ref.kind)).toEqual(['context', 'image', 'file']);
});
test('concealed input exits before source capture, expansion or durable submission', () => {
  let expanded = false; let submitted = false;
  const state = { prompt: 'secret', cursorPos: 6, inputScrollTop: 0, commandMode: false, indicatorFocused: false,
    submitConcealedInput: () => true, requestRender: () => {}, expandPrompt: () => { expanded = true; return ''; },
    commandContext: { submitInput: () => { submitted = true; } },
  } as unknown as KeyRouteState;
  handlePromptKeyToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false });
  expect(expanded).toBe(false); expect(submitted).toBe(false);
});
