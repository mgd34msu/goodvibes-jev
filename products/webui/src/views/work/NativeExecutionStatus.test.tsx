import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  NativeWorkExecutionIdentity,
  NativeWorkExecutionSnapshot,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import { NativeExecutionStatus } from "./NativeExecutionStatus";

const target: NativeWorkExecutionIdentity = {
  workId: "work-original",
  attemptId: "attempt-original",
  expectedRevision: { work: 3, criteria: 2, attempt: 1 },
};
const base = {
  ...target,
  projectId: "project",
  currentRevision: target.expectedRevision,
  currentAttempt: true,
  stale: false,
};
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function render(observation?: NativeExecutionObservation, busy = "") {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const clicked: string[] = [];
  flushSync(() =>
    root.render(
      <NativeExecutionStatus
        observation={observation}
        busy={busy}
        onInspect={() => clicked.push("inspect")}
        onRequest={() => clicked.push("request")}
        onResume={() => clicked.push("resume")}
        onCancel={() => clicked.push("cancel")}
      />
    )
  );
  cleanups.push(() => {
    flushSync(() => root.unmount());
    el.remove();
  });
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((item) => item.textContent === label);
  return { el, button, clicked };
}
function recorded(snapshot: NativeWorkExecutionSnapshot): NativeExecutionObservation {
  return { kind: "recorded", target, snapshot };
}
const execution = (
  overrides: Partial<Extract<NativeWorkExecutionSnapshot, { kind: "execution" }>> = {}
): NativeWorkExecutionSnapshot => ({
  kind: "execution",
  ...base,
  state: "launch-claimed",
  recovery: "available",
  receipt: { contractId: "real-contract", ownerAgentId: "real-owner" },
  progress: {
    status: "running",
    sessionMode: true,
    semanticState: "deciding",
    stage: "check-plan",
    retrying: true,
    units: { total: 3, passed: 1, failed: 0 },
    criteria: { total: 4, met: 1, unmet: 1, unshown: 2 },
  },
  ...overrides,
});

