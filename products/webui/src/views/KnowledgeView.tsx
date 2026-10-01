/**
 * The Knowledge tab of the Library. One section switch keeps every knowledge function
 * reachable without stacked panels:
 *   Browse   sources, nodes, issues and wiki projections as rows (filtered by the
 *            Library's shared search), with Ask and Search for the current query.
 *            A selected row opens in the detail pane (item data, a projection with
 *            Render and Materialize, or the answer to a question).
 *   Map      the knowledge map, with its named honesty states.
 *   Packet   build the compact context packet an agent would receive for a task.
 *   Activity index status, refinement tasks and job runs.
 * Add link (knowledge.ingest.url) is a dialog opened from the toolbar. Consolidation
 * candidates live on the Review tab.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Brain, FileText, Link, Search } from 'lucide-react';
import { invokeMethod, sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { MarkdownMessage } from '../components/MarkdownMessage';
import { bestId, bestStatus, bestTitle, compactJson, countFrom, firstArray, firstString, readPath } from '../lib/object';
import { formatError } from '../lib/errors';
import { asProjectionKind, projectionPayload, type ProjectionKind } from '../lib/knowledge-projection';
import { CodeFrame, DetailPane, DetailSection, Disclosure, EmptyState, Facts, ListDetail, RowGroup, SkeletonRows } from '../components/data-view/DataView';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { Row } from '../components/ui/Row';
import { Segmented } from '../components/ui/Segmented';
import ErrorBoundary from '../components/feedback/ErrorBoundary';
import { ErrorState } from '../components/feedback/ErrorState';
import { KnowledgeMap } from './knowledge/KnowledgeMap';
import { KnowledgePacketPanel } from './knowledge/KnowledgePacket';
import { KnowledgeActivity, scalarFacts } from './knowledge/KnowledgeActivity';
import { AddLinkDialog } from './knowledge/AddLinkDialog';
import { includesText, sentence } from './library/library-data';
import '../styles/components/knowledge.css';

type Section = 'browse' | 'map' | 'packet' | 'activity';
const SECTIONS: readonly { value: Section; label: string }[] = [
  { value: 'browse', label: 'Browse' },
  { value: 'map', label: 'Map' },
  { value: 'packet', label: 'Packet' },
  { value: 'activity', label: 'Activity' },
];

const PAGE_SIZE = { source: 25, node: 25, issue: 10, projection: 25 } as const;

interface ProjectionSelection {
  key: string;
  /** Verbatim from the daemon, NOT narrowed: a target from a daemon newer than this
   * client still appears in the list with its real name. `renderableKind` decides
   * whether it can be sent. */
  kind: string;
  renderableKind: ProjectionKind | null;
  id?: string;
  target: unknown;
}

function projectionSelection(target: unknown): ProjectionSelection | null {
  const kind = firstString(target, ['kind']);
  if (!kind) return null;
  const id = firstString(target, ['targetId', 'id', 'itemId']);
  return {
    key: `${kind}:${id}`,
    kind,
    renderableKind: asProjectionKind(kind),
    ...(id ? { id } : {}),
    target,
  };
}

function markdownTextFromValue(value: unknown): string {
  return firstString(value, ['markdown', 'content', 'body', 'text', 'answer', 'summary', 'response'])
    || firstString(readPath(value, ['projection']), ['markdown', 'content', 'body', 'text'])
    || firstString(readPath(value, ['page']), ['markdown', 'content', 'body', 'text'])
    || firstString(readPath(value, ['result']), ['markdown', 'content', 'body', 'text']);
}

