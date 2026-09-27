// Ported from goodvibes-tui src/test/core/permission-mode.test.ts. The mode
// vocabulary and Shift+Tab cycle now live in gate/presets.ts, where each
// `permissions.mode` value names a preset; the preset rows are pinned here in
// full, alongside the spot checks in gate.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  decideByPreset,
  GATE_PRESETS,
  GATE_STAKES,
  isPlanMode,
  nextPermissionMode,
  PERMISSION_MODE_CYCLE,
  permissionModeLabel,
  permissionModeTone,
  presetForMode,
  togglePlanMode,
  type GateAction,
  type GatePresetName,
} from '../sdk/src/platform/gate/presets.ts';

describe('permission-mode', () => {
  test('cycle order is normal → accept-edits → plan → auto → normal', () => {
    expect([...PERMISSION_MODE_CYCLE]).toEqual(['prompt', 'accept-edits', 'plan', 'allow-all']);
    expect(nextPermissionMode('prompt')).toBe('accept-edits');
    expect(nextPermissionMode('accept-edits')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('allow-all');
    expect(nextPermissionMode('allow-all')).toBe('prompt');
  });

  test('cycling from custom or unknown starts at normal', () => {
    expect(nextPermissionMode('custom')).toBe('prompt');
    expect(nextPermissionMode(undefined)).toBe('prompt');
    expect(nextPermissionMode('nonsense')).toBe('prompt');
  });

  test('labels map config values to user-facing names', () => {
    expect(permissionModeLabel('prompt')).toBe('normal');
    expect(permissionModeLabel('allow-all')).toBe('auto');
    expect(permissionModeLabel('plan')).toBe('plan');
    expect(permissionModeLabel('accept-edits')).toBe('accept-edits');
    expect(permissionModeLabel('custom')).toBe('custom');
    expect(permissionModeLabel(undefined)).toBe('normal');
  });

  test('tones: normal neutral, plan info, autonomy modes caution', () => {
    expect(permissionModeTone('prompt')).toBe('neutral');
    expect(permissionModeTone('plan')).toBe('info');
    expect(permissionModeTone('accept-edits')).toBe('caution');
    expect(permissionModeTone('allow-all')).toBe('caution');
    expect(permissionModeTone('custom')).toBe('caution');
  });

  test('plan-mode toggle enters plan from any non-plan and leaves to normal', () => {
    expect(isPlanMode('plan')).toBe(true);
    expect(isPlanMode('prompt')).toBe(false);
    expect(togglePlanMode('prompt')).toBe('plan');
    expect(togglePlanMode('accept-edits')).toBe('plan');
    expect(togglePlanMode('allow-all')).toBe('plan');
    expect(togglePlanMode('plan')).toBe('prompt');
  });
});

describe('modes select presets', () => {
  test('each preset names the mode that selects it, and that mode selects it back', () => {
    for (const preset of Object.values(GATE_PRESETS)) {
      expect(presetForMode(preset.mode)).toBe(preset);
      expect(permissionModeLabel(preset.mode)).toBe(preset.name);
    }
  });

  test('every mode in the Shift+Tab cycle selects a distinct preset, custom excluded', () => {
    const names = PERMISSION_MODE_CYCLE.map((mode) => presetForMode(mode).name);
    expect(names).toEqual(['normal', 'accept-edits', 'plan', 'auto']);
    expect(new Set(names).size).toBe(PERMISSION_MODE_CYCLE.length);
  });

  test('an unset or unknown mode selects normal, the conservative preset', () => {
    expect(presetForMode(undefined).name).toBe('normal');
    expect(presetForMode('ALLOW-ALL').name).toBe('normal');
  });
});

describe('decideByPreset: every row', () => {
  const EXPECTED: Readonly<Record<GatePresetName, readonly GateAction[]>> = {
    normal: ['allow', 'ask', 'ask', 'ask'],
    'accept-edits': ['allow', 'ask', 'ask', 'ask'],
    plan: ['allow', 'ask', 'ask', 'ask'],
    auto: ['allow', 'allow', 'allow', 'ask'],
    custom: ['allow', 'ask', 'ask', 'ask'],
  };

  test('a read-only generic call follows each preset\'s stakes row, for the stakes reason', () => {
    for (const name of Object.keys(EXPECTED) as GatePresetName[]) {
      const row = GATE_STAKES.map((stakes) => decideByPreset(GATE_PRESETS[name], { stakes, family: 'generic', changesState: false }));
      expect(row.map((decision) => decision.action)).toEqual([...EXPECTED[name]]);
      expect(row.every((decision) => decision.reason === 'stakes')).toBe(true);
    }
  });

  test('plan refuses any change at every stakes level, naming the plan reason', () => {
    for (const stakes of GATE_STAKES) {
      expect(decideByPreset(GATE_PRESETS.plan, { stakes, family: 'generic', changesState: true }))
        .toEqual({ action: 'deny', reason: 'plan-read-only' });
    }
  });

  test('accept-edits allows each edit family through high, and only those families', () => {
    for (const family of ['file-mutation', 'notebook-edit', 'config-mutation'] as const) {
      for (const stakes of ['low', 'medium', 'high'] as const) {
        expect(decideByPreset(GATE_PRESETS['accept-edits'], { stakes, family, changesState: true }))
          .toEqual({ action: 'allow', reason: 'accepted-edit' });
      }
      expect(decideByPreset(GATE_PRESETS['accept-edits'], { stakes: 'critical', family, changesState: true }))
        .toEqual({ action: 'ask', reason: 'stakes' });
    }
    expect(decideByPreset(GATE_PRESETS['accept-edits'], { stakes: 'medium', family: 'generic', changesState: true }))
      .toEqual({ action: 'ask', reason: 'stakes' });
  });

  test('no preset allows a critical call without asking', () => {
    for (const preset of Object.values(GATE_PRESETS)) {
      expect(decideByPreset(preset, { stakes: 'critical', family: 'file-mutation', changesState: true }).action).not.toBe('allow');
    }
  });
});
