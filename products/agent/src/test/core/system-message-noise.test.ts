import { describe, expect, test } from 'bun:test';
import {
  classifyNoise,
  foldProviderReplayLines,
  providerNameFromReplay,
} from '../../core/system-message-noise.ts';

describe('system-message noise classifier', () => {
  test('1b: provider "from last session" replay lines fold', () => {
    const msg = '[Local] ollama at localhost:11434 (2 models) — from last session';
    expect(classifyNoise(msg, {}).action).toBe('foldProviderReplay');
  });

  test('1b: a live [Local] line (not a replay) still emits', () => {
    expect(classifyNoise('[Local] ollama at localhost:11434 (2 models)', {}).action).toBe('emit');
  });

  test('1d: periodic "[Agents] N running:" snapshot is dropped', () => {
    expect(classifyNoise('[Agents] 3 running:\n  abc12345: Turn 2 · Thinking…', {}).action).toBe('drop');
  });

  test('1d: meaningful [Agents] lifecycle lines still emit', () => {
    expect(classifyNoise('[Agents] ✓ abc12345 completed', {}).action).toBe('emit');
    expect(classifyNoise('[Agents] Cohort finished: 3 ok', {}).action).toBe('emit');
  });

  test('1c: [Replay] transition for a terminal/killed chain is dropped', () => {
    const msg = '[Replay] WRFC chain chain-7 transitioned pending → engineering — waiting for action (first notified 2 turns ago)';
    expect(classifyNoise(msg, { isChainTerminal: (id) => id === 'chain-7' }).action).toBe('drop');
  });

  test('1c: [Replay] transition for an active chain still emits', () => {
    const msg = '[Replay] WRFC chain chain-7 transitioned pending → engineering — waiting for action (first notified 2 turns ago)';
    expect(classifyNoise(msg, { isChainTerminal: () => false }).action).toBe('emit');
  });

  test('1c: without an isChainTerminal predicate, replays are never suppressed', () => {
    const msg = '[Replay] WRFC chain chain-7 transitioned pending → engineering — waiting for action (first notified 2 turns ago)';
    expect(classifyNoise(msg, {}).action).toBe('emit');
  });

  test('unrelated system messages pass through', () => {
    expect(classifyNoise('[Error] a fatal error occurred', {}).action).toBe('emit');
    expect(classifyNoise('[WRFC] Chain abc started', {}).action).toBe('emit');
  });
});

describe('terminal captured-write notice (agent-specific)', () => {
  test('the aggregate captured-write notice is dropped from the feed', () => {
    const msg = '[Terminal] Captured 4 direct stdout writes that would have corrupted the TUI: some plumbing';
    expect(classifyNoise(msg, {}).action).toBe('drop');
  });

  test('the singular captured-write notice is also dropped', () => {
    const msg = '[Terminal] Captured 1 direct stderr write that would have corrupted the TUI: x';
    expect(classifyNoise(msg, {}).action).toBe('drop');
  });

  test('specificity: a non-captured [Terminal] lifecycle line is NOT suppressed', () => {
    // Only the "Captured N direct …" aggregate matches; other [Terminal] lines
    // (e.g. a genuine lifecycle/resize notice) must still reach the feed.
    expect(classifyNoise('[Terminal] resized to 120x40', {}).action).toBe('emit');
    expect(classifyNoise('[Terminal] entered alt-screen mode', {}).action).toBe('emit');
  });
});

describe('provider-replay folding', () => {
  test('extracts a provider name from a replay line', () => {
    expect(providerNameFromReplay('[Local] ollama at localhost:11434 (2 models) — from last session')).toBe('ollama');
  });

  test('folds a burst into one line naming the providers', () => {
    const lines = [
      '[Local] ollama at localhost:11434 (2 models) — from last session',
      '[Local] lmstudio at localhost:1234 (5 models) — from last session',
    ];
    const summary = foldProviderReplayLines(lines);
    expect(summary).toBe('[Local] Restored 2 providers from last session (ollama, lmstudio)');
  });

  test('a single provider reads in the singular', () => {
    const summary = foldProviderReplayLines(['[Local] ollama at localhost:11434 (2 models) — from last session']);
    expect(summary).toBe('[Local] Restored 1 provider from last session (ollama)');
  });

  test('more than three providers collapse to a "+K more" tail', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'].map((n) => `[Local] ${n} at localhost:1 (1 models) — from last session`);
    expect(foldProviderReplayLines(lines)).toBe('[Local] Restored 5 providers from last session (a, b, c, +2 more)');
  });
});
