/**
 * CheckInSettings, the proactive check-in configuration, its run receipts, and a
 * manual run-now trigger (checkin.*). It is the Check-ins section of Settings,
 * Notifications (`?settings=checkins`; the old `?view=checkin` page link opens
 * it there).
 *
 * Single-column, phone-first: config display up top with an edit control (gated by a
 * confirm sheet, checkin.config.set can ENABLE proactive contact, so every save
 * confirms, not just the enabling edit), a "run now" action showing the resulting
 * receipt inline, then the receipts list (newest first, from the wire) rendering each
 * outcome plainly, delivered / ran quiet / skipped-and-why / error, never collapsed
 * to a bare status dot.
 *
 * checkin.* emits no wire event yet (a standing gap shared with fleet.*, checkpoints.*,
 * ci.*, see queryKeys.checkinConfig/checkinReceipts), so freshness comes from
 * mutation-driven invalidation and a manual refresh, not realtime invalidation.
 */

import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, RefreshCw } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { OperatorMethodOutput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { DetailSection, EmptyState, Facts, SkeletonRows } from '../../components/data-view/DataView';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Field, Input } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { StatusDot, type StatusTone } from '../../components/ui/StatusDot';
import { Toggle } from '../../components/ui/Toggle';
import { whenLabel } from '../../lib/when-label';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import '../../styles/components/checkin.css';

type CheckinConfig = OperatorMethodOutput<'checkin.config.get'>['config'];
type CheckinReceipt = OperatorMethodOutput<'checkin.receipts.list'>['receipts'][number];
type CheckinRunResult = OperatorMethodOutput<'checkin.run'>;

/** Plain outcome labels, the receipts.list enum (skipped-disabled/skipped-quiet-hours)
 * and the checkin.run enum (a generic 'skipped') are distinct wire shapes; this handles
 * both rather than assuming one covers the other. */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'delivered': return 'Delivered';
    case 'quiet': return 'Ran quiet: nothing worth surfacing';
    case 'skipped-disabled': return 'Skipped: check-in is disabled';
    case 'skipped-quiet-hours': return 'Skipped: within quiet hours';
    case 'skipped': return 'Skipped';
    case 'error': return 'Error';
    default: return outcome;
  }
}

function outcomeTone(outcome: string): StatusTone {
  if (outcome === 'delivered') return 'ok';
  if (outcome === 'error') return 'bad';
  return 'idle';
}

/** "Scheduled" or "Run by you", from the receipt's trigger word. */
function triggerLabel(trigger: string): string {
  if (trigger === 'manual') return 'Run by you';
  if (trigger === 'scheduled') return 'Scheduled';
  return trigger;
}

