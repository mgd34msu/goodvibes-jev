/**
 * AccountsPanel, structured provider accounts/subscription health, replacing
 * ProvidersView's bare `<DataBlock title="Account Snapshot" .../>` raw JSON
 * dump with the TUI-parity depth the brief calls for (accounts.snapshot's
 * ProviderAccountSnapshot: per-provider active route, auth freshness, usage
 * windows, issues, recommended actions, packages/sdk/src/platform/runtime/
 * provider-accounts/registry.ts, verified against source).
 *
 * Read-only display: the underlying accounts.snapshot() query and its
 * loading/error states are owned by the caller (ProvidersView already fetches
 * it for the boot snapshot), this component only renders whatever result it
 * is handed, honestly.
 */
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './feedback/EmptyState';
import { ErrorState } from './feedback/ErrorState';
import { SkeletonBlock } from './feedback/SkeletonBlock';
import { asRecord, firstArrayAtPath, firstString } from '../lib/object';
import { Landmark } from 'lucide-react';
import { SettingsBlock } from './settings/dialog/parts';
import '../styles/components/providers.css';

export interface AccountsPanelProps {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}

interface AccountRow {
  readonly providerId: string;
  readonly configured: boolean;
  readonly activeRoute: string;
  readonly authFreshness: string;
  readonly modelCount: number;
  readonly usageWindows: readonly { label: string; detail: string }[];
  readonly issues: readonly string[];
  readonly recommendedActions: readonly string[];
}

function toAccountRow(raw: unknown): AccountRow | null {
  const record = asRecord(raw);
  const providerId = firstString(record, ['providerId']);
  if (!providerId) return null;
  return {
    providerId,
    configured: record.configured === true,
    activeRoute: firstString(record, ['activeRoute']) || 'unconfigured',
    authFreshness: firstString(record, ['authFreshness']) || 'status unavailable',
    modelCount: typeof record.modelCount === 'number' ? record.modelCount : 0,
    usageWindows: firstArrayAtPath(record, [['usageWindows']]).map((w) => ({
      label: firstString(w, ['label']) || 'window',
      detail: firstString(w, ['detail']),
    })),
    issues: firstArrayAtPath(record, [['issues']]).filter((i): i is string => typeof i === 'string'),
    recommendedActions: firstArrayAtPath(record, [['recommendedActions']]).filter((i): i is string => typeof i === 'string'),
  };
}

export function AccountsPanel({ data, isLoading, isError, error, onRetry }: AccountsPanelProps) {
  const rows = firstArrayAtPath(data, [['providers']]).map(toAccountRow).filter((row): row is AccountRow => row !== null);
  const configuredCount = typeof asRecord(data).configuredCount === 'number' ? (asRecord(data).configuredCount as number) : rows.filter((r) => r.configured).length;
  const issueCount = typeof asRecord(data).issueCount === 'number' ? (asRecord(data).issueCount as number) : rows.reduce((sum, r) => sum + r.issues.length, 0);

  return (
    <SettingsBlock className="accounts-panel" title="Accounts and subscriptions">
      {isLoading ? (
        <div className="accounts-panel__skeleton" aria-label="Loading accounts" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonBlock key={i} variant="block" height={44} />
          ))}
        </div>
      ) : isError ? (
        <ErrorState error={error} title="Account snapshot unavailable" onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Landmark size={24} aria-hidden="true" />}
          title="No account data"
          description="No provider account snapshot reported by the daemon."
        />
      ) : (
        <>
          <p className="accounts-panel__summary">
            {configuredCount} of {rows.length} providers configured
            {issueCount > 0 ? ` · ${issueCount} issue${issueCount === 1 ? '' : 's'}` : ''}
          </p>
          <ul className="gv-rows" aria-label="Provider accounts">
            {rows.map((row) => (
              <li key={row.providerId} className="gv-row accounts-panel__row">
                <div className="gv-row__main">
                  <span className="gv-row__text">
                    <span className="gv-row__title">{row.providerId}</span>
                    <span className="gv-row__meta accounts-panel__route">
                      {row.activeRoute} · {row.modelCount} model{row.modelCount === 1 ? '' : 's'}
                    </span>
                    {row.usageWindows.length > 0 && (
                      <ul className="accounts-panel__notes accounts-panel__windows">
                        {row.usageWindows.map((w) => (
                          <li key={w.label}>{w.label}: {w.detail}</li>
                        ))}
                      </ul>
                    )}
                    {row.issues.length > 0 && (
                      <ul className="accounts-panel__notes accounts-panel__issues">
                        {row.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    {row.recommendedActions.length > 0 && (
                      <ul className="accounts-panel__notes accounts-panel__actions-list">
                        {row.recommendedActions.map((action) => (
                          <li key={action}>{action}</li>
                        ))}
                      </ul>
                    )}
                  </span>
                </div>
                <div className="gv-row__trailing">
                  <StatusBadge value={row.authFreshness} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsBlock>
  );
}
