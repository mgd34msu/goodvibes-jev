/**
 * Tests for ProfilePickerModal state class.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-prof-picker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ProfilePickerModal', () => {
  let tmpDir: string;
  let pm: ProfileManager;
  let cm: ConfigManager;
  let modal: ProfilePickerModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    pm = new ProfileManager(join(tmpDir, 'profiles'));
    cm = createConfigManager(tmpDir);
    modal = new ProfilePickerModal(pm);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test.each([false, true, null, 'false'])('holds unsupported profile setting (%j) before mutation', (notificationsMetadataOnly) => {
    const path = pm.save('privacy-profile', {
      display: { stream: false },
      provider: { model: 'fixture-profile-model', reasoningEffort: 'low' },
      behavior: { autoApprove: true, ...{ notificationsMetadataOnly } },
    });
    const profileBefore = readFileSync(path, 'utf8');
    const settingsBefore = structuredClone(cm.getRaw());
    const set = spyOn(cm, 'set');
    const dynamic = spyOn(cm, 'setDynamic');
    const save = spyOn(cm, 'save');
    try {
      modal.open();
      expect(modal.loadSelected(cm)).toBe(false);
      expect(modal.statusMessage).toContain('cannot apply');
      expect(modal.statusMessage).toContain('No settings were changed');
      expect(set).not.toHaveBeenCalled();
      expect(dynamic).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(cm.getRaw()).toEqual(settingsBefore);
      expect(readFileSync(path, 'utf8')).toBe(profileBefore);
    } finally { set.mockRestore(); dynamic.mockRestore(); save.mockRestore(); }
  });

  test('loads supported profile settings without an unsupported privacy field', () => {
    pm.save('display-profile', { display: { stream: false }, behavior: { notifyOnComplete: false } });
    modal.open();
    expect(modal.loadSelected(cm)).toBe(true);
    expect(cm.get('display.stream')).toBe(false);
    expect(cm.get('behavior.notifyOnComplete')).toBe(false);
    expect(modal.statusMessage).toBe('Loaded profile display-profile');
  });

  test('starts inactive', () => {
    expect(modal.active).toBe(false);
  });

  test('close() deactivates modal and clears statusMessage', () => {
    modal.active = true;
    modal.statusMessage = 'something';
    modal.deleteConfirmationTarget = 'work-profile';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.statusMessage).toBe('');
    expect(modal.deleteConfirmationTarget).toBeNull();
  });

  test('navigation wraps around (moveUp from 0 → last)', () => {
    modal.profiles = [
      { name: 'a', timestamp: 1, filePath: '/a' },
      { name: 'b', timestamp: 2, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.moveUp();
    expect(modal.selectedIndex).toBe(1);
  });

  test('moveDown increments selectedIndex', () => {
    modal.profiles = [
      { name: 'a', timestamp: 1, filePath: '/a' },
      { name: 'b', timestamp: 2, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.deleteConfirmationTarget = 'a';
    modal.moveDown();
    expect(modal.selectedIndex).toBe(1);
    expect(modal.deleteConfirmationTarget).toBeNull();
  });

  test('moveDown wraps around', () => {
    modal.profiles = [{ name: 'a', timestamp: 1, filePath: '/a' }];
    modal.selectedIndex = 0;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('getSelected returns the current profile', () => {
    modal.profiles = [
      { name: 'a', timestamp: 1, filePath: '/a' },
      { name: 'b', timestamp: 2, filePath: '/b' },
    ];
    modal.selectedIndex = 1;
    expect(modal.getSelected()!.name).toBe('b');
  });

  test('no navigation when profiles list is empty', () => {
    modal.profiles = [];
    modal.moveUp();
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('saveCurrentAs points to Agent profile homes instead of copied config profiles', () => {
    const result = modal.saveCurrentAs('my-profile', cm);
    expect(result).toBe(false);
    expect(modal.statusMessage).toContain('Config-profile saving is disabled');
    expect(modal.statusMessage).toContain('Agent Workspace -> Profiles');
  });

  test('saveCurrentAs with empty name returns false', () => {
    const result = modal.saveCurrentAs('', cm);
    expect(result).toBe(false);
    expect(modal.statusMessage).toEqual(expect.any(String));
    expect(modal.statusMessage.length).toBeGreaterThan(0);
  });

  test('deleteSelected points to Agent profile homes before removal', () => {
    pm.save('test-profile', { display: {}, behavior: {} });
    modal.profiles = pm.list();
    modal.selectedIndex = 0;
    const result = modal.deleteSelected();
    expect(result).toBe(false);
    expect(modal.deleteConfirmationTarget).toBeNull();
    expect(modal.statusMessage).toContain('Config-profile deletion is disabled');
    expect(modal.statusMessage).toContain('Agent Workspace -> Profiles');
    expect(pm.list().map((profile) => profile.name)).toContain('test-profile');
  });

  test('loadSelected on missing profile returns false with status message', () => {
    modal.profiles = [{ name: 'missing', timestamp: 0, filePath: '/nowhere/missing.json' }];
    modal.selectedIndex = 0;
    const result = modal.loadSelected(cm);
    expect(result).toBe(false);
    expect(modal.statusMessage).toContain('Error');
  });
});