describe("Native execution projection and controls", () => {
  test("unknown and absent associations permit explicit continuation without claiming a launch", () => {
    for (const observation of [
      undefined,
      { kind: "not-requested" } as const,
      { kind: "not-found", target } as const,
    ]) {
      const { el, button } = render(observation);
      expect(button("Continue request")).toBeDefined();
      expect(button("Inspect execution")).toBeDefined();
      expect(button("Resume execution")).toBeUndefined();
      expect(el.textContent).not.toContain("Execution receipt");
    }
  });

  test("pending intent has no receipt or runtime projection and is inspection-only until recovery is required", () => {
    const pending = {
      kind: "pending-intent",
      ...base,
      state: "admitting",
      recovery: "pending",
    } as const;
    const { el, button } = render(recorded(pending));
    expect(el.textContent).toContain("Execution admission is pending");
    expect(el.textContent).not.toContain("Execution receipt");
    expect(el.textContent).not.toContain("Execution progress");
    expect(el.textContent).not.toContain("Ledger settlement");
    expect(button("Continue request")).toBeUndefined();
    expect(button("Resume execution")).toBeUndefined();
    expect(
      render(recorded({ ...pending, recovery: "required" })).button("Resume execution")
    ).toBeDefined();
    expect(
      render(recorded({ ...pending, state: "refused", recovery: "required" })).el.textContent
    ).toContain("Jev refused execution admission");
    expect(
      render(recorded({ ...pending, stale: true, recovery: "required" })).button("Resume execution")
    ).toBeUndefined();
    expect(
      render(recorded({ ...pending, currentAttempt: false, recovery: "required" })).button(
        "Resume execution"
      )
    ).toBeUndefined();
  });

  test("prevention is final for this attempt without inventing an execution receipt", () => {
    const { el, button } = render(
      recorded({
        kind: "prevented-before-admission",
        ...base,
        state: "cancelled",
        recovery: "cancelled",
      })
    );
    expect(el.textContent).toContain("prevented before admission");
    expect(el.textContent).not.toContain("Execution receipt");
    expect(button("Cancel execution")).toBeUndefined();
    expect(button("Resume execution")).toBeUndefined();
    expect(button("Continue request")).toBeUndefined();
  });

  test("real execution displays exact receipts, both revisions, semantic retry and bounded progress", () => {
    const { el } = render(
      recorded(
        execution({
          stale: true,
          currentAttempt: false,
          currentRevision: { work: 9, criteria: 8, attempt: 7 },
        })
      )
    );
    for (const text of [
      "real-contract",
      "real-owner",
      "Work 3, criteria 2, attempt 1",
      "Work 9, criteria 8, attempt 7",
      "check-plan",
      "deciding",
      "Waiting on shared transport retry",
      "1 passed, 0 failed, 3 total",
      "1 met, 1 unmet, 2 unshown, 4 total",
      "do not establish ledger verification",
      "The ledger target changed",
    ])
      expect(el.textContent).toContain(text);
  });

  test("prepared available or required recovery can explicitly resume; launch-claimed and terminal outcomes cannot restart", () => {
    for (const recovery of ["available", "required"] as const) {
      const prepared = execution({ state: "prepared", recovery, receipt: null, progress: null });
      const { el, button, clicked } = render(recorded(prepared));
      expect(button("Resume execution")).toBeDefined();
      expect(el.textContent).toContain("Prepared execution is available for explicit recovery");
      expect(el.textContent).not.toContain("Execution receipt");
      button("Resume execution")?.click();
      expect(clicked).toEqual(["resume"]);
      expect(
        render(recorded({ ...prepared, stale: true })).button("Resume execution")
      ).toBeUndefined();
      expect(
        render(recorded({ ...prepared, currentAttempt: false })).button("Resume execution")
      ).toBeUndefined();
      expect(
        render(recorded(execution({ state: "launch-claimed", recovery }))).button(
          "Resume execution"
        )
      ).toBeUndefined();
    }
    const claimed = render(recorded(execution({ recovery: "required" })));
    expect(claimed.el.textContent).toContain("cannot restart its effects");
    for (const recovery of ["terminal", "cancelled"] as const) {
      expect(
        render(recorded(execution({ state: "prepared", recovery, progress: null }))).button(
          "Resume execution"
        )
      ).toBeUndefined();
    }
    expect(
      render(recorded(execution({ state: "cancelled", recovery: "available" }))).button(
        "Resume execution"
      )
    ).toBeUndefined();
  });

  test("passed runner verification and published reconciliation remain distinct from verified completion", () => {
    const progress = {
      status: "passed",
      sessionMode: false,
      semanticState: null,
      stage: null,
      retrying: false,
      units: { total: 1, passed: 1, failed: 0 },
      criteria: { total: 1, met: 1, unmet: 0, unshown: 0 },
    } as const;
    for (const state of ["pending", "failed", "required"] as const) {
      const { el, button } = render(
        recorded(execution({ progress, recovery: "terminal", settlement: { state } }))
      );
      expect(button("Verify and publish")).toBeDefined();
      expect(button("Resume execution")).toBeUndefined();
      expect(el.textContent).toContain("runner passed");
      expect(el.textContent).toContain("does not establish verified ledger completion");
    }
    const published = render(
      recorded(
        execution({
          progress,
          recovery: "terminal",
          stale: true,
          currentAttempt: false,
          settlement: {
            state: "published",
            evidenceId: "evidence-real",
            reportSequence: 12,
            evidenceSequence: 13,
          },
        })
      )
    );
    expect(published.button("Reconcile publication")).toBeDefined();
    expect(published.button("Verify and publish")).toBeUndefined();
    expect(published.el.textContent).toContain("evidence-real");
    expect(published.el.textContent).toContain(
      "does not say that the evidence passed verification"
    );
    const cancelled = render(
      recorded(
        execution({
          progress,
          state: "cancelled",
          recovery: "cancelled",
          settlement: { state: "published" },
        })
      )
    );
    expect(cancelled.button("Reconcile publication")).toBeUndefined();
    expect(cancelled.button("Cancel execution")).toBeUndefined();
    expect(cancelled.el.textContent).toContain("real-contract");
  });

  test("cancel can interrupt request, status and resume, but cannot duplicate cancellation", () => {
    for (const busy of ["Requesting execution", "Inspecting execution", "Resuming execution"]) {
      const { button, clicked } = render(recorded(execution()), busy);
      expect(button("Inspect execution")?.disabled).toBe(true);
      expect(button("Cancel execution")?.disabled).toBe(false);
      flushSync(() => button("Cancel execution")?.click());
      expect(clicked).toEqual(["cancel"]);
    }
    expect(render(undefined, "Cancelling execution").button("Cancel execution")?.disabled).toBe(
      true
    );
  });
});
