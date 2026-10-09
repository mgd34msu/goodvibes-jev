/** Actual panel, query cache, names-only reader and client lifetime; synthetic transport only. */
import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { invalidateClientLifetime } from "../lib/client-lifetime";

type Request = BrowserJudgmentRequest<"webui.credentials.provider-key">;
let pending: { request: Request; signal: AbortSignal; finish: (raw: unknown) => void }[] = [];
const forbiddenValue = "synthetic-secret-must-never-leave-credential-response";
const wire = (names: readonly string[]) => ({
  available: true,
  credentials: names.map((key) => ({
    key,
    configured: true,
    usable: true,
    source: "fixture",
    value: forbiddenValue,
    secret: forbiddenValue,
  })),
});
mock.module("../lib/goodvibes", () => ({
  sdk: { operator: { credentials: { get: async () => wire([]) } } },
  runBrowserJudgment: (request: Request, signal: AbortSignal) =>
    new Promise<unknown>((finish) => pending.push({ request, signal, finish })),
}));
const { CredentialStatusPanel } = await import("./CredentialStatusPanel");
function response(request: Request, matches = request.input.keys.map(() => true), held = false) {
  return {
    protocolVersion: 1,
    batteryVersion: 1,
    battery: request.battery,
    requestId: request.requestId,
    status: held ? "held" : "settled",
    ...(held ? { reason: "uncertain" } : { value: { matches } }),
    outcome: held ? "confirm" : "act",
    readings: Object.fromEntries(
      matches.map((match, index) => [
        `key_${index}`,
        {
          kind: "yes-no",
          probability: held ? 0.5 : match ? 0.99 : 0.01,
          verdict: held ? "uncertain" : match ? "yes" : "no",
          outcome: held ? "confirm" : "act",
        },
      ])
    ),
    evidence: matches.map((_, index) => ({
      decisionId: `synthetic-${index}`,
      model: "fixture",
      requestedModel: "fixture",
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    })),
  };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error("Credential panel did not reach expected state");
}
const cleanups: (() => void)[] = [];
function mount(names: readonly string[], providerId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  client.setQueryData(["credentials"], wire(names));
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (selectedProviderId?: string) =>
    flushSync(() =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(CredentialStatusPanel, { selectedProviderId })
        )
      )
    );
  render(providerId);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      flushSync(() => root.unmount());
      client.clear();
      el.remove();
    }
  };
  cleanups.push(unmount);
  const selected = (key: string) => {
    const row = [...el.querySelectorAll("li")].find(
      (item) => item.querySelector(".credential-status__key")?.textContent === key
    );
    return Boolean(row?.querySelector("[aria-current]"));
  };
  return {
    el,
    selected,
    render,
    unmount,
    setNames: (newNames: readonly string[]) => client.setQueryData(["credentials"], wire(newNames)),
  };
}
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  pending.forEach((item) => item.finish(response(item.request)));
  await settle();
  pending = [];
});

test("mounting without a provider renders unclassified credentials without asking for a reading", async () => {
  const ui = mount(["CUSTOM_ONLY"]);
  await settle();
  expect(ui.el.textContent).toContain("CUSTOM_ONLY");
  expect(ui.selected("CUSTOM_ONLY")).toBe(false);
  expect(pending).toHaveLength(0);
});

