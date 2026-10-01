import { describe, expect, test } from 'bun:test';
import { submitPlanningAnswerWithShellFallback } from '../../runtime/bootstrap-shell.ts';

describe('bootstrap shell planning answer route', () => {
  test('submits immediately when the prompt route is attached', () => {
    const submitted: string[] = [];
    const messages: string[] = [];

    submitPlanningAnswerWithShellFallback('Use the recommended scope.', {
      getSubmitInput: () => (answer) => submitted.push(answer),
      addSystemMessage: (message) => messages.push(message),
      requestRender: () => messages.push('render'),
      defer: (callback) => callback(),
    });

    expect(submitted).toEqual(['Use the recommended scope.']);
    expect(messages).toEqual([]);
  });

  test('retries once before showing a recoverable planning message', () => {
    const submitted: string[] = [];
    const messages: string[] = [];
    let submitAttached = false;

    submitPlanningAnswerWithShellFallback('Only the Agent setup flow.', {
      getSubmitInput: () => submitAttached
        ? (answer) => submitted.push(answer)
        : undefined,
      addSystemMessage: (message) => messages.push(message),
      requestRender: () => messages.push('render'),
      defer: (callback) => {
        submitAttached = true;
        callback();
      },
    });

    expect(submitted).toEqual(['Only the Agent setup flow.']);
    expect(messages).toEqual([]);
  });

  test('does not throw when the prompt route never attaches', () => {
    const submitted: string[] = [];
    const messages: string[] = [];

    submitPlanningAnswerWithShellFallback('Need a smaller plan.', {
      getSubmitInput: () => undefined,
      addSystemMessage: (message) => messages.push(message),
      requestRender: () => messages.push('render'),
      defer: (callback) => callback(),
    });

    expect(submitted).toEqual([]);
    expect(messages.join('\n')).toContain('prompt route is not ready');
    expect(messages.join('\n')).toContain('Need a smaller plan.');
    expect(messages).toContain('render');
  });
});
