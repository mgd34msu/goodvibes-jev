import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { nativeConversationIntakeLookupResultSchema } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import { nativeHostedTurnLookupSchema } from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { nativeWorkExecutionSnapshotSchema } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client";
import {
  loadSelectedDiffCapture,
  recordedUnifiedDiff,
  selectedDiffPreview,
  selectedDiffDeliveryPhaseAfterMutation,
  validateSelectedDiffCapture,
} from "./native-selected-diff-fixture";

describe("genuine native selected-hunk HTTP recordings", () => {
  test("all native requests, checkpoint reads and unchanged response bodies validate current generated contracts and SDK schemas", () => {
    const capture = loadSelectedDiffCapture();
    expect(capture.source.toLowerCase()).toContain("real");
    expect(capture.sessionRow).toMatchObject({ id: capture.sessionId, kind: "hosted" });
    expect(JSON.parse(capture.sessionList.body).sessions).toContainEqual(capture.sessionRow);
    expect(JSON.parse(capture.sharedSession.body).session).toMatchObject({
      id: capture.sessionRow.id,
      kind: capture.sessionRow.kind,
      project: capture.sessionRow.project,
      title: capture.sessionRow.title,
      status: capture.sessionRow.status,
    });
    expect(JSON.stringify(capture)).not.toContain("Bearer ");
    expect(JSON.parse(capture.auth.body).scopes).toEqual(
      expect.arrayContaining(["read:work-ledger", "write:work-ledger", "write:sessions"])
    );
    expect(JSON.parse(capture.discovery.body)).toMatchObject({
      kind: "native",
      sessionId: capture.sessionId,
      projectId: capture.projectId,
    });
  });
  test("session and workspace originals retain exact text and separately host-captured complete hunk provenance", () => {
    const capture = loadSelectedDiffCapture();
    for (const name of ["session", "workspace"] as const) {
      const scenario = capture[name];
      const original = scenario.command;
      const selector = original.continuation!.selectedDiff!;
      const source = nativeConversationIntakeLookupResultSchema.parse(
        JSON.parse(scenario.admit!.body)
      );
      expect(source.kind).toBe(name === "session" ? "turn" : "work");
      expect(selector.kind).toBe(name);
      expect(selector.revision).toBe(
        createHash("sha256").update(recordedUnifiedDiff(scenario.diff!)).digest("hex")
      );
      expect(original.text).toStartWith("  ");
      expect(original.text).toEndWith("  ");
      expect(original.text).toContain("🌻");
      expect(original.text).not.toContain("diff --git");
      expect(selectedDiffPreview(capture, name).split("\n").length).toBeGreaterThan(40);
      expect(scenario.get!.body).toBe(scenario.admit!.body);
      if (source.kind === "not-found") throw new Error("Missing captured original");
      expect(source.sourceRef.continuation?.sessionId).toBe(capture.sessionId);
      if (source.kind === "turn") {
        expect(source.text).toBe(original.text);
        expect(source.continuation?.selectedDiff?.unifiedDiff).toBe(
          selectedDiffPreview(capture, name)
        );
        expect(source.continuation?.selectedDiff?.revision).toBe(selector.revision);
      } else if (source.kind === "work") {
        expect(source.receipt.goal).toBe(original.text);
        expect(source.receipt.criteria).toEqual([original.text]);
        expect(source.receipt.source.spans).toEqual([
          { partId: "input", start: 0, end: original.text.length },
        ]);
        expect(source.receipt.source.continuation?.selectedDiff?.unifiedDiff).toBe(
          selectedDiffPreview(capture, name)
        );
      }
    }
  });
  test("a deliberate repeated original has fresh intake and broker identities in the same session", () => {
    const capture = loadSelectedDiffCapture();
    const first = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.session.status!.body));
    const repeated = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.repeated.status!.body));
    if ("kind" in first || "kind" in repeated) throw new Error("Missing recorded turns");
    expect(capture.repeated.command.text).toBe(capture.session.command.text);
    expect(capture.repeated.command.inputId).not.toBe(capture.session.command.inputId);
    expect(capture.repeated.command.requestId).not.toBe(capture.session.command.requestId);
    expect(first.sessionId).toBe(capture.sessionId);
    expect(repeated.sessionId).toBe(first.sessionId);
    expect(repeated.brokerInputId).not.toBe(first.brokerInputId);
    expect(first.state).toBe("completed");
    expect(repeated.state).toBe("completed");
  });
  test("work and queued cancellation use real exact-target outcomes; stale source capture is an actual refusal", () => {
    const capture = loadSelectedDiffCapture();
    const execution = nativeWorkExecutionSnapshotSchema.parse(
      JSON.parse(capture.workspace.start!.body)
    );
    expect(execution.kind).toBe("execution");
    if (execution.kind !== "execution") throw new Error("Missing native execution");
    expect(execution.receipt?.contractId).toBeTruthy();
    expect(JSON.parse(capture.queuedCancel.start!.body)).toMatchObject({
      state: "queued",
      inputId: capture.queuedCancel.command.inputId,
    });
    expect(JSON.parse(capture.queuedCancel.cancel!.body)).toMatchObject({
      state: "cancelled",
      inputId: capture.queuedCancel.command.inputId,
    });
    expect(capture.queuedCancel.status!.body).toBe(capture.queuedCancel.cancel!.body);
    expect(JSON.parse(capture.queuedDelivery.start!.body)).toMatchObject({
      state: "queued",
      inputId: capture.queuedDelivery.command.inputId,
    });
    expect(JSON.parse(capture.queuedDelivery.status!.body)).toMatchObject({
      state: "completed",
      inputId: capture.queuedDelivery.command.inputId,
      sessionId: capture.sessionId,
    });
    expect(JSON.parse(capture.cancel.cancel!.body)).toMatchObject({ kind: "cancelled" });
    expect(capture.stale.capture.status).toBeGreaterThanOrEqual(400);
  });
  test("reopening after cancellation selects the actual status read wire, never its mutation acknowledgement", () => {
    const scenario = loadSelectedDiffCapture().queuedCancel;
    const phase = selectedDiffDeliveryPhaseAfterMutation(scenario, "cancel");
    expect(phase).toBe("status");
    const wire = scenario[phase];
    expect(wire).toBe(scenario.status);
    expect(wire).not.toBe(scenario.cancel);
    expect(wire?.methodId).toBe("workLedger.turn.status");
    expect(JSON.parse(wire!.body)).toMatchObject({
      state: "cancelled",
      inputId: scenario.command.inputId,
    });
    expect(wire?.body).toBe(scenario.cancel?.body);
  });
  test("fixture validation rejects tampered source text, revision, response and route", () => {
    const capture = loadSelectedDiffCapture();
    const altered = structuredClone(capture);
    altered.session.command.text += " rewritten";
    expect(() => validateSelectedDiffCapture(altered)).toThrow("Changed selected-diff original");
    const wrongDiff = structuredClone(capture);
    const diff = JSON.parse(wrongDiff.session.diff!.body) as { unifiedDiff: string };
    diff.unifiedDiff += "\n";
    wrongDiff.session.diff!.body = JSON.stringify(diff);
    expect(() => validateSelectedDiffCapture(wrongDiff)).toThrow(
      "Invalid host-written native diff revision"
    );
    const wrongRoute = structuredClone(capture);
    wrongRoute.session.capture.path = "/api/sessions/steer";
    expect(() => validateSelectedDiffCapture(wrongRoute)).toThrow(
      "Noncanonical selected-diff route"
    );
    const wrongOutput = structuredClone(capture);
    wrongOutput.session.capture.body = "{}";
    expect(() => validateSelectedDiffCapture(wrongOutput)).toThrow("Invalid selected-diff output");
  });
});
