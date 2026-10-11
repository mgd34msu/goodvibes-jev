/** Real config provider, row renderer, strict names-only reader, and client lifetime. */
import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { invalidateClientLifetime } from "../../../lib/client-lifetime";
import { ToastProvider } from "../../../lib/toast";

type Request = BrowserJudgmentRequest<"webui.config.credential-key" | "webui.settings.card-material-key">;
let pending: {
  request: Request;
  signal: AbortSignal;
  finish: (raw: unknown) => void;
  fail: (error: Error) => void;
}[] = [];
let configReadError: Error | undefined;
let configReadOverride: (() => Promise<unknown>) | undefined;
mock.module("../../../lib/goodvibes", () => ({
  sdk: {
    operator: {
      config: {
        get: async () => {
          if (configReadError) throw configReadError;
          if (configReadOverride) return configReadOverride();
          return {};
        },
      },
    },
  },
  runBrowserJudgment: (request: Request, signal: AbortSignal) =>
    new Promise<unknown>((finish, fail) => {
      pending.push({ request, signal, finish, fail });
    }),
}));
const { ConfigSettingsProvider, ConfigGroupList, useConfigSettings } =
  await import("./ConfigSettings");
const privateValue = "synthetic-config-private-value";
const fixture = () => ({
  extension: {
    label: privateValue,
    amount: 4815162342,
    choices: [{ private: privateValue }],
    nested: { value: privateValue },
  },
  cluster: { groupMaterial: "synthetic-declared-secret-1234" },
});
function response(request: Request, matches = request.input.keys.map(() => false), held = false) {
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
type ReadingRound = { credential: (typeof pending)[number]; card: (typeof pending)[number] };
function readingRound(index: number): ReadingRound {
  const calls = pending.slice(index * 2, index * 2 + 2);
  expect(calls).toHaveLength(2);
  expect(calls.map(call => call.request.battery).sort()).toEqual([
    "webui.config.credential-key", "webui.settings.card-material-key",
  ]);
  const credential = calls.find(call => call.request.battery === "webui.config.credential-key")!;
  const card = calls.find(call => call.request.battery === "webui.settings.card-material-key")!;
  expect(card.request.input).toEqual(credential.request.input);
  expect(card.request.requestId).not.toBe(credential.request.requestId);
  for (const { request } of calls) {
    expect(JSON.stringify(request)).not.toContain(privateValue);
    expect(JSON.stringify(request)).not.toContain("4815162342");
    expect(JSON.stringify(request)).not.toContain("synthetic-declared-secret");
  }
  return { credential, card };
}
/** Explicit fixture responses for BOTH authorities; never a transport fallback. */
function finishRound(round: ReadingRound, credentialMatches?: boolean[]) {
  round.credential.finish(response(round.credential.request, credentialMatches));
  round.card.finish(response(round.card.request));
}
function expectRoundAborted(round: ReadingRound) {
  expect(round.credential.signal.aborted).toBe(true);
  expect(round.card.signal.aborted).toBe(true);
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}
async function waitFor(check: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await settle();
  }
  throw new Error("Config settings did not reach the expected state");
}
const cleanups: (() => void)[] = [];
function mount(config: unknown, enabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
  client.setQueryData(["config"], config);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  function Rows() {
    const { groups } = useConfigSettings();
    return React.createElement(ConfigGroupList, {
      groups: groups.filter((group) => ["extension", "cluster"].includes(group.id)),
    });
  }
  const render = (active: boolean) =>
    flushSync(() =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            ToastProvider,
            null,
            React.createElement(ConfigSettingsProvider, {
              enabled: active,
              children: React.createElement(Rows),
            })
          )
        )
      )
    );
  render(enabled);
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
  const shown = (key: string) =>
    [...el.querySelectorAll(".settings-readable__row")]
      .find((row) => row.querySelector("dt")?.textContent?.startsWith(key))
      ?.querySelector("dd")?.textContent;
  return {
    el,
    render,
    unmount,
    shown,
    setConfig: (value: unknown) => client.setQueryData(["config"], value),
    refetch: () => client.refetchQueries({ queryKey: ["config"] }),
  };
}
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  pending.forEach((call) => call.finish(response(call.request)));
  await settle();
  pending = [];
  configReadError = undefined;
  configReadOverride = undefined;
});

