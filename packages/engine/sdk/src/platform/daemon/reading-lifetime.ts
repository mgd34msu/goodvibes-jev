import { prepareJudgmentResult } from '../gate/judgment-result.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';

/** Do not hide a thenable from the foundation's synchronous authority contract. */
export function assertSynchronousCurrent(check?: () => void): void {
  const result: unknown = check?.();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Daemon reading authority checks must be synchronous');
  }
}

/** Bind transmission, retention and late results to the daemon caller's live source. */
export function daemonReadingPort(site: string, assertCurrent: () => void, signal?: AbortSignal): JudgmentPort {
  return captureJudgmentPort(site, { signal, assertCurrent: () => assertSynchronousCurrent(assertCurrent),
    prepareResultCapture: prepareJudgmentResult }).port;
}