function ResultBlock({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const markdown = markdownTextFromValue(value);
  return (
    <DetailSection title={title}>
      {markdown ? <div className="lib-markdown"><MarkdownMessage content={markdown} /></div> : <CodeFrame>{compactJson(value)}</CodeFrame>}
    </DetailSection>
  );
}

function ItemPane({ itemId, label, onClose }: { itemId: string; label: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['knowledge', 'item', itemId],
    queryFn: () => invokeMethod('knowledge.item.get', { id: itemId }),
  });
  const body = readPath(detail.data, ['item']) ?? detail.data;
  return (
    <DetailPane title={detail.data ? bestTitle(body, itemId) : itemId} meta={label} onClose={onClose}>
      {detail.isPending && <SkeletonRows count={3} label="Loading detail" />}
      {detail.error && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} title="Could not load this item" />}
      {detail.data !== undefined && (
        <>
          <Facts items={scalarFacts(body)} />
          <Disclosure summary="Raw data" defaultOpen={scalarFacts(body).length === 0}>
            <CodeFrame>{compactJson(detail.data)}</CodeFrame>
          </Disclosure>
        </>
      )}
    </DetailPane>
  );
}

interface ItemGroupProps {
  label: string;
  kindLabel: string;
  prefix: string;
  items: unknown[];
  query: string;
  pageSize: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

function ItemGroup({ label, kindLabel, prefix, items, query, pageSize, selectedKey, onSelect }: ItemGroupProps) {
  const [visible, setVisible] = useState(pageSize);
  const shown = useMemo(
    () => items.filter((item) => includesText([bestTitle(item, ''), bestId(item)], query)),
    [items, query],
  );
  if (shown.length === 0) return null;
  return (
    <>
      <RowGroup label={label} count={shown.length}>
        {shown.slice(0, visible).map((item, index) => {
          const id = bestId(item) || String(index);
          const key = `${prefix}:${id}`;
          return (
            <Row
              key={`${key}-${index}`}
              title={bestTitle(item, id)}
              meta={`${kindLabel} · ${sentence(bestStatus(item))}`}
              selected={selectedKey === key}
              onSelect={() => onSelect(key)}
            />
          );
        })}
      </RowGroup>
      {shown.length > visible && (
        <div className="lib-more">
          <Button variant="ghost" size="sm" aria-label={`Show more ${label.toLowerCase()}`} onClick={() => setVisible((v) => v + pageSize)}>
            Show more ({shown.length - visible} left)
          </Button>
        </div>
      )}
    </>
  );
}

export interface KnowledgeViewProps {
  /** The Library's shared search text (already settled). */
  query?: string;
}

export function KnowledgeView({ query = '' }: KnowledgeViewProps) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>('browse');
  const [selection, setSelection] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [mapFilter, setMapFilter] = useState('');

  const status = useQuery({ queryKey: queryKeys.knowledgeStatus, queryFn: () => sdk.knowledge.status() });
  const sources = useQuery({ queryKey: queryKeys.knowledgeSources, queryFn: () => invokeMethod('knowledge.sources.list', { limit: 100 }) });
  const nodes = useQuery({ queryKey: queryKeys.knowledgeNodes, queryFn: () => invokeMethod('knowledge.nodes.list', { limit: 100 }) });
  const issues = useQuery({ queryKey: queryKeys.knowledgeIssues, queryFn: () => invokeMethod('knowledge.issues.list', { limit: 100 }) });
  const projections = useQuery({ queryKey: queryKeys.knowledgeProjections, queryFn: () => invokeMethod('knowledge.projections.list', { limit: 100 }) });
  const knowledgeMap = useQuery({
    queryKey: [...queryKeys.knowledgeMap, mapFilter],
    queryFn: () => sdk.knowledge.map({
      limit: 150,
      includeSources: true,
      includeIssues: true,
      includeGenerated: true,
      ...(mapFilter.trim() ? { query: mapFilter.trim() } : {}),
    }),
  });

  const ask = useMutation({
    mutationFn: (mode: 'ask' | 'search') => mode === 'ask'
      ? sdk.knowledge.ask({ query, limit: 10, includeSources: true, includeConfidence: true, includeLinkedObjects: true, timeoutMs: 20_000 })
      : sdk.knowledge.search({ query, limit: 25, includeSources: true, includeNodes: true }),
  });

