/** Required CI proof cannot turn missing host support or early returns into green. */
export const EXEC_CONTAINMENT_REQUIRED_ENV = 'GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT';
export const EXEC_CONTAINMENT_FIXTURES = ['filesystem-boundary', 'sandboxed-answer'] as const;
type Fixture = (typeof EXEC_CONTAINMENT_FIXTURES)[number];

interface Host {
  readonly pty: { readonly available: boolean; readonly reason: string };
  readonly sandbox: {
    readonly available: boolean;
    readonly bwrapPath?: string | undefined;
    readonly reason: string;
    readonly networkIsolationGuaranteed: boolean;
  };
}

export function execContainmentRequired(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${EXEC_CONTAINMENT_REQUIRED_ENV} must be unset or exactly 1`);
}

/** Optional local runs may skip unavailable capabilities; required CI never skips. */
export function skipExecContainment(required: boolean, host: Host): boolean {
  return !required && (!host.pty.available || !host.sandbox.available
    || !host.sandbox.bwrapPath || !host.sandbox.networkIsolationGuaranteed);
}

export function createExecContainmentProof(required: boolean, host: Host) {
  const completed = new Set<Fixture>();
  const assertHost = (): void => {
    if (!required) return;
    if (!host.pty.available) throw new Error(`Required exec containment: ${host.pty.reason}`);
    if (!host.sandbox.available || !host.sandbox.bwrapPath) {
      throw new Error(`Required exec containment: ${host.sandbox.reason}`);
    }
    if (!host.sandbox.networkIsolationGuaranteed) {
      throw new Error('Required exec containment: network namespace isolation is not confirmed');
    }
  };
  return {
    assertHost,
    // Call only AFTER every live fixture assertion. A successful availability
    // probe alone is not evidence that either real containment fixture ran.
    completed(fixture: Fixture): void {
      if (completed.has(fixture)) throw new Error(`Duplicate exec containment fixture: ${fixture}`);
      completed.add(fixture);
    },
    assertComplete(): void {
      if (!required) return;
      assertHost();
      const missing = EXEC_CONTAINMENT_FIXTURES.filter((fixture) => !completed.has(fixture));
      if (missing.length > 0) throw new Error(`Required exec containment fixtures did not complete: ${missing.join(', ')}`);
    },
  };
}
