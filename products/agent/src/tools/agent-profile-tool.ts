/**
 * agent-profile-tool.ts, the `profile` tool: what the platform knows about the
 * owner, read and recorded from ordinary conversation.
 *
 * Design: docs/owner-profile.md. Three parts of it are load-bearing here.
 *
 * §7, untrusted sources stay barred. The daemon enforces that, and this tool
 * neither weakens nor re-implements it. Every write carries an `authority`
 * naming where the fact came from, and the tool forwards it unchanged: a fact
 * out of an email body, a web page, a channel message from anyone but him, or a
 * document carries THAT surface, the daemon refuses the write, and the refusal
 * and its reason are handed back for him to see. There is no retry with a
 * different authority anywhere in this file, and no path that turns a refusal
 * into a success.
 *
 * The daemon now REQUIRES `authority` on every write verb: an absent one is a
 * 400 INVALID_ARGUMENT, not a silent fallback to `owner-direct`. `forget` and
 * `undo` are why, §7 gives them an authority check and nothing else (no
 * derivation check, no verbatim quote, because a deletion has neither a value
 * to compare nor an utterance to quote), so an omitted authority on a delete
 * meant no gate at all: a caller sending no authority could delete the owner's
 * shipping address. This tool still requires the caller to state one, because
 * the caller here is a model that knows where the fact came from and the
 * daemon cannot. Leaving it out would make an untrusted-sourced write look
 * exactly like a spoken one to the layer that has the answer.
 *
 * §8.2, it tells him what it recorded. The daemon returns a one-line
 * disclosure; every write result carries it forward as the line to say, naming
 * the field and never quoting the value back.
 *
 * §10, §11.3, third-party personal data. No profile value is ever logged from
 * this file. `read` is the "what do you know about me?" answer and deliberately
 * does NOT list the People section: the platform runtime's own descriptor calls
 * `profile.read` "the ONE read that returns closed-tier content in bulk, which
 * is why it is never callable from a message-composition path", and a model
 * turn can compose an outbound message. People stay reachable one at a time
 * through `person`, by a name he used in this turn's instruction, and every
 * such read is disclosed.
 */

import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PROFILE_FIELDS, PROSE_ONLY_SECTIONS } from '@goodvibes-jev/engine/sdk/platform/owner-profile';
import type { ProfileGatewayInvoke } from '../agent/owner-profile-gateway.ts';
import {
  isProfileAuthority,
  narrowProfileGet,
  narrowProfilePerson,
  narrowProfileProvenance,
  narrowProfileRead,
  narrowProfileStatus,
  narrowProfileWrite,
  normalizeProfileAction,
  PROFILE_ACTIONS,
  PROFILE_AUTHORITIES,
  PROFILE_METHOD_IDS,
  PROFILE_RECORDING_SURFACE,
  PROFILE_RESPONSE_UNREADABLE,
  type ProfileAuthority,
  type ProfileFieldResponse,
  type ProfileLineResponse,
} from './agent-profile-types.ts';

/**
 * The section whose lines are about people other than him. Held back from
 * `read` (§10) and reachable only through `person`.
 */
const PEOPLE_SECTION = 'people';

/**
 * The declared `fieldId` values, taken from the SDK's field registry at module
 * load rather than written out here.
 *
 * `fieldId` used to be a free-form string with two ids as examples, and the
 * model filled it with the names a person would use: `full_name`,
 * `preferred_name`, `home_address`, `timezone`, `wife`. Every one was refused by
 * the daemon, correctly, since none of them is a field, and the facts he had
 * just given ended up as prose instead of records. The parameter now carries the
 * whole catalog as an `enum`, so the ids are in front of the model at the moment
 * it fills the argument in.
 *
 * Sourced from {@link PROFILE_FIELDS}, never copied: a hand-written list is one
 * SDK release away from declaring a field that no longer exists or omitting one
 * that does, and either way the declaration would be a claim about the daemon
 * that the daemon does not honour. A test pins this to the registry.
 */
const PROFILE_FIELD_IDS: readonly string[] = PROFILE_FIELDS.map((field) => field.id);

/**
 * The ids grouped under their section headings, e.g.
 * `Identity: identity.name (name), identity.goesBy (goes by)`.
 *
 * The enum alone says which ids exist; it does not say which one holds the fact
 * in hand. Grouping them by the section they live in, each next to the label
 * written in the file, is what lets "where he lives" reach `location.city`
 * rather than a guess.
 */
