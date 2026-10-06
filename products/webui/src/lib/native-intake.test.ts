import { afterEach, beforeEach, expect, test } from "bun:test";
import { getClientLifetime, tokenStore } from "./client-lifetime";
import {
  openNativeIntake,
  type NativeIntakeJournal,
  type NativeIntakeScope,
} from "./native-intake";
import type { NativeIntakeBrowserRecord } from "./native-intake-journal";
import type {
  NativeConversationIntakeCaptureRequest,
  NativeConversationIntakeResult,
  NativeSelectedDiffSelector,
  NativeSelectedDiffContext,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";

const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  await tokenStore.setToken("synthetic-native-owner");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});
const selectedHunk = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
function diffContext(selector: NativeSelectedDiffSelector, sessionId: string): NativeSelectedDiffContext {
  return selector.kind === "session"
    ? { ...selector, unifiedDiff: selectedHunk, provenance: { kind: "session", sessionId, baselineCheckpointId: "base", latestCheckpointId: "latest" } }
    : { ...selector, unifiedDiff: selectedHunk, provenance: { kind: "workspace", baselineId: selector.baselineId, to: "WORKING" } };
}
const original = "  Fix 🧪.\nKeep both. Keep both.  ";
function harness() {
  let principalId = "paired-owner";
  let projectId = "native-project";
  let admin = true;
  let scopes = ["read:work-ledger", "write:work-ledger", "write:sessions", "read:sessions", "read:checkpoints"];
  let principalKind = "token";
  let failSave = false;
  let failConfirm = false;
  let turn: Record<string, unknown> | undefined;
  let lostStart = false;
  let invalidStatus = false;
  let statusHook: (() => void) | undefined;
  let lostCapture = false;
  let drift = false;
  let continuationDrift = false;
  let diffDrift = false;
  let command: NativeConversationIntakeCaptureRequest | undefined;
  let state: NativeConversationIntakeResult | undefined;
  const rows: NativeIntakeBrowserRecord[] = [];
  const requests: { path: string; input: Record<string, unknown>; auth: string | null }[] = [];
  const journal: NativeIntakeJournal = {
    async list(binding) {
      return structuredClone(
        rows.filter((row) => JSON.stringify(row.binding) === JSON.stringify(binding))
      );
    },
    async save(record) {
      if (failSave) throw new Error("Journal unavailable");
      rows.push(structuredClone(record));
    },
    async confirm(record) {
      if (failConfirm) throw new Error("Original journal unavailable");
      if (!rows.some((row) => JSON.stringify(row) === JSON.stringify(record)))
        throw new Error("Journal mismatch");
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ path, input: body, auth: new Headers(init?.headers).get("authorization") });
    if (path === "/api/control-plane/auth")
      return Response.json({
        authenticated: true,
        admin,
        principalKind,
        principalId,
        scopes,
        roles: [],
        authMode: "shared-token",
        tokenPresent: true,
        authorizationHeaderPresent: true,
        sessionCookiePresent: false,
      });
    if (path === "/api/work-ledger/project") return Response.json({ projectId });
    if (path.startsWith("/api/work-ledger/turn/")) {
      expect(body).toEqual({
        projectId: "native-project",
        inputId: command!.inputId,
        sourceRevision: state!.sourceRef.sourceRevision,
      });
      if (path.endsWith("/status")) {
        statusHook?.();
        return Response.json(invalidStatus ? { kind: "unknown" } : (turn ?? { kind: "not-found" }));
      }
      if (path.endsWith("/start")) {
        turn = {
          ...body,
          requestId: command!.requestId,
          state: "running",
          sessionId: command!.continuation?.sessionId ?? "hosted-session",
          brokerInputId: "broker-input",
          correlationId: "native-correlation",
        };
        if (lostStart) {
          lostStart = false;
          throw new TypeError("Lost turn acknowledgement");
        }
      } else if (path.endsWith("/cancel")) {
        turn = {
          ...body,
          requestId: command!.requestId,
          state: "cancelled",
          sessionId: null,
          brokerInputId: null,
          correlationId: null,
        };
      } else throw new Error(`Unexpected turn route ${path}`);
      return Response.json(turn);
    }
    if (path === "/api/work-ledger/intake/capture") {
      command = body as unknown as NativeConversationIntakeCaptureRequest;
      expect(rows.some((row) => JSON.stringify(row.command) === JSON.stringify(command))).toBe(
        true
      );
      state = {
        kind: "captured",
        projectId,
        requestId: command.requestId,
        sourceRef: {
          version: 1,
          inputId: command.inputId,
          sourceId: "host-source",
          sourceRevision: "host-revision",
          sessionId: "host-session",
          ...(command.continuation
            ? {
                continuation: {
                  sessionId: command.continuation.sessionId,
                  ...(command.continuation.selectedDiff ? { selectedDiff: command.continuation.selectedDiff } : {}),
                  revision: "a".repeat(64),
                },
              }
            : {}),
        },
      };
      if (lostCapture) {
        lostCapture = false;
        throw new TypeError("Lost capture acknowledgement");
      }
    } else if (path === "/api/work-ledger/intake/admit") {
      state = {
        ...state!,
        kind: "turn",
        route: "answer",
        text: command!.text,
        ...(command!.continuation
          ? {
              continuation: {
                sessionId: command!.continuation.sessionId,
                ...(command!.continuation.selectedDiff ? { selectedDiff: diffContext(command!.continuation.selectedDiff, command!.continuation.sessionId) } : {}),
                revision: "a".repeat(64),
                messages: [
                  { role: "user" as const, content: "Prior completed original" },
                  { role: "assistant" as const, content: "Prior completed reply" },
                ],
              },
            }
          : {}),
      };
    } else if (path === "/api/work-ledger/intake/resume") {
      state = { ...state!, kind: "refused", reason: "semantic" } as NativeConversationIntakeResult;
      delete (state as unknown as Record<string, unknown>).stage;
      delete (state as unknown as Record<string, unknown>).recovery;
    } else if (path === "/api/work-ledger/intake/cancel") {
      state = {
        kind: "cancelled",
        projectId,
        requestId: command!.requestId,
        sourceRef: state!.sourceRef,
      };
    } else if (path !== "/api/work-ledger/intake/get") throw new Error(`Unexpected route ${path}`);
    if (continuationDrift && state && state.kind === "turn")
      state = {
        ...state,
        sourceRef: {
          ...state.sourceRef,
          continuation: { sessionId: "other-session", revision: "a".repeat(64) },
        },
        continuation: { sessionId: "other-session", revision: "a".repeat(64), messages: [] },
      };
    if (diffDrift && state?.sourceRef.continuation?.selectedDiff) {
      state = structuredClone(state);
      state.sourceRef.continuation!.selectedDiff = { ...state.sourceRef.continuation!.selectedDiff!, hunkIndex: 99 };
    }
    return Response.json(
      state
        ? { ...state, ...(drift ? { requestId: "another-request" } : {}) }
        : { kind: "not-found" }
    );
  }) as typeof fetch;
  let counter = 0;
  async function open(scope?: NativeIntakeScope) {
    const session = await openNativeIntake(
      getClientLifetime(),
      new AbortController().signal,
      journal,
      () => `logical-${++counter}`,
      undefined,
      scope
    );
    cleanups.push(() => session.dispose());
    return session;
  }
  const writes = () =>
    requests.filter(
      (request) => request.path.includes("/intake/") && !request.path.endsWith("/get")
    );
  return {
    open,
    rows,
    requests,
    writes,
    setPrincipal(value: string) {
      principalId = value;
    },
    setProject(value: string) {
      projectId = value;
    },
    setAdmin(value: boolean) {
      admin = value;
    },
    setScopes(value: string[]) {
      scopes = value;
    },
    setKind(value: string) {
      principalKind = value;
    },
    failSave() {
      failSave = true;
    },
    failConfirm() {
      failConfirm = true;
    },
    loseStart() {
      lostStart = true;
    },
    invalidStatus() {
      invalidStatus = true;
    },
    statusHook(callback: () => void) {
      statusHook = callback;
    },
    loseCapture() {
      lostCapture = true;
    },
    driftDiff() { diffDrift = true; },
    driftContinuation() {
      continuationDrift = true;
    },
    drift() {
      drift = true;
    },
    processing(recovery: "pending" | "required") {
      state = {
        kind: "processing",
        projectId,
        requestId: command!.requestId,
        sourceRef: state!.sourceRef,
        stage: "waiting",
        recovery,
      };
    },
  };
}

