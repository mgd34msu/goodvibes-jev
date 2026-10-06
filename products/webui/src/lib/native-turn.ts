import {
  nativeHostedTurnLookupSchema,
  nativeHostedTurnRequestSchema,
  type NativeHostedTurnRequest,
  type NativeHostedTurnSnapshot,
} from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import type { NativeConversationIntakeLookupResult } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import type {
  NativeIntakeBrowserBinding,
  NativeIntakeBrowserRecord,
} from "./native-intake-journal";

export type NativeTurnObservation =
  | { kind: "not-requested" }
  | { kind: "not-found"; target: NativeHostedTurnRequest }
  | { kind: "recorded"; target: NativeHostedTurnRequest; snapshot: NativeHostedTurnSnapshot };

type NativeTurnMethod =
  | "workLedger.turn.status"
  | "workLedger.turn.start"
  | "workLedger.turn.cancel";

/**
 * Only the original source identity crosses this boundary. The host owns the
 * strict dispatch journal, native permit and exactly-once broker association.
 */
export function createNativeIntakeTurn(options: {
  binding: NativeIntakeBrowserBinding;
  invoke(
    method: NativeTurnMethod,
    input: NativeHostedTurnRequest,
    signal?: AbortSignal
  ): Promise<unknown>;
  confirm(record: NativeIntakeBrowserRecord): Promise<void>;
  inspect(
    record: NativeIntakeBrowserRecord,
    signal?: AbortSignal
  ): Promise<NativeConversationIntakeLookupResult>;
  active(signal?: AbortSignal): void;
}) {
  const current = (signal?: AbortSignal) => {
    options.active(signal);
    signal?.throwIfAborted();
  };
  async function run(
    action: "inspect" | "request" | "cancel",
    record: NativeIntakeBrowserRecord,
    signal?: AbortSignal
  ): Promise<NativeTurnObservation> {
    // Caller mutation or navigation cannot substitute the saved original.
    const original = structuredClone(record);
    current(signal);
    await options.confirm(original);
    current(signal);
    const source = await options.inspect(original, signal);
    current(signal);
    if (source.kind !== "turn") return { kind: "not-requested" };
    if (
      source.projectId !== options.binding.projectId ||
      source.requestId !== original.command.requestId ||
      source.sourceRef.inputId !== original.command.inputId ||
      source.sourceRef.continuation?.sessionId !== original.command.continuation?.sessionId ||
      source.continuation?.sessionId !== original.command.continuation?.sessionId ||
      source.continuation?.revision !== source.sourceRef.continuation?.revision ||
      source.text !== original.command.text
    )
      throw new Error(
        "The conversation source differs from the saved original. Inspect the original request."
      );
    const target = nativeHostedTurnRequestSchema.parse({
      projectId: source.projectId,
      inputId: original.command.inputId,
      sourceRevision: source.sourceRef.sourceRevision,
    });
    const observe = async (method: NativeTurnMethod): Promise<NativeTurnObservation> => {
      current(signal);
      const result = nativeHostedTurnLookupSchema.parse(
        await options.invoke(method, target, signal)
      );
      current(signal);
      if ("kind" in result) return { kind: "not-found", target };
      if (
        result.projectId !== target.projectId ||
        result.requestId !== original.command.requestId ||
        result.inputId !== target.inputId ||
        result.sourceRevision !== target.sourceRevision ||
        (original.command.continuation &&
          result.sessionId !== null &&
          result.sessionId !== original.command.continuation.sessionId)
      )
        throw new Error(
          "The conversation response differs from the saved original. No response identity was adopted."
        );
      return { kind: "recorded", target, snapshot: result };
    };
    if (action !== "cancel") {
      const observed = await observe("workLedger.turn.status");
      // Unknown responses, preparing/running and recovery-required all stop
      // here. No polling, implicit recovery, replay or legacy fallback.
      if (action === "inspect" || observed.kind !== "not-found") return observed;
    }
    await options.confirm(original);
    current(signal);
    return observe(action === "cancel" ? "workLedger.turn.cancel" : "workLedger.turn.start");
  }
  return Object.freeze({
    inspect: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("inspect", record, signal),
    request: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("request", record, signal),
    cancel: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("cancel", record, signal),
  });
}
