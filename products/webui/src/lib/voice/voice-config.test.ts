import { describe, expect, test } from 'bun:test';
import {
  deriveVoiceAvailability,
  describeSharedVoice,
  readSharedVoiceConfig,
} from './voice-config';

const provider = (over: Record<string, unknown>) => ({
  id: 'p',
  label: 'P',
  state: 'unconfigured',
  configured: false,
  capabilities: [],
  ...over,
});

describe('deriveVoiceAvailability', () => {
  test('a configured full provider enables both TTS and STT with sensible defaults', () => {
    const status = {
      enabled: true,
      providerCount: 1,
      note: 'n',
      providers: [
        provider({ id: 'elevenlabs', label: 'ElevenLabs', state: 'healthy', configured: true, capabilities: ['tts', 'tts-stream', 'stt', 'voice-list'] }),
      ],
    };
    const a = deriveVoiceAvailability(status);
    expect(a.ttsAvailable).toBe(true);
    expect(a.sttAvailable).toBe(true);
    expect(a.defaultTtsProviderId).toBe('elevenlabs');
    expect(a.defaultSttProviderId).toBe('elevenlabs');
  });

  test('providers present but NONE configured => not available (honest, not confident-on)', () => {
    const status = {
      enabled: false,
      providers: [provider({ id: 'elevenlabs', capabilities: ['tts', 'stt'] })],
    };
    const a = deriveVoiceAvailability(status);
    expect(a.ttsAvailable).toBe(false);
    expect(a.sttAvailable).toBe(false);
    expect(a.defaultTtsProviderId).toBeUndefined();
  });

  test('a configured STT-only provider enables dictation but not read-aloud', () => {
    const status = {
      enabled: true,
      providers: [provider({ id: 'deepgram', configured: true, state: 'healthy', capabilities: ['stt'] })],
    };
    const a = deriveVoiceAvailability(status);
    expect(a.ttsAvailable).toBe(false);
    expect(a.sttAvailable).toBe(true);
    expect(a.defaultSttProviderId).toBe('deepgram');
  });

  test('an unknown/legacy shape degrades to not-available rather than throwing', () => {
    const a = deriveVoiceAvailability({ garbage: true });
    expect(a.ttsAvailable).toBe(false);
    expect(a.sttAvailable).toBe(false);
    expect(a.providers).toEqual([]);
  });
});

describe('readSharedVoiceConfig', () => {
  test('reads tts.provider/voice/speed out of the resolved snapshot', () => {
    const snapshot = { ui: {}, tts: { provider: 'elevenlabs', voice: 'rachel', speed: 1.25 } };
    expect(readSharedVoiceConfig(snapshot)).toEqual({ provider: 'elevenlabs', voice: 'rachel', speed: 1.25 });
  });

  test('a snapshot without a tts section yields empty defaults (daemon applies its own)', () => {
    expect(readSharedVoiceConfig({ ui: {} })).toEqual({ provider: '', voice: '' });
    expect(readSharedVoiceConfig(null)).toEqual({ provider: '', voice: '' });
  });
});

describe('describeSharedVoice', () => {
  test('carries provider and voice, and is never blank when unset', () => {
    const named = describeSharedVoice({ provider: 'elevenlabs', voice: 'rachel' });
    expect(named).toContain('elevenlabs');
    expect(named).toContain('rachel');
    expect(describeSharedVoice({ provider: '', voice: '' }).length).toBeGreaterThan(0);
  });
});