test("intake helper preserves original source and leaves turn delivery to the form continuation", async () => {
  const h = harness();
  const session = await h.open();
  const markers = [{ kind: "context" as const, label: "Unread appendix" }];
  let saved: NativeIntakeBrowserRecord | undefined;
  const result = await session.submit({ text: original, unsupportedSources: markers }, (record) => {
    saved = record;
  });
  expect(result.kind).toBe("turn");
  expect(saved?.command.text).toBe(original);
  expect(saved?.command.unsupportedSources).toEqual(markers);
  expect(h.writes().map((row) => row.path)).toEqual([
    "/api/work-ledger/intake/capture",
    "/api/work-ledger/intake/admit",
  ]);
  expect(h.writes()[0]?.input).toEqual({
    requestId: "logical-1",
    inputId: "logical-2",
    text: original,
    unsupportedSources: markers,
  });
  expect(h.writes()[1]?.input).toEqual({ inputId: "logical-2", sourceRevision: "host-revision" });
  expect(h.requests.every((row) => row.auth === "Bearer synthetic-native-owner")).toBe(true);
  const count = h.writes().length;
  await session.inspect(saved!);
  await session.resume(saved!);
  await session.cancel(saved!);
  await session.retry(saved!);
  expect(h.writes()).toHaveLength(count);
});

