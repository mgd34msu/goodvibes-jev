import { describe, expect, test } from "bun:test";
import { isLegacyExecutionMutation } from "./native-execution-fixture";
import type { RecordedRequest } from "./requests";

function invoke(methodId: string): RecordedRequest {
  return {
    method: "POST",
    path: `/api/control-plane/methods/${methodId}/invoke`,
    methodId,
    body: { body: {} },
    search: "",
  };
}

describe("native execution's no-legacy-mutations proof", () => {
  test("the actual Work-mount hosted-session list is a read despite JSON-RPC POST", () => {
    const observed: RecordedRequest = {
      ...invoke("sessions.hosted.list"),
      body: { body: { includeTerminated: false } },
    };
    expect(isLegacyExecutionMutation(observed)).toBe(false);
  });

  test.each(["contracts.list", "sessions.messages.list", "tasks.get"])(
    "known read %s remains allowed through generic invoke",
    (methodId) => {
      expect(isLegacyExecutionMutation(invoke(methodId))).toBe(false);
    }
  );

  test.each([
    "contracts.start",
    "contracts.reply",
    "contracts.cancel",
    "tasks.create",
    "tasks.retry",
    "sessions.hosted.create",
    "sessions.hosted.attach",
    "sessions.inputs.deliver",
    "sessions.steer",
  ])("legacy mutation %s remains rejected through generic invoke", (methodId) => {
    expect(isLegacyExecutionMutation(invoke(methodId))).toBe(true);
  });

  test("an unknown legacy method fails closed even when its name resembles a read", () => {
    expect(isLegacyExecutionMutation(invoke("sessions.future.list"))).toBe(true);
  });

  test.each([
    "/api/contracts",
    "/api/contracts/ctr-owned/reply",
    "/api/tasks/task-owned/cancel",
    "/api/sessions/session-owned/steer",
    "/task",
  ])("direct legacy mutation %s remains rejected without a method ID", (path) => {
    expect(isLegacyExecutionMutation({ method: "POST", path })).toBe(true);
  });

  test("deletion stays rejected and unrelated native dispatch is outside this legacy guard", () => {
    expect(
      isLegacyExecutionMutation({ method: "DELETE", path: "/api/sessions/session-owned" })
    ).toBe(true);
    expect(
      isLegacyExecutionMutation({ method: "POST", path: "/api/work-ledger/execution/start" })
    ).toBe(false);
  });
});
