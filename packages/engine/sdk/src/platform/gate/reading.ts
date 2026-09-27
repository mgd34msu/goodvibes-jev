/**
 * The gate's Jev reading of one tool call: the risk-family and side-effect
 * batteries asked in parallel (one request each), composed in code into the
 * call's stakes. The facts are narrow yes/no questions; the composition is
 * the rule below, kept in one place (stakesFromFacts).
 *
 * Code reads an uncertain fact as true: a reading that does not reach a
 * confident no counts as yes. Doubt raises the stakes; it never lowers them.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { JsonValue, Stakes, YesNoReading } from '@goodvibes-jev/judgment';
import { riskFamily, type GateRiskFamily } from './batteries/risk-family.js';
import { sideEffect, type SideEffectKind } from './batteries/side-effect.js';
import type { PermissionCategory } from '../permissions/types.js';

/** The yes/no facts behind a call's stakes. */
export interface GateFacts {
  readonly mutates: boolean;
  readonly outward: boolean;
  readonly secrets: boolean;
  readonly irreversible: boolean;
  readonly beyondProject: boolean;
  readonly weakensSecurity: boolean;
}

export type GateFactName = keyof GateFacts;

export interface GateReading extends GateFacts {
  readonly family: GateRiskFamily;
  /** Whether the family reading reached act; the accept-edits allowance needs it. */
  readonly familyConfident: boolean;
  readonly stakes: Stakes;
  /** Facts whose reading was uncertain and were therefore taken as true. */
  readonly uncertain: readonly GateFactName[];
  /** The side-effect kind, when the caller asked for it. */
  readonly kind?: SideEffectKind | undefined;
  /** Records what the gate did with this reading in the decision log. */
  recordAction(action: string): void;
}

/**
 * The stakes rule. Critical: loosens a security boundary, or is hard to undo
 * and reaches beyond the project or outside the machine, or sends secrets out.
 * High: hard to undo, touches secrets, reaches beyond the project, or goes
 * outside the machine. Medium: changes something. Low: changes nothing.
 */
export function stakesFromFacts(facts: GateFacts): Stakes {
  if (facts.weakensSecurity) return 'critical';
  if (facts.irreversible && (facts.beyondProject || facts.outward)) return 'critical';
  if (facts.secrets && facts.outward) return 'critical';
  if (facts.irreversible || facts.secrets || facts.beyondProject || facts.outward) return 'high';
  if (facts.mutates) return 'medium';
  return 'low';
}

/** How long a string argument may be before the reading shows only its head. */
const MAX_STRING_CHARS = 4000;

/** The arguments as JSON, with very long strings cut to a head and a marker naming the dropped length. */
export function readingArguments(value: unknown): JsonValue {
  if (typeof value === 'string') {
    return value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS)} [${value.length - MAX_STRING_CHARS} more characters]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map(readingArguments);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, readingArguments(v)]));
  }
  return String(value);
}

/** The state a gate battery reads: the tool, its arguments and the working directory. */
export function readingState(toolName: string, args: Record<string, unknown>, workingDirectory?: string): { [key: string]: JsonValue } {
  return {
    tool: toolName,
    arguments: readingArguments(args),
    ...(workingDirectory ? { workingDirectory } : {}),
  };
}

/** A yes/no fact as code uses it: true unless the reading is a no. */
const factOf = (reading: YesNoReading): boolean => reading.verdict !== 'no';

export interface ReadToolCallInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workingDirectory?: string | undefined;
  /** Also ask the side-effect kind (for a tool the closed tool table does not name). */
  readonly askKind?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The decision site the gate's readings are logged under. */
export const GATE_SITE = 'engine.gate';

/** Reads one tool call through the gate's two batteries, in parallel. */
export async function readToolCall(input: ReadToolCallInput, site: string = GATE_SITE): Promise<GateReading> {
  const port = judgmentPort(site);
  const state = readingState(input.toolName, input.args, input.workingDirectory);
  const signal = input.signal === undefined ? {} : { signal: input.signal };
  const [effect, risk] = await Promise.all([
    sideEffect.run(port, state, {
      site,
      only: input.askKind ? ['mutates', 'outward', 'secrets', 'kind'] : ['mutates', 'outward', 'secrets'],
      ...signal,
    }),
    riskFamily.run(port, state, { site, ...signal }),
  ]);
  const yesNo: Readonly<Record<GateFactName, YesNoReading>> = {
    mutates: effect.readings.mutates,
    outward: effect.readings.outward,
    secrets: effect.readings.secrets,
    irreversible: risk.readings.irreversible,
    beyondProject: risk.readings.beyondProject,
    weakensSecurity: risk.readings.weakensSecurity,
  };
  const facts = Object.fromEntries(Object.entries(yesNo).map(([name, reading]) => [name, factOf(reading)])) as unknown as GateFacts;
  const uncertain = (Object.keys(yesNo) as GateFactName[]).filter((name) => yesNo[name].verdict === 'uncertain');
  const kindReading = input.askKind ? effect.readings.kind : undefined;
  return {
    ...facts,
    family: risk.readings.family.choice,
    familyConfident: risk.readings.family.outcome === 'act',
    stakes: stakesFromFacts(facts),
    uncertain,
    ...(kindReading ? { kind: kindReading.choice } : {}),
    recordAction(action) {
      effect.recordAction(action);
      risk.recordAction(action);
    },
  };
}

/** The permission category a side-effect kind maps to (fetch-like network reads stay read, as the fetch tool is). */
const CATEGORY_FOR_KIND: Readonly<Record<SideEffectKind, PermissionCategory>> = {
  read: 'read',
  write: 'write',
  shell: 'execute',
  network: 'read',
  delegation: 'delegate',
  browser: 'execute',
  other: 'delegate',
};

export function categoryForSideEffectKind(kind: SideEffectKind): PermissionCategory {
  return CATEGORY_FOR_KIND[kind];
}

/** Reads only the side-effect kind of a call (the execution ledger's route kind). */
export async function readSideEffectKind(toolName: string, args: Record<string, unknown>, site: string): Promise<{ readonly kind: SideEffectKind; readonly confident: boolean }> {
  const run = await sideEffect.run(judgmentPort(site), readingState(toolName, args), { site, only: ['kind'] });
  return { kind: run.readings.kind.choice, confident: run.readings.kind.outcome === 'act' };
}
