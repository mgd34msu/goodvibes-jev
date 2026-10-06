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
import { Button } from "../../components/ui/Button";
import { Field, Input, Textarea } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { Facts, DetailSection } from "../../components/data-view/DataView";

/** Original source admission only. This view never creates a legacy task or turn. */
export function NativeIntakeForm({ lifetime }: { lifetime: ClientLifetime }) {
  const [text, setText] = useState("");
  const [sources, setSources] = useState<NativeConversationIntakeUnsupportedSource[]>([]);
  const [records, setRecords] = useState<NativeIntakeBrowserRecord[]>([]);
  const [selected, setSelected] = useState<NativeIntakeBrowserRecord>();
  const [result, setResult] = useState<NativeIntakeResult>();
  const [busy, setBusy] = useState<string>("Connecting");
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const session = useRef<NativeIntakeSession | undefined>(undefined);
  const operation = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const busyRef = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++generation.current;
    const current = () =>
      !controller.signal.aborted &&
      epoch === generation.current &&
      isClientLifetimeCurrent(lifetime);
    void (async () => {
      try {
        const connected = await openNativeIntake(lifetime, controller.signal);
        if (!current()) {
          connected.dispose();
          return;
        }
        session.current = connected;
        const saved = await connected.list();
        if (!current()) return;
        setRecords(saved);
        setReady(true);
        // Reopening only inspects. It never resubmits or resumes a saved input.
        if (saved.length > 0) {
          const latest = [...saved].sort((a, b) => b.createdAt - a.createdAt)[0];
          setSelected(latest);
          const found = await connected.inspect(latest, controller.signal);
          if (current()) setResult(found);
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
  }, [lifetime]);

  const run = async (
    label: string,
    action: (
      connected: NativeIntakeSession,
      signal: AbortSignal,
      current: () => boolean
    ) => Promise<NativeIntakeResult>,
    cancel = false
  ) => {
    if (!session.current || (busyRef.current && !cancel)) return;
    busyRef.current = true;
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
      const found = await action(session.current, controller.signal, current);
      if (current()) setResult(found);
    } catch (cause) {
      if (current()) {
        setResult(undefined);
        setError(
          `${formatError(cause)} The outcome may be unknown. Inspect the saved input before retrying.`
        );
      }
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy("");
      }
    }
  };
  const inspect = (record: NativeIntakeBrowserRecord) => {
    if (busyRef.current) return;
    setSelected(record);
    setResult(undefined);
    void run("Inspecting", (connected, signal) => connected.inspect(record, signal));
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !text.trim() ||
      text.length > 20_000 ||
      sources.some((source) => !source.label.trim() || source.label.length > 200) ||
      busyRef.current
    )
      return;
    void run("Submitting", (connected, signal, current) =>
      connected.submit(
        { text, unsupportedSources: sources },
        (record) => {
          if (!current()) return;
          setSelected(record);
          setResult(undefined);
          setRecords((saved) => [...saved, record]);
          setText("");
          setSources([]);
        },
        signal
      )
    );
  };
  const terminal =
    result !== undefined &&
    ["work", "turn", "blocked", "refused", "cancelled"].includes(result.kind);
  const canCancel = Boolean(
    selected && !terminal && busy !== "Cancelling" && busy !== "Connecting"
  );

  return (
    <div className="work-form native-intake">
      <p>
        Submit complete original text for Jev to assess. This screen records admission; it does not
        launch execution or deliver a conversation turn.
      </p>
      <p className="dv-muted">
        Original text and source markers are saved in this browser before sending. Closing this view
        does not cancel daemon intake.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{busy}…</p>}
      {ready && !selected && (
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
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("Retrying submission", (connected, signal) =>
                    connected.retry(selected, signal)
                  )
                }
              >
                Retry submission
              </Button>
            )}
            {result?.kind === "processing" && result.recovery === "required" && (
              <Button
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("Resuming", (connected, signal) => connected.resume(selected, signal))
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
                    (connected, signal) => connected.cancel(selected, signal),
                    true
                  )
                }
              >
                Cancel intake
              </Button>
            )}
            {(terminal || result?.kind === "not-found") && (
              <Button
                disabled={Boolean(busy)}
                onClick={() => {
                  setSelected(undefined);
                  setResult(undefined);
                  setError(undefined);
                }}
              >
                New request
              </Button>
            )}
          </div>
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
