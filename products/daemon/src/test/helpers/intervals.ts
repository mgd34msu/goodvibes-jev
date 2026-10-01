/** Observes real intervals; restoration also contains a failed fixture's leak. */
export function trackIntervals() {
  const live = new Map<unknown, { milliseconds: unknown; origin: string }>();
  const create = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = ((callback: never, milliseconds?: never, ...args: never[]) => {
    const handle = create(callback, milliseconds, ...args);
    live.set(handle, { milliseconds, origin: new Error().stack?.split('\n').slice(2, 5).join('\n') ?? '' });
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: never) => { live.delete(handle); return clear(handle); }) as typeof globalThis.clearInterval;
  return {
    get count() { return live.size; },
    remaining: () => [...live.values()],
    restore() {
      globalThis.setInterval = create; globalThis.clearInterval = clear;
      for (const handle of live.keys()) clear(handle as never);
      live.clear();
    },
  };
}
