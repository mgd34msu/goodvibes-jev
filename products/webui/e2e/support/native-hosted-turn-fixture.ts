/** Exact paired DaemonServer/owned-model captures, never fabricated hosted delivery identities. */
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
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import {
  nativeHostedTurnLookupSchema,
  nativeHostedTurnRequestSchema,
  type NativeHostedTurnRequest,
} from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { installMockDaemon } from "./mock-daemon";

export type NativeHostedTurnCaptureName = "completed" | "cancelled";
export type NativeHostedTurnOperation = "capture" | "admit" | "get" | "status" | "start" | "cancel";
interface WireResponse {
  methodId: string;
  method: string;
  path: string;
  status: number;
  body: string;
  requestBody?: unknown;
  requestJson?: string;
}
interface NativeHostedTurnCapture {
  source: string;
  input: NativeConversationIntakeCaptureRequest;
  identity: NativeHostedTurnRequest;
  auth: WireResponse;
  project: WireResponse;
  capture: WireResponse;
  admit: WireResponse;
  get: WireResponse;
  absent: WireResponse;
  start: WireResponse;
  status: WireResponse;
  duplicate?: WireResponse;
  cancel?: WireResponse;
  attachment?: {
    session: { id: string; turnCount: number; messageCount: number; contractIds: string[] };
    history: { role: string; content: string }[];
  };
}

export function loadNativeHostedTurnCapture(name: NativeHostedTurnCaptureName) {
  const capture = JSON.parse(
    readFileSync(new URL(`./fixtures/native-hosted-turn/${name}.json`, import.meta.url), "utf8")
  ) as NativeHostedTurnCapture;
  nativeConversationIntakeCaptureRequestSchema.parse(capture.input);
  nativeHostedTurnRequestSchema.parse(capture.identity);
  const transition = nativeConversationIntakeTransitionRequestSchema.parse({
    inputId: capture.input.inputId,
    sourceRevision: capture.identity.sourceRevision,
  });
  if (
    capture.identity.inputId !== capture.input.inputId ||
    !isDeepStrictEqual(capture.capture.requestBody, capture.input) ||
    !isDeepStrictEqual(capture.admit.requestBody, transition)
  )
    throw new Error(`Mismatched original hosted-turn request: ${name}`);
  for (const value of Object.values(capture)) {
    if (!value || typeof value !== "object" || !("methodId" in value)) continue;
    const wire = value as WireResponse;
    const method = operatorContract.operator.methods.find((entry) => entry.id === wire.methodId);
    if (!method || method.http?.method !== wire.method || method.http.path !== wire.path)
      throw new Error(`Noncanonical captured route: ${name}/${wire.methodId}`);
    if (
      wire.requestJson !== undefined &&
      !isDeepStrictEqual(JSON.parse(wire.requestJson), wire.requestBody)
    )
      throw new Error(`Captured request bytes differ: ${name}/${wire.methodId}`);
    if (
      wire.requestBody !== undefined &&
      (!method.inputSchema || firstJsonSchemaFailure(method.inputSchema, wire.requestBody))
    )
      throw new Error(`Invalid captured request: ${name}/${wire.methodId}`);
    if (wire.status >= 400)
      throw new Error(`Unexpected unsuccessful native capture: ${name}/${wire.methodId}`);
    const parsed: unknown = JSON.parse(wire.body);
    if (firstJsonSchemaFailure(method.outputSchema, parsed))
      throw new Error(`Invalid captured response: ${name}/${wire.methodId}`);
    if (wire.methodId.startsWith("workLedger.intake.")) {
      const result = nativeConversationIntakeLookupResultSchema.parse(parsed);
      if (
        result.kind === "not-found" ||
        result.requestId !== capture.input.requestId ||
        result.sourceRef.inputId !== capture.input.inputId ||
        result.sourceRef.sourceRevision !== capture.identity.sourceRevision ||
        result.projectId !== capture.identity.projectId ||
        (result.kind === "turn" && result.text !== capture.input.text)
      )
        throw new Error(`Captured intake differs from original source: ${name}/${wire.methodId}`);
    }
    if (wire.methodId.startsWith("workLedger.turn.")) {
      if (!isDeepStrictEqual(wire.requestBody, capture.identity))
        throw new Error(`Captured delivery request changed identity: ${name}/${wire.methodId}`);
      const snapshot = nativeHostedTurnLookupSchema.parse(parsed);
      if (
        !("kind" in snapshot) &&
        (snapshot.projectId !== capture.identity.projectId ||
          snapshot.requestId !== capture.input.requestId ||
          snapshot.inputId !== capture.identity.inputId ||
          snapshot.sourceRevision !== capture.identity.sourceRevision)
      )
        throw new Error(`Captured delivery changed original source: ${name}/${wire.methodId}`);
    }
  }
  if (
    capture.get.methodId !== "workLedger.intake.get" ||
    capture.status.methodId !== "workLedger.turn.status"
  )
    throw new Error(`Read proof requires genuine get/status captures: ${name}`);
  if (!isDeepStrictEqual(capture.get.requestBody, { inputId: capture.input.inputId }))
    throw new Error(`Captured source lookup changed identity: ${name}`);
  return capture;
}

