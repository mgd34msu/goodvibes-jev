import type { NativeHostedTurnSnapshot } from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import type { NativeTurnObservation } from "../../lib/native-turn";
import { Button } from "../../components/ui/Button";
import { DetailSection, Facts } from "../../components/data-view/DataView";

interface NativeTurnStatusProps {
  observation?: NativeTurnObservation;
  error?: string;
  busy: string;
  requestDisabled?: boolean;
  onInspect: () => void;
  onRequest: () => void;
  onCancel: () => void;
  onOpenSession?: (sessionId: string) => void;
}

function description(state: NativeHostedTurnSnapshot["state"]): string {
  switch (state) {
    case "queued":
      return "The host queued this continuation behind the active turn. It will deliver it in order using the completed transcript captured at submission, excluding the active reply.";
    case "preparing":
      return "The host is preparing the original conversation delivery.";
    case "running":
      return "The original conversation turn is running in its hosted session.";
    case "cancelling":
      return "The host is cancelling the original turn and waiting for its owned work to stop.";
    case "completed":
      return "The host recorded completion of the original conversation delivery.";
    case "cancelled":
      return "The original conversation delivery is cancelled. Effects already performed are not undone. Any recorded session identity is retained below.";
    case "recovery-required":
      return "The original conversation delivery requires reconciliation. Its dispatch will not be replayed from this screen.";
  }
}

/** A host observation is status, never browser authority to replay a model turn. */
export function NativeTurnStatus({
  observation,
  error,
  busy,
  requestDisabled = false,
  onInspect,
  onRequest,
  onCancel,
  onOpenSession,
}: NativeTurnStatusProps) {
  const snapshot = observation?.kind === "recorded" ? observation.snapshot : undefined;
  const sessionId = snapshot?.sessionId;
  const canRequest = !observation || observation.kind === "not-found";
  const terminal = snapshot?.state === "completed" || snapshot?.state === "cancelled";
  return (
    <DetailSection title="Hosted conversation">
      {error && <p role="alert">{error}</p>}
      {error && snapshot && (
        <p className="dv-muted">The details below are the last successful observation.</p>
      )}
      <p role="status">
        {snapshot
          ? description(snapshot.state)
          : observation?.kind === "not-found"
            ? "The latest lookup found no hosted delivery for this original input."
            : observation?.kind === "not-requested"
              ? "The latest source lookup did not identify a conversation turn."
              : "The conversation delivery outcome is not yet known. Inspect the saved original before drawing conclusions."}
      </p>
      {snapshot && (
        <Facts
          items={[
            { label: "Conversation state", value: snapshot.state },
            { label: "Conversation source revision", value: snapshot.sourceRevision },
            { label: "Hosted session", value: snapshot.sessionId ?? "Not recorded" },
            { label: "Broker input", value: snapshot.brokerInputId ?? "Not recorded" },
            { label: "Correlation", value: snapshot.correlationId ?? "Not recorded" },
          ]}
        />
      )}
      <div className="work-form__actions">
        <Button disabled={Boolean(busy)} onClick={onInspect}>
          Inspect conversation
        </Button>
        {canRequest && (
          <Button disabled={Boolean(busy) || requestDisabled} onClick={onRequest}>
            Continue conversation request
          </Button>
        )}
        {!terminal && observation?.kind !== "not-requested" && (
          <Button
            disabled={busy.startsWith("Cancelling") || busy === "Connecting"}
            onClick={onCancel}
          >
            Cancel conversation
          </Button>
        )}
        {sessionId && onOpenSession && (
          <Button onClick={() => onOpenSession(sessionId)}>Open hosted session</Button>
        )}
      </div>
      <p className="dv-muted">
        Inspect only reads status. Continuing checks the original source and delivery status before
        sending. Closing or choosing New request only detaches this view.
      </p>
    </DetailSection>
  );
}
