/**
 * voice-local-setup.ts, the managed local-voice provisioning shapes and pure helper
 * functions (voice.local.status / voice.local.install, SDK 1.9.0-dev's
 * memory-relay-voice-hardening work).
 *
 * `voice.local.status` reports the RESTING state of the managed runtime on disk
 * (piper TTS always; whisper.cpp STT only where goodvibes has a pinned, checksummed
 * build, today that is linux-x64 only, everywhere else STT reports honestly
 * unsupported with a reason). `voice.local.install` is the one-act setup; its result
 * carries a FINER per-engine terminal state than status's resting enum (e.g.
 * checksum-mismatch, bundle-unavailable, sideload-mismatch) because it describes what
 * THIS attempt did, not just where things stand.
 *
 * SDK ADOPTION NOTE (round: webui memory+voice compose, SDK commit efc1b380): the
 * calling brief's own context described voice.local.install as returning/streaming
 * "structured progress" and voice.local.status as reporting a `not-yet-published`
 * engine state. Neither exists on the wire at this commit, verified against
 * packages/sdk/src/platform/control-plane/routes/voice-setup.ts (install is a plain
 * POST returning ONE final JSON result; the provisioner's internal onProgress callback
 * is never wired to any runtime event, SSE frame, or chunked response) and against
 * method-catalog-voice-setup.ts's actual output enums (no `not-yet-published` value
 * anywhere, the closest analogues are `bundle-unavailable`, a hosted-but-not-yet-
 * uploaded engine bundle, currently unreachable in practice since every platform in
 * the manifest that has an entry at all already has a real URL; and
 * `unsupported-platform` with an honest `reason` string for platforms with no pinned
 * build at all). This module and its UI render the REAL enums verbatim rather than
 * inventing the promised-but-absent ones, reported back per this round's brief,
 * not patched around.
 */

export type VoiceLocalRuntimeState = 'not-provisioned' | 'partial' | 'provisioned' | 'unsupported-platform';

export interface VoiceLocalTtsStatus {
  readonly engine: string;
  readonly binaryPresent: boolean;
  readonly voicePresent: boolean;
  readonly binaryPath: string;
  readonly modelPath: string;
}

export interface VoiceLocalSttStatus {
  readonly engine: string;
  readonly supported: boolean;
  readonly state: VoiceLocalRuntimeState;
  readonly binaryPresent: boolean;
  readonly modelPresent: boolean;
  readonly binaryPath: string;
  readonly modelPath: string;
  readonly reason?: string;
}

/** The provisioner's phase vocabulary for one install component (SDK ProvisionPhase). */
export type VoiceLocalInstallPhase = 'skip' | 'download' | 'verify' | 'extract' | 'done' | 'error';

/** The latest observed state of one component of the ACTIVE install run. */
export interface VoiceLocalInstallProgressComponent {
  readonly component: string;
  readonly phase: VoiceLocalInstallPhase;
  readonly message?: string;
  /** The component's pinned size in bytes, where the manifest knows it. */
  readonly bytesTotal?: number;
  /** Bytes landed on disk, where known, completion boundaries only (downloads
   * verify whole-file; bytes are not streamed mid-transfer). */
  readonly bytesDone?: number;
}

/**
 * voice.local.status's OPTIONAL `installInProgress` section (SDK 5357f09e): present
 * while, and only while, an install run is active, so a surface polling status
 * during its own install call renders live per-component progress. Absent on an
 * older daemon (or between installs), the surface falls back to a plain busy state.
 */
export interface VoiceLocalInstallProgress {
  readonly startedAt: number;
  readonly components: readonly VoiceLocalInstallProgressComponent[];
}

export interface VoiceLocalStatusSnapshot {
  readonly platform: string | null;
  readonly state: VoiceLocalRuntimeState;
  readonly tts: VoiceLocalTtsStatus;
  readonly stt: VoiceLocalSttStatus;
  /** Size-labeled offer for the one-act install, in bytes, null when no pinned build
   * exists for this platform at all (nothing to offer). */
  readonly offerBytes: number | null;
  /** Live progress of the ACTIVE install run, see VoiceLocalInstallProgress. */
  readonly installInProgress?: VoiceLocalInstallProgress;
}

/** The real wire enum for an install attempt's per-engine terminal state, richer than
 * VoiceLocalRuntimeState because it names WHY an attempt didn't land. */
export type VoiceLocalInstallEngineState =
  | 'provisioned'
  | 'unsupported-platform'
  | 'download-failed'
  | 'checksum-mismatch'
  | 'bundle-unavailable'
  | 'sideload-mismatch';

export interface VoiceLocalInstallEngineOutcome {
  readonly engine: string;
  readonly state: VoiceLocalInstallEngineState;
  readonly binaryPath?: string;
  readonly modelPath?: string;
  readonly reason?: string;
}