/** Unrelated shell state is synthetic; every native success response uses unchanged HTTP bytes. */
export async function installNativeHostedTurnDaemon(
  page: Page,
  name: NativeHostedTurnCaptureName = "completed",
  options: {
    hold?: NativeHostedTurnOperation[];
    loseStartAcknowledgement?: boolean;
  } = {}
) {
  const daemon = await installMockDaemon(page);
  const capture = loadNativeHostedTurnCapture(name);
  const held = new Set(options.hold ?? []);
  const nativeRequests: {
    operation: NativeHostedTurnOperation;
    path: string;
    body: unknown;
    authorization: string | undefined;
  }[] = [];
  const pending: { operation: NativeHostedTurnOperation; route: Route; wire: WireResponse }[] = [];
  let turnPhase: "absent" | "status" = "absent";
  let admitted = false;
  const reply = (route: Route, wire: WireResponse) =>
    route.fulfill({ status: wire.status, contentType: "application/json", body: wire.body });
  await page.addInitScript(({ requestId, inputId }) => {
    localStorage.setItem("goodvibes.webui.hosted.clientId", "native-hosted-turn-proof-client");
    localStorage.setItem("goodvibes.webui.push.deviceId", "native-hosted-turn-proof-device");
    const original = crypto.randomUUID.bind(crypto);
    const ids = [requestId, inputId];
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => ids.shift() ?? original(),
    });
  }, capture.input);
  await page.route("**/api/control-plane/auth", (route) => reply(route, capture.auth));
  await page.route("**/api/work-ledger/project", (route) => reply(route, capture.project));
  await page.route("**/api/work-ledger/{intake,turn}/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const operation = path.split("/").at(-1) as NativeHostedTurnOperation;
    const isTurn = path.includes("/turn/");
    const body: unknown = request.postDataJSON();
    nativeRequests.push({ operation, path, body, authorization: request.headers().authorization });
    const expected = isTurn
      ? capture.identity
      : operation === "capture"
        ? capture.input
        : operation === "get"
          ? { inputId: capture.input.inputId }
          : capture.admit.requestBody;
    if (request.method() !== "POST" || !isDeepStrictEqual(body, expected))
      return route.fulfill({
        status: 409,
        json: { error: "Browser request differs from the exact native capture." },
      });
    let wire: WireResponse | undefined;
    if (!isTurn) {
      if (operation === "capture") wire = capture.capture;
      if (operation === "admit") {
        wire = capture.admit;
        admitted = true;
      }
      if (operation === "get" && admitted) wire = capture.get;
    } else {
      if (operation === "status") wire = capture[turnPhase];
      if (operation === "start") {
        wire = capture.start;
        turnPhase = "status";
      }
      if (operation === "cancel") {
        wire = capture.cancel;
        turnPhase = "status";
      }
    }
    if (!wire) throw new Error(`No genuine ${name} native wire for ${path}`);
    if (held.has(operation)) {
      pending.push({ operation, route, wire });
      return;
    }
    if (operation === "start" && options.loseStartAcknowledgement)
      return route.abort("connectionreset");
    return reply(route, wire);
  });
  return {
    ...daemon,
    capture,
    nativeRequests,
    get writes() {
      return nativeRequests.filter((request) => !["get", "status"].includes(request.operation));
    },
    get turnRequests() {
      return nativeRequests.filter((request) => request.path.includes("/turn/"));
    },
    get turnWrites() {
      return nativeRequests.filter(
        (request) => request.path.includes("/turn/") && request.operation !== "status"
      );
    },
    get pendingCount() {
      return pending.length;
    },
    async release(operation: NativeHostedTurnOperation) {
      held.delete(operation);
      const selected = pending.filter((item) => item.operation === operation);
      for (const item of selected) pending.splice(pending.indexOf(item), 1);
      await Promise.all(selected.map((item) => reply(item.route, item.wire)));
    },
  };
}
