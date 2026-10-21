import type { ContractRunner, ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';

/** Share one detached contract snapshot across the shell's agent lookups. */
export function createSessionContractViews(runner: Pick<ContractRunner, 'list' | 'on'>, sessionId: () => string): {
  readonly read: () => readonly ContractView[];
  readonly dispose: () => void;
} {
  let savedSession: string | undefined;
  let snapshot: readonly ContractView[] | undefined;
  const dispose = runner.on(() => { snapshot = undefined; });
  return {
    read() {
      const current = sessionId();
      if (snapshot === undefined || current !== savedSession) {
        snapshot = Object.freeze(runner.list({ sessionId: current, includeTerminal: true, includeInputSnapshot: false }));
        savedSession = current;
      }
      return snapshot;
    },
    dispose,
  };
}
