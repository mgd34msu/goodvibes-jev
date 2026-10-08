/**
 * PermissionModeSheet, the picker for a session's permission mode, on the kit
 * Dialog (420 wide glass on desktop, a bottom sheet with a grabber on a phone).
 * Each settable mode is one 44-tall choice; the current one carries a check.
 * Presentational only: the caller runs the sessions.permissionMode.set mutation
 * after onSelect fires and owns pendingMode (the list is disabled while a write
 * is in flight).
 *
 * Only the engine's SESSION_GATE_PRESET_NAMES render as choices: 'custom' is a read-only wire
 * state (a bespoke rule set), never a value `sessions.permissionMode.set`
 * accepts. In custom mode no choice is marked current,
 * which is honest: none of them is.
 */
import { Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { GATE_PRESETS, SESSION_GATE_PRESET_NAMES, type SettableGatePresetName } from '@goodvibes-jev/engine/sdk/platform/gate/presets';

export interface PermissionModeSheetProps {
  open: boolean;
  /** '' when the current mode has not been read from the daemon yet. */
  currentMode: string;
  /** The mode a write is currently in flight for, if any; disables the list. */
  pendingMode?: string;
  onSelect: (mode: SettableGatePresetName) => void;
  onCancel: () => void;
}

export function PermissionModeSheet({ open, currentMode, pendingMode, onSelect, onCancel }: PermissionModeSheetProps) {
  const busy = Boolean(pendingMode);
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title="Set permission mode"
      description="Applies to this session's live runtime, while it is the daemon's own local session."
      size="confirm"
      footer={<Button variant="secondary" onClick={onCancel} disabled={busy}>Close</Button>}
    >
      <div className="gv-choice-list" role="group" aria-label="Permission modes">
        {SESSION_GATE_PRESET_NAMES.map((mode) => {
          const current = mode === currentMode;
          return (
            <button
              key={mode}
              type="button"
              className="gv-choice"
              disabled={busy}
              aria-pressed={current}
              onClick={() => onSelect(mode)}
            >
              <span className="gv-choice__label">
                {GATE_PRESETS[mode].label}
                {mode === pendingMode ? '…' : ''}
              </span>
              {current && <Check className="gv-choice__check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
