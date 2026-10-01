/**
 * TaskGraphPanel, the fix-phase task graph for one workstream
 * (fleet.graph.get, SDK 1.8.0), rendered in the workstream/fleet detail pane.
 *
 * Deliberately a vertical list, not a node-link diagram: legible at phone
 * width is the bar (per the brief), and every state tell (ready/running/
 * blocked/at-cap/stalled) is expressible as text + a badge, a diagram earns
 * its complexity only once this list stops being readable, which it is not.
 *
 * The pool summary line renders the brief's own vocabulary verbatim: "N
 * ready, M running, at the limit of N running at once", the limit clause only
 * when the daemon reports it. `pool` is null for a workstream with no
 * elastic pool (a fixed-capacity/single-agent run); no summary line renders
 * then, never a fabricated "0 ready, 0 running".
 */
import { useQuery } from '@tanstack/react-query';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import {
  graphNodeStateLabel,
  graphNodeStateTone,
  isKnownGraphNodeState,
  poolSummaryLabel,
  type FleetGraphNode,
} from '../../lib/fleet-graph';
import type { BadgeTone } from '../../lib/presentation-bridge';
import { DetailSection } from '../data-view/DataView';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { Chip } from '../ui/Chip';
import type { StatusTone } from '../ui/StatusDot';
import '../../styles/components/task-graph.css';

export interface TaskGraphPanelProps {
  workstreamId: string;
}

const CHIP_TONE: Record<BadgeTone, StatusTone> = {
  ok: 'ok',
  warning: 'warn',
  bad: 'bad',
  neutral: 'idle',
};

/** One graph node as a divided row: title, one meta line, the state word right-aligned. */
function GraphNodeRow({ node }: { node: FleetGraphNode }) {
  const tone = graphNodeStateTone(node.state);
  const meta = [node.blockedReason, node.files.length > 0 ? node.files.join(', ') : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="gv-row task-graph-node" data-testid="task-graph-node">
      <div className="gv-row__main">
        <span className="gv-row__text">
          <span className="gv-row__title task-graph-node__title">{node.title}</span>
          {meta && <span className="gv-row__meta" title={meta}>{meta}</span>}
        </span>
      </div>
      <div className="gv-row__trailing">
        <Chip
          size="sm"
          tone={CHIP_TONE[tone]}
          data-tone={tone}
          title={isKnownGraphNodeState(node.state) ? undefined : 'State not known to this client, shown verbatim'}
        >
          {graphNodeStateLabel(node.state)}
        </Chip>
        {node.stalled && <Chip size="sm" tone="warn">Stalled</Chip>}
      </div>
    </li>
  );
}

export function TaskGraphPanel({ workstreamId }: TaskGraphPanelProps) {
  const graph = useQuery({
    queryKey: queryKeys.fleetGraph(workstreamId),
    queryFn: () => sdk.operator.fleet.graph.get(workstreamId),
    enabled: Boolean(workstreamId),
  });

  if (graph.isPending) {
    return (
      <div className="task-graph-panel">
        <DetailSection title="Task graph">
          <SkeletonBlock variant="text" lines={3} />
        </DetailSection>
      </div>
    );
  }

  if (graph.isError) {
    return (
      <div className="task-graph-panel">
        <DetailSection title="Task graph">
          <ErrorState error={graph.error} title="Task graph unavailable" onRetry={() => void graph.refetch()} />
        </DetailSection>
      </div>
    );
  }

  const { nodes, pool } = graph.data;

  return (
    <div className="task-graph-panel">
      <DetailSection title="Task graph">
        {pool && (
          <p className="task-graph-panel__pool" data-testid="task-graph-pool">
            {poolSummaryLabel(pool)}
            {pool.refusal && `: ${pool.refusal}`}
          </p>
        )}
        {nodes.length === 0 ? (
          <p className="task-graph-panel__empty">No task-graph nodes yet.</p>
        ) : (
          <ul className="gv-rows task-graph-nodes">
            {nodes.map((node) => <GraphNodeRow key={node.id} node={node} />)}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
