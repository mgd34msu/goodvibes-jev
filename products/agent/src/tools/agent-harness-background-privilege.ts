import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Battery, YesNoItem } from '@goodvibes-jev/judgment';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';

/** Reserved literal programs are local policy. Mentions inside arguments or
 * wrappers require interpretation of the complete screened command. The
 * interpretation only resolves this additional background-prompt restriction;
 * recorded execution admission remains independently mandatory. */
export async function withBackgroundPrivilegeCheck<T>(command: string, options: CatalogRankingOptions,
  consume: (privileged: boolean, assertCurrent: () => void) => Promise<T>): Promise<T> {
  const assertNativeCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertNativeCurrent();
  const program = /^\s*(\S+)/.exec(command)?.[1]?.split('/').at(-1);
  if (program && ['sudo', 'su', 'doas', 'pkexec'].includes(program)) return consume(true, assertNativeCurrent);
  if (!/\b(?:sudo|su|doas|pkexec)\b/.test(command)) return consume(false, assertNativeCurrent);
  return withModelReadingSource({ command }, options, async (captured, source) => {
    const name = 'engine.gate.sandbox-needs', site = 'agent.background-process.privilege';
    const decision = gateJudgmentRegistry.get(name);
    if (!decision || !('run' in decision) || typeof decision.run !== 'function') throw new ToolInputProjectionError('unavailable');
    const runMethod = decision.run;
    const authority = captureJudgmentPort(site, source);
    const assertCurrent = () => {
      source.assertCurrent?.(); authority.assertCurrent();
      if (gateJudgmentRegistry.get(name) !== decision || decision.run !== runMethod) throw new ToolInputProjectionError('held');
    };
    assertCurrent();
    const run = await (decision as Battery<{ needsPrivilege: YesNoItem }>).run(authority.port, captured,
      { site, only: ['needsPrivilege'], signal: authority.signal, beforeAttempt: assertCurrent });
    assertCurrent();
    const reading = run.readings.needsPrivilege;
    if (reading.outcome !== 'act') throw new ToolInputProjectionError('held');
    run.recordAction(reading.verdict === 'yes' ? 'Keep the background privilege-prompt restriction.' : 'The command mention does not require background privilege.');
    return consume(reading.verdict === 'yes', assertCurrent);
  });
}
