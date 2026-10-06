import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { NativeHostedTurnSnapshot } from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import type { NativeTurnObservation } from "../../lib/native-turn";
import { NativeTurnStatus } from "./NativeTurnStatus";

const target = {
  projectId: "project",
  inputId: "input-original",
  sourceRevision: "source-original-v1",
};
const snapshot: NativeHostedTurnSnapshot = {
  ...target,
  requestId: "request-original",
  state: "running",
  sessionId: "hosted-session-real",
  brokerInputId: "broker-input-real",
  correlationId: "correlation-real",
};
const recorded = (overrides: Partial<NativeHostedTurnSnapshot> = {}): NativeTurnObservation => ({
  kind: "recorded",
  target,
  snapshot: { ...snapshot, ...overrides },
});
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function render(
  observation?: NativeTurnObservation,
  options: { busy?: string; error?: string; canOpen?: boolean } = {}
) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const clicked: string[] = [];
  const opened: string[] = [];
  flushSync(() =>
    root.render(
      <NativeTurnStatus
        observation={observation}
        error={options.error}
        busy={options.busy ?? ""}
        onInspect={() => clicked.push("inspect")}
        onRequest={() => clicked.push("request")}
        onCancel={() => clicked.push("cancel")}
        onOpenSession={options.canOpen ? (id) => opened.push(id) : undefined}
      />
    )
  );
  cleanups.push(() => {
    flushSync(() => root.unmount());
    el.remove();
  });
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((item) => item.textContent === label);
  return { el, button, clicked, opened };
}

