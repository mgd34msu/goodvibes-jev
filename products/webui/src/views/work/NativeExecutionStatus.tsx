import type {
  NativeWorkExecutionRevision,
  NativeWorkExecutionSnapshot,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import { Button } from "../../components/ui/Button";
import { DetailSection, Facts } from "../../components/data-view/DataView";

interface NativeExecutionStatusProps {
  observation?: NativeExecutionObservation;
  error?: string;
  busy: string;
  requestDisabled?: boolean;
  onInspect: () => void;
  onRequest: () => void;
  onResume: () => void;
  onCancel: () => void;
}

function revision(value: NativeWorkExecutionRevision | null): string {
  return value
    ? `Work ${value.work}, criteria ${value.criteria}, attempt ${value.attempt}`
    : "Unavailable";
}

function description(snapshot: NativeWorkExecutionSnapshot): string {
  if (snapshot.kind === "prevented-before-admission")
    return "Execution was prevented before admission. No native execution association was published.";
  if (snapshot.kind === "pending-intent") {
    if (snapshot.state === "refused")
      return "Jev refused execution admission. No execution receipt has been recorded.";
    return snapshot.recovery === "required"
      ? "Execution admission was interrupted. Explicit recovery is required; no execution receipt has been recorded."
      : "Execution admission is pending. No execution receipt has been recorded.";
  }
  if (snapshot.state === "cancelled" || snapshot.recovery === "cancelled")
    return "Native execution is cancelled. Any real execution receipt is retained below.";
  if (snapshot.recovery === "required" && snapshot.state === "launch-claimed")
    return "The execution launch was claimed and requires reconciliation. This screen cannot restart its effects.";
  if (snapshot.state === "prepared" && ["available", "required"].includes(snapshot.recovery))
    return "Prepared execution is available for explicit recovery. Resume rechecks the current attempt before continuing.";
  if (snapshot.progress?.status === "passed")
    return "The execution runner passed. Ledger verification and publication are separate outcomes.";
  if (snapshot.progress?.status === "failed")
    return "The execution runner failed. It cannot be restarted as this attempt.";
  return snapshot.progress
    ? `Native execution is ${snapshot.progress.status}.`
    : "A native execution association is recorded. Runtime progress is not available.";
}

/** Project only bounded host observations. Intent states never acquire a fabricated receipt. */
export function NativeExecutionStatus({
  observation,
  error,
  busy,
  requestDisabled = false,
  onInspect,
  onRequest,
  onResume,
  onCancel,
}: NativeExecutionStatusProps) {
  const snapshot = observation?.kind === "recorded" ? observation.snapshot : undefined;
  const target =
    observation && observation.kind !== "not-requested" ? observation.target : undefined;
  const execution = snapshot?.kind === "execution" ? snapshot : undefined;
  const cancelled =
    snapshot?.kind === "prevented-before-admission" || snapshot?.state === "cancelled";
  const resumable = Boolean(
    snapshot &&
    !snapshot.stale &&
    snapshot.currentAttempt &&
    ((snapshot.kind === "pending-intent" && snapshot.recovery === "required") ||
      (snapshot.kind === "execution" &&
        snapshot.state === "prepared" &&
        ["available", "required"].includes(snapshot.recovery)))
  );
  const settlement = execution?.settlement;
  const settlementAction =
    !cancelled && settlement?.state === "published"
      ? "Reconcile publication"
      : !cancelled &&
          execution?.progress?.status === "passed" &&
          settlement &&
          ["pending", "failed", "required"].includes(settlement.state)
        ? "Verify and publish"
        : undefined;
  const canRequest =
    !observation || observation.kind === "not-requested" || observation.kind === "not-found";

  return (
    <DetailSection title="Native execution">
      {error && <p role="alert">{error}</p>}
      {error && observation && observation.kind !== "not-requested" && (
        <p className="dv-muted">The details below are the last successful observation.</p>
      )}
      <p role="status">
        {snapshot
          ? description(snapshot)
          : observation?.kind === "not-found"
            ? "The latest lookup found no execution association or intent for this saved attempt."
            : observation?.kind === "not-requested"
              ? "No execution request target has been retained in this browser for this input."
              : "The execution outcome is not yet known. Inspect this saved request before drawing conclusions."}
      </p>
      {target && (
        <Facts
          items={[
            { label: "Execution work", value: target.workId },
            { label: "Execution attempt", value: target.attemptId },
            { label: "Requested revisions", value: revision(target.expectedRevision) },
          ]}
        />
      )}
      {snapshot && (
        <>
          <Facts
            items={[
              { label: "Association", value: snapshot.kind },
              { label: "State", value: snapshot.state },
              { label: "Recovery", value: snapshot.recovery },
              {
                label: snapshot.kind === "execution" ? "Admitted revisions" : "Intent revisions",
                value: revision(snapshot.expectedRevision),
              },
              { label: "Current revisions", value: revision(snapshot.currentRevision) },
              { label: "Current attempt", value: snapshot.currentAttempt ? "Yes" : "No" },
              { label: "Stale target", value: snapshot.stale ? "Yes" : "No" },
            ]}
          />
          {(snapshot.stale || !snapshot.currentAttempt) && (
            <p className="dv-muted">
              The ledger target changed. These observations retain the original attempt and
              revisions; they do not authorize a new attempt.
            </p>
          )}
        </>
      )}
      {execution?.receipt && (
        <DetailSection title="Execution receipt">
          <Facts
            items={[
              { label: "Contract", value: execution.receipt.contractId },
              { label: "Owner agent", value: execution.receipt.ownerAgentId },
            ]}
          />
        </DetailSection>
      )}
      {execution?.progress && (
        <DetailSection title="Execution progress">
          <Facts
            items={[
              { label: "Runner", value: execution.progress.status },
              { label: "Session mode", value: execution.progress.sessionMode ? "Yes" : "No" },
              {
                label: "Semantic state",
                value: execution.progress.semanticState ?? "None reported",
              },
              { label: "Semantic stage", value: execution.progress.stage ?? "None reported" },
              {
                label: "Transport retry",
                value: execution.progress.retrying
                  ? "Waiting on shared transport retry"
                  : "None reported",
              },
              {
                label: "Units",
                value: `${execution.progress.units.passed} passed, ${execution.progress.units.failed} failed, ${execution.progress.units.total} total`,
              },
              {
                label: "Criteria",
                value: `${execution.progress.criteria.met} met, ${execution.progress.criteria.unmet} unmet, ${execution.progress.criteria.unshown} unshown, ${execution.progress.criteria.total} total`,
              },
            ]}
          />
          <p className="dv-muted">
            Runner progress and criterion counts do not establish ledger verification.
          </p>
        </DetailSection>
      )}
      {execution && (
        <DetailSection title="Ledger settlement">
          <Facts
            items={[
              { label: "Publication", value: settlement?.state ?? "Not reported" },
              ...(settlement?.evidenceId === undefined
                ? []
                : [{ label: "Evidence", value: settlement.evidenceId }]),
              ...(settlement?.reportSequence === undefined
                ? []
                : [{ label: "Report sequence", value: settlement.reportSequence }]),
              ...(settlement?.evidenceSequence === undefined
                ? []
                : [{ label: "Evidence sequence", value: settlement.evidenceSequence }]),
            ]}
          />
          <p className="dv-muted">
            {settlement?.state === "published"
              ? "The host published a report and verification evidence. Publication alone does not say that the evidence passed verification."
              : "Verification and publication are separate from execution. This snapshot does not establish verified ledger completion."}
          </p>
        </DetailSection>
      )}
      <div className="work-form__actions">
        <Button disabled={Boolean(busy)} onClick={onInspect}>
          Inspect execution
        </Button>
        {canRequest && (
          <Button disabled={Boolean(busy) || requestDisabled} onClick={onRequest}>
            Continue request
          </Button>
        )}
        {resumable && !settlementAction && (
          <Button disabled={Boolean(busy) || requestDisabled} onClick={onResume}>
            Resume execution
          </Button>
        )}
        {settlementAction && (
          <Button disabled={Boolean(busy) || requestDisabled} onClick={onResume}>
            {settlementAction}
          </Button>
        )}
        {!cancelled && (
          <Button
            disabled={
              busy === "Cancelling execution" || busy === "Connecting" || busy === "Cancelling"
            }
            onClick={onCancel}
          >
            Cancel execution
          </Button>
        )}
      </div>
      <p className="dv-muted">
        Inspect only reads status. Continuing a request checks the same saved attempt before
        sending; recovery is always explicit. Closing or choosing New request only detaches this
        view.
      </p>
    </DetailSection>
  );
}
