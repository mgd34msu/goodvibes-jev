/**
 * Voice routes for the hermetic harness, layered on top of installChatMockDaemon.
 *
 * Answers voice.status / voice.voices.list / voice.tts.stream / voice.stt and config.get
 * in-page, so the voice surface exercises every honest state with NO real voice provider
 * and NO real network. Audio is faked two ways: the TTS stream returns throwaway bytes,
 * and an injected fake AudioContext (installFakeAudio) decodes/plays them without touching
 * real audio hardware, the tests assert the STATES, never real sound.
 *
 * Registered AFTER the chat mock's '**\/api\/**' catch-all, so these more specific
 * handlers win for the voice/config paths.
 */
import type { Page, Route } from '@playwright/test';
import {
  voiceLocalInstallResponse,
  voiceLocalStatusInProgressResponse,
  voiceLocalStatusResponse,
  wakeModelChunkResponse,
  wakeProvisionResponse,
  wakeStatusResponse,
  WAKE_MODEL_CHUNK_BYTES,
  type VoiceLocalStatus,
  isWakeModelComponentId,
  WAKE_MODEL_COMPONENT_IDS,
} from './mock-daemon';

export interface VoiceProviderSeed {
  id: string;
  label: string;
  configured: boolean;
  capabilities: string[];
}

export interface VoiceMockOptions {
  /** Providers voice.status reports. Default: a configured ElevenLabs (tts + stt). */
  providers?: VoiceProviderSeed[];
  /** The transcript voice.stt returns. Default 'hello from voice input'. */
  transcript?: string;
  /** Shared tts.provider/tts.voice config.get reports. */
  ttsProvider?: string;
  ttsVoice?: string;
  /**
   * voice.local.status's resting state (SDK 1.9.0-dev's managed provisioning).
   * Default 'not-provisioned' (the size-labeled setup offer). 'unavailable' answers
   * the honest 404 of an older daemon build (the section stays absent entirely).
   */
  localRuntime?: 'not-provisioned' | 'provisioned' | 'unsupported-platform' | 'unavailable';
  /** The voice.local.install receipt outcome. Default 'provisioned' (flips the
   * resting state, exactly like the real one-act flow). */
  localInstallOutcome?: 'provisioned' | 'download-failed';
  /**
   * How long the install POST stays in flight, in ms (default 0, answers
   * immediately). While it is in flight, voice.local.status serves the
   * installInProgress section (SDK 5357f09e), set this to a couple of poll
   * intervals to prove the live-progress rendering end to end.
   */
  localInstallDurationMs?: number;
  /**
   * The `voice.wake.*` rows config.get reports. Merged over the shipped defaults, so
   * omitting this leaves wake detection OFF and the tab never calls getUserMedia,
   * which is the state most voice tests want and the one the product ships.
   */
  wakeConfig?: Record<string, unknown>;
  /**
   * Seed for the three wake verbs. Default: not provisioned (the size-labeled
   * download action). `provisioned: true` serves genuinely loadable ONNX fixtures
   * with their real sha256, so the tab creates a real inference session over them.
   * 'unavailable' answers the 404 of a daemon build without the verbs.
   */
  wake?: {
    provisioned?: boolean;
    /** Seeds the SPEECH GATE's own artifact as verified. Default false. */
    vadProvisioned?: boolean;
    chunkBytes?: number;
    corruptSha?: boolean;
  } | 'unavailable';
}

export interface VoiceMock {
  ttsRequests: { body: unknown }[];
  sttRequests: { body: unknown }[];
  configWrites: { key: unknown; value: unknown }[];
  localInstallRequests: number;
  /** voice.wake.provision calls, it must never happen without an explicit act. */
  wakeProvisionRequests: number;
  /** Every voice.wake.model.get read, in order: the chunk loop, observable. */
  wakeModelReads: { component: string; offset: number }[];
  /** config.get answers served: the wake rows the tab decides from. */
  configReads: number;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

const DEFAULT_PROVIDERS: VoiceProviderSeed[] = [
  { id: 'elevenlabs', label: 'ElevenLabs', configured: true, capabilities: ['tts', 'tts-stream', 'stt', 'voice-list'] },
];

/** Inject a fake AudioContext so the Web Audio player runs deterministically with no real
 * decoding or hardware. decodeAudioData always resolves; a scheduled source "ends" after a
 * generous delay so the playing/Stop state is observable and interruptible. */
export async function installFakeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      decodeAudioData() {
        return Promise.resolve({ duration: 1.5 });
      }
      createBufferSource() {
        const source: {
          buffer: unknown;
          onended: (() => void) | null;
          connect: () => void;
          start: () => void;
          stop: () => void;
        } = {
          buffer: null,
          onended: null,
          connect: () => undefined,
          start: () => {
            setTimeout(() => source.onended?.(), 1500);
          },
          stop: () => {
            source.onended = null;
          },
        };
        return source;
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
    (window as any).AudioContext = FakeAudioContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
    (window as any).webkitAudioContext = FakeAudioContext;
  });
}

