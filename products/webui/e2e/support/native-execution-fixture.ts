/** Replay unchanged authenticated DaemonServer bytes, never synthetic execution receipts. */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Page, Route } from "@playwright/test";
import { firstJsonSchemaFailure } from "@goodvibes-jev/engine/transport-http";
import operatorContract from "@goodvibes-jev/engine/contracts/operator-contract.json" with { type: "json" };
import {
  nativeConversationIntakeCaptureRequestSchema,
  nativeConversationIntakeLookupResultSchema,
  nativeConversationIntakeTransitionRequestSchema,
  type NativeConversationIntakeCaptureRequest,
  type NativeConversationIntakeTransitionRequest,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import {
  nativeWorkExecutionRequestSchema,
  nativeWorkExecutionSnapshotSchema,
  type NativeWorkExecutionRequest,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import type { NativeExecutionBrowserRecord } from "../../src/lib/native-execution-journal";
import type { NativeIntakeBrowserRecord } from "../../src/lib/native-intake-journal";
import { installMockDaemon } from "./mock-daemon";
import type { RecordedRequest } from "./requests";

/**
 * Generic invoke uses POST for reads too. Classify those by canonical required
 * scopes, and fail closed for unknown or unclassified legacy methods. Direct
 * legacy HTTP mutations remain forbidden, including tasks.create at /task.
 */
export function isLegacyExecutionMutation(
  request: Pick<RecordedRequest, "method" | "path" | "methodId">
): boolean {
  if (
    request.method !== "GET" &&
    /^\/(?:api\/(?:contracts|tasks|sessions)(?:\/|$)|task(?:\/|$))/.test(request.path)
  )
    return true;
  if (!request.methodId || !/^(?:contracts|tasks|sessions)\./.test(request.methodId)) return false;
  const method = operatorContract.operator.methods.find((entry) => entry.id === request.methodId);
  return (
    !method ||
    method.scopes.length === 0 ||
    !method.scopes.every((scope) => scope.startsWith("read:"))
  );
}

export type NativeExecutionCaptureName =
  | "running"
  | "prepared"
  | "terminal"
  | "prevented"
  | "pending-intent"
  | "required"
  | "refused"
  | "cancelled-execution"
  | "settlement"
  | "settlement-required";
export type NativeExecutionOperation =
  | "capture"
  | "admit"
  | "start"
  | "status"
  | "resume"
  | "cancel";
export type NativeExecutionResponse = "captured" | "disconnected" | "server-error" | "malformed";
interface WireResponse {
  methodId: string;
  method: string;
  path: string;
  status: number;
  body: string;
  requestBody?: unknown;
  requestJson?: string;
}
interface NativeExecutionCapture {
  source: string;
  name: NativeExecutionCaptureName;
  input: NativeConversationIntakeCaptureRequest;
  transition: NativeConversationIntakeTransitionRequest;
  identity: NativeWorkExecutionRequest;
  auth: WireResponse;
  project: WireResponse;
  lookupBefore: WireResponse;
  capture: WireResponse;
  getCaptured: WireResponse;
  admit: WireResponse;
  get: WireResponse;
  notStarted: WireResponse;
  start: WireResponse;
  status: WireResponse;
  pending?: WireResponse;
  resume?: WireResponse;
  afterResume?: WireResponse;
  cancel?: WireResponse;
  afterCancel?: WireResponse;
}
type ExecutionPhase =
  | "notStarted"
  | "status"
  | "pending"
  | "afterResume"
  | "afterCancel"
  | "cancel";

export function loadNativeExecutionCapture(name: NativeExecutionCaptureName) {
  const capture = JSON.parse(
    readFileSync(new URL(`./fixtures/native-execution/${name}.json`, import.meta.url), "utf8")
  ) as NativeExecutionCapture;
  if (capture.name !== name) throw new Error(`Wrong native execution capture: ${name}`);
  nativeConversationIntakeCaptureRequestSchema.parse(capture.input);
  nativeConversationIntakeTransitionRequestSchema.parse(capture.transition);
  nativeWorkExecutionRequestSchema.parse(capture.identity);
  for (const value of Object.values(capture)) {
    if (!value || typeof value !== "object" || !("methodId" in value)) continue;
    const wire = value as WireResponse;
    if (
      wire.requestJson !== undefined &&
      !isDeepStrictEqual(JSON.parse(wire.requestJson), wire.requestBody)
    )
      throw new Error(`Request bytes differ from capture: ${name}/${wire.methodId}`);
    if (wire.status >= 400) continue;
    const schema = operatorContract.operator.methods.find(
      (entry) => entry.id === wire.methodId
    )?.outputSchema;
    const parsed: unknown = JSON.parse(wire.body);
    if (!schema || firstJsonSchemaFailure(schema, parsed))
      throw new Error(`Invalid ${name}/${wire.methodId} capture`);
    if (wire.methodId.startsWith("workLedger.intake.")) {
      const result = nativeConversationIntakeLookupResultSchema.parse(parsed);
      if (result.kind === "not-found") continue;
      if (
        result.requestId !== capture.input.requestId ||
        result.sourceRef.inputId !== capture.input.inputId ||
        result.sourceRef.sourceRevision !== capture.transition.sourceRevision ||
        result.projectId !== capture.identity.projectId ||
        (result.kind === "work" &&
          (result.receipt.goal !== capture.input.text ||
            result.receipt.workId !== capture.identity.workId ||
            result.receipt.attemptId !== capture.identity.attemptId ||
            !isDeepStrictEqual(result.receipt.expectedRevision, capture.identity.expectedRevision)))
      )
        throw new Error(`Mismatched original source: ${name}/${wire.methodId}`);
    }
    if (wire.methodId.startsWith("workLedger.execution.")) {
      const snapshot = nativeWorkExecutionSnapshotSchema.parse(parsed);
      if (
        snapshot.projectId !== capture.identity.projectId ||
        snapshot.workId !== capture.identity.workId ||
        snapshot.attemptId !== capture.identity.attemptId ||
        !isDeepStrictEqual(snapshot.expectedRevision, capture.identity.expectedRevision)
      )
        throw new Error(`Mismatched execution identity: ${name}/${wire.methodId}`);
    }
  }
  if (!isDeepStrictEqual(capture.capture.requestBody, capture.input))
    throw new Error(`Mismatched capture input: ${name}`);
  return capture;
}

/** Read actual persisted records only after the readonly transaction completes. */
export async function nativeBrowserRecords(page: Page) {
  return page.evaluate(async () => {
    const read = (name: string, store: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        let absent = false;
        request.onupgradeneeded = () => {
          // An inspection must never leave a schema-less database behind.
          absent = true;
          request.transaction?.abort();
          request.result.close();
          resolve([]);
        };
        request.onerror = () => {
          if (!absent) reject(request.error);
        };
        request.onblocked = () => reject(new Error(`Browser journal inspection blocked: ${name}`));
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction(store, "readonly");
          const records = tx.objectStore(store).getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(records.result);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    return {
      originals: await read("goodvibes.native-intake.v1", "captures"),
      targets: await read("goodvibes.native-execution.v1", "targets"),
    };
  }) as Promise<{
    originals: NativeIntakeBrowserRecord[];
    targets: NativeExecutionBrowserRecord[];
  }>;
}

/**
 * Only unrelated Work state is synthetic. Intake and execution fixtures preserve
 * the real daemon's exact IDs, request bodies, authority responses and HTTP bytes.
 */
export async function installNativeExecutionDaemon(
  page: Page,
  name: NativeExecutionCaptureName = "running",
  options: {
    hold?: NativeExecutionOperation[];
    responses?: Partial<Record<NativeExecutionOperation, NativeExecutionResponse>>;
  } = {}
) {
  const daemon = await installMockDaemon(page);
  const capture = loadNativeExecutionCapture(name);
  const held = new Set(options.hold ?? []);
  const responses = { ...options.responses };
  const requests: {
    operation: NativeExecutionOperation | "get";
    path: string;
    body: unknown;
    authorization: string | undefined;
  }[] = [];
  const pending: { operation: NativeExecutionOperation; route: Route; wire: WireResponse }[] = [];
  let intakePhase: "lookupBefore" | "getCaptured" | "get" = "lookupBefore";
  let executionPhase: ExecutionPhase = "notStarted";
  let authBody = capture.auth.body;
  const reply = (route: Route, wire: WireResponse) =>
    route.fulfill({ status: wire.status, contentType: "application/json", body: wire.body });
  await page.addInitScript(({ requestId, inputId }) => {
    localStorage.setItem("goodvibes.webui.hosted.clientId", "native-execution-proof-hosted-client");
    localStorage.setItem("goodvibes.webui.push.deviceId", "native-execution-proof-push-device");
    const original = crypto.randomUUID.bind(crypto);
    const ids = [requestId, inputId];
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => ids.shift() ?? original(),
    });
  }, capture.input);
  await page.route("**/api/control-plane/auth", (route) =>
    route.fulfill({ status: capture.auth.status, contentType: "application/json", body: authBody })
  );
  await page.route("**/api/work-ledger/project", (route) => reply(route, capture.project));
  async function answer(operation: NativeExecutionOperation, route: Route, wire: WireResponse) {
    const response = responses[operation];
    if (response === "disconnected") return route.abort("connectionreset");
    if (response === "server-error")
      return route.fulfill({
        status: 503,
        json: { error: "Owned browser fixture interrupted the response after receipt." },
      });
    if (response === "malformed")
      return route.fulfill({
        json: { invalid: "deliberately malformed response, never an execution snapshot" },
      });
    return reply(route, wire);
  }
  await page.route("**/api/work-ledger/{intake,execution}/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const operation = path.split("/").at(-1) as NativeExecutionOperation | "get";
    const execution = path.includes("/execution/");
    const body: unknown = request.postDataJSON();
    requests.push({ operation, path, body, authorization: request.headers().authorization });
    const expected = execution
      ? capture.identity
      : operation === "capture"
        ? capture.input
        : operation === "get"
          ? { inputId: capture.input.inputId }
          : capture.transition;
    if (request.method() !== "POST" || !isDeepStrictEqual(body, expected))
      return route.fulfill({
        status: 409,
        json: { error: "Browser request differs from the real daemon capture." },
      });
    let wire: WireResponse | undefined;
    if (!execution) {
      if (operation === "get") return reply(route, capture[intakePhase]);
      if (operation === "capture") {
        wire = capture.capture;
        intakePhase = "getCaptured";
      } else if (operation === "admit") {
        wire = capture.admit;
        intakePhase = "get";
      }
    } else {
      if (operation === "status") wire = capture[executionPhase];
      else if (operation === "start") {
        wire = capture.start;
        executionPhase = held.has("start") && capture.pending ? "pending" : "status";
      } else if (operation === "resume") {
        wire = capture.resume;
        executionPhase = capture.afterResume ? "afterResume" : "status";
      } else if (operation === "cancel") {
        wire = capture.cancel;
        executionPhase = capture.afterCancel ? "afterCancel" : "cancel";
      }
    }
    if (!wire || operation === "get")
      throw new Error(`No genuine ${name} wire for ${path}/${executionPhase}`);
    if (held.has(operation)) {
      pending.push({ operation, route, wire });
      return;
    }
    return answer(operation, route, wire);
  });
  return {
    ...daemon,
    capture,
    nativeRequests: requests,
    get writes() {
      return requests.filter((request) => !["get", "status"].includes(request.operation));
    },
    get executionRequests() {
      return requests.filter((request) => request.path.includes("/execution/"));
    },
    get executionWrites() {
      return requests.filter(
        (request) => request.path.includes("/execution/") && request.operation !== "status"
      );
    },
    get pendingCount() {
      return pending.length;
    },
    async release(operation?: NativeExecutionOperation) {
      if (operation) held.delete(operation);
      else held.clear();
      const selected = pending.filter(
        (item) => operation === undefined || item.operation === operation
      );
      for (const item of selected) pending.splice(pending.indexOf(item), 1);
      await Promise.all(selected.map((item) => answer(item.operation, item.route, item.wire)));
    },
    setResponse(operation: NativeExecutionOperation, response: NativeExecutionResponse) {
      responses[operation] = response;
    },
    setIntakePhase(phase: "lookupBefore" | "getCaptured" | "get") {
      intakePhase = phase;
    },
    setStatus(phase: ExecutionPhase) {
      if (!capture[phase]) throw new Error(`No genuine ${name}/${phase} status`);
      executionPhase = phase;
    },
    /** Explicit authority failure injection. Ordinary auth uses captured bytes. */
    setAuthResponse(value: unknown) {
      authBody = JSON.stringify(value);
    },
  };
}
