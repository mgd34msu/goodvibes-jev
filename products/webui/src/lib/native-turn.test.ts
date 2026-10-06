import { expect, test } from "bun:test";
import type { NativeConversationIntakeLookupResult } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import { createNativeIntakeTurn } from "./native-turn";
import type { NativeIntakeBrowserRecord } from "./native-intake-journal";

const original: NativeIntakeBrowserRecord = {
  binding: {
    endpoint: "http://localhost:3000",
    projectId: "project",
    principalId: "paired-owner",
    transport: "direct",
  },
  command: {
    requestId: "original-request",
    inputId: "original-input",
    text: "  Answer 🧪.\nRepeat. Repeat.  ",
    unsupportedSources: [],
  },
  createdAt: 1,
};
const source = {
  kind: "turn" as const,
  projectId: original.binding.projectId,
  requestId: original.command.requestId,
  sourceRef: {
    version: 1 as const,
    inputId: original.command.inputId,
    sourceId: "original-source",
    sourceRevision: "revision-v1",
    sessionId: "source-session",
  },
  route: "answer" as const,
  text: original.command.text,
};
const identity = {
  projectId: source.projectId,
  inputId: source.sourceRef.inputId,
  sourceRevision: source.sourceRef.sourceRevision,
};
const running = {
  ...identity,
  requestId: source.requestId,
  state: "running" as const,
  sessionId: "hosted-session",
  brokerInputId: "broker-input",
  correlationId: "turn-correlation",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(originalRecord: NativeIntakeBrowserRecord = original) {
  const calls: string[] = [];
  let found: NativeConversationIntakeLookupResult = structuredClone(source);
  let status: unknown = { kind: "not-found" };
  let response: unknown = running;
  let confirms = 0,
    failConfirmAt = 0;
  let detached = false;
  let hook: ((method: string) => Promise<void> | void) | undefined;
  const session = createNativeIntakeTurn({
    binding: original.binding,
    active() {
      if (detached) throw new Error("Connection changed");
    },
    async confirm(record) {
      confirms++;
      calls.push("confirm");
      if (confirms === failConfirmAt) throw new Error("Original journal unavailable");
      expect(record).toEqual(originalRecord);
    },
    async inspect(record) {
      calls.push("source");
      expect(record).toEqual(originalRecord);
      return structuredClone(found);
    },
    async invoke(method, input) {
      expect(input).toEqual(identity);
      calls.push(method);
      await hook?.(method);
      if (method === "workLedger.turn.status") return structuredClone(status);
      return structuredClone(response);
    },
  });
  return {
    session,
    calls,
    setSource(value: NativeConversationIntakeLookupResult) {
      found = value;
    },
    setStatus(value: unknown) {
      status = value;
    },
    setResponse(value: unknown) {
      response = value;
    },
    failConfirmAt(value: number) {
      failConfirmAt = value;
    },
    detach() {
      detached = true;
    },
    hook(value: typeof hook) {
      hook = value;
    },
  };
}
const writes = (h: ReturnType<typeof harness>) =>
  h.calls.filter((call) => ["workLedger.turn.start", "workLedger.turn.cancel"].includes(call));

test("conversation continuation confirms strict original, reads source/status and sends only host identity once", async () => {
  const h = harness();
  expect(await h.session.request(original)).toEqual({
    kind: "recorded",
    target: identity,
    snapshot: running,
  });
  expect(h.calls).toEqual([
    "confirm",
    "source",
    "workLedger.turn.status",
    "confirm",
    "workLedger.turn.start",
  ]);
});

test("Inspect is read-only even when the host proves delivery absent", async () => {
  const h = harness();
  expect(await h.session.inspect(original)).toEqual({ kind: "not-found", target: identity });
  expect(writes(h)).toHaveLength(0);
});

for (const state of [
  "preparing",
  "queued",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "recovery-required",
] as const)
  test(`recorded ${state} delivery never repeats start or attempts recovery`, async () => {
    const h = harness();
    h.setStatus({ ...running, state });
    await h.session.request(original);
    await h.session.request(original);
    expect(writes(h)).toHaveLength(0);
  });

for (const status of [
  undefined,
  {},
  { kind: "unknown" },
  { kind: "not-found", permit: {} },
  { ...running, sessionId: null },
])
  test("unknown or invalid status cannot become absence or start", async () => {
    const h = harness();
    h.setStatus(status);
    await expect(h.session.request(original)).rejects.toThrow();
    expect(writes(h)).toHaveLength(0);
  });

for (const key of ["projectId", "requestId", "inputId", "sourceRevision"] as const)
  test(`conversation ${key} mismatch is rejected on status and start`, async () => {
    const h = harness();
    h.setStatus({ ...running, [key]: "another" });
    await expect(h.session.request(original)).rejects.toThrow("differs from the saved original");
    expect(writes(h)).toHaveLength(0);
    h.setStatus({ kind: "not-found" });
    h.setResponse({ ...running, [key]: "another" });
    await expect(h.session.request(original)).rejects.toThrow("differs from the saved original");
    expect(writes(h)).toEqual(["workLedger.turn.start"]);
  });

for (const mutation of [
  { ...source, projectId: "another" },
  { ...source, requestId: "another" },
  { ...source, sourceRef: { ...source.sourceRef, inputId: "another" } },
  { ...source, text: source.text.trim() },
])
  test("source identity/text substitution cannot create a conversation request", async () => {
    const h = harness();
    h.setSource(mutation);
    await expect(h.session.request(original)).rejects.toThrow("source differs");
    expect(h.calls).toEqual(["confirm", "source"]);
  });

for (const kind of ["not-found", "captured", "cancelled", "blocked", "refused"] as const)
  test(`${kind} intake cannot create a hosted delivery`, async () => {
    const h = harness();
    h.setSource({ ...source, kind } as NativeConversationIntakeLookupResult);
    expect(await h.session.request(original)).toEqual({ kind: "not-requested" });
    expect(writes(h)).toHaveLength(0);
  });

for (const failAt of [1, 2])
  test(`original strict journal failure at confirmation ${failAt} prevents mutation`, async () => {
    const h = harness();
    h.failConfirmAt(failAt);
    await expect(h.session.request(original)).rejects.toThrow("journal unavailable");
    expect(writes(h)).toHaveLength(0);
  });

test("lost start acknowledgement only becomes a status read on explicit continuation", async () => {
  const h = harness();
  h.hook((method) => {
    if (method === "workLedger.turn.start") {
      h.setStatus(running);
      throw new Error("Lost acknowledgement");
    }
  });
  await expect(h.session.request(original)).rejects.toThrow("Lost acknowledgement");
  expect(writes(h)).toEqual(["workLedger.turn.start"]);
  expect(await h.session.request(original)).toEqual({
    kind: "recorded",
    target: identity,
    snapshot: running,
  });
  expect(writes(h)).toEqual(["workLedger.turn.start"]);
});

test("cancel uses its own identity-only endpoint and strict original without requiring readable status", async () => {
  const h = harness();
  h.setStatus(undefined);
  const cancelled = { ...running, state: "cancelled" as const };
  h.setResponse(cancelled);
  expect(await h.session.cancel(original)).toEqual({
    kind: "recorded",
    target: identity,
    snapshot: cancelled,
  });
  expect(h.calls).toEqual(["confirm", "source", "confirm", "workLedger.turn.cancel"]);
});

test("caller mutation is detached before asynchronous source confirmation", async () => {
  const h = harness();
  const supplied = structuredClone(original);
  const pending = h.session.request(supplied);
  supplied.command.text = "Replaced";
  supplied.command.inputId = "Replacement";
  expect(await pending).toEqual({ kind: "recorded", target: identity, snapshot: running });
});

test("connection change during status prevents the start", async () => {
  const h = harness();
  h.hook(() => h.detach());
  await expect(h.session.request(original)).rejects.toThrow("Connection changed");
  expect(writes(h)).toHaveLength(0);
});

test("late start response after abort cannot update the observation", async () => {
  const h = harness();
  const pending = deferred<undefined>();
  const controller = new AbortController();
  h.hook((method) => (method === "workLedger.turn.start" ? pending.promise : undefined));
  const request = h.session.request(original, controller.signal);
  while (!writes(h).length) await Promise.resolve();
  controller.abort();
  pending.resolve(undefined);
  await expect(request).rejects.toThrow();
  expect(writes(h)).toEqual(["workLedger.turn.start"]);
});

test("cancelling remains an in-progress host observation until explicit status confirms cancelled", async () => {
  const h = harness();
  const cancelling = { ...running, state: "cancelling" as const };
  const cancelled = { ...running, state: "cancelled" as const };
  h.setResponse(cancelling);
  expect(await h.session.cancel(original)).toEqual({
    kind: "recorded",
    target: identity,
    snapshot: cancelling,
  });
  expect(writes(h)).toEqual(["workLedger.turn.cancel"]);
  h.setStatus(cancelling);
  expect(await h.session.request(original)).toEqual({
    kind: "recorded",
    target: identity,
    snapshot: cancelling,
  });
  expect(writes(h)).toEqual(["workLedger.turn.cancel"]);
  h.setStatus(cancelled);
  expect(await h.session.inspect(original)).toEqual({
    kind: "recorded",
    target: identity,
    snapshot: cancelled,
  });
  expect(writes(h)).toEqual(["workLedger.turn.cancel"]);
  expect(h.calls.filter((call) => call === "workLedger.turn.status")).toHaveLength(2);
});

const continuationOriginal: NativeIntakeBrowserRecord = {
  ...original,
  command: { ...original.command, continuation: { sessionId: "hosted-session" } },
};
const continuationSource: NativeConversationIntakeLookupResult = {
  ...source,
  sourceRef: {
    ...source.sourceRef,
    continuation: { sessionId: "hosted-session", revision: "a".repeat(64) },
  },
  continuation: {
    sessionId: "hosted-session",
    revision: "a".repeat(64),
    messages: [
      { role: "user", content: "Earlier completed source" },
      { role: "assistant", content: "Earlier completed reply" },
    ],
  },
};

test("continuation sends only source identity, accepts queued state, and never replays after a lost acknowledgement", async () => {
  const h = harness(continuationOriginal);
  h.setSource(continuationSource);
  const queued = { ...running, state: "queued" };
  h.setResponse(queued);
  h.hook((method) => {
    if (method === "workLedger.turn.start") {
      h.setStatus(queued);
      throw new Error("Lost queued acknowledgement");
    }
  });
  await expect(h.session.request(continuationOriginal)).rejects.toThrow(
    "Lost queued acknowledgement"
  );
  expect(await h.session.inspect(continuationOriginal)).toMatchObject({
    kind: "recorded",
    snapshot: { state: "queued", sessionId: "hosted-session" },
  });
  await h.session.request(continuationOriginal);
  expect(writes(h)).toEqual(["workLedger.turn.start"]);
});

for (const mismatch of ["source", "snapshot", "revision"] as const)
  test(`continuation rejects ${mismatch} context substitution before requesting delivery`, async () => {
    const h = harness(continuationOriginal);
    const changed = structuredClone(continuationSource);
    if (mismatch === "source") changed.sourceRef.continuation!.sessionId = "other";
    if (mismatch === "snapshot") changed.continuation!.sessionId = "other";
    if (mismatch === "revision") changed.continuation!.revision = "b".repeat(64);
    h.setSource(changed);
    await expect(h.session.request(continuationOriginal)).rejects.toThrow(
      "differs from the saved original"
    );
    expect(writes(h)).toHaveLength(0);
  });

test("continuation refuses another hosted session in a same-input response", async () => {
  const h = harness(continuationOriginal);
  h.setSource(continuationSource);
  h.setStatus({ ...running, sessionId: "other-hosted-session" });
  await expect(h.session.request(continuationOriginal)).rejects.toThrow(
    "differs from the saved original"
  );
  expect(writes(h)).toHaveLength(0);
});
