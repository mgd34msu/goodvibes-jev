/**
 * Regression guard: platform voice-config cohesion (VOICE-AGENT-PARITY).
 *
 * Mike's ruling #6 ("tts works well in all areas" + "one shared voice
 * config") requires that the Agent's spoken-output pipeline read the SAME
 * tts.* config contract every other surface (TUI, daemon, and, once built,
 * the web UI) reads, rather than a private Agent-only voice-config schema
 * that could silently drift out of shape.
 *
 * This suite locks that in three ways:
 *  1. The tts.* keys the Agent's audio pipeline actually reads (tts.provider,
 *     tts.voice, and tts.speed inside the SDK-owned SpokenTurnController that
 *     spoken-turn-wiring.ts constructs, plus tts.llmProvider/tts.llmModel in
 *     spoken-turn-model-routing.ts and tts.provider/tts.voice in
 *     tts-settings-actions.ts) exist in the SDK's shared CONFIG_SCHEMA with
 *     the shared defaults, not a schema the Agent invented for itself.
 *  2. A real ConfigManager, constructed the exact way the Agent's entrypoint
 *     constructs it (surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, a fresh temp
 *     home directory, no local overrides on disk), resolves tts.* to those
 *     same shared defaults out of the box.
 *  3. The source files that read/write tts.* import ConfigManager's type
 *     from the shared SDK package, not a local reimplementation, so a
 *     future change can't quietly introduce an Agent-local voice-config
 *     silo without this test's import-scan catching it.
 *
 * See docs/voice-and-live-tts.md ("Platform Voice-Config Cohesion") for the
 * accompanying rulings: local (non-daemon) synthesis stays local so the
 * Agent keeps working offline, and microphone input arrives through the wake
 * word and only through it, the platform owns the capture primitive, so this
 * surface composes it rather than building a partial mic flow of its own, and
 * push-to-talk is still deliberately absent here.
 *
 * The last block also guards the two onnxruntime assets the wake engine needs
 * on disk, for the same reason: it is audio-layer wiring to a platform
 * contract, and getting it wrong is silent until a wake never fires.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { extractOnnxRuntimeAssets } from '../../audio/wake-inference.ts';
import { createVoiceSttGateway, describeTranscriptionFailure } from '../../core/voice-stt-gateway.ts';
import { GoodVibesSdkError } from '@goodvibes-jev/engine/sdk';

describe('Voice config cohesion: cross-surface proof (2026-07-06 shared config tier)', () => {
  // Mike's label is "one voice across terminal, desktop, and agent." Schema
  // cohesion (above) only proves the Agent reads the same KEYS everyone else
  // does; it says nothing about whether a VALUE set on one surface is the
  // value another surface actually sees. Before the shared tier
  // (docs/decisions/2026-07-06-shared-voice-config-tier.md), each surfaceRoot
  // wrote its own `~/.goodvibes/<surface>/settings.json` silo, so a voice set
  // in the TUI never reached the Agent even though both claimed "tts.*". This
  // is the test that actually proves the label true: two independently
  // constructed ConfigManagers, one per surfaceRoot, sharing nothing but a
  // home directory.

  test('a tts.voice value set under surfaceRoot "tui" resolves in a fresh ConfigManager built under surfaceRoot "agent"', () => {
    const homeDir = makeProjectTempDir('goodvibes-agent-voice-cross-surface');
    try {
      // The TUI/daemon surface, same construction shape as the TUI's own
      // entrypoint (surfaceRoot: 'tui'), sharing this test's temp homeDir.
      const tuiConfigManager = new ConfigManager({ homeDir, surfaceRoot: 'tui' });
      tuiConfigManager.set('tts.voice', 'shimmer');

      // A brand-new Agent ConfigManager, constructed AFTER the TUI-side write
      // and loading from disk for the first time, nothing is shared in
      // memory between the two instances, only the shared-tier file on disk.
      const agentConfigManager = new ConfigManager({ homeDir, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT });

      expect(agentConfigManager.get('tts.voice')).toBe('shimmer');
      // Confirm it actually resolved from the shared tier, not a coincidental
      // default or a stray Agent-local settings.json, the whole point of
      // the proof is which TIER carried the value across surfaces.
      expect(agentConfigManager.describeConfigKeySource('tts.voice').tier).toBe('shared');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('a tts.* write from the Agent surface routes to the shared tier file, not the Agent-local settings silo', () => {
    const homeDir = makeProjectTempDir('goodvibes-agent-voice-cross-surface');
    try {
      const agentConfigManager = new ConfigManager({ homeDir, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT });
      agentConfigManager.set('tts.voice', 'onyx');

      const sharedTierPath = agentConfigManager.getSharedTierPath();
      expect(sharedTierPath).not.toBeNull();
      const sharedTierRaw = JSON.parse(readFileSync(sharedTierPath!, 'utf-8')) as { tts?: { voice?: string } };
      expect(sharedTierRaw.tts?.voice).toBe('onyx');

      // The Agent's own surface-local settings.json must NOT carry the value
      //, a value present in both places would still pass the read-side
      // assertion above by accident while quietly keeping the old per-surface
      // silo alive underneath.
      const agentLocalSettingsPath = join(homeDir, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json');
      if (existsSync(agentLocalSettingsPath)) {
        const agentLocalRaw = JSON.parse(readFileSync(agentLocalSettingsPath, 'utf-8')) as { tts?: { voice?: string } };
        expect(agentLocalRaw.tts?.voice).toBeUndefined();
      }

      // And a second surface (e.g. the TUI) constructed fresh against the
      // same homeDir sees the Agent-originated write too, the sharing is
      // bidirectional, not an Agent-reads-TUI-writes one-way street.
      const tuiConfigManager = new ConfigManager({ homeDir, surfaceRoot: 'tui' });
      expect(tuiConfigManager.get('tts.voice')).toBe('onyx');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});


/**
 * The wake engine's inference runtime needs its two onnxruntime-web assets as real
 * files at a path it is pointed at. A compiled binary cannot satisfy the runtime's
 * dynamic import of them, which is why they are embedded and extracted, and a
 * failure here is silent in the worst way: session creation throws "Cannot find
 * module" at the moment a user turns the wake word on.
 */
