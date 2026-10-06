/** Real daemon/Orchestrator captures. Native success bodies are never reconstructed. */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Page, Route } from "@playwright/test";
import { firstJsonSchemaFailure } from "@goodvibes-jev/engine/transport-http";
import operatorContract from "@goodvibes-jev/engine/contracts/operator-contract.json" with { type: "json" };
import {
  nativeConversationIntakeCaptureRequestSchema,
  nativeConversationIntakeLookupResultSchema,
  type NativeConversationIntakeCaptureRequest,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import {
  nativeHostedSessionLookupSchema,
  nativeHostedTurnLookupSchema,
  nativeHostedTurnRequestSchema,
  type NativeHostedTurnRequest,
} from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { installMockDaemon } from "./mock-daemon";

export type ContinuationCase =
  | "second"
  | "active"
  | "queuedCancel"
  | "queuedDelivery"
  | "runningCancel";
export type ContinuationOperation =
  | "session"
  | "capture"
  | "admit"
  | "get"
  | "status"
  | "start"
  | "cancel";
interface Wire {
  methodId: string;
  method: string;
  path: string;
  requestBody?: unknown;
  requestJson?: string;
  status: number;
  body: string;
}
interface RecordedTurn {
  input: NativeConversationIntakeCaptureRequest;
  identity: NativeHostedTurnRequest;
  capture: Wire;
  admit: Wire;
  get: Wire;
  absent: Wire;
  start: Wire;
  status: Wire;
  duplicate?: Wire;
  cancel?: Wire;
  discovery?: Wire;
  attachment?: {
    session: Record<string, unknown>;
    history: { role: "user" | "assistant" | "system" | "tool"; content: string }[];
  };
}
interface ContinuationCapture {
  source: string;
  sessionId: string;
  auth: Wire;
  project: Wire;
  discovery: Wire;
  busyDiscovery: Wire;
  legacy: Wire;
  initial: RecordedTurn;
  second: RecordedTurn;
  active: RecordedTurn;
  queuedCancel: RecordedTurn;
  queuedDelivery: RecordedTurn;
  runningCancel: RecordedTurn;
  other: RecordedTurn;
  modelRequests: { messages: { role: string; content: unknown }[]; stream?: boolean }[];
}

function validateWire(wire: Wire) {
  const method = operatorContract.operator.methods.find((entry) => entry.id === wire.methodId);
  if (!method || method.http?.method !== wire.method || method.http.path !== wire.path)
    throw new Error(`Noncanonical continuation route: ${wire.methodId}`);
  if (
    wire.requestJson !== undefined &&
    !isDeepStrictEqual(JSON.parse(wire.requestJson), wire.requestBody)
  )
    throw new Error(`Continuation request bytes differ: ${wire.methodId}`);
  if (
    wire.requestBody !== undefined &&
    (!method.inputSchema || firstJsonSchemaFailure(method.inputSchema, wire.requestBody))
  )
    throw new Error(`Invalid continuation input: ${wire.methodId}`);
  if (wire.status !== 200 || firstJsonSchemaFailure(method.outputSchema, JSON.parse(wire.body)))
    throw new Error(`Invalid continuation response: ${wire.methodId}`);
}
export function loadNativeContinuationCapture(): ContinuationCapture {
  const capture = JSON.parse(
    readFileSync(
      new URL("./fixtures/native-session-continuation/lifecycle.json", import.meta.url),
      "utf8"
    )
  ) as ContinuationCapture;
  for (const wire of [
    capture.auth,
    capture.project,
    capture.discovery,
    capture.busyDiscovery,
    capture.legacy,
  ])
    validateWire(wire);
  const discovery = nativeHostedSessionLookupSchema.parse(JSON.parse(capture.discovery.body));
  if (discovery.kind !== "native" || discovery.sessionId !== capture.sessionId || discovery.busy)
    throw new Error("Missing genuine idle native-session discovery");
  for (const [name, turn] of Object.entries(capture).filter(
    (entry): entry is [string, RecordedTurn] =>
      Boolean(entry[1] && typeof entry[1] === "object" && "identity" in entry[1])
  )) {
    nativeConversationIntakeCaptureRequestSchema.parse(turn.input);
    nativeHostedTurnRequestSchema.parse(turn.identity);
    if (
      !isDeepStrictEqual(turn.capture.requestBody, turn.input) ||
      turn.identity.inputId !== turn.input.inputId
    )
      throw new Error(`Changed continuation original: ${name}`);
    for (const value of Object.values(turn)) {
      if (!value || typeof value !== "object" || !("methodId" in value)) continue;
      const wire = value as Wire;
      validateWire(wire);
      if (wire.methodId === "workLedger.turn.session") {
        const session = nativeHostedSessionLookupSchema.parse(JSON.parse(wire.body));
        if (
          session.kind !== "native" ||
          !isDeepStrictEqual(wire.requestBody, { sessionId: session.sessionId })
        )
          throw new Error(`Changed native discovery: ${name}`);
      } else if (wire.methodId.startsWith("workLedger.turn.")) {
        if (!isDeepStrictEqual(wire.requestBody, turn.identity))
          throw new Error(`Changed canonical turn identity: ${name}`);
        const result = nativeHostedTurnLookupSchema.parse(JSON.parse(wire.body));
        if (
          !("kind" in result) &&
          (result.inputId !== turn.input.inputId ||
            result.requestId !== turn.input.requestId ||
            result.sourceRevision !== turn.identity.sourceRevision ||
            result.projectId !== turn.identity.projectId)
        )
          throw new Error(`Changed recorded turn identity: ${name}`);
      } else if (wire.methodId.startsWith("workLedger.intake.")) {
        const source = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(wire.body));
        if (
          source.kind === "not-found" ||
          source.sourceRef.inputId !== turn.input.inputId ||
          source.sourceRef.sourceRevision !== turn.identity.sourceRevision ||
          source.projectId !== turn.identity.projectId ||
          source.requestId !== turn.input.requestId
        )
          throw new Error(`Changed recorded source: ${name}`);
        if (
          source.kind === "turn" &&
          (source.text !== turn.input.text ||
            (turn.input.continuation &&
              source.continuation?.sessionId !== turn.input.continuation.sessionId))
        )
          throw new Error(`Changed recorded continuation: ${name}`);
      }
    }
    if (
      !isDeepStrictEqual(turn.get.requestBody, { inputId: turn.input.inputId }) ||
      turn.get.body !== turn.admit.body
    )
      throw new Error(`Invalid original read proof: ${name}`);
  }
  return capture;
}

