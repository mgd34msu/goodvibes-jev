/**
 * owner-profile-command.ts, `goodvibes-agent owner-profile` over the daemon's
 * `profile.*` control-plane verbs (docs/owner-profile.md §11.1).
 *
 * Named `owner-profile`, not `profile`: `profile` is already an alias for
 * `profiles`, the isolated Agent profile homes, and quietly re-pointing it at a
 * different subject would break a command that works today. The platform
 * runtime's own module makes the same distinction (§3, naming note), nothing
 * about the owner profile is called `profile` unqualified.
 *
 * Honesty rules, same as every other connected-host command here:
 * - Every write verb answers `ok`. `ok: false` covers a refusal AND a `forget`
 *   for a field that was not there; both exit non-zero with the daemon's own
 *   reason printed, and neither is ever reported as done (§9.2).
 * - No retry with a different authority.
 * - Values that come back are printed for HIM, at his own terminal. Nothing in
 *   this file logs a value, and `status` prints counts and field names only.
 */

import {
  createProfileGatewayInvoke,
  type ProfileGatewayInvoke,
} from '../agent/owner-profile-gateway.ts';
import {
  narrowProfileGet,
  narrowProfilePerson,
  narrowProfileProvenance,
  narrowProfileRead,
  narrowProfileStatus,
  narrowProfileWrite,
  PROFILE_METHOD_IDS,
  PROFILE_RECORDING_SURFACE,
  PROFILE_RESPONSE_UNREADABLE,
} from '../tools/agent-profile-types.ts';
import { operatorFlagValue, parseOperatorCommandArgs } from './operator-command-args.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

const READ_USAGE = 'Usage: goodvibes-agent owner-profile read';
const GET_USAGE = 'Usage: goodvibes-agent owner-profile get <fieldId>';
const PERSON_USAGE = 'Usage: goodvibes-agent owner-profile person <name> --named-by "<your words this turn>"';
const PROVENANCE_USAGE = 'Usage: goodvibes-agent owner-profile provenance <fieldId>';
const SET_USAGE = 'Usage: goodvibes-agent owner-profile set <fieldId> <value> [--said "<your words>"] --yes';
const FORGET_USAGE = [
  'Usage: goodvibes-agent owner-profile forget <fieldId> --yes',
  '       goodvibes-agent owner-profile forget --section <section> --text "<the line, as it reads>" --yes',
].join('\n');
const STATUS_USAGE = 'Usage: goodvibes-agent owner-profile status';
const OWNER_PROFILE_USAGE = [
  'Usage: goodvibes-agent owner-profile [read|get <fieldId>|person <name>|provenance <fieldId>|set <fieldId> <value> --yes|forget <fieldId> --yes|status]',
  READ_USAGE,
  GET_USAGE,
  PERSON_USAGE,
  PROVENANCE_USAGE,
  SET_USAGE,
  FORGET_USAGE,
  STATUS_USAGE,
].join('\n');

/**
 * A command-line edit is him editing his own file, so it carries owner-direct
 * authority, the only one the daemon accepts, and, when he does not quote
 * himself with --said, the same kind of stand-in a settings-UI edit uses (§7
 * layer 3, §9.3). It is a truthful record of where the line came from: he typed
 * it here, not in conversation.
 */
const CLI_EDIT_SAID = '(edited from the command line)';

/** The section holding facts about other people. Counted, never listed (§10). */
const PEOPLE_SECTION = 'people';

function jsonOrText(runtime: CliCommandRuntime, value: unknown, text: string): string {
  return runtime.cli.flags.outputFormat === 'json' ? JSON.stringify(value, null, 2) : text;
}

function usageFailure(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'invalid_owner_profile_command', error }, error),
    exitCode: 2,
  };
}

function gatewayFor(runtime: CliCommandRuntime): ProfileGatewayInvoke {
  // The CLI process composes no gateway catalog of its own, so every call goes
  // to the connected host that owns the file.
  return createProfileGatewayInvoke({
    configManager: runtime.configManager,
    homeDirectory: runtime.homeDirectory,
  });
}