/**
 * Record every AudioContext the page constructs (before any app code runs), so a
 * test can wait for the capture graph to actually carry audio instead of sleeping.
 */
export async function trackAudioContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    if (!Native) return;
    const created: AudioContext[] = [];
    (window as unknown as { __audioContexts: AudioContext[] }).__audioContexts = created;
    class TrackedAudioContext extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        created.push(this);
      }
    }
    window.AudioContext = TrackedAudioContext;
  });
}

/**
 * Resolves once the newest AudioContext is running and has processed `seconds`
 * of audio: the microphone graph is really producing samples.
 */
export async function waitForAudioFlow(page: Page, seconds = 0.3): Promise<void> {
  await page.waitForFunction((minimum) => {
    const list = (window as unknown as { __audioContexts?: AudioContext[] }).__audioContexts ?? [];
    const newest = list[list.length - 1];
    return newest !== undefined && newest.state === 'running' && newest.currentTime >= minimum;
  }, seconds);
}

export async function installVoiceRoutes(page: Page, options: VoiceMockOptions = {}): Promise<VoiceMock> {
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const transcript = options.transcript ?? 'hello from voice input';
  const ttsProvider = options.ttsProvider ?? 'elevenlabs';
  const ttsVoice = options.ttsVoice ?? 'rachel';
  const mock: VoiceMock = {
    ttsRequests: [],
    sttRequests: [],
    configWrites: [],
    localInstallRequests: 0,
    wakeProvisionRequests: 0,
    wakeModelReads: [],
    configReads: 0,
  };
  // The wake rows config.get reports. A config.set write MUTATES this, so the
  // round-trip a user actually experiences (tick the box -> the daemon persists it ->
  // the refetch reports it back -> the detector starts) is what the tests exercise,
  // rather than a write that vanishes.
  const wakeConfigState: Record<string, unknown> = { ...options.wakeConfig };
  const wakeOption = options.wake;
  const wakeState = wakeOption === 'unavailable'
    ? null
    : {
      provisioned: wakeOption?.provisioned ?? false,
      vadProvisioned: wakeOption?.vadProvisioned ?? false,
      chunkBytes: wakeOption?.chunkBytes ?? WAKE_MODEL_CHUNK_BYTES,
      corruptSha: wakeOption?.corruptSha ?? false,
    };

  // voice.local.status / voice.local.install in-memory state, install flips the
  // resting state to provisioned (unless seeded to the retriable download failure,
  // which keeps nothing), exactly like the real one-act flow.
  let installActive = false;
  const localRuntime = options.localRuntime ?? 'not-provisioned';
  // Declared as the ONE status shape (or null for the older-daemon 404) rather than
  // letting the ternary infer a union of three mutually incompatible literal shapes:
  // the install handler below reassigns this variable, and against an inferred union
  // every reassignment is a type error even though the runtime value is correct.
  let voiceLocalState: VoiceLocalStatus | null = localRuntime === 'unavailable'
    ? null
    : localRuntime === 'unsupported-platform'
      ? {
          ...voiceLocalStatusResponse(),
          platform: null,
          state: 'unsupported-platform',
          stt: { ...voiceLocalStatusResponse().stt, supported: false, state: 'unsupported-platform' },
          offerBytes: null,
        }
      : localRuntime === 'provisioned'
        ? {
            ...voiceLocalStatusResponse(),
            state: 'provisioned',
            tts: { ...voiceLocalStatusResponse().tts, binaryPresent: true, voicePresent: true },
            stt: { ...voiceLocalStatusResponse().stt, state: 'provisioned', binaryPresent: true, modelPresent: true },
          }
        : voiceLocalStatusResponse();

  // config.get / config.set live at /config (no /api segment).
  await page.route('**/config', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = (request.postDataJSON?.() ?? {}) as { key?: unknown; value?: unknown };
      mock.configWrites.push({ key: body.key, value: body.value });
      if (typeof body.key === 'string' && body.key.startsWith('voice.wake.')) {
        // Persist into the nested shape config.get answers with, so a
        // voice.wake.surfaces.webui write really does turn the surface on.
        const segments = body.key.slice('voice.wake.'.length).split('.');
        let cursor = wakeConfigState;
        for (const segment of segments.slice(0, -1)) {
          const next = cursor[segment];
          if (next === null || typeof next !== 'object') cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[segments[segments.length - 1] as string] = body.value;
      }
      return json(route, { success: true, key: body.key, value: body.value });
    }
    mock.configReads += 1;
    return json(route, {
      ui: { voiceEnabled: true },
      tts: { provider: ttsProvider, voice: ttsVoice, speed: 1 },
      // The wake rows the tab resolves for this surface. Absent keys fall through to
      // the SDK's shipped defaults, which is why an unseeded test never listens.
      voice: { wake: { ...wakeConfigState } },
    });
  });

  await page.route('**/api/voice**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    // Managed local voice (voice.local.status / voice.local.install, SDK 1.9.0-dev).
    // While an install POST is in flight, status carries the installInProgress
    // section (SDK 5357f09e), present during, and only during, the active run,
    // exactly like the daemon's single-flight tracker.
    if (method === 'GET' && path === '/api/voice/local/status') {
      if (!voiceLocalState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      if (installActive) {
        return json(route, { ...voiceLocalState, installInProgress: voiceLocalStatusInProgressResponse().installInProgress });
      }
      return json(route, voiceLocalState);
    }
    if (method === 'POST' && path === '/api/voice/local/install') {
      if (!voiceLocalState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      mock.localInstallRequests += 1;
      const durationMs = options.localInstallDurationMs ?? 0;
      if (durationMs > 0) {
        installActive = true;
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        installActive = false;
      }
      const receipt = voiceLocalInstallResponse(options.localInstallOutcome ?? 'provisioned');
      if (receipt.provisioned) {
        voiceLocalState = {
          ...voiceLocalState,
          state: 'provisioned',
          tts: { ...voiceLocalState.tts, binaryPresent: true, voicePresent: true },
          stt: { ...voiceLocalState.stt, state: 'provisioned', binaryPresent: true, modelPresent: true },
        };
      }
      return json(route, receipt);
    }

    if (method === 'GET' && path === '/api/voice') {
      return json(route, {
        enabled: true,
        providerCount: providers.length,
        providers: providers.map((p) => ({
          id: p.id,
          label: p.label,
          state: p.configured ? 'healthy' : 'unconfigured',
          capabilities: p.capabilities,
          configured: p.configured,
          metadata: {},
        })),
        note: 'Voice capture is intentionally external to the SDK host process.',
      });
    }
    if (method === 'GET' && path === '/api/voice/providers') {
      return json(route, { providers: providers.map((p) => ({ id: p.id, label: p.label, capabilities: p.capabilities })) });
    }
    if (method === 'GET' && path === '/api/voice/voices') {
      return json(route, {
        voices: [
          { id: 'rachel', label: 'Rachel', metadata: {} },
          { id: 'adam', label: 'Adam', metadata: {} },
        ],
      });
    }
    if (method === 'POST' && path === '/api/voice/tts/stream') {
      mock.ttsRequests.push({ body: request.postDataJSON?.() });
      // Throwaway bytes, the fake AudioContext ignores their content.
      return route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        headers: { 'access-control-allow-origin': '*' },
        body: Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]),
      });
    }
    // Browser wake word. These need REAL handlers rather than the catch-all's `{}`:
    // model.get is a chunked binary read whose caller loops on `offset` and verifies
    // the assembled bytes against the sha256 the response states.
    if (method === 'GET' && path === '/api/voice/wake/status') {
      if (!wakeState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      return json(route, wakeStatusResponse(wakeState.provisioned, wakeState.vadProvisioned));
    }
    if (method === 'POST' && path === '/api/voice/wake/provision') {
      if (!wakeState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      mock.wakeProvisionRequests += 1;
      wakeState.provisioned = true;
      return json(route, wakeProvisionResponse());
    }
    if (method === 'GET' && path === '/api/voice/wake/model') {
      if (!wakeState) return json(route, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' }, 404);
      const params = new URL(request.url()).searchParams;
      const component = params.get('component');
      // Validated against the contract-derived set, so a component the daemon
      // serves is never refused here for being unknown to the mock.
      if (!isWakeModelComponentId(component)) {
        return json(route, {
          error: `component must be one of ${WAKE_MODEL_COMPONENT_IDS.join(', ')}`,
        }, 400);
      }
      const offset = Number(params.get('offset') ?? '0');
      mock.wakeModelReads.push({ component, offset: Number.isFinite(offset) ? offset : 0 });
      return json(route, wakeModelChunkResponse(component, Number.isFinite(offset) ? offset : 0, wakeState));
    }

    if (method === 'POST' && path === '/api/voice/stt') {
      mock.sttRequests.push({ body: request.postDataJSON?.() });
      return json(route, { providerId: providers[0]?.id ?? 'elevenlabs', text: transcript, metadata: {} });
    }
    return json(route, {});
  });

  return mock;
}
