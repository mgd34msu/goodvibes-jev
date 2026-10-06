/** Actual browser HTTP facade + SDK validators, replaying unchanged production daemon response bytes. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getClientLifetime, tokenStore } from "./client-lifetime";
import { openNativeIntake, type NativeIntakeJournal } from "./native-intake";
import type { NativeIntakeBrowserRecord } from "./native-intake-journal";
import type {
  NativeExecutionBrowserJournal,
  NativeExecutionBrowserRecord,
} from "./native-execution-journal";
import type { NativeConversationIntakeCaptureRequest } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import type { NativeWorkExecutionRequest } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";

interface Wire {
  status: number;
  body: string;
}
const fixture = JSON.parse(
  readFileSync(
    new URL("../../e2e/support/fixtures/native-execution/running.json", import.meta.url),
    "utf8"
  )
) as {
  input: NativeConversationIntakeCaptureRequest;
  identity: NativeWorkExecutionRequest;
  auth: Wire;
  project: Wire;
  lookupBefore: Wire;
  capture: Wire;
  getCaptured: Wire;
  admit: Wire;
  get: Wire;
  notStarted: Wire;
  start: Wire;
  status: Wire;
};
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  await tokenStore.setToken("owned-synthetic-browser-execution-token");
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) close();
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});
function harness() {
  let original: NativeIntakeBrowserRecord | null = null;
  let target: NativeExecutionBrowserRecord | null = null;
  let phase: "lookupBefore" | "getCaptured" | "get" = "lookupBefore";
  let started = false,
    loseStart = false,
    brokenStatus = false,
    failTarget = false;
  let authBody = fixture.auth.body,
    projectBody = fixture.project.body;
  let authHook: (() => void) | undefined;
  const requests: { path: string; body: unknown }[] = [];
  const journal: NativeIntakeJournal = {
    async list() {
      return original ? [structuredClone(original)] : [];
    },
    async save(record) {
      original = structuredClone(record);
    },
    async confirm(record) {
      expect(record).toEqual(original!);
    },
  };
  const executionJournal: NativeExecutionBrowserJournal = {
    async get() {
      return structuredClone(target);
    },
    async save(record) {
      if (failTarget) throw new Error("Execution journal unavailable");
      target = structuredClone(record);
    },
    async confirm(record) {
      expect(record).toEqual(target!);
    },
  };
  const reply = (wire: Wire) =>
    new Response(wire.body, {
      status: wire.status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ path, body });
    if (path === "/api/control-plane/auth") {
      authHook?.();
      return reply({ ...fixture.auth, body: authBody });
    }
    if (path === "/api/work-ledger/project")
      return reply({ ...fixture.project, body: projectBody });
    if (path === "/api/work-ledger/intake/capture") {
      expect(body).toEqual(fixture.input);
      expect(original?.command).toEqual(fixture.input);
      phase = "getCaptured";
      return reply(fixture.capture);
    }
    if (path === "/api/work-ledger/intake/admit") {
      phase = "get";
      return reply(fixture.admit);
    }
    if (path === "/api/work-ledger/intake/get") return reply(fixture[phase]);
    if (path.startsWith("/api/work-ledger/execution/")) {
      expect(body).toEqual(fixture.identity);
      if (path.endsWith("/status")) {
        if (brokenStatus)
          return new Response(
            JSON.stringify({ error: "owned unavailable", code: "NATIVE_EXECUTION_UNAVAILABLE" }),
            { status: 503 }
          );
        return reply(started ? fixture.status : fixture.notStarted);
      }
      if (path.endsWith("/start")) {
        expect(target?.target).toEqual({
          workId: fixture.identity.workId,
          attemptId: fixture.identity.attemptId,
          expectedRevision: fixture.identity.expectedRevision,
        });
        started = true;
        if (loseStart) {
          loseStart = false;
          throw new TypeError("Owned lost acknowledgement");
        }
        return reply(fixture.start);
      }
    }
    throw new Error(`Unexpected route ${path}`);
  }) as typeof fetch;
  async function open() {
    const ids = [fixture.input.requestId, fixture.input.inputId];
    const session = await openNativeIntake(
      getClientLifetime(),
      new AbortController().signal,
      journal,
      () => ids.shift()!,
      executionJournal
    );
    cleanups.push(() => session.dispose());
    return session;
  }
  return {
    open,
    requests,
    original: () => original!,
    target: () => target,
    auth(update: Record<string, unknown>) {
      authBody = JSON.stringify({ ...JSON.parse(authBody), ...update });
    },
    project() {
      projectBody = JSON.stringify({ projectId: "another-native-project" });
    },
    authHook(callback: () => void) {
      authHook = callback;
    },
    loseStart() {
      loseStart = true;
    },
    brokenStatus() {
      brokenStatus = true;
    },
    failTarget() {
      failTarget = true;
    },
  };
}
const starts = (h: ReturnType<typeof harness>) =>
  h.requests.filter((row) => row.path.endsWith("/execution/start"));
async function admit(h: ReturnType<typeof harness>) {
  const session = await h.open();
  const result = await session.submit(
    { text: fixture.input.text, unsupportedSources: fixture.input.unsupportedSources },
    () => {}
  );
  expect(result.kind).toBe("work");
  return session;
}

test("browser facade sends only canonical admitted identity after strict target retention", async () => {
  const h = harness();
  const session = await admit(h);
  expect(starts(h)).toHaveLength(0);
  const observed = await session.execution.request(h.original());
  expect(observed).toMatchObject({ kind: "recorded", snapshot: JSON.parse(fixture.start.body) });
  expect(starts(h)).toHaveLength(1);
  expect(starts(h)[0]?.body).toEqual(fixture.identity);
  expect(h.requests.some((row) => /\/api\/(contracts|tasks|sessions)\//.test(row.path))).toBe(
    false
  );
});

for (const change of ["fleet", "owner", "project", "shared", "user", "admin"] as const)
  test(`fresh browser authority blocks execution after ${change} changes`, async () => {
    const h = harness();
    const session = await admit(h);
    if (change === "fleet") h.auth({ scopes: ["read:work-ledger", "write:work-ledger"] });
    if (change === "owner") h.auth({ principalId: "pairing:replacement" });
    if (change === "project") h.project();
    if (change === "shared") h.auth({ principalId: "shared-token" });
    if (change === "user") h.auth({ principalKind: "user" });
    if (change === "admin") h.auth({ admin: false });
    await expect(session.execution.request(h.original())).rejects.toThrow();
    expect(starts(h)).toHaveLength(0);
  });

test("lost browser start response survives close/reopen and status-only reconciliation", async () => {
  const h = harness();
  const session = await admit(h);
  h.loseStart();
  await expect(session.execution.request(h.original())).rejects.toThrow("outcome is unknown");
  expect(starts(h)).toHaveLength(1);
  session.dispose();
  const reopened = await h.open();
  expect(await reopened.execution.inspect(h.original())).toMatchObject({
    kind: "recorded",
    snapshot: JSON.parse(fixture.status.body),
  });
  await reopened.execution.request(h.original());
  expect(starts(h)).toHaveLength(1);
});

test("unknown HTTP status and target storage failures never become native start", async () => {
  for (const fault of ["brokenStatus", "failTarget"] as const) {
    const h = harness();
    const session = await admit(h);
    h[fault]();
    await expect(session.execution.request(h.original())).rejects.toThrow();
    expect(starts(h)).toHaveLength(0);
  }
});

test("A to B to A connection change retires native execution and cannot regain authority", async () => {
  const h = harness();
  const session = await admit(h);
  await tokenStore.setToken("replacement-owner");
  await tokenStore.setToken("owned-synthetic-browser-execution-token");
  await expect(session.execution.request(h.original())).rejects.toThrow("connection changed");
  expect(starts(h)).toHaveLength(0);
});
