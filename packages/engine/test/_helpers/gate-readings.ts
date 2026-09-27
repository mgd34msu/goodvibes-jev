/**
 * A fake judgment port for the gate's batteries (packages/engine/sdk/src/platform/gate),
 * so tests of the gate, the permission phase and the tools never call the
 * live Jev API.
 *
 * Each table entry pairs text that appears in the reading's state (the tool
 * call JSON the gate sends) with what Jev is expected to read about it. The
 * first matching entry answers; an unmatched call reads as a medium-stakes
 * change: it changes state and nothing else, in the `file-mutation` family for
 * the write and edit tools and `generic` otherwise. That default makes the
 * normal preset ask, the auto preset allow and the plan preset deny, which is
 * what the old mode matrix did for writes and commands. Readings are strong,
 * so every band acts on them.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { GateRiskFamily } from '../../sdk/src/platform/gate/batteries/risk-family.ts';
import type { SideEffectKind } from '../../sdk/src/platform/gate/batteries/side-effect.ts';

export interface GateCallReading {
  readonly family?: GateRiskFamily;
  readonly mutates?: boolean;
  readonly outward?: boolean;
  readonly secrets?: boolean;
  readonly irreversible?: boolean;
  readonly beyondProject?: boolean;
  readonly weakensSecurity?: boolean;
  readonly obfuscated?: boolean;
  readonly kind?: SideEffectKind;
  readonly capability?: string;
  readonly flagsRisk?: boolean;
}

export type GateReadingTable = ReadonlyArray<readonly [text: string, reading: GateCallReading]>;

/** A read-only, low-stakes reading. */
export const READ_ONLY: GateCallReading = { mutates: false, family: 'generic', kind: 'read' };

function defaultReading(state: unknown): GateCallReading {
  const tool = typeof state === 'object' && state !== null ? (state as { tool?: unknown }).tool : undefined;
  const edits = tool === 'write' || tool === 'edit';
  return { mutates: true, family: edits ? 'file-mutation' : 'generic', kind: edits ? 'write' : 'other' };
}

const YES_NO = ['mutates', 'outward', 'secrets', 'irreversible', 'beyondProject', 'weakensSecurity', 'obfuscated', 'flagsRisk'] as const;

/** A port answering the gate batteries from `table`, recording every request. */
export function gateReadingsPort(table: GateReadingTable = []) {
  return fakePort((name: string, question: Question, state: unknown) => {
    const text = JSON.stringify(state);
    const reading = { ...defaultReading(state), ...(table.find(([match]) => text.includes(match))?.[1] ?? {}) };
    if (name === 'family') return choiceAnswer(question, reading.family ?? 'generic', 0.95);
    if (name === 'kind') return choiceAnswer(question, reading.kind ?? 'other', 0.95);
    if (name === 'capability') return choiceAnswer(question, reading.capability ?? 'generic', 0.95);
    if ((YES_NO as readonly string[]).includes(name)) return noulAnswer(reading[name as (typeof YES_NO)[number]] === true ? 0.97 : 0.03);
    throw new Error(`gate-readings: no answer for question ${name}`);
  });
}

/**
 * Installs a {@link gateReadingsPort} around every test in the calling file
 * (or describe block) and restores the previous port afterwards. The returned
 * object's `requests` is the current test's request log.
 */
export function useGateReadings(table: GateReadingTable = []): { readonly requests: ReadonlyArray<{ readonly state: unknown }> } {
  const log: { requests: ReadonlyArray<{ readonly state: unknown }> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    const { port, requests } = gateReadingsPort(table);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return log;
}
