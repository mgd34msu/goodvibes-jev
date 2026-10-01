/**
 * MemoryDiagnostics, the admin/ops surface for the daemon's own memory-pressure
 * governance state (ops.memory.get, SDK 1.9.0-dev's memory-relay-voice-hardening
 * work). Same non-schema-driven pattern as PowerSettings/TailscaleSettings: this verb
 * carries no CONFIG_SCHEMA entry, so it gets its own panel rather than a
 * SettingsModal row.
 *
 * Renders the tier as a kit Chip with a status dot (memory-governance.ts's
 * memoryTierBadgeClass, neutral/info/warning/bad for normal/elevated/high/critical,
 * mapped to idle/info/warn/bad), a labeled budget-vs-RSS bar, a per-cache footprint
 * table, the paused-deferrable-jobs list, and the leak-tripwire line.
 *
 * Honest states: a daemon build with no ops.memory.get id at all (404,
 * isMethodUnavailableError) and a build that has the id registered but no
 * MemoryGovernor wired (501, isMethodNotInvokableError) both render the same honest
 * "this daemon does not serve memory diagnostics" state, never placeholder numbers.
 * Any other fetch failure is a retriable ErrorState.
 *
 * Event surfacing: OPS_MEMORY_PRESSURE rides the 'ops' runtime domain, the SAME domain
 * OPS_POWER_STATE_CHANGED already rides, useRealtimeInvalidation invalidates this
 * panel's query on that domain (see queries.ts's opsMemory key), so it refetches on
 * the real pressure event exactly the way PowerChip/PowerSettings already refetch on
 * power-state changes: invalidate-and-rerender the live status, never a separate
 * attention-item notification feed. This webui has no such feed for arbitrary ops
 * events today (DaemonReceipts is a distinct, server-buffered receipt-consumption
 * mechanism; the Fleet attention badge is derived from node state, not from an event
 * stream), this round did not build one, per its own brief's instruction not to
 * invent new event infrastructure.
 */
import { MemoryStick } from 'lucide-react';
import type { StatusTone } from '../ui/StatusDot';
import { useMemoryDiagnostics } from '../../hooks/useMemoryDiagnostics';
import { isMethodNotInvokableError, isMethodUnavailableError } from '../../lib/errors';
import { formatBytes } from '../../lib/object';
import {
  clampUsedPct,
  formatMb,
  memoryTierBadgeClass,
  memoryTierLabel,
  tripwireLine,
} from '../../lib/memory-governance';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Chip } from '../ui/Chip';
import { SettingsBlock } from './dialog/parts';
import '../../styles/components/memory-diagnostics.css';

const TIER_TONE: Record<ReturnType<typeof memoryTierBadgeClass>, StatusTone> = {
  neutral: 'idle',
  info: 'info',
  warning: 'warn',
  bad: 'bad',
};

export function MemoryDiagnostics() {
  const diagnostics = useMemoryDiagnostics();

  const unavailable = diagnostics.isError
    && (isMethodUnavailableError(diagnostics.error) || isMethodNotInvokableError(diagnostics.error));

  return (
    <SettingsBlock className="memory-diagnostics" title="Memory use" testId="memory-diagnostics">

      {diagnostics.isPending && (
        <div aria-label="Loading memory diagnostics" aria-busy="true">
          <SkeletonBlock variant="text" lines={4} />
        </div>
      )}

      {unavailable && (
        <EmptyState
          icon={<MemoryStick size={24} />}
          title="This daemon does not serve memory diagnostics"
          description="The connected daemon build has no memory-governance observability endpoint. Upgrade it to see the pressure tier, cache footprints, and tripwire state here."
        />
      )}

      {diagnostics.isError && !unavailable && (
        <ErrorState error={diagnostics.error} onRetry={() => void diagnostics.refetch()} title="Memory diagnostics unavailable" />
      )}

      {diagnostics.isSuccess && (() => {
        const snapshot = diagnostics.data;
        const tone = TIER_TONE[memoryTierBadgeClass(snapshot.tier)];
        const usedPct = clampUsedPct(snapshot.usedPct);

        return (
          <>
            <div className="memory-diagnostics__tier-row">
              <Chip tone={tone} className="memory-diagnostics__tier">{memoryTierLabel(snapshot.tier)}</Chip>
              {snapshot.refusingExpensiveWork && (
                <span className="memory-diagnostics__note" role="note">Refusing expensive work while under pressure.</span>
              )}
            </div>

            <div className="memory-diagnostics__bar-row">
              <div className="memory-diagnostics__bar-label">
                <span>{formatMb(snapshot.rssMb)} of {formatMb(snapshot.budgetMb)} budget</span>
                <span>{Math.round(snapshot.usedPct)}%</span>
              </div>
              <div
                className="memory-diagnostics__bar-track"
                role="progressbar"
                aria-label="Memory used vs budget"
                aria-valuenow={Math.round(usedPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`memory-diagnostics__bar-fill memory-diagnostics__bar-fill--${snapshot.tier}`}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              <p className="memory-diagnostics__note">
                Heap {formatMb(snapshot.heapUsedMb)}
                {typeof snapshot.heapTotalMb === 'number' ? ` of ${formatMb(snapshot.heapTotalMb)}` : ''}
              </p>
            </div>

            {snapshot.caches.length > 0 && (
              <table className="memory-diagnostics__caches">
                <caption className="memory-diagnostics__caption">Per-cache footprint</caption>
                <thead>
                  <tr>
                    <th scope="col">Cache</th>
                    <th scope="col">Entries</th>
                    <th scope="col">Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.caches.map((cache) => (
                    <tr key={cache.id}>
                      <td>{cache.name}</td>
                      <td>{cache.entries}</td>
                      <td>{formatBytes(cache.estimatedBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {snapshot.pausedJobs.length > 0 ? (
              <div className="memory-diagnostics__paused">
                <h4 className="memory-diagnostics__subtitle">Paused jobs</h4>
                <ul className="memory-diagnostics__paused-jobs">
                  {snapshot.pausedJobs.map((job) => <li key={job}>{job}</li>)}
                </ul>
              </div>
            ) : (
              <p className="memory-diagnostics__note">No deferrable jobs currently paused.</p>
            )}

            <p className={`memory-diagnostics__tripwire${snapshot.tripwire.armed ? ' memory-diagnostics__tripwire--armed' : ''}`} role="status">
              {tripwireLine(snapshot.tripwire)}
            </p>
          </>
        );
      })()}
    </SettingsBlock>
  );
}
