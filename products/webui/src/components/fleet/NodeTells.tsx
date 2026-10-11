/**
 * NodeTells, the read-model's two derived per-node projections, rendered
 * identically wherever agent activity shows (FleetView, WorkstreamView):
 *
 *   - headline: ONE line derived from the node's task/phase identity, replaced
 *     in place on transitions (never an appended feed, the daemon enforces the
 *     anti-feed contract and the 80-char cap at the read-model).
 *   - stall tell: a pure timestamp comparison ("no activity for N minutes on a
 *     live node"), rendered as a marker with the raw facts, not a judgment.
 *
 * Both read defensively via lib/fleet.ts (the generated contract type does not
 * declare the fields yet; they ride the node's open index signature).
 */
import type { FleetProcessNode } from '../../lib/goodvibes';
import { readCheckSummary, readHeadline, readReviewSummary, readStallTell, stallTellLabel } from '../../lib/fleet';
import { whenLabel } from '../../lib/when-label';
import { Chip } from '../ui/Chip';
import { StatusDot } from '../ui/StatusDot';

export function NodeHeadline({ node, block = false }: { readonly node: FleetProcessNode; readonly block?: boolean }) {
  const headline = readHeadline(node);
  if (!headline) return null;
  if (block) {
    return <p className="node-headline node-headline--block" data-testid="fleet-detail-headline">{headline.text}</p>;
  }
  return <span className="node-headline" data-testid="fleet-headline">{headline.text}</span>;
}

export function NodeStallBadge({ node }: { readonly node: FleetProcessNode }) {
  const stall = readStallTell(node);
  if (!stall) return null;
  return (
    <Chip
      size="sm"
      tone="warn"
      className="node-stall-badge"
      data-testid="fleet-stall"
      title={`No activity ${whenLabel(stall.since) || 'recently'}: a comparison of timestamps, not a judgment`}
    >
      {stallTellLabel(stall)}
    </Chip>
  );
}

export function NodeStallNote({ node }: { readonly node: FleetProcessNode }) {
  const stall = readStallTell(node);
  if (!stall) return null;
  return (
    <p className="node-stall-note" role="note" data-testid="fleet-detail-stall">
      {stallTellLabel(stall)}{whenLabel(stall.since) ? `: last activity ${whenLabel(stall.since)}` : ''}
    </p>
  );
}

/** The canonical contract adapter owns these readings and counts. This renderer adds no score or pass decision. */
function NodeCheckSummary({ node }: { readonly node: FleetProcessNode }) {
  const check = readCheckSummary(node);
  if (!check) return <p role="note" data-testid="fleet-check-unavailable">Contract check summary unavailable.</p>;
  return (
    <div className="fleet-detail__review" data-testid="fleet-detail-check">
      <div className="fleet-detail__review-head">
        <strong>Contract checks</strong>
        <span>{check.met} of {check.judged} criteria met</span>
        <span className="fleet-detail__review-meta">{check.nudges} correction{check.nudges === 1 ? '' : 's'}</span>
      </div>
      {check.lastCheckAt !== undefined && <p>Last check {whenLabel(check.lastCheckAt)}</p>}
      {check.criteria.length === 0 ? <p role="note">No judged criteria reported.</p> : (
        <ul className="fleet-detail__review-checklist">
          {check.criteria.map(criterion => (
            <li key={criterion.id} data-verdict={criterion.verdict}>
              <span className="fleet-detail__review-mark" aria-hidden="true">
                <StatusDot tone={criterion.verdict === 'met' ? 'ok' : criterion.verdict === 'unmet' ? 'bad' : 'idle'} />
              </span>
              <span className="fleet-detail__review-body">
                <span className="fleet-detail__review-req">{criterion.text || criterion.id}</span>
                <span className="fleet-detail__review-state">{criterion.verdict}</span>
                {criterion.outcome !== undefined && <span>Recorded outcome: {criterion.outcome}</span>}
                {criterion.severity !== undefined && <span>Severity: {criterion.severity}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * NodeReviewSummary, the latest review's verdict, score, cycles, and acceptance
 * checklist for a reviewed wrfc-chain / wrfc-subtask node (readReviewSummary,
 * SDK 1.9.0). Detail-pane only; renders NOTHING before a review has completed
 * (the field is absent, never a fabricated "not yet reviewed" shell). The
 * verdict is the CONTROLLER's `passed` (gate-inclusive), not the reviewer's own
 * claim. Each checklist item shows whether the requirement was independently
 * VERIFIED (not just scored), with the reviewer's evidence and how it was
 * exercised. An EMPTY checklist is called out as a gate failure, an accepted
 * verdict with no acceptance items is not an accepted deliverable.
 */
export function NodeReviewSummary({ node }: { readonly node: FleetProcessNode }) {
  // A malformed canonical projection must never fall back to obsolete review evidence.
  if (Object.hasOwn(node, 'check')) return <NodeCheckSummary node={node} />;
  const review = readReviewSummary(node);
  if (!review) return null;
  const verdictTone = review.passed ? 'ok' : 'bad';
  const verdictLabel = review.passed ? 'Accepted' : 'Rejected';
  return (
    <div className="fleet-detail__review" data-testid="fleet-detail-review">
      <div className="fleet-detail__review-head">
        <strong>Review</strong>
        <span className="fleet-detail__review-verdict" data-tone={verdictTone} data-testid="fleet-review-verdict">
          <StatusDot tone={verdictTone} />
          {verdictLabel}
        </span>
        <span className="fleet-detail__review-meta">score {review.score} · {review.cycles} cycle{review.cycles === 1 ? '' : 's'}</span>
      </div>
      {review.checklist.length === 0 ? (
        <p className="fleet-detail__review-empty" role="note" data-testid="fleet-review-empty">
          The reviewer gave no acceptance checklist. That fails the review gate, so this is not an accepted result.
        </p>
      ) : (
        <ul className="fleet-detail__review-checklist" data-testid="fleet-review-checklist">
          {review.checklist.map((entry, index) => (
            <li
              key={`${index}-${entry.item}`}
              className={entry.verified ? 'verified' : 'unverified'}
              data-verified={entry.verified}
            >
              <span className="fleet-detail__review-mark" aria-hidden="true">
                <StatusDot tone={entry.verified ? 'ok' : 'bad'} />
              </span>
              <span className="fleet-detail__review-body">
                <span className="fleet-detail__review-req">{entry.item}</span>
                <span className="fleet-detail__review-state">{entry.verified ? 'Verified' : 'Not verified'}</span>
                {entry.evidence && <span className="fleet-detail__review-evidence">{entry.evidence}</span>}
                {entry.howExercised && (
                  <span className="fleet-detail__review-exercised">How exercised: {entry.howExercised}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
