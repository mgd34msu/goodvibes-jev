/**
 * DeviceGrants, the grants surface for paired-phone capabilities.
 *
 * The owner's ruling of 2026-07-25 requires that "always allow" be "a durable
 * per-capability, per-node grant, visible and revocable in the grants surface".
 * This panel is that surface: every durable grant with the device it belongs
 * to, the capability it covers, when it was given, when it expires, and how
 * often it has been used, each with a revoke control, plus the recent ledger
 * of grants given, used, revoked, and expired, and a control to run the
 * housekeeping sweep and read back exactly what it removed.
 *
 * It renders from devices.grants.list / devices.grants.revoke /
 * devices.housekeeping.run, so it shows the daemon's own record rather than a
 * client-side mirror that could disagree with what is actually honoured.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { invokeMethod } from '../../lib/goodvibes';
import type { OperatorMethodOutput } from '../../lib/goodvibes';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Disclosure } from '../data-view/DataView';
import { Row, RowList } from '../ui/Row';
import { SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';
import '../../styles/components/device.css';

type GrantsResult = OperatorMethodOutput<'devices.grants.list'>;
type NodesResult = OperatorMethodOutput<'devices.nodes.list'>;
type HousekeepingResult = OperatorMethodOutput<'devices.housekeeping.run'>;

export const deviceGrantsQueryKey = ['devices', 'grants'] as const;
export const deviceNodesQueryKey = ['devices', 'nodes'] as const;

/** A time for a grant line; a missing time reads "never". */
function formatWhen(value: number | null | undefined): string {
  return whenLabel(value) || 'never';
}

const TITLE = 'Phone capability grants';

export function DeviceGrants() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [sweep, setSweep] = useState<HousekeepingResult | null>(null);

  const grants = useQuery<GrantsResult>({
    queryKey: deviceGrantsQueryKey,
    queryFn: () => invokeMethod('devices.grants.list', {}),
  });
  const nodes = useQuery<NodesResult>({
    queryKey: deviceNodesQueryKey,
    queryFn: () => invokeMethod('devices.nodes.list', {}),
  });

  const revoke = useMutation({
    mutationFn: (grantId: string) => invokeMethod('devices.grants.revoke', { grantId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceGrantsQueryKey });
    },
  });

  /** Revoking is one-way: the confirm carries the warning, the row button stays quiet. */
  async function handleRevoke(grant: { grantId: string; capabilityTitle: string }): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke this grant?',
      target: grant.capabilityTitle,
      description: 'The phone asks again the next time it needs this.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    revoke.mutate(grant.grantId);
  }

  const housekeeping = useMutation({
    mutationFn: () => invokeMethod('devices.housekeeping.run', {}),
    onSuccess: (result) => {
      setSweep(result);
      void queryClient.invalidateQueries({ queryKey: deviceGrantsQueryKey });
    },
  });

  if (grants.isPending) {
    return (
      <SettingsBlock title={TITLE}>
        <div aria-label="Loading device grants" aria-busy="true">
          <SkeletonBlock variant="text" lines={3} />
        </div>
      </SettingsBlock>
    );
  }

  if (grants.isError) {
    // A daemon that predates this feature answers "method unavailable"; that is
    // an honest "not on this daemon yet", not an error state to alarm anyone.
    if (isMethodUnavailableError(grants.error)) {
      return (
        <SettingsBlock title={TITLE}>
          <EmptyState
            title="Not available on this daemon"
            description="This daemon does not serve the paired-phone capability verbs yet. Update it to manage phone grants here."
          />
        </SettingsBlock>
      );
    }
    return (
      <SettingsBlock title={TITLE}>
        <ErrorState error={grants.error} title="Device grants unavailable" onRetry={() => void grants.refetch()} />
      </SettingsBlock>
    );
  }

  // A daemon that answers without these lists reads as "none yet", never a crash.
  const rows = Array.isArray(grants.data.grants) ? grants.data.grants : [];
  const audit = Array.isArray(grants.data.audit) ? grants.data.audit : [];
  const nodeLabels = new Map((nodes.data?.nodes ?? []).map((node) => [node.nodeId, node.label]));

  return (
    <SettingsBlock
      className="device-grants"
      title={TITLE}
      description={(
        <>
          Every capability asks before it runs. Choosing &quot;always allow&quot; on that prompt
          writes one durable grant for that one capability on that one phone, listed here, and
          revocable here. Revoking deletes the grant, so the next request asks again.
          {nodes.data ? ` Captures are kept for ${String(nodes.data.captureRetentionHours)} hours.` : ''}
        </>
      )}
      actions={(
        <div className="device-panel__actions">
          <Button size="sm" icon={<RefreshCw aria-hidden="true" />} onClick={() => void grants.refetch()} disabled={grants.isFetching}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => housekeeping.mutate()} disabled={housekeeping.isPending}>
            Run housekeeping now
          </Button>
        </div>
      )}
    >
      {confirm.element}
      {housekeeping.isError ? (
        <div className="banner warning" role="alert">{formatError(housekeeping.error)}</div>
      ) : null}
      {sweep ? (
        <p className="device-panel__result" aria-live="polite">{sweep.summary}</p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={28} />}
          title="No durable grants"
          description='Nothing has been granted "always allow" yet. Every phone capability is asking each time.'
        />
      ) : (
        <RowList aria-label="Durable grants">
          {rows.map((grant) => (
            <Row
              key={grant.grantId}
              title={grant.capabilityTitle}
              meta={[
                `${nodeLabels.get(grant.nodeId) ?? grant.nodeId} · ${grant.nodeKind}`,
                `Granted ${formatWhen(grant.grantedAt)}`,
                `expires ${formatWhen(grant.expiresAt)}`,
                `used ${String(grant.useCount)} time${grant.useCount === 1 ? '' : 's'}`,
                `last used ${formatWhen(grant.lastUsedAt)}`,
              ].join(' · ')}
              trailing={(
                <Button
                  variant="quiet-danger"
                  size="sm"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => void handleRevoke(grant)}
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${grant.capabilityTitle}`}
                >
                  Revoke
                </Button>
              )}
            />
          ))}
        </RowList>
      )}

      {audit.length > 0 ? (
        <Disclosure summary={`Recent grant activity (${audit.length})`}>
          <RowList aria-label="Recent grant activity">
            {audit.slice(-25).reverse().map((entry) => (
              <Row
                key={entry.id}
                title={`${entry.action} · ${entry.capabilityId}`}
                meta={`${nodeLabels.get(entry.nodeId) ?? entry.nodeId}${entry.reason ? ` · ${entry.reason}` : ''}`}
                trailing={<span className="device-panel__when">{whenLabel(entry.at)}</span>}
              />
            ))}
          </RowList>
        </Disclosure>
      ) : null}
    </SettingsBlock>
  );
}
