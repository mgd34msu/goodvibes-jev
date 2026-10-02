/**
 * The Agent's own composition (runtime/services.ts) builds the WRFC controller
 * its chains run on. TUI live run 7: a controller without a planned-fix runner
 * failed the chain at the first failing review with "planned-fix execution is
 * not wired in this composition (setFixWorkstreamRunner was never called)".
 * The runner is now a required constructor dependency, bound late to this
 * composition's orchestration engine.
 */
import { describe, expect, test } from 'bun:test';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

describe('the Agent composition wires the WRFC fix phase', () => {
  test('the controller holds a fix runner that drives this composition\'s engine', async () => {
    const services = getTestRuntimeServices();
    const runner = (services.wrfcController as unknown as { fixWorkstreamRunner: { run: (input: unknown) => Promise<{ status: string; reason?: string; structured?: string }> } | null }).fixWorkstreamRunner;
    expect(runner).not.toBeNull();
    // A failing review with nothing to act on resolves through the planner
    // (nothing-to-fix), never the "not wired" failure.
    const outcome = await runner!.run({
      chainId: 'wrfc-wiring', originalTask: 'x', attempt: 1, commitScope: 'scoped',
      review: { version: 1, archetype: 'reviewer', summary: 's', score: 0, passed: false, dimensions: [], issues: [] },
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.structured).toBe('nothing-to-fix');
    expect(outcome.reason ?? '').not.toContain('not wired');
  });
});
