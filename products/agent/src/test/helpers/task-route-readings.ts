import { afterEach, beforeEach } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  NAMED_ID_KINDS,
  type ChannelTask,
  type NamedIdKind,
  type PersonalOpsLaneId,
  type TaskRouteSlots,
} from '@goodvibes-jev/engine/sdk/platform/routing';
import type { EntryType } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

type Flag = { [K in keyof TaskRouteSlots]: TaskRouteSlots[K] extends boolean ? K : never }[keyof TaskRouteSlots];

/** Explicit synthetic readings, never an interpretation of the request text. */
export interface TaskRouteReadings {
  readonly pick: string;
  readonly fits?: Readonly<Record<string, number>>;
  readonly slots?: Partial<Readonly<Record<Flag, number>>>;
  readonly choices?: {
    readonly lane?: PersonalOpsLaneId | 'none';
    readonly channelTask?: ChannelTask;
    readonly policyTarget?: string;
  };
  readonly named?: Partial<Readonly<Record<NamedIdKind, string>>>;
  /** Catalog record ids read as relevant; every unlisted record reads no. */
  readonly catalogFits?: Readonly<Record<string, number>>;
}

const FLAGS: Readonly<Record<Flag, number>> = {
  changes: 0.05,
  starts: 0.05,
  opensUi: 0.05,
  controls: 0.05,
  existing: 0.05,
  freshRead: 0.05,
  reminder: 0.05,
  delegated: 0.05,
  device: 0.05,
  evidence: 0.05,
  instructionFiles: 0.05,
};
const CHOICES = { lane: 'none', channelTask: 'status', policyTarget: 'none' } as const;

interface ReadingState {
  readonly context?: { readonly request: string; readonly kind?: string };
  readonly request?: string;
  readonly query?: string;
  readonly candidates?: readonly { readonly id: string }[];
  readonly candidate?: { readonly name: string };
}

/** Unknown requests or question families fail instead of inventing routing logic. */
export function taskRoutePort(fixtures: Readonly<Record<string, TaskRouteReadings>>) {
  return fakePort((name, question, rawState: EntryType) => {
    const state = rawState as unknown as ReadingState;
    const request = state.context?.request ?? state.request ?? state.query;
    const script = request === undefined ? undefined : fixtures[request];
    if (!script) throw new Error(`No task-route readings for request ${JSON.stringify(request)}`);

    if (state.candidates) {
      const kind = state.context?.kind;
      const namedKind = (Object.keys(NAMED_ID_KINDS) as NamedIdKind[]).find((key) => NAMED_ID_KINDS[key] === kind);
      if (kind !== undefined && namedKind === undefined) throw new Error(`Unknown task-route named-id kind ${kind}`);
      const chosen = namedKind === undefined ? script.pick : script.named?.[namedKind] ?? 'none';
      if (chosen !== 'none' && !state.candidates.some(({ id }) => id === chosen)) {
        throw new Error(`Task-route fixture chose unavailable candidate ${chosen}`);
      }
      if (name === 'pick') return choiceAnswer(question, chosen);
      const candidate = state.candidates.find((_entry, index) => name === `fits_${index}`);
      if (!candidate) throw new Error(`Unknown task-route selection question ${name}`);
      return noulAnswer(namedKind === undefined
        ? script.fits?.[candidate.id] ?? (candidate.id === chosen ? 0.95 : 0.05)
        : candidate.id === chosen ? 0.95 : 0.05);
    }

    // engine.tools.registry-rank asks one match per workspace/harness record.
    if (state.candidate && name === 'match') return noulAnswer(script.catalogFits?.[state.candidate.name] ?? 0.05);
    if (question.type === 'choice' && Object.hasOwn(CHOICES, name)) {
      const key = name as keyof typeof CHOICES;
      return choiceAnswer(question, script.choices?.[key] ?? CHOICES[key]);
    }
    if (Object.hasOwn(FLAGS, name)) return noulAnswer(script.slots?.[name as Flag] ?? FLAGS[name as Flag]);
    throw new Error(`Unknown task-route reading question ${name}`);
  });
}

/** Each test owns its local port and restores the normal guarded environment. */
export function useTaskRouteReadings(fixtures: Readonly<Record<string, TaskRouteReadings>>): void {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    previous = installJudgmentPort(taskRoutePort(fixtures).port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
}
