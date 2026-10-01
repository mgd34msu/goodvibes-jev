import { describe, expect, test } from 'bun:test';
import {
  PERMISSION_MODES,
  SETTABLE_PERMISSION_MODES,
  isPermissionMode,
  isSettablePermissionMode,
  permissionModeLabel,
} from './permission-mode';

describe('isPermissionMode', () => {
  test('recognizes every value of the operator PermissionMode vocabulary', () => {
    for (const mode of PERMISSION_MODES) expect(isPermissionMode(mode)).toBe(true);
  });

  test('rejects an unknown string', () => {
    expect(isPermissionMode('yolo')).toBe(false);
    expect(isPermissionMode('')).toBe(false);
  });
});

describe('isSettablePermissionMode', () => {
  test('recognizes every settable mode', () => {
    for (const mode of SETTABLE_PERMISSION_MODES) expect(isSettablePermissionMode(mode)).toBe(true);
  });

  test('rejects "custom": read-only, never a settable value on the wire', () => {
    expect(isSettablePermissionMode('custom')).toBe(false);
  });
});

describe('permissionModeLabel', () => {
  test('gives each known mode a distinct label', () => {
    const labels = ['plan', 'normal', 'accept-edits', 'auto', 'custom'].map(permissionModeLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('an unrecognized mode renders verbatim, never dropped', () => {
    expect(permissionModeLabel('future-mode')).toBe('future-mode');
  });

  test('an absent mode gets its own label, never a guessed known mode', () => {
    const absent = permissionModeLabel('');
    expect(absent.length).toBeGreaterThan(0);
    expect(['plan', 'normal', 'accept-edits', 'auto', 'custom'].map(permissionModeLabel)).not.toContain(absent);
  });
});
