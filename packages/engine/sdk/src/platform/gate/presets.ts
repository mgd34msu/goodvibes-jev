/**
 * Gate presets: the stakes table, in one reviewable place.
 *
 * Every side-effecting tool call is read by Jev (gate/reading.ts) and given a
 * stakes level. A preset says, for each stakes level, whether the gate allows
 * the call, asks the owner, or denies it. The presets replace the old
 * permission modes; the `permissions.mode` setting keeps its old values, and
 * each value names a preset, so existing settings files, the Shift+Tab cycle
 * and the mode pill keep working unchanged.
 *
 * The deterministic boundary (gate/boundary.ts) runs before any preset and no
 * preset can relax it. Explicit owner decisions (remembered approvals, user
 * and managed policy rules, and the custom preset's per-tool settings) are
 * applied before the reading and stand as given.
 *
 * The vocabulary and cycle below were hoisted from the TUI's
 * src/core/permission-mode.ts so every surface shares one definition.
 */
import type { PermissionMode } from '../config/schema-types-permissions.js';
import type { Stakes } from '@goodvibes-jev/judgment';
import type { GateRiskFamily } from './batteries/risk-family.js';

/** What the gate does with a call at a given stakes level. */
export type GateAction = 'allow' | 'ask' | 'deny';

/** The preset names, as the mode pill shows them. */
export type GatePresetName = 'normal' | 'accept-edits' | 'plan' | 'auto' | 'custom';

export type { Stakes as GateStakes } from '@goodvibes-jev/judgment';

/** Stakes levels from lowest to highest; the index is the level number. */
export const GATE_STAKES: readonly Stakes[] = ['low', 'medium', 'high', 'critical'];

export interface GatePreset {
  readonly name: GatePresetName;
  /** The `permissions.mode` value that selects this preset. */
  readonly mode: PermissionMode;
  /** One line for the presets sheet and the docs. */
  readonly summary: string;
  /** The action per stakes level. */
  readonly stakes: Readonly<Record<Stakes, GateAction>>;
  /**
   * Plan preset: a call Jev reads as changing anything or reaching outside the
   * machine is denied with the plan-mode denial, whatever its stakes.
   */
  readonly readOnly: boolean;
  /**
   * Accept-edits preset: calls in these risk families are allowed through
   * this stakes level; above it the stakes row applies.
   */
  readonly edits?: { readonly families: readonly GateRiskFamily[]; readonly through: Stakes };
  /** Custom preset: the per-tool settings (`permissions.tools.*`) decide first. */
  readonly perTool: boolean;
}

/** The families accept-edits treats as edits. */
export const EDIT_FAMILIES: readonly GateRiskFamily[] = ['file-mutation', 'notebook-edit', 'config-mutation'];

/**
 * The stakes table. Rows are presets; columns are stakes levels.
 *
 * | preset       | low   | medium | high  | critical | notes                                   |
 * |--------------|-------|--------|-------|----------|-----------------------------------------|
 * | normal       | allow | ask    | ask   | ask      |                                         |
 * | accept-edits | allow | ask    | ask   | ask      | edits allowed through high              |
 * | plan         | allow | ask    | ask   | ask      | any call that changes state is denied   |
 * | auto         | allow | allow  | allow | ask      |                                         |
 * | custom       | allow | ask    | ask   | ask      | per-tool settings decide first          |
 */
export const GATE_PRESETS: Readonly<Record<GatePresetName, GatePreset>> = {
  normal: {
    name: 'normal',
    mode: 'prompt',
    summary: 'Low-stakes calls run; anything that changes state asks first.',
    stakes: { low: 'allow', medium: 'ask', high: 'ask', critical: 'ask' },
    readOnly: false,
    perTool: false,
  },
  'accept-edits': {
    name: 'accept-edits',
    mode: 'accept-edits',
    summary: 'File, notebook and configuration edits run up to high stakes; other changes ask.',
    stakes: { low: 'allow', medium: 'ask', high: 'ask', critical: 'ask' },
    readOnly: false,
    edits: { families: EDIT_FAMILIES, through: 'high' },
    perTool: false,
  },
  plan: {
    name: 'plan',
    mode: 'plan',
    summary: 'Read-only: calls that change anything or reach outside the machine are refused.',
    stakes: { low: 'allow', medium: 'ask', high: 'ask', critical: 'ask' },
    readOnly: true,
    perTool: false,
  },
  auto: {
    name: 'auto',
    mode: 'allow-all',
    summary: 'Everything below critical stakes runs; critical calls still ask.',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: false,
    perTool: false,
  },
  custom: {
    name: 'custom',
    mode: 'custom',
    summary: 'Per-tool settings decide; tools without a setting follow the normal row.',
    stakes: { low: 'allow', medium: 'ask', high: 'ask', critical: 'ask' },
    readOnly: false,
    perTool: true,
  },
};

