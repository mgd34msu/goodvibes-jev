/**
 * The gate's Jev reading of one tool call: the risk-family and side-effect
 * batteries asked in parallel (one request each), composed in code into the
 * call's stakes. The facts are narrow yes/no questions; the composition is
 * the rule below, kept in one place (stakesFromFacts).
 *
 * Code reads an uncertain fact as true: a reading that does not reach a
 * confident no counts as yes. Doubt raises the stakes; it never lowers them.
 */
import { snapshotJudgmentInput } from './judgment-input.js';
import { executePolicyCheck } from './execute-policy-check.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { JsonValue, Stakes, YesNoReading } from '@goodvibes-jev/judgment';
import { riskFamily, type GateRiskFamily } from './batteries/risk-family.js';
import { sideEffect, type SideEffectKind } from './batteries/side-effect.js';
import { boundaryReading } from './batteries/boundary.js';
import type { PermissionCategory } from '../permissions/types.js';
import type { CommandClassification } from '../runtime/permissions/types.js';

/** The yes/no facts behind a call's stakes. */
export interface GateFacts {
  readonly mutates: boolean;
  readonly outward: boolean;
  readonly secrets: boolean;
  readonly irreversible: boolean;
  readonly beyondProject: boolean;
  readonly weakensSecurity: boolean;
  /** Asked only for a call that carries a shell command; false otherwise. */
  readonly obfuscated: boolean;
  /**
   * The boundary could not tell whether the shell command is catastrophic:
   * the call is not refused, and it is critical stakes so every preset asks.
   */
  readonly catastrophicUncertain?: boolean | undefined;
}

export type GateFactName = Exclude<keyof GateFacts, 'catastrophicUncertain'>;

export interface GateReading extends GateFacts {
  readonly family: GateRiskFamily;
  /** Whether the family reading reached act; the accept-edits allowance needs it. */
  readonly familyConfident: boolean;
  readonly stakes: Stakes;
  /** Facts whose reading was uncertain and were therefore taken as true. */
  readonly uncertain: readonly GateFactName[];
  /** The side-effect kind, when the caller asked for it. */
  readonly kind?: SideEffectKind | undefined;
  /**
   * The boundary questions (batteries/boundary.ts), as verdicts: whether the
   * shell command would destroy the machine or the user's data wholesale
   * (asked only for a call carrying one), and whether the call carries payment
   * card details. gate/boundary.ts decides on them.
   */
  readonly boundary: {
    readonly catastrophic?: YesNoReading['verdict'] | undefined;
    readonly cardDetails: YesNoReading['verdict'];
  };
  /** Records what the gate did with this reading in the decision log. */
  recordAction(action: string): void;
}

/**
 * The stakes rule. Critical: loosens a security boundary, is written to hide
 * what it does, might be catastrophic (an uncertain boundary reading), or is
 * hard to undo
 * and reaches beyond the project or outside the machine, or sends secrets out.
 * High: hard to undo, touches secrets, reaches beyond the project, or goes
 * outside the machine. Medium: changes something. Low: changes nothing.
 */
export function stakesFromFacts(facts: GateFacts): Stakes {
  if (facts.weakensSecurity || facts.obfuscated || facts.catastrophicUncertain) return 'critical';
  if (facts.irreversible && (facts.beyondProject || facts.outward)) return 'critical';
  if (facts.secrets && facts.outward) return 'critical';
  if (facts.irreversible || facts.secrets || facts.beyondProject || facts.outward) return 'high';
  if (facts.mutates) return 'medium';
  return 'low';
}

/** How long a string argument may be before the reading shows only its head. */
const MAX_STRING_CHARS = 4000;

/** Already privacy-checked JSON, with long strings cut to a head and a dropped-length marker. */
function boundedArguments(value: unknown): JsonValue {
  if (typeof value === 'string') {
    return value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS)} [${value.length - MAX_STRING_CHARS} more characters]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const projected: JsonValue[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      if (Object.hasOwn(value, index)) projected[index] = boundedArguments(value[index]);
    }
    return projected;
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, boundedArguments(v)]));
  }
  return String(value);
}

