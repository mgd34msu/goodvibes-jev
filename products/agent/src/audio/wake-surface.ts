/**
 * wake-surface.ts, which `voice.wake.surfaces.*` row this product listens on.
 *
 * One line of code in its own file for a load-bearing reason: this constant is
 * needed by the SETTINGS path, and wake-runtime.ts (where it used to live)
 * imports the inference runtime, which pulls onnxruntime-web and its ambient
 * wasm module declarations behind it. Importing the name from there dragged
 * that whole chain into every build that touched settings, including the
 * tooling build that has no ambient declarations for it.
 *
 * A constant with no dependencies belongs where anything can reach it.
 */
import type { WakeSurface } from '@goodvibes-jev/engine/sdk/platform/voice';

/** The `voice.wake.surfaces.*` row this surface listens on. */
export const AGENT_WAKE_SURFACE: WakeSurface = 'agent';
