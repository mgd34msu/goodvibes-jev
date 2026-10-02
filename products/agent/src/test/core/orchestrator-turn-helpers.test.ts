import { fakePort, choiceAnswer, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { prepareConversationForTurn } from '@goodvibes-jev/engine/sdk/platform/core';

const providerRegistry = {
  getCurrentModel: () => ({
    id: 'mock-model',
    provider: 'mock',
    registryKey: 'mock:mock-model',
    displayName: 'Mock',
    description: '',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
  }),
};

let restorePort: (() => void) | undefined;
afterEach(() => { restorePort?.(); restorePort = undefined; });
function readPlanning(needsPlan: boolean): void {
  const fake = fakePort((name, question) => {
    if (name === 'intent') return choiceAnswer(question, needsPlan ? 'project' : 'task', 0.99);
    if (name === 'needs_plan') return noulAnswer(needsPlan ? 0.99 : 0.01);
    if (name === 'risk') return scoreAnswer(question, 1, 0.99);
    throw new Error(`Unexpected turn judgment: ${name}`);
  });
  const previous = installJudgmentPort(fake.port);
  restorePort = () => { installJudgmentPort(previous); };
}

describe('prepareConversationForTurn', () => {
  test('does not inject project mode for long single-task implementation prompts', async () => {
    readPlanning(false);
    const conversation = new ConversationManager(() => 80);
    await prepareConversationForTurn(
      conversation,
      providerRegistry,
      'Update src/runtime/bootstrap.ts so the session restore path preserves the current provider selection, retains the existing lifecycle hooks, and keeps the shutdown semantics intact. This should be a single focused change in one source area with careful handling of the current bootstrap flow and no architectural planning output.',
      undefined,
      'session-1',
      null,
    );

    const messages = conversation.getMessageSnapshot();
    const projectModeMessages = messages.filter((message) => (
      message.role === 'system' && message.content.includes('[Project mode]')
    ));
    expect(projectModeMessages).toEqual([]);
  });

  test('injects project mode when the prompt clearly signals multi-step project work', async () => {
    readPlanning(true);
    const conversation = new ConversationManager(() => 80);
    await prepareConversationForTurn(
      conversation,
      providerRegistry,
      'Design the architecture for a new plugin system. Create the operator contract updates, implement the runtime integration, and add the release-gate coverage. Run the work in phases and keep the execution plan updated as each milestone lands.',
      undefined,
      'session-2',
      null,
    );

    // Canonical plan priming is a retained system instruction, emitted only
    // after the explicit planning reading reaches its act threshold.
    const messages = conversation.getMessageSnapshot();
    expect(messages.filter((message) => message.role === 'system' && message.content.includes('[Project mode]'))).toHaveLength(1);
  });
});
