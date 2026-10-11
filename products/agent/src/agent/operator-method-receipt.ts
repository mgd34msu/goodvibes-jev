import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { assertCurrentToolInvocation, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';

interface ReceiptScope {
  readonly methodId: string;
  readonly input: Record<string, unknown>;
  receive(body: unknown): void;
}
const scopes = new AsyncLocalStorage<ReceiptScope>();
type NestedResult = Awaited<ReturnType<ToolRegistry['executeNested']>>;
export type OperatorMethodPrivateReceipt = { readonly kind: 'held'; readonly result: NestedResult }
  | { readonly kind: 'received'; readonly result: NestedResult; readonly body: unknown };

/** A native parent receives private wire data only from its actual admitted child. */
export async function executeOperatorMethodWithReceipt(registry: ToolRegistry, callId: string, methodId: string,
  input: Record<string, unknown>, parentOptions: Parameters<Tool['execute']>[1],
  restrictions?: Parameters<ToolRegistry['executeNested']>[4]): Promise<OperatorMethodPrivateReceipt> {
  const captured = captureStrictJudgmentJson(input);
  const signal = restrictions?.signal, callerCurrent = restrictions?.assertCurrent;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (restrictions?.signal !== signal || restrictions?.assertCurrent !== callerCurrent
      || !isDeepStrictEqual(captureStrictJudgmentJson(input), captured)) throw new Error('Private operator request source changed.');
    if (callerCurrent?.() !== undefined) throw new Error('Private operator currentness must be synchronous.');
  };
  let receipt: { readonly body: unknown } | undefined;
  const result = await scopes.run({ methodId, input: captured, receive(body: unknown) {
    if (receipt !== undefined) throw new Error('Private operator receipt was already published.');
    receipt = { body: captureStrictJudgmentJson(body) };
  } }, () => registry.executeNested(callId, 'agent_operator_method', { methodId, input: captured }, parentOptions, { signal, assertCurrent }));
  assertCurrent();
  if (!result.success || receipt === undefined) return { kind: 'held', result };
  return { kind: 'received', result, body: receipt.body };
}

/** Internal transport publication. ToolResult contains the protected display only. */
export function publishOperatorMethodReceipt(methodId: string, args: Record<string, unknown>,
  options: Parameters<Tool['execute']>[1], body: unknown): void {
  const scope = scopes.getStore();
  if (!scope) return;
  if (methodId !== scope.methodId || !isDeepStrictEqual(captureStrictJudgmentJson(args.input ?? {}), scope.input)
    || !assertCurrentToolInvocation(args, options)) throw new Error('Private operator receipt source changed.');
  scope.receive(body);
}