async function handleRead(
  runtime: CliCommandRuntime,
  invoke: ProfileGatewayInvoke,
  outputEntersModelContext: boolean,
): Promise<CliCommandOutput> {
  const result = await invoke(PROFILE_METHOD_IDS.read, {});
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Profile read failed.'), exitCode: 1 };
  const response = narrowProfileRead(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  if (response.state.kind === 'unavailable') {
    const text = [
      `Your profile could not be read: ${response.state.reason ?? 'no reason given'}`,
      `  ${response.state.path}`,
    ].join('\n');
    return { output: jsonOrText(runtime, response, text), exitCode: 1 };
  }
  if (response.state.kind === 'disabled') {
    return {
      output: jsonOrText(runtime, response, `Your profile is turned off (${response.state.path}).`),
      exitCode: 1,
    };
  }
  const lines: string[] = [`Owner profile (${response.state.path})`];
  if (response.state.exists === false) lines.push('  The file does not exist yet; nothing has been recorded.');
  for (const section of response.sections) {
    lines.push(`  ## ${section.heading}`);
    // §10, keyed on the one thing that decides whether it applies: does this
    // output reach a model. Run as `/owner-profile` or through the workspace
    // card it lands in the transcript, which a later turn can compose from, so
    // People are counted and `person <name>` is the way through. Run at a shell
    // it goes to his terminal and nowhere else, so withholding his own list
    // would be friction with nothing gained, it is his file.
    //
    // One implementation, one predicate, and the predicate is a fact the caller
    // genuinely knows about itself rather than a guess. The default is the safe
    // answer (see OwnerProfileCommandOptions), so a call site that never thought
    // about it counts rather than lists.
    if (outputEntersModelContext && section.heading.trim().toLowerCase() === PEOPLE_SECTION) {
      const count = section.prose.length + section.fields.length;
      lines.push(`    ${count} ${count === 1 ? 'person' : 'people'} recorded; not listed here.`);
      lines.push('    Use `owner-profile person <name>` to see one.');
      continue;
    }
    if (section.fields.length === 0 && section.prose.length === 0) {
      lines.push('    (nothing recorded)');
      continue;
    }
    for (const field of section.fields) {
      const suffix = field.provenance
        ? `, from ${field.provenance.surface} on ${field.provenance.date}, you said: "${field.provenance.said}"`
        : '';
      const invalid = field.valid ? '' : `  (did not parse: ${field.invalidReason ?? 'no reason given'})`;
      lines.push(`    ${field.label}: ${field.value}${suffix}${invalid}`);
    }
    for (const line of section.prose) {
      const suffix = line.provenance
        ? `, from ${line.provenance.surface} on ${line.provenance.date}, you said: "${line.provenance.said}"`
        : '';
      lines.push(`    ${line.text}${suffix}`);
    }
  }
  return { output: jsonOrText(runtime, response, lines.join('\n')), exitCode: 0 };
}

async function handleProvenance(
  runtime: CliCommandRuntime,
  invoke: ProfileGatewayInvoke,
  args: readonly string[],
): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const fieldId = parsed.positionals[0];
  if (!fieldId) return usageFailure(runtime, PROVENANCE_USAGE);
  const result = await invoke(PROFILE_METHOD_IDS.provenance, { fieldId });
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Provenance read failed.'), exitCode: 1 };
  const response = narrowProfileProvenance(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  if (!response.present) {
    return {
      output: jsonOrText(runtime, response, `${response.fieldId} is not in your profile; there is nothing to trace.`),
      exitCode: 1,
    };
  }
  const lines = [`${response.fieldId}`];
  if (response.provenance) {
    lines.push(`  from ${response.provenance.surface} on ${response.provenance.date}, you said: "${response.provenance.said}"`);
  } else if (response.handEdited) {
    lines.push('  no provenance recorded; you edited this line by hand.');
  } else {
    lines.push('  no provenance recorded.');
  }
  for (const record of response.superseded) {
    const parts = [
      record.value,
      record.provenance ? `via ${record.provenance.surface}` : '',
      record.provenance ? `on ${record.provenance.date}` : '',
      record.provenance ? `you said: "${record.provenance.said}"` : '',
      `superseded ${record.supersededOn}`,
    ].filter(Boolean);
    lines.push(`  was: ${parts.join(', ')}`);
  }
  return { output: jsonOrText(runtime, response, lines.join('\n')), exitCode: 0 };
}

async function handleGet(
  runtime: CliCommandRuntime,
  invoke: ProfileGatewayInvoke,
  args: readonly string[],
): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const fieldId = parsed.positionals[0];
  if (!fieldId) return usageFailure(runtime, GET_USAGE);
  const result = await invoke(PROFILE_METHOD_IDS.get, { fieldId });
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Profile field read failed.'), exitCode: 1 };
  const response = narrowProfileGet(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  if (!response.present || !response.field) {
    return {
      output: jsonOrText(runtime, response, `${response.fieldId} is not set in your profile.`),
      exitCode: 1,
    };
  }
  const field = response.field;
  const lines = [`${field.label}: ${field.value}`];
  if (!field.valid) lines.push(`  did not parse: ${field.invalidReason ?? 'no reason given'}, kept as written, treated as unset`);
  lines.push(field.provenance
    ? `  from ${field.provenance.surface} on ${field.provenance.date}, you said: "${field.provenance.said}"`
    : '  no provenance recorded; you wrote or edited this line by hand.');
  // Non-empty only for a closed-tier field: the daemon decides which reads need
  // a receipt, and this relays rather than judging.
  if (response.disclosure) lines.push(response.disclosure);
  return { output: jsonOrText(runtime, response, lines.join('\n')), exitCode: 0 };
}

async function handlePerson(
  runtime: CliCommandRuntime,
  invoke: ProfileGatewayInvoke,
  args: readonly string[],
): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['named-by']);
  const name = parsed.positionals.join(' ').trim();
  if (!name) return usageFailure(runtime, PERSON_USAGE);
  const result = await invoke(PROFILE_METHOD_IDS.person, { name });
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Person lookup failed.'), exitCode: 1 };
  const response = narrowProfilePerson(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  if (response.lines.length === 0) {
    return {
      output: jsonOrText(runtime, response, `No one called ${response.name} is recorded in your profile.`),
      exitCode: 1,
    };
  }
  const lines = [`${response.name}`];
  for (const line of response.lines) {
    const suffix = line.provenance
      ? `, from ${line.provenance.surface} on ${line.provenance.date}, you said: "${line.provenance.said}"`
      : '';
    lines.push(`  ${line.text}${suffix}`);
  }
  if (response.disclosure) lines.push(response.disclosure);
  return { output: jsonOrText(runtime, response, lines.join('\n')), exitCode: 0 };
}

