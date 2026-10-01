/**
 * A standing CI watch (ci.watches.*) in the Work view's detail pane: check it
 * now (ci.watches.run) and read the per-job report, or delete it (confirmed:
 * deleting stops its notifications). The report always lists every job with
 * its own conclusion, never a bare rollup, and the daemon's violations
 * verbatim. A fix session the run started can be opened; a failed start is
 * said plainly, never a dead button.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Play, Trash2 } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { OperatorMethodOutput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { DetailPane, DetailSection, Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Row, RowList } from '../../components/ui/Row';
import { StatusDot, type StatusTone } from '../../components/ui/StatusDot';
import { ciWatchLabel, type CiWatch, whenLabel } from './work-items';

export type CiReport = OperatorMethodOutput<'ci.status'>['report'];
type CiWatchRunResult = OperatorMethodOutput<'ci.watches.run'>;

export function overallTone(overall: string): StatusTone {
  if (overall === 'passed') return 'ok';
  if (overall === 'failed') return 'bad';
  if (overall === 'pending') return 'live';
  return 'idle';
}

/** Every job listed individually, never a rollup alone. */
export function CiReportDetail({ report }: { report: CiReport }) {
  return (
    <div className="work-ci-report" aria-label="CI report">
      <p className="work-status">
        <StatusDot tone={overallTone(report.overall)} />
        {report.overall}
        <span className="work-prose--quiet">
          {' · '}{report.repo}{report.ref ? `@${report.ref}` : ''}{report.prNumber ? ` #${report.prNumber}` : ''}{whenLabel(report.checkedAt) ? ` · checked ${whenLabel(report.checkedAt)}` : ''}
        </span>
      </p>
      {report.violations.length > 0 && (
        <ul className="work-list">
          {report.violations.map((violation, index) => <li key={index}>{violation}</li>)}
        </ul>
      )}
      {report.jobs.length === 0 ? (
        <p className="work-prose" role="note">No jobs reported.</p>
      ) : (
        <RowList aria-label="Jobs">
          {report.jobs.map((job, index) => {
            const word = job.conclusion ?? job.status;
            const tone: StatusTone = job.conclusion === 'success' ? 'ok' : job.conclusion ? 'bad' : 'live';
            return (
              <Row
                key={`${job.name}-${index}`}
                leading={<StatusDot tone={tone} />}
                title={job.name}
                meta={[word, job.continueOnError ? 'continue-on-error' : ''].filter(Boolean).join(' · ')}
                trailing={job.url ? <a href={job.url} target="_blank" rel="noreferrer" className="work-link">Details</a> : undefined}
              />
            );
          })}
        </RowList>
      )}
    </div>
  );
}

export function CiWatchDetail({ watch, onClose, onOpenSession }: {
  watch: CiWatch;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [runResult, setRunResult] = useState<CiWatchRunResult | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.ciWatches });

  const run = useMutation({
    mutationFn: (watchId: string) => sdk.operator.ci.watches.run(watchId),
    onSuccess: async (result) => {
      setRunResult(result);
      await invalidate();
    },
    onError: (error: unknown) => {
      toast({
        title: isMethodUnavailableError(error) ? 'CI watches unavailable on this daemon' : 'Check failed',
        description: isMethodUnavailableError(error) ? undefined : formatError(error),
        tone: 'danger',
      });
    },
  });

  const remove = useMutation({
    mutationFn: (watchId: string) => sdk.operator.ci.watches.delete(watchId),
    onSuccess: async (result) => {
      if (!result.deleted) toast({ title: 'Watch already gone', description: 'No watch with that id existed.', tone: 'info' });
      onClose();
      await invalidate();
    },
    onError: (error: unknown) => toast({ title: 'Failed to delete watch', description: formatError(error), tone: 'danger' }),
  });

  async function handleDelete(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Delete this CI watch?',
      target: ciWatchLabel(watch),
      description: 'Its notifications stop, and the status history it already has stays.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) remove.mutate(watch.id);
  }

  return (
    <DetailPane
      title={ciWatchLabel(watch)}
      status={<span className="work-status"><StatusDot tone={overallTone(watch.lastOverall ?? '')} />{watch.lastOverall ?? 'Not checked yet'}</span>}
      meta={['CI watch', whenLabel(watch.createdAt) ? `created ${whenLabel(watch.createdAt)}` : ''].filter(Boolean).join(' · ')}
      onClose={onClose}
      closeLabel="Close CI watch"
      actions={(
        <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden="true" />} disabled={remove.isPending} onClick={() => void handleDelete()} aria-label="Delete this watch">
          Delete
        </Button>
      )}
      footer={(
        <Button variant="primary" icon={<Play aria-hidden="true" />} onClick={() => run.mutate(watch.id)} disabled={run.isPending}>
          {run.isPending ? 'Checking…' : 'Check now'}
        </Button>
      )}
    >
      {confirm.element}
      <Facts
        items={[
          { label: 'Delivers to', value: watch.deliveryChannel },
          { label: 'On failure', value: watch.triggerFixSession ? 'Starts a fix session' : 'Notifies only' },
        ]}
      />
      {runResult && (
        <DetailSection title="Latest check">
          <CiReportDetail report={runResult.report} />
          <p className="work-prose">
            {runResult.notified ? 'A notification was sent.' : 'No notification was sent (no state change, or quiet).'}
            {runResult.fixSessionTriggered && runResult.fixSessionId && ' A fix session was started.'}
            {runResult.fixSessionTriggered && runResult.fixSessionError && ` The fix session could not start; ${runResult.fixSessionError}`}
          </p>
          {runResult.fixSessionTriggered && runResult.fixSessionId && onOpenSession && (
            <div>
              <Button icon={<ExternalLink aria-hidden="true" />} onClick={() => onOpenSession(runResult.fixSessionId!)}>
                Open fix session
              </Button>
            </div>
          )}
        </DetailSection>
      )}
    </DetailPane>
  );
}
