/**
 * wake-inference.ts, this surface's inference runtime for the wake engine.
 *
 * The SDK engine never imports an inference runtime; it declares the shape of a
 * session ({@link WakeInferenceSession}) and takes one from the host. This is
 * that host half: onnxruntime-web on its WASM backend, which serves a browser tab
 * and bun from the same package with no native module to build.
 *
 * WHY THE TWO ASSETS ARE COPIED TO DISK
 *
 * onnxruntime-web loads its WASM glue by DYNAMIC IMPORT of a path, and a
 * `bun build --compile` binary cannot satisfy that: the runtime asks for
 * `/$bunfs/root/ort-wasm-simd-threaded.mjs`, which is not something bun embeds
 * for a dynamic path import, and session creation fails at runtime with
 * "Cannot find module". So both assets are imported with `with { type: 'file' }`
 *, embedded in the binary, handed to us as a path, written into a directory
 * this surface owns, and `ort.env.wasm.wasmPaths` is pointed at that directory.
 * The same code path runs from source, where the imports resolve to the real
 * files in node_modules and the copy is a no-op after the first launch.
 *
 * The copy is content-checked, not timestamp-checked: an identical byte length
 * and identical bytes mean the file already on disk is the one this build wants,
 * so nothing is rewritten. A different build writes its own bytes over the top
 * rather than trusting a stale extraction from a previous version.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-web/wasm';
import glueAssetPath from 'onnxruntime-web/ort-wasm-simd-threaded.mjs' with { type: 'file' };
import wasmAssetPath from 'onnxruntime-web/ort-wasm-simd-threaded.wasm' with { type: 'file' };
import type {
  WakeInferenceSession,
  WakeModelHandle,
  WakeRuntimeSettings,
  WakeTensor,
  WakeVadGate,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import { WakeWordEngine } from '@goodvibes-jev/engine/sdk/platform/voice';

/**
 * The runtime asks for its glue and its wasm by these exact names, relative to
 * `ort.env.wasm.wasmPaths`, so the extracted copies must keep them.
 */
const ORT_ASSETS = [
  { source: glueAssetPath, name: 'ort-wasm-simd-threaded.mjs' },
  { source: wasmAssetPath, name: 'ort-wasm-simd-threaded.wasm' },
] as const;

/** Set once, before the first session is created; changing it afterwards has no effect. */
let configuredAssetDirectory: string | null = null;

/**
 * Copy the onnxruntime-web assets into `directory` and return the value
 * `ort.env.wasm.wasmPaths` wants, a directory prefix WITH its trailing slash,
 * which the runtime concatenates a file name onto. Without the slash it looks
 * for a sibling of the directory and reports a missing module.
 */
export function extractOnnxRuntimeAssets(directory: string): string {
  mkdirSync(directory, { recursive: true });
  for (const asset of ORT_ASSETS) {
    const target = join(directory, asset.name);
    const bytes = readFileSync(asset.source);
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(target);
    } catch {
      // Absent, or unreadable: either way it gets written below.
    }
    if (existing !== null && existing.equals(bytes)) continue;
    writeFileSync(target, bytes);
  }
  return `${directory}/`;
}

/**
 * Point onnxruntime-web at the extracted assets and pin its threading.
 *
 * `numThreads = 1` is not a conservatism: the engine costs ~3.5 ms per 80 ms
 * frame single-threaded, comfortably inside its budget, while a threaded WASM
 * build needs a cross-origin-isolated environment to get its workers and would
 * spend the difference failing to start them.
 */
export function configureOnnxRuntime(assetDirectory: string): void {
  if (configuredAssetDirectory === assetDirectory) return;
  ort.env.wasm.wasmPaths = extractOnnxRuntimeAssets(assetDirectory);
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  configuredAssetDirectory = assetDirectory;
}

/**
 * Adapt an onnxruntime session to the SDK's session shape.
 *
 * The engine reads `inputNames[0]` / `outputNames[0]` rather than hard-coded
 * names, so the pinned classifier (`onnx::Flatten_0` -> `output`) and the
 * speech-embedding front end (`input_1` -> `embedding`) both work through this
 * one adapter with nothing per-model here.
 */
