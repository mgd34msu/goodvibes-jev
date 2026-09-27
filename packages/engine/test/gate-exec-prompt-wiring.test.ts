// Ported from goodvibes-agent src/test/runtime/exec-prompt-wiring.test.ts.
//
// exec-interactive.test.ts already covers the answer path (a typed answer
// feeds the run, a denial or an answer-less approval declines). These are the
// agent test's remaining assertions: what the broker is handed for a terminal
// prompt, and that a non-string answer is never coerced into input.
import { describe, expect, test } from 'bun:test';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.ts';
import { buildExecPromptAnswerHandler } from '../sdk/src/platform/runtime/permissions/exec-prompt-wiring.ts';

const ASK = {
  command: 'ssh build-host',
  prompt: 'Are you sure you want to continue connecting (yes/no)?',
  recentOutput: 'The authenticity of host build-host cannot be established.',
  workingDirectory: '/tmp/project',
} as const;

function makeHandler(decide: (request: PermissionPromptRequest) => PermissionPromptDecision) {
  const seen: { request: PermissionPromptRequest; metadata?: Record<string, unknown> | undefined }[] = [];
  const handler = buildExecPromptAnswerHandler({
    requestApproval: async (input) => {
      seen.push(input);
      return decide(input.request);
    },
  });
  return { handler, seen };
}

describe('buildExecPromptAnswerHandler: what the broker is asked', () => {
  test('a terminal prompt is an execute-category exec-prompt ask carrying its source', async () => {
    const { handler, seen } = makeHandler(() => ({ approved: false }));
    await handler(ASK);
    expect(seen).toHaveLength(1);
    const { request, metadata } = seen[0]!;
    expect(request.tool).toBe('exec:prompt');
    expect(request.category).toBe('execute');
    expect(request.analysis?.classification).toBe('exec-terminal-prompt');
    expect(request.workingDirectory).toBe('/tmp/project');
    expect(request.attribution).toEqual({ kind: 'exec-prompt', command: ASK.command, prompt: ASK.prompt });
    expect(metadata).toEqual({ source: 'exec-prompt', command: ASK.command });
  });

  test('a non-string answer declines rather than coercing', async () => {
    const { handler } = makeHandler(() => ({ approved: true, modifiedArgs: { answer: 42 } }));
    await expect(handler(ASK)).resolves.toEqual({ answered: false });
  });
});
