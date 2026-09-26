import type { JudgmentPort } from '@goodvibes-jev/judgment';

/**
 * The judgment port every engine decision site reads through. The composition
 * root (the daemon, a product, a test) installs it once; a read with no port
 * installed is an error, never a quiet fallback to the old heuristics.
 */
let installed: JudgmentPort | undefined;

export class JudgmentPortMissingError extends Error {
  constructor(site: string) {
    super(`No judgment port is installed; ${site} needs one. Call installJudgmentPort() at startup.`);
    this.name = 'JudgmentPortMissingError';
  }
}

/** Installs the port; returns the one it replaced, so a test can put it back. */
export function installJudgmentPort(port: JudgmentPort | undefined): JudgmentPort | undefined {
  const previous = installed;
  installed = port;
  return previous;
}

/** The installed port; throws when none is installed. */
export function judgmentPort(site: string): JudgmentPort {
  if (installed === undefined) throw new JudgmentPortMissingError(site);
  return installed;
}
