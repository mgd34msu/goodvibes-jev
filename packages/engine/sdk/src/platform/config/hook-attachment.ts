import type { HookDispatcher } from '../hooks/index.js';

type Dispatcher = Pick<HookDispatcher, 'fire'> | null;
const attachments = new WeakMap<object, object>();

/**
 * Keep the existing exclusive last-attachment-wins contract. A release clears
 * only its own generation, including when the same dispatcher is attached
 * twice. It never restores a prior attachment that may already be retired.
 */
export function attachOwnedConfigHook(
  owner: object,
  apply: (dispatcher: Dispatcher) => void,
  dispatcher: Dispatcher,
): () => void {
  const token = {};
  attachments.set(owner, token);
  apply(dispatcher);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (attachments.get(owner) !== token) return;
    attachments.delete(owner);
    apply(null);
  };
}
