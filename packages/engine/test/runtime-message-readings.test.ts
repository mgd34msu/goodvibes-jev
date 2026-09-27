/**
 * The runtime's message readings: pending approvals in the session return
 * summary, setup replies that hand over a command, and system message
 * priority, all read through a fake judgment port; and the system message
 * kind, which is a lookup over fixed bracket tags.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import type { ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.ts';
import {
  buildLocalReturnContextSummary,
  buildPersistedSessionContext,
} from '../sdk/src/platform/runtime/session-return-context.ts';
import { mentionsUserTypedCommand } from '../sdk/src/platform/runtime/setup-contract.ts';
import { setupReplyCommand } from '../sdk/src/platform/runtime/batteries/setup-reply-command.ts';
import {
  classifySystemMessageKind,
  classifySystemMessagePriority,
  defaultSystemMessageTarget,
} from '../sdk/src/platform/runtime/system-message-policy.ts';
import { voiceSetupStepMentionsUserCommand } from '../sdk/src/platform/voice/setup-chain.ts';
import { namedCommandsAndKeys } from './_helpers/setup-vocabulary.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

const system = (content: string): ConversationMessageSnapshot => ({ role: 'system', content } as ConversationMessageSnapshot);
const user = (content: string): ConversationMessageSnapshot => ({ role: 'user', content } as ConversationMessageSnapshot);

describe('pending approvals in the return summary', () => {
  /** Reads a message as pending when it contains `waiting`, with the given strength. */
  function approvalsPort(strength = 0.95) {
    return fakePort((_name: string, _question: Question, state: unknown) => noulAnswer(String(state).includes('waiting') ? strength : 0.03));
  }

  test('each system message is read once and the yes readings are counted', async () => {
    const { port, requests } = approvalsPort();
    installJudgmentPort(port);
    const summary = await buildLocalReturnContextSummary([
      user('ship it'),
      system('[Approval] exec git push is waiting for your decision'),
      system('[Approval] Allowed exec: bun test'),
      system('[Approval] edit src/a.ts is waiting'),
      system('   '),
    ]);
    expect(summary.pendingApprovals).toBe(2);
    expect(summary.lines).toContain('Pending approvals spotted: 2');
    expect(requests.map((request) => request.state)).toEqual([
      '[Approval] exec git push is waiting for your decision',
      '[Approval] Allowed exec: bun test',
      '[Approval] edit src/a.ts is waiting',
    ]);
  });

  test('a weak yes is not counted', async () => {
    installJudgmentPort(approvalsPort(0.57).port);
    const summary = await buildLocalReturnContextSummary([system('[Approval] waiting')]);
    expect(summary.pendingApprovals).toBe(0);
  });

  test('a structured count from the host is used as is, with no reading', async () => {
    const { port, requests } = approvalsPort();
    installJudgmentPort(port);
    const context = await buildPersistedSessionContext([system('[Approval] waiting')], undefined, { pendingApprovals: 4 });
    expect(context.returnContext?.pendingApprovals).toBe(4);
    expect(requests).toHaveLength(0);
  });

  test('reading with no port installed throws', async () => {
    await expect(buildLocalReturnContextSummary([system('[Approval] waiting')])).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('setup replies that hand over a command', () => {
  function replyPort(verdict: number) {
    return fakePort(() => noulAnswer(verdict));
  }

  test('the reply is sent as `{ reply }` and a strong yes flags it', async () => {
    const { port, requests } = replyPort(0.95);
    installJudgmentPort(port);
    expect(await mentionsUserTypedCommand('Run /voice setup to provision the managed local runtime.')).toBe(true);
    expect(requests[0]?.state).toEqual({ reply: 'Run /voice setup to provision the managed local runtime.' });
    expect(await voiceSetupStepMentionsUserCommand('/voice wake setup')).toBe(true);
  });

  test('a no or a weak yes does not flag it', async () => {
    installJudgmentPort(replyPort(0.03).port);
    expect(await mentionsUserTypedCommand('Wake-word detection is on and this surface is listening.')).toBe(false);
    installJudgmentPort(replyPort(0.57).port);
    expect(await mentionsUserTypedCommand('Wake-word detection is on and this surface is listening.')).toBe(false);
  });

  test('reading with no port installed throws', async () => {
    await expect(mentionsUserTypedCommand('/voice wake setup')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('the shapes that actually shipped are calibrated fixtures with their answers', () => {
    const calibrated = new Map(setupReplyCommand.fixtures.map((fixture) => [(fixture.state as { reply: string }).reply, fixture.expect.instructs]));
    expect(calibrated.get('Run /voice setup to provision the managed local runtime.')).toBe('yes');
    expect(calibrated.get('set voice.wake.surfaces.agent to true')).toBe('yes');
    expect(calibrated.get('/voice wake setup')).toBe('yes');
    expect(calibrated.get('Hand both values over with: /google client <id> <secret>')).toBe('yes');
    expect(calibrated.get('Wake-word detection is on and this surface is listening.')).toBe('no');
    expect(calibrated.get('Downloaded from https://example.com/model.onnx')).toBe('no');
  });

  test('the vocabulary check the product-text tests use finds commands and keys, not URLs or paths', () => {
    expect(namedCommandsAndKeys('Hand both values over with: /google client <id> <secret>', ['/google'])).toEqual(['/google']);
    expect(namedCommandsAndKeys('set voice.wake.surfaces.agent to true', ['/voice'])).toEqual(['voice.wake.surfaces.agent']);
    expect(namedCommandsAndKeys('Publish it at https://console.cloud.google.com/google/audience', ['/google'])).toEqual([]);
    expect(namedCommandsAndKeys('Installed under $HOME/google-cloud-sdk/bin', ['/google'])).toEqual([]);
  });
});

describe('system message priority', () => {
  function priorityPort(choice: 'high' | 'low', confidence: number) {
    return fakePort((_name: string, question: Question) => choiceAnswer(question, choice, confidence));
  }

  test('a strong reading decides the priority', async () => {
    const { port, requests } = priorityPort('high', 0.95);
    installJudgmentPort(port);
    expect(await classifySystemMessagePriority('[Recovery] Failed to restore: disk error')).toBe('high');
    expect(requests[0]?.state).toBe('[Recovery] Failed to restore: disk error');
    installJudgmentPort(priorityPort('low', 0.95).port);
    expect(await classifySystemMessagePriority('[Scan] Found llama-server at 192.168.1.20:8080 (3 models)')).toBe('low');
  });

  test('a weak high reading stays at the routine level', async () => {
    installJudgmentPort(priorityPort('high', 0.4).port);
    expect(await classifySystemMessagePriority('[Session] Saved session abc123')).toBe('low');
  });

  test('reading with no port installed throws', async () => {
    await expect(classifySystemMessagePriority('[Compaction] Compacted context')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('system message kind', () => {
  test('operational tags, in any case', () => {
    for (const tag of ['Scan', 'Local', 'Agents', 'MCP', 'Plugin', 'Hook', 'Tool', 'Exec', 'Remote', 'Bridge', 'Approval']) {
      expect(classifySystemMessageKind(`[${tag}] something happened`)).toBe('operational');
      expect(classifySystemMessageKind(`[${tag.toUpperCase()}] something happened`)).toBe('operational');
    }
  });

  test('contract runner and review workflow tags are the contract kind, delivered to both', () => {
    expect(classifySystemMessageKind('[Contract] c-12 passed: all criteria met')).toBe('contract');
    expect(classifySystemMessageKind('[WRFC] Chain 3f9a2c1b77e0 started: add export')).toBe('contract');
    expect(defaultSystemMessageTarget('contract')).toBe('both');
  });

  test('untagged, unknown and non-leading tags are system, delivered to the panel', () => {
    expect(classifySystemMessageKind('Context usage is at 82%')).toBe('system');
    expect(classifySystemMessageKind('[Session] Saved session abc123')).toBe('system');
    expect(classifySystemMessageKind('note: [Scan] found nothing')).toBe('system');
    expect(classifySystemMessageKind('[] empty tag')).toBe('system');
    expect(classifySystemMessageKind('[constructor] not a tag')).toBe('system');
    expect(defaultSystemMessageTarget('system')).toBe('panel');
    expect(defaultSystemMessageTarget('operational')).toBe('panel');
  });
});
