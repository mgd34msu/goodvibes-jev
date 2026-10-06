import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  NativeIntakeResult,
  NativeIntakeSession,
  NativeIntakeSource,
} from "../../lib/native-intake";
import type { NativeIntakeBrowserRecord } from "../../lib/native-intake-journal";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import { getClientLifetime, invalidateClientLifetime } from "../../lib/client-lifetime";

const original = "  Keep every word.\nRepeat. Repeat.  ";
const record: NativeIntakeBrowserRecord = {
  binding: {
    endpoint: "http://localhost:3000",
    projectId: "project",
    principalId: "owner",
    transport: "direct",
  },
  command: {
    inputId: "input-original",
    requestId: "request-original",
    text: original,
    unsupportedSources: [],
  },
  createdAt: 1,
};
const common = {
  projectId: "project",
  requestId: record.command.requestId,
  sourceRef: {
    version: 1 as const,
    inputId: record.command.inputId,
    sourceId: "source",
    sourceRevision: "source-v1",
    sessionId: "session",
  },
};
const work: Extract<NativeIntakeResult, { kind: "work" }> = {
  kind: "work",
  ...common,
  receipt: {
    projectId: "project",
    requestId: common.requestId,
    inputId: common.sourceRef.inputId,
    ledgerRevision: 1,
    workId: "work-original",
    attemptId: "attempt-original",
    expectedRevision: { work: 1, criteria: 1, attempt: 1 },
    goal: original,
    criteria: ["  Keep every word.", "Repeat.", "Repeat."],
    source: {
      version: 2,
      sourceId: "source",
      sourceRevision: "source-v1",
      sessionId: "session",
      offsetEncoding: "utf16",
      proposalRevision: "proposal-v1",
      spans: [],
      admissionDecisionId: "admission-real",
      judgmentDecisionIds: ["judgment-real"],
    },
  },
};
const target = {
  workId: work.receipt.workId,
  attemptId: work.receipt.attemptId,
  expectedRevision: work.receipt.expectedRevision,
};
const running: NativeExecutionObservation = {
  kind: "recorded",
  target,
  snapshot: {
    ...target,
    projectId: "project",
    currentRevision: target.expectedRevision,
    currentAttempt: true,
    stale: false,
    kind: "execution",
    state: "launch-claimed",
    recovery: "available",
    receipt: { contractId: "contract-real", ownerAgentId: "owner-real" },
    progress: null,
  },
};
const prevented: NativeExecutionObservation = {
  kind: "recorded",
  target,
  snapshot: {
    ...target,
    projectId: "project",
    currentRevision: target.expectedRevision,
    currentAttempt: true,
    stale: false,
    kind: "prevented-before-admission",
    state: "cancelled",
    recovery: "cancelled",
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let session: NativeIntakeSession;
const open = mock(async () => session);
mock.module("../../lib/native-intake", () => ({
  openNativeIntake: open,
  nativeIntakeDescription: (result: NativeIntakeResult) => `Intake outcome: ${result.kind}`,
}));
const { NativeIntakeForm } = await import("./NativeIntakeForm");
const cleanups: (() => void)[] = [];
function fixture() {
  return {
    binding: record.binding,
    list: mock(async (): Promise<NativeIntakeBrowserRecord[]> => []),
    submit: mock(
      async (
        _source: NativeIntakeSource,
        saved: (original: NativeIntakeBrowserRecord) => void,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => {
        saved(record);
        return work;
      }
    ),
    inspect: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => work
    ),
    retry: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => work
    ),
    resume: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => work
    ),
    cancel: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => ({ kind: "cancelled", ...common })
    ),
    execution: {
      inspect: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => ({ kind: "not-found", target })
      ),
      request: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => running
      ),
      resume: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => running
      ),
      cancel: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => prevented
      ),
    },
    dispose: mock(() => {}),
  };
}
let connected: ReturnType<typeof fixture>;
beforeEach(() => {
  connected = fixture();
  session = connected;
  open.mockClear();
});
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
async function settle(check: () => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    flushSync(() => {});
    if (check()) return;
  }
  expect(check()).toBe(true);
}
async function render() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => root.render(<NativeIntakeForm lifetime={getClientLifetime()} />));
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    el.remove();
  };
  const rerender = () =>
    flushSync(() => root.render(<NativeIntakeForm lifetime={getClientLifetime()} />));
  cleanups.push(unmount);
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((item) => item.textContent === label);
  const click = (label: string) => {
    const item = button(label);
    expect(item).toBeDefined();
    flushSync(() => item!.click());
  };
  await settle(() => Boolean(button("Submit") || button("New request")));
  return { el, button, click, unmount, rerender };
}
function submit(el: HTMLElement) {
  const field = el.querySelector("textarea");
  expect(field).not.toBeNull();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      original
    );
    field!.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  flushSync(() =>
    el
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  );
}

