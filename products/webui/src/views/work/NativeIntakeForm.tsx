import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { NativeConversationIntakeUnsupportedSource } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import { type ClientLifetime, isClientLifetimeCurrent } from "../../lib/client-lifetime";
import {
  nativeIntakeDescription,
  openNativeIntake,
  type NativeIntakeResult,
  type NativeIntakeSession,
} from "../../lib/native-intake";
import type { NativeIntakeBrowserRecord } from "../../lib/native-intake-journal";
import { formatError } from "../../lib/errors";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import { NativeExecutionStatus } from "./NativeExecutionStatus";
import { NativeTurnStatus } from "./NativeTurnStatus";
import type { NativeTurnObservation } from "../../lib/native-turn";
import { Button } from "../../components/ui/Button";
import { Field, Input, Textarea } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { Facts, DetailSection } from "../../components/data-view/DataView";

/** One original submission continues into native work or hosted conversation delivery. */
interface NativeIntakeFormProps {
  lifetime: ClientLifetime;
  onOpenSession?: (sessionId: string) => void;
  continuationSessionId?: string;
  projectId?: string;
  closed?: boolean;
}
export function NativeIntakeForm(props: NativeIntakeFormProps) {
  return (
    <ScopedNativeIntakeForm
      key={JSON.stringify([
        props.lifetime.revision,
        props.continuationSessionId ?? null,
        props.projectId ?? null,
      ])}
      {...props}
    />
  );
}

