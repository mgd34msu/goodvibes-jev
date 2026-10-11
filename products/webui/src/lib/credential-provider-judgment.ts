import type { BrowserJudgmentRequest } from "@goodvibes-jev/engine/daemon-sdk";
import { runBrowserJudgment } from "./goodvibes";
import {
  getClientLifetime,
  isClientLifetimeCurrent,
  subscribeClientLifetime,
} from "./client-lifetime";
import { randomUuid } from "./uuid";

type ProviderBattery = "webui.credentials.provider-key" | "webui.models.catalog-provider-match";
type Request = BrowserJudgmentRequest<ProviderBattery>;
export type CredentialProviderResult =
  | {
      readonly status: "ready";
      readonly matches: readonly boolean[];
      readonly isCurrent: () => boolean;
    }
  | { readonly status: "held" | "unavailable" };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const keys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function readCredentialProviderResponse(
  request: Request,
  raw: unknown
):
  | { readonly status: "ready"; readonly matches: readonly boolean[] }
  | { readonly status: "held" }
  | undefined {
  const result = object(raw);
  const count = request.input.keys.length;
  if (
    result?.protocolVersion !== 1 ||
    result.batteryVersion !== 1 ||
    result.battery !== request.battery ||
    result.requestId !== request.requestId ||
    (result.status !== "settled" && result.status !== "held")
  )
    return undefined;
  const settled = result.status === "settled";
  if (
    !keys(result, [
      "protocolVersion",
      "batteryVersion",
      "requestId",
      "battery",
      "status",
      settled ? "value" : "reason",
      "readings",
      "outcome",
      "evidence",
    ])
  )
    return undefined;
  const readings = object(result.readings);
  if (
    !readings ||
    count < 1 ||
    count > 64 ||
    !keys(
      readings,
      request.input.keys.map((_, index) => `key_${index}`)
    )
  )
    return undefined;
  let strongest = 0;
  const matches: boolean[] = [];
  for (let index = 0; index < count; index++) {
    const reading = object(readings[`key_${index}`]);
    if (
      !reading ||
      !keys(reading, ["kind", "probability", "verdict", "outcome"]) ||
      reading.kind !== "yes-no" ||
      !nonnegative(reading.probability) ||
      reading.probability > 1 ||
      (reading.verdict !== "yes" && reading.verdict !== "no" && reading.verdict !== "uncertain") ||
      (reading.outcome !== "act" &&
        reading.outcome !== "confirm" &&
        reading.outcome !== "escalate") ||
      (reading.verdict === "uncertain" && reading.outcome === "act")
    )
      return undefined;
    strongest = Math.max(
      strongest,
      reading.outcome === "escalate" ? 2 : reading.outcome === "confirm" ? 1 : 0
    );
    matches.push(reading.verdict === "yes");
  }
  if (result.outcome !== (strongest === 2 ? "escalate" : strongest === 1 ? "confirm" : "act"))
    return undefined;
  if (!Array.isArray(result.evidence) || result.evidence.length !== count) return undefined;
  const decisions = new Set<string>();
  for (const entry of result.evidence) {
    const evidence = object(entry);
    const usage = object(evidence?.usage);
    if (
      !evidence ||
      !keys(evidence, ["decisionId", "model", "requestedModel", "usage", "latencyMs"]) ||
      !nonempty(evidence.decisionId) ||
      decisions.has(evidence.decisionId) ||
      !nonempty(evidence.model) ||
      !nonempty(evidence.requestedModel) ||
      !nonnegative(evidence.latencyMs) ||
      !usage ||
      !keys(usage, ["inputTokens", "outputTokens"]) ||
      !nonnegative(usage.inputTokens) ||
      !nonnegative(usage.outputTokens)
    )
      return undefined;
    decisions.add(evidence.decisionId);
  }
  if (!settled)
    return result.reason === "uncertain" && strongest > 0 ? { status: "held" } : undefined;
  const value = object(result.value);
  if (
    !value ||
    !keys(value, ["matches"]) ||
    !Array.isArray(value.matches) ||
    strongest !== 0 ||
    value.matches.length !== count ||
    value.matches.some((match, index) => typeof match !== "boolean" || match !== matches[index])
  )
    return undefined;
  return { status: "ready", matches };
}

/** Only names cross this boundary. The daemon independently verifies canonical inventory and current admin access. */
export async function readCredentialProvider(
  providerId: string,
  names: readonly string[],
  signal: AbortSignal,
  battery: ProviderBattery = "webui.credentials.provider-key"
): Promise<CredentialProviderResult> {
  if (!providerId || !names.length || names.length > 64 || signal.aborted)
    return { status: "held" };
  const lifetime = getClientLifetime();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener("abort", cancel, { once: true });
  const isCurrent = () =>
    !signal.aborted && !abort.signal.aborted && isClientLifetimeCurrent(lifetime);
  try {
    if (!isCurrent()) return { status: "unavailable" };
    const request: Request = {
      protocolVersion: 1,
      requestId: randomUuid(),
      battery,
      batteryVersion: 1,
      input: { providerId, keys: [...names] },
    };
    const raw = await runBrowserJudgment(request, abort.signal);
    if (!isCurrent()) return { status: "unavailable" };
    const result = readCredentialProviderResponse(request, raw);
    return result?.status === "ready"
      ? { ...result, isCurrent }
      : (result ?? { status: "unavailable" });
  } catch {
    return { status: "unavailable" };
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", cancel);
  }
}