describe("Native intake to execution lifecycle", () => {
  test("one Submit preserves exact original, renders admission immediately and requests execution once", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, button } = await render();
    submit(el);
    await settle(
      () =>
        connected.execution.request.mock.calls.length === 1 && Boolean(button("Cancel execution"))
    );
    expect(connected.submit.mock.calls[0]?.[0]).toEqual({ text: original, unsupportedSources: [] });
    expect(connected.execution.request.mock.calls[0]?.[0]).toBe(record);
    expect(el.textContent).toContain("admission-real");
    expect(el.textContent).not.toContain("contract-real");
    expect(button("Cancel execution")?.disabled).toBe(false);
    expect(button("New request")?.disabled).toBe(false);
    pending.resolve(running);
    await settle(() => el.textContent?.includes("contract-real") === true);
    expect(connected.execution.resume).not.toHaveBeenCalled();
    expect(connected.execution.request).toHaveBeenCalledTimes(1);
  });

  test("dispatch failure retains admission and explicit continuation; inspection does not dispatch", async () => {
    connected.execution.request.mockRejectedValue(
      new Error("Native execution requires write:fleet.")
    );
    const { el, click } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("requires write:fleet") === true);
    expect(el.textContent).toContain("admission-real");
    expect(el.textContent).toContain("Repeat.Repeat.");
    expect(el.querySelector("pre")?.textContent).toBe(original);
    click("Inspect execution");
    await settle(() => connected.execution.inspect.mock.calls.length === 1);
    expect(connected.execution.request).toHaveBeenCalledTimes(1);
    connected.execution.request.mockResolvedValue(running);
    await settle(() => el.textContent?.includes("latest lookup found no execution") === true);
    click("Continue request");
    await settle(() => el.textContent?.includes("contract-real") === true);
    expect(connected.execution.request).toHaveBeenCalledTimes(2);
  });

  test("reopen and saved-request inspection only read intake and execution", async () => {
    connected.list.mockResolvedValue([record]);
    const { el, click } = await render();
    await settle(() => el.textContent?.includes("latest lookup found no execution") === true);
    expect(connected.inspect).toHaveBeenCalledTimes(1);
    expect(connected.execution.inspect).toHaveBeenCalledTimes(1);
    click("Inspect");
    await settle(() => connected.execution.inspect.mock.calls.length === 2);
    expect(connected.submit).not.toHaveBeenCalled();
    expect(connected.retry).not.toHaveBeenCalled();
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(connected.execution.resume).not.toHaveBeenCalled();
  });

  test("retry submission and admission recovery continue work dispatch without an extra gate", async () => {
    for (const kind of ["captured", "processing"] as const) {
      connected = fixture();
      session = connected;
      connected.list.mockResolvedValue([record]);
      connected.inspect.mockResolvedValue(
        kind === "captured"
          ? { kind, ...common }
          : { kind, ...common, recovery: "required", stage: "waiting" }
      );
      connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
      const { el, button, click } = await render();
      const label = kind === "captured" ? "Retry submission" : "Resume";
      await settle(() => button(label)?.disabled === false);
      click(label);
      await settle(() => el.textContent?.includes("contract-real") === true);
      expect(connected.execution.request).toHaveBeenCalledTimes(1);
      expect(connected.execution.resume).not.toHaveBeenCalled();
    }
  });

  test("turn outcome never dispatches native execution", async () => {
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(record);
      return { kind: "turn", ...common, route: "answer", text: original };
    });
    const { el } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("Intake outcome: turn") === true);
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("Execution receipt");
  });

  test("cancel interrupts dispatch and a late start response cannot overwrite prevention", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, click, button } = await render();
    submit(el);
    await settle(() => button("Cancel execution")?.disabled === false);
    const oldSignal = connected.execution.request.mock.calls[0]?.[1];
    click("Cancel execution");
    await settle(() => el.textContent?.includes("prevented before admission") === true);
    expect(oldSignal?.aborted).toBe(true);
    expect(connected.execution.cancel).toHaveBeenCalledTimes(1);
    pending.resolve(running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(el.textContent).toContain("prevented before admission");
    expect(el.textContent).not.toContain("contract-real");
    expect(el.textContent).toContain("admission-real");
  });

  test("New request detaches a pending execution without cancelling it or adopting its late response", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, click, button } = await render();
    submit(el);
    await settle(() => connected.execution.request.mock.calls.length === 1);
    const oldSignal = connected.execution.request.mock.calls[0]?.[1];
    click("New request");
    expect(oldSignal?.aborted).toBe(true);
    expect(button("Submit")).toBeDefined();
    pending.resolve(running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(button("Submit")).toBeDefined();
    expect(el.textContent).not.toContain("contract-real");
    expect(el.textContent).toContain("Saved requests");
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
  });

  test("a durable execution target stays inspectable and cancellable after intake lookup fails", async () => {
    connected.list.mockResolvedValue([record]);
    connected.inspect.mockRejectedValue(new Error("Original intake scope is stale."));
    connected.execution.inspect.mockResolvedValue(running);
    const { el, button, click } = await render();
    await settle(
      () =>
        el.textContent?.includes("contract-real") === true &&
        button("Inspect execution")?.disabled === false
    );
    expect(el.textContent).toContain("Original intake scope is stale");
    expect(button("Cancel execution")).toBeDefined();
    click("Inspect execution");
    await settle(() => connected.execution.inspect.mock.calls.length === 2);
    expect(connected.execution.request).not.toHaveBeenCalled();
  });
  test("cancellation supersedes a pending execution inspection or explicit resume", async () => {
    for (const method of ["inspect", "resume"] as const) {
      connected = fixture();
      session = connected;
      connected.list.mockResolvedValue([record]);
      connected.execution.inspect.mockResolvedValue({
        kind: "recorded",
        target,
        snapshot: {
          ...target,
          projectId: "project",
          currentRevision: target.expectedRevision,
          currentAttempt: true,
          stale: false,
          kind: "pending-intent",
          state: "admitting",
          recovery: "required",
        },
      });
      const { el, button, click } = await render();
      await settle(() => button("Resume execution")?.disabled === false);
      const pending = deferred<NativeExecutionObservation>();
      connected.execution[method].mockImplementation(() => pending.promise);
      click(method === "inspect" ? "Inspect execution" : "Resume execution");
      const oldSignal = connected.execution[method].mock.calls.at(-1)?.[1];
      click("Cancel execution");
      await settle(() => el.textContent?.includes("prevented before admission") === true);
      expect(oldSignal?.aborted).toBe(true);
      pending.resolve(running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      flushSync(() => {});
      expect(el.textContent).not.toContain("contract-real");
      expect(el.textContent).toContain("prevented before admission");
    }
  });

  test("closing detaches and disposes without host cancellation", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, unmount } = await render();
    submit(el);
    await settle(() => connected.execution.request.mock.calls.length === 1);
    const oldSignal = connected.execution.request.mock.calls[0]?.[1];
    unmount();
    expect(oldSignal?.aborted).toBe(true);
    expect(connected.dispose).toHaveBeenCalledTimes(1);
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
    pending.resolve(running);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("connection replacement clears prior source and receipts and fences a late result", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const old = connected;
    const { el, button, rerender } = await render();
    submit(el);
    await settle(() => old.execution.request.mock.calls.length === 1);
    expect(el.textContent).toContain("admission-real");
    connected = fixture();
    session = connected;
    invalidateClientLifetime();
    rerender();
    await settle(() => button("Submit")?.disabled === true);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(old.execution.request.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(el.textContent).not.toContain("admission-real");
    expect(el.textContent).not.toContain("Saved requests");
    pending.resolve(running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(el.textContent).not.toContain("contract-real");
    expect(connected.execution.request).not.toHaveBeenCalled();
  });
  test("cancellation can interrupt the read-only reopening status lookup", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.list.mockResolvedValue([record]);
    connected.execution.inspect.mockImplementation(() => pending.promise);
    const { el, button, click } = await render();
    await settle(() => button("Cancel execution")?.disabled === false);
    const oldSignal = connected.execution.inspect.mock.calls[0]?.[1];
    click("Cancel execution");
    await settle(() => el.textContent?.includes("prevented before admission") === true);
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(el.textContent).not.toContain("contract-real");
    expect(connected.execution.request).not.toHaveBeenCalled();
  });
});