function ConfigEditForm({
  config,
  onSaved,
  onCancel,
}: {
  config: CheckinConfig;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [enabled, setEnabled] = useState(config.enabled);
  const [cadence, setCadence] = useState(config.cadence);
  const [deliveryChannel, setDeliveryChannel] = useState(config.deliveryChannel);
  const [quietHours, setQuietHours] = useState(config.quietHours);

  const save = useMutation({
    mutationFn: () => sdk.operator.checkin.config.set({ enabled, cadence, deliveryChannel, quietHours }),
    onSuccess: () => {
      onSaved();
      toast({ title: 'Check-in configuration saved', tone: 'success' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Failed to save', description: formatError(error), tone: 'danger' });
    },
  });

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Every save confirms, this can ENABLE proactive contact (the daemon reaching out
    // on its own schedule), not just the specific edit that flips enabled on.
    const ok = await confirm.ask({
      title: enabled ? 'Turn on check-ins?' : 'Save check-in settings?',
      description: enabled
        ? `GoodVibes contacts you through ${deliveryChannel || 'the chosen channel'} on the schedule “${cadence}”, outside quiet hours “${quietHours}”.`
        : 'Check-ins stay off, so GoodVibes never contacts you on its own.',
      confirmLabel: 'Save',
      tone: enabled ? 'danger' : 'default',
    });
    if (!ok) return;
    save.mutate();
  }

  return (
    <form className="checkin-edit-form" onSubmit={(e) => void handleSubmit(e)}>
      {confirm.element}
      <Toggle className="checkin-edit-form__toggle" checked={enabled} onChange={setEnabled} disabled={save.isPending}>
        Enabled
      </Toggle>
      <Field label="Schedule" help="A cron expression, for example 0 9 * * * for every day at 9:00.">
        <Input
          type="text"
          className="checkin-edit-form__code"
          value={cadence}
          onChange={(e) => setCadence(e.target.value)}
          disabled={save.isPending}
        />
      </Field>
      <Field label="Delivery channel" help="Where the check-in is sent, for example slack:#daily.">
        <Input type="text" value={deliveryChannel} onChange={(e) => setDeliveryChannel(e.target.value)} disabled={save.isPending} />
      </Field>
      <Field label="Quiet hours" help="No check-ins in this window, for example 22:00-07:00.">
        <Input type="text" value={quietHours} onChange={(e) => setQuietHours(e.target.value)} disabled={save.isPending} />
      </Field>
      <div className="checkin-edit-form__actions">
        <Button onClick={onCancel} disabled={save.isPending}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

/** One receipt: the summary, one meta line (trigger and when), the outcome right-aligned. */
function ReceiptRow({ receipt }: { receipt: CheckinReceipt }) {
  const when = whenLabel(receipt.ranAt);
  const details = [
    receipt.decisionReason ? `Reason: ${receipt.decisionReason}` : '',
    receipt.deliveredMessage ? `Message: ${receipt.deliveredMessage}` : '',
  ].filter(Boolean);
  return (
    <li className="gv-row checkin-receipt">
      <div className="gv-row__main checkin-receipt__main">
        <span className="gv-row__text">
          <span className="gv-row__title checkin-receipt__summary">{receipt.briefingSummary}</span>
          <span className="gv-row__meta">{[triggerLabel(receipt.trigger), when].filter(Boolean).join(' · ')}</span>
          {details.map((line) => <span key={line} className="checkin-receipt__detail">{line}</span>)}
          {receipt.error && <span className="checkin-receipt__detail checkin-receipt__error">Error: {receipt.error}</span>}
        </span>
      </div>
      <div className="gv-row__trailing checkin-receipt__outcome">
        <StatusDot tone={outcomeTone(receipt.outcome)} />
        {outcomeLabel(receipt.outcome)}
      </div>
    </li>
  );
}

export function CheckInSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [runResult, setRunResult] = useState<CheckinRunResult | null>(null);

  const config = useQuery({
    queryKey: queryKeys.checkinConfig,
    queryFn: () => sdk.operator.checkin.config.get(),
  });
  const receipts = useQuery({
    queryKey: queryKeys.checkinReceipts,
    queryFn: () => sdk.operator.checkin.receipts.list(),
  });

  const run = useMutation({
    mutationFn: () => sdk.operator.checkin.run(),
    onSuccess: async (result) => {
      setRunResult(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.checkinReceipts });
    },
    onError: (error: unknown) => {
      toast({
        title: isMethodUnavailableError(error) ? 'Check-in unavailable on this daemon' : 'Check-in run failed',
        description: isMethodUnavailableError(error) ? undefined : formatError(error),
        tone: 'danger',
      });
    },
  });

  const configUnavailable = config.isError && isMethodUnavailableError(config.error);
  const receiptsUnavailable = receipts.isError && isMethodUnavailableError(receipts.error);
  const list = receipts.data?.receipts ?? [];

  return (
    <div className="checkin-view">
      <div className="checkin-sections">
        <DetailSection
          title="Settings"
          actions={
            <>
              <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
                {run.isPending ? 'Running…' : 'Run check-in now'}
              </Button>
              {config.isSuccess && !editing && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
              )}
              <IconButton
                size="sm"
                label="Refresh settings"
                icon={<RefreshCw size={14} aria-hidden="true" />}
                onClick={() => void config.refetch()}
              />
            </>
          }
        >
          {config.isPending && <SkeletonRows count={3} label="Loading settings" />}
          {configUnavailable && <p className="checkin-empty" role="note">Check-in is unavailable on this daemon.</p>}
          {config.isError && !configUnavailable && (
            <ErrorState error={config.error} onRetry={() => void config.refetch()} title="Failed to load check-in config" />
          )}
          {config.isSuccess && !editing && (
            <Facts
              items={[
                {
                  label: 'Status',
                  value: (
                    <span className="checkin-status">
                      <StatusDot tone={config.data.config.enabled ? 'ok' : 'idle'} />
                      {config.data.config.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  ),
                },
                { label: 'Schedule', value: <code className="checkin-code">{config.data.config.cadence}</code> },
                { label: 'Delivery channel', value: config.data.config.deliveryChannel },
                { label: 'Quiet hours', value: config.data.config.quietHours },
              ]}
            />
          )}
          {config.isSuccess && editing && (
            <ConfigEditForm
              config={config.data.config}
              onSaved={() => { setEditing(false); void config.refetch(); }}
              onCancel={() => setEditing(false)}
            />
          )}
        </DetailSection>

        {runResult && (
          <DetailSection title="Last run">
            <div className="checkin-run-result">
              <span className="checkin-status">
                <StatusDot tone={outcomeTone(runResult.outcome)} />
                {outcomeLabel(runResult.outcome)}
              </span>
              <p className="checkin-run-result__summary">{runResult.summary}</p>
            </div>
          </DetailSection>
        )}

        <DetailSection
          title="Recent receipts"
          actions={
            <IconButton
              size="sm"
              label="Refresh receipts"
              icon={<RefreshCw size={14} aria-hidden="true" />}
              onClick={() => void receipts.refetch()}
            />
          }
        >
          {receipts.isPending && <SkeletonRows count={3} label="Loading receipts" />}
          {receiptsUnavailable && <p className="checkin-empty" role="note">Check-in receipts are unavailable on this daemon.</p>}
          {receipts.isError && !receiptsUnavailable && (
            <ErrorState error={receipts.error} onRetry={() => void receipts.refetch()} title="Failed to load receipts" />
          )}
          {receipts.isSuccess && list.length === 0 && (
            <EmptyState icon={<BellRing size={20} />}>
              No check-ins yet. They show up here after the first scheduled or manual run.
            </EmptyState>
          )}
          {list.length > 0 && (
            <ul className="gv-rows checkin-receipts">
              {list.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} />)}
            </ul>
          )}
        </DetailSection>
      </div>
    </div>
  );
}
