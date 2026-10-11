/** Actual hook/event loop with the real platform reader; only transport is synthetic. */
import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { invalidateClientLifetime } from "../client-lifetime";
import type { BeforeInstallPromptEvent, UseInstallPrompt } from "./install-prompt";

type Request = BrowserJudgmentRequest<"webui.pwa.install-platform">;
interface Pending {
  request: Request;
  signal: AbortSignal;
  finish: (value: unknown) => void;
}
let pending: Pending[] = [];
mock.module("../goodvibes", () => ({
  runBrowserJudgment: (request: Request, signal: AbortSignal) =>
    new Promise<unknown>((finish) => pending.push({ request, signal, finish })),
}));
const { useInstallPrompt } = await import("./install-prompt");
function response(request: Request) {
  return {
    protocolVersion: 1,
    batteryVersion: 1,
    battery: request.battery,
    requestId: request.requestId,
    status: "settled",
    value: { platform: "ios-share-menu" },
    outcome: "act",
    readings: {
      platform: {
        kind: "choice",
        choice: "ios-share-menu",
        confidence: 0.99,
        probabilities: { "ios-share-menu": 0.99, other: 0.01 },
        outcome: "act",
      },
    },
    evidence: [
      {
        decisionId: "synthetic-platform",
        model: "fixture",
        requestedModel: "fixture",
        latencyMs: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ],
  };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error("Hook did not reach expected state");
}
const cleanups: (() => void)[] = [];
function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  let hook: UseInstallPrompt | undefined;
  function Harness() {
    hook = useInstallPrompt();
    return React.createElement("output", null, hook.affordance);
  }
  flushSync(() => root.render(React.createElement(Harness)));
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      flushSync(() => root.unmount());
      el.remove();
    }
  };
  cleanups.push(unmount);
  return {
    el,
    unmount,
    get hook() {
      if (!hook) throw new Error("Hook missing");
      return hook;
    },
  };
}
function capturePrompt() {
  const choice = Promise.withResolvers<{ outcome: "accepted" | "dismissed" }>();
  const prompt = mock(async () => {});
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt,
    userChoice: choice.promise,
  }) as BeforeInstallPromptEvent;
  flushSync(() => window.dispatchEvent(event));
  return { event, prompt, choice };
}
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  pending.forEach((p) => p.finish(response(p.request)));
  await settle();
  pending = [];
});

test("an actual platform reading reaches the iOS instructions affordance", async () => {
  const ui = mount();
  await waitFor(() => pending.length === 1);
  expect(ui.el.textContent).toBe("none");
  expect(pending[0]!.request.input).toEqual({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
  pending[0]!.finish(response(pending[0]!.request));
  await waitFor(() => ui.el.textContent === "ios-instructions");
});
test.each(["beforeinstallprompt", "appinstalled"] as const)(
  "late platform result cannot override captured %s fact",
  async (eventName) => {
    const ui = mount();
    await waitFor(() => pending.length === 1);
    const reading = pending[0]!;
    if (eventName === "beforeinstallprompt")
      expect(capturePrompt().event.defaultPrevented).toBe(true);
    else flushSync(() => window.dispatchEvent(new Event("appinstalled")));
    expect(reading.signal.aborted).toBe(true);
    reading.finish(response(reading.request));
    await settle();
    expect(ui.el.textContent).toBe(eventName === "beforeinstallprompt" ? "prompt" : "installed");
  }
);
test("unmount aborts platform transport and removes native event listeners", async () => {
  const ui = mount();
  await waitFor(() => pending.length === 1);
  const reading = pending[0]!;
  ui.unmount();
  expect(reading.signal.aborted).toBe(true);
  reading.finish(response(reading.request));
  await settle();
  const event = capturePrompt();
  expect(event.event.defaultPrevented).toBe(false);
  expect(event.prompt).not.toHaveBeenCalled();
  expect(ui.el.textContent).toBe("");
});
test.each([false, true])(
  "%s settled reading is invalidated on identity replacement and late old answers stay ignored",
  async (alreadySettled) => {
    const ui = mount();
    await waitFor(() => pending.length === 1);
    const old = pending[0]!;
    if (alreadySettled) {
      old.finish(response(old.request));
      await waitFor(() => ui.el.textContent === "ios-instructions");
    }
    flushSync(() => invalidateClientLifetime());
    await waitFor(() => pending.length === 2);
    if (!alreadySettled) expect(old.signal.aborted).toBe(true);
    expect(ui.el.textContent).toBe("none");
    old.finish(response(old.request));
    await settle();
    expect(ui.el.textContent).toBe("none");
    pending[1]!.finish(response(pending[1]!.request));
    await waitFor(() => ui.el.textContent === "ios-instructions");
  }
);
test("double prompt execution invokes the captured native prompt exactly once", async () => {
  const ui = mount();
  const event = capturePrompt();
  const first = ui.hook.promptInstall();
  expect(await ui.hook.promptInstall()).toBe("unavailable");
  expect(event.prompt).toHaveBeenCalledTimes(1);
  event.choice.resolve({ outcome: "accepted" });
  expect(await first).toBe("accepted");
  await settle();
  expect(await ui.hook.promptInstall()).toBe("unavailable");
  expect(event.prompt).toHaveBeenCalledTimes(1);
});
test("a newer captured event survives completion of an older in-flight prompt", async () => {
  const ui = mount();
  const older = capturePrompt();
  const first = ui.hook.promptInstall();
  const newer = capturePrompt();
  expect(await ui.hook.promptInstall()).toBe("unavailable");
  older.choice.resolve({ outcome: "dismissed" });
  expect(await first).toBe("dismissed");
  await settle();
  expect(ui.el.textContent).toBe("prompt");
  const second = ui.hook.promptInstall();
  expect(newer.prompt).toHaveBeenCalledTimes(1);
  newer.choice.resolve({ outcome: "accepted" });
  expect(await second).toBe("accepted");
});
test("appinstalled during a pending native prompt stays installed after its completion", async () => {
  const ui = mount();
  const event = capturePrompt();
  const action = ui.hook.promptInstall();
  flushSync(() => window.dispatchEvent(new Event("appinstalled")));
  event.choice.resolve({ outcome: "accepted" });
  expect(await action).toBe("accepted");
  await settle();
  expect(ui.el.textContent).toBe("installed");
  expect(await ui.hook.promptInstall()).toBe("unavailable");
});
test("a rejecting native prompt is consumed and allows a later fresh event", async () => {
  const ui = mount();
  const first = capturePrompt();
  first.prompt.mockImplementation(async () => {
    throw new Error("native rejection");
  });
  expect(await ui.hook.promptInstall()).toBe("unavailable");
  expect(await ui.hook.promptInstall()).toBe("unavailable");
  const second = capturePrompt();
  const action = ui.hook.promptInstall();
  second.choice.resolve({ outcome: "dismissed" });
  expect(await action).toBe("dismissed");
  expect(second.prompt).toHaveBeenCalledTimes(1);
});
