/** Native source, checkpoints, and outcomes are unchanged paired-daemon wire captures. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Page, Route } from "@playwright/test";
import { firstJsonSchemaFailure } from "@goodvibes-jev/engine/transport-http";
import operatorContract from "@goodvibes-jev/engine/contracts/operator-contract.json" with { type: "json" };
import {
  nativeConversationIntakeCaptureRequestSchema,
  nativeConversationIntakeLookupResultSchema,
  selectNativeDiffHunk,
  type NativeConversationIntakeCaptureRequest,
} from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import {
  nativeHostedSessionLookupSchema,
  nativeHostedTurnLookupSchema,
} from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { nativeWorkExecutionSnapshotSchema } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import { installMockDaemon } from "./mock-daemon";
import { sessionRecord, STEERABLE_SESSION } from "./seed";

export interface DiffWire {
  methodId: string;
  method: string;
  path: string;
  requestBody?: unknown;
  requestJson?: string;
  status: number;
  body: string;
}
export interface RecordedDiffCase {
  command: NativeConversationIntakeCaptureRequest;
  capture: DiffWire;
  diff?: DiffWire;
  admit?: DiffWire;
  get?: DiffWire;
  getCaptured?: DiffWire;
  absent?: DiffWire;
  start?: DiffWire;
  status?: DiffWire;
  cancel?: DiffWire;
  [key: string]: unknown;
}
export type DiffCaseName =
  | "session"
  | "workspace"
  | "repeated"
  | "stale"
  | "cancel"
  | "queuedCancel"
  | "queuedDelivery";
export interface SelectedDiffCapture {
  source: string;
  projectId: string;
  sessionId: string;
  sessionList: DiffWire;
  sharedSession: DiffWire;
  sessionRow: ReturnType<typeof sessionRecord>;
  auth: DiffWire;
  project: DiffWire;
  discovery: DiffWire;
  discoveryDenied: DiffWire;
  changedSessionDiff: DiffWire;
  checkpoints: DiffWire;
  legacy?: DiffWire;
  busyDiscovery?: DiffWire;
  session: RecordedDiffCase;
  workspace: RecordedDiffCase;
  repeated: RecordedDiffCase;
  stale: RecordedDiffCase;
  cancel: RecordedDiffCase;
  queuedCancel: RecordedDiffCase;
  queuedDelivery: RecordedDiffCase;
}

function wires(value: unknown): DiffWire[] {
  if (!value || typeof value !== "object") return [];
  if ("methodId" in value && "body" in value && "status" in value) return [value as DiffWire];
  return Object.values(value).flatMap(wires);
}
export function recordedUnifiedDiff(wire: DiffWire): string {
  const body = JSON.parse(wire.body) as { unifiedDiff?: string; diff?: { unifiedDiff: string } };
  const text = body.unifiedDiff ?? body.diff?.unifiedDiff;
  if (typeof text !== "string") throw new Error("Missing genuine checkpoint diff");
  return text;
}
export function selectedDiffPreview(
  capture: SelectedDiffCapture,
  name: DiffCaseName = "session"
): string {
  const scenario = capture[name];
  const selector = scenario.command.continuation?.selectedDiff;
  const diff =
    scenario.diff ??
    (selector?.kind === "workspace" ? capture.workspace.diff : capture.session.diff);
  if (!selector || !diff) throw new Error(`Missing selected diff source: ${name}`);
  return selectNativeDiffHunk(recordedUnifiedDiff(diff), selector.fileIndex, selector.hunkIndex);
}
export function validateSelectedDiffCapture(capture: SelectedDiffCapture): void {
  for (const wire of wires(capture)) {
    const method = operatorContract.operator.methods.find((entry) => entry.id === wire.methodId);
    if (!method) throw new Error(`Unknown captured method: ${wire.methodId}`);
    const invoke = `/api/control-plane/methods/${encodeURIComponent(wire.methodId)}/invoke`;
    if (
      !(
        (method.http?.path === wire.path && method.http.method === wire.method) ||
        (wire.method === "POST" && wire.path === invoke)
      )
    )
      throw new Error(`Noncanonical selected-diff route: ${wire.methodId}`);
    if (
      wire.requestJson !== undefined &&
      !isDeepStrictEqual(
        JSON.parse(wire.requestJson),
        wire.path === invoke ? { body: wire.requestBody } : wire.requestBody
      )
    )
      throw new Error(`Changed captured request bytes: ${wire.methodId}`);
    if (
      wire.requestBody !== undefined &&
      method.inputSchema &&
      firstJsonSchemaFailure(method.inputSchema, wire.requestBody)
    )
      throw new Error(`Invalid selected-diff input: ${wire.methodId}`);
    if (wire.status >= 400) continue;
    const body: unknown = JSON.parse(wire.body);
    if (wire.status !== 200 || firstJsonSchemaFailure(method.outputSchema, body))
      throw new Error(`Invalid selected-diff output: ${wire.methodId}`);
    if (wire.methodId === "sessions.changes.get" || wire.methodId === "checkpoints.diff") {
      const read = body as { nativeRevision?: string; diff?: { nativeRevision?: string } };
      const revision = read.diff?.nativeRevision ?? read.nativeRevision;
      if (revision !== createHash("sha256").update(recordedUnifiedDiff(wire)).digest("hex"))
        throw new Error(`Invalid host-written native diff revision: ${wire.methodId}`);
    }
    if (wire.methodId.startsWith("workLedger.intake."))
      nativeConversationIntakeLookupResultSchema.parse(body);
    if (wire.methodId.startsWith("workLedger.execution."))
      nativeWorkExecutionSnapshotSchema.parse(body);
    if (wire.methodId.startsWith("workLedger.turn.")) {
      if (wire.methodId.endsWith(".session")) nativeHostedSessionLookupSchema.parse(body);
      else nativeHostedTurnLookupSchema.parse(body);
    }
  }
  const navigation = JSON.parse(capture.sessionList.body) as { sessions: unknown[] };
  const shared = JSON.parse(capture.sharedSession.body) as {
    session: ReturnType<typeof sessionRecord>;
  };
  const stableSessionKeys = ["id", "kind", "project", "title", "status"] as const;
  if (
    capture.sessionRow.id !== capture.sessionId ||
    capture.sessionRow.kind !== "hosted" ||
    !navigation.sessions.some((row) => isDeepStrictEqual(row, capture.sessionRow)) ||
    !stableSessionKeys.every((key) => shared.session[key] === capture.sessionRow[key])
  )
    throw new Error(
      "Native selected session is not reachable through the real shared-session catalog"
    );
  const discovery = nativeHostedSessionLookupSchema.parse(JSON.parse(capture.discovery.body));
  if (
    discovery.kind !== "native" ||
    discovery.sessionId !== capture.sessionId ||
    discovery.projectId !== capture.projectId
  )
    throw new Error("Selected change lacks genuine native ownership");
  for (const name of [
    "session",
    "workspace",
    "repeated",
    "stale",
    "cancel",
    "queuedCancel",
    "queuedDelivery",
  ] as const) {
    const scenario = capture[name];
    if (!scenario) throw new Error(`Missing selected-diff recording: ${name}`);
    const command = nativeConversationIntakeCaptureRequestSchema.parse(scenario.command);
    if (
      !isDeepStrictEqual(command, scenario.capture.requestBody) ||
      command.continuation?.sessionId !== capture.sessionId
    )
      throw new Error(`Changed selected-diff original: ${name}`);
    const selector = command.continuation.selectedDiff;
    if (!selector) throw new Error(`Missing selected-diff selector: ${name}`);
    if (scenario.capture.status < 400) {
      const diff =
        scenario.diff ??
        (selector.kind === "workspace" ? capture.workspace.diff : capture.session.diff);
      if (
        !diff ||
        selector.revision !== createHash("sha256").update(recordedUnifiedDiff(diff)).digest("hex")
      )
        throw new Error(`Changed full-diff revision: ${name}`);
      selectedDiffPreview(capture, name);
    }
    for (const wire of [scenario.capture, scenario.admit, scenario.getCaptured, scenario.get]) {
      if (!wire || wire.status >= 400) continue;
      const source = nativeConversationIntakeLookupResultSchema.parse(JSON.parse(wire.body));
      if (source.kind === "not-found") continue;
      if (
        source.sourceRef.inputId !== command.inputId ||
        source.requestId !== command.requestId ||
        source.projectId !== capture.projectId
      )
        throw new Error(`Changed selected-diff source identity: ${name}`);
      if (!isDeepStrictEqual(source.sourceRef.continuation?.selectedDiff, selector))
        throw new Error(`Changed selected-diff source provenance: ${name}`);
      if (
        source.kind === "turn" &&
        (source.text !== command.text ||
          source.continuation?.selectedDiff?.unifiedDiff !== selectedDiffPreview(capture, name))
      )
        throw new Error(`Changed original comment or complete hunk: ${name}`);
      if (
        source.kind === "work" &&
        (source.receipt.goal !== command.text ||
          source.receipt.source.continuation?.selectedDiff?.unifiedDiff !==
            selectedDiffPreview(capture, name))
      )
        throw new Error(`Changed work original comment or complete hunk: ${name}`);
    }
  }
}
export function loadSelectedDiffCapture(): SelectedDiffCapture {
  const capture = JSON.parse(
    readFileSync(new URL("./fixtures/native-selected-diff/lifecycle.json", import.meta.url), "utf8")
  ) as SelectedDiffCapture;
  validateSelectedDiffCapture(capture);
  return capture;
}

type DeliveryPhase = "absent" | "start" | "status";
/** Mutation acknowledgement and later status reads are distinct recorded routes. */
export function selectedDiffDeliveryPhaseAfterMutation(
  scenario: RecordedDiffCase,
  operation: "start" | "cancel"
): DeliveryPhase {
  return operation === "start" && scenario.cancel ? "start" : "status";
}

