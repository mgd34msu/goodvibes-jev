/** Actual hook/event loop with the real platform reader; only transport is synthetic. */
import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { invalidateClientLifetime } from "../client-lifetime";
import type { BeforeInstallPromptEvent, UseInstallPrompt } from "./install-prompt";

const transport = mock(() => { throw new Error('Platform facts must stay local'); });
mock.module('../goodvibes', () => ({ runBrowserJudgment: transport }));
const { useInstallPrompt } = await import('./install-prompt');
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
  for (const key of ['platform', 'maxTouchPoints'] as const) delete (navigator as unknown as Record<string, unknown>)[key];
  transport.mockClear();
  await settle();
});
test('desktop-mode iPad reaches iOS instructions without a host request', async () => {
  Object.defineProperties(navigator, { platform: { value: 'MacIntel', configurable: true }, maxTouchPoints: { value: 5, configurable: true } });
  const ui = mount();
  await waitFor(() => ui.el.textContent === 'ios-instructions');
  expect(transport).not.toHaveBeenCalled();
  flushSync(() => invalidateClientLifetime());
  await settle(); expect(ui.el.textContent).toBe('ios-instructions');
});
test.each(['beforeinstallprompt', 'appinstalled'] as const)('native %s takes precedence over device instructions', async eventName => {
  Object.defineProperties(navigator, { platform: { value: 'MacIntel', configurable: true }, maxTouchPoints: { value: 5, configurable: true } });
  const ui = mount();
  if (eventName === 'beforeinstallprompt') expect(capturePrompt().event.defaultPrevented).toBe(true);
  else flushSync(() => window.dispatchEvent(new Event('appinstalled')));
  await settle(); expect(ui.el.textContent).toBe(eventName === 'beforeinstallprompt' ? 'prompt' : 'installed');
  expect(transport).not.toHaveBeenCalled();
});
test('unmount removes native event listeners', async () => {
  const ui = mount(); ui.unmount();
  expect(capturePrompt().event.defaultPrevented).toBe(false);
});
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
