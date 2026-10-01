import { describe, expect, test } from 'bun:test';
import {
  contractGlyphForBadgeTone,
  contractGlyphForConnection,
  contractGlyphForMemoryTier,
  contractStateForAuth,
  contractStateForBadgeTone,
  contractStateForConnection,
  contractStateForMemoryTier,
  contractStateForSse,
  contractStateForWorking,
} from './presentation-bridge';
import { CONTRACT_STATE_GLYPHS } from './generated/presentation-tokens';

describe('badge tone to contract severity bucket', () => {
  test('contractStateForBadgeTone resolves each BadgeTone to its contract bucket', () => {
    expect(contractStateForBadgeTone('ok')).toBe('good');
    expect(contractStateForBadgeTone('warning')).toBe('warn');
    expect(contractStateForBadgeTone('bad')).toBe('bad');
    expect(contractStateForBadgeTone('neutral')).toBe('info');
  });
});

describe('daemon-health axis mappings (StatusStrip): genuine severity correspondence only', () => {
  test('ConnectionState: connected=good, reconnecting=warn, down=bad', () => {
    expect(contractStateForConnection('connected')).toBe('good');
    expect(contractStateForConnection('reconnecting')).toBe('warn');
    expect(contractStateForConnection('down')).toBe('bad');
  });


  test('AuthState: signed-in=good, signed-out=info (absence is not a fault), unknown=info', () => {
    expect(contractStateForAuth('signed-in')).toBe('good');
    expect(contractStateForAuth('signed-out')).toBe('info');
    expect(contractStateForAuth('unknown')).toBe('info');
  });

  test('WorkingState: working=good, blocked=bad (a real fault), unknown=info', () => {
    expect(contractStateForWorking('working')).toBe('good');
    expect(contractStateForWorking('blocked')).toBe('bad');
    expect(contractStateForWorking('unknown')).toBe('info');
  });

  test('SseState: active=good, connecting=info, error=bad, disabled and relay-unsupported=info (not faults)', () => {
    expect(contractStateForSse('active')).toBe('good');
    expect(contractStateForSse('connecting')).toBe('info');
    expect(contractStateForSse('error')).toBe('bad');
    expect(contractStateForSse('disabled')).toBe('info');
    expect(contractStateForSse('relay-unsupported')).toBe('info');
  });

  test('MemoryTier: normal=good, elevated=info (notice, not yet a fault), high=warn, critical=bad', () => {
    expect(contractStateForMemoryTier('normal')).toBe('good');
    expect(contractStateForMemoryTier('elevated')).toBe('info');
    expect(contractStateForMemoryTier('high')).toBe('warn');
    expect(contractStateForMemoryTier('critical')).toBe('bad');
  });

});

describe('the glyph helpers paint the glyph of the bucket the state helpers chose', () => {
  // Each glyph helper must agree with its state helper for every input, so a badge
  // never shows the glyph of one severity beside the wording of another. Checked
  // against the four-bucket STATE_GLYPHS table, never the 16-key status vocabulary.
  test('badge tones', () => {
    for (const tone of ['ok', 'warning', 'bad', 'neutral'] as const) {
      expect(contractGlyphForBadgeTone(tone)).toBe(CONTRACT_STATE_GLYPHS[contractStateForBadgeTone(tone)]);
    }
  });

  test('connection states', () => {
    for (const state of ['connected', 'reconnecting', 'down'] as const) {
      expect(contractGlyphForConnection(state)).toBe(CONTRACT_STATE_GLYPHS[contractStateForConnection(state)]);
    }
  });

  test('memory tiers', () => {
    for (const tier of ['normal', 'elevated', 'high', 'critical'] as const) {
      expect(contractGlyphForMemoryTier(tier)).toBe(CONTRACT_STATE_GLYPHS[contractStateForMemoryTier(tier)]);
    }
  });

  test('the four buckets paint four distinct glyphs, so the mapping is visible at all', () => {
    const glyphs = new Set(Object.values(CONTRACT_STATE_GLYPHS));
    expect(glyphs.size).toBe(4);
    for (const glyph of glyphs) expect(glyph.length).toBeGreaterThan(0);
  });
});
