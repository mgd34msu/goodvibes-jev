/**
 * The Agent as a push destination: what actually lands, and where.
 *
 * The SDK owns the destination, the target parsing and the failure reporting; this
 * file owns the landing. So the properties worth pinning are the ones a wrong
 * landing would break:
 *
 *  - the composed body arrives VERBATIM, and the title is not prepended to it
 *    (docs/occasions.md §4.3, the daemon composes from a day count that never
 *    leaves its own module, and a surface that decorated the sentence would be
 *    re-deciding that rule with worse information);
 *  - an addressed conversation is honoured, and one this runtime does not have
 *    FAILS rather than silently landing in a different conversation the daemon
 *    would then record as delivered;
 *  - a failure throws, which is the contract's honest answer and, for an occasion
 *    push, what leaves the open item unstamped so the pull still raises it.
 */

import { describe, expect, test } from 'bun:test';
import {
  AGENT_CONVERSATION_SENDER_ID,
  createAgentConversationSender,
  installAgentConversationSender,
  type AgentSenderConversation,
} from '../../runtime/agent-conversation-sender.ts';
import type { AgentConversationMessage, AgentConversationSender } from '@goodvibes-jev/engine/sdk/platform/channels';
import { installOccasionsNudging } from '../../runtime/occasions-boot.ts';

const NUDGE_BODY = "Sarah's birthday is coming up. Do you want to sort something for it?";

function conversation(): AgentSenderConversation & { readonly said: string[] } {
  const said: string[] = [];
  return { said, addAssistantMessage: (content: string) => { said.push(content); } };
}

function message(overrides: Partial<AgentConversationMessage> = {}): AgentConversationMessage {
  return {
    title: 'A date is coming up',
    body: NUDGE_BODY,
    jobId: 'occasions',
    runId: 'occasions-1',
    ...overrides,
  } as AgentConversationMessage;
}

describe('agent conversation sender', () => {
  test('it names itself, so the router can report it and refuse a silent takeover', () => {
    const sender = createAgentConversationSender({
      primaryConversation: () => conversation(),
      requestRender: () => undefined,
    });
    expect(sender.id).toBe(AGENT_CONVERSATION_SENDER_ID);
    expect(typeof sender.send).toBe('function');
  });

  test('the body lands verbatim in the primary conversation, and the title is not prepended', async () => {
    const primary = conversation();
    let renders = 0;
    const sender = createAgentConversationSender({
      primaryConversation: () => primary,
      requestRender: () => { renders += 1; },
    });

    await sender.send(message());

    // Equality, not containment: a "A date is coming up:" prefix would be this
    // surface putting words in the assistant's mouth that nothing composed.
    expect(primary.said).toEqual([NUDGE_BODY]);
    expect(primary.said[0]).not.toContain('A date is coming up');
    expect(renders).toBe(1);
  });

  test('no digit can reach the transcript, because the composed body carries none', async () => {
    const primary = conversation();
    const sender = createAgentConversationSender({
      primaryConversation: () => primary,
      requestRender: () => undefined,
    });
    await sender.send(message());
    // Proximity is a WORD. A day count in the landed line is the same defect as
    // a date (§4.3), and the passthrough is what makes it unreachable here.
    expect(/\d/.test(primary.said.join(''))).toBe(false);
  });

  test('an addressed conversationId lands there, not in the primary one', async () => {
    const primary = conversation();
    const addressed = conversation();
    const sender = createAgentConversationSender({
      primaryConversation: () => primary,
      resolveConversation: (id) => (id === 'conv-7' ? addressed : null),
      requestRender: () => undefined,
    });

    await sender.send(message({ conversationId: 'conv-7' }));

    expect(addressed.said).toEqual([NUDGE_BODY]);
    expect(primary.said).toEqual([]);
  });

  test('sessionId is used when no conversationId was given', async () => {
    const primary = conversation();
    const bySession = conversation();
    const sender = createAgentConversationSender({
      primaryConversation: () => primary,
      resolveConversation: (id) => (id === 'session-3' ? bySession : null),
      requestRender: () => undefined,
    });

    await sender.send(message({ sessionId: 'session-3' }));

    expect(bySession.said).toEqual([NUDGE_BODY]);
    expect(primary.said).toEqual([]);
  });

  test('an address this runtime does not have FAILS rather than landing elsewhere', async () => {
    const primary = conversation();
    let renders = 0;
    const sender = createAgentConversationSender({
      primaryConversation: () => primary,
      resolveConversation: () => null,
      requestRender: () => { renders += 1; },
    });

    // Falling back to the primary conversation would put a message meant for one
    // conversation into another, and the daemon would record it as delivered.
    await expect(sender.send(message({ conversationId: 'gone' }))).rejects.toThrow(/no live conversation "gone"/);
    expect(primary.said).toEqual([]);
    expect(renders).toBe(0);
  });

  test('no conversation at all FAILS honestly rather than dropping the message', async () => {
    const sender = createAgentConversationSender({
      primaryConversation: () => null,
      requestRender: () => undefined,
    });
    await expect(sender.send(message())).rejects.toThrow(/no active conversation/);
  });

  test('the primary conversation is read per send, not captured at construction', async () => {
    const first = conversation();
    const second = conversation();
    let current: AgentSenderConversation = first;
    const sender = createAgentConversationSender({
      primaryConversation: () => current,
      requestRender: () => undefined,
    });

    await sender.send(message());
    current = second;
    await sender.send(message({ runId: 'occasions-2' }));

    // A captured reference would pin the conversation this process started with,
    // and every later push would land in a transcript nobody is reading.
    expect(first.said).toEqual([NUDGE_BODY]);
    expect(second.said).toEqual([NUDGE_BODY]);
  });

  test('a non-occasions push lands the same way: this destination is not occasions-specific', async () => {
    const primary = conversation();
    const sender = createAgentConversationSender({
      primaryConversation: () => primary,
      requestRender: () => undefined,
    });
    await sender.send(message({
      title: 'CI is red',
      body: 'The release workflow failed on main.',
      jobId: 'ci-watch',
      runId: 'run-42',
    }));
    expect(primary.said).toEqual(['The release workflow failed on main.']);
  });
});

