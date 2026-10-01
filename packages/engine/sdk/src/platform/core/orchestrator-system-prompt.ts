/** Resolve the prompt before using it, even when an embedder reads memory asynchronously. */
export async function resolveSystemPrompt(
  getSystemPrompt: (signal?: AbortSignal) => string | Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!signal) return getSystemPrompt();

  // An embedder may ignore cancellation. Stop waiting without letting a late
  // resolution reach the provider, and keep a rejection handler on its promise.
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return getSystemPrompt(signal);
    });
    const prompt = await Promise.race([pending, cancelled]);
    signal.throwIfAborted();
    return prompt;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
