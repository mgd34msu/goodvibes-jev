import { JudgmentError } from '@goodvibes-jev/judgment';
import { executePolicyCheck } from '../gate/execute-policy-check.js';

/** Caller reasons can contain private context and never cross permission boundaries. */
export function assertPermissionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new JudgmentError('aborted', 'the permission request was cancelled');
}

/** Release this caller, draining any late failure without adopting its result. */
export async function awaitPermission<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    const value = await executePolicyCheck(work, signal);
    assertPermissionActive(signal);
    return value;
  } catch (error) {
    assertPermissionActive(signal);
    throw error;
  }
}
