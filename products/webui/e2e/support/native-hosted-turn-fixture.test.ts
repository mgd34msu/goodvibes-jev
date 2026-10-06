import { describe, expect, test } from "bun:test";
import { nativeHostedTurnLookupSchema } from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { loadNativeHostedTurnCapture } from "./native-hosted-turn-fixture";

describe("native hosted turn exact production HTTP captures", () => {
  for (const name of ["completed", "cancelled"] as const) {
    test(`${name} validates SDK schemas, operator contract and unmodified original identity`, () => {
      const capture = loadNativeHostedTurnCapture(name);
      const auth = JSON.parse(capture.auth.body) as {
        authenticated: boolean;
        admin: boolean;
        principalKind: string;
        principalId: string;
        scopes: string[];
      };
      expect(auth).toMatchObject({ authenticated: true, admin: true, principalKind: "token" });
      expect(auth.principalId).toStartWith("pairing:");
      for (const scope of ["read:work-ledger", "write:work-ledger", "write:sessions"])
        expect(auth.scopes).toContain(scope);
      expect(JSON.stringify(capture)).not.toContain("Bearer ");
      expect(capture.input.text).toStartWith("  ");
      expect(capture.input.text).toEndWith("  ");
      expect(capture.input.text).toContain("café é 🌻");
      expect(capture.input.text.match(/Keep this original text\./g)).toHaveLength(2);
      expect(JSON.parse(capture.get.body)).toEqual(JSON.parse(capture.admit.body));
      expect(nativeHostedTurnLookupSchema.parse(JSON.parse(capture.absent.body))).toEqual({
        kind: "not-found",
      });
    });
  }
  test("completion retains canonical broker identity and a real owned-model answer", () => {
    const capture = loadNativeHostedTurnCapture("completed");
    const start = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.start.body));
    const status = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.status.body));
    if ("kind" in start || "kind" in status) throw new Error("Missing recorded hosted turn");
    expect(start.state).toBe("running");
    expect(status).toEqual({ ...start, state: "completed" });
    expect(status.sessionId).toStartWith("hosted-");
    expect(status.brokerInputId).toStartWith("sin-");
    expect(status.correlationId).toBe(`session-input:${status.brokerInputId}`);
    expect(JSON.parse(capture.duplicate!.body)).toEqual(status);
    expect(capture.attachment?.session).toMatchObject({
      id: status.sessionId,
      turnCount: 1,
      messageCount: 2,
      contractIds: [],
    });
    expect(capture.attachment?.history).toEqual([
      { role: "user", content: capture.input.text },
      { role: "assistant", content: "Owned native hosted answer." },
    ]);
  });
  test("pre-start cancellation never invents hosted or broker association", () => {
    const capture = loadNativeHostedTurnCapture("cancelled");
    const cancelled = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.cancel!.body));
    expect(cancelled).toMatchObject({
      state: "cancelled",
      sessionId: null,
      brokerInputId: null,
      correlationId: null,
    });
    expect(JSON.parse(capture.status.body)).toEqual(cancelled);
    expect(JSON.parse(capture.start.body)).toEqual(cancelled);
  });
});
