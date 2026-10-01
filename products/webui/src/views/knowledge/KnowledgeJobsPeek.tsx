/**
 * The knowledge jobs activity list (W8: the '766 jobs ran / 0 nodes' gap). Reads
 * knowledge.jobs.list + knowledge.job-runs.list so a maintainer can see WHY indexing
 * produced no nodes, instead of a bare zero. Shown in the Activity section of the
 * Knowledge tab, and reached from the "View jobs" action on the map and node states.
 */
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { invokeMethod } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { countFrom, firstArray, firstString, readPath } from '../../lib/object';
import { EmptyState, SkeletonRows } from '../../components/data-view/DataView';
import { Chip } from '../../components/ui/Chip';
import { Row, RowList } from '../../components/ui/Row';
import { ErrorState } from '../../components/feedback/ErrorState';
import { statusTone } from '../library/library-data';
import { whenLabel } from '../../lib/when-label';

function formatRunTimestamp(value: unknown): string {
  return (typeof value === 'number' && whenLabel(value)) || 'unknown time';
}

export function KnowledgeJobsPeekBody() {
  const jobs = useQuery({
    queryKey: queryKeys.knowledgeJobs,
    queryFn: () => invokeMethod('knowledge.jobs.list', {}),
  });
  const runs = useQuery({
    queryKey: [...queryKeys.knowledgeJobs, 'runs'],
    queryFn: () => invokeMethod('knowledge.job-runs.list', { limit: 50 }),
  });

  if (jobs.isPending || runs.isPending) return <SkeletonRows count={3} label="Loading job activity" />;

  const queryError = jobs.error ?? runs.error;
  if (queryError) {
    return (
      <ErrorState
        error={queryError}
        onRetry={() => { void jobs.refetch(); void runs.refetch(); }}
        title="Job activity unavailable"
      />
    );
  }

  const jobItems = firstArray(jobs.data, ['jobs']);
  const runItems = firstArray(runs.data, ['runs']);
  const jobTitleById = new Map(jobItems.map((job) => [firstString(job, ['id']), firstString(job, ['title'])]));

  if (runItems.length === 0) {
    return (
      <EmptyState icon={<Activity />} title="No job runs yet">
        Indexing jobs have not run yet.
      </EmptyState>
    );
  }

  const sortedRuns = [...runItems].sort(
    (a, b) => countFrom(b, ['requestedAt']) - countFrom(a, ['requestedAt']),
  );

  return (
    <div className="knowledge-jobs-peek">
      <p className="lib-quiet knowledge-jobs-peek__summary">
        {jobItems.length} job{jobItems.length === 1 ? '' : 's'} defined · {runItems.length} run{runItems.length === 1 ? '' : 's'} shown
      </p>
      <RowList aria-label="Job runs">
        {sortedRuns.map((run, index) => {
          const id = firstString(run, ['id']) || String(index);
          const jobId = firstString(run, ['jobId']);
          const mappedTitle = jobTitleById.get(jobId);
          // Fall through past a genuinely-empty title (not just a nullish one) to the
          // jobId, and past an empty jobId to a final honest label, a plain `??` would
          // stop at an empty-string title, so this is a truthiness fallback.
          const title = [mappedTitle, jobId].find((value): value is string => Boolean(value?.trim())) ?? 'Unknown job';
          const status = firstString(run, ['status']) || 'unknown';
          const error = firstString(run, ['error']);
          return (
            <Row
              key={id}
              className="knowledge-jobs-peek__row"
              title={title}
              meta={[formatRunTimestamp(readPath(run, ['requestedAt'])), error].filter(Boolean).join(' · ')}
              trailing={<Chip size="sm" tone={statusTone(status)}>{status}</Chip>}
            />
          );
        })}
      </RowList>
    </div>
  );
}
