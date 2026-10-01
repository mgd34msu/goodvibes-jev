/**
 * PowerChip, the always-visible "sleep disabled" chip, rendered in the
 * StatusStrip footer while the owner's keep-awake toggle actually holds a
 * sleep inhibitor (power.status.get's `keepAwake.held`, SDK 1.8.0). Absent
 * while the toggle is off or unheld, there is nothing dangerous to flag,
 * so this never pads the strip with a dead segment.
 *
 * Danger idiom (--status-danger/--status-danger-soft, same tokens
 * checkpoints.css's destructive-restore chip uses): keep-awake is an active
 * override a user should notice, not ambient status.
 *
 * The honest lid-split note, e.g. "idle sleep blocked; lid-close suspend is
 * controlled by your OS here", rides `keepAwake.note` verbatim in the title
 * tooltip when the daemon served one (a class it could not grant is named,
 * never papered over). No fabricated wording fills the gap when `note` is
 * absent; the tooltip just states which classes are held.
 */
import { MoonStar } from 'lucide-react';
import { usePowerStatus } from '../../hooks/usePowerStatus';

function heldClassesLabel(classes: readonly string[]): string {
  return classes.length > 0 ? classes.join(', ') : 'none';
}

export function PowerChip() {
  const status = usePowerStatus();
  const keepAwake = status.data?.keepAwake;

  if (!keepAwake?.held) return null;

  const title = keepAwake.note ?? `Sleep disabled: holding: ${heldClassesLabel(keepAwake.grantedClasses)}`;

  return (
    <div
      className="status-strip__segment status-strip__segment--power"
      aria-label={`Sleep disabled: ${title}`}
      title={title}
    >
      <MoonStar className="status-strip__icon" aria-hidden="true" size={11} />
      <span className="status-strip__label">Sleep disabled</span>
    </div>
  );
}