export function adaptOnnxSession(session: ort.InferenceSession): WakeInferenceSession {
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    async run(feeds: Readonly<Record<string, WakeTensor>>): Promise<Readonly<Record<string, WakeTensor>>> {
      const inputs: Record<string, ort.Tensor> = {};
      for (const [name, tensor] of Object.entries(feeds)) {
        inputs[name] = new ort.Tensor('float32', tensor.data, [...tensor.dims]);
      }
      const outputs = await session.run(inputs);
      const result: Record<string, WakeTensor> = {};
      for (const [name, tensor] of Object.entries(outputs)) {
        // Every tensor the wake graphs produce is float32; the cast narrows the
        // runtime's union of typed-array data types to the one this path sees.
        result[name] = { data: tensor.data as Float32Array, dims: [...tensor.dims] };
      }
      return result;
    },
    release: () => session.release(),
  };
}

/** Load one .onnx file into an adapted session. */
export async function loadWakeSession(modelPath: string): Promise<WakeInferenceSession> {
  const bytes = readFileSync(modelPath);
  const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ['wasm'],
  });
  return adaptOnnxSession(session);
}

export interface WakeEngineFactoryOptions {
  /** Directory this surface owns for the extracted onnxruntime assets. */
  readonly assetDirectory: string;
  /** The provisioned speech-embedding front end. */
  readonly embeddingPath: string;
  /** The provisioned classifiers, in configuration order. */
  readonly models: readonly { readonly id: string; readonly path: string }[];
  /**
   * The provisioned speech gate, and whether it is on disk and verified.
   *
   * Loaded ONLY when `voice.wake.vadThreshold` is above 0, because the row's
   * shipped default is 0 and an unused session is a model file read for nothing.
   * A configured gate that will not load is fatal to the start rather than
   * skipped: the caller asked for frames to be screened, and running them through
   * unscreened while the row says otherwise is the failure the row guards.
   */
  readonly vad?: { readonly path: string; readonly ready: boolean } | undefined;
  readonly settings: Pick<WakeRuntimeSettings, 'tuning' | 'preRollMs' | 'vadThreshold'>;
  /** Where a classifier that fails to run is reported (the engine skips it rather than dying). */
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
  /** Injected in tests: a stub session per path, so no real model file is read. */
  readonly loadSession?: (modelPath: string) => Promise<WakeInferenceSession>;
}

/**
 * Build the `createEngine` callback the SDK listener drives.
 *
 * The listener calls it on EVERY start including a restart, because a restart
 * exists to recover from a runtime that died, so the sessions are created here
 * per call rather than captured once.
 */
export function createWakeEngineFactory(options: WakeEngineFactoryOptions): () => Promise<WakeWordEngine> {
  const load = options.loadSession ?? loadWakeSession;
  return async () => {
    if (options.loadSession === undefined) configureOnnxRuntime(options.assetDirectory);
    const embedding = await load(options.embeddingPath);
    const models: WakeModelHandle[] = [];
    for (const model of options.models) {
      models.push({ id: model.id, session: await load(model.path) });
    }
    // The gate runs over the SAME embedding the classifiers consume, so turning it
    // on costs one small inference per frame and no second front-end pass.
    let vad: WakeVadGate | undefined;
    if (options.settings.vadThreshold > 0 && options.vad !== undefined) {
      if (!options.vad.ready) {
        throw new Error(
          `voice.wake.vadThreshold is ${options.settings.vadThreshold}, but the speech gate is not on disk. `
          + 'Refusing to start rather than scoring frames the row says are being screened; the gate is fetched with '
          + 'the rest of the wake artifacts.',
        );
      }
      vad = { session: await load(options.vad.path), threshold: options.settings.vadThreshold };
    }
    return new WakeWordEngine({
      embedding,
      models,
      ...(vad !== undefined ? { vad } : {}),
      tuning: options.settings.tuning,
      preRollMs: options.settings.preRollMs,
      warn: options.warn,
    });
  };
}
