import { describe, expect, test } from 'bun:test';
import {
  checkUsagePct,
  outcomeLabel,
  outcomeTone,
  parseCompactionCheck,
  parseCompactionReceipt,
} from './compaction';

const RAW_RECEIPT = {
  type: 'COMPACTION_RECEIPT',
  sessionId: 's-1',
  trigger: 'auto',
  strategy: 'summarize-oldest',
  tokensBefore: 180_000,
  tokensAfter: 42_000,
  messagesBefore: 210,
  messagesAfter: 18,
  qualityScore: 0.86,
  qualityGrade: 'B',
  lowQuality: false,
  instructionsReinjected: true,
  validationPassed: true,
  outcome: 'applied',
  detail: 'Kept the last 3 turns verbatim.',
};

describe('parseCompactionReceipt', () => {
  test('parses a well-formed COMPACTION_RECEIPT frame', () => {
    const receipt = parseCompactionReceipt(RAW_RECEIPT);
    expect(receipt).not.toBeNull();
    expect(receipt?.sessionId).toBe('s-1');
    expect(receipt?.trigger).toBe('auto');
    expect(receipt?.tokensBefore).toBe(180_000);
    expect(receipt?.tokensAfter).toBe(42_000);
    expect(receipt?.outcome).toBe('applied');
    expect(receipt?.detail).toBe('Kept the last 3 turns verbatim.');
  });

  test('returns null for a different compaction event type (not a receipt)', () => {
    expect(parseCompactionReceipt({ type: 'COMPACTION_CHECK', sessionId: 's-1', tokenCount: 1, threshold: 2 })).toBeNull();
  });

  test('returns null when sessionId is missing, never fabricates one', () => {
    expect(parseCompactionReceipt({ ...RAW_RECEIPT, sessionId: undefined })).toBeNull();
  });

  test('returns null for non-object / garbage payloads', () => {
    expect(parseCompactionReceipt(null)).toBeNull();
    expect(parseCompactionReceipt('nope')).toBeNull();
    expect(parseCompactionReceipt(undefined)).toBeNull();
  });

  test('an unrecognized trigger/outcome falls back honestly rather than crashing', () => {
    const receipt = parseCompactionReceipt({ ...RAW_RECEIPT, trigger: 'weird', outcome: 'weird' });
    expect(receipt?.trigger).toBe('auto');
    expect(receipt?.outcome).toBe('failed');
  });

  test('missing numeric fields read as 0, never NaN/undefined', () => {
    const receipt = parseCompactionReceipt({ type: 'COMPACTION_RECEIPT', sessionId: 's-1', outcome: 'applied' });
    expect(receipt?.tokensBefore).toBe(0);
    expect(receipt?.qualityScore).toBe(0);
  });
});

describe('parseCompactionCheck', () => {
  test('parses a well-formed COMPACTION_CHECK frame', () => {
    const check = parseCompactionCheck({ type: 'COMPACTION_CHECK', sessionId: 's-1', tokenCount: 90_000, threshold: 160_000 });
    expect(check).not.toBeNull();
    expect(check?.tokenCount).toBe(90_000);
    expect(check?.threshold).toBe(160_000);
  });

  test('returns null for a receipt frame (wrong type)', () => {
    expect(parseCompactionCheck(RAW_RECEIPT)).toBeNull();
  });

  test('returns null when sessionId is missing', () => {
    expect(parseCompactionCheck({ type: 'COMPACTION_CHECK', tokenCount: 1, threshold: 2 })).toBeNull();
  });
});

describe('checkUsagePct', () => {
  test('computes a whole-percent ratio when both numbers are present', () => {
    expect(checkUsagePct({ tokenCount: 80_000, threshold: 160_000 })).toBe(50);
  });

  test('returns null when threshold is 0, never divides by a fabricated denominator', () => {
    expect(checkUsagePct({ tokenCount: 1000, threshold: 0 })).toBeNull();
  });
});

describe('outcomeTone / outcomeLabel', () => {
  test('applied + not low quality is ok', () => {
    expect(outcomeTone({ outcome: 'applied', lowQuality: false })).toBe('ok');
  });

  test('applied but low quality is a warning', () => {
    expect(outcomeTone({ outcome: 'applied', lowQuality: true })).toBe('warning');
  });

  test('kept-original is a warning', () => {
    expect(outcomeTone({ outcome: 'kept-original', lowQuality: false })).toBe('warning');
  });

  test('failed is bad', () => {
    expect(outcomeTone({ outcome: 'failed', lowQuality: false })).toBe('bad');
  });

  test('each outcome gets a distinct label', () => {
    const labels = (['applied', 'kept-original', 'failed'] as const).map(outcomeLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
