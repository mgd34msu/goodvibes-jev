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
import type { NativeTurnObservation } from "../../lib/native-turn";
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
const turn: Extract<NativeIntakeResult, { kind: "turn" }> = {
  kind: "turn",
  ...common,
  route: "answer",
  text: original,
};
const turnTarget = {
  projectId: common.projectId,
  inputId: common.sourceRef.inputId,
  sourceRevision: common.sourceRef.sourceRevision,
};
const turnRunning: NativeTurnObservation = {
  kind: "recorded",
  target: turnTarget,
  snapshot: {
    ...turnTarget,
    requestId: common.requestId,
    state: "running",
    sessionId: "hosted-session-real",
    brokerInputId: "broker-input-real",
    correlationId: "correlation-real",
  },
};
const turnCancelled: NativeTurnObservation = {
  ...turnRunning,
  snapshot: { ...turnRunning.snapshot, state: "cancelled" },
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
    turn: {
      inspect: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeTurnObservation> => ({ kind: "not-requested" })
      ),
      request: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeTurnObservation> => turnRunning
      ),
      cancel: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeTurnObservation> => turnCancelled
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
async function render(onOpenSession?: (sessionId: string) => void) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() =>
    root.render(<NativeIntakeForm lifetime={getClientLifetime()} onOpenSession={onOpenSession} />)
  );
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    el.remove();
  };
  const rerender = () =>
    flushSync(() =>
      root.render(<NativeIntakeForm lifetime={getClientLifetime()} onOpenSession={onOpenSession} />)
    );
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
    expect(connected.turn.request).not.toHaveBeenCalled();
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
      return turn;
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