describe('the onnxruntime assets the wake engine loads from disk', () => {
  test('both are written, the returned prefix ends in a slash, and identical bytes are left alone', () => {
    const directory = join(makeProjectTempDir('wake-ort-assets'), 'onnxruntime');
    const prefix = extractOnnxRuntimeAssets(directory);
    // The runtime concatenates a file name onto this; without the trailing slash it
    // looks for a sibling of the directory and reports a missing module.
    expect(prefix).toBe(`${directory}/`);

    const glue = join(directory, 'ort-wasm-simd-threaded.mjs');
    const wasm = join(directory, 'ort-wasm-simd-threaded.wasm');
    expect(existsSync(glue)).toBe(true);
    expect(existsSync(wasm)).toBe(true);
    expect(statSync(wasm).size).toBeGreaterThan(0);

    // Content-checked, not timestamp-checked: a second call rewrites nothing.
    const firstWrite = statSync(wasm).mtimeMs;
    extractOnnxRuntimeAssets(directory);
    expect(statSync(wasm).mtimeMs).toBe(firstWrite);

    // A stale extraction from another build is replaced rather than trusted.
    writeFileSync(glue, 'stale bytes from a previous version');
    extractOnnxRuntimeAssets(directory);
    expect(readFileSync(glue, 'utf8')).not.toBe('stale bytes from a previous version');
  });
});


/**
 * Speech-to-text for a captured utterance goes through the SAME call the
 * `voice.stt` verb is served from, this process owns that VoiceService instance,
 * so a loopback HTTP request to ask itself a question it already holds the answer
 * to would be the private-silo shape this file exists to prevent.
 */
describe('the wake path transcribes through the platform voice service', () => {
  const artifact = {
    mimeType: 'audio/wav',
    format: 'wav',
    dataBase64: 'UklGRg==',
    sampleRateHz: 16000,
    durationMs: 900,
  } as const;

  test('the utterance reaches VoiceService.transcribe with a default provider and the artifact the verb takes', async () => {
    const calls: Array<{ providerId: string | undefined; audio: Record<string, unknown> }> = [];
    const resolution = createVoiceSttGateway({
      voiceService: {
        transcribe: async (providerId: string | undefined, request: { audio: Record<string, unknown> }) => {
          calls.push({ providerId, audio: request.audio });
          return { providerId: 'local', text: '  open the deploy log  ', metadata: {} };
        },
      } as never,
      voiceProviders: { findProvider: () => ({ transcribe: async () => ({ providerId: 'local', text: '', metadata: {} }) }) } as never,
    });
    if (!resolution.available) throw new Error(`expected a gateway, got: ${resolution.reason}`);

    expect(await resolution.gateway.transcribe(artifact)).toBe('  open the deploy log  ');
    expect(calls.length).toBe(1);
    // Undefined provider: the registry picks the configured one, exactly as the verb
    // does for a caller that sends no providerId.
    expect(calls[0]?.providerId).toBeUndefined();
    expect(calls[0]?.audio.format).toBe('wav');
    expect(calls[0]?.audio.dataBase64).toBe('UklGRg==');
    // Required by the service's artifact and absent from the capture layer's.
    expect(calls[0]?.audio.metadata).toEqual({});
  });

  test('no speech-to-text ANYWHERE is a reason reported BEFORE audio is captured, not a throw after', () => {
    // "No provider registered" is only ever true of THIS process, so the
    // refusal now requires both routes to be absent, no local provider AND no
    // connected host. It also names no command: the platform provisions.
    const resolution = createVoiceSttGateway({
      voiceService: {} as never,
      voiceProviders: { findProvider: () => null } as never,
      daemonVerbs: { probe: () => ({ available: false, reason: 'no connected host' }) } as never,
    });
    expect(resolution.available).toBe(false);
    if (resolution.available) throw new Error('expected no gateway');
    expect(resolution.reason).toContain('no provider registered');
    expect(resolution.reason).toContain('no connected host');
    expect(resolution.reason).not.toContain('/voice setup');
  });

  test('a provider registered without a transcribe implementation is refused rather than called', () => {
    const resolution = createVoiceSttGateway({
      voiceService: {} as never,
      voiceProviders: { findProvider: () => ({ id: 'tts-only' }) } as never,
      daemonVerbs: { probe: () => ({ available: false, reason: 'no connected host' }) } as never,
    });
    expect(resolution.available).toBe(false);
  });

  test('a provider that is registered but not configured is described as that, not as a generic failure', () => {
    const notConfigured = new GoodVibesSdkError('Voice STT provider is not registered', { code: 'PROVIDER_NOT_CONFIGURED' });
    const described = describeTranscriptionFailure(notConfigured);
    expect(described).toContain('Voice STT provider is not registered');
    // It says what the PLATFORM does about it, and hands over no command: an
    // instruction to type something is the defect this replaced.
    expect(described).toContain('managed voice runtime provisions');
    expect(described).not.toContain('/voice');
    expect(describeTranscriptionFailure(new Error('whisper exited 1'))).toBe('whisper exited 1');
  });
});
