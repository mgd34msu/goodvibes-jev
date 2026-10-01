import { describe, expect, test } from 'bun:test';
import {
  readVoiceLocalInstallResult,
  readVoiceLocalStatus,
  voiceLocalInstallIsRetriable,
  voiceLocalInstallStateLabel,
  voiceLocalNeedsSetup,
  voiceLocalPhaseLabel,
  voiceLocalStateLabel,
  type VoiceLocalStatusSnapshot,
} from './voice-local-setup';

function status(overrides: Partial<VoiceLocalStatusSnapshot> = {}): VoiceLocalStatusSnapshot {
  return {
    platform: 'linux-x64',
    state: 'not-provisioned',
    tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/x/piper', modelPath: '/x/voice.onnx' },
    stt: {
      engine: 'whisper-cpp',
      supported: true,
      state: 'not-provisioned',
      binaryPresent: false,
      modelPresent: false,
      binaryPath: '/x/whisper',
      modelPath: '/x/model.bin',
    },
    offerBytes: 200_000_000,
    ...overrides,
  };
}

describe('voiceLocalNeedsSetup', () => {
  test('offers setup for not-provisioned and partial', () => {
    expect(voiceLocalNeedsSetup(status({ state: 'not-provisioned' }))).toBe(true);
    expect(voiceLocalNeedsSetup(status({ state: 'partial' }))).toBe(true);
  });

  test('does not offer setup once provisioned', () => {
    expect(voiceLocalNeedsSetup(status({ state: 'provisioned' }))).toBe(false);
  });

  test('does not offer setup on an unsupported platform (no pinned build to install)', () => {
    expect(voiceLocalNeedsSetup(status({ state: 'unsupported-platform' }))).toBe(false);
  });
});