test("declared GOOGLE alias selects Gemini without guessing or transmitting any key value", async () => {
  const ui = mount(["GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], "gemini");
  await settle();
  expect(ui.selected("GOOGLE_API_KEY")).toBe(true);
  expect(ui.selected("GEMINI_API_KEY")).toBe(true);
  expect(ui.selected("OPENAI_API_KEY")).toBe(false);
  expect(pending).toHaveLength(0);
  expect(ui.el.textContent).not.toContain(forbiddenValue);
});
test("canonical Azure key never falsely highlights OpenAI via a shared substring", async () => {
  const ui = mount(["AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"], "openai");
  await settle();
  expect(ui.selected("AZURE_OPENAI_API_KEY")).toBe(false);
  expect(ui.selected("OPENAI_API_KEY")).toBe(true);
  expect(pending).toHaveLength(0);
  ui.render("microsoft-foundry");
  expect(ui.selected("AZURE_OPENAI_API_KEY")).toBe(true);
  expect(ui.selected("OPENAI_API_KEY")).toBe(false);
});
test("unknown names fan out in canonical row order and only names cross the browser transport", async () => {
  const ui = mount(
    ["OPENAI_API_KEY", "CUSTOM_ALPHA", "AZURE_OPENAI_API_KEY", "CUSTOM_BETA"],
    "openai"
  );
  await waitFor(() => pending.length === 1);
  const call = pending[0]!;
  expect(call.request.input).toEqual({
    providerId: "openai",
    keys: ["CUSTOM_ALPHA", "CUSTOM_BETA"],
  });
  expect(JSON.stringify(call.request)).not.toContain(forbiddenValue);
  expect(ui.selected("CUSTOM_ALPHA")).toBe(false);
  expect(ui.selected("CUSTOM_BETA")).toBe(false);
  call.finish(response(call.request, [false, true]));
  await waitFor(() => ui.selected("CUSTOM_BETA"));
  expect(ui.selected("CUSTOM_ALPHA")).toBe(false);
  expect(ui.selected("OPENAI_API_KEY")).toBe(true);
  expect(ui.selected("AZURE_OPENAI_API_KEY")).toBe(false);
  expect(ui.el.textContent).not.toContain(forbiddenValue);
});
test("late old-provider result cannot highlight the new provider snapshot", async () => {
  const ui = mount(["CUSTOM_ONLY"], "openai");
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  ui.render("gemini");
  await waitFor(() => pending.length === 2);
  expect(old.signal.aborted).toBe(true);
  old.finish(response(old.request));
  await settle();
  expect(ui.selected("CUSTOM_ONLY")).toBe(false);
  expect(pending[1]!.request.input.providerId).toBe("gemini");
  pending[1]!.finish(response(pending[1]!.request, [false]));
  await settle();
  expect(ui.selected("CUSTOM_ONLY")).toBe(false);
});
test("late old-key result cannot highlight a replacement key at the same index", async () => {
  const ui = mount(["CUSTOM_OLD"], "openai");
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  ui.setNames(["CUSTOM_NEW"]);
  await waitFor(() => pending.length === 2);
  expect(old.signal.aborted).toBe(true);
  old.finish(response(old.request));
  await settle();
  expect(ui.selected("CUSTOM_NEW")).toBe(false);
  expect(ui.el.textContent).not.toContain("CUSTOM_OLD");
  pending[1]!.finish(response(pending[1]!.request));
  await waitFor(() => ui.selected("CUSTOM_NEW"));
});
test("reordering pending key names cannot transplant an old index-based match", async () => {
  const ui = mount(["CUSTOM_A", "CUSTOM_B"], "openai");
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  ui.setNames(["CUSTOM_B", "CUSTOM_A"]);
  await waitFor(() => pending.length === 2);
  old.finish(response(old.request, [true, false]));
  await settle();
  expect(ui.selected("CUSTOM_A")).toBe(false);
  expect(ui.selected("CUSTOM_B")).toBe(false);
  pending[1]!.finish(response(pending[1]!.request, [true, false]));
  await waitFor(() => ui.selected("CUSTOM_B"));
  expect(ui.selected("CUSTOM_A")).toBe(false);
});
test("unmount aborts a pending reading and late completion cannot update another panel instance", async () => {
  const first = mount(["CUSTOM_ONLY"], "openai");
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  first.unmount();
  expect(old.signal.aborted).toBe(true);
  const next = mount(["CUSTOM_ONLY"], "openai");
  await waitFor(() => pending.length === 2);
  old.finish(response(old.request));
  await settle();
  expect(next.selected("CUSTOM_ONLY")).toBe(false);
});
test.each([false, true])(
  "identity revocation discards %s settled alignment and requires fresh evidence",
  async (alreadySettled) => {
    const ui = mount(["CUSTOM_ONLY"], "openai");
    await waitFor(() => pending.length === 1);
    const old = pending[0]!;
    if (alreadySettled) {
      old.finish(response(old.request));
      await waitFor(() => ui.selected("CUSTOM_ONLY"));
    }
    flushSync(() => invalidateClientLifetime());
    await waitFor(() => pending.length === 2);
    if (!alreadySettled) expect(old.signal.aborted).toBe(true);
    expect(ui.selected("CUSTOM_ONLY")).toBe(false);
    old.finish(response(old.request));
    await settle();
    expect(ui.selected("CUSTOM_ONLY")).toBe(false);
    pending[1]!.finish(response(pending[1]!.request, [false]));
    await settle();
    expect(ui.selected("CUSTOM_ONLY")).toBe(false);
  }
);
test.each(["held", "wrong-request", "missing-evidence", "inconsistent-match"])(
  "%s response never highlights unknown credentials",
  async (failure) => {
    const ui = mount(["CUSTOM_ONLY"], "openai");
    await waitFor(() => pending.length === 1);
    const call = pending[0]!;
    const raw = response(call.request, [true], failure === "held");
    if (failure === "wrong-request") raw.requestId = crypto.randomUUID();
    if (failure === "missing-evidence") raw.evidence = [];
    if (failure === "inconsistent-match") Object.assign(raw, { value: { matches: [false] } });
    call.finish(raw);
    await settle();
    expect(ui.selected("CUSTOM_ONLY")).toBe(false);
    expect(ui.el.textContent).toContain("usable");
  }
);
test("removing the selected provider aborts pending classification and clears enrichment", async () => {
  const ui = mount(["CUSTOM_ONLY"], "openai");
  await waitFor(() => pending.length === 1);
  const call = pending[0]!;
  ui.render();
  expect(call.signal.aborted).toBe(true);
  call.finish(response(call.request));
  await settle();
  expect(ui.selected("CUSTOM_ONLY")).toBe(false);
  expect(pending).toHaveLength(1);
});
