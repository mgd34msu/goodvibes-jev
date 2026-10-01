/**
 * PowerSettings, the admin/ops surface for the host sleep-ownership state
 * (power.status.get / power.keepAwake.set, SDK 1.8.0). Same non-schema-driven
 * pattern as NotificationSettings/PairingTokensSettings: these two verbs carry
 * no CONFIG_SCHEMA entry (they are dedicated wire verbs, not config.set keys),
 * so they get their own panel rather than a schema-driven SettingsModal row.
 *
 * The ruled shape (owner ruling, 2026-07): ONE toggle, no timers, no AC-only
 * sub-options. The always-visible "sleep disabled" chip (StatusStrip/PowerChip)
 * is the safety mechanism that keeps this override from being forgotten, not a
 * countdown.
 *
 * "Held because X": the automatic work inhibitor's live reasons render
 * verbatim whenever it holds, this is the daemon's own honest accounting of
 * why sleep is currently blocked (e.g. an active turn), never a client guess.
 * The keep-awake toggle's own state (granted vs. denied classes, and the
 * honest lid-split `note` when part of the requested coverage was refused)
 * renders alongside it, verbatim, the same as PowerChip's tooltip.
 */
import { usePowerStatus, useSetKeepAwake } from '../../hooks/usePowerStatus';
import { formatError } from '../../lib/errors';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { StatusDot } from '../ui/StatusDot';
import { Toggle } from '../ui/Toggle';
import { SettingRow, SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';
import '../../styles/components/power.css';

function classesLabel(classes: readonly string[]): string {
  return classes.length > 0 ? classes.join(', ') : 'none';
}

export function PowerSettings() {
  const status = usePowerStatus();
  const setKeepAwake = useSetKeepAwake();

  if (status.isPending) {
    return (
      <SettingsBlock className="power-panel" title="Power">
        <div aria-label="Loading power state" aria-busy="true">
          <SkeletonBlock variant="text" lines={3} />
        </div>
      </SettingsBlock>
    );
  }

  if (status.isError) {
    return (
      <SettingsBlock className="power-panel" title="Power">
        <ErrorState error={status.error} title="Power state unavailable" onRetry={() => void status.refetch()} />
      </SettingsBlock>
    );
  }

  // status.isPending/isError are both false here, so react-query's discriminated
  // union guarantees status.data is defined (the 'success' branch), no defensive
  // null check needed (and eslint's no-unnecessary-condition catches one if added).
  const { work, keepAwake } = status.data;
  const pendingEnabled = setKeepAwake.isPending ? setKeepAwake.variables : keepAwake.enabled;
  const heldSince = typeof work.heldSince === 'number' ? whenLabel(work.heldSince) : '';

  return (
    <SettingsBlock
      className="power-panel"
      title="Power"
      description="Keep this machine from sleeping while you want it reachable. One switch, no timers; the status strip shows a chip while it holds."
    >
      <div className="settings-rows">
        <SettingRow
          label="Keep this machine awake"
          control={(
            <Toggle
              checked={pendingEnabled}
              disabled={setKeepAwake.isPending}
              aria-label="Keep this machine awake"
              onChange={(checked) => setKeepAwake.mutate(checked)}
            />
          )}
        />
      </div>

      {setKeepAwake.isError && (
        <div className="banner warning" role="alert">{formatError(setKeepAwake.error)}</div>
      )}

      {keepAwake.held && (
        <div className="power-panel__state power-panel__state--danger" role="status">
          <StatusDot tone="bad" />
          <span>
            Sleep disabled: holding: {classesLabel(keepAwake.grantedClasses)}
            {keepAwake.deniedClasses.length > 0 ? ` (refused: ${classesLabel(keepAwake.deniedClasses)})` : ''}
          </span>
        </div>
      )}

      {/* The honest lid-split line, verbatim, whenever the daemon serves one. Never
          papered over with different wording. */}
      {keepAwake.note && (
        <p className="power-panel__note" role="note">{keepAwake.note}</p>
      )}

      <div className="settings-rows">
        <SettingRow
          label="Automatic work inhibitor"
          description={work.held ? (
            <span className="power-panel__held-because">
              Held because: {work.reasons.length > 0 ? work.reasons.join('; ') : 'active work'}
              {heldSince ? ` (since ${heldSince})` : ''}
            </span>
          ) : 'Not currently held, no active work requires it.'}
          control={<span className="power-panel__work-state">{work.held ? 'Held' : 'Idle'}</span>}
        />
      </div>
      {work.capExpired && (
        <div className="banner warning" role="alert">
          The work inhibitor's cap ({work.capMinutes}m) has expired, the host may sleep during
          active work.
        </div>
      )}
    </SettingsBlock>
  );
}