/** Never carry source, receipts or controls across a selected connection change. */
function ScopedNativeIntakeForm({
  lifetime,
  onOpenSession,
  continuationSessionId,
  projectId,
  closed = false,
}: NativeIntakeFormProps) {
  const [text, setText] = useState("");
  const [sources, setSources] = useState<NativeConversationIntakeUnsupportedSource[]>([]);
  const [records, setRecords] = useState<NativeIntakeBrowserRecord[]>([]);
  const [selected, setSelected] = useState<NativeIntakeBrowserRecord>();
  const [result, setResult] = useState<NativeIntakeResult>();
  const [turn, setTurn] = useState<NativeTurnObservation>();
  const [turnError, setTurnError] = useState<string>();
  const [busy, setBusy] = useState<string>("Connecting");
  const [error, setError] = useState<string>();
  const [execution, setExecution] = useState<NativeExecutionObservation>();
  const [executionError, setExecutionError] = useState<string>();
  const [ready, setReady] = useState(false);
  const session = useRef<NativeIntakeSession | undefined>(undefined);
  const operation = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const busyRef = useRef(true);
  const cancelling = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++generation.current;
    const current = () =>
      !controller.signal.aborted &&
      epoch === generation.current &&
      isClientLifetimeCurrent(lifetime);
    void (async () => {
      try {
        const connected = await openNativeIntake(
          lifetime,
          controller.signal,
          undefined,
          undefined,
          undefined,
          {
            continuationSessionId,
            projectId,
          }
        );
        if (!current()) {
          connected.dispose();
          return;
        }
        session.current = connected;
        const saved = (await connected.list()).filter(
          (record) => record.command.continuation?.sessionId === continuationSessionId
        );
        if (!current()) return;
        setRecords(saved);
        setReady(true);
        // Reopening only inspects. It never resubmits or resumes a saved input.
        if (saved.length > 0) {
          const latest = [...saved].sort((a, b) => b.createdAt - a.createdAt)[0];
          setSelected(latest);
          setBusy("Inspecting");
          const read = new AbortController();
          operation.current = read;
          await Promise.all([
            connected.inspect(latest, read.signal).then(
              (found) => {
                if (current()) setResult(found);
              },
              (cause: unknown) => {
                if (current()) setError(formatError(cause));
              }
            ),
            connected.turn.inspect(latest, read.signal).then(
              (found) => {
                if (current()) setTurn(found);
              },
              (cause: unknown) => {
                if (current()) setTurnError(formatError(cause));
              }
            ),
            connected.execution.inspect(latest, read.signal).then(
              (found) => {
                if (current()) setExecution(found);
              },
              (cause: unknown) => {
                if (current()) setExecutionError(formatError(cause));
              }
            ),
          ]);
        }
      } catch (cause) {
        if (current()) setError(formatError(cause));
      } finally {
        if (current()) {
          busyRef.current = false;
          setBusy("");
        }
      }
    })();
    return () => {
      controller.abort();
      operation.current?.abort();
      session.current?.dispose();
      session.current = undefined;
    };
  }, [lifetime, continuationSessionId, projectId]);

  const run = async (
    label: string,
    action: (
      connected: NativeIntakeSession,
      signal: AbortSignal,
      current: () => boolean
    ) => Promise<void>,
    cancel = false
  ) => {
    if (!session.current || (busyRef.current && (!cancel || cancelling.current))) return;
    busyRef.current = true;
    cancelling.current = cancel;
    const epoch = ++generation.current;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const current = () =>
      epoch === generation.current &&
      !controller.signal.aborted &&
      isClientLifetimeCurrent(lifetime);
    setBusy(label);
    setError(undefined);
    try {
      await action(session.current, controller.signal, current);
    } catch (cause) {
      if (current()) {
        setError(
          `${formatError(cause)} The outcome may be unknown. Inspect the saved input before retrying.`
        );
      }
    } finally {
      if (current()) {
        busyRef.current = false;
        cancelling.current = false;
        setBusy("");
      }
    }
  };
  const observeExecution = async (
    connected: NativeIntakeSession,
    record: NativeIntakeBrowserRecord,
    method: "inspect" | "request" | "resume" | "cancel",
    signal: AbortSignal,
    current: () => boolean
  ) => {
    if (!current()) return;
    setExecutionError(undefined);
    try {
      const found = await connected.execution[method](record, signal);
      if (current()) setExecution(found);
    } catch (cause) {
      if (current())
        setExecutionError(
          `${formatError(cause)} Execution outcome is unconfirmed. Inspect execution to read the host's current state.`
        );
    }
  };
  const observeTurn = async (
    connected: NativeIntakeSession,
    record: NativeIntakeBrowserRecord,
    method: "inspect" | "request" | "cancel",
    signal: AbortSignal,
    current: () => boolean
  ) => {
    if (!current()) return;
    setTurnError(undefined);
    try {
      const found = await connected.turn[method](record, signal);
      if (current()) setTurn(found);
    } catch (cause) {
      if (current())
        setTurnError(
          `${formatError(cause)} Conversation delivery is unconfirmed. Inspect conversation to read the host's current state. No automatic retry was sent.`
        );
    }
  };
  const continueWork = async (
    connected: NativeIntakeSession,
    record: NativeIntakeBrowserRecord,
    found: NativeIntakeResult,
    signal: AbortSignal,
    current: () => boolean
  ) => {
    if (!current()) return;
    // Admission is already durable. Never erase its receipt if execution fails.
    setResult(found);
    if (found.kind === "work") {
      setBusy("Requesting execution");
      await observeExecution(connected, record, "request", signal, current);
    } else if (found.kind === "turn") {
      setBusy("Requesting conversation");
      await observeTurn(connected, record, "request", signal, current);
    }
  };
  const inspect = (record: NativeIntakeBrowserRecord) => {
    if (busyRef.current) return;
    if (record.command.inputId !== selected?.command.inputId) {
      setResult(undefined);
      setTurn(undefined);
      setTurnError(undefined);
      setExecution(undefined);
      setExecutionError(undefined);
    }
    setSelected(record);
    void run("Inspecting", async (connected, signal, current) => {
      // Independent reads keep durable execution controls reachable when intake
      // lookup is unavailable or its older source scope has become stale.
      await Promise.all([
        connected.inspect(record, signal).then(
          (found) => {
            if (current()) setResult(found);
          },
          (cause: unknown) => {
            if (current()) setError(formatError(cause));
          }
        ),
        observeExecution(connected, record, "inspect", signal, current),
        observeTurn(connected, record, "inspect", signal, current),
      ]);
    });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      closed ||
      !text.trim() ||
      text.length > 20_000 ||
      sources.some((source) => !source.label.trim() || source.label.length > 200) ||
      busyRef.current
    )
      return;
    void run("Submitting", async (connected, signal, current) => {
      let original: NativeIntakeBrowserRecord | undefined;
      const found = await connected.submit(
        { text, unsupportedSources: sources },
        (record) => {
          original = record;
          if (!current()) return;
          setSelected(record);
          setResult(undefined);
          setTurn(undefined);
          setTurnError(undefined);
          setExecution(undefined);
          setExecutionError(undefined);
          setRecords((saved) => [...saved, record]);
          setText("");
          setSources([]);
        },
        signal
      );
      if (original) await continueWork(connected, original, found, signal, current);
    });
  };
  const executionAction = (method: "inspect" | "request" | "resume" | "cancel") => {
    if (!selected || (closed && method !== "inspect" && method !== "cancel")) return;
    const labels = {
      inspect: "Inspecting execution",
      request: "Continuing execution request",
      resume: "Resuming execution",
      cancel: "Cancelling execution",
    };
    void run(
      labels[method],
      (connected, signal, current) =>
        observeExecution(connected, selected, method, signal, current),
      method === "cancel"
    );
  };
  const turnAction = (method: "inspect" | "request" | "cancel") => {
    if (!selected || (closed && method !== "inspect" && method !== "cancel")) return;
    const labels = {
      inspect: "Inspecting conversation",
      request: "Continuing conversation request",
      cancel: "Cancelling conversation",
    };
    void run(
      labels[method],
      (connected, signal, current) => observeTurn(connected, selected, method, signal, current),
      method === "cancel"
    );
  };
  const newRequest = () => {
    // Detach only. The saved immutable input and host execution are untouched.
    ++generation.current;
    operation.current?.abort();
    operation.current = undefined;
    busyRef.current = false;
    cancelling.current = false;
    setBusy("");
    setSelected(undefined);
    setResult(undefined);
    setTurn(undefined);
    setTurnError(undefined);
    setExecution(undefined);
    setExecutionError(undefined);
    setError(undefined);
  };
  const terminal =
    result !== undefined &&
    ["work", "turn", "blocked", "refused", "cancelled"].includes(result.kind);
  const hasTurnTarget = turn !== undefined && turn.kind !== "not-requested";
  // A failed source lookup cannot establish that a hosted conversation exists.
  // Keep that error with intake until a real turn disposition/target owns it.
  const showTurn = result?.kind === "turn" || hasTurnTarget;
  const hasExecutionTarget = execution !== undefined && execution.kind !== "not-requested";
  const showExecution = result?.kind === "work" || hasExecutionTarget || Boolean(executionError);
  const canCancel = Boolean(
    selected &&
    !terminal &&
    !hasExecutionTarget &&
    !hasTurnTarget &&
    busy !== "Cancelling" &&
    busy !== "Cancelling execution" &&
    busy !== "Cancelling conversation" &&
    busy !== "Connecting"
  );

  return (
    <div className="work-form native-intake">
      <p>
        Submit complete original text for Jev to assess. If Jev admits work, Submit automatically
        requests native execution for that same work and attempt. If Jev routes a conversation turn,
        Submit automatically requests hosted delivery of that exact original input.
      </p>
      <p className="dv-muted">
        Original text and source markers are saved in this browser before sending. Closing this view
        does not cancel daemon intake, execution or hosted conversation delivery.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{busy}…</p>}
      {closed && <p role="status">Session closed: reopen to submit a continuation.</p>}
      {ready && !selected && !closed && (
        <form className="work-form" onSubmit={submit}>
          <Field
            label="Original request"
            help="Include all required context. Whitespace and repeated requirements are preserved exactly; maximum 20,000 UTF-16 characters."
          >
            <Textarea
              autoFocus
              rows={6}
              value={text}
              disabled={Boolean(busy)}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          {text.length > 20_000 && (
            <p role="alert">
              The request exceeds 20,000 characters. Nothing will be truncated or sent.
            </p>
          )}
          {sources.map((source, index) => (
            <div className="work-form__pair" key={index}>
              <Field label={`Source ${index + 1} type`}>
                <Select
                  value={source.kind}
                  disabled={Boolean(busy)}
                  options={[
                    { value: "context", label: "Missing context" },
                    { value: "file", label: "Unread file" },
                    { value: "image", label: "Unread image" },
                  ]}
                  onChange={(kind: NativeConversationIntakeUnsupportedSource["kind"]) =>
                    setSources((items) =>
                      items.map((item, i) => (i === index ? { ...item, kind } : item))
                    )
                  }
                />
              </Field>
              <Field
                label={`Source ${index + 1} label`}
                error={
                  source.label.length > 200
                    ? "Source labels must be at most 200 characters. Nothing will be truncated."
                    : undefined
                }
              >
                <Input
                  value={source.label}
                  disabled={Boolean(busy)}
                  onChange={(event) =>
                    setSources((items) =>
                      items.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item
                      )
                    )
                  }
                />
              </Field>
              <Button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setSources((items) => items.filter((_, i) => i !== index))}
              >
                Remove source {index + 1}
              </Button>
            </div>
          ))}
          <div className="work-form__actions">
            <Button
              type="button"
              disabled={Boolean(busy) || sources.length >= 100}
              onClick={() => setSources((items) => [...items, { kind: "context", label: "" }])}
            >
              Mark an unavailable source
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                Boolean(busy) ||
                !text.trim() ||
                text.length > 20_000 ||
                sources.some((source) => !source.label.trim() || source.label.length > 200)
              }
            >
              Submit
            </Button>
          </div>
        </form>
      )}
      {selected && (
        <>
          <DetailSection title="Original request">
            <pre className="native-intake__source">{selected.command.text}</pre>
            {selected.command.unsupportedSources.length > 0 && (
              <ul>
                {selected.command.unsupportedSources.map((source, index) => (
                  <li key={index}>
                    {source.kind}: {source.label}
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
          <Facts
            items={[
              { label: "Input", value: selected.command.inputId },
              { label: "Request", value: selected.command.requestId },
              ...(selected.command.continuation
                ? [
                    {
                      label: "Continuation session",
                      value: selected.command.continuation.sessionId,
                    },
                  ]
                : []),
              ...(result && result.kind !== "not-found" && result.sourceRef.continuation
                ? [
                    {
                      label: "Completed transcript revision",
                      value: result.sourceRef.continuation.revision,
                    },
                  ]
                : []),
              ...(result && result.kind !== "not-found"
                ? [{ label: "Source revision", value: result.sourceRef.sourceRevision }]
                : []),
            ]}
          />
          {result && <p role="status">{nativeIntakeDescription(result)}</p>}
          {result?.kind === "work" && (
            <DetailSection title="Admission receipt">
              <Facts
                items={[
                  { label: "Work", value: result.receipt.workId },
                  { label: "Attempt", value: result.receipt.attemptId },
                  { label: "Decision", value: result.receipt.source.admissionDecisionId },
                ]}
              />
              <ol>
                {result.receipt.criteria.map((criterion, index) => (
                  <li className="native-intake__source" key={index}>
                    {criterion}
                  </li>
                ))}
              </ol>
            </DetailSection>
          )}
          <div className="work-form__actions">
            <Button disabled={Boolean(busy)} onClick={() => inspect(selected)}>
              Inspect
            </Button>
            {(result?.kind === "not-found" || result?.kind === "captured") && (
              <Button
                disabled={Boolean(busy) || closed}
                onClick={() =>
                  void run("Retrying submission", async (connected, signal, current) =>
                    continueWork(
                      connected,
                      selected,
                      await connected.retry(selected, signal),
                      signal,
                      current
                    )
                  )
                }
              >
                Retry submission
              </Button>
            )}
            {result?.kind === "processing" && result.recovery === "required" && (
              <Button
                disabled={Boolean(busy) || closed}
                onClick={() =>
                  void run("Resuming", async (connected, signal, current) =>
                    continueWork(
                      connected,
                      selected,
                      await connected.resume(selected, signal),
                      signal,
                      current
                    )
                  )
                }
              >
                Resume
              </Button>
            )}
            {canCancel && (
              <Button
                onClick={() =>
                  void run(
                    "Cancelling",
                    async (connected, signal, current) => {
                      const found = await connected.cancel(selected, signal);
                      if (!current()) return;
                      setResult(found);
                      // A cancellation race may reveal admitted work. Read it;
                      // cancellation must never become a new execution request.
                      if (found.kind === "work")
                        await observeExecution(connected, selected, "inspect", signal, current);
                      else if (found.kind === "turn")
                        await observeTurn(connected, selected, "inspect", signal, current);
                    },
                    true
                  )
                }
              >
                Cancel intake
              </Button>
            )}
            <Button onClick={newRequest}>New request</Button>
          </div>
          {showExecution && (
            <NativeExecutionStatus
              observation={execution}
              error={executionError}
              busy={busy}
              onInspect={() => executionAction("inspect")}
              requestDisabled={closed}
              onRequest={() => executionAction("request")}
              onResume={() => executionAction("resume")}
              onCancel={() => executionAction("cancel")}
            />
          )}
          {showTurn && (
            <NativeTurnStatus
              observation={turn}
              error={turnError}
              busy={busy}
              onInspect={() => turnAction("inspect")}
              requestDisabled={closed}
              onRequest={() => turnAction("request")}
              onCancel={() => turnAction("cancel")}
              onOpenSession={
                onOpenSession
                  ? (sessionId) => {
                      if (isClientLifetimeCurrent(lifetime)) onOpenSession(sessionId);
                    }
                  : undefined
              }
            />
          )}
          {!terminal && (
            <p className="dv-muted">
              A separate new request keeps this original saved. It does not cancel daemon intake or
              execution for this original.
            </p>
          )}
        </>
      )}
      {records.length > 0 && (
        <DetailSection title="Saved requests">
          <ul className="native-intake__saved">
            {[...records]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((record) => (
                <li key={record.command.inputId}>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => inspect(record)}
                    aria-label={`Inspect input ${record.command.inputId}`}
                  >
                    {record.command.text.slice(0, 80)}
                    {record.command.text.length > 80 ? "…" : ""}
                  </Button>
                </li>
              ))}
          </ul>
        </DetailSection>
      )}
    </div>
  );
}