test("unknown string, number, object leaves and arrays stay excluded until card clearance; only names cross transport", async () => {
  const ui = mount(fixture());
  await waitFor(() => pending.length === 2);
  const call = readingRound(0);
  expect(call.credential.request.input).toEqual({
    keys: ["extension.label", "extension.amount", "extension.choices", "extension.nested.value"],
  });
  expect(JSON.stringify(call.credential.request)).not.toContain(privateValue);
  expect(JSON.stringify(call.credential.request)).not.toContain("4815162342");
  expect(JSON.stringify(call.credential.request)).not.toContain("synthetic-declared-secret");
  for (const key of call.credential.request.input.keys) expect(ui.shown(key)).toBeUndefined();
  expect(ui.el.textContent).not.toContain(privateValue);
  expect(ui.el.textContent).not.toContain("4815162342");
  expect(ui.el.textContent).not.toContain("synthetic-declared-secret");
  finishRound(call, [false, false, false, true]);
  await waitFor(() => ui.shown("extension.label") === privateValue);
  expect(ui.shown("extension.amount")).toBe("4815162342");
  expect(ui.shown("extension.choices")).toBe(JSON.stringify([{ private: privateValue }]));
  expect(ui.shown("extension.nested.value")).toBe("••••");
  expect(ui.el.querySelector('[data-config-group="extension"] .settings-secret-flag')?.textContent).toContain("(masked)");
  expect(ui.shown("cluster.groupMaterial")).not.toContain("synthetic-declared-secret");
});

test("known schema facts and declared secret paths need no semantic reading", async () => {
  const ui = mount({
    display: { theme: "nord" },
    cluster: { groupMaterial: "synthetic-secret-1234" },
  });
  await settle();
  expect(pending).toHaveLength(0);
  expect(ui.shown("cluster.groupMaterial")).toContain("1234");
  expect(ui.el.textContent).not.toContain("synthetic-secret");
});

test("a malformed object under a declared secret cannot produce clearable child rows", async () => {
  const ui = mount({ cluster: { groupMaterial: { ordinaryName: privateValue } } });
  await settle();
  expect(pending).toHaveLength(0);
  expect(ui.shown("cluster.groupMaterial")).toBe("••••");
  expect(ui.el.textContent).not.toContain("ordinaryName");
  expect(ui.el.textContent).not.toContain(privateValue);
});

for (const authority of ["credential", "card"] as const) {
  test.each(["held", "outage", "malformed", "wrong-request", "array-negative", "partial-negative"])(
    `${authority} %s cannot clear any unknown value`,
    async (cause) => {
      const ui = mount(fixture());
      await waitFor(() => pending.length === 2);
      const round = readingRound(0);
      const call = round[authority];
      if (cause === "outage") call.fail(new Error("synthetic network outage"));
      else {
        const raw = response(call.request, undefined, cause === "held");
        if (cause === "malformed") raw.evidence = [];
        if (cause === "wrong-request") raw.requestId = crypto.randomUUID();
        if (cause === "array-negative") Object.assign(raw.readings.key_0!, { verdict: ["no"] });
        if (cause === "partial-negative") {
          raw.readings.key_1!.outcome = "confirm";
          raw.outcome = "confirm";
        }
        call.finish(raw);
      }
      const other = round[authority === "credential" ? "card" : "credential"];
      other.finish(response(other.request));
      await settle();
      await settle();
      for (const key of call.request.input.keys) {
        if (authority === "credential") expect(ui.shown(key)).toBe("••••");
        else expect(ui.shown(key)).toBeUndefined();
      }
      expect(ui.el.textContent).not.toContain(privateValue);
      expect(ui.el.textContent).not.toContain("4815162342");
    }
  );
}

test.each(["credential", "card"] as const)("%s clearance alone cannot display an unknown value", async authority => {
  const ui = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 2);
  const round = readingRound(0);
  round[authority].finish(response(round[authority].request));
  await settle();
  await settle();
  expect(ui.shown("extension.label")).toBeUndefined();
  expect(ui.el.textContent).not.toContain(privateValue);
  const other = round[authority === "credential" ? "card" : "credential"];
  other.finish(response(other.request));
  await waitFor(() => ui.shown("extension.label") === privateValue);
});

test("a positive card reading excludes the row even with negative credential evidence", async () => {
  const ui = mount({ extension: { label: privateValue, ordinaryName: "visible-fixture" } });
  await waitFor(() => pending.length === 2);
  const round = readingRound(0);
  round.credential.finish(response(round.credential.request, [false, false]));
  round.card.finish(response(round.card.request, [true, false]));
  await waitFor(() => ui.shown("extension.ordinaryName") === "visible-fixture");
  expect(ui.shown("extension.label")).toBeUndefined();
  expect(ui.el.textContent).not.toContain(privateValue);
});

test.each([false, true])(
  "identity change retracts %s settled clearance and prevents late adoption",
  async (alreadySettled) => {
    const ui = mount({ extension: { label: privateValue } });
    await waitFor(() => pending.length === 2);
    const old = readingRound(0);
    if (alreadySettled) {
      finishRound(old);
      await waitFor(() => ui.shown("extension.label") === privateValue);
    }
    flushSync(() => invalidateClientLifetime());
    await waitFor(() => pending.length === 4);
    if (!alreadySettled) expectRoundAborted(old);
    expect(ui.shown("extension.label")).toBeUndefined();
    finishRound(old);
    await settle();
    expect(ui.shown("extension.label")).toBeUndefined();
    finishRound(readingRound(1));
    await waitFor(() => ui.shown("extension.label") === privateValue);
  }
);

