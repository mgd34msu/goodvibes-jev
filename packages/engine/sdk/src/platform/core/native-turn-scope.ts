import { AsyncLocalStorage } from 'node:async_hooks';
import { readNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';

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
