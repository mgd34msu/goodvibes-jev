/**
 * PermissionModeSheet, the picker for a session's permission mode, on the kit
 * Dialog (420 wide glass on desktop, a bottom sheet with a grabber on a phone).
 * Each settable mode is one 44-tall choice; the current one carries a check.
 * Presentational only: the caller runs the sessions.permissionMode.set mutation
 * after onSelect fires and owns pendingMode (the list is disabled while a write
 * is in flight).
 *
 * Only SETTABLE_PERMISSION_MODES render as choices: 'custom' is a read-only wire
 * state (a bespoke rule set), never a value `sessions.permissionMode.set`
 * accepts (lib/permission-mode.ts). In custom mode no choice is marked current,
 * which is honest: none of them is.
 */
import { Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { SETTABLE_PERMISSION_MODES, permissionModeLabel, type SettablePermissionMode } from '../../lib/permission-mode';

export interface PermissionModeSheetProps {
  open: boolean;
  /** '' when the current mode has not been read from the daemon yet. */
  currentMode: string;
  /** The mode a write is currently in flight for, if any; disables the list. */
  pendingMode?: string;
  onSelect: (mode: SettablePermissionMode) => void;
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
        {SETTABLE_PERMISSION_MODES.map((mode) => {
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
                {permissionModeLabel(mode)}
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
