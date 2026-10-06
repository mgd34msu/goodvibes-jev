import {
  nativeHostedSessionLookupSchema,
  nativeHostedSessionRequestSchema,
  type NativeHostedSessionLookup,
} from "@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client";
import { sdk } from "./goodvibes";
import { isClientLifetimeCurrent, type ClientLifetime } from "./client-lifetime";

/** Only the host may distinguish a legacy session from a native owned session. */
export async function inspectNativeSession(
  lifetime: ClientLifetime,
  sessionId: string,
  signal: AbortSignal
): Promise<NativeHostedSessionLookup> {
  const current = () => {
    signal.throwIfAborted();
    if (!isClientLifetimeCurrent(lifetime))
      throw new Error("The selected connection changed. Reopen the session.");
  };
  current();
  const request = nativeHostedSessionRequestSchema.parse({ sessionId });
  // Discovery uses read:sessions. The host checks native ownership and scopes
  // before disclosing native details; an error can never authorize legacy send.
  const result = nativeHostedSessionLookupSchema.parse(
    await sdk.operator.invoke("workLedger.turn.session", request, signal)
  );
  current();
  if (result.kind === "native" && result.sessionId !== sessionId)
    throw new Error("The daemon identified a different native session. Reopen this session.");
  return result;
}
