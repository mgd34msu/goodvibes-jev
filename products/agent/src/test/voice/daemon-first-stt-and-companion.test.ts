/**
 * Two failures from the same session, both on this surface:
 *
 *  - a captured utterance was transcribed by THIS process's voice service and
 *    nowhere else, so when its local provider threw 'local STT is not
 *    configured', the user was told speech-to-text did not exist, while the
 *    daemon on the same machine transcribed perfectly from the same managed
 *    whisper install;
 *  - `voice.wake.enabled` was turned on for a surface whose
 *    `voice.wake.surfaces.agent` row was off, which stores correctly, reports
 *    success, and opens no microphone at all.
 */
import { describe, expect, test } from 'bun:test';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

import { createVoiceSttGateway, describeTranscriptionFailure } from '../../core/voice-stt-gateway.ts';
import { readVoiceDiagnostics } from '@goodvibes-jev/engine/sdk/platform/voice';

const audio = {
  mimeType: 'audio/wav',
  format: 'wav' as const,
  dataBase64: 'UklGRiQAAABXQVZF',
  sampleRateHz: 16_000,
  durationMs: 1_200,
};

/** A voice service whose local provider is broken, exactly as it was that day. */
function brokenLocalService(): { transcribe: () => Promise<{ text: string }> } {
  return {
    transcribe: async () => {
      throw new Error('local STT is not configured; voice.local.sttEngine is not set');
    },
  };
}

function registryWithStt(): { findProvider: () => { id: string; transcribe: () => Promise<unknown> } | null } {
  return { findProvider: () => ({ id: 'local', transcribe: async () => ({}) }) };
}

function registryWithoutStt(): { findProvider: () => null } {
  return { findProvider: () => null };
}

describe('captured audio goes to the connected host first', () => {
  test('the host transcribes even though this process\'s own provider is broken', async () => {
    const invoked: Array<{ method: string; input: unknown }> = [];
    const resolution = createVoiceSttGateway({
      voiceService: brokenLocalService() as never,
      voiceProviders: registryWithStt() as never,
      daemonVerbs: {
        probe: () => ({ available: true }),
        invoke: async (method: string, input: unknown) => {
          invoked.push({ method, input });
          return { providerId: 'local', text: 'turn the hallway light off' };
        },
      } as never,
    });

    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    const text = await resolution.gateway.transcribe(audio as never);

    expect(text).toBe('turn the hallway light off');
    // It went over the daemon's own verb, not a loopback of this process.
    expect(invoked[0]?.method).toBe('voice.stt');
    expect(resolution.gateway.lastRouteExplanation()).toContain('connected host');
  });

  test('with no connected host it transcribes here, and says nothing about a host', async () => {
    const resolution = createVoiceSttGateway({
      voiceService: { transcribe: async () => ({ text: 'hello there' }) } as never,
      voiceProviders: registryWithStt() as never,
      daemonVerbs: { probe: () => ({ available: false, reason: 'no connected host is configured' }) } as never,
    });

    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    expect(await resolution.gateway.transcribe(audio as never)).toBe('hello there');
    expect(resolution.gateway.lastRouteExplanation()).toContain('this process');
  });

  test('a host that fails hands over to this process and states what it fell back from', async () => {
    const resolution = createVoiceSttGateway({
      voiceService: { transcribe: async () => ({ text: 'local words' }) } as never,
      voiceProviders: registryWithStt() as never,
      daemonVerbs: {
        probe: () => ({ available: true }),
        invoke: async () => { throw new Error('HTTP 503 from the host'); },
      } as never,
    });

    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    expect(await resolution.gateway.transcribe(audio as never)).toBe('local words');
    expect(resolution.gateway.lastRouteExplanation()).toContain('HTTP 503 from the host');
  });

  test('a reachable host is a route even when this process has no provider registered at all', () => {
    // The old code called this "no speech-to-text provider is registered" and
    // stopped. It is only true of THIS process.
    const resolution = createVoiceSttGateway({
      voiceService: brokenLocalService() as never,
      voiceProviders: registryWithoutStt() as never,
      daemonVerbs: { probe: () => ({ available: true }), invoke: async () => ({ text: 'x' }) } as never,
    });
    expect(resolution.available).toBe(true);
  });

  test('only when BOTH routes are absent is transcription unavailable, and it says so without naming a command', () => {
    const resolution = createVoiceSttGateway({
      voiceService: brokenLocalService() as never,
      voiceProviders: registryWithoutStt() as never,
      daemonVerbs: { probe: () => ({ available: false, reason: 'not configured' }) } as never,
    });
    expect(resolution.available).toBe(false);
    if (resolution.available) return;
    expect(resolution.reason).not.toContain('/voice');
    expect(resolution.reason).not.toMatch(/\brun\b/i);
  });

  test('every route attempt is written to the voice diagnostics file', async () => {
    const managedVoiceRoot = makeProjectTempDir('gv-agent-voice-diag-');
    const resolution = createVoiceSttGateway({
      voiceService: { transcribe: async () => ({ text: 'recovered' }) } as never,
      voiceProviders: registryWithStt() as never,
      managedVoiceRoot,
      daemonVerbs: {
        probe: () => ({ available: true }),
        invoke: async () => { throw new Error('connect ECONNREFUSED'); },
      } as never,
    });
    if (!resolution.available) throw new Error('expected a gateway');
    await resolution.gateway.transcribe(audio as never);

    const entries = readVoiceDiagnostics(managedVoiceRoot);
    // The failed host attempt AND the successful local one are both recorded:
    // "it broke" is only diagnosable next to "it worked, over there".
    expect(entries).toHaveLength(2);
    expect(entries[0]?.route).toBe('connected-host');
    expect(entries[0]?.ok).toBe(false);
    expect(entries[0]?.error).toContain('ECONNREFUSED');
    expect(entries[1]?.route).toBe('in-process');
    expect(entries[1]?.ok).toBe(true);
  });

  test('an exhausted-routes failure reports every route\'s own reason', async () => {
    const resolution = createVoiceSttGateway({
      voiceService: brokenLocalService() as never,
      voiceProviders: registryWithStt() as never,
      daemonVerbs: {
        probe: () => ({ available: true }),
        invoke: async () => { throw new Error('the host refused'); },
      } as never,
    });
    if (!resolution.available) throw new Error('expected a gateway');

    let described = '';
    try {
      await resolution.gateway.transcribe(audio as never);
    } catch (error) {
      described = describeTranscriptionFailure(error);
    }
    expect(described).toContain('the host refused');
    expect(described).toContain('local STT is not configured');
  });
});