const PRESET_BY_MODE: Readonly<Record<PermissionMode, GatePresetName>> = {
  prompt: 'normal',
  'accept-edits': 'accept-edits',
  plan: 'plan',
  'allow-all': 'auto',
  custom: 'custom',
};

/** The preset a `permissions.mode` value selects; an unknown value selects normal. */
export function presetForMode(mode: PermissionMode | string | undefined): GatePreset {
  const name = PRESET_BY_MODE[mode as PermissionMode] ?? 'normal';
  return GATE_PRESETS[name];
}

/** The stakes level one higher than `stakes`, or critical. */
export function raiseStakes(stakes: Stakes): Stakes {
  return GATE_STAKES[Math.min(GATE_STAKES.length - 1, GATE_STAKES.indexOf(stakes) + 1)]!;
}

/** The higher of two stakes levels. */
export function maxStakes(a: Stakes, b: Stakes): Stakes {
  return GATE_STAKES.indexOf(a) >= GATE_STAKES.indexOf(b) ? a : b;
}

/** The facts a preset decides on: the call's stakes, its risk family, and whether it changes anything. */
export interface PresetInput {
  readonly stakes: Stakes;
  readonly family: GateRiskFamily;
  /** Jev read the call as changing state or reaching outside the machine (uncertain counts as yes). */
  readonly changesState: boolean;
}

/** What a preset decides for one read call, and why. */
export interface PresetDecision {
  readonly action: GateAction;
  readonly reason: 'stakes' | 'plan-read-only' | 'accepted-edit';
}

/** Applies a preset's row to one read call. */
export function decideByPreset(preset: GatePreset, input: PresetInput): PresetDecision {
  if (preset.readOnly && input.changesState) return { action: 'deny', reason: 'plan-read-only' };
  const edits = preset.edits;
  if (edits && edits.families.includes(input.family) && GATE_STAKES.indexOf(input.stakes) <= GATE_STAKES.indexOf(edits.through)) {
    return { action: 'allow', reason: 'accepted-edit' };
  }
  return { action: preset.stakes[input.stakes], reason: 'stakes' };
}

// ── The mode vocabulary shared by every surface (hoisted from the TUI) ───────

/** The config `permissions.mode` values, exactly as the schema defines them. */
export type PermissionModeValue = PermissionMode;

/**
 * The Shift+Tab cycle order over the four session presets. `custom` is a
 * per-tool policy rather than a session posture, so it is left out; cycling
 * from custom starts at the first entry (normal).
 *
 * Order (escalating autonomy, then wrap): normal, accept-edits, plan, auto.
 */
export const PERMISSION_MODE_CYCLE: readonly PermissionModeValue[] = ['prompt', 'accept-edits', 'plan', 'allow-all'] as const;

/** User-facing label for a mode value: the preset name the pill shows. */
export function permissionModeLabel(mode: PermissionModeValue | string | undefined): GatePresetName {
  return presetForMode(mode).name;
}

/**
 * A coarse tone key for the pill, so the renderer can color presets without
 * importing the value vocabulary: `neutral` for normal, `caution` for the
 * autonomy-raising presets, `info` for plan (read-only).
 */
export type PermissionModeTone = 'neutral' | 'info' | 'caution';

export function permissionModeTone(mode: PermissionModeValue | string | undefined): PermissionModeTone {
  switch (mode) {
    case 'plan': return 'info';
    case 'accept-edits': return 'caution';
    case 'allow-all': return 'caution';
    case 'custom': return 'caution';
    default: return 'neutral';
  }
}

/** Next mode in the Shift+Tab cycle; an unknown or `custom` value maps to the first entry. */
export function nextPermissionMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  const idx = PERMISSION_MODE_CYCLE.indexOf(current as PermissionModeValue);
  if (idx < 0) return PERMISSION_MODE_CYCLE[0]!;
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length]!;
}

/** True when the value selects the plan preset. */
export function isPlanMode(mode: PermissionModeValue | string | undefined): boolean {
  return mode === 'plan';
}

/** The `/plan` toggle target: plan from any other preset, back to normal from plan. */
export function togglePlanMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  return isPlanMode(current) ? 'prompt' : 'plan';
}