test("a deliberate identical request receives new IDs without text normalization", async () => {
  const h = harness();
  const session = await h.open();
  await session.submit({ text: original, unsupportedSources: [] }, () => undefined);
  await session.submit({ text: original, unsupportedSources: [] }, () => undefined);
  expect(h.rows.map((row) => row.command.inputId)).toEqual(["logical-2", "logical-4"]);
  expect(h.rows.map((row) => row.command.text)).toEqual([original, original]);
});

test("submission snapshots the original source before asynchronous authorization", async () => {
  const h = harness();
  const session = await h.open();
  const source = {
    text: original,
    unsupportedSources: [{ kind: "file" as const, label: "Original reference" }],
  };
  const pending = session.submit(source, () => undefined);
  source.text = "Changed after submission";
  source.unsupportedSources[0]!.label = "Changed reference";
  await pending;
  expect(h.rows[0]?.command.text).toBe(original);
  expect(h.rows[0]?.command.unsupportedSources).toEqual([
    { kind: "file", label: "Original reference" },
  ]);
});

test("journal failure prevents every capture/admission request", async () => {
  const h = harness();
  const session = await h.open();
  h.failSave();
  await expect(
    session.submit({ text: original, unsupportedSources: [] }, () => {
      throw new Error("Must not mark saved");
    })
  ).rejects.toThrow("Journal unavailable");
  expect(h.writes()).toHaveLength(0);
});

test("lost capture acknowledgement survives reopening; lookup is inert and retry continues the same identity", async () => {
  const h = harness();
  const session = await h.open();
  h.loseCapture();
  await expect(
    session.submit({ text: original, unsupportedSources: [] }, () => undefined)
  ).rejects.toThrow();
  session.dispose();
  const reopened = await h.open();
  const [record] = await reopened.list();
  expect((await reopened.inspect(record!)).kind).toBe("captured");
  expect(h.writes()).toHaveLength(1);
  expect((await reopened.retry(record!)).kind).toBe("turn");
  expect(h.writes().map((row) => row.path)).toEqual([
    "/api/work-ledger/intake/capture",
    "/api/work-ledger/intake/admit",
  ]);
  expect(h.writes()[1]?.input.inputId).toBe(record!.command.inputId);
});

