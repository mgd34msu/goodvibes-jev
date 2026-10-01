/**
 * memory-governance.ts, the MemoryGovernor observability shape and pure helper
 * functions (ops.memory.get, SDK 1.9.0-dev's memory-relay-voice-hardening work).
 * Derives labels/tones from data the daemon already serves. No `any`. No side effects.
 *
 * ops.memory.get carries a real generated OperatorMethodInputMap/OutputMap entry
 * (foundation-client-types.ts), MemoryGovernanceSnapshot below is a plain re-statement
 * of that generated shape (not a divergent hand-authored type), kept local so the
 * component/hook/test files have a named type to import without reaching into the
 * generated module directly, matching daemon-health.ts's own DaemonHealth pattern.
 */

export type MemoryTier = 'normal' | 'elevated' | 'high' | 'critical';

export interface MemoryCacheFootprint {
  readonly id: string;
  readonly name: string;
  readonly entries: number;
  /** Absent when the cache cannot estimate its own byte footprint, render as
   * "—", never a fabricated 0. */
  readonly estimatedBytes?: number;
}

export interface MemoryTripwireState {
  readonly armed: boolean;
  readonly sustainedSec: number;
  readonly rateMbPerSec: number;
}

export interface MemoryThresholds {
  readonly elevatedPct: number;
  readonly highPct: number;
  readonly criticalPct: number;
}

export interface MemoryGovernanceSnapshot {
  readonly tier: MemoryTier;
  readonly budgetMb: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb?: number;
  readonly usedPct: number;
  readonly refusingExpensiveWork: boolean;
  readonly caches: readonly MemoryCacheFootprint[];
  readonly pausedJobs: readonly string[];
  readonly tripwire: MemoryTripwireState;
  readonly thresholds: MemoryThresholds;
}

const MEMORY_TIERS: readonly MemoryTier[] = ['normal', 'elevated', 'high', 'critical'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Defensive wire parse: the REAL ops.memory.get snapshot, or null when the answer does
 * not actually carry one (a daemon or intermediary answering 200 with an empty/foreign
 * body). Null means "render the honest cannot-read state", never crash the panel's
 * whole view tree on `undefined.length`, and never paint placeholder numbers. Same
 * lenient-read stance voice-config.ts documents ("parse leniently, never assume a
 * shape"): optional/decorative fields degrade individually; only the load-bearing core
 * (tier + the budget/rss/usage numbers) is required for the snapshot to count as real.
 */
export function readMemoryGovernanceSnapshot(value: unknown): MemoryGovernanceSnapshot | null {
  if (!isRecord(value)) return null;
  const tier = MEMORY_TIERS.find((t) => t === value.tier);
  const budgetMb = readNumber(value.budgetMb);
  const rssMb = readNumber(value.rssMb);
  const heapUsedMb = readNumber(value.heapUsedMb);
  const usedPct = readNumber(value.usedPct);
  if (!tier || budgetMb === undefined || rssMb === undefined || heapUsedMb === undefined || usedPct === undefined) {
    return null;
  }
  const caches: MemoryCacheFootprint[] = (Array.isArray(value.caches) ? value.caches : [])
    .filter(isRecord)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : (typeof entry.id === 'string' ? entry.id : ''),
      entries: readNumber(entry.entries) ?? 0,
      ...(readNumber(entry.estimatedBytes) !== undefined ? { estimatedBytes: readNumber(entry.estimatedBytes) } : {}),
    }))
    .filter((entry) => entry.id !== '');
  const tripwire = isRecord(value.tripwire) ? value.tripwire : {};
  const thresholds = isRecord(value.thresholds) ? value.thresholds : {};
  return {
    tier,
    budgetMb,
    rssMb,
    heapUsedMb,
    ...(readNumber(value.heapTotalMb) !== undefined ? { heapTotalMb: readNumber(value.heapTotalMb) } : {}),
    usedPct,
    refusingExpensiveWork: value.refusingExpensiveWork === true,
    caches,
    pausedJobs: (Array.isArray(value.pausedJobs) ? value.pausedJobs : []).filter(
      (job): job is string => typeof job === 'string',
    ),
    tripwire: {
      armed: tripwire.armed === true,
      sustainedSec: readNumber(tripwire.sustainedSec) ?? 0,
      rateMbPerSec: readNumber(tripwire.rateMbPerSec) ?? 0,
    },
    thresholds: {
      elevatedPct: readNumber(thresholds.elevatedPct) ?? 0,
      highPct: readNumber(thresholds.highPct) ?? 0,
      criticalPct: readNumber(thresholds.criticalPct) ?? 0,
    },
  };
}

/** Human-facing label for the pressure tier, the chip's own text, never just the
 * raw enum value. */
export function memoryTierLabel(tier: MemoryTier): string {
  switch (tier) {
    case 'normal': return 'Normal';
    case 'elevated': return 'Elevated';
    case 'high': return 'High';
    case 'critical': return 'Critical';
  }
}

/**
 * The webui's own `.badge` tone class (src/styles.css: .badge.ok/.warning/.bad/.neutral/
 * .info) for a pressure tier, reusing the SAME chip idiom every other status surface
 * uses (StatusBadge, PowerChip's danger idiom), not inventing new chip CSS. 'elevated'
 * maps to 'info', the app's one tone between neutral and warning ("notice": still
 * working, worth a glance, not yet a problem), 'high'/'critical' get the two genuine
 * severities (warning/bad).
 */
export function memoryTierBadgeClass(tier: MemoryTier): 'neutral' | 'info' | 'warning' | 'bad' {
  switch (tier) {
    case 'normal': return 'neutral';
    case 'elevated': return 'info';
    case 'high': return 'warning';
    case 'critical': return 'bad';
  }
}

/** Format a megabyte value for display ("512 MB"). Values are already in MB on the
 * wire (budgetMb/rssMb/heapUsedMb/heapTotalMb), this only rounds and labels them. */
export function formatMb(mb: number | undefined): string {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) return '—';
  return `${Math.round(mb)} MB`;
}

/** Clamp a used-percentage to a sane display range for the bar's width (0–100), never
 * letting a transient over-budget sample push the fill past the bar's own edge. */
export function clampUsedPct(pct: number): number {
  if (!Number.isFinite(pct) || pct < 0) return 0;
  return Math.min(pct, 100);
}

/** One human line for the tripwire state, armed (with its live rate/duration) or not. */
export function tripwireLine(tripwire: MemoryTripwireState): string {
  if (!tripwire.armed) return 'Leak tripwire: not armed.';
  return `Leak tripwire: armed: sustained growth of ${tripwire.rateMbPerSec.toFixed(1)} MB/s for ${tripwire.sustainedSec}s.`;
}
