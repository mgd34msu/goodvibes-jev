import type { Orchestrator, OrchestratorUserInputOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import type { NativeConversationInput } from './native-conversation-input.ts';
import { nativeConversationIntakeLines, type NativeConversationIntakeActions, type NativeConversationIntakeState } from './native-conversation-intake.ts';

/** Only a fresh durable dispatch claim can enter the ordinary turn loop. */
export async function routeNativeConversationInput(deps: {
  readonly intake: NativeConversationIntakeActions | undefined;
  readonly source: NativeConversationInput;
  readonly notify: (message: string) => void;
  readonly dispatch: (state: NativeConversationIntakeState) => Promise<void>;
}): Promise<NativeConversationIntakeState | undefined> {
  if (!deps.intake) {
    const state = { status: 'unavailable' as const, message: 'Native conversation intake is unavailable. No ordinary turn was started.' };
    deps.notify(state.message); return state;
  }
  let state: NativeConversationIntakeState | undefined;
  try { state = await deps.intake.submit(deps.source); }
  catch {
    const failed = { status: 'unknown' as const, message: 'Prompt preparation failed. Use /work intake-status to inspect the original input.' };
    deps.notify(failed.message); return failed;
  }
  for (const line of nativeConversationIntakeLines(state)) deps.notify(line);
  if (state?.turnReady && state.turnPermit && state.result?.kind === 'turn') {
    try { await deps.dispatch(state); }
    catch {
      const message = 'Native turn dispatch requires recovery. Its durable claim was preserved.';
      deps.notify(message); return { ...state, status: 'unknown', turnReady: false, message };
    }
  }
  return state;
}

/** A permit carries host provenance; derived text and attachments never replace its source. */
export async function dispatchNativeConversationTurn(
  state: NativeConversationIntakeState,
  orchestrator: Pick<Orchestrator, 'bindNativeConversationProject' | 'handleUserInput'>,
  options?: OrchestratorUserInputOptions,
): Promise<void> {
  if (!state.turnReady || !state.turnPermit || state.result?.kind !== 'turn') return;
  orchestrator.bindNativeConversationProject(state.result.projectId);
  await orchestrator.handleUserInput(state.result.text, undefined, { ...options, nativeConversationTurnPermit: state.turnPermit });
}