async function handleSet(
  runtime: CliCommandRuntime,
  invoke: ProfileGatewayInvoke,
  args: readonly string[],
): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['said']);
  const fieldId = parsed.positionals[0];
  const value = parsed.positionals.slice(1).join(' ').trim();
  if (!fieldId || !value) return usageFailure(runtime, SET_USAGE);
  if (!parsed.yes) {
    return { output: `Refusing to write ${fieldId} without --yes.`, exitCode: 2 };
  }
  const said = operatorFlagValue(parsed, 'said') ?? CLI_EDIT_SAID;
  const result = await invoke(PROFILE_METHOD_IDS.set, {
    fieldId,
    value,
    surface: PROFILE_RECORDING_SURFACE,
    said,
    authority: 'owner-direct',
  });
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Profile write failed.'), exitCode: 1 };
  const response = narrowProfileWrite(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  if (!response.ok) {
    const text = [`Not done: ${fieldId} was not recorded.`, `  reason: ${response.reason ?? 'no reason given'}`].join('\n');
    return { output: jsonOrText(runtime, response, text), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, response, response.disclosure || `Noted, saved ${fieldId} to your profile.`),
    exitCode: 0,
  };
}

/**
 * A mechanical field goes by id; a prose line goes by its section and its exact
 * text, never by position (§9.2). He edits this file himself, so a line number
 * from an earlier read can point at a different line by the time the delete
 * runs, and a stale index is well-formed, so nothing could catch it. Content
 * re-resolves against the document as it is now.
 */