function describeProfileFieldCatalog(): string {
  const bySection = new Map<string, string[]>();
  for (const field of PROFILE_FIELDS) {
    const entries = bySection.get(field.section) ?? [];
    entries.push(`${field.id} (${field.label})`);
    bySection.set(field.section, entries);
  }
  return Array.from(bySection, ([section, ids]) => `${section}: ${ids.join(', ')}`).join('. ');
}

/** The sections that hold prose lines rather than keyed fields, in file order. */
const PROSE_SECTION_LIST = PROSE_ONLY_SECTIONS.join(', ');

type ToolOutcome = { readonly success: boolean; readonly output: string };

interface AgentProfileToolDeps {
  readonly invoke: ProfileGatewayInvoke;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(lines: readonly string[]): ToolOutcome {
  return { success: false, output: lines.filter(Boolean).join('\n') };
}

function ok(lines: readonly string[]): ToolOutcome {
  return { success: true, output: lines.filter(Boolean).join('\n') };
}

function renderProseLine(line: ProfileLineResponse): string {
  const suffix = line.provenance ? `  [recorded via ${line.provenance.surface} on ${line.provenance.date}]` : '';
  return `  ${line.text}${suffix}`;
}

function renderField(field: ProfileFieldResponse): string {
  const suffix = field.provenance ? `  [recorded via ${field.provenance.surface} on ${field.provenance.date}]` : '';
  const invalid = field.valid ? '' : `  [did not parse: ${field.invalidReason ?? 'no reason given'}; treat as unset]`;
  return `  ${field.fieldId}: ${field.value}${invalid}${suffix}`;
}

// ── Reads ──────────────────────────────────────────────────────────────────

async function handleRead(deps: AgentProfileToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(PROFILE_METHOD_IDS.read, {});
  if (!result.ok) return fail(['Could not read your profile.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileRead(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (response.state.kind === 'unavailable') {
    return fail([
      'Your profile could not be read.',
      `  ${response.state.reason ?? 'no reason given'}`,
      `  ${response.state.path}`,
      'This is not an empty profile, say that it could not be read, and why.',
    ]);
  }
  if (response.state.kind === 'disabled') {
    return fail([`Your profile is turned off (${response.state.path}). Nothing is recorded or read while it is off.`]);
  }
  if (response.state.exists === false) {
    return ok([
      `Your profile file does not exist yet (${response.state.path}).`,
      'Nothing has been recorded about you. This is an honest empty, not a read failure.',
    ]);
  }

  const lines: string[] = ['Your profile:'];
  for (const section of response.sections) {
    lines.push(`## ${section.heading}`);
    // §10: the People section is third-party personal data. Counted here, never
    // listed, a turn holding every person's details is one injected
    // instruction away from putting them in an outbound message.
    if (section.heading.trim().toLowerCase() === PEOPLE_SECTION) {
      const count = section.prose.length + section.fields.length;
      lines.push(`  ${count} ${count === 1 ? 'person' : 'people'} recorded. Not listed here.`);
      lines.push('  Look one up with action:"person" only when he named that person in this turn.');
      continue;
    }
    if (section.fields.length === 0 && section.prose.length === 0) lines.push('  (nothing recorded)');
    for (const field of section.fields) lines.push(renderField(field));
    for (const line of section.prose) lines.push(renderProseLine(line));
  }
  lines.push('Ask with action:"provenance" to answer "where did you get that".');
  return ok(lines);
}

async function handleGet(deps: AgentProfileToolDeps, fieldId: string): Promise<ToolOutcome> {
  if (!fieldId) return fail(['`fieldId` is required, e.g. fieldId:"location.timezone".']);
  const result = await deps.invoke(PROFILE_METHOD_IDS.get, { fieldId });
  if (!result.ok) return fail([`Could not read ${fieldId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileGet(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (!response.present || !response.field) return ok([`${response.fieldId} is not set in your profile.`]);
  const field = response.field;
  const lines = [`${field.fieldId}: ${field.value}`];
  if (!field.valid) {
    lines.push(`  This value did not parse: ${field.invalidReason ?? 'no reason given'}.`);
    lines.push('  It is kept exactly as written; treat the field as unset and fall back.');
  }
  lines.push(field.provenance
    ? `  recorded via ${field.provenance.surface} on ${field.provenance.date}`
    : '  no provenance recorded; he wrote or edited this line by hand.');
  // Non-empty only for a closed-tier field, the daemon decides which reads
  // need a receipt, so the tool relays rather than judging.
  if (response.disclosure) lines.push(`Say this in your reply: ${response.disclosure}`);
  return ok(lines);
}

async function handlePerson(
  deps: AgentProfileToolDeps,
  name: string,
  namedInInstruction: string,
): Promise<ToolOutcome> {
  if (!name) return fail(['`name` is required. There is no call that lists everyone.']);
  if (!namedInInstruction) {
    // §10 makes this structural rather than a judgement call: a People line
    // reaches a turn only because HE pointed at that person in this turn's
    // instruction. "Email the vendor and cc anyone relevant" names nobody and
    // must reach nothing.
    return fail([
      '`namedInInstruction` is required: his words in this turn that pointed at this person.',
      'If he did not name or refer to anyone this turn, do not look anyone up.',
    ]);
  }
  const result = await deps.invoke(PROFILE_METHOD_IDS.person, { name });
  if (!result.ok) return fail([`Could not look up ${name}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfilePerson(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (response.lines.length === 0) return ok([`No one called ${response.name} is recorded in your profile.`]);
  return ok([
    `${response.name}:`,
    ...response.lines.map(renderProseLine),
    response.disclosure ? `Say this in your reply: ${response.disclosure}` : '',
    'Use these details only for what he asked for this turn; do not carry them into anything else.',
  ]);
}

async function handleProvenance(deps: AgentProfileToolDeps, fieldId: string): Promise<ToolOutcome> {
  if (!fieldId) return fail(['`fieldId` is required, e.g. fieldId:"commerce.shippingAddress".']);
  const result = await deps.invoke(PROFILE_METHOD_IDS.provenance, { fieldId });
  if (!result.ok) return fail([`Could not read provenance for ${fieldId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileProvenance(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (!response.present) return ok([`${response.fieldId} is not in your profile, so there is nothing to trace.`]);
  const lines = [`${response.fieldId}:`];
  if (response.provenance) {
    lines.push(`  from ${response.provenance.surface} on ${response.provenance.date}`);
    lines.push(`  you said: "${response.provenance.said}"`);
  } else if (response.handEdited) {
    lines.push('  no provenance recorded; you edited this line by hand.');
  } else {
    lines.push('  no provenance recorded.');
  }
  if (response.superseded.length > 0) {
    lines.push(`  ${response.superseded.length} earlier value(s) kept:`);
    for (const record of response.superseded) {
      const parts = [
        record.value,
        record.provenance ? `via ${record.provenance.surface}` : '',
        record.provenance ? `on ${record.provenance.date}` : '',
        record.provenance ? `you said: "${record.provenance.said}"` : '',
        `superseded ${record.supersededOn}`,
      ].filter(Boolean);
      lines.push(`    - ${parts.join(', ')}`);
    }
    lines.push('  action:"undo" puts the most recent one back.');
  }
  return ok(lines);
}

async function handleStatus(deps: AgentProfileToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(PROFILE_METHOD_IDS.status, {});
  if (!result.ok) return fail(['Could not read profile status.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileStatus(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  const lines = [`Profile: ${response.kind}`];
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
    lines.push(`  ${invalid.length} field(s) did not parse and are kept as written:`);
    for (const entry of invalid) lines.push(`    - ${entry.fieldId}: ${entry.reason}`);
  }
  return ok(lines);
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * `ok: false` is the daemon's one answer for every way a write did not happen,
 * the authority gate, the derivation check, the missing verbatim quote, a
 * profile that is off, and a field that was not there to delete. It is
 * deliberately not distinguished by parsing the reason: the platform runtime's
 * own note says the wire answer must not depend on wording the trust module is
 * free to reword. So the reason is passed through untouched, the outcome is a
 * failure either way, and nothing here softens it, retries it, or reports it as
 * partly done.
 */
function notDoneOutcome(what: string, reason: string | null | undefined, authority: ProfileAuthority): ToolOutcome {
  return fail([
    `Not done: ${what}.`,
    `  reason: ${reason ?? 'no reason given'}`,
    `  authority sent: ${authority}`,
    'Tell him this happened and why, in the daemon\'s own words above.',
    'Never retry with a different authority, and never report this as done.',
  ]);
}

function requireAuthority(value: unknown): { readonly authority: ProfileAuthority } | ToolOutcome {
  const raw = readString(value);
  if (!raw) {
    return fail([
      '`authority` is required on every profile write: where this fact came from.',
      `  one of: ${PROFILE_AUTHORITIES.join(', ')}`,
      '  Use "owner-direct" only when he said it himself, to you, in this turn.',
      '  A fact out of a message, a page, or a document carries that surface and will be refused.',
    ]);
  }
  if (!isProfileAuthority(raw)) {
    return fail([`\`authority\` "${raw}" is not a source this platform knows.`, `  one of: ${PROFILE_AUTHORITIES.join(', ')}`]);
  }
  return { authority: raw };
}

function isOutcome(value: { readonly authority: ProfileAuthority } | ToolOutcome): value is ToolOutcome {
  return 'output' in value;
}

function disclosureOutcome(disclosure: string, fallbackLine: string): ToolOutcome {
  return ok([
    `Say this in your reply: ${disclosure || fallbackLine}`,
    'One line, and do not quote the value back unless he asks for it.',
  ]);
}

async function handleSet(
  deps: AgentProfileToolDeps,
  fieldId: string,
  value: string,
  authority: ProfileAuthority,
  said: string,
): Promise<ToolOutcome> {
  if (!fieldId) return fail(['`fieldId` is required, e.g. fieldId:"commerce.shippingAddress".']);
  if (!value) return fail(['`value` is required.']);
  const result = await deps.invoke(PROFILE_METHOD_IDS.set, {
    fieldId,
    value,
    surface: PROFILE_RECORDING_SURFACE,
    said,
    authority,
  });
  if (!result.ok) return fail([`Could not record ${fieldId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileWrite(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (!response.ok) return notDoneOutcome(`${fieldId} was not recorded`, response.reason, authority);
  return disclosureOutcome(response.disclosure, `Noted, saved ${fieldId} to your profile.`);
}

async function handleAppend(
  deps: AgentProfileToolDeps,
  section: string,
  text: string,
  authority: ProfileAuthority,
  said: string,
): Promise<ToolOutcome> {
  if (!section) return fail([`\`section\` is required, one of: ${PROSE_SECTION_LIST}.`]);
  if (!text) return fail(['`text` is required: the note to add, in plain words.']);
  const result = await deps.invoke(PROFILE_METHOD_IDS.append, {
    section,
    text,
    surface: PROFILE_RECORDING_SURFACE,
    said,
    authority,
  });
  if (!result.ok) return fail([`Could not add to ${section}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileWrite(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (!response.ok) return notDoneOutcome(`the note under ${section} was not added`, response.reason, authority);
  return disclosureOutcome(response.disclosure, `Noted, added a line to ${section} in your profile.`);
}

/**
 * A prose line is named by its CONTENT, never by its position (§9.2).
 *
 * He edits this file himself while a turn is running, so an index taken from a
 * read is only valid against the exact document that produced it. Insert one
 * line above and every index below shifts: a positional delete then removes a
 * different line and reports success, which is the false receipt §9.2 exists to
 * prevent. That case is not malformed input, the index is perfectly well
 * formed, just for a file that no longer exists, so no validation could catch
 * it. Addressing by section and exact text re-resolves against the document as
 * it is now, and finds nothing when the line is gone.
 */
async function handleForget(
  deps: AgentProfileToolDeps,
  fieldId: string,
  section: string,
  text: string,
  authority: ProfileAuthority,
): Promise<ToolOutcome> {
  if (!fieldId && !(section && text)) {
    return fail([
      'Say what to forget: either `fieldId` for a mechanical field, or `section` plus the exact `text` of the line.',
      '  A note, a person, a place or a work line is addressed by its text, not by its position;',
      '  he edits this file himself, so a line number from an earlier read may point at a different line now.',
      '  Read the profile first and pass the line back in his words. A list marker is not part of the line.',
      '  The match is on the whole line, so a paraphrase or a partial line finds nothing.',
    ]);
  }
  const target = fieldId || `the line "${text}" under ${section}`;
  // Two plain literals rather than one assembled from spreads. Not because a
  // spread literal is unchecked, what is written inline in one still is, but
  // because a field carried IN by a spread source's type is not, and having no
  // spread here means there is no source to carry one. Two lines to remove the
  // vector entirely at the site that had it.
  //
  // The general case is not closed by writing it this way: see the measured
  // table on `assertOperatorBody` in
  // src/test/agent/operator-payload-conformance.test.ts. That guard is what
  // catches a spread-carried or variable-built body, and it is load-bearing.
  const result = fieldId
    ? await deps.invoke(PROFILE_METHOD_IDS.forget, { fieldId, authority })
    : await deps.invoke(PROFILE_METHOD_IDS.forget, { section, text, authority });
  if (!result.ok) return fail([`Could not forget ${target}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileWrite(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  // A field that was not there answers ok:false with its own reason, exactly
  // like a refusal does. Both are failures here, reporting "forgotten" for
  // something that was never recorded is the dishonesty delete-means-delete
  // exists to remove.
  if (!response.ok) return notDoneOutcome(`${target} was not deleted`, response.reason, authority);
  return ok([
    `Say this in your reply: ${response.disclosure || `Forgotten: removed ${target} from your profile.`}`,
    'The line and its kept history are gone from the file.',
  ]);
}

async function handleUndo(
  deps: AgentProfileToolDeps,
  fieldId: string,
  authority: ProfileAuthority,
): Promise<ToolOutcome> {
  if (!fieldId) return fail(['`fieldId` is required: which field to put back.']);
  const result = await deps.invoke(PROFILE_METHOD_IDS.undo, { fieldId, authority });
  if (!result.ok) return fail([`Could not undo ${fieldId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowProfileWrite(result.data);
  if (!response) return fail([PROFILE_RESPONSE_UNREADABLE]);
  if (!response.ok) return notDoneOutcome(`${fieldId} was not restored`, response.reason, authority);
  return ok([`Say this in your reply: ${response.disclosure || `Put back the previous ${fieldId} in your profile.`}`]);
}

// ── Tool ───────────────────────────────────────────────────────────────────

export function createAgentProfileTool(deps: AgentProfileToolDeps): Tool {
  return {
    definition: {
      name: 'profile',
      description: 'Read and record what GoodVibes knows about the owner.'
        + ' Two kinds of content, and which one it is decides the action.'
        + ' A MECHANICAL FIELD holds one keyed fact: action:"set" with a'
        + ' fieldId from the list on that parameter, and nothing else is a field.'
        + ' A PROSE SECTION holds lines in his own words: action:"append" with'
        + ` section and text. The prose sections are ${PROSE_SECTION_LIST}.`
        + ' No field id exists for a relationship, a person, or a birthday, and'
        + ' that is by design: people belong in People prose, dates in'
        + ' Important dates prose, which is where occasions reads them.'
        + ' An invented fieldId is refused; append the fact instead.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...PROFILE_ACTIONS],
            description: 'read/get/person/provenance look up; set/append record; forget/undo fix.',
          },
          fieldId: {
            type: 'string',
            enum: [...PROFILE_FIELD_IDS],
            description: `The mechanical field, by id. ${describeProfileFieldCatalog()}.`
              + ' Nothing outside this list is a field; anything else is prose, via action:"append".',
          },
          value: { type: 'string', description: 'The value to record for `fieldId`.' },
          section: { type: 'string', description: `A prose section: ${PROSE_SECTION_LIST}. For append and for forget.` },
          text: { type: 'string', description: 'The note to append, or the line to forget, without its list marker.' },
          // No lineIndex: a prose line is named by its content. See handleForget.

          name: { type: 'string', description: 'One person, by a name he used this turn. There is no list-everyone call.' },
          namedInInstruction: { type: 'string', description: 'His words this turn that pointed at that person. Required for person.' },
          authority: {
            type: 'string',
            enum: [...PROFILE_AUTHORITIES],
            description: 'Where the fact came from. owner-direct only if he said it this turn.',
          },
          said: { type: 'string', description: 'His verbatim words for this fact. Required on set/append.' },
        },
        additionalProperties: false,
      },
      // The file itself is the daemon's to write; from here the effect is a
      // control-plane call that changes durable state.
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {}) as Record<string, unknown>;
      const action = normalizeProfileAction(args.action) ?? normalizeProfileAction(args.mode);
      if (!action) {
        return fail([`\`action\` is required: ${PROFILE_ACTIONS.join(', ')}.`]);
      }
      const fieldId = readString(args.fieldId) || readString(args.field);

      switch (action) {
        case 'read':
          return handleRead(deps);
        case 'get':
          return handleGet(deps, fieldId);
        case 'person':
          return handlePerson(deps, readString(args.name), readString(args.namedInInstruction));
        case 'provenance':
          return handleProvenance(deps, fieldId);
        case 'status':
          return handleStatus(deps);
        default:
          break;
      }

      const authority = requireAuthority(args.authority);
      if (isOutcome(authority)) return authority;
      const said = readString(args.said);

      if (action === 'set') {
        return handleSet(deps, fieldId, readString(args.value), authority.authority, said);
      }
      if (action === 'append') {
        return handleAppend(deps, readString(args.section), readString(args.text), authority.authority, said);
      }
      if (action === 'forget') {
        return handleForget(deps, fieldId, readString(args.section), readString(args.text), authority.authority);
      }
      return handleUndo(deps, fieldId, authority.authority);
    },
  };
}

export interface RegisterAgentProfileToolOptions {
  readonly invoke: ProfileGatewayInvoke;
}

export function registerAgentProfileTool(
  registry: ToolRegistry,
  options: RegisterAgentProfileToolOptions,
): void {
  if (!registry.has('profile')) registry.register(createAgentProfileTool({ invoke: options.invoke }));
}
