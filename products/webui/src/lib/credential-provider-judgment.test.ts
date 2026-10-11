import { afterEach, expect, mock, test } from "bun:test";
import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { invalidateClientLifetime } from "./client-lifetime";

type Request = BrowserJudgmentRequest<"webui.credentials.provider-key">;
let calls: { request: Request; signal: AbortSignal }[] = [];
let transport: (request: Request) => Promise<unknown> = async (request) => response(request);
mock.module("./goodvibes", () => ({
  runBrowserJudgment: (request: Request, signal: AbortSignal) => {
    calls.push({ request, signal });
    return transport(request);
  },
}));
const { readCredentialProvider, readCredentialProviderResponse } =
  await import("./credential-provider-judgment");
const request = (keys = ["CUSTOM_A", "CUSTOM_B"]): Request => ({
  protocolVersion: 1,
  batteryVersion: 1,
  battery: "webui.credentials.provider-key",
  requestId: crypto.randomUUID(),
  input: { providerId: "openai", keys },
});
function response(input: Request, held = false) {
  const matches = input.input.keys.map((_, index) => index % 2 === 0);
  return {
    protocolVersion: 1,
    batteryVersion: 1,
    battery: input.battery as string,
    requestId: input.requestId,
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
afterEach(() => {
  calls = [];
  transport = async (input) => response(input);
});

test("valid names-only projection preserves boolean correspondence and per-key evidence", () => {
  const input = request();
  expect(readCredentialProviderResponse(input, response(input))).toEqual({
    status: "ready",
    matches: [true, false],
  });
});
test("uncertainty exposes neither a partial match nor a guessed credential", () => {
  const input = request();
  expect(readCredentialProviderResponse(input, response(input, true))).toEqual({ status: "held" });
});
const corruptions: readonly [string, (raw: ReturnType<typeof response>) => void][] = [
  [
    "array verdict cannot impersonate an explicit negative",
    (raw) => {
      Object.assign(raw.readings.key_1!, { verdict: ["no"] });
    },
  ],
  [
    "array verdict cannot impersonate an explicit positive",
    (raw) => {
      Object.assign(raw.readings.key_0!, { verdict: ["yes"] });
    },
  ],
  [
    "array outcome cannot impersonate act",
    (raw) => {
      Object.assign(raw.readings.key_1!, { outcome: ["act"] });
    },
  ],
  [
    "protocol",
    (raw) => {
      raw.protocolVersion = 2;
    },
  ],
  [
    "battery-version",
    (raw) => {
      raw.batteryVersion = 2;
    },
  ],
  [
    "battery",
    (raw) => {
      raw.battery = "webui.pwa.install-platform";
    },
  ],
  [
    "request",
    (raw) => {
      raw.requestId = crypto.randomUUID();
    },
  ],
  [
    "status",
    (raw) => {
      raw.status = "ready";
    },
  ],
  [
    "extra envelope field",
    (raw) => {
      Object.assign(raw, { secret: "synthetic-forbidden" });
    },
  ],
  [
    "missing reading",
    (raw) => {
      delete raw.readings.key_1;
    },
  ],
  [
    "extra reading",
    (raw) => {
      raw.readings.key_2 = { ...raw.readings.key_0! };
    },
  ],
  [
    "wrong reading kind",
    (raw) => {
      raw.readings.key_0!.kind = "choice";
    },
  ],
  [
    "extra reading field",
    (raw) => {
      Object.assign(raw.readings.key_0!, { confidence: 1 });
    },
  ],
  [
    "negative probability",
    (raw) => {
      raw.readings.key_0!.probability = -0.1;
    },
  ],
  [
    "overflow probability",
    (raw) => {
      raw.readings.key_0!.probability = 1.1;
    },
  ],
  [
    "NaN probability",
    (raw) => {
      raw.readings.key_0!.probability = NaN;
    },
  ],
  [
    "infinite probability",
    (raw) => {
      raw.readings.key_0!.probability = Infinity;
    },
  ],
  [
    "unknown verdict",
    (raw) => {
      raw.readings.key_0!.verdict = "maybe";
    },
  ],
  [
    "unknown outcome",
    (raw) => {
      raw.readings.key_0!.outcome = "allow";
    },
  ],
  [
    "uncertain act",
    (raw) => {
      raw.readings.key_0!.verdict = "uncertain";
    },
  ],
  [
    "compound outcome",
    (raw) => {
      raw.outcome = "confirm";
    },
  ],
  [
    "unsettled reading with value",
    (raw) => {
      raw.readings.key_0!.outcome = "confirm";
      raw.outcome = "confirm";
    },
  ],
  [
    "missing evidence",
    (raw) => {
      raw.evidence = [];
    },
  ],
  [
    "duplicate evidence identity",
    (raw) => {
      raw.evidence[1]!.decisionId = raw.evidence[0]!.decisionId;
    },
  ],
  [
    "empty evidence identity",
    (raw) => {
      raw.evidence[0]!.decisionId = " ";
    },
  ],
  [
    "empty model",
    (raw) => {
      raw.evidence[0]!.model = "";
    },
  ],
  [
    "empty requested model",
    (raw) => {
      raw.evidence[0]!.requestedModel = "";
    },
  ],
  [
    "negative latency",
    (raw) => {
      raw.evidence[0]!.latencyMs = -1;
    },
  ],
  [
    "invalid input usage",
    (raw) => {
      raw.evidence[0]!.usage.inputTokens = NaN;
    },
  ],
  [
    "invalid output usage",
    (raw) => {
      raw.evidence[0]!.usage.outputTokens = -1;
    },
  ],
  [
    "extra usage",
    (raw) => {
      Object.assign(raw.evidence[0]!.usage, { secret: "synthetic-forbidden" });
    },
  ],
  [
    "extra evidence",
    (raw) => {
      Object.assign(raw.evidence[0]!, { state: "synthetic-forbidden" });
    },
  ],
  [
    "match reading disagreement",
    (raw) => {
      Object.assign(raw, { value: { matches: [false, false] } });
    },
  ],
  [
    "missing match",
    (raw) => {
      Object.assign(raw, { value: { matches: [true] } });
    },
  ],
  [
    "extra match",
    (raw) => {
      Object.assign(raw, { value: { matches: [true, false, true] } });
    },
  ],
  [
    "extra value field",
    (raw) => {
      Object.assign("value" in raw ? raw.value : {}, { names: ["CUSTOM_A", "CUSTOM_B"] });
    },
  ],
];
for (const [label, corrupt] of corruptions)
  test(`${label} substitution fails closed`, () => {
    const input = request();
    const raw = response(input);
    corrupt(raw);
    expect(readCredentialProviderResponse(input, raw)).toBeUndefined();
  });
test.each(["wrong-reason", "settled-outcomes", "extra-value"])(
  "%s held envelope cannot smuggle an actionable value",
  (failure) => {
    const input = request();
    const raw = response(input, true);
    if (failure === "wrong-reason") Object.assign(raw, { reason: "other" });
    if (failure === "settled-outcomes") {
      Object.values(raw.readings).forEach((reading) => {
        reading.outcome = "act";
        reading.verdict = "yes";
      });
      raw.outcome = "act";
    }
    if (failure === "extra-value") Object.assign(raw, { value: { matches: [true, false] } });
    expect(readCredentialProviderResponse(input, raw)).toBeUndefined();
  }
);
test.each(["abort", "identity"])(
  "%s cancels pending names-only transport and prevents late adoption",
  async (cause) => {
    const deferred = Promise.withResolvers<unknown>();
    transport = () => deferred.promise;
    const abort = new AbortController();
    const pending = readCredentialProvider("openai", ["CUSTOM_A", "CUSTOM_B"], abort.signal);
    await Promise.resolve();
    expect(calls[0]!.request.input).toEqual({
      providerId: "openai",
      keys: ["CUSTOM_A", "CUSTOM_B"],
    });
    if (cause === "abort") abort.abort();
    else invalidateClientLifetime();
    expect(calls[0]!.signal.aborted).toBe(true);
    deferred.resolve(response(calls[0]!.request));
    expect(await pending).toEqual({ status: "unavailable" });
  }
);
test("adopted result expires on identity change", async () => {
  const result = await readCredentialProvider(
    "openai",
    ["CUSTOM_A", "CUSTOM_B"],
    new AbortController().signal
  );
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Missing ready fixture");
  expect(result.matches).toEqual([true, false]);
  expect(result.isCurrent()).toBe(true);
  invalidateClientLifetime();
  expect(result.isCurrent()).toBe(false);
});
test.each(["no-provider", "empty-names", "too-many-names", "already-aborted"])(
  "%s is held before transport",
  async (failure) => {
    const abort = new AbortController();
    if (failure === "already-aborted") abort.abort();
    const names =
      failure === "empty-names"
        ? []
        : failure === "too-many-names"
          ? Array.from({ length: 65 }, (_, index) => `CUSTOM_${index}`)
          : ["CUSTOM_A"];
    expect(
      await readCredentialProvider(failure === "no-provider" ? "" : "openai", names, abort.signal)
    ).toEqual({ status: "held" });
    expect(calls).toHaveLength(0);
  }
);
test("transport refusal remains unavailable without a partial guessed answer", async () => {
  transport = async () => {
    throw new Error("synthetic refusal");
  };
  expect(
    await readCredentialProvider("openai", ["CUSTOM_A"], new AbortController().signal)
  ).toEqual({ status: "unavailable" });
});
