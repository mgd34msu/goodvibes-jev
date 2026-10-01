import type {
  AttemptCandidate,
  AttemptJudgment,
  AttemptPickResult,
  HeldMergeGroup,
} from '@goodvibes-jev/engine/sdk/platform/orchestration';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  operatorFlagValue,
  parseOperatorCommandArgs,
} from './operator-command-args.ts';
import { withRuntimeServices } from './management.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * `goodvibes-agent fleet`, the best-of-N attempts admin surface (SDK 1.6.1
 * orchestration engine held-merge groups). Unlike ci/principals/channel-
 * profiles (which reach a REMOTE connected host over HTTP), fleet.attempts.*
 * is ws-only on the wire (no HTTP binding, see method-catalog-fleet.ts) and
 * reads THIS agent's own orchestration engine, which persists workstream
 * state to disk (.goodvibes/orchestration/<workstreamId>.json). So this
 * command goes through withRuntimeServices (the same in-process
 * RuntimeServices construction `tasks`/`sessions` already use, see
 * management.ts), not the operator-gateway-call HTTP path ci-command.ts
 * uses: calling sdk.operator.invoke on a method with no `http` binding always
 * throws (methodHttpRoute in @pellux/goodvibes-operator-sdk), so the HTTP
 * path can never reach these three verbs regardless of connection health.
 * services.orchestrationEngine is the exact same FleetAttemptsController
 * instance the fleet.attempts.* gateway verb handlers are wired to in
 * runtime/services.ts, so this CLI and the gateway verbs read/write
 * identical state.
 */

const FLEET_ATTEMPTS_PICK_USAGE = 'Usage: goodvibes-agent fleet attempts pick <groupId> <winnerItemId> --yes';
const FLEET_ATTEMPTS_JUDGE_USAGE = 'Usage: goodvibes-agent fleet attempts judge <groupId>';
const FLEET_USAGE = 'Usage: goodvibes-agent fleet attempts [list [--workstream <workstreamId>]|pick <groupId> <winnerItemId> --yes|judge <groupId>]';

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function usageFailure(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'invalid_fleet_command', error }, error),
    exitCode: 2,
  };
}

function errorFailure(runtime: CliCommandRuntime, error: unknown): CliCommandOutput {
  const message = summarizeError(error);
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'fleet_attempts_error', error: message }, message),
    exitCode: 1,
  };
}

/** The model proposal is clearly labeled at every point it renders, never presented as a decision. */
function renderJudgment(judgment: AttemptJudgment | null): readonly string[] {
  if (!judgment) return ['    judge proposal: none yet'];
  const winner = judgment.proposedWinnerItemId ?? '(judge declined to choose)';
  const lines = [
    `    MODEL PROPOSAL (scored by ${judgment.model ?? 'unknown model'}, not a decision, confirm with fleet attempts pick)`,
    `      proposed winner ${winner}`,
  ];
  for (const reason of judgment.reasons) lines.push(`      reason: ${reason}`);
  return lines;
}

function renderCandidate(candidate: AttemptCandidate): readonly string[] {
  const lines = [
    `    ${candidate.itemId}  attempt #${candidate.attemptIndex}  ${candidate.state}  ${candidate.title}`,
  ];
  if (candidate.state === 'failed' && candidate.failureReason) {
    lines.push(`      failure: ${candidate.failureReason}`);
  }
  if (candidate.diff) {
    lines.push(`      diff: ${candidate.diff.files.length} file(s), ${candidate.diff.stat}`);
  }
  const usage = candidate.usage;
  const cost = usage.costState === 'priced' && usage.costUsd !== null ? `$${usage.costUsd.toFixed(4)}` : usage.costState;
  lines.push(`      usage: ${usage.turnCount} turn(s), ${usage.toolCallCount} tool call(s), cost ${cost}`);
  return lines;
}

