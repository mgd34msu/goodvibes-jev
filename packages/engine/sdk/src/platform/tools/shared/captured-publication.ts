import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/** Serialize platform-owned mutation of one captured view across retained jobs
 * and write/edit tools. The opaque authority is the key, never a path prefix. */
import { assertContractInputAuthority, type ContractInputAuthority } from '../../contract/input-authority.js';
const tails = new WeakMap<ContractInputAuthority, Promise<void>>();
export async function withCapturedPublication<T>(authority: ContractInputAuthority, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = tails.get(authority) ?? Promise.resolve();
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => finished);
  tails.set(authority, tail);
  try {
    await executePolicyCheck(() => previous, signal);
    await assertContractInputAuthority(authority, undefined, signal);
    return await operation();
  } finally {
    release();
    void tail.then(() => { if (tails.get(authority) === tail) tails.delete(authority); });
  }
}