  const allSources = useMemo(() => firstArray(sources.data, ['sources', 'items', 'data']), [sources.data]);
  const allNodes = useMemo(() => firstArray(nodes.data, ['nodes', 'items', 'data']), [nodes.data]);
  const allIssues = useMemo(() => firstArray(issues.data, ['issues', 'items', 'data']), [issues.data]);
  const projectionSelections = useMemo(
    () => firstArray(projections.data, ['targets', 'items', 'data'])
      .map(projectionSelection)
      .filter((item): item is ProjectionSelection => item !== null),
    [projections.data],
  );
  const selectedProjection = selection?.startsWith('projection:')
    ? projectionSelections.find((s) => `projection:${s.key}` === selection) ?? null
    : null;

  const renderProjection = useMutation({
    mutationFn: (target: ProjectionSelection) => invokeMethod('knowledge.projection.render', projectionPayload(target)),
  });
  const materializeProjection = useMutation({
    mutationFn: (target: ProjectionSelection) => invokeMethod('knowledge.projection.materialize', projectionPayload(target)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });

  // W8 activity honesty: jobRunCount/nodeCount live side by side on knowledge.status but
  // were never contrasted (a '766 jobs ran / 0 nodes' state read as a blank map). null
  // means "the status query hasn't resolved yet" so nothing flashes a false "empty".
  const statusKnown = !status.isPending && !status.error;
  const statusJobRunCount = statusKnown ? countFrom(status.data, ['jobRunCount']) : null;
  const statusNodeCount = statusKnown ? countFrom(status.data, ['nodeCount']) : null;

  const runAsk = useCallback((mode: 'ask' | 'search') => {
    if (!query.trim()) return;
    setSelection('answer');
    ask.mutate(mode);
  }, [ask, query]);

  const loadingAll = sources.isPending && nodes.isPending && issues.isPending && projections.isPending;
  const browseEmpty = !loadingAll && !sources.isPending && !nodes.isPending && !issues.isPending && !projections.isPending
    && allSources.length + allNodes.length + allIssues.length + projectionSelections.length === 0;
  const nodesNote = !nodes.isPending && !nodes.error && allNodes.length === 0 && statusJobRunCount !== null && statusJobRunCount > 0;

  const retryNote = (label: string, error: unknown, retry: () => void) => (
    <div className="dv-notice dv-notice--bad" role="alert" key={label}>
      <span>{label} could not load: {formatError(error)}</span>
      <Button variant="ghost" size="sm" onClick={retry}>Retry</Button>
    </div>
  );

  const answerText = firstString(ask.data, ['answer', 'text', 'summary', 'response']);
  const listPane = (
    <>
      {query.trim() && (
        <div className="lib-ask" role="group" aria-label="Ask knowledge">
          <span className="lib-ask__text">Ask or search knowledge for “{query.trim()}”</span>
          <span className="lib-ask__actions">
            <Button variant="outline" size="sm" icon={<Brain aria-hidden="true" />} disabled={ask.isPending} onClick={() => runAsk('ask')}>Ask</Button>
            <Button variant="outline" size="sm" icon={<Search aria-hidden="true" />} disabled={ask.isPending} onClick={() => runAsk('search')}>Search</Button>
          </span>
        </div>
      )}
      {loadingAll && <SkeletonRows count={6} label="Loading knowledge" />}
      {sources.error && retryNote('Sources', sources.error, () => void sources.refetch())}
      {nodes.error && retryNote('Nodes', nodes.error, () => void nodes.refetch())}
      {issues.error && retryNote('Issues', issues.error, () => void issues.refetch())}
      {projections.error && retryNote('Projections', projections.error, () => void projections.refetch())}
      {nodesNote && (
        <div className="dv-notice" role="status">
          <span>
            {statusJobRunCount} indexing job{statusJobRunCount === 1 ? '' : 's'} ran, 0 nodes. Indexing may still be in progress, filtered out everything, or be failing to produce nodes.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSection('activity')}>View jobs</Button>
        </div>
      )}
      <ItemGroup label="Sources" kindLabel="Source" prefix="source" items={allSources} query={query} pageSize={PAGE_SIZE.source} selectedKey={selection} onSelect={setSelection} />
      <ItemGroup label="Nodes" kindLabel="Node" prefix="node" items={allNodes} query={query} pageSize={PAGE_SIZE.node} selectedKey={selection} onSelect={setSelection} />
      <ItemGroup label="Issues" kindLabel="Issue" prefix="issue" items={allIssues} query={query} pageSize={PAGE_SIZE.issue} selectedKey={selection} onSelect={setSelection} />
      {projectionSelections.length > 0 && (
        <RowGroup label="Wiki projections" count={projectionSelections.length}>
          {projectionSelections
            .filter((s) => includesText([bestTitle(s.target, s.kind), s.kind, s.id], query))
            .slice(0, PAGE_SIZE.projection)
            .map((s, index) => (
              <Row
                key={`${s.key}-${index}`}
                title={bestTitle(s.target, s.kind)}
                meta={`${sentence(s.kind)}${s.id ? ` · ${s.id}` : ''}`}
                selected={selection === `projection:${s.key}`}
                onSelect={() => setSelection(`projection:${s.key}`)}
              />
            ))}
        </RowGroup>
      )}
      {browseEmpty && (
        <EmptyState
          icon={<BookOpen />}
          title="No knowledge yet"
          action={<Button variant="secondary" icon={<Link aria-hidden="true" />} onClick={() => setLinkOpen(true)}>Add link</Button>}
        >
          Add a link and GoodVibes will read it, index it and answer questions from it.
        </EmptyState>
      )}
    </>
  );

