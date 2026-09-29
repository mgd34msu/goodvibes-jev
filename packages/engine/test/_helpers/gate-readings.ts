/**
 * A fake judgment port for the gate's batteries (packages/engine/sdk/src/platform/gate),
 * so tests of the gate, the permission phase and the tools never call the
 * live Jev API.
 *
 * Each table entry pairs text that appears in the reading's state (the tool
 * call JSON the gate sends) with what Jev is expected to read about it. The
 * first matching entry answers; an unmatched call reads as a medium-stakes
 * change: it changes state and nothing else, in the `file-mutation` family for
 * the write and edit tools and `generic` otherwise. Every other question
 * (secrets, the boundary, taint and sandbox needs) reads no unless the entry
 * says yes, so a known read-only tool call runs without a full reading. That default makes the
 * normal preset ask, the auto preset allow and the plan preset deny, which is
 * what the old mode matrix did for writes and commands. Readings are strong,
 * so every band acts on them.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetCatastrophicReadings } from '../../sdk/src/platform/gate/reading.ts';
import { forgetReadSecrets } from '../../sdk/src/platform/permissions/credential-read-defaults.ts';
import { forgetCommandNeeds } from '../../sdk/src/platform/runtime/permissions/normalization/classifier.ts';

/** Clears the readings the gate remembers per process, so one test's answers never serve another. */
export function forgetGateReadings(): void {
  forgetCatastrophicReadings();
  forgetReadSecrets();
  forgetCommandNeeds();
}
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
  /** The boundary battery: the shell command would destroy the machine or the user's data. */
  readonly catastrophic?: boolean | 'uncertain';
  /** The boundary battery: the call carries payment card details. */
  readonly cardDetails?: boolean;
  /** The outward-taint battery: what the call sends derives from untrusted text. */
  readonly derives?: boolean;
  /** The sandbox-needs battery. */
  readonly needsNetwork?: boolean;
  readonly needsPrivilege?: boolean;
  /** The settings-hazard battery. */
  readonly hazard?: string;
  readonly requested?: boolean;
}

export type GateReadingTable = ReadonlyArray<readonly [text: string, reading: GateCallReading]>;

/** A read-only, low-stakes reading. */
export const READ_ONLY: GateCallReading = { mutates: false, family: 'generic', kind: 'read' };

function defaultReading(state: unknown): GateCallReading {
  const tool = typeof state === 'object' && state !== null ? (state as { tool?: unknown }).tool : undefined;
  const edits = tool === 'write' || tool === 'edit';
  return { mutates: true, family: edits ? 'file-mutation' : 'generic', kind: edits ? 'write' : 'other' };
}

const YES_NO = ['mutates', 'outward', 'secrets', 'irreversible', 'beyondProject', 'weakensSecurity', 'obfuscated', 'flagsRisk', 'catastrophic', 'cardDetails', 'derives', 'needsNetwork', 'needsPrivilege', 'requested'] as const;

/** A port answering the gate batteries from `table`, recording every request. */
export function gateReadingsPort(table: GateReadingTable = []) {
  return fakePort((name: string, question: Question, state: unknown) => {
    const text = JSON.stringify(state);
    const reading = { ...defaultReading(state), ...(table.find(([match]) => text.includes(match))?.[1] ?? {}) };
    if (name === 'family') return choiceAnswer(question, reading.family ?? 'generic', 0.95);
    if (name === 'kind') return choiceAnswer(question, reading.kind ?? 'other', 0.95);
    if (name === 'capability') return choiceAnswer(question, reading.capability ?? 'generic', 0.95);
    if (name === 'hazard') return choiceAnswer(question, reading.hazard ?? 'none', 0.95);
    if ((YES_NO as readonly string[]).includes(name)) {
      const value = reading[name as (typeof YES_NO)[number]];
      return noulAnswer(value === 'uncertain' ? 0.5 : value === true ? 0.97 : 0.03);
    }
    // Any other yes/no question a tool asks along the way (for example the
    // credential-env scrub) reads as a no, so a plain command runs plainly.
    if (question.type === 'noul') return noulAnswer(0.03);
    throw new Error(`gate-readings: no answer for question ${name}`);
  });
}

/**
 * Installs a {@link gateReadingsPort} around every test in the calling file
 * (or describe block) and restores the previous port afterwards. The returned
 * object's `requests` is the current test's request log.
 */
export function useGateReadings(table: GateReadingTable = []): { readonly requests: ReadonlyArray<{ readonly state: unknown; readonly questions?: Readonly<Record<string, unknown>> }> } {
  const log: { requests: ReadonlyArray<{ readonly state: unknown; readonly questions?: Readonly<Record<string, unknown>> }> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    forgetGateReadings();
    const { port, requests } = gateReadingsPort(table);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
    forgetGateReadings();
  });
  return log;
}

/**
 * Readings for tests that run shell commands through the exec tool: the
 * catastrophic shapes those tests use read as catastrophic, and commands that
 * reach the network read as needing it. Everything else reads as ordinary.
 */
export const EXEC_GATE_TABLE: GateReadingTable = [
  ['rm -rf /"', { mutates: true, catastrophic: true }],
  ['rm -rf / ', { mutates: true, catastrophic: true }],
  ['rm -rf /*', { mutates: true, catastrophic: true }],
  ['rm --no-preserve-root', { mutates: true, catastrophic: true }],
  ['of=/dev/sd', { mutates: true, catastrophic: true }],
  ['of=/dev/nvme', { mutates: true, catastrophic: true }],
  ['mkfs', { mutates: true, catastrophic: true }],
  [':(){', { mutates: true, catastrophic: true }],
  ['curl ', { mutates: false, outward: true, needsNetwork: true }],
  ['wget ', { mutates: false, outward: true, needsNetwork: true }],
];
