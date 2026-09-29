/**
 * forensics-slow-phases.test.ts
 *
 * A failure report's slow phases are the timed phases that
 * `engine.runtime.forensics-slow-phase` reads as unusually long for their
 * kind, one reading per timed phase, in phase order. Only a strong yes counts;
 * phases with no duration are not asked; a read with no port installed throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { readSlowPhases } from '../sdk/src/platform/runtime/forensics/slow-phases.ts';
import type { PhaseTimingEntry } from '../sdk/src/platform/runtime/forensics/types.ts';

type PhaseState = { readonly phase: string; readonly durationMs: number };

function timing(phase: string, durationMs?: number): PhaseTimingEntry {
  return { phase, startedAt: 0, ...(durationMs === undefined ? {} : { endedAt: durationMs, durationMs }), success: false };
}

/** A port reading each phase's slowness through `probability`, recording the phases asked. */
function slowPort(probability: (state: PhaseState) => number, asked: string[]) {
  return fakePort((name: string, _question: Question, state: EntryType) => {
    if (name !== 'slow') throw new Error(`slow-phase port: unexpected question ${name}`);
    asked.push((state as unknown as PhaseState).phase);
    return noulAnswer(probability(state as unknown as PhaseState));
  }).port;
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('readSlowPhases', () => {
  test('strong yes phases are slow, in phase order', async () => {
    const asked: string[] = [];
    installJudgmentPort(slowPort((state) => (state.phase === 'PREFLIGHT' || state.phase === 'POST_HOOKS' ? 0.95 : 0.05), asked));
    const slow = await readSlowPhases('turn', [timing('SUBMITTED', 5), timing('PREFLIGHT', 4800), timing('STREAM', 6000), timing('POST_HOOKS', 12000)], 'test');
    expect(slow).toEqual(['PREFLIGHT', 'POST_HOOKS']);
    expect(asked).toEqual(['SUBMITTED', 'PREFLIGHT', 'STREAM', 'POST_HOOKS']);
  });

  test('a weak yes does not make a phase slow', async () => {
    installJudgmentPort(slowPort(() => 0.58, []));
    expect(await readSlowPhases('task', [timing('RUNNING', 90000)], 'test')).toEqual([]);
  });

  test('phases with no duration are not asked', async () => {
    const asked: string[] = [];
    installJudgmentPort(slowPort(() => 0.95, asked));
    expect(await readSlowPhases('turn', [timing('STREAM')], 'test')).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('a read with no port installed throws', async () => {
    await expect(readSlowPhases('turn', [timing('STREAM', 6000)], 'test')).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});