test("only explicit recovery of interrupted processing resumes; pending work never rerolls", async () => {
  const h = harness();
  const session = await h.open();
  await session.submit({ text: original, unsupportedSources: [] }, () => undefined);
  const record = h.rows[0]!;
  h.processing("pending");
  await session.retry(record);
  await session.resume(record);
  expect(h.writes()).toHaveLength(2);
  h.processing("required");
  await session.inspect(record);
  expect(h.writes()).toHaveLength(2);
  expect((await session.resume(record)).kind).toBe("refused");
  expect(h.writes().at(-1)?.path).toBe("/api/work-ledger/intake/resume");
  await session.resume(record);
  expect(h.writes()).toHaveLength(3);
});

test("cancellation uses the authoritative source revision and never recaptures missing inputs", async () => {
  const h = harness();
  const session = await h.open();
  await session.submit({ text: original, unsupportedSources: [] }, () => undefined);
  h.processing("pending");
  expect((await session.cancel(h.rows[0]!)).kind).toBe("cancelled");
  expect(h.writes().at(-1)?.input).toEqual({
    inputId: "logical-2",
    sourceRevision: "host-revision",
  });
  await session.cancel(h.rows[0]!);
  expect(h.writes()).toHaveLength(3);
});

for (const unsupported of ["shared", "session", "non-admin", "missing-scope"])
  test(`native intake fails closed for ${unsupported} authority`, async () => {
    const h = harness();
    if (unsupported === "shared") h.setPrincipal("shared-token");
    if (unsupported === "session") h.setKind("user");
    if (unsupported === "non-admin") h.setAdmin(false);
    if (unsupported === "missing-scope") h.setScopes(["read:work-ledger"]);
    await expect(h.open()).rejects.toThrow("existing paired admin");
    expect(h.writes()).toHaveLength(0);
  });

test("fresh paired owner/project checks fence mutations after the view is opened", async () => {
  for (const change of ["owner", "project", "scope"]) {
    const h = harness();
    const session = await h.open();
    if (change === "owner") h.setPrincipal("other-owner");
    if (change === "project") h.setProject("other-project");
    if (change === "scope") h.setScopes(["read:work-ledger"]);
    await expect(
      session.submit({ text: original, unsupportedSources: [] }, () => undefined)
    ).rejects.toThrow();
    expect(h.writes()).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
  }
});

test("mismatched source identity is rejected after reload rather than adopted as authority", async () => {
  const h = harness();
  const session = await h.open();
  await session.submit({ text: original, unsupportedSources: [] }, () => undefined);
  session.dispose();
  const reopened = await h.open();
  h.drift();
  await expect(reopened.inspect(h.rows[0]!)).rejects.toThrow("different original source");
  expect(h.writes()).toHaveLength(2);
});

test("A → B → A sign-in changes permanently retire the original intake client", async () => {
  const h = harness();
  const session = await h.open();
  await tokenStore.setToken("other-owner");
  await tokenStore.setToken("synthetic-native-owner");
  await expect(
    session.submit({ text: original, unsupportedSources: [] }, () => undefined)
  ).rejects.toThrow("connection changed");
  expect(h.rows).toHaveLength(0);
  expect(h.writes()).toHaveLength(0);
});

const turnCalls = (h: ReturnType<typeof harness>) =>
  h.requests.filter((row) => row.path.includes("/turn/"));
async function admittedTurn(h: ReturnType<typeof harness>) {
  const session = await h.open();
  expect((await session.submit({ text: original, unsupportedSources: [] }, () => {})).kind).toBe(
    "turn"
  );
  return session;
}

