import type { OperatorRemoteClient } from "@goodvibes-jev/engine/operator-sdk";
import { createOperatorNativeWorkExecutionClient } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import {
  createOperatorNativeConversationIntakeClient,
  nativeConversationIntakeCaptureRequestSchema,
  type NativeConversationIntakeLookupResult,
  type NativeConversationIntakeUnsupportedSource,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import { GOODVIBES_BASE_URL, sdk } from "./goodvibes";
import {
  isClientLifetimeCurrent,
  subscribeClientLifetime,
  type ClientLifetime,
} from "./client-lifetime";
import { getActiveRoute } from "./relay-connection";
import { getStoredRelayPairing } from "./relay-pairing";
import { randomUuid } from "./uuid";
import { createNativeIntakeExecution } from "./native-execution";
import { createNativeIntakeTurn } from "./native-turn";
import {
  createNativeExecutionBrowserJournal,
  type NativeExecutionBrowserJournal,
} from "./native-execution-journal";
import {
  createNativeIntakeBrowserJournal,
  type NativeIntakeBrowserBinding,
  type NativeIntakeBrowserRecord,
} from "./native-intake-journal";

export type NativeIntakeResult = NativeConversationIntakeLookupResult;
export interface NativeIntakeSource {
  text: string;
  unsupportedSources: NativeConversationIntakeUnsupportedSource[];
}
export interface NativeIntakeScope {
  continuationSessionId?: string;
  /** Verified discovery result. Reopening must not silently adopt a different project. */
  projectId?: string;
}
export type NativeIntakeJournal = ReturnType<typeof createNativeIntakeBrowserJournal>;
const terminal = (result: NativeIntakeResult) =>
  ["work", "turn", "blocked", "refused", "cancelled"].includes(result.kind);
const sameBinding = (left: NativeIntakeBrowserBinding, right: NativeIntakeBrowserBinding) =>
  JSON.stringify(left) === JSON.stringify(right);

/** A selected browser identity is a fence, never a native authority grant. */
export async function openNativeIntake(
  lifetime: ClientLifetime,
  signal: AbortSignal,
  journal: NativeIntakeJournal = createNativeIntakeBrowserJournal(),
  newId: () => string = randomUuid,
  executionJournal: NativeExecutionBrowserJournal = createNativeExecutionBrowserJournal(),
  scope: NativeIntakeScope = {}
) {
  const { continuationSessionId, projectId: expectedProjectId } = scope;
  const continuation =
    continuationSessionId === undefined ? undefined : { sessionId: continuationSessionId };
  if (continuation)
    nativeConversationIntakeCaptureRequestSchema.parse({
      requestId: "validation",
      inputId: "validation",
      text: "validation",
      unsupportedSources: [],
      continuation,
    });
  let disposed = false;
  const lifetimeAbort = new AbortController();
  const stop = () => lifetimeAbort.abort();
  const unsubscribe = subscribeClientLifetime(stop);
  signal.addEventListener("abort", stop, { once: true });
  const check = () => {
    if (
      disposed ||
      signal.aborted ||
      lifetimeAbort.signal.aborted ||
      !isClientLifetimeCurrent(lifetime)
    ) {
      throw new Error("The selected connection changed. Reopen Native request to inspect it.");
    }
  };
  const combined = (operation?: AbortSignal) =>
    AbortSignal.any([signal, lifetimeAbort.signal, ...(operation ? [operation] : [])]);
  const readBinding = async (
    operation?: AbortSignal,
    authority: "intake" | "execution" | "turn" = "intake"
  ): Promise<NativeIntakeBrowserBinding> => {
    check();
    const current = combined(operation);
    current.throwIfAborted();
    const auth = await sdk.operator.invoke("control.auth.current", {}, current);
    check();
    current.throwIfAborted();
    if (
      !auth.authenticated ||
      !auth.admin ||
      auth.principalKind !== "token" ||
      !auth.principalId ||
      auth.principalId === "shared-token" ||
      auth.principalId.length > 200 ||
      !(
        authority === "turn"
          ? ["read:work-ledger", "write:work-ledger", "write:sessions"]
          : ["read:work-ledger", authority === "execution" ? "write:fleet" : "write:work-ledger"]
      ).every((scope) => auth.scopes.includes("*") || auth.scopes.includes(scope))
    ) {
      const error = new Error(
        authority === "turn"
          ? "Native conversation delivery requires an existing paired admin with read:work-ledger, write:work-ledger and write:sessions. Shared tokens and user sessions are unsupported."
          : authority === "execution"
            ? "Native execution requires an existing paired admin with read:work-ledger and write:fleet. Shared tokens and user sessions are unsupported."
            : "Native requests require an existing paired admin with read:work-ledger and write:work-ledger. Shared tokens and user sessions are unsupported."
      );
      throw authority === "execution"
        ? Object.assign(error, { code: "NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY" })
        : error;
    }
    const project = await sdk.operator.invoke("workLedger.project", {}, current);
    check();
    current.throwIfAborted();
    if (
      typeof project.projectId !== "string" ||
      !project.projectId ||
      project.projectId.length > 200
    )
      throw new Error("The daemon did not identify its native project.");
    if (expectedProjectId !== undefined && project.projectId !== expectedProjectId)
      throw new Error("The native session project changed. Reopen the session before submitting.");
    const relay = getActiveRoute() === "relay" ? getStoredRelayPairing() : null;
    if (getActiveRoute() === "relay" && !relay)
      throw new Error("The selected relay connection is unavailable.");
    // Only the public host key is retained. No token, relay rendezvous or grant.
    return {
      endpoint: GOODVIBES_BASE_URL,
      projectId: project.projectId,
      principalId: auth.principalId,
      transport: relay ? `relay:${relay.daemonPublicKey}` : "direct",
    };
  };
  try {
    const binding = await readBinding(undefined, continuation ? "turn" : "intake");
    const authorize = async (
      operation?: AbortSignal,
      authority: "intake" | "execution" | "turn" = "intake"
    ) => {
      const current = await readBinding(
        operation,
        continuation && authority === "intake" ? "turn" : authority
      );
      if (!sameBinding(binding, current))
        throw new Error("The native project or paired owner changed. Reopen Native request.");
      check();
    };
    const invoke = (async (
      method: string,
      input?: Record<string, unknown>,
      options?: { signal?: AbortSignal }
    ) => {
      await authorize(
        options?.signal,
        method.startsWith("workLedger.turn.")
          ? "turn"
          : method.startsWith("workLedger.execution.")
            ? "execution"
            : "intake"
      );
      const result = await sdk.operator.invoke(method, input, combined(options?.signal));
      check();
      return result;
    }) as OperatorRemoteClient["invoke"];
    const client = createOperatorNativeConversationIntakeClient({ invoke }, binding.projectId);
    const executionClient = createOperatorNativeWorkExecutionClient({ invoke }, binding.projectId);
    const confirm = async (record: NativeIntakeBrowserRecord) => {
      check();
      if (!sameBinding(binding, record.binding))
        throw new Error("This request belongs to a different native owner.");
      if (record.command.continuation?.sessionId !== continuationSessionId)
        throw new Error("This saved request belongs to a different session scope.");
      await journal.confirm(record);
      check();
    };
    const validate = (
      record: NativeIntakeBrowserRecord,
      result: NativeIntakeResult
    ): NativeIntakeResult => {
      if (
        result.kind !== "not-found" &&
        (result.requestId !== record.command.requestId ||
          result.projectId !== binding.projectId ||
          result.sourceRef.inputId !== record.command.inputId ||
          result.sourceRef.continuation?.sessionId !== record.command.continuation?.sessionId ||
          (result.kind === "turn" &&
            (result.continuation?.sessionId !== record.command.continuation?.sessionId ||
              result.continuation?.revision !== result.sourceRef.continuation?.revision)) ||
          (result.kind === "turn" && result.text !== record.command.text) ||
          (result.kind === "work" && result.receipt.goal !== record.command.text))
      ) {
        throw new Error(
          "The daemon returned a different original source. Keep the saved request for inspection."
        );
      }
      return result;
    };
    const inspect = async (record: NativeIntakeBrowserRecord, operation?: AbortSignal) => {
      await confirm(record);
      return validate(
        record,
        await client.get({ inputId: record.command.inputId }, { signal: combined(operation) })
      );
    };
    const execution = createNativeIntakeExecution({
      binding,
      client: executionClient,
      journal: executionJournal,
      confirm,
      inspect,
      active(operation) {
        check();
        combined(operation).throwIfAborted();
      },
    });
    const turn = createNativeIntakeTurn({
      binding,
      invoke: (method, input, operation) => invoke(method, input, { signal: combined(operation) }),
      confirm,
      inspect,
      active(operation) {
        check();
        combined(operation).throwIfAborted();
      },
    });
    const continueSubmission = async (
      record: NativeIntakeBrowserRecord,
      found: NativeIntakeResult,
      operation?: AbortSignal
    ): Promise<NativeIntakeResult> => {
      let result = found;
      if (result.kind === "not-found") {
        await confirm(record);
        result = validate(
          record,
          await client.capture(record.command, { signal: combined(operation) })
        );
      }
      if (result.kind === "captured") {
        await confirm(record);
        result = validate(
          record,
          await client.admit(
            { inputId: record.command.inputId, sourceRevision: result.sourceRef.sourceRevision },
            { signal: combined(operation) }
          )
        );
      }
      return result;
    };
    return {
      binding,
      execution,
      turn,
      async list() {
        await authorize();
        const records = await journal.list(binding);
        check();
        return records.filter(
          (record) => record.command.continuation?.sessionId === continuationSessionId
        );
      },
      async submit(
        source: NativeIntakeSource,
        saved: (record: NativeIntakeBrowserRecord) => void,
        operation?: AbortSignal
      ) {
        // Validate before allocating identities. Deliberate identical inputs still get new IDs.
        const original = nativeConversationIntakeCaptureRequestSchema.parse({
          requestId: "validation",
          inputId: "validation",
          ...source,
          ...(continuation ? { continuation } : {}),
        });
        await authorize(operation);
        const record = {
          binding,
          command: nativeConversationIntakeCaptureRequestSchema.parse({
            requestId: newId(),
            inputId: newId(),
            text: original.text,
            unsupportedSources: original.unsupportedSources,
            ...(original.continuation ? { continuation: original.continuation } : {}),
          }),
          createdAt: Date.now(),
        };
        await journal.save(record);
        check();
        saved(record);
        return continueSubmission(record, { kind: "not-found" }, operation);
      },
      inspect,
      async retry(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        // Never repeat an uncertain mutation until authoritative lookup has answered.
        return continueSubmission(record, await inspect(record, operation), operation);
      },
      async resume(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        const found = await inspect(record, operation);
        if (found.kind !== "processing" || found.recovery !== "required") return found;
        await confirm(record);
        return validate(
          record,
          await client.resume(
            { inputId: record.command.inputId, sourceRevision: found.sourceRef.sourceRevision },
            { signal: combined(operation) }
          )
        );
      },
      async cancel(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        const found = await inspect(record, operation);
        if (found.kind === "not-found" || terminal(found)) return found;
        await confirm(record);
        return validate(
          record,
          await client.cancel(
            { inputId: record.command.inputId, sourceRevision: found.sourceRef.sourceRevision },
            { signal: combined(operation) }
          )
        );
      },
      dispose() {
        disposed = true;
        stop();
        client.dispose();
        executionClient.dispose();
        unsubscribe();
        signal.removeEventListener("abort", stop);
      },
    };
  } catch (error) {
    unsubscribe();
    signal.removeEventListener("abort", stop);
    stop();
    throw error;
  }
}

export type NativeIntakeSession = Awaited<ReturnType<typeof openNativeIntake>>;

/** The protocol discriminators are factual lifecycle states, not prose classifiers. */
export function nativeIntakeDescription(result: NativeIntakeResult): string {
  switch (result.kind) {
    case "not-found":
      return "The latest lookup found no capture for this input. Retry submission keeps its original text and IDs; New request keeps this original saved for later inspection.";
    case "captured":
      return "Original source captured. Retry submission continues Jev admission with the same identity.";
    case "processing":
      return result.recovery === "required"
        ? "Admission was interrupted. Resume asks Jev to continue under a new recovery generation."
        : `Jev admission is ${result.stage}. Inspect to read its current state.`;
    case "work":
      return "Jev admitted this exact source to the work ledger. Native execution and verification are reported separately below.";
    case "turn":
      return `Jev routed this exact source to ${result.route}. Hosted conversation delivery is reported separately below.`;
    case "blocked":
      return result.reason === "unsupported-source"
        ? "Admission is blocked by an unsupported source. Submit a new complete request when that source is available."
        : "Admission is blocked by missing context. Submit a new complete request with the context included.";
    case "refused":
      return result.reason === "exhausted"
        ? "Jev admission refused this source after the bounded proposal attempts."
        : "Jev refused admission of this source.";
    case "cancelled":
      return "Intake was cancelled before work admission.";
  }
}
