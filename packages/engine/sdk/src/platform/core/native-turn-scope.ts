import { AsyncLocalStorage } from 'node:async_hooks';
import type { NativeSelectedDiffContext } from '../workflow/work-ledger/native-diff-context.js';
import type { AutonomousToolSource } from '../permissions/autonomous.js';
import { readNativeConversationTurnPermit, revalidateNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';

interface NativeTurnScope { readonly permit: NativeConversationTurnPermit; effectsPossible: boolean; }
const scope = new AsyncLocalStorage<NativeTurnScope>();
export const NATIVE_TURN_EXECUTION_REFUSAL = 'This native conversation turn cannot start agents or legacy contracts. Submit new work through native intake.';

export function withNativeConversationTurn<T>(permit: NativeConversationTurnPermit, run: () => T): T {
  readNativeConversationTurnPermit(permit);
  return scope.run({ permit, effectsPossible: false }, run);
}
/** An unrelated queued turn must not inherit the preceding turn's async scope. */
export function withoutNativeConversationTurn<T>(run: () => T): T { return scope.exit(run); }
export function isNativeConversationTurn(): boolean { return scope.getStore() !== undefined; }
export function markNativeConversationTurnEffectsPossible(): void {
  const current = scope.getStore();
  if (current) current.effectsPossible = true;
}
export function nativeConversationTurnCanRetry(): boolean { return scope.getStore()?.effectsPossible === false; }

/** Tool admission uses only the original comment and separately captured evidence. */
export function readNativeConversationTurnActionSource(): AutonomousToolSource | undefined {
  const current = scope.getStore();
  if (!current) return undefined;
  const source = readNativeConversationTurnPermit(current.permit);
  return Object.freeze({ goal: source.text, criteria: Object.freeze([]),
    ...(source.continuation ? { conversationContext: source.continuation.messages,
      ...(source.continuation.selectedDiff ? { selectedDiffContext: source.continuation.selectedDiff } : {}) } : {}) });
}

/** Exact quoted evidence from the live permit; never append it to the persisted transcript. */
export function readNativeConversationTurnSelectedDiffContext(): NativeSelectedDiffContext | undefined {
  const current = scope.getStore();
  return current ? readNativeConversationTurnPermit(current.permit).continuation?.selectedDiff : undefined;
}

/** Revalidate the actual process-local source immediately before provider transmission. */
export async function revalidateNativeConversationTurnScope(): Promise<void> {
  const current = scope.getStore();
  if (!current) throw new Error('Native conversation source scope unavailable');
  await revalidateNativeConversationTurnPermit(current.permit);
}