  let detail: ReactNode = null;
  if (selection === 'answer') {
    detail = (
      <DetailPane title={ask.variables === 'search' ? 'Search results' : 'Answer'} meta={query.trim() ? `“${query.trim()}”` : undefined} onClose={() => setSelection(null)}>
        {ask.isPending && <SkeletonRows count={3} label="Running the query" />}
        {ask.error && (
          <div className="dv-notice dv-notice--bad" role="alert">
            <span>Query failed: {formatError(ask.error)}</span>
            <Button variant="ghost" size="sm" onClick={() => runAsk(ask.variables ?? 'ask')}>Retry</Button>
          </div>
        )}
        {ask.data !== undefined && ask.data !== null && (
          <>
            {answerText
              ? <div className="lib-markdown"><MarkdownMessage content={answerText} /></div>
              : <CodeFrame label="Response">{compactJson(ask.data)}</CodeFrame>}
            {([
              ['Sources', firstArray(ask.data, ['sources'])],
              ['Facts', firstArray(ask.data, ['facts'])],
              ['Gaps', firstArray(ask.data, ['gaps', 'issues'])],
              ['Linked objects', firstArray(ask.data, ['linkedObjects', 'objects'])],
              ['Refinement', firstArray(ask.data, ['refinementTaskIds', 'refinementTasks'])],
            ] as const).filter(([, items]) => items.length > 0).map(([title, items]) => (
              <DetailSection key={title} title={title}><CodeFrame>{compactJson(items)}</CodeFrame></DetailSection>
            ))}
          </>
        )}
      </DetailPane>
    );
  } else if (selectedProjection) {
    const blocked = !selectedProjection.renderableKind;
    const blockedNote = `This web UI cannot request a "${selectedProjection.kind}" projection.`;
    detail = (
      <DetailPane
        title={bestTitle(selectedProjection.target, selectedProjection.kind)}
        meta={`${sentence(selectedProjection.kind)}${selectedProjection.id ? ` · ${selectedProjection.id}` : ''}`}
        onClose={() => setSelection(null)}
        footer={(
          <>
            <Button variant="secondary" disabled={blocked || renderProjection.isPending} title={blocked ? blockedNote : undefined} aria-busy={renderProjection.isPending} onClick={() => renderProjection.mutate(selectedProjection)}>Render</Button>
            <Button variant="secondary" disabled={blocked || materializeProjection.isPending} title={blocked ? blockedNote : undefined} aria-busy={materializeProjection.isPending} onClick={() => materializeProjection.mutate(selectedProjection)}>Materialize</Button>
          </>
        )}
      >
        {blocked && <div className="dv-notice" role="note"><span>{blockedNote}</span></div>}
        {renderProjection.error && <div className="dv-notice dv-notice--bad" role="alert"><span>Render failed: {formatError(renderProjection.error)}</span></div>}
        {materializeProjection.error && <div className="dv-notice dv-notice--bad" role="alert"><span>Materialize failed: {formatError(materializeProjection.error)}</span></div>}
        <ResultBlock title="Rendered projection" value={renderProjection.data} />
        <ResultBlock title="Materialized projection" value={materializeProjection.data} />
        {renderProjection.data === undefined && materializeProjection.data === undefined && !blocked && (
          <p className="lib-quiet"><FileText size={14} aria-hidden="true" /> Render previews the page; Materialize writes it.</p>
        )}
      </DetailPane>
    );
  } else if (selection && /^(source|node|issue):/.test(selection)) {
    const [kind, ...rest] = selection.split(':');
    detail = <ItemPane key={selection} itemId={rest.join(':')} label={sentence(kind)} onClose={() => setSelection(null)} />;
  }