function renderGroup(group: HeldMergeGroup): string {
  return [
    `  ${group.groupId}  workstream ${group.workstreamId}  ${group.sourceTitle}`,
    `    ready ${group.ready ? 'yes' : 'no'}  autoAccept ${group.autoAccept ? 'yes' : 'no'}  candidates ${group.candidates.length}`,
    ...group.candidates.flatMap(renderCandidate),
    ...renderJudgment(group.judgment),
  ].join('\n');
}

function renderGroupList(groups: readonly HeldMergeGroup[]): string {
  if (groups.length === 0) {
    return [
      'Best-of-N held-merge groups',
      '  No groups are currently held for a winner pick.',
    ].join('\n');
  }
  return [`Best-of-N held-merge groups (${groups.length})`, ...groups.map(renderGroup)].join('\n\n');
}

async function handleFleetAttemptsList(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['workstream']);
  const workstreamId = operatorFlagValue(parsed, 'workstream');
  try {
    const groups = await withRuntimeServices(runtime, (services) => services.orchestrationEngine.listHeldMergeGroups(workstreamId));
    return { output: jsonOrText(runtime, { ok: true, groups }, renderGroupList(groups)), exitCode: 0 };
  } catch (error) {
    return errorFailure(runtime, error);
  }
}

async function handleFleetAttemptsPick(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const groupId = parsed.positionals[0];
  const winnerItemId = parsed.positionals[1];
  if (!groupId || !winnerItemId) return usageFailure(runtime, FLEET_ATTEMPTS_PICK_USAGE);
  if (!parsed.yes) {
    return { output: `Refusing to pick a winner for group ${groupId} without --yes. Losing siblings' worktrees are cleaned on pick.`, exitCode: 2 };
  }
  try {
    const result: AttemptPickResult = await withRuntimeServices(runtime, (services) => services.orchestrationEngine.pickAttemptWinner(groupId, winnerItemId));
    const text = [
      `Picked winner ${result.winnerItemId} for group ${result.groupId}`,
      `  losers cleaned: ${result.loserItemIds.length === 0 ? 'none' : result.loserItemIds.join(', ')}`,
      `  auto-picked ${result.auto ? 'yes (judge auto-accept)' : 'no (explicit operator pick)'}`,
    ].join('\n');
    return { output: jsonOrText(runtime, { ok: true, ...result }, text), exitCode: 0 };
  } catch (error) {
    return errorFailure(runtime, error);
  }
}

async function handleFleetAttemptsJudge(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const groupId = parsed.positionals[0];
  if (!groupId) return usageFailure(runtime, FLEET_ATTEMPTS_JUDGE_USAGE);
  try {
    const judgment: AttemptJudgment = await withRuntimeServices(runtime, (services) => services.orchestrationEngine.proposeAttemptWinner(groupId));
    const text = [
      `Judge proposal for group ${groupId}`,
      ...renderJudgment(judgment),
      '',
      'This is a model judgment, not a decision. Confirm with:',
      `  goodvibes-agent fleet attempts pick ${groupId} <winnerItemId> --yes`,
    ].join('\n');
    return { output: jsonOrText(runtime, { ok: true, judgment }, text), exitCode: 0 };
  } catch (error) {
    return errorFailure(runtime, error);
  }
}

async function handleFleetAttemptsCommand(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const [sub = 'list', ...rest] = args;
  switch (sub.toLowerCase()) {
    case 'list':
      return handleFleetAttemptsList(runtime, rest);
    case 'pick':
      return handleFleetAttemptsPick(runtime, rest);
    case 'judge':
      return handleFleetAttemptsJudge(runtime, rest);
    default:
      return usageFailure(runtime, FLEET_USAGE);
  }
}

export async function handleFleetCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub, ...rest] = runtime.cli.commandArgs;
  switch ((sub ?? '').toLowerCase()) {
    case 'attempts':
      return handleFleetAttemptsCommand(runtime, rest);
    default:
      return usageFailure(runtime, FLEET_USAGE);
  }
}
