/** Optional ownership context for an admitted hook invocation. */
export interface HookExecutionOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * A hook deadline requests cancellation; it is never a substitute for joining
 * the operation. Callers must await the provider/handler/body before disposing
 * this context, including when that operation ignores its signal.
 */
export function createHookExecution(
  options: HookExecutionOptions,
  timeoutSeconds: number,
  kind: string,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${kind} hook timed out after ${timeoutSeconds}s`));
  }, timeoutSeconds * 1000);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}
