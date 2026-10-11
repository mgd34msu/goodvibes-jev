/** Deterministic configuration/rendering boundaries for the conversation gate.
 * Semantic caller qualification is in conversation-work-readings.test.ts;
 * natural-language fixture expectations belong to the canonical batteries.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONVERSATION_GATE_DEFAULTS,
  CONVERSATION_GATE_DEFAULT_SURFACES,
  isGatedSurface,
  readConversationGateConfig,
  renderWorkProposalMessage,
  summarizeWorkRequest,
  type ConversationGateConfig,
} from '../sdk/src/platform/agents/conversation-gate.ts';

function reader(scalars: Record<string, unknown>, category?: unknown) {
  return {
    get: (key: string) => scalars[key],
    getCategory: () => category,
  };
}

describe('summarizeWorkRequest', () => {
  test('collapses whitespace and stays one short line', () => {
    const summary = summarizeWorkRequest(`fix   the\n\nlogin bug`);
    expect(summary).toBe('fix the login bug');
    expect(summary).not.toContain('\n');
  });

  test('truncates long requests', () => {
    const summary = summarizeWorkRequest('x'.repeat(400));
    expect(summary.length).toBeLessThanOrEqual(90);
  });
});

describe('readConversationGateConfig', () => {
  test('defaults to propose mode: conversation first is the shipped behavior', () => {
    const config = readConversationGateConfig(reader({}));
    expect(config.mode).toBe('propose');
    expect(config).toEqual(CONVERSATION_GATE_DEFAULTS);
  });

  test('reads a configured mode', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.mode': 'off' })).mode).toBe('off');
    expect(readConversationGateConfig(reader({ 'conversationGate.mode': 'confirm-all' })).mode).toBe('confirm-all');
  });

  test('rejects a bogus mode rather than disabling the gate', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.mode': 'nonsense' })).mode).toBe('propose');
  });

  test('clamps the TTL so a proposal can never be unanswerable or immortal', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.proposalTtlMs': 1 })).proposalTtlMs).toBe(60_000);
    expect(readConversationGateConfig(reader({ 'conversationGate.proposalTtlMs': 1e12 })).proposalTtlMs).toBe(24 * 60 * 60_000);
    expect(readConversationGateConfig(reader({ 'conversationGate.proposalTtlMs': Number.NaN })).proposalTtlMs)
      .toBe(CONVERSATION_GATE_DEFAULTS.proposalTtlMs);
  });

  test('clamps the pending cap', () => {
    expect(readConversationGateConfig(reader({ 'conversationGate.maxPendingProposals': 0 })).maxPendingProposals).toBe(1);
    expect(readConversationGateConfig(reader({ 'conversationGate.maxPendingProposals': 9_999 })).maxPendingProposals).toBe(200);
  });

  test('reads gatedSurfaces from the category, and ignores junk entries', () => {
    const config = readConversationGateConfig(reader({}, { gatedSurfaces: ['ntfy', '', 42, 'telegram'] }));
    expect(config.gatedSurfaces).toEqual(['ntfy', 'telegram']);
  });

  test('a throwing config reader falls back to defaults rather than crashing ingress', () => {
    const hostile = {
      get: () => { throw new Error('no such key'); },
      getCategory: () => { throw new Error('no such category'); },
    };
    expect(readConversationGateConfig(hostile)).toEqual(CONVERSATION_GATE_DEFAULTS);
  });
});

describe('isGatedSurface', () => {
  const config: ConversationGateConfig = CONVERSATION_GATE_DEFAULTS;

  test('channel surfaces are gated', () => {
    for (const surface of ['ntfy', 'telegram', 'slack', 'discord', 'homeassistant']) {
      expect(isGatedSurface(config, surface)).toBe(true);
    }
  });

  test('goodvibes-tui is exempt: the operator typed it in front of the terminal', () => {
    expect(isGatedSurface(config, 'tui')).toBe(false);
    expect(isGatedSurface(config, 'local')).toBe(false);
  });

  test('generic webhooks are not gated: a registered webhook is pre-authorized automation', () => {
    expect(isGatedSurface(config, 'webhook')).toBe(false);
  });

  test('an unknown/undeclared surface is gated, so a new adapter cannot silently opt out', () => {
    expect(isGatedSurface(config, undefined)).toBe(true);
  });

  test('email is gated, so a mail adapter written the ordinary way cannot spawn work', () => {
    // The fail-closed rule only covers a surface the gate cannot identify:
    // `undefined` returns true above. 'email' is a known, non-TUI string, so
    // it skips that branch entirely and falls through to
    // `gatedSurfaces.includes(...)`, which was false. An adapter passing
    // `surface: 'email'` would therefore have let any message that reads as a
    // work request spawn an agent immediately, skipping propose-and-wait.
    //
    // Nothing in the inbound-mail design reaches this gate: the watcher is
    // handed a context with no spawn capability in it at all. This covers the
    // person who wires email the ordinary way later, without reading that.
    expect(isGatedSurface(config, 'email')).toBe(true);
    expect(CONVERSATION_GATE_DEFAULT_SURFACES).toContain('email');
  });

  test('mode off disables the gate entirely', () => {
    expect(isGatedSurface({ ...config, mode: 'off' }, 'ntfy')).toBe(false);
  });
});

describe('renderWorkProposalMessage', () => {
  test('is short enough to read on a lock screen and says how to answer', () => {
    const message = renderWorkProposalMessage({ summary: 'fix the login bug', expiresInMs: 30 * 60_000 });
    const lines = message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('fix the login bug');
    expect(message).toContain('yes');
    expect(message).toContain('30m');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });
});
