import { describe, expect, test } from "bun:test";
import { nativeHostedTurnLookupSchema } from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { nativeConversationIntakeLookupResultSchema } from "@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client";
import { loadNativeContinuationCapture } from "./native-session-continuation-fixture";

describe("native continuation genuine HTTP recordings", () => {
  test("all routes and response bytes validate the generated operator contract and SDK", () => {
    const capture = loadNativeContinuationCapture();
    expect(JSON.stringify(capture)).not.toContain("Bearer ");
    const auth = JSON.parse(capture.auth.body) as { principalId: string; scopes: string[] };
    expect(auth.principalId).toStartWith("pairing:");
    for (const scope of ["read:work-ledger", "write:work-ledger", "write:sessions"])
      expect(auth.scopes).toContain(scope);
  });
  test("the exact second original reaches a distinct broker input in the same real hosted session", () => {
    const capture = loadNativeContinuationCapture();
    const first = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.initial.status.body));
    const second = nativeHostedTurnLookupSchema.parse(JSON.parse(capture.second.status.body));
    if ("kind" in first || "kind" in second) throw new Error("Missing recorded turn");
    expect(second).toMatchObject({ state: "completed", sessionId: first.sessionId });
    expect(second.brokerInputId).not.toBe(first.brokerInputId);
    expect(second.correlationId).toBe(`session-input:${second.brokerInputId}`);
    expect(capture.second.input.text).toStartWith("  ");
    expect(capture.second.input.text).toEndWith("  ");
    expect(capture.second.input.text).toContain("café é 🌻");
    expect(capture.second.input.text.match(/Keep this original text\./g)).toHaveLength(2);
    const source = nativeConversationIntakeLookupResultSchema.parse(
      JSON.parse(capture.second.admit.body)
    );
    if (source.kind !== "turn" || !source.continuation)
      throw new Error("Missing native conversation disposition");
    expect(source.continuation?.messages).toEqual(capture.initial.attachment!.history);
    expect(source.sourceRef.continuation).toEqual({
      sessionId: capture.sessionId,
      revision: source.continuation.revision,
    });
    const request = capture.modelRequests.find(
      (request) =>
        request.stream &&
        [...request.messages].reverse().find((message) => message.role === "user")?.content ===
          capture.second.input.text
    );
    expect(request?.messages).toContainEqual({ role: "user", content: capture.initial.input.text });
    expect(request?.messages).toContainEqual({ role: "user", content: capture.second.input.text });
    expect(capture.second.attachment!.history).toEqual([
      ...capture.initial.attachment!.history,
      { role: "user", content: capture.second.input.text },
      { role: "assistant", content: `Owned continuation answer: ${capture.second.input.text}` },
    ]);
  });
  test("queued source excludes the active reply and queued/running cancellation retain exact identities", () => {
    const capture = loadNativeContinuationCapture();
    for (const name of ["queuedCancel", "queuedDelivery"] as const) {
      const source = nativeConversationIntakeLookupResultSchema.parse(
        JSON.parse(capture[name].admit.body)
      );
      if (source.kind !== "turn" || !source.continuation) throw new Error("Missing queued source");
      expect(source.continuation?.messages).toEqual(capture.second.attachment!.history);
      expect(
        source.continuation?.messages.some((message) =>
          message.content.includes(capture.active.input.text)
        )
      ).toBe(false);
      expect(JSON.parse(capture[name].start.body)).toMatchObject({
        state: "queued",
        sessionId: capture.sessionId,
      });
    }
    for (const name of ["queuedCancel", "runningCancel"] as const) {
      const turn = capture[name];
      const start = nativeHostedTurnLookupSchema.parse(JSON.parse(turn.start.body));
      if ("kind" in start) throw new Error("Missing cancelled identity");
      expect(JSON.parse(turn.cancel!.body)).toMatchObject({
        state: "cancelled",
        sessionId: start.sessionId,
        brokerInputId: start.brokerInputId,
        inputId: turn.input.inputId,
      });
      expect(turn.status.body).toBe(turn.cancel!.body);
      expect(turn.duplicate!.body).toBe(turn.cancel!.body);
    }
    expect(
      capture.queuedDelivery.attachment!.history.some(
        (message) => message.content === capture.queuedCancel.input.text
      )
    ).toBe(false);
    expect(
      capture.queuedDelivery.attachment!.history.some(
        (message) => message.content === capture.queuedDelivery.input.text
      )
    ).toBe(true);
  });
});