  return (
    <ErrorBoundary fallback={(err, reset) => <ErrorState error={err} onRetry={reset} title="Knowledge view failed" />}>
      <div className="lib-tab">
        <div className="lib-toolbar" role="group" aria-label="Knowledge toolbar">
          <Segmented<Section> label="Knowledge sections" value={section} onChange={setSection} options={SECTIONS} />
          <span className="lib-toolbar__end">
            <Button variant="secondary" icon={<Link aria-hidden="true" />} onClick={() => setLinkOpen(true)}>Add link</Button>
          </span>
        </div>

        {section === 'browse' && (
          <ListDetail
            mode="peek"
            list={listPane}
            detail={detail}
            detailOpen={detail !== null}
            onCloseDetail={() => setSelection(null)}
            listLabel="Knowledge"
            detailLabel="Knowledge detail"
            backLabel="All knowledge"
          />
        )}

        {section === 'map' && (
          <div className="lib-scroll">
            <div className="lib-inline">
              <Input
                value={mapFilter}
                onChange={(event) => setMapFilter(event.target.value)}
                placeholder="Filter map"
                aria-label="Filter knowledge map"
              />
              <Button variant="secondary" aria-label="Refresh knowledge map" onClick={() => void knowledgeMap.refetch()}>Refresh</Button>
            </div>
            <div aria-live="polite" aria-atomic="true">
              <KnowledgeMap
                isPending={knowledgeMap.isPending}
                error={knowledgeMap.error}
                data={knowledgeMap.data}
                onRetry={() => void knowledgeMap.refetch()}
                hasFilter={Boolean(mapFilter.trim())}
                onClearFilter={() => setMapFilter('')}
                onViewJobs={() => setSection('activity')}
                jobRunCount={statusJobRunCount}
                overallNodeCount={statusNodeCount}
                statusPending={status.isPending}
              />
            </div>
          </div>
        )}

        {section === 'packet' && <div className="lib-scroll lib-scroll--narrow"><KnowledgePacketPanel /></div>}
        {section === 'activity' && <div className="lib-scroll lib-scroll--narrow"><KnowledgeActivity /></div>}

        <AddLinkDialog
          open={linkOpen}
          onClose={() => setLinkOpen(false)}
          onIngested={(sourceId) => {
            setSection('browse');
            setSelection(`source:${sourceId}`);
          }}
        />
      </div>
    </ErrorBoundary>
  );
}
