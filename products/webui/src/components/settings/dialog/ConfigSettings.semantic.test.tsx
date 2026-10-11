/** Real config provider, row renderer, strict names-only reader, and client lifetime. */
import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { invalidateClientLifetime } from "../../../lib/client-lifetime";
import { ToastProvider } from "../../../lib/toast";

type Request = BrowserJudgmentRequest<"webui.config.credential-key">;
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

test("unknown string, number, object leaves and arrays are fully masked while only their names cross transport", async () => {
  const ui = mount(fixture());
  await waitFor(() => pending.length === 1);
  const call = pending[0]!;
  expect(call.request.input).toEqual({
    keys: ["extension.label", "extension.amount", "extension.choices", "extension.nested.value"],
  });
  expect(JSON.stringify(call.request)).not.toContain(privateValue);
  expect(JSON.stringify(call.request)).not.toContain("4815162342");
  expect(JSON.stringify(call.request)).not.toContain("synthetic-declared-secret");
  for (const key of call.request.input.keys) expect(ui.shown(key)).toBe("••••");
  expect(ui.el.textContent).not.toContain(privateValue);
  expect(ui.el.textContent).not.toContain("4815162342");
  expect(ui.el.querySelector('[data-config-group="extension"] .settings-readable__row .settings-secret-flag')?.textContent).toContain("(masked)");
  expect(ui.el.textContent).not.toContain("synthetic-declared-secret");
  call.finish(response(call.request, [false, false, false, true]));
  await waitFor(() => ui.shown("extension.label") === privateValue);
  expect(ui.shown("extension.amount")).toBe("4815162342");
  expect(ui.shown("extension.choices")).toBe(JSON.stringify([{ private: privateValue }]));
  expect(ui.shown("extension.nested.value")).toBe("••••");
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

test.each(["held", "outage", "malformed", "wrong-request", "array-negative", "partial-negative"])(
  "%s cannot clear any unknown value",
  async (cause) => {
    const ui = mount(fixture());
    await waitFor(() => pending.length === 1);
    const call = pending[0]!;
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
    await settle();
    await settle();
    for (const key of call.request.input.keys) expect(ui.shown(key)).toBe("••••");
    expect(ui.el.textContent).not.toContain(privateValue);
  }
);

test.each([false, true])(
  "identity change retracts %s settled clearance and prevents late adoption",
  async (alreadySettled) => {
    const ui = mount({ extension: { label: privateValue } });
    await waitFor(() => pending.length === 1);
    const old = pending[0]!;
    if (alreadySettled) {
      old.finish(response(old.request));
      await waitFor(() => ui.shown("extension.label") === privateValue);
    }
    flushSync(() => invalidateClientLifetime());
    await waitFor(() => pending.length === 2);
    if (!alreadySettled) expect(old.signal.aborted).toBe(true);
    expect(ui.shown("extension.label")).toBe("••••");
    old.finish(response(old.request));
    await settle();
    expect(ui.shown("extension.label")).toBe("••••");
    pending[1]!.finish(response(pending[1]!.request));
    await waitFor(() => ui.shown("extension.label") === privateValue);
  }
);

test.each([false, true])(
  "same-key config replacement retracts %s settled clearance until a fresh result",
  async (alreadySettled) => {
    const ui = mount({ extension: { label: privateValue } });
    await waitFor(() => pending.length === 1);
    const old = pending[0]!;
    if (alreadySettled) {
      old.finish(response(old.request));
      await waitFor(() => ui.shown("extension.label") === privateValue);
    }
    ui.setConfig({ extension: { label: "synthetic-replacement-value" } });
    await waitFor(() => pending.length === 2);
    if (!alreadySettled) expect(old.signal.aborted).toBe(true);
    expect(ui.shown("extension.label")).toBe("••••");
    old.finish(response(old.request));
    await settle();
    expect(ui.shown("extension.label")).toBe("••••");
    pending[1]!.finish(response(pending[1]!.request));
    await waitFor(() => ui.shown("extension.label") === "synthetic-replacement-value");
  }
);

test("replacement names cannot inherit clearance at the same index", async () => {
  const ui = mount({ extension: { oldName: privateValue } });
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  ui.setConfig({ extension: { newName: privateValue } });
  await waitFor(() => pending.length === 2);
  expect(old.signal.aborted).toBe(true);
  old.finish(response(old.request));
  await settle();
  expect(ui.shown("extension.oldName")).toBeUndefined();
  expect(ui.shown("extension.newName")).toBe("••••");
  expect(pending[1]!.request.input).toEqual({ keys: ["extension.newName"] });
});

test.each([false, true])(
  "disabling the provider retracts %s settled clearance and cancels its lifetime",
  async (alreadySettled) => {
    const ui = mount({ extension: { label: privateValue } });
    await waitFor(() => pending.length === 1);
    const old = pending[0]!;
    if (alreadySettled) {
      old.finish(response(old.request));
      await waitFor(() => ui.shown("extension.label") === privateValue);
    }
    ui.render(false);
    expect(ui.shown("extension.label")).toBe("••••");
    if (!alreadySettled) expect(old.signal.aborted).toBe(true);
    old.finish(response(old.request));
    await settle();
    expect(ui.shown("extension.label")).toBe("••••");
    ui.render(true);
    await waitFor(() => pending.length === 2);
    expect(ui.shown("extension.label")).toBe("••••");
  }
);

test("closing settings aborts transport and a late result cannot clear a replacement dialog", async () => {
  const first = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  first.unmount();
  expect(old.signal.aborted).toBe(true);
  const next = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 2);
  old.finish(response(old.request));
  await settle();
  expect(next.shown("extension.label")).toBe("••••");
});

test("oversized unknown-key inventory remains masked without partial or guessed clearance", async () => {
  const ui = mount({
    extension: Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key${index}`, privateValue])
    ),
  });
  await settle();
  expect(pending).toHaveLength(0);
  expect(ui.el.querySelectorAll(".settings-readable__row")).toHaveLength(65);
  expect(ui.el.textContent).not.toContain(privateValue);
});

test("loss of config read access never leaves a cleared cached value displayed", async () => {
  const ui = mount({ extension: { label: privateValue } });
  await waitFor(() => pending.length === 1);
  pending[0]!.finish(response(pending[0]!.request));
  await waitFor(() => ui.shown("extension.label") === privateValue);
  configReadError = Object.assign(new Error("Admin role required"), { status: 403 });
  await ui.refetch();
  await waitFor(() => ui.el.textContent?.includes("Admin access required") === true);
  expect(ui.el.textContent).not.toContain(privateValue);
});


test.each([false, true])("equal-content refetch retracts %s settled clearance and requires fresh evidence", async alreadySettled => {
  const snapshot = { extension: { label: privateValue } };
  const ui = mount(snapshot);
  await waitFor(() => pending.length === 1);
  const old = pending[0]!;
  if (alreadySettled) {
    old.finish(response(old.request));
    await waitFor(() => ui.shown("extension.label") === privateValue);
  }
  const deferred = Promise.withResolvers<unknown>();
  configReadOverride = () => deferred.promise;
  const refreshing = ui.refetch();
  await waitFor(() => ui.shown("extension.label") === "••••");
  await settle();
  if (!alreadySettled) expect(old.signal.aborted).toBe(true);
  old.finish(response(old.request));
  await settle();
  expect(ui.shown("extension.label")).toBe("••••");
  deferred.resolve(snapshot);
  await refreshing;
  await waitFor(() => pending.length === 2);
  expect(ui.shown("extension.label")).toBe("••••");
  pending[1]!.finish(response(pending[1]!.request));
  await waitFor(() => ui.shown("extension.label") === privateValue);
});
