/**
 * The Activity section of the Knowledge tab: index status counts, refinement tasks
 * and job runs. These are the honesty surfaces behind the map and node states (a
 * '766 jobs ran / 0 nodes' reading is explained here).
 */
import { useQuery } from '@tanstack/react-query';
import { invokeMethod, sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { asRecord, bestId, bestStatus, bestTitle, compactJson, firstArray } from '../../lib/object';
import { CodeFrame, DetailSection, Disclosure, Facts, SkeletonRows } from '../../components/data-view/DataView';
import { Chip } from '../../components/ui/Chip';
import { Row, RowList } from '../../components/ui/Row';
import { ErrorState } from '../../components/feedback/ErrorState';
import { sentence, statusTone } from '../library/library-data';
import { KnowledgeJobsPeekBody } from './KnowledgeJobsPeek';

/** Scalar fields of a record as label / value facts (nested objects are left to the raw view). */
export function scalarFacts(value: unknown, limit = 12): { label: string; value: string }[] {
  return Object.entries(asRecord(value))
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, limit)
    .map(([key, v]) => ({ label: sentence(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()), value: String(v) }));
}

export function KnowledgeActivity() {
  const status = useQuery({ queryKey: queryKeys.knowledgeStatus, queryFn: () => sdk.knowledge.status() });
  const refinement = useQuery({
    queryKey: queryKeys.knowledgeRefinement,
    queryFn: () => invokeMethod('knowledge.refinement.tasks.list', { limit: 100 }),
  });
  const tasks = firstArray(refinement.data, ['tasks', 'items', 'data']);

  return (
    <div className="lib-stack" aria-label="Knowledge activity">
      <DetailSection title="Index status">
        {status.isPending ? <SkeletonRows count={2} label="Loading status" /> : status.error ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} title="Status unavailable" />
        ) : (
          <>
            <Facts items={scalarFacts(status.data)} />
            <Disclosure summary="Raw status"><CodeFrame>{compactJson(status.data)}</CodeFrame></Disclosure>
          </>
        )}
      </DetailSection>

      <DetailSection title="Refinement tasks">
        {refinement.isPending ? <SkeletonRows count={2} label="Loading refinement tasks" /> : refinement.error ? (
          <ErrorState error={refinement.error} onRetry={() => void refinement.refetch()} title="Refinement tasks unavailable" />
        ) : tasks.length === 0 ? (
          <p className="lib-quiet">No refinement tasks are open.</p>
        ) : (
          <RowList aria-label="Refinement tasks">
            {tasks.map((task, index) => {
              const state = bestStatus(task);
              return (
                <Row
                  key={bestId(task) || index}
                  title={bestTitle(task, `Task ${index + 1}`)}
                  meta={bestId(task)}
                  trailing={<Chip size="sm" tone={statusTone(state)}>{state}</Chip>}
                />
              );
            })}
          </RowList>
        )}
      </DetailSection>

      <DetailSection title="Job runs">
        <KnowledgeJobsPeekBody />
      </DetailSection>
    </div>
  );
}
