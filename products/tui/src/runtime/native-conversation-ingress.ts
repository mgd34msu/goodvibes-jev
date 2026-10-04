import type { Orchestrator, OrchestratorUserInputOptions } from '@goodvibes-jev/engine/sdk/platform/core';
import type { NativeConversationInput } from './native-conversation-input.ts';
import { nativeConversationIntakeLines, type NativeConversationIntakeActions, type NativeConversationIntakeState } from './native-conversation-intake.ts';

/** Only a fresh durable dispatch claim can enter the ordinary turn loop. */
export async function routeNativeConversationInput(deps: {
  readonly intake: NativeConversationIntakeActions | undefined;
  readonly source: NativeConversationInput;
  readonly notify: (message: string) => void;
  readonly dispatch: (state: NativeConversationIntakeState) => Promise<void>;
}): Promise<void> {
  if (!deps.intake) { deps.notify('Native conversation intake is unavailable. No ordinary turn was started.'); return; }
  let state: NativeConversationIntakeState | undefined;
  try { state = await deps.intake.submit(deps.source); }
  catch { deps.notify('Native intake could not be inspected. No ordinary turn was started. Use /work intake-status to inspect the original input.'); return; }
  for (const line of nativeConversationIntakeLines(state)) deps.notify(line);
  if (state?.turnReady && state.turnPermit && state.result?.kind === 'turn') {
    try { await deps.dispatch(state); }
    catch { deps.notify('Native turn dispatch requires recovery. Its durable claim was preserved.'); }
  }
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
