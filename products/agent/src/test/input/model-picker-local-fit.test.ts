import { describe, expect, test, afterEach } from 'bun:test';
import {
  buildLocalFitRecommendations,
  buildSignInRow,
  isLocalFitRecommendation,
  isProviderSignInRow,
  LOCAL_REC_PROVIDER,
  SIGN_IN_ROW_ID,
} from '../../input/model-picker-local-fit.ts';
import {
  _resetHardwareProfileCache,
  _setHardwareProfileForTest,
  fitAssessment,
  estimateModelBytes,
} from '../../core/hardware-profile.ts';
import type { HardwareProfile } from '../../core/hardware-profile.ts';

const COMFORTABLE_PROFILE: HardwareProfile = {
  totalRamBytes: 32 * 1024 ** 3,
  availableRamBytes: 24 * 1024 ** 3,
  gpus: [],
  cpuCores: 8,
};

const TIGHT_PROFILE: HardwareProfile = {
  totalRamBytes: 8 * 1024 ** 3,
  availableRamBytes: 2 * 1024 ** 3,
  gpus: [],
  cpuCores: 4,
};

afterEach(() => {
  _resetHardwareProfileCache();
});

describe('buildLocalFitRecommendations', () => {
  test('returns a non-empty list regardless of profile', () => {
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    expect(recs.length).toBeGreaterThan(0);
  });

  test('all entries use the LOCAL_REC_PROVIDER sentinel', () => {
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    for (const rec of recs) {
      expect(rec.provider).toBe(LOCAL_REC_PROVIDER);
    }
  });

  test('all entries are identified as local fit recommendations', () => {
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    for (const rec of recs) {
      expect(isLocalFitRecommendation(rec)).toBe(true);
    }
  });

  test('description explicitly says not yet installed', () => {
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    for (const rec of recs) {
      expect(rec.description ?? '').toContain('not yet installed');
    }
  });

  test('fit label for 7B on comfortable profile matches fitAssessment result', () => {
    _setHardwareProfileForTest(COMFORTABLE_PROFILE);
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    // The 7B entry is the second (index 1) in LOCAL_REC_SIZES order
    const rec7b = recs.find((r) => r.id.includes('7b'));
    expect(rec7b).toBeDefined();
    // Verify the description contains the verdict string
    const verdict = fitAssessment(estimateModelBytes(7_000_000_000), COMFORTABLE_PROFILE);
    // On a 32 GB / 24 GB available machine, 7B (3.85 GB) fits in RAM
    expect(verdict).toBe('fits-ram');
    expect(rec7b!.description).toContain('runs on CPU RAM');
  });

  test('fit label for 7B on tight profile reflects tight/too-big verdict', () => {
    const recs = buildLocalFitRecommendations(TIGHT_PROFILE);
    const rec7b = recs.find((r) => r.id.includes('7b'));
    expect(rec7b).toBeDefined();
    // On 8 GB total / 2 GB available, 7B (3.85 GB) exceeds available but fits total => tight
    const verdict = fitAssessment(estimateModelBytes(7_000_000_000), TIGHT_PROFILE);
    expect(verdict).toBe('tight');
    expect(rec7b!.description).toContain('tight');
  });

  test('uses process-level hardware profile when no override provided', () => {
    _setHardwareProfileForTest(COMFORTABLE_PROFILE);
    // Should not throw and should produce results based on injected profile
    const recs = buildLocalFitRecommendations();
    expect(recs.length).toBeGreaterThan(0);
  });
});

describe('isProviderSignInRow', () => {
  test('returns true for the sign-in row built by buildSignInRow()', () => {
    const row = buildSignInRow();
    expect(isProviderSignInRow(row)).toBe(true);
  });

  test('returns false for a regular local fit recommendation', () => {
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    for (const rec of recs) {
      expect(isProviderSignInRow(rec)).toBe(false);
    }
  });

  test('sign-in row id equals SIGN_IN_ROW_ID sentinel', () => {
    const row = buildSignInRow();
    expect(row.id).toBe(SIGN_IN_ROW_ID);
    expect(row.provider).toBe(LOCAL_REC_PROVIDER);
  });

  test('sign-in row has a plain-language displayName', () => {
    const row = buildSignInRow();
    expect(row.displayName).toContain('Sign in to a provider');
  });

  test('returns false for a real cloud model', () => {
    expect(
      isProviderSignInRow({
        id: 'claude-sonnet-4-5',
        provider: 'anthropic',
        registryKey: 'anthropic:claude-sonnet-4-5',
        displayName: 'Claude Sonnet',
        description: 'Real model',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
        contextWindow: 200_000,
        selectable: true,
        tier: 'premium',
      }),
    ).toBe(false);
  });
});

describe('isLocalFitRecommendation', () => {
  test('returns true for synthetic local entries', () => {
    const recs = buildLocalFitRecommendations(COMFORTABLE_PROFILE);
    expect(isLocalFitRecommendation(recs[0]!)).toBe(true);
  });

  test('returns false for a real cloud model', () => {
    expect(
      isLocalFitRecommendation({
        id: 'claude-sonnet-4-5',
        provider: 'anthropic',
        registryKey: 'anthropic:claude-sonnet-4-5',
        displayName: 'Claude Sonnet',
        description: 'Real model',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
        contextWindow: 200_000,
        selectable: true,
        tier: 'premium',
      }),
    ).toBe(false);
  });

  test('returns false for a real ollama model', () => {
    expect(
      isLocalFitRecommendation({
        id: 'llama3',
        provider: 'ollama',
        registryKey: 'ollama:llama3',
        displayName: 'Llama 3',
        description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
        tier: 'free',
      }),
    ).toBe(false);
  });
});