test.each([false, true])(
  "same-key config replacement retracts %s settled clearance until a fresh result",
  async (alreadySettled) => {
    const ui = mount({ extension: { label: privateValue } });
    await waitFor(() => pending.length === 2);
    const old = readingRound(0);
    if (alreadySettled) {
      finishRound(old);
      await waitFor(() => ui.shown("extension.label") === privateValue);
    }
    ui.setConfig({ extension: { label: "synthetic-replacement-value" } });
    await waitFor(() => pending.length === 4);
    if (!alreadySettled) expectRoundAborted(old);
    expect(ui.shown("extension.label")).toBeUndefined();
    finishRound(old);
    await settle();
    expect(ui.shown("extension.label")).toBeUndefined();
    finishRound(readingRound(1));
    await waitFor(() => ui.shown("extension.label") === "synthetic-replacement-value");
  }
);

test("replacement names cannot inherit clearance at the same index", async () => {
  const ui = mount({ extension: { oldName: privateValue } });
  await waitFor(() => pending.length === 2);
  const old = readingRound(0);
  ui.setConfig({ extension: { newName: privateValue } });
  await waitFor(() => pending.length === 4);
  expectRoundAborted(old);
  finishRound(old);
  await settle();
  expect(ui.shown("extension.oldName")).toBeUndefined();
  expect(ui.shown("extension.newName")).toBeUndefined();
  expect(readingRound(1).credential.request.input).toEqual({ keys: ["extension.newName"] });
});

test.each([false, true])(
  "disabling the provider retracts %s settled clearance and cancels its lifetime",
  async (alreadySettled) => {
    const ui = mount({ extension: { label: privateValue } });
    await waitFor(() => pending.length === 2);
    const old = readingRound(0);
    if (alreadySettled) {
      finishRound(old);
      await waitFor(() => ui.shown("extension.label") === privateValue);
    }
    ui.render(false);
    expect(ui.shown("extension.label")).toBeUndefined();
    if (!alreadySettled) expectRoundAborted(old);
    finishRound(old);
    await settle();
    expect(ui.shown("extension.label")).toBeUndefined();
    ui.render(true);
    await waitFor(() => pending.length === 4);
    expect(ui.shown("extension.label")).toBeUndefined();
  }
);

test("closing settings aborts transport and a late result cannot clear a replacement dialog", async () => {
  const first = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 2);
  const old = readingRound(0);
  first.unmount();
  expectRoundAborted(old);
  const next = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 4);
  finishRound(old);
  await settle();
  expect(next.shown("extension.label")).toBeUndefined();
});

test("oversized unknown-key inventory remains excluded without partial or guessed clearance", async () => {
  const ui = mount({
    extension: Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key${index}`, privateValue])
    ),
  });
  await settle();
  expect(pending).toHaveLength(0);
  expect(ui.el.querySelectorAll(".settings-readable__row")).toHaveLength(0);
  expect(ui.el.textContent).not.toContain(privateValue);
});

test("loss of config read access never leaves a cleared cached value displayed", async () => {
  const ui = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 2);
  finishRound(readingRound(0));
  await waitFor(() => ui.shown("extension.label") === privateValue);
  configReadError = Object.assign(new Error("Admin role required"), { status: 403 });
  await ui.refetch();
  await waitFor(() => ui.el.textContent?.includes("Admin access required") === true);
  expect(ui.el.textContent).not.toContain(privateValue);
});


test.each([false, true])("equal-content refetch retracts %s settled clearance and requires fresh evidence", async alreadySettled => {
  const snapshot = { extension: { label: privateValue } };
  const ui = mount(snapshot);
  await waitFor(() => pending.length === 2);
  const old = readingRound(0);
  if (alreadySettled) {
    finishRound(old);
    await waitFor(() => ui.shown("extension.label") === privateValue);
  }
  const deferred = Promise.withResolvers<unknown>();
  configReadOverride = () => deferred.promise;
  const refreshing = ui.refetch();
  await waitFor(() => ui.shown("extension.label") === undefined);
  await settle();
  if (!alreadySettled) expectRoundAborted(old);
  finishRound(old);
  await settle();
  expect(ui.shown("extension.label")).toBeUndefined();
  deferred.resolve(snapshot);
  await refreshing;
  await waitFor(() => pending.length === 4);
  expect(ui.shown("extension.label")).toBeUndefined();
  finishRound(readingRound(1));
  await waitFor(() => ui.shown("extension.label") === privateValue);
});