describe("Native hosted conversation projection and controls", () => {
  test("unknown and absent delivery can explicitly inspect, continue or cancel without inventing a receipt", () => {
    for (const observation of [undefined, { kind: "not-found", target } as const]) {
      const { el, button, clicked, opened } = render(observation, { canOpen: true });
      expect(button("Inspect conversation")?.disabled).toBe(false);
      expect(button("Continue conversation request")?.disabled).toBe(false);
      expect(button("Cancel conversation")?.disabled).toBe(false);
      expect(button("Open hosted session")).toBeUndefined();
      expect(el.textContent).not.toContain("hosted-session-real");
      expect(el.textContent).not.toContain("broker-input-real");
      expect(clicked).toEqual([]);
      expect(opened).toEqual([]);
      flushSync(() => button("Inspect conversation")?.click());
      flushSync(() => button("Continue conversation request")?.click());
      flushSync(() => button("Cancel conversation")?.click());
      expect(clicked).toEqual(["inspect", "request", "cancel"]);
    }
  });

  test("a non-turn observation exposes only read-only inspection", () => {
    const { el, button } = render({ kind: "not-requested" }, { canOpen: true });
    expect(button("Inspect conversation")).toBeDefined();
    expect(button("Continue conversation request")).toBeUndefined();
    expect(button("Cancel conversation")).toBeUndefined();
    expect(button("Open hosted session")).toBeUndefined();
    expect(el.textContent).not.toContain("hosted-session-real");
  });

  test("preparing, running, cancelling and recovery-required observations remain cancellable but cannot replay delivery", () => {
    for (const state of ["preparing", "running", "cancelling", "recovery-required"] as const) {
      const { el, button, clicked } = render(recorded({ state }));
      expect(el.textContent).toContain(state);
      expect(button("Inspect conversation")?.disabled).toBe(false);
      expect(button("Cancel conversation")?.disabled).toBe(false);
      expect(button("Continue conversation request")).toBeUndefined();
      expect(button("Start conversation")).toBeUndefined();
      expect(button("Resume conversation")).toBeUndefined();
      expect(button("Approve")).toBeUndefined();
      expect(clicked).toEqual([]);
      flushSync(() => button("Cancel conversation")?.click());
      expect(clicked).toEqual(["cancel"]);
    }
  });

  test("completed and cancelled observations retain real identities and never expose replay or cancellation", () => {
    for (const state of ["completed", "cancelled"] as const) {
      const { el, button } = render(recorded({ state }), { canOpen: true });
      for (const value of [
        state,
        target.sourceRevision,
        "hosted-session-real",
        "broker-input-real",
        "correlation-real",
      ])
        expect(el.textContent).toContain(value);
      expect(button("Inspect conversation")?.disabled).toBe(false);
      expect(button("Open hosted session")?.disabled).toBe(false);
      expect(button("Continue conversation request")).toBeUndefined();
      expect(button("Cancel conversation")).toBeUndefined();
    }
  });

  test("only a recorded hosted session and a navigation callback can open that exact session", () => {
    const { button, clicked, opened } = render(recorded(), { canOpen: true });
    expect(opened).toEqual([]);
    flushSync(() => button("Open hosted session")?.click());
    expect(opened).toEqual(["hosted-session-real"]);
    expect(clicked).toEqual([]);
    expect(render(recorded()).button("Open hosted session")).toBeUndefined();
    const absent = render(recorded({ sessionId: null, brokerInputId: null, correlationId: null }), {
      canOpen: true,
    });
    expect(absent.button("Open hosted session")).toBeUndefined();
    expect(absent.el.textContent).not.toContain("hosted-session-real");
    expect(absent.el.textContent).not.toContain("broker-input-real");
    expect(absent.el.textContent).not.toContain("correlation-real");
    expect(absent.el.textContent).toContain("Not recorded");
  });

  test("unknown failures preserve inspect and cancel while failed inspections retain the last observed identity", () => {
    const unknown = render(undefined, { error: "Delivery acknowledgement was lost." });
    expect(unknown.el.querySelector('[role="alert"]')?.textContent).toBe(
      "Delivery acknowledgement was lost."
    );
    expect(unknown.button("Inspect conversation")?.disabled).toBe(false);
    expect(unknown.button("Cancel conversation")?.disabled).toBe(false);
    const known = render(recorded(), { error: "The latest status lookup failed.", canOpen: true });
    expect(known.el.textContent).toContain("The latest status lookup failed.");
    expect(known.el.textContent).toContain("last successful observation");
    expect(known.el.textContent).toContain("hosted-session-real");
    expect(known.button("Continue conversation request")).toBeUndefined();
    expect(known.button("Open hosted session")).toBeDefined();
    expect(known.clicked).toEqual([]);
  });

  test("cancellation interrupts pending request or inspection but cannot repeat or race connection setup", () => {
    for (const busy of ["Requesting conversation", "Inspecting conversation", "Inspecting"]) {
      const { button, clicked } = render(undefined, { busy });
      expect(button("Inspect conversation")?.disabled).toBe(true);
      expect(button("Continue conversation request")?.disabled).toBe(true);
      expect(button("Cancel conversation")?.disabled).toBe(false);
      flushSync(() => button("Cancel conversation")?.click());
      expect(clicked).toEqual(["cancel"]);
    }
    for (const busy of ["Cancelling conversation", "Connecting", "Cancelling"]) {
      const { button, clicked } = render(undefined, { busy });
      expect(button("Cancel conversation")?.disabled).toBe(true);
      flushSync(() => button("Cancel conversation")?.click());
      expect(clicked).toEqual([]);
    }
  });
});

test("cancelling reports the owned-work drain without claiming terminal cancellation or completion", () => {
  const pending = render(recorded({ state: "cancelling" }), { canOpen: true });
  const waiting = pending.el.querySelector('[role="status"]')?.textContent;
  expect(waiting).toContain("cancelling the original turn");
  expect(waiting).toContain("waiting for its owned work to stop");
  expect(waiting).not.toContain("is cancelled");
  expect(waiting).not.toContain("completion");
  expect(pending.button("Continue conversation request")).toBeUndefined();
  expect(pending.button("Start conversation")).toBeUndefined();
  expect(pending.button("Resume conversation")).toBeUndefined();
  expect(pending.button("Inspect conversation")?.disabled).toBe(false);
  expect(pending.button("Open hosted session")?.disabled).toBe(false);
  expect(pending.clicked).toEqual([]);
  const terminal = render(recorded({ state: "cancelled" }));
  expect(terminal.el.querySelector('[role="status"]')?.textContent).toContain("is cancelled");
  expect(terminal.el.textContent).toContain("Effects already performed are not undone");
  expect(terminal.button("Cancel conversation")).toBeUndefined();
  expect(terminal.button("Continue conversation request")).toBeUndefined();
});
