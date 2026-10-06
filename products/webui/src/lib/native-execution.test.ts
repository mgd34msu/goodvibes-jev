import { expect, test } from "bun:test";
import {
  createOperatorNativeWorkExecutionClient,
  type NativeWorkExecutionSnapshot,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import type { NativeConversationIntakeLookupResult } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import { createNativeIntakeExecution, nativeExecutionCanResume } from "./native-execution";
import type { NativeExecutionBrowserRecord } from "./native-execution-journal";
import type { NativeIntakeBrowserRecord } from "./native-intake-journal";

const original: NativeIntakeBrowserRecord = {
  binding: {
    endpoint: "https://daemon.example",
    projectId: "project",
    principalId: "pairing:owner",
    transport: "direct",
  },
  command: {
    inputId: "input",
    requestId: "request",
    text: "  Keep 🧪. Keep 🧪.  ",
    unsupportedSources: [],
  },
  createdAt: 1,
};
const target = {
  workId: "work",
  attemptId: "attempt",
  expectedRevision: { work: 1, criteria: 1, attempt: 1 },
};
const projection = {
  projectId: "project",
  ...target,
  currentRevision: { ...target.expectedRevision },
  currentAttempt: true,
  stale: false,
};
const running = (): Extract<NativeWorkExecutionSnapshot, { kind: "execution" }> => ({
  kind: "execution",
  ...structuredClone(projection),
  state: "launch-claimed",
  recovery: "available",
  receipt: { contractId: "contract", ownerAgentId: "owner" },
  progress: null,
});
const work = {
  kind: "work",
  projectId: "project",
  requestId: "request",
  sourceRef: {
    version: 1,
    inputId: "input",
    sourceId: "source",
    sourceRevision: "revision",
    sessionId: "session",
  },
  receipt: { ...target, goal: original.command.text },
} as NativeConversationIntakeLookupResult;
const absent = () =>
  Object.assign(new Error("synthetic absent"), { code: "NATIVE_EXECUTION_NOT_FOUND" });
function harness() {
  let saved: NativeExecutionBrowserRecord | null = null;
  let snapshot: NativeWorkExecutionSnapshot | null = null;
  let source = work;
  let sourceFailure = false,
    saveFailure = false,
    confirmFailure = false,
    statusFailure = false,
    loseStart = false,
    active = true;
  let beforeStart: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const client = createOperatorNativeWorkExecutionClient(
    {
      invoke: async <T>(method: string, input?: Record<string, unknown>) => {
        calls.push(method);
        inputs.push(structuredClone(input));
        if (method.endsWith(".status")) {
          if (statusFailure) throw new Error("private credential https://example/token-secret");
          if (!snapshot) throw absent();
        } else {
          expect(saved?.target).toEqual(target);
          if (method.endsWith(".start")) {
            if (beforeStart) await beforeStart();
            snapshot = running();
            if (loseStart) {
              loseStart = false;
              throw new Error("Lost acknowledgement private-secret");
            }
          } else if (method.endsWith(".cancel"))
            snapshot = {
              kind: "prevented-before-admission",
              ...projection,
              state: "cancelled",
              recovery: "cancelled",
            };
          else if (method.endsWith(".resume")) snapshot = running();
          else throw new Error(`Unexpected method ${method}`);
        }
        return structuredClone(snapshot) as T;
      },
    },
    "project"
  );
  const session = createNativeIntakeExecution({
    binding: original.binding,
    client,
    journal: {
      async get() {
        calls.push("journal.get");
        return structuredClone(saved);
      },
      async save(record) {
        calls.push("journal.save");
        if (saveFailure) throw new Error("Journal unavailable");
        saved = structuredClone(record);
      },
      async confirm(record) {
        calls.push("journal.confirm");
        if (confirmFailure || JSON.stringify(record) !== JSON.stringify(saved))
          throw new Error("Journal unconfirmed");
      },
    },
    async confirm(record) {
      calls.push("original.confirm");
      expect(record).toEqual(original);
    },
    async inspect() {
      calls.push("intake.get");
      if (sourceFailure) throw new Error("Source scope is stale");
      return structuredClone(source);
    },
    active(signal) {
      if (!active) throw new Error("Connection retired");
      signal?.throwIfAborted();
    },
  });
  return {
    session,
    calls,
    inputs,
    client,
    saved: () => saved,
    setSnapshot(value: NativeWorkExecutionSnapshot | null) {
      snapshot = value;
    },
    setSource(value: NativeConversationIntakeLookupResult) {
      source = value;
    },
    sourceFailure() {
      sourceFailure = true;
    },
    saveFailure() {
      saveFailure = true;
    },
    confirmFailure() {
      confirmFailure = true;
    },
    statusFailure() {
      statusFailure = true;
    },
    loseStart() {
      loseStart = true;
    },
    retire() {
      active = false;
    },
    beforeStart(callback: () => Promise<void>) {
      beforeStart = callback;
    },
  };
}
const writes = (calls: string[]) =>
  calls.filter((call) => /execution\.(start|resume|cancel)$/.test(call));

test("explicit request retains the original canonical target before status and one native start", async () => {
  const h = harness();
  const result = await h.session.request(original);
  expect(result).toMatchObject({ kind: "recorded", target, snapshot: { kind: "execution" } });
  expect(h.saved()).toEqual({
    binding: original.binding,
    inputId: "input",
    requestId: "request",
    target,
  });
  expect(h.calls.indexOf("journal.save")).toBeLessThan(
    h.calls.indexOf("workLedger.execution.start")
  );
  expect(h.calls.indexOf("journal.confirm")).toBeLessThan(
    h.calls.indexOf("workLedger.execution.start")
  );
  expect(writes(h.calls)).toEqual(["workLedger.execution.start"]);
  expect(h.inputs).toEqual([
    { projectId: "project", ...target },
    { projectId: "project", ...target },
  ]);
});

test("opening and inspecting canonical admitted work never records a dispatch or starts it", async () => {
  const h = harness();
  expect(await h.session.inspect(original)).toEqual({ kind: "not-found", target });
  expect(h.saved()).toBeNull();
  expect(writes(h.calls)).toEqual([]);
  expect(h.calls).not.toContain("journal.save");
});

test("lost start acknowledgement is not retried; explicit continuation reconciles the same attempt", async () => {
  const h = harness();
  h.loseStart();
  await expect(h.session.request(original)).rejects.toThrow("outcome is unknown");
  expect(writes(h.calls)).toEqual(["workLedger.execution.start"]);
  expect(await h.session.request(original)).toMatchObject({
    kind: "recorded",
    snapshot: { receipt: { contractId: "contract" } },
  });
  expect(writes(h.calls)).toEqual(["workLedger.execution.start"]);
});

test("unknown status cannot become absence or start; remote errors are redacted", async () => {
  const h = harness();
  h.statusFailure();
  await expect(h.session.request(original)).rejects.toThrow("outcome is unknown");
  expect(writes(h.calls)).toEqual([]);
});

for (const fault of ["saveFailure", "confirmFailure"] as const)
  test(`${fault} prevents all execution mutations`, async () => {
    const h = harness();
    h[fault]();
    await expect(h.session.request(original)).rejects.toThrow("Journal");
    expect(writes(h.calls)).toEqual([]);
  });

test("terminal turn/refusal/source holds do not produce a native execution target", async () => {
  for (const kind of [
    "turn",
    "blocked",
    "refused",
    "cancelled",
    "captured",
    "processing",
    "not-found",
  ]) {
    const h = harness();
    h.setSource({ kind } as NativeConversationIntakeLookupResult);
    expect(await h.session.request(original)).toEqual({ kind: "not-requested" });
    expect(h.saved()).toBeNull();
    expect(writes(h.calls)).toEqual([]);
  }
});

test("saved target permits status and cancellation after the original source scope becomes stale", async () => {
  const h = harness();
  await h.session.request(original);
  h.sourceFailure();
  expect(await h.session.inspect(original)).toMatchObject({ kind: "recorded", target });
  expect(await h.session.cancel(original)).toMatchObject({
    kind: "recorded",
    snapshot: { kind: "prevented-before-admission" },
  });
  expect(h.calls.filter((call) => call === "intake.get")).toHaveLength(1);
  expect(writes(h.calls)).toEqual(["workLedger.execution.start", "workLedger.execution.cancel"]);
});

test("cancel can durably prevent a canonical admitted target before start exists", async () => {
  const h = harness();
  expect(await h.session.cancel(original)).toMatchObject({
    kind: "recorded",
    snapshot: { kind: "prevented-before-admission" },
  });
  expect(writes(h.calls)).toEqual(["workLedger.execution.cancel"]);
});

test("continuation never retries refused/pending/prevented or recovery-required execution", async () => {
  const states: NativeWorkExecutionSnapshot[] = [
    { kind: "pending-intent", ...projection, state: "admitting", recovery: "pending" },
    { kind: "pending-intent", ...projection, state: "refused", recovery: "required" },
    {
      kind: "prevented-before-admission",
      ...projection,
      state: "cancelled",
      recovery: "cancelled",
    },
    { ...running(), recovery: "required" },
  ];
  for (const snapshot of states) {
    const h = harness();
    h.setSnapshot(snapshot);
    expect(await h.session.request(original)).toMatchObject({ kind: "recorded", snapshot });
    expect(writes(h.calls)).toEqual([]);
  }
});

test("explicit resume rechecks current prepared/pending intent and cannot restart a launch claim", async () => {
  const h = harness();
  h.setSnapshot({
    kind: "pending-intent",
    ...projection,
    state: "admitting",
    recovery: "required",
  });
  await h.session.resume(original);
  expect(writes(h.calls)).toEqual(["workLedger.execution.resume"]);
  h.setSnapshot({ ...running(), recovery: "required" });
  await h.session.resume(original);
  expect(writes(h.calls)).toEqual(["workLedger.execution.resume"]);
});

test("real prepared available recovery can explicitly resume but continuation stays read-only", async () => {
  const h = harness();
  h.setSnapshot({ ...running(), state: "prepared", recovery: "available", receipt: null });
  await h.session.request(original);
  expect(writes(h.calls)).toEqual([]);
  await h.session.resume(original);
  expect(writes(h.calls)).toEqual(["workLedger.execution.resume"]);
});

test("stale/noncurrent/terminal recovery is inert and a changed admitted revision is refused", async () => {
  for (const change of [{ stale: true }, { currentAttempt: false }]) {
    const h = harness();
    h.setSnapshot({
      kind: "pending-intent",
      ...projection,
      ...change,
      state: "admitting",
      recovery: "required",
    });
    await h.session.resume(original);
    expect(writes(h.calls)).toEqual([]);
  }
  const h = harness();
  h.setSnapshot({
    kind: "pending-intent",
    ...projection,
    expectedRevision: { work: 2, criteria: 1, attempt: 1 },
    state: "admitting",
    recovery: "required",
  });
  await expect(h.session.resume(original)).rejects.toThrow("revisions differ");
  expect(writes(h.calls)).toEqual([]);
});

test("passed or published execution permits explicit settlement reconciliation without start", async () => {
  for (const state of ["required", "published"] as const) {
    const h = harness();
    h.setSnapshot({
      kind: "execution",
      ...projection,
      stale: true,
      currentAttempt: false,
      state: "launch-claimed",
      recovery: "terminal",
      receipt: { contractId: "contract", ownerAgentId: "owner" },
      settlement: { state },
      progress: {
        status: "passed",
        sessionMode: true,
        semanticState: null,
        stage: null,
        retrying: false,
        units: { total: 0, passed: 0, failed: 0 },
        criteria: { total: 1, met: 1, unmet: 0, unshown: 0 },
      },
    });
    await h.session.resume(original);
    expect(writes(h.calls)).toEqual(["workLedger.execution.resume"]);
  }
});

test("a retired connection or abort cannot publish a late execution result or trigger another operation", async () => {
  const h = harness();
  h.beforeStart(async () => h.retire());
  await expect(h.session.request(original)).rejects.toThrow("Connection retired");
  await expect(h.session.cancel(original)).rejects.toThrow("Connection retired");
  expect(writes(h.calls)).toEqual(["workLedger.execution.start"]);
  const other = harness();
  const controller = new AbortController();
  controller.abort();
  await expect(other.session.request(original, controller.signal)).rejects.toThrow();
  expect(writes(other.calls)).toEqual([]);
});

test("resume guard never interprets a prevention intent or cancelled receipt as settlement", () => {
  expect(
    nativeExecutionCanResume({
      kind: "prevented-before-admission",
      ...projection,
      state: "cancelled",
      recovery: "cancelled",
    })
  ).toBe(false);
  expect(
    nativeExecutionCanResume({
      ...running(),
      kind: "execution",
      state: "cancelled",
      recovery: "cancelled",
      settlement: { state: "published" },
      receipt: null,
      progress: null,
    })
  ).toBe(false);
});