/** Privacy-checked arguments; scan the complete input before applying size caps. */
export function readingArguments(value: unknown): JsonValue {
  return boundedArguments(snapshotJudgmentInput(value));
}

/** The state a gate battery reads: the tool, its arguments and the working directory. */
export function readingState(toolName: string, args: Record<string, unknown>, workingDirectory?: string): { [key: string]: JsonValue } {
  const snapshot = snapshotJudgmentInput({ args, workingDirectory }, toolName) as { args: unknown; workingDirectory?: string };
  return {
    tool: toolName,
    arguments: boundedArguments(snapshot.args),
    ...(snapshot.workingDirectory ? { workingDirectory: snapshot.workingDirectory } : {}),
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
  /** Also ask whether the shell command is obfuscated (for a call that carries one). */
  readonly askObfuscated?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The decision site the gate's readings are logged under. */
export const GATE_SITE = 'engine.gate';

/** Reads one tool call through the gate's two batteries, in parallel. */
export async function readToolCall(input: ReadToolCallInput, site: string = GATE_SITE): Promise<GateReading> {
  const state = readingState(input.toolName, input.args, input.workingDirectory);
  const port = judgmentPort(site);
  const signal = input.signal === undefined ? {} : { signal: input.signal };
  const shell = input.askObfuscated === true;
  const [effect, risk, edge] = await Promise.all([
    sideEffect.run(port, state, {
      site,
      only: [
        'mutates',
        'outward',
        'secrets',
        ...(input.askKind ? (['kind'] as const) : []),
        ...(input.askObfuscated ? (['obfuscated'] as const) : []),
      ],
      ...signal,
    }),
    riskFamily.run(port, state, { site, ...signal }),
    boundaryReading.run(port, state, { site, only: shell ? ['catastrophic', 'cardDetails'] : ['cardDetails'], ...signal }),
  ]);
  const catastrophic = shell ? edge.readings.catastrophic.verdict : undefined;
  if (catastrophic !== undefined) rememberCatastrophic(input.args, catastrophic);
  const yesNo: Partial<Record<GateFactName, YesNoReading>> = {
    mutates: effect.readings.mutates,
    outward: effect.readings.outward,
    secrets: effect.readings.secrets,
    irreversible: risk.readings.irreversible,
    beyondProject: risk.readings.beyondProject,
    weakensSecurity: risk.readings.weakensSecurity,
    ...(input.askObfuscated ? { obfuscated: effect.readings.obfuscated } : {}),
  };
  const facts = {
    obfuscated: false,
    ...Object.fromEntries(Object.entries(yesNo).map(([name, reading]) => [name, factOf(reading!)])),
    catastrophicUncertain: catastrophic === 'uncertain',
  } as GateFacts;
  const uncertain = (Object.keys(yesNo) as GateFactName[]).filter((name) => yesNo[name]!.verdict === 'uncertain');
  const kindReading = input.askKind ? effect.readings.kind : undefined;
  return {
    ...facts,
    family: risk.readings.family.choice,
    familyConfident: risk.readings.family.outcome === 'act',
    stakes: stakesFromFacts(facts),
    uncertain,
    ...(kindReading ? { kind: kindReading.choice } : {}),
    boundary: { catastrophic, cardDetails: edge.readings.cardDetails.verdict },
    recordAction(action) {
      effect.recordAction(action);
      risk.recordAction(action);
      edge.recordAction(action);
    },
  };
}

/** Risk families whose calls hand work to another agent, runner or server. */
const DELEGATING_FAMILIES: ReadonlySet<GateRiskFamily> = new Set(['agent-spawn', 'delegation', 'remote-dispatch', 'mcp-escalation']);

/**
 * The policy evaluator's classification of a call, from the gate's reading:
 * delegation by its risk family, then network when it reaches outside this
 * machine, destructive when it changes something that cannot be undone,
 * write when it changes anything, else read. It replaces the evaluator's
 * tool-name lists, which guessed what a tool does from what it is called.
 */
export function classificationFromReading(reading: Pick<GateReading, 'family' | 'outward' | 'mutates' | 'irreversible'>): CommandClassification {
  if (DELEGATING_FAMILIES.has(reading.family)) return 'escalation';
  if (reading.outward) return 'network';
  if (reading.mutates) return reading.irreversible ? 'destructive' : 'write';
  return 'read';
}

/**
 * Reads a call through the gate's batteries and returns its evaluator
 * classification, for policy simulation and preflight, which evaluate a call
 * outside the gate. A JudgmentError propagates.
 */
export async function readCallClassification(toolName: string, args: Record<string, unknown>, site: string = GATE_SITE): Promise<CommandClassification> {
  return classificationFromReading(await readToolCall({ toolName, args, askObfuscated: shellCommandsIn(args).length > 0 }, site));
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
  const state = readingState(toolName, args);
  const run = await sideEffect.run(judgmentPort(site), state, { site, only: ['kind'] });
  return { kind: run.readings.kind.choice, confident: run.readings.kind.outcome === 'act' };
}

/** The shell commands a call's arguments carry: a `commands` list of `{ cmd }`, or `command` / `cmd`. */
export function shellCommandsIn(args: Record<string, unknown>): string[] {
  const listed = Array.isArray(args['commands'])
    ? (args['commands'] as unknown[]).flatMap((entry) => (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['cmd'] === 'string' ? [(entry as Record<string, unknown>)['cmd'] as string] : []))
    : [];
  if (listed.length > 0) return listed;
  for (const key of ['command', 'cmd']) if (typeof args[key] === 'string') return [args[key] as string];
  return [];
}

/**
 * The catastrophic verdicts the gate read, by command text, so the exec tool's
 * run-time check (tools/exec/ast-guard.ts) repeats the gate's decision without
 * asking again. Bounded: the oldest entry leaves first.
 */
const CATASTROPHIC_SEEN = new Map<string, YesNoReading['verdict']>();
const CATASTROPHIC_SEEN_LIMIT = 256;

function rememberCatastrophic(args: Record<string, unknown>, verdict: YesNoReading['verdict']): void {
  const commands = shellCommandsIn(args);
  if (commands.length !== 1) return;
  CATASTROPHIC_SEEN.delete(commands[0]!);
  CATASTROPHIC_SEEN.set(commands[0]!, verdict);
  if (CATASTROPHIC_SEEN.size > CATASTROPHIC_SEEN_LIMIT) CATASTROPHIC_SEEN.delete(CATASTROPHIC_SEEN.keys().next().value!);
}

/**
 * Whether one shell command would destroy the machine or the user's data
 * wholesale: the gate's reading of it when the gate read this command
 * (`readByGate`), or a fresh `engine.gate.boundary` reading of just that
 * question, which is not remembered as the gate's.
 */
export async function readCatastrophic(
  command: string,
  site = 'engine.gate.exec-time',
  signal?: AbortSignal,
): Promise<{ readonly verdict: YesNoReading['verdict']; readonly readByGate: boolean }> {
  signal?.throwIfAborted();
  const state = readingState('exec', { command });
  const seen = CATASTROPHIC_SEEN.get(command);
  if (seen !== undefined) return { verdict: seen, readByGate: true };
  const run = await executePolicyCheck(() => boundaryReading.run(judgmentPort(site), state, {
    site, only: ['catastrophic'], ...(signal === undefined ? {} : { signal }),
  }), signal);
  signal?.throwIfAborted();
  const verdict = run.readings.catastrophic.verdict;
  run.recordAction(`exec-time:${verdict}`);
  return { verdict, readByGate: false };
}

export { readTouchesSecrets } from '../permissions/credential-read-defaults.js';

/** Forgets the catastrophic verdicts the gate remembered (tests, and a model change). */
export function forgetCatastrophicReadings(): void {
  CATASTROPHIC_SEEN.clear();
}