export interface VoiceLocalInstallComponentOutcome {
  readonly id: string;
  readonly state: 'installed' | 'skipped' | 'failed';
  readonly bytes?: number;
  readonly error?: string;
}

export interface VoiceLocalInstallResult {
  readonly provisioned: boolean;
  readonly platform: string | null;
  readonly tts: VoiceLocalInstallEngineOutcome;
  readonly stt: VoiceLocalInstallEngineOutcome;
  readonly components: readonly VoiceLocalInstallComponentOutcome[];
  readonly configured: {
    readonly set: readonly { key: string; value: string }[];
    readonly skipped: readonly { key: string; reason: string }[];
  };
}

const RUNTIME_STATES: readonly VoiceLocalRuntimeState[] = [
  'not-provisioned', 'partial', 'provisioned', 'unsupported-platform',
];

const INSTALL_ENGINE_STATES: readonly VoiceLocalInstallEngineState[] = [
  'provisioned', 'unsupported-platform', 'download-failed', 'checksum-mismatch', 'bundle-unavailable', 'sideload-mismatch',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Defensive wire parse: the REAL voice.local.status snapshot, or null when the answer
 * does not carry one (a daemon or intermediary answering 200 with an empty/foreign
 * body). Null means "render the honest cannot-read state", never a crash or a
 * fabricated 'undefined' label. Same lenient-read stance voice-config.ts documents.
 * Only the load-bearing `state` enum is required; per-engine detail degrades field by
 * field.
 */
const INSTALL_PHASES: readonly VoiceLocalInstallPhase[] = ['skip', 'download', 'verify', 'extract', 'done', 'error'];

/** Parse the optional installInProgress section, dropping malformed entries rather
 * than sinking the whole status read (the section is progress decoration, not the
 * load-bearing runtime state). Undefined when absent or unusable. */
function readInstallProgress(value: unknown): VoiceLocalInstallProgress | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return undefined;
  const components = (Array.isArray(value.components) ? value.components : [])
    .filter(isRecord)
    .flatMap((entry): VoiceLocalInstallProgressComponent[] => {
      const phase = INSTALL_PHASES.find((p) => p === entry.phase);
      if (!phase || typeof entry.component !== 'string' || !entry.component) return [];
      return [{
        component: entry.component,
        phase,
        ...(readOptionalString(entry.message) !== undefined ? { message: readOptionalString(entry.message) } : {}),
        ...(typeof entry.bytesTotal === 'number' && Number.isFinite(entry.bytesTotal) ? { bytesTotal: entry.bytesTotal } : {}),
        ...(typeof entry.bytesDone === 'number' && Number.isFinite(entry.bytesDone) ? { bytesDone: entry.bytesDone } : {}),
      }];
    });
  return { startedAt: value.startedAt, components };
}

export function readVoiceLocalStatus(value: unknown): VoiceLocalStatusSnapshot | null {
  if (!isRecord(value)) return null;
  const state = RUNTIME_STATES.find((s) => s === value.state);
  if (!state) return null;
  const tts = isRecord(value.tts) ? value.tts : {};
  const stt = isRecord(value.stt) ? value.stt : {};
  const installInProgress = readInstallProgress(value.installInProgress);
  return {
    ...(installInProgress !== undefined ? { installInProgress } : {}),
    platform: typeof value.platform === 'string' ? value.platform : null,
    state,
    tts: {
      engine: typeof tts.engine === 'string' ? tts.engine : 'piper',
      binaryPresent: tts.binaryPresent === true,
      voicePresent: tts.voicePresent === true,
      binaryPath: typeof tts.binaryPath === 'string' ? tts.binaryPath : '',
      modelPath: typeof tts.modelPath === 'string' ? tts.modelPath : '',
    },
    stt: {
      engine: typeof stt.engine === 'string' ? stt.engine : 'whisper-cpp',
      supported: stt.supported === true,
      state: RUNTIME_STATES.find((s) => s === stt.state) ?? 'not-provisioned',
      binaryPresent: stt.binaryPresent === true,
      modelPresent: stt.modelPresent === true,
      binaryPath: typeof stt.binaryPath === 'string' ? stt.binaryPath : '',
      modelPath: typeof stt.modelPath === 'string' ? stt.modelPath : '',
      ...(readOptionalString(stt.reason) !== undefined ? { reason: readOptionalString(stt.reason) } : {}),
    },
    offerBytes: typeof value.offerBytes === 'number' && Number.isFinite(value.offerBytes) ? value.offerBytes : null,
  };
}