describe('voiceLocalStateLabel', () => {
  test('gives every resting state a distinct, non-empty label', () => {
    const labels = (['provisioned', 'partial', 'not-provisioned', 'unsupported-platform'] as const).map(voiceLocalStateLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });
});

describe('voiceLocalInstallStateLabel', () => {
  test('gives every install-attempt terminal state a distinct, non-empty label', () => {
    const labels = ([
      'provisioned', 'unsupported-platform', 'download-failed', 'checksum-mismatch', 'bundle-unavailable', 'sideload-mismatch',
    ] as const).map(voiceLocalInstallStateLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });
});

describe('readVoiceLocalStatus: defensive wire parse', () => {
  test('a full schema-shaped payload parses verbatim', () => {
    const parsed = readVoiceLocalStatus(status());
    expect(parsed).not.toBeNull();
    expect(parsed?.state).toBe('not-provisioned');
    expect(parsed?.stt.engine).toBe('whisper-cpp');
    expect(parsed?.offerBytes).toBe(200_000_000);
  });

  test('a 200-with-empty-body answer parses to null (honest cannot-read), never an undefined label', () => {
    expect(readVoiceLocalStatus({})).toBeNull();
    expect(readVoiceLocalStatus(null)).toBeNull();
    expect(readVoiceLocalStatus([])).toBeNull();
  });

  test('an unknown state value parses to null rather than an invented state', () => {
    expect(readVoiceLocalStatus(status({ state: 'installing' as never }))).toBeNull();
  });

  test('per-engine detail degrades field by field without sinking the snapshot', () => {
    const parsed = readVoiceLocalStatus({ state: 'provisioned' });
    expect(parsed).not.toBeNull();
    expect(parsed?.tts.engine).toBe('piper');
    expect(parsed?.stt.state).toBe('not-provisioned');
    expect(parsed?.offerBytes).toBeNull();
  });
});

describe('readVoiceLocalStatus: the optional installInProgress section (SDK 5357f09e)', () => {
  const IN_PROGRESS = {
    startedAt: 1_752_600_000_000,
    components: [
      { component: 'piper-voice-onnx', phase: 'done', bytesTotal: 63_201_294, bytesDone: 63_201_294 },
      { component: 'piper-engine', phase: 'download', message: 'fetching piper.tar.gz', bytesTotal: 6_942_130 },
      { component: 'whisper-model', phase: 'extract' },
    ],
  };

  test('a schema-shaped section parses verbatim, bytes where present', () => {
    const parsed = readVoiceLocalStatus({ ...status(), installInProgress: IN_PROGRESS });
    expect(parsed?.installInProgress).toBeDefined();
    expect(parsed?.installInProgress?.startedAt).toBe(1_752_600_000_000);
    expect(parsed?.installInProgress?.components).toHaveLength(3);
    expect(parsed?.installInProgress?.components[0]).toMatchObject({ phase: 'done', bytesDone: 63_201_294 });
    expect(parsed?.installInProgress?.components[1]).toMatchObject({ phase: 'download', message: 'fetching piper.tar.gz' });
    expect(parsed?.installInProgress?.components[2]?.bytesTotal).toBeUndefined();
  });

  test('absent section (an older daemon, or no active install) leaves the field undefined', () => {
    expect(readVoiceLocalStatus(status())?.installInProgress).toBeUndefined();
  });

  test('a malformed section degrades to undefined without sinking the status read', () => {
    const parsed = readVoiceLocalStatus({ ...status(), installInProgress: { components: 'nope' } });
    expect(parsed).not.toBeNull();
    expect(parsed?.installInProgress).toBeUndefined();
  });

  test('malformed component entries are dropped individually (unknown phase, missing name)', () => {
    const parsed = readVoiceLocalStatus({
      ...status(),
      installInProgress: {
        startedAt: 1,
        components: [
          { component: 'piper-engine', phase: 'download' },
          { component: 'bad-phase', phase: 'uploading' },
          { phase: 'done' },
        ],
      },
    });
    expect(parsed?.installInProgress?.components).toHaveLength(1);
    expect(parsed?.installInProgress?.components[0]?.component).toBe('piper-engine');
  });
});

describe('voiceLocalPhaseLabel', () => {
  test('gives every provisioner phase a distinct, non-empty label', () => {
    const labels = (['skip', 'download', 'verify', 'extract', 'done', 'error'] as const).map(voiceLocalPhaseLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });
});

describe('readVoiceLocalInstallResult: defensive wire parse', () => {
  const RECEIPT = {
    provisioned: true,
    platform: 'linux-x64',
    tts: { engine: 'piper', state: 'provisioned', binaryPath: '/x/piper', modelPath: '/x/voice.onnx' },
    stt: { engine: 'whisper-cpp', state: 'download-failed', reason: 'network timeout' },
    components: [{ id: 'piper-engine', state: 'installed', bytes: 100 }],
    configured: { set: [{ key: 'tts.provider', value: 'local' }], skipped: [{ key: 'voice.local.ttsBinary', reason: 'user-set' }] },
  };

  test('a full schema-shaped receipt parses verbatim', () => {
    const parsed = readVoiceLocalInstallResult(RECEIPT);
    expect(parsed).not.toBeNull();
    expect(parsed?.tts.state).toBe('provisioned');
    expect(parsed?.stt.state).toBe('download-failed');
    expect(parsed?.stt.reason).toBe('network timeout');
    expect(parsed?.configured.set[0]?.key).toBe('tts.provider');
    expect(parsed?.configured.skipped[0]?.reason).toBe('user-set');
  });

  test('a 200-with-empty-body answer parses to null (honest cannot-read)', () => {
    expect(readVoiceLocalInstallResult({})).toBeNull();
    expect(readVoiceLocalInstallResult(null)).toBeNull();
  });

  test('a receipt missing a per-engine terminal state parses to null, the receipt is meaningless without both', () => {
    expect(readVoiceLocalInstallResult({ ...RECEIPT, stt: { engine: 'whisper-cpp' } })).toBeNull();
    expect(readVoiceLocalInstallResult({ ...RECEIPT, tts: { engine: 'piper', state: 'half-done' } })).toBeNull();
  });
});

describe('voiceLocalInstallIsRetriable', () => {
  test('download-failed and checksum-mismatch are retriable', () => {
    expect(voiceLocalInstallIsRetriable('download-failed')).toBe(true);
    expect(voiceLocalInstallIsRetriable('checksum-mismatch')).toBe(true);
  });

  test('provisioned, unsupported-platform, bundle-unavailable, sideload-mismatch are not', () => {
    expect(voiceLocalInstallIsRetriable('provisioned')).toBe(false);
    expect(voiceLocalInstallIsRetriable('unsupported-platform')).toBe(false);
    expect(voiceLocalInstallIsRetriable('bundle-unavailable')).toBe(false);
    expect(voiceLocalInstallIsRetriable('sideload-mismatch')).toBe(false);
  });
});
