/** Pairing must replace first-load queries made before the token was stored. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let validation = deferred<unknown>();
let status = "";
let storedToken: string | null = null;

mock.module("../lib/goodvibes", () => ({
  setExplicitAuthToken: (token: string) => {
    storedToken = token;
    return validation.promise;
  },
  sdk: { operator: { pairing: { posture: { get: () => Promise.resolve({ posture: {} }) } } } },
}));

const { usePairingHandoff, resetPairingCaptureForTest } = await import("./usePairingHandoff");

function Probe() {
  status = usePairingHandoff().status;
  return null;
}

const cleanups: (() => void)[] = [];

function render(client: QueryClient, strict: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const probe = React.createElement(Probe);
  flushSync(() =>
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        strict ? React.createElement(React.StrictMode, null, probe) : probe
      )
    )
  );
  cleanups.push(() => {
    flushSync(() => root.unmount());
    container.remove();
  });
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Pairing did not settle");
    await new Promise<void>((resolve) => setImmediate(resolve));
    flushSync(() => {});
  }
}

beforeEach(() => {
  validation = deferred();
  status = "";
  storedToken = null;
  resetPairingCaptureForTest();
  window.history.replaceState(null, "", "/?view=chat#pair=paired-token");
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  window.history.replaceState(null, "", "/");
});

describe("pairing during a pending first auth probe", () => {
  for (const strict of [false, true]) {
    test(`replaces tokenless queries and ignores their late 401 (StrictMode=${String(strict)})`, async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      cleanups.push(() => client.clear());
      // These first-load queries are already active when the pairing effect runs,
      // just as App's boot/auth/health observers subscribe before passive effects.
      const probes = [["auth"], ["boot"], ["daemon-health", "auth"]].map((queryKey) => {
        const old = deferred<{ authenticated: boolean }>();
        const tokens: (string | null)[] = [];
        const observer = new QueryObserver(client, {
          queryKey,
          queryFn: () => {
            tokens.push(storedToken);
            return storedToken === null ? old.promise : Promise.resolve({ authenticated: true });
          },
        });
        cleanups.push(observer.subscribe(() => {}));
        return { old, tokens, observer };
      });
      expect(probes.map(({ tokens }) => tokens)).toEqual([[null], [null], [null]]);
      const invalidated = new Set<string>();
      cleanups.push(
        client.getQueryCache().subscribe((event) => {
          if (event.type === "updated" && event.action.type === "invalidate")
            invalidated.add(event.query.queryHash);
        })
      );
      render(client, strict);
      expect(status).toBe("pending");
      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe("?view=chat");

      validation.resolve({ authenticated: true });
      // Answer the old requests after validation has succeeded and pairing has
      // invalidated the queries. Without cancellation, those 401s become the final
      // cached auth result and no token-bearing read is ever started.
      await until(() => invalidated.size === probes.length);
      for (const { old } of probes)
        old.reject(Object.assign(new Error("Unauthorized"), { status: 401 }));
      await Promise.allSettled(probes.map(({ old }) => old.promise));
      await until(() => status === "idle");
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const { observer, tokens } of probes) {
        expect(observer.getCurrentResult().status).toBe("success");
        expect(observer.getCurrentResult().data).toEqual({ authenticated: true });
        expect(tokens).toContain("paired-token");
      }
      expect(storedToken).toBe("paired-token");
    });
  }

  test("a cancelled older authenticated response cannot undo a newer sign-out", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cleanups.push(() => client.clear());
    const old = deferred<{ authenticated: boolean }>();
    let calls = 0;
    const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 });
    const observer = new QueryObserver(client, {
      queryKey: ["auth"],
      queryFn: () => {
        calls += 1;
        if (calls === 1) return old.promise;
        return storedToken
          ? Promise.resolve({ authenticated: true })
          : Promise.reject(unauthorized);
      },
    });
    cleanups.push(observer.subscribe(() => {}));
    render(client, false);
    validation.resolve({ authenticated: true });
    await until(() => status === "idle");
    expect(observer.getCurrentResult().status).toBe("success");

    // Same order as App's sign-out: clear the token, then invalidate auth.
    storedToken = null;
    await client.invalidateQueries();
    expect(observer.getCurrentResult().error).toBe(unauthorized);
    old.resolve({ authenticated: true });
    await old.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observer.getCurrentResult().status).toBe("error");
    expect(observer.getCurrentResult().error).toBe(unauthorized);
    expect(storedToken).toBeNull();
  });
});
