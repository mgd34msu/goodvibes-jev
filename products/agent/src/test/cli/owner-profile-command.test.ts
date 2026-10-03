/**
 * The `owner-profile` CLI command. Same honesty rules as the tool: a write that
 * did not happen prints the daemon's reason and exits non-zero, and a `forget`
 * for a field that was not there is one of those cases, never a reported
 * deletion (docs/owner-profile.md §9.2).
 *
 * The gateway is injected, with the platform runtime's real payload shapes.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleOwnerProfileCommand } from '../../cli/owner-profile-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { ProfileGatewayInvoke, ProfileGatewayResult } from '../../agent/owner-profile-gateway.ts';
import type { ProfileMethodId } from '../../tools/agent-profile-types.ts';

const roots: string[] = [];

function runtime(argv: readonly string[], withToken = true) {
  const root = makeProjectTempDir('gv-agent-owner-profile-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  if (withToken) {
    writeFileSync(
      join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'),
      JSON.stringify({ token: 'owner-profile-cli-token' }),
    );
  }
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli(['owner-profile', ...argv]),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

type Call = { methodId: ProfileMethodId; body: Record<string, unknown> };

function stubInvoke(
  respond: (methodId: ProfileMethodId, body: Record<string, unknown>) => unknown,
  calls: Call[] = [],
): ProfileGatewayInvoke {
  return async (methodId, body): Promise<ProfileGatewayResult> => {
    calls.push({ methodId, body });
    return { ok: true, data: respond(methodId, body), route: 'connected-host' };
  };
}

function refused(reason: string): Record<string, unknown> {
  return { ok: false, reason, changes: [], disclosure: '' };
}

function wrote(disclosure: string): Record<string, unknown> {
  return { ok: true, reason: null, changes: [], disclosure };
}

/** A loaded profile with two People lines, for the containment-predicate tests. */
function peopleProfile(): Record<string, unknown> {
  return {
    state: {
      kind: 'loaded',
      path: '/home/owner/.goodvibes/daemon/owner-profile.md',
      exists: true,
      lineCount: 12,
      fieldCount: 1,
      proseLineCount: 2,
      sections: ['Identity', 'People'],
      invalidFields: [],
    },
    sections: [
      { heading: 'Identity', tier: 'open', fields: [{ fieldId: 'identity.goesBy', label: 'goes by', value: 'Mike', valid: true }], prose: [] },
      {
        heading: 'People',
        tier: 'closed',
        fields: [],
        prose: [
          { lineIndex: 8, section: 'People', text: 'Sarah, sister, sarah@example.com' },
          { lineIndex: 9, section: 'People', text: 'Dave from work, handles the contracts' },
        ],
      },
    ],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owner-profile CLI command', () => {
  test('parses as its own command rather than the Agent profile homes command', () => {
    expect(parseGoodVibesCli(['owner-profile', 'read']).command).toBe('owner-profile');
    // `profile` still means the isolated Agent profile homes; nothing about it changed.
    expect(parseGoodVibesCli(['profile', 'list']).command).toBe('profiles');
  });

  test('forget for a field that was not there prints the reason and never reports a deletion', async () => {
    const calls: Call[] = [];
    const result = await handleOwnerProfileCommand(
      runtime(['forget', 'contact.phone', '--yes']),
      { invoke: stubInvoke(() => refused('Your profile has no phone recorded, so there was nothing to forget.'), calls) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Not done: contact.phone was not deleted.');
    expect(result.output).toContain('there was nothing to forget');
    expect(result.output).not.toContain('Deleted contact.phone');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.methodId).toBe('profile.forget');
  });

  test('an actual deletion exits zero and names what went', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['forget', 'contact.phone', '--yes']),
      { invoke: stubInvoke(() => wrote('Deleted contact.phone from your profile.')) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Deleted contact.phone from your profile.');
  });

  test('a refused write prints the reason and exits non-zero', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['set', 'contact.email', 'someone@example.com', '--yes']),
      { invoke: stubInvoke(() => refused('That text overlaps content read this turn from web-page example.com.')) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Not done: contact.email was not recorded.');
    expect(result.output).toContain('overlaps content read this turn');
  });

  test('a write carries owner-direct authority, the agent surface, and a stand-in for his words', async () => {
    const calls: Call[] = [];
    await handleOwnerProfileCommand(
      runtime(['set', 'location.timezone', 'America/Detroit', '--yes']),
      { invoke: stubInvoke(() => wrote('Noted.'), calls) },
    );

    expect(calls[0]?.body.authority).toBe('owner-direct');
    expect(calls[0]?.body.surface).toBe('agent');
    expect(calls[0]?.body.said).toBe('(edited from the command line)');
    expect(calls[0]?.body.value).toBe('America/Detroit');
  });

  test('--said records his own words instead of the stand-in', async () => {
    const calls: Call[] = [];
    await handleOwnerProfileCommand(
      runtime(['set', 'commerce.shippingAddress', '200 Office Way', '--said', 'ship it to my office instead', '--yes']),
      { invoke: stubInvoke(() => wrote('Noted.'), calls) },
    );

    expect(calls[0]?.body.said).toBe('ship it to my office instead');
    expect(calls[0]?.body.value).toBe('200 Office Way');
  });

  test('set and forget refuse without --yes and never reach the daemon', async () => {
    const calls: Call[] = [];
    const invoke = stubInvoke(() => wrote('Noted.'), calls);

    const set = await handleOwnerProfileCommand(runtime(['set', 'contact.phone', '555']), { invoke });
    expect(set.exitCode).toBe(2);
    expect(set.output).toContain('without --yes');

    const forget = await handleOwnerProfileCommand(runtime(['forget', 'contact.phone']), { invoke });
    expect(forget.exitCode).toBe(2);
    expect(forget.output).toContain('without --yes');

    expect(calls).toHaveLength(0);
  });

  test('provenance without a field prints usage', async () => {
    const result = await handleOwnerProfileCommand(runtime(['provenance']), { invoke: stubInvoke(() => ({})) });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('owner-profile provenance <fieldId>');
  });

  test('provenance prints the suffix and every superseded predecessor', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['provenance', 'commerce.shippingAddress']),
      { invoke: stubInvoke(() => ({
        fieldId: 'commerce.shippingAddress',
        present: true,
        handEdited: false,
        provenance: { surface: 'agent', date: '2026-07-27', said: 'ship it to my office instead' },
        superseded: [{
          lineIndex: 14,
          fieldId: 'commerce.shippingAddress',
          section: 'Commerce',
          text: 'shipping address: 401 Home St',
          value: '401 Home St',
          supersededOn: '2026-07-27',
          previousLine: 'shipping address: 401 Home St, from tui on 2026-07-20, you said: "ship to 401 Home St"',
          provenance: { surface: 'tui', date: '2026-07-20', said: 'ship to 401 Home St' },
        }],
      })) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('from agent on 2026-07-27, you said: "ship it to my office instead"');
    expect(result.output).toContain('was: 401 Home St, via tui, on 2026-07-20');
    expect(result.output).toContain('superseded 2026-07-27');
  });

  test('a hand-edited line reports no provenance rather than inventing a source', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['provenance', 'identity.name']),
      { invoke: stubInvoke(() => ({ fieldId: 'identity.name', present: true, handEdited: true, superseded: [] })) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('you edited this line by hand');
  });

  test('read prints the document by section, with provenance on learned lines', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['read']),
      { invoke: stubInvoke(() => ({
        state: {
          kind: 'loaded',
          path: '/home/owner/.goodvibes/daemon/owner-profile.md',
          exists: true,
          lineCount: 10,
          fieldCount: 1,
          proseLineCount: 1,
          sections: ['Identity', 'Places'],
          invalidFields: [],
        },
        sections: [
          {
            heading: 'Identity',
            tier: 'open',
            fields: [{ fieldId: 'identity.goesBy', label: 'goes by', value: 'Mike', valid: true }],
            prose: [],
          },
          {
            heading: 'Places',
            tier: 'closed',
            fields: [],
            prose: [{
              lineIndex: 20,
              section: 'Places',
              text: 'Gym: the Y on Michigan Ave',
              provenance: { surface: 'agent', date: '2026-07-27', said: 'I go to the Y on Michigan Ave' },
            }],
          },
        ],
      })) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('## Identity');
    expect(result.output).toContain('goes by: Mike');
    expect(result.output).toContain('Gym: the Y on Michigan Ave, from agent on 2026-07-27, you said: "I go to the Y on Michigan Ave"');
  });

  test('an unreadable profile exits non-zero with the reason, never an empty document', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['read']),
      { invoke: stubInvoke(() => ({
        state: { kind: 'unavailable', path: '/x/owner-profile.md', reason: 'permission denied' },
        sections: [],
      })) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('could not be read: permission denied');
  });

  test('status prints load state, counts and invalid fields, and no values', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['status']),
      { invoke: stubInvoke(() => ({
        kind: 'loaded',
        path: '/home/owner/.goodvibes/daemon/owner-profile.md',
        exists: true,
        sections: ['Identity', 'Location'],
        lineCount: 24,
        fieldCount: 9,
        proseLineCount: 6,
        invalidFields: [{ fieldId: 'location.timezone', reason: 'not an IANA zone' }],
      })) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Owner profile: loaded');
    expect(result.output).toContain('fields 9');
    expect(result.output).toContain('invalid location.timezone: not an IANA zone');
  });

  test('read counts the People section when the output reaches a model', async () => {
    // This output lands in the Agent transcript when the command runs as
    // `/owner-profile` and in the workspace card, both of which a later turn
    // can compose from, so the rule the tool applies applies here too (§10).
    const result = await handleOwnerProfileCommand(
      runtime(['read']),
      { invoke: stubInvoke(() => ({
        state: {
          kind: 'loaded',
          path: '/home/owner/.goodvibes/daemon/owner-profile.md',
          exists: true,
          lineCount: 12,
          fieldCount: 1,
          proseLineCount: 2,
          sections: ['Identity', 'People'],
          invalidFields: [],
        },
        sections: [
          { heading: 'Identity', tier: 'open', fields: [{ fieldId: 'identity.goesBy', label: 'goes by', value: 'Mike', valid: true }], prose: [] },
          {
            heading: 'People',
            tier: 'closed',
            fields: [],
            prose: [
              { lineIndex: 8, section: 'People', text: 'Sarah, sister, sarah@example.com' },
              { lineIndex: 9, section: 'People', text: 'Dave from work, handles the contracts' },
            ],
          },
        ],
      })) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('goes by: Mike');
    expect(result.output).toContain('2 people recorded; not listed here.');
    expect(result.output).not.toContain('sarah@example.com');
    expect(result.output).not.toContain('Dave from work');
  });

  test('read lists the People section at a shell, where no model sees it', async () => {
    // His own file, printed to his own terminal. Withholding his list here
    // would be friction with nothing gained, the containment exists to keep
    // third-party details out of a transcript a later turn composes from, and
    // there is no transcript.
    const result = await handleOwnerProfileCommand(
      runtime(['read']),
      { outputEntersModelContext: false, invoke: stubInvoke(() => peopleProfile()) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('sarah@example.com');
    expect(result.output).toContain('Dave from work');
    expect(result.output).not.toContain('not listed here');
  });

  test('a caller that does not say gets the containment, not the exposure', async () => {
    // The default is the safe answer: a new call site that never thought about
    // whether its output reaches a model counts rather than lists.
    const result = await handleOwnerProfileCommand(
      runtime(['read']),
      { invoke: stubInvoke(() => peopleProfile()) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('2 people recorded; not listed here.');
    expect(result.output).not.toContain('sarah@example.com');
  });

  test('person prints one person by name, with the disclosure the daemon supplied', async () => {
    const calls: Call[] = [];
    const result = await handleOwnerProfileCommand(
      runtime(['person', 'Sarah', '--named-by', 'email my sister the tickets']),
      { invoke: stubInvoke(() => ({
        name: 'Sarah',
        lines: [{ lineIndex: 8, section: 'People', text: 'Sarah, sister, sarah@example.com' }],
        disclosure: "Used Sarah's details from your profile.",
      }), calls) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('sarah@example.com');
    expect(result.output).toContain("Used Sarah's details from your profile.");
    // The verb takes a name and nothing else, --named-by is a gate at this
    // surface, not a parameter invented for the daemon.
    expect(calls[0]?.body).toEqual({ name: 'Sarah' });
  });

  test('a person who is not recorded exits non-zero and claims no receipt', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['person', 'Nobody', '--named-by', 'send it to Nobody']),
      { invoke: stubInvoke(() => ({ name: 'Nobody', lines: [], disclosure: '' })) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No one called Nobody is recorded in your profile.');
    expect(result.output).not.toContain('Used Nobody');
  });

  test('get prints one field with provenance, and an unset one says so', async () => {
    const present = await handleOwnerProfileCommand(
      runtime(['get', 'location.timezone']),
      { invoke: stubInvoke(() => ({
        fieldId: 'location.timezone',
        present: true,
        field: {
          fieldId: 'location.timezone',
          label: 'timezone',
          value: 'America/Detroit',
          valid: true,
          provenance: { surface: 'agent', date: '2026-07-27', said: 'I am in Detroit time' },
        },
        disclosure: '',
      })) },
    );
    expect(present.exitCode).toBe(0);
    expect(present.output).toContain('timezone: America/Detroit');
    expect(present.output).toContain('you said: "I am in Detroit time"');

    const absent = await handleOwnerProfileCommand(
      runtime(['get', 'contact.phone']),
      { invoke: stubInvoke(() => ({ fieldId: 'contact.phone', present: false, disclosure: '' })) },
    );
    expect(absent.exitCode).toBe(1);
    expect(absent.output).toContain('is not set in your profile');
  });

  test('an invalid mechanical value comes back as written, with the reason', async () => {
    const result = await handleOwnerProfileCommand(
      runtime(['get', 'location.timezone']),
      { invoke: stubInvoke(() => ({
        fieldId: 'location.timezone',
        present: true,
        field: { fieldId: 'location.timezone', label: 'timezone', value: 'Mars/Olympus', valid: false, invalidReason: 'not an IANA zone' },
        disclosure: '',
      })) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Mars/Olympus');
    expect(result.output).toContain('did not parse: not an IANA zone');
    expect(result.output).toContain('treated as unset');
  });

  test('forget names a prose line by section and exact text, never by position', async () => {
    const calls: Call[] = [];
    const result = await handleOwnerProfileCommand(
      runtime(['forget', '--section', 'Notes', '--text', 'Allergic to shellfish', '--yes']),
      { invoke: stubInvoke(() => wrote('Forgotten. Removed a line from Notes.'), calls) },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.body).toEqual({
      section: 'Notes',
      text: 'Allergic to shellfish',
      authority: 'owner-direct',
    });
    expect(calls[0]?.body.lineIndex).toBeUndefined();
  });

  test('a prose line whose text no longer matches deletes nothing and exits non-zero', async () => {
    // He edited or removed that line since the read. Content re-resolves against
    // the document as it is now, so nothing goes and the answer says so, where a
    // position would have deleted whatever had shifted into its place.
    const result = await handleOwnerProfileCommand(
      runtime(['forget', '--section', 'Notes', '--text', 'Allergic to shellfish', '--yes']),
      { invoke: stubInvoke(() => refused('Your profile has no line reading "Allergic to shellfish" under Notes any more.')) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('was not deleted');
    expect(result.output).toContain('no line reading "Allergic to shellfish" under Notes any more');
  });

  test('forget with half an address prints usage and reaches nothing', async () => {
    const calls: Call[] = [];
    const invoke = stubInvoke(() => wrote('Forgotten.'), calls);

    const noText = await handleOwnerProfileCommand(runtime(['forget', '--section', 'Notes', '--yes']), { invoke });
    expect(noText.exitCode).toBe(2);
    expect(noText.output).toContain('--section <section> --text');

    const nothing = await handleOwnerProfileCommand(runtime(['forget', '--yes']), { invoke });
    expect(nothing.exitCode).toBe(2);

    expect(calls).toHaveLength(0);
  });

  test('an unknown subcommand prints usage', async () => {
    const result = await handleOwnerProfileCommand(runtime(['wipe']), { invoke: stubInvoke(() => ({})) });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent owner-profile');
  });

  test('with no operator token on disk the default route reports auth_required', async () => {
    const result = await handleOwnerProfileCommand(runtime(['status', '--json'], false));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('auth_required');
  });
});
