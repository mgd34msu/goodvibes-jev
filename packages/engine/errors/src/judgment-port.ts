import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';

/** One installation lifetime; restoring the same port never restores old readers. */
interface Installation {
  readonly port: JudgmentPort;
  readonly controller: AbortController;
  readonly identities: WeakMap<object, object>;
}
let installed: Installation | undefined;

export class JudgmentPortMissingError extends Error {
  constructor(site: string) {
    super(`No judgment port is installed; ${site} needs one. Call installJudgmentPort() at startup.`);
    this.name = 'JudgmentPortMissingError';
  }
}

/** Installs the port; returns the one it replaced, preserving the public contract. */
export function installJudgmentPort(port: JudgmentPort | undefined): JudgmentPort | undefined {
  const previous = installed;
  if (previous?.port === port) return port;
  installed = port === undefined ? undefined : {
    port, controller: new AbortController(), identities: new WeakMap(),
  };
  // Publish the replacement before reentrant cancellation listeners run.
  previous?.controller.abort();
  return previous?.port;
}

/** Retiring an older runtime must never temporarily replace the live runtime. */
export function restoreJudgmentPort(owner: JudgmentPort, previous: JudgmentPort | undefined): void {
  if (installed?.port === owner) installJudgmentPort(previous);
}

/** The installed port; throws when none is installed. */
export function judgmentPort(site: string): JudgmentPort {
  if (installed === undefined) throw new JudgmentPortMissingError(site);
  return installed.port;
}

/** Package-private installation facts; identities contain no source or credential data. */
export function judgmentPortInstallation(site: string): {
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  readonly identityFor: (owner: object) => object;
} {
  judgmentPort(site);
  const current = installed!;
  return {
    port: current.port,
    signal: current.controller.signal,
    identityFor(owner) {
      let identity = current.identities.get(owner);
      if (!identity) { identity = Object.freeze({}); current.identities.set(owner, identity); }
      return identity;
    },
  };
}
