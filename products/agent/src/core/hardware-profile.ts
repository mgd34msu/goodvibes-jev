import { readFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { spawn } from 'node:child_process';

/**
 * Raw hardware snapshot for this process.
 * All fields that cannot be determined safely are null.
 * This module never throws, callers always receive a result.
 */
export interface HardwareProfile {
  /** Total physical RAM in bytes, or null when unreadable. */
  readonly totalRamBytes: number | null;
  /** Available/free RAM in bytes at probe time, or null when unreadable. */
  readonly availableRamBytes: number | null;
  /** Discovered GPUs with VRAM sizes (empty when none detected). */
  readonly gpus: readonly GpuInfo[];
  /** Logical CPU core count (hyperthreaded), or null when unreadable. */
  readonly cpuCores: number | null;
}

export interface GpuInfo {
  /** GPU product name (e.g. "NVIDIA GeForce RTX 3090"). */
  readonly name: string;
  /** Total VRAM in bytes, or null when not reported. */
  readonly vramBytes: number | null;
}

/**
 * Plain-language verdict for whether a model fits on this machine.
 *
 * Heuristic (documented):
 *   Quantized model size in bytes is estimated as: params * bytesPerWeight
 *   Default quant assumed Q4 => bytesPerWeight = 0.6 bytes/param
 *   (1-bit quants like Q1 => 0.125, Q2 => 0.25, Q4 => ~0.55, Q8 => 1.0, fp16 => 2.0)
 *
 *   fits-gpu  : modelSizeBytes <= 0.80 * max(gpus[].vramBytes)  (80% headroom for activations)
 *   fits-ram  : modelSizeBytes <= 0.60 * availableRamBytes       (60% of free RAM to leave OS headroom)
 *   tight     : modelSizeBytes <= totalRamBytes                  (fits but will starve other processes)
 *   too-big   : modelSizeBytes > totalRamBytes
 *   unknown   : any required profile field is null / no data
 */
export type FitVerdict = 'fits-gpu' | 'fits-ram' | 'tight' | 'too-big' | 'unknown';

/**
 * Bytes-per-weight constants for common quantization levels.
 * Use these when converting a parameter count to an estimated model size.
 */
export const BYTES_PER_WEIGHT: Readonly<Record<string, number>> = {
  q2: 0.25,
  q4: 0.55,  // Q4_K_M midpoint
  q5: 0.69,
  q8: 1.0,
  f16: 2.0,
  f32: 4.0,
};

/** Default quantization assumed when none is specified (Q4 GGUF). */
export const DEFAULT_BYTES_PER_WEIGHT = BYTES_PER_WEIGHT.q4;

/**
 * Estimate model size in bytes from a parameter count.
 * @param params  Parameter count (e.g. 7_000_000_000 for a 7B model).
 * @param bytesPerWeight  Bytes per weight for the target quant. Defaults to Q4 (0.55).
 */
export function estimateModelBytes(params: number, bytesPerWeight = DEFAULT_BYTES_PER_WEIGHT): number {
  return Math.round(params * bytesPerWeight);
}

/**
 * Assess whether a model fits on the given hardware profile.
 * @param modelSizeBytes  Estimated model size in bytes (use estimateModelBytes if you have param count).
 * @param profile         Hardware profile from readHardwareProfile().
 */
export function fitAssessment(modelSizeBytes: number, profile: HardwareProfile): FitVerdict {
  // Try GPU first, fastest/best path
  const maxVram = maxVramBytes(profile.gpus);
  if (maxVram !== null && modelSizeBytes <= Math.floor(maxVram * 0.80)) {
    return 'fits-gpu';
  }

  // RAM fallback
  if (profile.availableRamBytes !== null) {
    if (modelSizeBytes <= Math.floor(profile.availableRamBytes * 0.60)) {
      return 'fits-ram';
    }
  }

  if (profile.totalRamBytes !== null) {
    return modelSizeBytes <= profile.totalRamBytes ? 'tight' : 'too-big';
  }

  return 'unknown';
}

/**
 * Representative parameter count for a 7B starter model, used when estimating
 * hardware fit across multiple call sites.
 */
export const REPRESENTATIVE_7B_PARAMS = 7_000_000_000;

/**
 * Plain-language description of a fit verdict for display in the TUI renderer and cookbook.
 * When `sizeDescriptor` is provided (e.g. '70B', '3B'), it is used in place of '7B' in the
 * label so the hint reflects the actual model size. When omitted, falls back to '7B'
 * (the representative constant used for the cookbook and unknown-size models).
 * Returns an empty string when verdict is 'unknown' (no annotation shown).
 */
export function fitVerdictLabel(verdict: FitVerdict, sizeDescriptor?: string): string {
  const size = sizeDescriptor ?? '7B';
  switch (verdict) {
    case 'fits-gpu': return `a ${size} model fits in GPU memory here`;
    case 'fits-ram': return `a ${size} model runs on CPU RAM here`;
    case 'tight':    return `a ${size} model is tight here, close other apps`;
    case 'too-big':  return `a ${size} model needs more memory than this machine has`;
    case 'unknown':  return '';
  }
}

/**
 * Parse a parameter count from a model identifier or display name.
 * Matches patterns like '70b', '3b', '1.5b', '7B' (case-insensitive, word-boundary-like).
 * Returns the count as a number (e.g. 70e9 for '70b') or null when no size token is found.
 *
 * Examples:
 *   'llama-3.1-70b'  → 70_000_000_000
 *   'qwen2.5-3b'     → 3_000_000_000
 *   '7b'             → 7_000_000_000
 *   'gpt-4o'         → null
 */
export function paramCountFromModel(model: { id: string; displayName?: string }): number | null {
  const candidates = [model.id, model.displayName ?? ''];
  const re = /(\d+(?:\.\d+)?)\s*b\b/i;
  for (const s of candidates) {
    const m = re.exec(s);
    if (m) {
      const val = parseFloat(m[1]!);
      if (Number.isFinite(val) && val > 0) {
        return Math.round(val * 1e9);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process-level cache, the probe runs at most once per process.
// ---------------------------------------------------------------------------
let cachedProfile: HardwareProfile | null = null;

/**
 * Return a hardware profile immediately without spawning any child process.
 * RAM and CPU are read from OS APIs (cheap, synchronous, non-blocking).
 * GPU information is populated only if a prior `startHardwareProbe()` call
 * has already completed and written to the module cache; otherwise `gpus` is
 * an empty array.
 *
 * This is the correct reader for render-path callers (TUI renderer, cookbook).
 * Never throws; degraded fields are null.
 */
export function readHardwareProfileSync(): HardwareProfile {
  if (cachedProfile !== null) return cachedProfile;
  // Build an immediate profile with RAM+CPU only (no GPU spawn).
  // Populate the cache so repeated sync calls return the same object, and so
  // that subsequent renders are instant. startHardwareProbe() will upgrade
  // this entry with GPU data when the async probe completes.
  const { totalRamBytes, availableRamBytes } = probeRam();
  const cpuCores = probeCpuCores();
  cachedProfile = { totalRamBytes, availableRamBytes, gpus: [], cpuCores };
  return cachedProfile;
}

/**
 * Probe hardware and return a snapshot.
 * Safe to call many times, the OS probe runs exactly once per process.
 * Never throws; degraded fields are null.
 *
 * @deprecated Delegates to `readHardwareProfileSync()`. Prefer calling
 *   `readHardwareProfileSync()` directly on the render path.
 *   GPU data is populated asynchronously, call `startHardwareProbe()` at
 *   application startup so that subsequent `readHardwareProfileSync()` calls
 *   include GPU information; this alias does not trigger the probe itself.
 */
export function readHardwareProfile(): HardwareProfile {
  return readHardwareProfileSync();
}

/**
 * Start a one-time async nvidia-smi probe in the background.
 * When the probe completes it writes a full profile (RAM + CPU + GPUs) into
 * the module cache, so subsequent `readHardwareProfileSync()` calls will
 * include GPU data.
 *
 * Call once at application startup, off the render frame.
 * Never throws; GPU errors are silently ignored.
 */
export function startHardwareProbe(): void {
  try {
    const child = spawn(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 1500 },
    );
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code: number | null) => {
      try {
        const { totalRamBytes, availableRamBytes } = probeRam();
        const cpuCores = probeCpuCores();
        const gpus = code === 0 && chunks.length > 0
          ? parseNvidiaSmiOutput(Buffer.concat(chunks).toString('utf-8'))
          : [];
        // Populate if cache is cold, or upgrade an existing sync-only entry
        // (gpus: []) with the GPU data returned by the async probe.
        cachedProfile = _mergeProbeIntoCache(cachedProfile, { totalRamBytes, availableRamBytes, gpus, cpuCores });
      } catch {
        // GPU probe failure is non-fatal, leave cache unpopulated.
      }
    });
    child.on('error', () => {
      // nvidia-smi not found or not executable, leave cache unpopulated.
    });
  } catch {
    // spawn itself failed, leave cache unpopulated.
  }
}

/** Reset the process-level cache (test use only). */
export function _resetHardwareProfileCache(): void {
  cachedProfile = null;
}

/**
 * Inject a hardware profile into the process-level cache (test use only).
 * Useful when tests need a deterministic hardware profile to exercise
 * verdict/label paths without depending on the real machine's hardware.
 */
export function _setHardwareProfileForTest(profile: HardwareProfile): void {
  cachedProfile = profile;
}

/**
 * Pure helper: decide how to merge a freshly-probed profile into the current
 * module cache. Extracted so the merge logic can be unit-tested independently
 * of the child-process lifecycle.
 *
 * Rules:
 *   - current === null  →  use fresh as-is (cold-cache populate)
 *   - current.gpus.length === 0 && fresh.gpus.length > 0
 *       →  { ...current, gpus: fresh.gpus }  (upgrade only the empty gpus field;
 *          all other fields, RAM, CPU, are kept from the existing entry)
 *   - otherwise  →  return current unchanged (never overwrite non-empty gpus)
 */
export function _mergeProbeIntoCache(
  current: HardwareProfile | null,
  fresh: HardwareProfile,
): HardwareProfile {
  if (current === null) return fresh;
  if (current.gpus.length === 0 && fresh.gpus.length > 0) {
    return { ...current, gpus: fresh.gpus };
  }
  return current;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function probeRam(): { totalRamBytes: number | null; availableRamBytes: number | null } {
  // Linux: try /proc/meminfo first (accurate, no system call overhead)
  try {
    const raw = readFileSync('/proc/meminfo', 'utf-8');
    const parsed = parseProcMeminfo(raw);
    if (parsed.totalRamBytes !== null) return parsed;
  } catch {
    // not Linux or permission denied, fall through to node:os
  }

  // Fallback: node:os (works on macOS/Windows too)
  try {
    const total = totalmem();
    const avail = freemem();
    return {
      totalRamBytes: Number.isFinite(total) && total > 0 ? total : null,
      availableRamBytes: Number.isFinite(avail) && avail > 0 ? avail : null,
    };
  } catch {
    return { totalRamBytes: null, availableRamBytes: null };
  }
}

/**
 * Parse /proc/meminfo text and extract MemTotal and MemAvailable.
 * Lines look like: "MemTotal:       16384000 kB"
 */
export function parseProcMeminfo(raw: string): { totalRamBytes: number | null; availableRamBytes: number | null } {
  let totalKb: number | null = null;
  let availableKb: number | null = null;

  for (const line of raw.split('\n')) {
    if (totalKb === null && line.startsWith('MemTotal:')) {
      totalKb = parseKbLine(line);
    } else if (availableKb === null && line.startsWith('MemAvailable:')) {
      availableKb = parseKbLine(line);
    }
    if (totalKb !== null && availableKb !== null) break;
  }

  return {
    totalRamBytes: totalKb !== null ? totalKb * 1024 : null,
    availableRamBytes: availableKb !== null ? availableKb * 1024 : null,
  };
}

function parseKbLine(line: string): number | null {
  // Format: "MemTotal:       16384000 kB"
  const parts = line.split(/\s+/);
  const kb = parts[1] !== undefined ? Number(parts[1]) : NaN;
  return Number.isFinite(kb) && kb > 0 ? kb : null;
}

/**
 * Parse nvidia-smi CSV output lines into GpuInfo entries.
 * Each line: "GPU Name, vramMiB"
 */
export function parseNvidiaSmiOutput(raw: string): readonly GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of raw.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Last comma-separated field is the memory in MiB
    const lastComma = trimmed.lastIndexOf(',');
    if (lastComma < 0) {
      gpus.push({ name: trimmed, vramBytes: null });
      continue;
    }
    const name = trimmed.slice(0, lastComma).trim();
    const mibStr = trimmed.slice(lastComma + 1).trim();
    const mib = Number(mibStr);
    const vramBytes = Number.isFinite(mib) && mib > 0 ? Math.round(mib * 1024 * 1024) : null;
    gpus.push({ name, vramBytes });
  }
  return gpus;
}

function probeCpuCores(): number | null {
  try {
    const count = cpus().length;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

function maxVramBytes(gpus: readonly GpuInfo[]): number | null {
  let max: number | null = null;
  for (const gpu of gpus) {
    if (gpu.vramBytes !== null && (max === null || gpu.vramBytes > max)) {
      max = gpu.vramBytes;
    }
  }
  return max;
}