function readInstallEngineOutcome(value: unknown, fallbackEngine: string): VoiceLocalInstallEngineOutcome | null {
  if (!isRecord(value)) return null;
  const state = INSTALL_ENGINE_STATES.find((s) => s === value.state);
  if (!state) return null;
  return {
    engine: typeof value.engine === 'string' ? value.engine : fallbackEngine,
    state,
    ...(readOptionalString(value.binaryPath) !== undefined ? { binaryPath: readOptionalString(value.binaryPath) } : {}),
    ...(readOptionalString(value.modelPath) !== undefined ? { modelPath: readOptionalString(value.modelPath) } : {}),
    ...(readOptionalString(value.reason) !== undefined ? { reason: readOptionalString(value.reason) } : {}),
  };
}

/** Defensive wire parse for the voice.local.install receipt, null when the answer
 * does not carry one (same stance as readVoiceLocalStatus above). Both per-engine
 * terminal states are load-bearing (the receipt is meaningless without them). */
export function readVoiceLocalInstallResult(value: unknown): VoiceLocalInstallResult | null {
  if (!isRecord(value)) return null;
  const tts = readInstallEngineOutcome(value.tts, 'piper');
  const stt = readInstallEngineOutcome(value.stt, 'whisper-cpp');
  if (!tts || !stt) return null;
  const configured = isRecord(value.configured) ? value.configured : {};
  return {
    provisioned: value.provisioned === true,
    platform: typeof value.platform === 'string' ? value.platform : null,
    tts,
    stt,
    components: (Array.isArray(value.components) ? value.components : [])
      .filter(isRecord)
      .map((entry): VoiceLocalInstallComponentOutcome => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        state: entry.state === 'installed' || entry.state === 'skipped' || entry.state === 'failed' ? entry.state : 'failed',
        ...(typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) ? { bytes: entry.bytes } : {}),
        ...(readOptionalString(entry.error) !== undefined ? { error: readOptionalString(entry.error) } : {}),
      }))
      .filter((entry) => entry.id !== ''),
    configured: {
      set: (Array.isArray(configured.set) ? configured.set : [])
        .filter(isRecord)
        .map((entry) => ({
          key: typeof entry.key === 'string' ? entry.key : '',
          value: typeof entry.value === 'string' ? entry.value : '',
        }))
        .filter((entry) => entry.key !== ''),
      skipped: (Array.isArray(configured.skipped) ? configured.skipped : [])
        .filter(isRecord)
        .map((entry) => ({
          key: typeof entry.key === 'string' ? entry.key : '',
          reason: typeof entry.reason === 'string' ? entry.reason : '',
        }))
        .filter((entry) => entry.key !== ''),
    },
  };
}

/** True when the resting status justifies offering the one-act setup action,
 * 'unsupported-platform' gets an honest message instead (no pinned build exists for
 * this platform at all, so an install attempt cannot succeed). */
export function voiceLocalNeedsSetup(status: VoiceLocalStatusSnapshot): boolean {
  return status.state === 'not-provisioned' || status.state === 'partial';
}

/** Human label for the resting runtime state. */
export function voiceLocalStateLabel(state: VoiceLocalRuntimeState): string {
  switch (state) {
    case 'provisioned': return 'Installed';
    case 'partial': return 'Partially installed';
    case 'not-provisioned': return 'Not set up';
    case 'unsupported-platform': return 'Not supported on this platform';
  }
}

/** Human label for an install attempt's per-engine terminal state. */
export function voiceLocalInstallStateLabel(state: VoiceLocalInstallEngineState): string {
  switch (state) {
    case 'provisioned': return 'Installed';
    case 'unsupported-platform': return 'Not supported on this platform';
    case 'download-failed': return 'Download failed';
    case 'checksum-mismatch': return 'Checksum mismatch';
    case 'bundle-unavailable': return 'Not yet published for this platform';
    case 'sideload-mismatch': return 'Sideloaded file does not match the pinned build';
  }
}

/** True when retrying the SAME one-act install (the only retry surface that exists,
 * there is no per-engine retry verb) is a genuinely useful action for this terminal
 * state: a download or checksum failure may well succeed on a fresh attempt. A
 * platform gap, an unpublished bundle, or a mismatched sideloaded file will not be
 * fixed by clicking the same button again. */
export function voiceLocalInstallIsRetriable(state: VoiceLocalInstallEngineState): boolean {
  return state === 'download-failed' || state === 'checksum-mismatch';
}

/** Human label for a live install component's phase. */
export function voiceLocalPhaseLabel(phase: VoiceLocalInstallPhase): string {
  switch (phase) {
    case 'skip': return 'Already present';
    case 'download': return 'Downloading';
    case 'verify': return 'Verifying';
    case 'extract': return 'Extracting';
    case 'done': return 'Done';
    case 'error': return 'Failed';
  }
}