async function handleForget(
  runtime: CliCommandRuntime,
  invoke: ProfileGatewayInvoke,
  args: readonly string[],
): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['section', 'text']);
  const fieldId = parsed.positionals[0];
  const section = operatorFlagValue(parsed, 'section');
  const text = operatorFlagValue(parsed, 'text');
  if (!fieldId && !(section && text)) return usageFailure(runtime, FORGET_USAGE);
  const target = fieldId ?? `the line "${String(text)}" under ${String(section)}`;
  if (!parsed.yes) {
    return { output: `Refusing to forget ${target} without --yes.`, exitCode: 2 };
  }
  // Two plain literals, not one spread. A field written inline in a spread
  // literal is still checked; one carried in by the spread source's type is
  // not, and with no spread there is no source to carry one. The general case
  // is covered by the `assertOperatorBody` guard, not by this shape.
  const result = fieldId
    ? await invoke(PROFILE_METHOD_IDS.forget, { fieldId, authority: 'owner-direct' })
    : await invoke(PROFILE_METHOD_IDS.forget, { section, text, authority: 'owner-direct' });
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Profile delete failed.'), exitCode: 1 };
  const response = narrowProfileWrite(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  if (!response.ok) {
    // Covers refusal, "there was nothing to forget", and a prose line whose
    // text no longer matches because he changed it. None is ok, the daemon's
    // own reason says which, and this never claims a deletion.
    const failure = [`Not done: ${target} was not deleted.`, `  reason: ${response.reason ?? 'no reason given'}`].join('\n');
    return { output: jsonOrText(runtime, response, failure), exitCode: 1 };
  }
  return {
    output: jsonOrText(runtime, response, response.disclosure || `Deleted ${target} from your profile.`),
    exitCode: 0,
  };
}

async function handleStatus(runtime: CliCommandRuntime, invoke: ProfileGatewayInvoke): Promise<CliCommandOutput> {
  const result = await invoke(PROFILE_METHOD_IDS.status, {});
  if (!result.ok) return { output: jsonOrText(runtime, result, result.error ?? 'Profile status failed.'), exitCode: 1 };
  const response = narrowProfileStatus(result.data);
  if (!response) return { output: jsonOrText(runtime, result, PROFILE_RESPONSE_UNREADABLE), exitCode: 1 };
  const lines = [`Owner profile: ${response.kind}`];
  if (response.reason) lines.push(`  ${response.reason}`);
  lines.push(`  path ${response.path}`);
  if (response.exists === false) lines.push('  the file does not exist yet');
  if (response.sections && response.sections.length > 0) lines.push(`  sections ${response.sections.join(', ')}`);
  if (response.lineCount !== undefined) lines.push(`  lines ${response.lineCount}`);
  if (response.fieldCount !== undefined) lines.push(`  fields ${response.fieldCount}`);
  if (response.proseLineCount !== undefined) lines.push(`  prose lines ${response.proseLineCount}`);
  const invalid = response.invalidFields ?? [];
  if (invalid.length === 0) {
    lines.push('  no invalid fields');
  } else {
    for (const entry of invalid) lines.push(`  invalid ${entry.fieldId}: ${entry.reason}`);
  }
  return { output: jsonOrText(runtime, response, lines.join('\n')), exitCode: response.kind === 'loaded' ? 0 : 1 };
}

export interface OwnerProfileCommandOptions {
  /**
   * Whether this command's output will land somewhere a model can read it.
   *
   * True for the `/owner-profile` slash command and the workspace card, whose
   * output goes into the session transcript. False for the top-level CLI, whose
   * output goes to his terminal and nowhere else.
   *
   * **Defaults to true**, a caller that has not thought about it gets the
   * containment rather than the exposure. Every caller can answer this
   * truthfully about itself; it is not a claim anyone has to guess at.
   */
  readonly outputEntersModelContext?: boolean;
  /**
   * The gateway route. Defaults to the connected host, and is injectable so the
   * command's honesty rules, a refusal printed with its reason, a delete that
   * was a no-op reported as a no-op, are testable without a live daemon.
   */
  readonly invoke?: ProfileGatewayInvoke;
}

export async function handleOwnerProfileCommand(
  runtime: CliCommandRuntime,
  options: OwnerProfileCommandOptions = {},
): Promise<CliCommandOutput> {
  const invoke = options.invoke ?? gatewayFor(runtime);
  const outputEntersModelContext = options.outputEntersModelContext ?? true;
  const [sub = 'read', ...rest] = runtime.cli.commandArgs;
  switch (sub.toLowerCase()) {
    case 'read':
    case 'show':
    case 'list':
      return handleRead(runtime, invoke, outputEntersModelContext);
    case 'get':
    case 'field':
      return handleGet(runtime, invoke, rest);
    case 'person':
      return handlePerson(runtime, invoke, rest);
    case 'provenance':
    case 'source':
    case 'where':
      return handleProvenance(runtime, invoke, rest);
    case 'set':
      return handleSet(runtime, invoke, rest);
    case 'forget':
    case 'delete':
    case 'remove':
      return handleForget(runtime, invoke, rest);
    case 'status':
      return handleStatus(runtime, invoke);
    default:
      return usageFailure(runtime, OWNER_PROFILE_USAGE);
  }
}
