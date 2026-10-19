import { AsyncLocalStorage } from 'node:async_hooks';

// Host-only evidence travels with execution, never model tool arguments or
// user-facing tool-input events. An unrelated turn explicitly clears the scope.
const context = new AsyncLocalStorage<string | undefined>();
export function withCompletionRepairContext<T>(repair: string | undefined, run: () => T): T { return context.run(repair, run); }
export function readCompletionRepairContext(): string | undefined { return context.getStore(); }
