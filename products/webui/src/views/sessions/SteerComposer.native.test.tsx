import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getClientLifetime,
  tokenStore,
  RELAY_PAIRING_STORAGE_KEY,
} from "../../lib/client-lifetime";

const invoke = mock(
  async (_method: string, _request: unknown, _signal?: AbortSignal): Promise<unknown> => ({
    kind: "legacy",
  })
);
const send = mock(async (_sessionId: string, _body: unknown): Promise<unknown> => ({}));
mock.module("../../lib/goodvibes", () => ({
  GOODVIBES_BASE_URL: "http://localhost/test",
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  hasStoredTokenSync: () => true,
  sdk: { operator: { invoke, sessions: { steer: send, followUp: send } } },
}));
const form = mock(
  (props: { continuationSessionId?: string; projectId?: string; closed?: boolean }) => (
    <div
      data-native-session={props.continuationSessionId}
      data-native-project={props.projectId}
      data-closed={String(props.closed)}
    >
      Native intake workflow
    </div>
  )
);
mock.module("../work/NativeIntakeForm", () => ({ NativeIntakeForm: form }));
const { SteerComposer } = await import("./SteerComposer");
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  await tokenStore.setToken("synthetic-native-owner");
  invoke.mockReset();
  invoke.mockResolvedValue({ kind: "legacy" });
  send.mockClear();
  form.mockClear();
});
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
  await tokenStore.clearToken();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle(check: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    flushSync(() => {});
    if (check()) return;
  }
  expect(check()).toBe(true);
}
function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let props = { sessionId: "native-a", canSteer: true, closed: false, streamPaused: false };
  const rerender = (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <SteerComposer {...props} />
        </QueryClientProvider>
      )
    );
  };
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    client.clear();
    el.remove();
  };
  cleanups.push(unmount);
  rerender();
  return { el, rerender, unmount };
}
const native = (sessionId = "native-a", busy = true) => ({
  kind: "native",
  projectId: "native-project",
  sessionId,
  busy,
});

test("native discovery gates sending and mounts the existing workflow with verified session/project scope", async () => {
  const pending = deferred<unknown>();
  invoke.mockImplementation(() => pending.promise);
  const h = render();
  expect(h.el.textContent).toContain("Verifying session continuation");
  expect(h.el.querySelector("textarea")).toBeNull();
  expect(invoke.mock.calls[0]?.[0]).toBe("workLedger.turn.session");
  expect(invoke.mock.calls[0]?.[1]).toEqual({ sessionId: "native-a" });
  expect(send).not.toHaveBeenCalled();
  pending.resolve(native());
  await settle(() => Boolean(h.el.querySelector('[data-native-session="native-a"]')));
  expect(h.el.querySelector('[data-native-project="native-project"]')).not.toBeNull();
  expect(h.el.textContent).toContain("queues conversation delivery behind any active turn");
  expect(h.el.textContent).toContain("active reply is excluded");
  expect(h.el.textContent).toContain("never supplies or rewrites the transcript");
  expect(h.el.querySelector("textarea")).toBeNull();
  expect(send).not.toHaveBeenCalled();
  h.rerender({ closed: true, streamPaused: true });
  expect(h.el.querySelector('[data-closed="true"]')).not.toBeNull();
  expect(h.el.textContent).toContain("Live updates are paused");
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("only an explicit authoritative legacy result enables the unchanged legacy composer", async () => {
  const h = render();
  await settle(() => Boolean(h.el.querySelector("textarea")));
  expect(form).not.toHaveBeenCalled();
  expect(h.el.textContent).toContain("Steer: an agent is working");
  const textarea = h.el.querySelector("textarea")!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "  Legacy still trims  "
    );
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  flushSync(() =>
    h.el
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  );
  await settle(() => send.mock.calls.length === 1);
  expect(send.mock.calls[0]?.[0]).toBe("native-a");
  expect(send.mock.calls[0]?.[1]).toEqual({ body: "Legacy still trims" });
});

for (const response of [
  undefined,
  {},
  { kind: "native" },
  { ...native(), sessionId: "different" },
  { ...native(), busy: "yes" },
  { kind: "legacy", permit: {} },
])
  test("unknown, mismatched or malformed discovery never falls back to legacy", async () => {
    invoke.mockResolvedValue(response);
    const h = render();
    await settle(() => Boolean(h.el.querySelector('[role="alert"]')));
    expect(h.el.textContent).toContain("Nothing was sent");
    expect(h.el.querySelector("textarea")).toBeNull();
    expect(form).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

for (const message of [
  "Native owner mismatch",
  "Native delivery requires paired admin and write:sessions",
  "Native runtime unavailable",
  "Discovery route unavailable",
])
  test("failed native discovery retains an honest error and only explicit retry rechecks", async () => {
    invoke.mockRejectedValue(new Error(message));
    const h = render();
    await settle(() => h.el.textContent?.includes(message) === true);
    expect(h.el.querySelector("textarea")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValue(native());
    flushSync(() => h.el.querySelector("button")!.click());
    await settle(() => Boolean(h.el.querySelector('[data-native-session="native-a"]')));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

test("late discovery cannot change a newer session selection", async () => {
  const pending = deferred<unknown>();
  invoke.mockImplementationOnce(() => pending.promise);
  const h = render();
  const signal = invoke.mock.calls[0]?.[2];
  invoke.mockResolvedValue(native("native-b", false));
  h.rerender({ sessionId: "native-b" });
  await settle(() => Boolean(h.el.querySelector('[data-native-session="native-b"]')));
  expect(signal?.aborted).toBe(true);
  pending.resolve({ kind: "legacy" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  flushSync(() => {});
  expect(h.el.querySelector("textarea")).toBeNull();
  expect(h.el.querySelector('[data-native-session="native-b"]')).not.toBeNull();
});

for (const change of ["account", "relay", "unmount"] as const)
  test(`connection ${change} retires unresolved discovery and never renders a late legacy fallback`, async () => {
    const pending = deferred<unknown>();
    invoke.mockImplementationOnce(() => pending.promise);
    const h = render();
    const signal = invoke.mock.calls[0]?.[2];
    invoke.mockResolvedValue(native());
    if (change === "account") await tokenStore.setToken("replacement-owner");
    if (change === "relay") {
      localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, "changed relay identity");
      getClientLifetime();
    }
    if (change === "unmount") h.unmount();
    await settle(() => signal?.aborted === true);
    pending.resolve({ kind: "legacy" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
    expect(h.el.querySelector("textarea")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

test("hung discovery times out honestly and a late result cannot enable sending", async () => {
  const realTimeout = globalThis.setTimeout;
  let deadline: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 15_000 && typeof callback === "function") deadline = () => callback(...args);
    return realTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  try {
    const pending = deferred<unknown>();
    invoke.mockImplementationOnce(() => pending.promise);
    const h = render();
    expect(deadline).toBeDefined();
    flushSync(() => deadline!());
    expect(h.el.textContent).toContain("Session verification timed out");
    expect(invoke.mock.calls[0]?.[2]?.aborted).toBe(true);
    pending.resolve({ kind: "legacy" });
    await new Promise((resolve) => realTimeout(resolve, 5));
    flushSync(() => {});
    expect(h.el.querySelector("textarea")).toBeNull();
    expect(h.el.textContent).toContain("Session verification timed out");
    expect(send).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
});