describe("Native intake to hosted conversation lifecycle", () => {
  beforeEach(() => {
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(record);
      return turn;
    });
  });

  test("one Submit requests the exact turn once and exposes cancellation before acknowledgement", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.turn.request.mockImplementation(() => pending.promise);
    const { el, button, rerender } = await render();
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 1);
    expect(connected.submit.mock.calls[0]?.[0]).toEqual({ text: original, unsupportedSources: [] });
    expect(connected.turn.request.mock.calls[0]?.[0]).toBe(record);
    expect(el.querySelector("pre")?.textContent).toBe(original);
    expect(el.textContent).toContain("Intake outcome: turn");
    expect(button("Cancel conversation")?.disabled).toBe(false);
    expect(button("New request")?.disabled).toBe(false);
    expect(button("Start conversation")).toBeUndefined();
    expect(button("Approve")).toBeUndefined();
    pending.resolve(turnRunning);
    await settle(() => el.textContent?.includes("hosted-session-real") === true);
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect).not.toHaveBeenCalled();
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(connected.execution.resume).not.toHaveBeenCalled();
    expect(button("Continue conversation request")).toBeUndefined();
  });

  test("reopen and both inspection buttons only read the saved input and hosted turn", async () => {
    connected.list.mockResolvedValue([record]);
    connected.inspect.mockResolvedValue(turn);
    connected.turn.inspect.mockResolvedValue({ kind: "not-found", target: turnTarget });
    const { el, button, click } = await render();
    await settle(() => button("Inspect conversation")?.disabled === false);
    expect(connected.inspect).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect.mock.calls[0]?.[0]).toBe(record);
    click("Inspect");
    await settle(
      () => connected.turn.inspect.mock.calls.length === 2 && button("Inspect")?.disabled === false
    );
    click("Inspect conversation");
    await settle(
      () =>
        connected.turn.inspect.mock.calls.length === 3 &&
        button("Inspect conversation")?.disabled === false
    );
    expect(el.querySelector("pre")?.textContent).toBe(original);
    expect(connected.submit).not.toHaveBeenCalled();
    expect(connected.retry).not.toHaveBeenCalled();
    expect(connected.resume).not.toHaveBeenCalled();
    expect(connected.turn.request).not.toHaveBeenCalled();
    expect(connected.turn.cancel).not.toHaveBeenCalled();
    expect(connected.execution.request).not.toHaveBeenCalled();
  });

  test("retry submission and intake recovery continue the turn without another approval gate", async () => {
    for (const kind of ["captured", "processing"] as const) {
      connected = fixture();
      session = connected;
      connected.list.mockResolvedValue([record]);
      connected.inspect.mockResolvedValue(
        kind === "captured"
          ? { kind, ...common }
          : { kind, ...common, recovery: "required", stage: "waiting" }
      );
      connected.retry.mockResolvedValue(turn);
      connected.resume.mockResolvedValue(turn);
      connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
      const { el, button, click, unmount } = await render();
      const label = kind === "captured" ? "Retry submission" : "Resume";
      await settle(() => button(label)?.disabled === false);
      click(label);
      await settle(() => el.textContent?.includes("hosted-session-real") === true);
      expect(connected.turn.request).toHaveBeenCalledTimes(1);
      expect(connected.turn.request.mock.calls[0]?.[0]).toBe(record);
      expect(connected.execution.request).not.toHaveBeenCalled();
      expect(connected.execution.resume).not.toHaveBeenCalled();
      unmount();
    }
  });

  test("an unconfirmed request retains the source and requires explicit inspection or continuation", async () => {
    connected.turn.request.mockRejectedValue(
      new Error("Hosted conversation acknowledgement was lost.")
    );
    const { el, button, click } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("acknowledgement was lost") === true);
    expect(el.textContent).toContain("Intake outcome: turn");
    expect(el.querySelector("pre")?.textContent).toBe(original);
    expect(button("Inspect conversation")?.disabled).toBe(false);
    expect(button("Cancel conversation")?.disabled).toBe(false);
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect).not.toHaveBeenCalled();
    connected.turn.inspect.mockResolvedValue({ kind: "not-found", target: turnTarget });
    click("Inspect conversation");
    await settle(
      () =>
        connected.turn.inspect.mock.calls.length === 1 &&
        button("Continue conversation request")?.disabled === false
    );
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    connected.turn.request.mockResolvedValue(turnRunning);
    click("Continue conversation request");
    await settle(() => el.textContent?.includes("hosted-session-real") === true);
    expect(connected.turn.request).toHaveBeenCalledTimes(2);
    expect(connected.submit).toHaveBeenCalledTimes(1);
    expect(connected.retry).not.toHaveBeenCalled();
    expect(connected.resume).not.toHaveBeenCalled();
  });

  test("opening a hosted session uses its durable session ID without requesting another turn", async () => {
    const opened = mock((_sessionId: string) => {});
    const { el, button, click } = await render(opened);
    submit(el);
    await settle(() => button("Open hosted session")?.disabled === false);
    expect(opened).not.toHaveBeenCalled();
    expect(el.textContent).toContain("hosted-session-real");
    click("Open hosted session");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0]?.[0]).toBe("hosted-session-real");
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect).not.toHaveBeenCalled();
    expect(connected.execution.request).not.toHaveBeenCalled();
  });

  test("NewWorkMenu opens the recorded hosted Work item and closes native intake without cancellation", async () => {
    const { NewWorkMenu } = await import("./NewWorkMenu");
    const opened = mock((_key: string) => {});
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    flushSync(() => root.render(<NewWorkMenu lifetime={getClientLifetime()} onCreated={opened} />));
    cleanups.push(() => {
      flushSync(() => root.unmount());
      el.remove();
    });
    const menuButton = el.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(menuButton).not.toBeNull();
    flushSync(() => menuButton!.click());
    const nativeItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Native request"
    );
    expect(nativeItem).toBeDefined();
    flushSync(() => nativeItem!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await settle(() => Boolean(dialog?.querySelector("textarea")));
    submit(dialog!);
    const openButton = () =>
      [...dialog!.querySelectorAll("button")].find(
        (item) => item.textContent === "Open hosted session"
      );
    await settle(() => openButton()?.disabled === false);
    expect(opened).not.toHaveBeenCalled();
    flushSync(() => openButton()!.click());
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0]?.[0]).toBe("hosted:hosted-session-real");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(connected.dispose).toHaveBeenCalledTimes(1);
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.turn.cancel).not.toHaveBeenCalled();
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
  });

  test("blocked and refused intake never request conversation delivery or execution", async () => {
    for (const found of [
      { kind: "blocked", ...common, reason: "missing-context", recovery: "required" },
      { kind: "refused", ...common, reason: "semantic" },
    ] as const) {
      connected = fixture();
      session = connected;
      connected.submit.mockImplementation(async (_source, saved) => {
        saved(record);
        return found;
      });
      const { el, button, unmount } = await render();
      submit(el);
      await settle(() => el.textContent?.includes(`Intake outcome: ${found.kind}`) === true);
      expect(connected.turn.request).not.toHaveBeenCalled();
      expect(connected.execution.request).not.toHaveBeenCalled();
      expect(button("Continue conversation request")).toBeUndefined();
      expect(button("Cancel conversation")).toBeUndefined();
      expect(button("Open hosted session")).toBeUndefined();
      unmount();
    }
  });

  test("cancelling intake fences a late turn result before it can request hosted delivery", async () => {
    const pending = deferred<NativeIntakeResult>();
    connected.submit.mockImplementation((_source, saved) => {
      saved(record);
      return pending.promise;
    });
    const { el, button, click } = await render();
    submit(el);
    await settle(() => button("Cancel intake")?.disabled === false);
    const oldSignal = connected.submit.mock.calls[0]?.[2];
    click("Cancel intake");
    await settle(() => el.textContent?.includes("Intake outcome: cancelled") === true);
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(turn);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(el.textContent).toContain("Intake outcome: cancelled");
    expect(connected.turn.request).not.toHaveBeenCalled();
    expect(connected.turn.inspect).not.toHaveBeenCalled();
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(button("Cancel conversation")).toBeUndefined();
  });

  test("a cancellation race that reveals a turn only inspects hosted delivery", async () => {
    const pending = deferred<NativeIntakeResult>();
    connected.submit.mockImplementation((_source, saved) => {
      saved(record);
      return pending.promise;
    });
    connected.cancel.mockResolvedValue(turn);
    connected.turn.inspect.mockResolvedValue(turnRunning);
    const { el, button, click } = await render();
    submit(el);
    await settle(() => button("Cancel intake")?.disabled === false);
    click("Cancel intake");
    await settle(() => el.textContent?.includes("hosted-session-real") === true);
    expect(connected.turn.inspect).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect.mock.calls[0]?.[0]).toBe(record);
    expect(connected.turn.request).not.toHaveBeenCalled();
    pending.resolve(turn);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(connected.turn.request).not.toHaveBeenCalled();
    expect(connected.execution.request).not.toHaveBeenCalled();
  });

  test("cancelling waits for an explicit host observation before displaying terminal cancellation", async () => {
    const cancelling: NativeTurnObservation = {
      ...turnRunning,
      snapshot: { ...turnRunning.snapshot, state: "cancelling" },
    };
    connected.turn.cancel.mockResolvedValue(cancelling);
    connected.turn.inspect.mockResolvedValue(turnCancelled);
    const { el, button, click } = await render();
    submit(el);
    await settle(() => button("Inspect conversation")?.disabled === false);
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    click("Cancel conversation");
    await settle(() => el.textContent?.includes("waiting for its owned work to stop") === true);
    expect(el.textContent).not.toContain("delivery is cancelled");
    expect(el.textContent).not.toContain("recorded completion");
    expect(button("Continue conversation request")).toBeUndefined();
    expect(button("Start conversation")).toBeUndefined();
    expect(button("Resume conversation")).toBeUndefined();
    expect(button("Inspect conversation")?.disabled).toBe(false);
    expect(connected.turn.cancel).toHaveBeenCalledTimes(1);
    expect(connected.turn.inspect).not.toHaveBeenCalled();
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    click("Inspect conversation");
    await settle(() => el.textContent?.includes("delivery is cancelled") === true);
    expect(el.textContent).toContain("Effects already performed are not undone");
    expect(el.textContent).not.toContain("waiting for its owned work to stop");
    expect(button("Cancel conversation")).toBeUndefined();
    expect(button("Continue conversation request")).toBeUndefined();
    expect(connected.turn.inspect).toHaveBeenCalledTimes(1);
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.turn.cancel).toHaveBeenCalledTimes(1);
  });

  test("cancellation supersedes a pending delivery and ignores its late acknowledgement", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.turn.request.mockImplementation(() => pending.promise);
    const { el, button, click } = await render();
    submit(el);
    await settle(() => button("Cancel conversation")?.disabled === false);
    const oldSignal = connected.turn.request.mock.calls[0]?.[1];
    click("Cancel conversation");
    await settle(
      () =>
        connected.turn.cancel.mock.calls.length === 1 &&
        button("Inspect conversation")?.disabled === false
    );
    expect(oldSignal?.aborted).toBe(true);
    expect(connected.turn.cancel.mock.calls[0]?.[0]).toBe(record);
    expect(button("Cancel conversation")).toBeUndefined();
    pending.resolve(turnRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(button("Cancel conversation")).toBeUndefined();
    expect(button("Continue conversation request")).toBeUndefined();
    expect(el.querySelector("pre")?.textContent).toBe(original);
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
  });

  test("cancellation supersedes an explicit turn inspection without adopting its late state", async () => {
    const { el, button, click } = await render();
    submit(el);
    await settle(() => button("Inspect conversation")?.disabled === false);
    const pending = deferred<NativeTurnObservation>();
    connected.turn.inspect.mockImplementation(() => pending.promise);
    click("Inspect conversation");
    const oldSignal = connected.turn.inspect.mock.calls[0]?.[1];
    expect(button("Cancel conversation")?.disabled).toBe(false);
    click("Cancel conversation");
    await settle(
      () =>
        connected.turn.cancel.mock.calls.length === 1 &&
        button("Inspect conversation")?.disabled === false
    );
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(turnRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(button("Cancel conversation")).toBeUndefined();
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
  });

  test("reopening can cancel while its read-only turn observation is pending", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.list.mockResolvedValue([record]);
    connected.inspect.mockResolvedValue(turn);
    connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
    connected.turn.inspect.mockImplementation(() => pending.promise);
    const { button, click } = await render();
    await settle(() => button("Cancel conversation")?.disabled === false);
    const oldSignal = connected.turn.inspect.mock.calls[0]?.[1];
    click("Cancel conversation");
    await settle(
      () =>
        connected.turn.cancel.mock.calls.length === 1 &&
        button("Inspect conversation")?.disabled === false
    );
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(turnRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(button("Cancel conversation")).toBeUndefined();
    expect(connected.turn.request).not.toHaveBeenCalled();
    expect(connected.submit).not.toHaveBeenCalled();
  });

  test("a durable hosted turn remains inspectable and cancellable when intake lookup fails", async () => {
    connected.list.mockResolvedValue([record]);
    connected.inspect.mockRejectedValue(new Error("Original intake scope is stale."));
    connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
    connected.turn.inspect.mockResolvedValue(turnRunning);
    const { el, button, click } = await render();
    await settle(() => button("Inspect conversation")?.disabled === false);
    expect(el.textContent).toContain("Original intake scope is stale");
    expect(el.textContent).toContain("hosted-session-real");
    expect(button("Cancel conversation")?.disabled).toBe(false);
    click("Inspect conversation");
    await settle(() => connected.turn.inspect.mock.calls.length === 2);
    expect(connected.turn.request).not.toHaveBeenCalled();
  });

  test("New request detaches pending delivery and fences the late acknowledgement without cancellation", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.turn.request.mockImplementation(() => pending.promise);
    const { el, click, button } = await render();
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 1);
    const oldSignal = connected.turn.request.mock.calls[0]?.[1];
    click("New request");
    expect(oldSignal?.aborted).toBe(true);
    expect(button("Submit")).toBeDefined();
    pending.resolve(turnRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(button("Submit")).toBeDefined();
    expect(el.textContent).not.toContain("hosted-session-real");
    expect(el.textContent).toContain("Saved requests");
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.turn.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
  });

  test("closing aborts local delivery observation and disposes without cancelling the host", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.turn.request.mockImplementation(() => pending.promise);
    const { el, unmount } = await render();
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 1);
    const oldSignal = connected.turn.request.mock.calls[0]?.[1];
    unmount();
    expect(oldSignal?.aborted).toBe(true);
    expect(connected.dispose).toHaveBeenCalledTimes(1);
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.turn.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
    pending.resolve(turnRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(el.textContent).toBe("");
  });

  test("connection replacement clears the old source and fences a late hosted receipt", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.turn.request.mockImplementation(() => pending.promise);
    const old = connected;
    const { el, button, rerender } = await render();
    submit(el);
    await settle(() => old.turn.request.mock.calls.length === 1);
    expect(el.querySelector("pre")?.textContent).toBe(original);
    connected = fixture();
    session = connected;
    invalidateClientLifetime();
    rerender();
    await settle(() => button("Submit")?.disabled === true);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(old.turn.request.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(el.querySelector("pre")).toBeNull();
    expect(el.textContent).not.toContain("Saved requests");
    pending.resolve(turnRunning);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(el.textContent).not.toContain("hosted-session-real");
    expect(connected.turn.request).not.toHaveBeenCalled();
    expect(old.turn.cancel).not.toHaveBeenCalled();
  });
});