describe('installing the destination at startup', () => {
  test('it registers on the router and files the undo in the same call', () => {
    const registered: AgentConversationSender[] = [];
    const disposals: Array<() => void> = [];
    let released = 0;
    const router = {
      agentDelivery: {
        register: (sender: AgentConversationSender) => {
          registered.push(sender);
          return () => { released += 1; };
        },
      },
    };

    const sender = installAgentConversationSender({
      router,
      disposals,
      primaryConversation: () => conversation(),
      requestRender: () => undefined,
    });

    expect(registered).toEqual([sender]);
    expect(sender.id).toBe(AGENT_CONVERSATION_SENDER_ID);
    // Filed at the same moment as the registration, not left to a shutdown path
    // to remember: a stale sender pointing at a torn-down conversation would
    // accept a push and drop it.
    expect(disposals).toHaveLength(1);

    disposals[0]!();
    expect(released).toBe(1);
  });

  test('the installed sender is the live one: it lands a body through the same path', async () => {
    const primary = conversation();
    let installed: AgentConversationSender | null = null;
    installAgentConversationSender({
      router: { agentDelivery: { register: (sender) => { installed = sender; return () => undefined; } } },
      disposals: { push: () => undefined },
      primaryConversation: () => primary,
      requestRender: () => undefined,
    });

    expect(installed).not.toBeNull();
    await installed!.send(message());
    expect(primary.said).toEqual([NUDGE_BODY]);
  });
});

describe('installOccasionsNudging wires BOTH halves, so neither can ship alone', () => {
  test('one call registers the push destination and hands back the pull surface', () => {
    // The property this pins is that they arrive together. A change that dropped
    // either half would leave the other looking complete: push-only loses every
    // nudge a failed send would have covered, and pull-only is the pull-only
    // build the SDK seam exists to replace.
    const registered: AgentConversationSender[] = [];
    const disposals: Array<() => void> = [];
    const conv = conversation();

    const pull = installOccasionsNudging({
      router: { agentDelivery: { register: (sender) => { registered.push(sender); return () => undefined; } } },
      gatewayMethods: { hasHandler: () => false } as never,
      configManager: { get: () => true } as never,
      homeDirectory: '/nowhere',
      conversation: conv as never,
      requestRender: () => undefined,
      disposals,
    });

    // Push half: registered, with its undo filed for shutdown.
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe(AGENT_CONVERSATION_SENDER_ID);
    expect(disposals).toHaveLength(1);
    // Pull half: a real surface the caller can fire at a turn boundary.
    expect(typeof pull.raiseNow).toBe('function');
  });
});
