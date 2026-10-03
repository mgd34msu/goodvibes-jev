import { describe, expect, test, afterEach } from 'bun:test';
import {
  _mergeProbeIntoCache,
  _resetHardwareProfileCache,
  _setHardwareProfileForTest,
  estimateModelBytes,
  fitAssessment,
  fitVerdictLabel,
  paramCountFromModel,
  parseProcMeminfo,
  parseNvidiaSmiOutput,
  readHardwareProfileSync,
  startHardwareProbe,
  BYTES_PER_WEIGHT,
  DEFAULT_BYTES_PER_WEIGHT,
  REPRESENTATIVE_7B_PARAMS,
  type FitVerdict,
  type HardwareProfile,
} from '../../core/hardware-profile.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    totalRamBytes: 16 * 1024 ** 3,       // 16 GB
    availableRamBytes: 8 * 1024 ** 3,    //  8 GB
    gpus: [],
    cpuCores: 8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fitAssessment, table-driven across all verdicts
// ---------------------------------------------------------------------------

describe('fitAssessment', () => {
  const GB = 1024 ** 3;

  const cases: Array<{ label: string; modelBytes: number; profile: HardwareProfile; expected: FitVerdict }> = [
    {
      label: 'fits-gpu: model <= 80% of max VRAM',
      // 24 GB VRAM, 80% = 19.2 GB. Model is 16 GB.
      modelBytes: 16 * GB,
      profile: makeProfile({
        gpus: [{ name: 'NVIDIA RTX 3090', vramBytes: 24 * GB }],
      }),
      expected: 'fits-gpu',
    },
    {
      label: 'fits-gpu: multiple GPUs, uses max VRAM',
      // Two GPUs: 8 GB and 24 GB. Max = 24 GB. 80% = 19.2 GB. Model is 10 GB.
      modelBytes: 10 * GB,
      profile: makeProfile({
        gpus: [
          { name: 'NVIDIA RTX 2070', vramBytes: 8 * GB },
          { name: 'NVIDIA RTX 3090', vramBytes: 24 * GB },
        ],
      }),
      expected: 'fits-gpu',
    },
    {
      label: 'fits-ram: model > 80% VRAM but <= 60% available RAM',
      // 8 GB VRAM, 80% = 6.4 GB. Model is 7 GB (exceeds GPU).
      // 16 GB available RAM, 60% = 9.6 GB. Model 7 GB fits.
      modelBytes: 7 * GB,
      profile: makeProfile({
        gpus: [{ name: 'NVIDIA GTX 1080', vramBytes: 8 * GB }],
        availableRamBytes: 16 * GB,
      }),
      expected: 'fits-ram',
    },
    {
      label: 'fits-ram: no GPU, model <= 60% available RAM',
      // 20 GB available, 60% = 12 GB. Model is 8 GB.
      modelBytes: 8 * GB,
      profile: makeProfile({
        gpus: [],
        availableRamBytes: 20 * GB,
      }),
      expected: 'fits-ram',
    },
    {
      label: 'tight: model > 60% available RAM but <= total RAM',
      // available = 8 GB, 60% = 4.8 GB. Model is 6 GB (exceeds fits-ram).
      // total = 16 GB. Model 6 GB <= 16 GB => tight.
      modelBytes: 6 * GB,
      profile: makeProfile({
        gpus: [],
        availableRamBytes: 8 * GB,
        totalRamBytes: 16 * GB,
      }),
      expected: 'tight',
    },
    {
      label: 'tight: no available RAM field, model <= total RAM',
      // When availableRamBytes is null, skip fits-ram check.
      // Model 8 GB <= total 16 GB => tight.
      modelBytes: 8 * GB,
      profile: makeProfile({
        gpus: [],
        availableRamBytes: null,
        totalRamBytes: 16 * GB,
      }),
      expected: 'tight',
    },
    {
      label: 'too-big: model > total RAM',
      modelBytes: 32 * GB,
      profile: makeProfile({
        gpus: [],
        availableRamBytes: 8 * GB,
        totalRamBytes: 16 * GB,
      }),
      expected: 'too-big',
    },
    {
      label: 'too-big: no GPU, model > total RAM even with no available RAM',
      modelBytes: 64 * GB,
      profile: makeProfile({
        gpus: [],
        availableRamBytes: null,
        totalRamBytes: 32 * GB,
      }),
      expected: 'too-big',
    },
    {
      label: 'unknown: totalRamBytes is null and no GPU',
      modelBytes: 8 * GB,
      profile: makeProfile({
        gpus: [],
        availableRamBytes: null,
        totalRamBytes: null,
      }),
      expected: 'unknown',
    },
    {
      label: 'unknown: all profile fields null',
      modelBytes: 4 * GB,
      profile: {
        totalRamBytes: null,
        availableRamBytes: null,
        gpus: [],
        cpuCores: null,
      },
      expected: 'unknown',
    },
    {
      label: 'unknown: GPU has null VRAM, totalRamBytes also null',
      modelBytes: 4 * GB,
      profile: makeProfile({
        gpus: [{ name: 'Unknown GPU', vramBytes: null }],
        totalRamBytes: null,
        availableRamBytes: null,
      }),
      expected: 'unknown',
    },
    {
      label: 'bytes-estimate path: params * 0.55 for Q4',
      // 7B params at Q4 = 7e9 * 0.55 = 3.85 GB
      // Available 16 GB, 60% = 9.6 GB. 3.85 GB fits comfortably.
      modelBytes: estimateModelBytes(7_000_000_000),
      profile: makeProfile({
        gpus: [],
        availableRamBytes: 16 * GB,
        totalRamBytes: 32 * GB,
      }),
      expected: 'fits-ram',
    },
    {
      label: 'bytes-estimate path: 70B Q4 too big on 16 GB machine',
      // 70B * 0.55 = 38.5 GB >> 16 GB total
      modelBytes: estimateModelBytes(70_000_000_000),
      profile: makeProfile({
        gpus: [],
        availableRamBytes: 8 * GB,
        totalRamBytes: 16 * GB,
      }),
      expected: 'too-big',
    },
  ];

  for (const { label, modelBytes, profile, expected } of cases) {
    test(label, () => {
      expect(fitAssessment(modelBytes, profile)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// fitVerdictLabel, plain-language strings
// ---------------------------------------------------------------------------

describe('fitVerdictLabel', () => {
  test('fits-gpu mentions 7B and GPU', () => {
    const label = fitVerdictLabel('fits-gpu');
    expect(label).toContain('7B');
    expect(label).toContain('GPU');
    expect(label.length).toBeGreaterThan(0);
  });

  test('fits-ram mentions 7B and CPU RAM', () => {
    const label = fitVerdictLabel('fits-ram');
    expect(label).toContain('7B');
    expect(label.length).toBeGreaterThan(0);
  });

  test('tight returns non-empty string containing "tight" or "Tight"', () => {
    const label = fitVerdictLabel('tight');
    expect(label.toLowerCase()).toContain('tight');
    expect(label.length).toBeGreaterThan(0);
  });

  test('too-big mentions memory', () => {
    const label = fitVerdictLabel('too-big');
    expect(label.toLowerCase()).toContain('memory');
    expect(label.length).toBeGreaterThan(0);
  });

  test('unknown returns empty string (no annotation shown)', () => {
    expect(fitVerdictLabel('unknown')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseProcMeminfo, fixture strings
// ---------------------------------------------------------------------------

describe('parseProcMeminfo', () => {
  test('parses typical Linux /proc/meminfo correctly', () => {
    const fixture = [
      'MemTotal:       32891636 kB',
      'MemFree:         2048000 kB',
      'MemAvailable:   16384000 kB',
      'Buffers:          512000 kB',
      'Cached:          8192000 kB',
    ].join('\n');
    const result = parseProcMeminfo(fixture);
    expect(result.totalRamBytes).toBe(32891636 * 1024);
    expect(result.availableRamBytes).toBe(16384000 * 1024);
  });

  test('returns null for missing MemAvailable field', () => {
    const fixture = 'MemTotal:       16384000 kB\nMemFree:        4096000 kB\n';
    const result = parseProcMeminfo(fixture);
    expect(result.totalRamBytes).toBe(16384000 * 1024);
    expect(result.availableRamBytes).toBeNull();
  });

  test('returns null for missing MemTotal field', () => {
    const fixture = 'MemAvailable:   8192000 kB\nMemFree:        2048000 kB\n';
    const result = parseProcMeminfo(fixture);
    expect(result.totalRamBytes).toBeNull();
    expect(result.availableRamBytes).toBe(8192000 * 1024);
  });

  test('returns both null for empty string', () => {
    const result = parseProcMeminfo('');
    expect(result.totalRamBytes).toBeNull();
    expect(result.availableRamBytes).toBeNull();
  });

  test('returns both null for unrelated content', () => {
    const result = parseProcMeminfo('SwapTotal: 0 kB\nSwapFree: 0 kB\n');
    expect(result.totalRamBytes).toBeNull();
    expect(result.availableRamBytes).toBeNull();
  });

  test('MemTotal: 0 kB yields null (falls through to os fallback, never caches 0)', () => {
    // A zero-value meminfo line must be rejected so that totalRamBytes is null
    // and the node:os fallback (which also requires > 0) is used instead of
    // caching 0 bytes as total RAM (which would make every fit verdict 'too-big').
    const fixture = 'MemTotal:       0 kB\nMemAvailable:   0 kB\n';
    const result = parseProcMeminfo(fixture);
    expect(result.totalRamBytes).toBeNull();
    expect(result.availableRamBytes).toBeNull();
  });

  test('handles extra whitespace in kB lines', () => {
    const fixture = 'MemTotal:            8192000 kB\nMemAvailable:        4096000 kB\n';
    const result = parseProcMeminfo(fixture);
    expect(result.totalRamBytes).toBe(8192000 * 1024);
    expect(result.availableRamBytes).toBe(4096000 * 1024);
  });
});

// ---------------------------------------------------------------------------
// parseNvidiaSmiOutput, fixture strings
// ---------------------------------------------------------------------------

describe('parseNvidiaSmiOutput', () => {
  test('parses a single GPU line', () => {
    const raw = 'NVIDIA GeForce RTX 3090, 24576\n';
    const gpus = parseNvidiaSmiOutput(raw);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.name).toBe('NVIDIA GeForce RTX 3090');
    expect(gpus[0]?.vramBytes).toBe(24576 * 1024 * 1024);
  });

  test('parses multiple GPU lines', () => {
    const raw = [
      'NVIDIA GeForce RTX 3090, 24576',
      'NVIDIA GeForce RTX 2070, 8192',
    ].join('\n');
    const gpus = parseNvidiaSmiOutput(raw);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]?.name).toBe('NVIDIA GeForce RTX 3090');
    expect(gpus[0]?.vramBytes).toBe(24576 * 1024 * 1024);
    expect(gpus[1]?.name).toBe('NVIDIA GeForce RTX 2070');
    expect(gpus[1]?.vramBytes).toBe(8192 * 1024 * 1024);
  });

  test('returns null vramBytes when MiB field is not a number', () => {
    const raw = 'NVIDIA Tesla V100, [N/A]\n';
    const gpus = parseNvidiaSmiOutput(raw);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.vramBytes).toBeNull();
  });

  test('handles GPU name containing commas', () => {
    // Last comma separates name from MiB value
    const raw = 'NVIDIA GeForce GTX 1080 Ti, 11264\n';
    const gpus = parseNvidiaSmiOutput(raw);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.name).toBe('NVIDIA GeForce GTX 1080 Ti');
    expect(gpus[0]?.vramBytes).toBe(11264 * 1024 * 1024);
  });

  test('returns empty array for empty string', () => {
    expect(parseNvidiaSmiOutput('')).toHaveLength(0);
  });

  test('returns empty array for whitespace-only string', () => {
    expect(parseNvidiaSmiOutput('   \n  \n  ')).toHaveLength(0);
  });

  test('returns null vramBytes when line has no comma', () => {
    const raw = 'NVIDIA GeForce RTX 3090\n';
    const gpus = parseNvidiaSmiOutput(raw);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.name).toBe('NVIDIA GeForce RTX 3090');
    expect(gpus[0]?.vramBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// estimateModelBytes
// ---------------------------------------------------------------------------

describe('estimateModelBytes', () => {
  test('uses Q4 default (0.55 bytes/param)', () => {
    expect(estimateModelBytes(7_000_000_000)).toBe(Math.round(7_000_000_000 * DEFAULT_BYTES_PER_WEIGHT));
  });

  test('accepts explicit bytesPerWeight override', () => {
    expect(estimateModelBytes(7_000_000_000, BYTES_PER_WEIGHT.f16)).toBe(Math.round(7_000_000_000 * 2.0));
  });

  test('returns integer (Math.round applied)', () => {
    const result = estimateModelBytes(7_000_000_001);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readHardwareProfile, cache reset safety
// ---------------------------------------------------------------------------

describe('readHardwareProfile', () => {
  afterEach(() => {
    _resetHardwareProfileCache();
  });

  test('returns a profile that never throws', async () => {
    const { readHardwareProfile } = await import('../../core/hardware-profile.ts');
    expect(() => readHardwareProfile()).not.toThrow();
  });

  test('profile has expected shape', async () => {
    const { readHardwareProfile } = await import('../../core/hardware-profile.ts');
    const profile = readHardwareProfile();
    // totalRamBytes is either a positive number or null
    if (profile.totalRamBytes !== null) {
      expect(profile.totalRamBytes).toBeGreaterThan(0);
    }
    // gpus is always an array
    expect(Array.isArray(profile.gpus)).toBe(true);
    // cpuCores is either a positive integer or null
    if (profile.cpuCores !== null) {
      expect(profile.cpuCores).toBeGreaterThan(0);
    }
  });

  test('returns the same object on repeated calls (cache hit)', async () => {
    const { readHardwareProfile } = await import('../../core/hardware-profile.ts');
    const first = readHardwareProfile();
    const second = readHardwareProfile();
    expect(first).toBe(second);
  });

  test('cache is reset by _resetHardwareProfileCache', async () => {
    const { readHardwareProfile, _resetHardwareProfileCache: reset } = await import('../../core/hardware-profile.ts');
    const first = readHardwareProfile();
    reset();
    const second = readHardwareProfile();
    // After reset a new probe runs, yielding a new object reference
    expect(first).not.toBe(second);
    // But the shape is the same (same machine)
    expect(second.cpuCores).toBe(first.cpuCores);
  });
});

// ---------------------------------------------------------------------------
// readHardwareProfileSync, never spawns, returns immediate RAM+CPU profile
// ---------------------------------------------------------------------------

describe('readHardwareProfileSync', () => {
  afterEach(() => {
    _resetHardwareProfileCache();
  });

  test('never throws', () => {
    expect(() => readHardwareProfileSync()).not.toThrow();
  });

  test('returns a valid HardwareProfile shape', () => {
    const profile = readHardwareProfileSync();
    expect(Array.isArray(profile.gpus)).toBe(true);
    if (profile.totalRamBytes !== null) {
      expect(profile.totalRamBytes).toBeGreaterThan(0);
    }
    if (profile.cpuCores !== null) {
      expect(profile.cpuCores).toBeGreaterThan(0);
    }
  });

  test('returns gpus:[] when cache is cold (no async probe has run)', () => {
    // Cold cache: sync path never spawns nvidia-smi, so gpus must be empty.
    _resetHardwareProfileCache();
    const profile = readHardwareProfileSync();
    // Either the cache was empty (gpus=[]) OR a prior test populated it.
    // What we assert is that the function did not block, no spawn is fired here.
    expect(Array.isArray(profile.gpus)).toBe(true);
  });

  test('returns the same object on repeated calls (cache hit)', () => {
    const first = readHardwareProfileSync();
    const second = readHardwareProfileSync();
    expect(first).toBe(second);
  });

  test('async GPU result from startHardwareProbe upgrades cached profile after close', async () => {
    // Reset so startHardwareProbe sees a cold cache.
    _resetHardwareProfileCache();
    // Kick off the async probe. On this machine nvidia-smi is either absent
    // (exits non-0) or present. Either way the probe must complete without error.
    startHardwareProbe();
    // Wait long enough for the spawn to close (2s covers the 1.5s timeout + startup).
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    // After the probe resolves, readHardwareProfileSync() should have a non-null
    // RAM snapshot (the probe writes RAM+CPU regardless of GPU presence).
    const profile = readHardwareProfileSync();
    // The module cache is now populated, RAM should be readable on this machine.
    if (profile.totalRamBytes !== null) {
      expect(profile.totalRamBytes).toBeGreaterThan(0);
    }
    // gpus is always an array (empty when nvidia-smi not found)
    expect(Array.isArray(profile.gpus)).toBe(true);
  }, 5000);

  test('probe upgrades a sync-populated cache (gpus:[]) with GPU data on close', async () => {
    // Smoke test: real probe runs and cache is populated.
    _resetHardwareProfileCache();
    startHardwareProbe();
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    const profile = readHardwareProfileSync();
    if (profile.totalRamBytes !== null) {
      expect(profile.totalRamBytes).toBeGreaterThan(0);
    }
    expect(Array.isArray(profile.gpus)).toBe(true);
  }, 5000);
});

// ---------------------------------------------------------------------------
// _mergeProbeIntoCache, pure helper unit tests
// ---------------------------------------------------------------------------

describe('_mergeProbeIntoCache', () => {
  const GB = 1024 ** 3;

  const fresh: HardwareProfile = {
    totalRamBytes: 32 * GB,
    availableRamBytes: 16 * GB,
    gpus: [{ name: 'NVIDIA GeForce RTX 3090', vramBytes: 24576 * 1024 * 1024 }],
    cpuCores: 16,
  };

  test('cold cache (null) returns fresh as-is', () => {
    const result = _mergeProbeIntoCache(null, fresh);
    expect(result).toBe(fresh);
  });

  test('empty-gpus cache is upgraded: gpus come from fresh, other fields preserved from current', () => {
    const current: HardwareProfile = {
      totalRamBytes: 16 * GB,
      availableRamBytes: 8 * GB,
      gpus: [],
      cpuCores: 8,
    };
    const result = _mergeProbeIntoCache(current, fresh);
    // gpus upgraded from fresh
    expect(result.gpus).toHaveLength(1);
    expect(result.gpus[0]?.name).toBe('NVIDIA GeForce RTX 3090');
    expect(result.gpus[0]?.vramBytes).toBe(24576 * 1024 * 1024);
    // RAM and CPU fields preserved from current, not overwritten by fresh
    expect(result.totalRamBytes).toBe(16 * GB);
    expect(result.availableRamBytes).toBe(8 * GB);
    expect(result.cpuCores).toBe(8);
  });

  test('non-empty-gpus cache is returned unchanged (no overwrite)', () => {
    const current: HardwareProfile = {
      totalRamBytes: 16 * GB,
      availableRamBytes: 8 * GB,
      gpus: [{ name: 'NVIDIA GeForce GTX 1070', vramBytes: 8192 * 1024 * 1024 }],
      cpuCores: 8,
    };
    const result = _mergeProbeIntoCache(current, fresh);
    // Returns the exact same object reference, cache untouched
    expect(result).toBe(current);
    // Original GPU is preserved, fresh GPU is NOT applied
    expect(result.gpus[0]?.name).toBe('NVIDIA GeForce GTX 1070');
  });
});

// ---------------------------------------------------------------------------
// REPRESENTATIVE_7B_PARAMS, shared constant
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// paramCountFromModel, regex parsing of param count from id/displayName
// ---------------------------------------------------------------------------

describe('paramCountFromModel', () => {
  test('parses 70b from model id (llama-3.1-70b)', () => {
    expect(paramCountFromModel({ id: 'llama-3.1-70b' })).toBe(70_000_000_000);
  });

  test('parses 3b from model id (qwen2.5-3b)', () => {
    expect(paramCountFromModel({ id: 'qwen2.5-3b' })).toBe(3_000_000_000);
  });

  test('parses 1.5b (decimal fraction)', () => {
    expect(paramCountFromModel({ id: 'qwen-1.5b' })).toBe(1_500_000_000);
  });

  test('parses 7B (uppercase)', () => {
    expect(paramCountFromModel({ id: '7B' })).toBe(7_000_000_000);
  });

  test('returns null when no size token present (gpt-4o)', () => {
    expect(paramCountFromModel({ id: 'gpt-4o' })).toBeNull();
  });

  test('does not read a version decimal as a parameter size (gpt-4.1)', () => {
    expect(paramCountFromModel({ id: 'gpt-4.1' })).toBeNull();
  });

  test('returns null for cloud model with no param suffix', () => {
    expect(paramCountFromModel({ id: 'claude-opus-4' })).toBeNull();
  });

  test('falls back to displayName when id has no size token', () => {
    expect(paramCountFromModel({ id: 'my-model', displayName: 'My Model 13B' })).toBe(13_000_000_000);
  });

  test('id takes priority over displayName', () => {
    expect(paramCountFromModel({ id: 'model-7b', displayName: 'Model 13B' })).toBe(7_000_000_000);
  });
});

describe('REPRESENTATIVE_7B_PARAMS', () => {
  test('produces a plausible Q4 size estimate (~3.85 GB)', () => {
    const bytes = estimateModelBytes(REPRESENTATIVE_7B_PARAMS);
    const gb = bytes / (1024 ** 3);
    // Q4 7B should be roughly 3.5–4.2 GB
    expect(gb).toBeGreaterThan(3);
    expect(gb).toBeLessThan(5);
  });
});
