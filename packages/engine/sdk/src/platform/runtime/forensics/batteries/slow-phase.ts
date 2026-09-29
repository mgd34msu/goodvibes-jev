/**
 * `engine.runtime.forensics-slow-phase`: did one phase of a failed turn or
 * task take unusually long for what that phase does? Read by the forensics
 * collector (forensics/collector.ts, readSlowPhases) when it builds a failure
 * report, in place of the registry's single 1000 ms line for every phase kind
 * (forensics/registry.ts slowPhases), which called an ordinary five-second
 * model stream slow and a two-second preflight check fine alike.
 *
 * One yes/no per timed phase, all of a report's phases sent together; state:
 * `{ domain, phase, durationMs, succeeded }`. Phases with no duration are not
 * asked. The yes phases, in phase order, are the report's slowPhases (code),
 * which the incident bundle lists and the incident memory record tags.
 *
 * Band: low stakes. The answer labels a diagnostic; nothing gates, retries or
 * blocks on it.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const phase = (domain: 'turn' | 'task', name: string, durationMs: number, succeeded: boolean) => ({ domain, phase: name, durationMs, succeeded });

export const forensicsSlowPhase = defineBattery({
  name: 'engine.runtime.forensics-slow-phase',
  version: 1,
  description: 'Whether one phase of a failed agent turn or task took unusually long for what that phase does.',
  accuracyFloor: 0.9,
  items: {
    slow: yesNo(
      'In a failed `domain` of an AI coding assistant (a turn is one model request with its tool calls; a task is a background job), the phase `phase` took `durationMs` milliseconds and `succeeded` says whether it completed. Phases: SUBMITTED is queueing the request, PREFLIGHT is local checks before the model call, STREAM is the model generating its reply, STREAM_COMPLETE is finishing the stream, TOOL_BATCH is running the tools the model asked for, POST_TOOL_BATCH and POST_HOOKS are local bookkeeping and hooks after tools, CREATED is registering a task, RUNNING is a background task doing its work, which commonly takes minutes. Did this phase take unusually long for what that phase does?',
      STAKES_BANDS.low.yesNo,
      {
        true: 'The time is well beyond what this kind of phase normally needs, such as local checks, queueing or bookkeeping taking seconds, or a model stream or tool batch running for many minutes.',
        false: 'The time is ordinary for this kind of phase, such as a model stream or a tool batch running for several seconds, or local checks finishing in milliseconds.',
      },
    ),
  },
  fixtures: [
    { name: 'preflight taking seconds', state: phase('turn', 'PREFLIGHT', 4_800, true), expect: { slow: 'yes' } },
    { name: 'submission queued for half a minute', state: phase('turn', 'SUBMITTED', 31_000, true), expect: { slow: 'yes' } },
    { name: 'post hooks taking twelve seconds', state: phase('turn', 'POST_HOOKS', 12_000, false), expect: { slow: 'yes' } },
    { name: 'model stream running twelve minutes', state: phase('turn', 'STREAM', 720_000, false), expect: { slow: 'yes' } },
    { name: 'task registration taking seconds', state: phase('task', 'CREATED', 6_500, true), expect: { slow: 'yes' } },
    { name: 'tool batch stuck for forty minutes', state: phase('turn', 'TOOL_BATCH', 2_400_000, false), expect: { slow: 'yes' } },
    { name: 'ordinary model stream of six seconds', state: phase('turn', 'STREAM', 6_200, true), expect: { slow: 'no' } },
    { name: 'tool batch of three seconds', state: phase('turn', 'TOOL_BATCH', 3_100, false), expect: { slow: 'no' } },
    { name: 'quick preflight', state: phase('turn', 'PREFLIGHT', 40, true), expect: { slow: 'no' } },
    { name: 'post tool bookkeeping in milliseconds', state: phase('turn', 'POST_TOOL_BATCH', 12, true), expect: { slow: 'no' } },
    { name: 'stream completion in milliseconds', state: phase('turn', 'STREAM_COMPLETE', 8, true), expect: { slow: 'no' } },
    { name: 'background task running two minutes', state: phase('task', 'RUNNING', 120_000, false), expect: { slow: 'no' } },
  ],
});
