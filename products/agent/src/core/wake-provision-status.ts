// ---------------------------------------------------------------------------
// wake-provision-status.ts, the surface-facing projection of wake-word
// provisioning and of the `voice.wake.*` rows that are or are not in force.
//
// The wake artifacts are checksum-pinned and provisioned ONLY by an explicit act
// (/voice wake setup). This module is the read-only projection those surfaces
// render from: per-artifact present / verified / corrupt / bytes taken straight
// from the SDK's wakeProvisionStatus, which verifies by CONTENT rather than by
// existence, a truncated or wrong-asset file reports corrupt instead of present,
// because a detector loading it would fail in a way the user could not diagnose.
//
// Pure formatting only (no I/O): the command layer fetches the status and hands
// it here, so every builder is testable against fixture shapes.
// ---------------------------------------------------------------------------

import type {
  WakeArtifactStatus,
  WakeProvisionResult,
  WakeProvisionStatus,
  WakeRuntimeSettings,
  WakeSurfaceCapabilities,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import { resolveWakeVadThreshold, WAKE_VAD_MODEL } from '@goodvibes-jev/engine/sdk/platform/voice';
import { SPEEXDSP_PREPROCESS } from '@goodvibes-jev/engine/sdk/platform/voice/capture';

/**
 * What the configured gate threshold does, in the head's own measured numbers.
 *
 * Read from the pinned manifest rather than described in prose here: a threshold
 * whose trade-off a surface states from memory is a number that goes stale the
 * first time the head is retrained.
 */
function vadThresholdNote(threshold: number): string {
  const row = resolveWakeVadThreshold(threshold);
  if (row === null) return '';
  return ` (at ${row.threshold} it passes ${(row.speechPassRate * 100).toFixed(1)}% of speech frames`
    + ` and stops ${(row.noiseGateRate * 100).toFixed(1)}% of non-speech ones)`;
}

/**
 * Bytes as a short human string.
 *
 * Local because this repository has no shared byte formatter, `/voice status`
 * divides by 1024*1024 inline at its call site, and the file tree has its own.
 * One place for the wake surfaces beats a third inline division.
 */
export function formatWakeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What THIS surface can actually do, so a `voice.wake.*` row is refused or
 * reported rather than faked.
 *
 * Lives here, beside the status projection and away from the inference runtime,
 * so `/voice wake status` can resolve settings without pulling onnxruntime into a
 * status call.
 */
export function agentWakeCapabilities(options: { readonly vadReady: boolean }): WakeSurfaceCapabilities {
  return {
    // speexAvailable is DELIBERATELY OMITTED, not passed as a boolean. The
    // platform carries SpeexDSP's preprocessor as a WebAssembly module and
    // WakeListener wraps this surface's opener with it, so the honest answer is
    // "does this runtime have WebAssembly", which the SDK asks itself. Asserting
    // `true` here would claim a filter this file cannot see running, and `false`
    // would refuse a filter that does run.
    //
    // The speech gate is the opposite shape and stays host-declared: the artifact
    // is provisioned, but LOADING an inference session is this surface's job, so
    // `true` means this host has the gate on disk AND wires its session into the
    // engine. wireWakeRuntime derives this from the same provision read that
    // decides whether to load it, so the claim and the wiring cannot disagree,
    // and below 1.0 on either count, `voice.wake.vadThreshold` above 0 is refused
    // rather than letting frames reach the classifier unscreened.
    vadAvailable: options.vadReady,
    // This process has a filesystem (voice.wake.retainAudio) and an audio player
    // (a custom activation-sound file). A host with neither mpv nor ffplay still
    // reports that at the moment of a wake rather than here, the capability is
    // "this surface can read and play a local path", not "a player is installed".
    canRetainAudio: true,
    canPlayLocalFile: true,
  };
}

/** One artifact's line: what is on disk, verified by content. */
export function wakeArtifactLine(label: string, artifact: WakeArtifactStatus): string {
  if (artifact.verified) return `  ${label}: verified (${formatWakeBytes(artifact.bytes)})`;
  if (artifact.corrupt) {
    return `  ${label}: PRESENT BUT FAILS VERIFICATION (${formatWakeBytes(artifact.bytes)}): torn, truncated, or the wrong asset; the next provision replaces it`;
  }
  return `  ${label}: missing`;
}

/**
 * Blockers, in the SDK's own words. A blocker means the detector must NOT start,
 * so the row's key and the written reason are both shown, a swallowed blocker is
 * a user staring at a feature that is on and doing nothing.
 */
export function describeWakeBlockers(settings: Pick<WakeRuntimeSettings, 'blockers'>): string[] {
  return settings.blockers.map((blocker) => `  ${blocker.key}: ${blocker.detail}`);
}

/** Limitations: the detector runs, with one row not in force, and says which. */
export function describeWakeLimitations(settings: Pick<WakeRuntimeSettings, 'limitations'>): string[] {
  return settings.limitations.map((limitation) => `  ${limitation.key}: ${limitation.detail}`);
}

/** The `/voice wake status` block. */
export function wakeStatusLines(
  status: WakeProvisionStatus,
  settings: WakeRuntimeSettings,
): string[] {
  const lines: string[] = [
    `  feature: voice.wake.enabled=${settings.enabled ? 'on' : 'off'}, voice.wake.surfaces.agent=${settings.surfaceEnabled ? 'on' : 'off'}`,
    `  listening on this surface: ${settings.active ? 'yes, when the models are provisioned' : 'no'}`,
    `  models provisioned: ${status.ready ? 'yes' : `no (${status.reason ?? 'not-provisioned'})`}`,
    `  model version: ${status.modelVersion ?? 'unpinned'}`,
    wakeArtifactLine('classifier', status.classifier),
    wakeArtifactLine('speech-embedding front end', status.embedding),
    wakeArtifactLine('attribution NOTICE', status.notice),
    wakeArtifactLine('speech gate (voice.wake.vadThreshold)', status.vad),
    wakeArtifactLine('speech-gate NOTICE', status.vadNotice),
  ];
  if (!status.ready) {
    lines.push(`  a fresh provision would download ${formatWakeBytes(status.downloadBytes)}, fetched automatically when wake detection is turned on`);
  }
  lines.push(
    `  wake models configured: ${settings.modelIds.length > 0 ? settings.modelIds.join(', ') : 'none (voice.wake.models is empty, so nothing is scored)'}`,
    `  recorder: voice.wake.captureCommand=${settings.capture.backend}, device=${settings.capture.device.trim().length > 0 ? settings.capture.device : 'system default'}`,
    // Both rows that used to refuse outright, reported as what they now do.
    `  noise suppression: voice.wake.noiseSuppression=${settings.capture.noiseSuppression}`
      + `${settings.capture.noiseSuppression === 'speex' ? ` (${SPEEXDSP_PREPROCESS.component} ${SPEEXDSP_PREPROCESS.version}, ${SPEEXDSP_PREPROCESS.license}, carried in the package, nothing to install)` : ''}`,
    // Present tense ONLY when it is actually screening. A row set above 0 with no
    // gate on disk is refusing, not filtering, and saying "screening frames" there
    // would be the precise claim the refusal exists to stop.
    `  speech gate: voice.wake.vadThreshold=${settings.vadThreshold}`
      + `${settings.vadThreshold === 0
        ? ' (0 = every frame reaches the classifier, which is the shipped default)'
        : status.vadReady
          ? `, screening frames with goodvibes-vad ${WAKE_VAD_MODEL.version}${vadThresholdNote(settings.vadThreshold)}`
          : `, but the gate is not on disk, so the detector refuses to start rather than leaving frames unscreened; it is fetched with the other wake artifacts (goodvibes-vad ${WAKE_VAD_MODEL.version}${vadThresholdNote(settings.vadThreshold)})`}`
      + `, gate on disk: ${status.vadReady ? 'yes' : 'no'}`,
    `  after a wake: ${settings.autoSubmit ? 'the transcript is submitted as a turn' : 'the transcript is placed in the composer'}`,
    `  indicator: voice.wake.indicator=${settings.indicator}, activation sound=${settings.activationSound.kind}`,
    `  retained audio: voice.wake.retainAudio=${settings.retainAudio}`,
  );
  if (status.recallIsSyntheticOnly) {
    lines.push('  the published recall figures for this model are measured on synthesised speech only; no human recording of the phrase exists behind them.');
  }
  const blockers = describeWakeBlockers(settings);
  if (blockers.length > 0) lines.push('  rows blocking startup:', ...blockers);
  const limitations = describeWakeLimitations(settings);
  if (limitations.length > 0) lines.push('  rows not in force:', ...limitations);
  return lines;
}

/** The `/voice wake setup` receipt. */
export function wakeProvisionReceiptLines(result: WakeProvisionResult): string[] {
  const lines = [
    `  ready: ${result.ready ? 'yes' : 'no'}`,
    `  model version: ${result.modelVersion ?? 'unpinned'}`,
  ];
  for (const outcome of result.outcomes) {
    const detail = outcome.state === 'failed'
      ? `, ${outcome.error ?? 'no reason reported'}`
      : outcome.bytes !== undefined ? ` (${formatWakeBytes(outcome.bytes)})` : '';
    lines.push(`  ${outcome.component}: ${outcome.state}${detail}`);
    lines.push(`    ${outcome.path}`);
  }
  if (result.noticePath !== null) {
    lines.push(`  attribution NOTICE (travels with the classifier): ${result.noticePath}`);
  }
  if (result.recallIsSyntheticOnly) {
    lines.push('  the published recall figures for this model are measured on synthesised speech only; no human recording of the phrase exists behind them.');
  }
  return lines;
}

/** The one-line announcement printed before a (multi-megabyte) provision runs. */
export const WAKE_SETUP_ANNOUNCEMENT = [
  'Wake-Word Setup',
  '  downloading the pinned "hey goodvibes" classifier and the shared speech-embedding front end…',
  '  both are checksum-verified and the download is resumable, so a failed component is retried rather than restarted.',
].join('\n');