test("actual browser facade validates and sends identity-only native turn status/start", async () => {
  const h = harness();
  const session = await admittedTurn(h);
  const observed = await session.turn.request(h.rows[0]!);
  expect(observed).toMatchObject({
    kind: "recorded",
    snapshot: {
      requestId: "logical-1",
      inputId: "logical-2",
      state: "running",
      sessionId: "hosted-session",
    },
  });
  expect(turnCalls(h).map((row) => row.path)).toEqual([
    "/api/work-ledger/turn/status",
    "/api/work-ledger/turn/start",
  ]);
  expect(
    turnCalls(h).every(
      (row) =>
        JSON.stringify(row.input) ===
        JSON.stringify({
          projectId: "native-project",
          inputId: "logical-2",
          sourceRevision: "host-revision",
        })
    )
  ).toBe(true);
  expect(h.requests.some((row) => /\/api\/(sessions|contracts|tasks)\//.test(row.path))).toBe(
    false
  );
  expect(h.writes()).toHaveLength(2);
});

for (const change of [
  "owner",
  "project",
  "admin",
  "session",
  "shared",
  "read",
  "ledger",
  "sessions",
] as const)
  test(`fresh browser authority fences native turn after ${change} change`, async () => {
    const h = harness();
    const session = await admittedTurn(h);
    if (change === "owner") h.setPrincipal("another-paired-owner");
    if (change === "project") h.setProject("another-project");
    if (change === "admin") h.setAdmin(false);
    if (change === "session") h.setKind("user");
    if (change === "shared") h.setPrincipal("shared-token");
    if (change === "read") h.setScopes(["write:work-ledger", "write:sessions"]);
    if (change === "ledger") h.setScopes(["read:work-ledger", "write:sessions"]);
    if (change === "sessions") h.setScopes(["read:work-ledger", "write:work-ledger"]);
    await expect(session.turn.request(h.rows[0]!)).rejects.toThrow();
    expect(turnCalls(h)).toHaveLength(0);
  });

for (const change of ["owner", "project", "scope", "journal"] as const)
  test(`native turn rechecks ${change} after status and before start`, async () => {
    const h = harness();
    const session = await admittedTurn(h);
    h.statusHook(() => {
      if (change === "owner") h.setPrincipal("replacement-owner");
      if (change === "project") h.setProject("replacement-project");
      if (change === "scope") h.setScopes(["read:work-ledger", "write:work-ledger"]);
      if (change === "journal") h.failConfirm();
    });
    await expect(session.turn.request(h.rows[0]!)).rejects.toThrow();
    expect(turnCalls(h).map((row) => row.path)).toEqual(["/api/work-ledger/turn/status"]);
  });

test("lost turn response survives reopening and explicit status reconciliation without replay", async () => {
  const h = harness();
  const session = await admittedTurn(h);
  h.loseStart();
  await expect(session.turn.request(h.rows[0]!)).rejects.toThrow();
  session.dispose();
  const reopened = await h.open();
  expect(await reopened.turn.inspect(h.rows[0]!)).toMatchObject({
    kind: "recorded",
    snapshot: { state: "running" },
  });
  await reopened.turn.request(h.rows[0]!);
  expect(turnCalls(h).filter((row) => row.path.endsWith("/start"))).toHaveLength(1);
  expect(h.writes()).toHaveLength(2);
});

test("unavailable original storage and unknown turn status fail closed in the browser facade", async () => {
  for (const fault of ["failConfirm", "invalidStatus"] as const) {
    const h = harness();
    const session = await admittedTurn(h);
    h[fault]();
    await expect(session.turn.request(h.rows[0]!)).rejects.toThrow();
    expect(turnCalls(h).filter((row) => !row.path.endsWith("/status"))).toHaveLength(0);
  }
});

test("conversation cancellation uses the turn endpoint and never re-admits or starts", async () => {
  const h = harness();
  const session = await admittedTurn(h);
  expect(await session.turn.cancel(h.rows[0]!)).toMatchObject({
    kind: "recorded",
    snapshot: { state: "cancelled" },
  });
  expect(turnCalls(h).map((row) => row.path)).toEqual(["/api/work-ledger/turn/cancel"]);
  expect(h.writes()).toHaveLength(2);
});

test("A to B to A sign-in permanently retires the native conversation client", async () => {
  const h = harness();
  const session = await admittedTurn(h);
  await tokenStore.setToken("another-owner");
  await tokenStore.setToken("synthetic-native-owner");
  await expect(session.turn.request(h.rows[0]!)).rejects.toThrow("connection changed");
  expect(turnCalls(h)).toHaveLength(0);
});

test("native continuation captures only the exact original plus session identity and retains it on retry", async () => {
  const h = harness();
  const scope = { continuationSessionId: "native-session", projectId: "native-project" };
  const session = await h.open(scope);
  h.loseCapture();
  await expect(
    session.submit({ text: original, unsupportedSources: [] }, () => {})
  ).rejects.toThrow();
  expect(h.rows[0]?.command).toEqual({
    requestId: "logical-1",
    inputId: "logical-2",
    text: original,
    unsupportedSources: [],
    continuation: { sessionId: "native-session" },
  });
  expect(h.writes()[0]?.input).toEqual(h.rows[0]?.command);
  session.dispose();
  const reopened = await h.open(scope);
  expect(await reopened.list()).toEqual(h.rows);
  expect((await reopened.inspect(h.rows[0]!)).kind).toBe("captured");
  expect(h.writes()).toHaveLength(1);
  expect((await reopened.retry(h.rows[0]!)).kind).toBe("turn");
  expect(h.writes()).toHaveLength(2);
  expect(h.writes().filter((request) => request.path.endsWith("/capture"))).toHaveLength(1);
  expect(await reopened.turn.request(h.rows[0]!)).toMatchObject({
    kind: "recorded",
    snapshot: { sessionId: "native-session" },
  });
  expect(turnCalls(h).map((row) => row.input)).toEqual([
    { projectId: "native-project", inputId: "logical-2", sourceRevision: "host-revision" },
    { projectId: "native-project", inputId: "logical-2", sourceRevision: "host-revision" },
  ]);
});

test("continuation lists and mutation controls are strictly scoped, and Work/New excludes continuations", async () => {
  const h = harness();
  const first = await h.open({ continuationSessionId: "session-a" });
  await first.submit({ text: original, unsupportedSources: [] }, () => {});
  const second = await h.open({ continuationSessionId: "session-b" });
  await second.submit({ text: original, unsupportedSources: [] }, () => {});
  const fresh = await h.open();
  await fresh.submit({ text: original, unsupportedSources: [] }, () => {});
  expect((await first.list()).map((row) => row.command.inputId)).toEqual(["logical-2"]);
  expect((await second.list()).map((row) => row.command.inputId)).toEqual(["logical-4"]);
  expect((await fresh.list()).map((row) => row.command.inputId)).toEqual(["logical-6"]);
  const count = h.requests.length;
  for (const action of ["inspect", "retry", "resume", "cancel"] as const)
    await expect(first[action](h.rows[1]!)).rejects.toThrow("different session scope");
  await expect(fresh.inspect(h.rows[0]!)).rejects.toThrow("different session scope");
  expect(h.requests).toHaveLength(count);
});

test("continuation rejects a changed source session instead of adopting it", async () => {
  const h = harness();
  const session = await h.open({ continuationSessionId: "native-session" });
  await session.submit({ text: original, unsupportedSources: [] }, () => {});
  h.driftContinuation();
  await expect(session.inspect(h.rows[0]!)).rejects.toThrow();
  await expect(session.turn.request(h.rows[0]!)).rejects.toThrow();
  expect(turnCalls(h)).toHaveLength(0);
});

test("continuation opening requires native turn scopes and the discovered project before source capture", async () => {
  const h = harness();
  await expect(
    h.open({ continuationSessionId: "native-session", projectId: "different-project" })
  ).rejects.toThrow("project changed");
  h.setScopes(["read:work-ledger", "write:work-ledger"]);
  await expect(h.open({ continuationSessionId: "native-session" })).rejects.toThrow(
    "write:sessions"
  );
  expect(h.writes()).toHaveLength(0);
});

test("selected native comments keep exact originals, selector, and independent repeated identities", async () => {
  const h = harness();
  const selectedDiff: NativeSelectedDiffSelector = { kind: "session", revision: "c".repeat(64), fileIndex: 0, hunkIndex: 0 };
  const scope = { continuationSessionId: "native-session", projectId: "native-project", selectedDiff };
  const session = await h.open(scope);
  await session.submit({ text: original, unsupportedSources: [] }, () => {});
  await session.submit({ text: original, unsupportedSources: [] }, () => {});
  expect(h.rows.map(row => row.command.text)).toEqual([original, original]);
  expect(new Set(h.rows.map(row => row.command.inputId)).size).toBe(2);
  expect(new Set(h.rows.map(row => row.command.requestId)).size).toBe(2);
  expect(h.rows.every(row => JSON.stringify(row.command.continuation) === JSON.stringify({ sessionId: "native-session", selectedDiff }))).toBe(true);
  expect(h.writes().map(row => Object.keys(row.input).sort())).toEqual([
    ["continuation", "inputId", "requestId", "text", "unsupportedSources"], ["inputId", "sourceRevision"],
    ["continuation", "inputId", "requestId", "text", "unsupportedSources"], ["inputId", "sourceRevision"],
  ]);
});

test("selected comment lost acknowledgement reopens read-only and an ordinary session can inspect it", async () => {
  const h = harness();
  const selectedDiff: NativeSelectedDiffSelector = { kind: "workspace", baselineId: "checkpoint-base", revision: "d".repeat(64), fileIndex: 0, hunkIndex: 0 };
  const scope = { continuationSessionId: "native-session", selectedDiff };
  const session = await h.open(scope); h.loseCapture();
  await expect(session.submit({ text: original, unsupportedSources: [] }, () => {})).rejects.toThrow();
  session.dispose();
  const reopened = await h.open(scope);
  expect(await reopened.list()).toEqual(h.rows);
  expect((await reopened.inspect(h.rows[0]!)).kind).toBe("captured");
  expect(h.writes()).toHaveLength(1);
  const ordinary = await h.open({ continuationSessionId: "native-session" });
  expect(await ordinary.list()).toEqual(h.rows);
  expect((await ordinary.inspect(h.rows[0]!)).kind).toBe("captured");
  expect(h.writes()).toHaveLength(1);
  expect((await reopened.retry(h.rows[0]!)).kind).toBe("turn");
  expect(h.writes()).toHaveLength(2);
});

test("selected diff scopes are immutable and cannot adopt another hunk or unbound selection", async () => {
  const h = harness();
  const selectedDiff = { kind: "session" as const, revision: "e".repeat(64), fileIndex: 0, hunkIndex: 0 };
  await expect(h.open({ selectedDiff })).rejects.toThrow("verified native session");
  const session = await h.open({ continuationSessionId: "native-session", selectedDiff });
  selectedDiff.hunkIndex = 88;
  await session.submit({ text: original, unsupportedSources: [] }, () => {});
  expect(h.rows[0]!.command.continuation!.selectedDiff!.hunkIndex).toBe(0);
  const other = await h.open({ continuationSessionId: "native-session", selectedDiff });
  expect(await other.list()).toEqual([]);
  await expect(other.inspect(h.rows[0]!)).rejects.toThrow("selected change");
  h.driftDiff();
  await expect(session.inspect(h.rows[0]!)).rejects.toThrow();
  expect(h.writes()).toHaveLength(2);
});

test("selected source scopes are rechecked before mutation and not implied by native ownership", async () => {
  const h = harness();
  const selectedDiff: NativeSelectedDiffSelector = { kind: "workspace", baselineId: "base", revision: "f".repeat(64), fileIndex: 0, hunkIndex: 0 };
  const session = await h.open({ continuationSessionId: "native-session", selectedDiff });
  h.setScopes(["read:work-ledger", "write:work-ledger", "write:sessions", "read:sessions"]);
  await expect(session.submit({ text: original, unsupportedSources: [] }, () => {})).rejects.toThrow("read:checkpoints");
  expect(h.writes()).toHaveLength(0); expect(h.rows).toHaveLength(0);
});