/** Only navigation rows and unrelated shell state are synthetic. */
export async function installSelectedDiffDaemon(
  page: Page,
  options: {
    cases?: DiffCaseName[];
    hold?: "capture" | "admit" | "start" | "cancel";
    loseStartAcknowledgement?: boolean;
    discoveryFailure?: boolean;
    busy?: boolean;
  } = {}
) {
  const capture = loadSelectedDiffCapture();
  const cases = options.cases ?? ["session"];
  const daemon = await installMockDaemon(page, {
    localSessionId: capture.sessionId,
    approvals: [],
    hostedSessions: [],
  });
  // The native row (including real kind:'hosted') is an actual shared-session
  // catalog record. Only its display title is cosmetic browser navigation.
  const session = { ...capture.sessionRow, title: "Recorded native selected changes" };
  const other = sessionRecord({
    ...STEERABLE_SESSION,
    id: "unrelated-legacy-selection",
    title: "Other session changes",
  });
  await page.route(/\/api\/sessions(?:\/|\?|$)/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/sessions")
      return route.fulfill({
        json: { sessions: [session, other], totals: { sessions: 2, active: 2, closed: 0 } },
      });
    for (const record of [session, other]) {
      if (path === `/api/sessions/${record.id}`)
        return route.fulfill({ json: { session: record } });
      if (path === `/api/sessions/${record.id}/messages`)
        return route.fulfill({ json: { session: record, messages: [] } });
    }
    return route.fallback();
  });
  const fleetTitle = "Recorded selected-hunk process";
  const fleet = {
    capturedAt: 1000,
    truncated: false,
    totalCount: 1,
    nodes: [
      {
        id: "recorded-selected-hunk-process",
        label: fleetTitle,
        kind: "agent",
        state: "thinking",
        elapsedMs: 0,
        costState: "unpriced",
        capabilities: {
          interruptible: false,
          killable: false,
          pausable: false,
          resumable: false,
          steerable: true,
        },
        sessionRef: { sessionId: capture.sessionId },
      },
    ],
  };
  const fleetMethod = operatorContract.operator.methods.find(
    (entry) => entry.id === "fleet.snapshot"
  );
  if (!fleetMethod || firstJsonSchemaFailure(fleetMethod.outputSchema, fleet))
    throw new Error("Invalid selected-hunk Fleet navigation");
  await page.route("**/api/control-plane/methods/fleet.snapshot/invoke", (route) =>
    route.fulfill({ json: fleet })
  );
  await page.route("**/api/control-plane/methods/fleet.list/invoke", (route) =>
    route.fulfill({ json: { items: fleet.nodes, hasMore: false, capturedAt: fleet.capturedAt } })
  );
  const reply = (route: Route, wire: DiffWire) =>
    route.fulfill({ status: wire.status, contentType: "application/json", body: wire.body });
  const expectedBody = (route: Route): unknown => {
    const body: unknown = route.request().postDataJSON();
    return route.request().url().includes("/methods/") &&
      body &&
      typeof body === "object" &&
      "body" in body
      ? body.body
      : body;
  };
  const pending: { operation: string; route: Route; wire: DiffWire }[] = [];
  let held = options.hold;
  let discoveryFailure = options.discoveryFailure === true;
  let changedSessionDiff = false;
  const phase = new Map<DiffCaseName, DeliveryPhase>();
  const intakeCancelled = new Set<DiffCaseName>();
  const nativeRequests: {
    methodId: string;
    operation: string;
    body: unknown;
    authorization?: string;
  }[] = [];
  const failures: string[] = [];
  await page.addInitScript(
    (ids: string[]) => {
      localStorage.setItem("goodvibes.webui.hosted.clientId", "selected-diff-proof-client");
      localStorage.setItem("goodvibes.webui.push.deviceId", "selected-diff-proof-device");
      const random = crypto.randomUUID.bind(crypto);
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: () => {
          const index = Number(sessionStorage.getItem("selected-diff-proof-id") ?? 0);
          if (index >= ids.length) return random();
          sessionStorage.setItem("selected-diff-proof-id", String(index + 1));
          return ids[index];
        },
      });
    },
    cases.flatMap((name) => [capture[name].command.requestId, capture[name].command.inputId])
  );
  await page.route("**/api/control-plane/auth", (route) => reply(route, capture.auth));
  await page.route("**/api/work-ledger/project", (route) => reply(route, capture.project));
  for (const wire of [capture.session.diff, capture.workspace.diff, capture.checkpoints]) {
    if (!wire) throw new Error("Missing recorded checkpoint route");
    const invoke = `**/api/control-plane/methods/${wire.methodId}/invoke`;
    await page.route(invoke, (route) => {
      if (
        wire.methodId === "sessions.changes.get" &&
        isDeepStrictEqual(expectedBody(route), { sessionId: other.id })
      )
        return route.fallback();
      if (!isDeepStrictEqual(expectedBody(route), wire.requestBody)) {
        failures.push(`Changed checkpoint request: ${wire.methodId}`);
        return route.abort("failed");
      }
      return reply(
        route,
        wire.methodId === "sessions.changes.get" && changedSessionDiff
          ? capture.changedSessionDiff
          : wire
      );
    });
  }
  await page.route("**/api/work-ledger/{intake,turn,execution}/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const operation = path.split("/").at(-1);
    const family = path.split("/").at(-2);
    if (!operation || !family) throw new Error(`Invalid native route: ${path}`);
    const methodId = `workLedger.${family}.${operation}`;
    const body = expectedBody(route);
    nativeRequests.push({
      methodId,
      operation,
      body,
      authorization: request.headers().authorization,
    });
    if (operation === "session") {
      if (discoveryFailure) return reply(route, capture.discoveryDenied);
      if (isDeepStrictEqual(body, { sessionId: capture.sessionId }))
        return reply(
          route,
          options.busy && capture.busyDiscovery ? capture.busyDiscovery : capture.discovery
        );
      if (capture.legacy) return reply(route, capture.legacy);
      return route.abort("failed");
    }
    const name = cases.find(
      (candidate) =>
        capture[candidate].command.inputId === (body as { inputId?: string }).inputId ||
        (family === "execution" && isDeepStrictEqual(body, capture[candidate].start?.requestBody))
    );
    if (!name) {
      failures.push(`No genuine selected-diff request: ${methodId}`);
      return route.abort("failed");
    }
    const scenario = capture[name];
    let wire: DiffWire | undefined;
    if (family === "intake") {
      if (operation === "capture") wire = scenario.capture;
      if (operation === "admit") wire = scenario.admit;
      if (operation === "get")
        wire = intakeCancelled.has(name) ? scenario.get : (scenario.getCaptured ?? scenario.get);
      if (operation === "cancel") {
        wire = scenario.cancel;
        intakeCancelled.add(name);
      }
    } else {
      if (operation === "status")
        wire = scenario[phase.get(name) ?? "absent"] as DiffWire | undefined;
      if (operation === "start") {
        wire = scenario.start;
        phase.set(name, selectedDiffDeliveryPhaseAfterMutation(scenario, "start"));
      }
      if (operation === "cancel") {
        wire = scenario.cancel;
        phase.set(name, selectedDiffDeliveryPhaseAfterMutation(scenario, "cancel"));
      }
    }
    if (
      !wire ||
      wire.methodId !== methodId ||
      request.method() !== wire.method ||
      !isDeepStrictEqual(body, wire.requestBody)
    ) {
      failures.push(`Request differs from genuine selected-diff wire: ${name}/${methodId}`);
      return route.abort("failed");
    }
    if (operation === held) {
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
    session,
    other,
    fleetTitle,
    nativeRequests,
    failures,
    get writes() {
      return nativeRequests.filter(
        (request) => !["session", "get", "status"].includes(request.operation)
      );
    },
    get pendingCount() {
      return pending.length;
    },
    setChangedSessionDiff(value: boolean) {
      changedSessionDiff = value;
    },
    setDiscoveryFailure(value: boolean) {
      discoveryFailure = value;
    },
    async release() {
      held = undefined;
      await Promise.all(
        pending.splice(0).map((item) => reply(item.route, item.wire).catch(() => undefined))
      );
    },
  };
}
