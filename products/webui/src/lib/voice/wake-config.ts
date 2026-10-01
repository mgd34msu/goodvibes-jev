/**
 * wake-config.ts, `voice.wake.*` as this surface resolves it.
 *
 * The daemon's `config.get` answers the WHOLE config tree as nested objects; the
 * SDK's `resolveWakeRuntimeSettings` reads FLAT dotted keys. This is the adapter
 * between them, plus the one honest statement of what a browser tab can do.
 *
 * None of the capability answers is a guess:
 *   - speexAvailable, asked of the SDK, not declared here. The filter is a
 *     WebAssembly module the SDK carries, so the only question is whether this
 *     runtime has WebAssembly, which a tab does: `voice.wake.noiseSuppression:
 *     "speex"` RUNS here, applied by the wrapper inside WakeListener and
 *     PushToTalkSession.
 *   - vadAvailable, follows the daemon's `voice.wake.status`, because the speech
 *     gate is its own pinned artifact. Provisioned, `voice.wake.vadThreshold`
 *     above 0 screens frames; missing, it BLOCKS rather than scoring ungated
 *     behind a row that claims otherwise.
 *   - canRetainAudio, a tab has no filesystem to retain a clip to.
 *   - canPlayLocalFile, a tab cannot read an absolute path on the user's machine,
 *     so a custom activation sound downgrades to the built-in chime.
 *
 * The resolver turns the last two into `limitations` (the detector still runs and
 * says which row is not in force) and the first two into `blockers` (the detector
 * does not start). Only `.active` decides whether a device is opened.
 */
import {
  resolveWakeRuntimeSettings,
  wakeSurfaceKey,
  type WakeRuntimeSettings,
  type WakeSettingReader,
  type WakeSurfaceCapabilities,
} from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { noiseSuppressionSupport } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { asRecord } from '../object';

/** The surface id this tab resolves `voice.wake.surfaces.*` under. */
export const WAKE_SURFACE = 'webui' as const;

/** The `voice.wake.surfaces.webui` key, from the SDK rather than spelled again. */
export const WAKE_SURFACE_KEY = wakeSurfaceKey(WAKE_SURFACE);

/**
 * What a browser tab can actually do. See this file's header for each answer.
 *
 * `speexAvailable` is asked of the SDK rather than declared here: the filter is a
 * WebAssembly module carried in the package, so the only question is whether this
 * runtime has WebAssembly, which a tab does, and the SDK answers it with a
 * reason a settings row can show.
 *
 * `vadAvailable` is NOT a constant, because the speech gate is its own pinned
 * artifact the daemon has to have provisioned: see {@link webuiWakeCapabilities}.
 */
export const WEBUI_WAKE_CAPABILITIES: WakeSurfaceCapabilities = webuiWakeCapabilities(false);

/**
 * Capabilities for a tab, given whether the daemon reports the speech gate
 * provisioned. With the artifact missing, `voice.wake.vadThreshold` above 0 still
 * blocks startup and says why, rather than the tab scoring frames ungated while
 * the row claims they are screened.
 */
export function webuiWakeCapabilities(vadReady: boolean): WakeSurfaceCapabilities {
  return {
    speexAvailable: noiseSuppressionSupport().supported,
    vadAvailable: vadReady,
    canRetainAudio: false,
    canPlayLocalFile: false,
  };
}

/**
 * Read a dotted path out of a `config.get` tree.
 *
 * Returns undefined for anything the tree does not hold, which is exactly what
 * the resolver wants: it then applies the shipped default rather than a zero, so
 * a partial tree resolves to shipped behaviour instead of a disabled detector
 * with every threshold at 0.
 */
export function configPathReader(tree: unknown): WakeSettingReader {
  return (key: string): unknown => {
    const segments = key.split('.');
    let cursor: unknown = tree;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = asRecord(cursor)[segment];
      if (cursor === undefined) return undefined;
    }
    return cursor;
  };
}

/** Resolve every `voice.wake.*` row for this tab from a `config.get` tree. */
export function resolveWebuiWakeSettings(tree: unknown, vadReady = false): WakeRuntimeSettings {
  return resolveWakeRuntimeSettings(configPathReader(tree), WAKE_SURFACE, webuiWakeCapabilities(vadReady));
}
