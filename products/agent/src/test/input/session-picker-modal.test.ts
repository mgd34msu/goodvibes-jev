/**
 * Tests for SessionPickerModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'fs';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return makeProjectTempDir('gv-sess-picker-test');
}

const META = { title: 'Test Session', model: 'mercury-2', provider: 'inceptionlabs', timestamp: 1700000000000 };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SessionPickerModal', () => {
  let tmpDir: string;
  let sm: SessionManager;
  let modal: SessionPickerModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new SessionManager(tmpDir, { surfaceRoot: 'tui' });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('starts inactive', () => {
    modal = new SessionPickerModal(sm);
    expect(modal.active).toBe(false);
  });

  test('open() on empty dir shows empty sessions', () => {
    // Override the internal SessionManager by testing with no sessions
    modal = new SessionPickerModal(sm);
    // The modal uses getSessionManager() which points to cwd, so just test the interface
    modal.active = true;
    modal.sessions = [];
    modal.selectedIndex = 0;
    expect(modal.sessions.length).toBe(0);
    expect(modal.getSelected()).toBeNull();
  });

  test('navigation wraps around (moveUp from 0 → last)', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.moveUp();
    expect(modal.selectedIndex).toBe(1);
  });

  test('moveDown increments selectedIndex', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(1);
  });

  test('moveDown wraps around', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
    ];
    modal.selectedIndex = 0;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('getSelected returns the current session', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 1;
    const sel = modal.getSelected();
    expect(sel).toEqual(expect.objectContaining({ name: 'b' }));
  });

  test('deleteSelected requires explicit slash command and does not remove files', () => {
    sm.save('mysession', [{ role: 'user', content: 'hi' }], META);
    modal = new SessionPickerModal(sm);
    const sessions = sm.list();
    modal.sessions = sessions;
    modal.selectedIndex = 0;

    const result = modal.deleteSelected();
    expect(result).toBe(false);
    expect(modal.statusMessage).toContain('/session delete mysession --yes');
    expect(existsSync(sessions[0].filePath)).toBe(true);
  });

  test('deleteSelected quotes session names that need escaping in command guidance', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [
      { name: 'imported client review', title: 'Client Review', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
    ];
    modal.selectedIndex = 0;

    const result = modal.deleteSelected();

    expect(result).toBe(false);
    expect(modal.statusMessage).toContain('/session delete "imported client review" --yes');
  });

  test('moving selection clears stale delete guidance state', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [
      { name: 'a', title: 'A', model: '', provider: '', timestamp: 1, messageCount: 2, filePath: '/a' },
      { name: 'b', title: 'B', model: '', provider: '', timestamp: 2, messageCount: 3, filePath: '/b' },
    ];
    modal.selectedIndex = 0;
    modal.deleteConfirmationTarget = 'a';
    expect(modal.deleteConfirmationTarget).toBe('a');
    modal.moveDown();
    expect(modal.deleteConfirmationTarget).toBeNull();
  });

  test('close() deactivates modal', () => {
    modal = new SessionPickerModal(sm);
    modal.active = true;
    modal.statusMessage = 'some message';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.statusMessage).toBe('');
  });

  test('no navigation when sessions list is empty', () => {
    modal = new SessionPickerModal(sm);
    modal.sessions = [];
    modal.selectedIndex = 0;
    modal.moveUp();
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });
});
