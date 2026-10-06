import { afterEach, beforeEach, expect, test } from "bun:test";
import { getClientLifetime, tokenStore } from "./client-lifetime";
import { openNativeIntake, type NativeIntakeJournal } from "./native-intake";
import type { NativeIntakeBrowserRecord } from "./native-intake-journal";
import type {
  NativeConversationIntakeCaptureRequest,
  NativeConversationIntakeResult,
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
const original = "  Fix 🧪.\nKeep both. Keep both.  ";
function harness() {
  let principalId = "paired-owner";
  let projectId = "native-project";
  let admin = true;
  let scopes = ["read:work-ledger", "write:work-ledger"];
  let principalKind = "token";
  let failSave = false;
  let lostCapture = false;
  let drift = false;
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
        },
      };
      if (lostCapture) {
        lostCapture = false;
        throw new TypeError("Lost capture acknowledgement");
      }
    } else if (path === "/api/work-ledger/intake/admit") {
      state = { ...state!, kind: "turn", route: "answer", text: command!.text };
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
    return Response.json(
      state
        ? { ...state, ...(drift ? { requestId: "another-request" } : {}) }
        : { kind: "not-found" }
    );
  }) as typeof fetch;
  let counter = 0;
  async function open() {
    const session = await openNativeIntake(
      getClientLifetime(),
      new AbortController().signal,
      journal,
      () => `logical-${++counter}`
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
    loseCapture() {
      lostCapture = true;
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

test("submission journals exact original source before capture, automatically admits and never dispatches a turn", async () => {
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