/** Only navigation labels and unrelated shell state are synthetic. */
export async function installNativeContinuationDaemon(
  page: Page,
  options: {
    cases?: ContinuationCase[];
    holdStart?: boolean;
    loseStartAcknowledgement?: boolean;
    discoveryFailure?: boolean;
    busy?: boolean;
  } = {}
) {
  const capture = loadNativeContinuationCapture();
  const cases = options.cases ?? ["second"];
  const initialAttachment = capture.initial.attachment;
  const otherAttachment = capture.other.attachment;
  const otherDiscovery = capture.other.discovery;
  if (!initialAttachment || !otherAttachment || !otherDiscovery)
    throw new Error("Missing genuine native session attachments/discovery");
  const otherSessionId = String(otherAttachment.session.id);
  const title = "Recorded native continuation";
  const otherTitle = "Other recorded native session";
  const daemon = await installMockDaemon(page, {
    approvals: [],
    hostedSessions: [
      { ...initialAttachment.session, title, attachedClients: [] },
      { ...otherAttachment.session, title: otherTitle, attachedClients: [] },
    ],
    hostedSessionHistory: {
      [capture.sessionId]: initialAttachment.history,
      [otherSessionId]: otherAttachment.history,
    },
  });
  await page.route(/\/api\/sessions(?:\?|$)/, (route) =>
    route.fulfill({ json: { sessions: [], totals: { sessions: 0, active: 0, closed: 0 } } })
  );
  const nativeRequests: {
    operation: ContinuationOperation;
    path: string;
    body: unknown;
    authorization?: string;
  }[] = [];
  const phase = new Map(cases.map((name) => [name, "absent" as "absent" | "start" | "status"]));
  const pending: { route: Route; wire: Wire }[] = [];
  let holdStart = options.holdStart === true;
  const reply = (route: Route, wire: Wire) =>
    route.fulfill({ status: wire.status, contentType: "application/json", body: wire.body });
  await page.addInitScript(
    (ids: string[]) => {
      localStorage.setItem("goodvibes.webui.hosted.clientId", "native-continuation-proof-client");
      localStorage.setItem("goodvibes.webui.push.deviceId", "native-continuation-proof-device");
      const original = crypto.randomUUID.bind(crypto);
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: () => {
          const index = Number(sessionStorage.getItem("native-continuation-proof-id") ?? 0);
          if (index >= ids.length) return original();
          sessionStorage.setItem("native-continuation-proof-id", String(index + 1));
          return ids[index];
        },
      });
    },
    cases.flatMap((name) => [capture[name].input.requestId, capture[name].input.inputId])
  );
  await page.route("**/api/control-plane/auth", (route) => reply(route, capture.auth));
  await page.route("**/api/work-ledger/project", (route) => reply(route, capture.project));
  await page.route("**/api/work-ledger/{intake,turn}/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const operation = path.split("/").at(-1) as ContinuationOperation;
    const body: unknown = request.postDataJSON();
    nativeRequests.push({ operation, path, body, authorization: request.headers().authorization });
    if (operation === "session") {
      if (options.discoveryFailure)
        return route.fulfill({
          status: 403,
          json: { error: "Native session owner verification denied." },
        });
      if (isDeepStrictEqual(body, { sessionId: capture.sessionId }))
        return reply(route, options.busy ? capture.busyDiscovery : capture.discovery);
      if (isDeepStrictEqual(body, { sessionId: otherSessionId }))
        return reply(route, otherDiscovery);
      throw new Error(`No genuine native discovery for ${JSON.stringify(body)}`);
    }
    const name = cases.find(
      (candidate) => capture[candidate].input.inputId === (body as { inputId?: string }).inputId
    );
    if (!name)
      return route.fulfill({
        status: 409,
        json: { error: "No genuine captured original for this request." },
      });
    const turn = capture[name],
      isTurn = path.includes("/turn/");
    const expected = isTurn
      ? turn.identity
      : operation === "capture"
        ? turn.input
        : operation === "get"
          ? { inputId: turn.input.inputId }
          : turn.admit.requestBody;
    if (request.method() !== "POST" || !isDeepStrictEqual(body, expected))
      return route.fulfill({
        status: 409,
        json: { error: "Request differs from the exact original continuation capture." },
      });
    let wire: Wire | undefined;
    if (!isTurn) {
      if (operation === "capture") wire = turn.capture;
      if (operation === "admit") wire = turn.admit;
      if (operation === "get") wire = turn.get;
    } else {
      if (operation === "status") wire = turn[phase.get(name) ?? "absent"];
      if (operation === "start") {
        wire = turn.start;
        phase.set(name, turn.cancel ? "start" : "status");
      }
      if (operation === "cancel") {
        wire = turn.cancel;
        phase.set(name, "status");
      }
    }
    if (!wire) throw new Error(`No genuine continuation response: ${name}/${path}`);
    if (operation === "start" && holdStart) {
      pending.push({ route, wire });
      return;
    }
    if (operation === "start" && options.loseStartAcknowledgement)
      return route.abort("connectionreset");
    return reply(route, wire);
  });
  return {
    ...daemon,
    capture,
    title,
    otherTitle,
    otherSessionId,
    nativeRequests,
    get writes() {
      return nativeRequests.filter(
        (request) => !["session", "get", "status"].includes(request.operation)
      );
    },
    get pendingCount() {
      return pending.length;
    },
    async releaseStart() {
      holdStart = false;
      await Promise.all(
        pending.splice(0).map((item) => reply(item.route, item.wire).catch(() => undefined))
      );
    },
  };
}
