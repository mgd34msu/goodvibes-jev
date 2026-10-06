import { afterEach, beforeEach, expect, test } from "bun:test";
import { getClientLifetime, tokenStore } from "./client-lifetime";
import { inspectNativeSession } from "./native-session";

const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await tokenStore.setToken("synthetic-session-reader");
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});

for (const response of [
  { kind: "legacy" },
  { kind: "native", projectId: "native-project", sessionId: "native-session", busy: true },
] as const)
  test("actual browser facade performs one identity-only discovery without native-auth prerequisites", async () => {
    const requests: {
      path: string;
      method: string | undefined;
      input: unknown;
      auth: string | null;
    }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method,
        input: JSON.parse(String(init?.body)) as unknown,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json(response);
    }) as typeof fetch;
    const result = await inspectNativeSession(
      getClientLifetime(),
      "native-session",
      new AbortController().signal
    );
    expect(result).toEqual(response);
    expect(requests).toEqual([
      {
        path: "/api/work-ledger/turn/session",
        method: "POST",
        input: { sessionId: "native-session" },
        auth: "Bearer synthetic-session-reader",
      },
    ]);
  });

for (const response of [
  { status: 403, code: "NATIVE_OWNER_MISMATCH" },
  { status: 503, code: "NATIVE_RUNTIME_UNAVAILABLE" },
  { status: 404, code: "NOT_FOUND" },
])
  test("discovery rejection is surfaced without fallback or an automatic second request", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++;
      return Response.json(
        { error: "Native discovery unavailable", code: response.code },
        { status: response.status }
      );
    }) as typeof fetch;
    await expect(
      inspectNativeSession(getClientLifetime(), "native-session", new AbortController().signal)
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

test("malformed response, wrong session and extra authority fields are never interpreted as legacy", async () => {
  for (const response of [
    {},
    { kind: "legacy", permit: {} },
    { kind: "native", projectId: "p", sessionId: "another-session", busy: false },
  ]) {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(response)) as typeof fetch;
    await expect(
      inspectNativeSession(getClientLifetime(), "native-session", new AbortController().signal)
    ).rejects.toThrow();
  }
});

test("discovery will not run with an already retired connection or aborted view", async () => {
  const lifetime = getClientLifetime();
  await tokenStore.setToken("replacement-owner");
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls++;
    return Response.json({ kind: "legacy" });
  }) as typeof fetch;
  await expect(
    inspectNativeSession(lifetime, "native-session", new AbortController().signal)
  ).rejects.toThrow("connection changed");
  const controller = new AbortController();
  controller.abort();
  await expect(
    inspectNativeSession(getClientLifetime(), "native-session", controller.signal)
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
