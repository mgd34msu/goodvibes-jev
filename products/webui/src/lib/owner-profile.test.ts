/**
 * owner-profile.ts, the wire readers for the profile.* verbs, against the REAL generated
 * contract shapes (fieldId / heading / tier / state.kind / ok+reason+changes+disclosure).
 *
 * The load-bearing assertions are the honesty ones: a profile that could not be read must
 * never come back as an empty profile (docs/owner-profile.md §4.4), a write whose answer
 * did not say `ok` must never come back as a success (§9.2), and a `profile.status` answer
 * must carry names, counts and reasons but no values (§11.3).
 */
import { describe, expect, test } from 'bun:test';
import {
  deletedWhat,
  forgetReportLine,
  forgetTargetInput,
  profileStateBadgeClass,
  profileTargetId,
  profileUnavailableLine,
  provenanceSummary,
  readProfileDocument,
  readProfileProvenanceAnswer,
  readProfileStatus,
  readProfileWriteOutcome,
  sectionHoldsThirdPartyData,
  STALE_VIEW_NOTE,
  writeReportLine,
  type ProfileSection,
} from './owner-profile';

const PROFILE_PATH = '/home/owner/.goodvibes/daemon/owner-profile.md';

const LOADED_READ = {
  state: {
    kind: 'loaded',
    path: PROFILE_PATH,
    exists: true,
    lineCount: 42,
    fieldCount: 11,
    proseLineCount: 5,
    sections: ['Identity', 'Commerce', 'People'],
    invalidFields: [],
  },
  sections: [
    {
      heading: 'Identity',
      tier: 'open',
      fields: [
        { fieldId: 'identity.name', label: 'name', value: 'Mike Davis', valid: true },
        { fieldId: 'identity.goesBy', label: 'goes by', value: 'Mike', valid: true },
      ],
      prose: [],
    },
    {
      heading: 'Commerce',
      tier: 'closed',
      fields: [
        {
          fieldId: 'commerce.shippingAddress',
          label: 'shipping address',
          value: '200 Office Way, Lansing, MI 48933, US',
          valid: true,
          provenance: { surface: 'tui', date: '2026-07-27', said: 'ship it to my office instead' },
        },
      ],
      prose: [],
    },
    {
      heading: 'People',
      tier: 'closed',
      fields: [],
      prose: [
        {
          lineIndex: 41,
          section: 'People',
          text: 'Sarah, sister, sarah@example.com',
          provenance: { surface: 'tui', date: '2026-07-27', said: 'my sister Sarah, sarah@example.com' },
        },
        { lineIndex: 42, section: 'People', text: 'Dave from work, handles the Pellux contracts' },
      ],
    },
  ],
};

describe('readProfileDocument', () => {
  test('reads sections, tiers, mechanical fields, prose lines and provenance', () => {
    const document = readProfileDocument(LOADED_READ);
    expect(document).not.toBeNull();
    expect(document?.state).toBe('loaded');
    expect(document?.path).toBe(PROFILE_PATH);
    expect(document?.sections.length).toBe(3);

    const identity = document?.sections[0];
    expect(identity?.heading).toBe('Identity');
    expect(identity?.tier).toBe('open');
    expect(identity?.fields[0]?.fieldId).toBe('identity.name');
    expect(identity?.fields[0]?.label).toBe('name');

    const commerce = document?.sections[1];
    expect(commerce?.tier).toBe('closed');
    expect(commerce?.fields[0]?.value).toBe('200 Office Way, Lansing, MI 48933, US');
    expect(commerce?.fields[0]?.provenance?.said).toBe('ship it to my office instead');

    const people = document?.sections[2];
    expect(people?.prose.map((line) => line.text)).toEqual([
      'Sarah, sister, sarah@example.com',
      'Dave from work, handles the Pellux contracts',
    ]);
    // The line index is the only address profile.forget takes for a note.
    expect(people?.prose[0]?.lineIndex).toBe(41);
    expect(people?.prose[1]?.provenance).toBeUndefined();
  });

  test('an unrecognised tier is read as closed, never as open', () => {
    const document = readProfileDocument({
      state: { kind: 'loaded', path: PROFILE_PATH },
      sections: [{ heading: 'Something New', tier: 'restricted', fields: [], prose: [] }],
    });
    expect(document?.sections[0]?.tier).toBe('closed');
  });

  test('an invalid mechanical value is preserved with its reason, not dropped', () => {
    const document = readProfileDocument({
      state: { kind: 'loaded', path: PROFILE_PATH },
      sections: [
        {
          heading: 'Location',
          tier: 'open',
          fields: [
            {
              fieldId: 'location.timezone',
              label: 'timezone',
              value: 'Mars/Olympus',
              valid: false,
              invalidReason: 'not an IANA time zone',
            },
          ],
          prose: [],
        },
      ],
    });
    const field = document?.sections[0]?.fields[0];
    expect(field?.value).toBe('Mars/Olympus');
    expect(field?.valid).toBe(false);
    expect(field?.invalidReason).toBe('not an IANA time zone');
  });

  test('unavailable carries its reason and NO sections, never an empty profile', () => {
    const document = readProfileDocument({
      state: { kind: 'unavailable', path: PROFILE_PATH, reason: 'permission denied' },
      sections: [{ heading: 'Identity', tier: 'open', fields: [], prose: [] }],
    });
    expect(document?.state).toBe('unavailable');
    expect(document?.reason).toBe('permission denied');
    expect(document?.path).toBe(PROFILE_PATH);
    expect(document?.sections.length).toBe(0);
  });

  test('disabled is a stated state, not an empty profile', () => {
    const document = readProfileDocument({ state: { kind: 'disabled', path: PROFILE_PATH }, sections: [] });
    expect(document?.state).toBe('disabled');
    expect(document?.sections.length).toBe(0);
  });

  test('a body that carries no profile at all is null, not an empty document', () => {
    expect(readProfileDocument(null)).toBeNull();
    expect(readProfileDocument('nope')).toBeNull();
    expect(readProfileDocument({})).toBeNull();
    expect(readProfileDocument({ sections: [] })).toBeNull();
    expect(readProfileDocument({ state: { kind: 'loaded' } })).toBeNull();
  });

  test('a state kind this surface does not know is null, not a guess at the closest one', () => {
    expect(readProfileDocument({ state: { kind: 'partially-loaded', path: PROFILE_PATH }, sections: [] })).toBeNull();
  });

  test('a malformed field or line is dropped, and the rest of the section survives', () => {
    const document = readProfileDocument({
      state: { kind: 'loaded', path: PROFILE_PATH },
      sections: [
        {
          heading: 'Contact',
          tier: 'closed',
          fields: [{ fieldId: 'contact.email' }, { fieldId: 'contact.phone', label: 'phone', value: '+1', valid: true }],
          prose: ['not an object', { lineIndex: 3, section: 'Contact', text: 'kept' }],
        },
      ],
    });
    expect(document?.sections[0]?.fields.map((field) => field.fieldId)).toEqual(['contact.phone']);
    expect(document?.sections[0]?.prose.map((line) => line.text)).toEqual(['kept']);
  });
});

describe('readProfileStatus', () => {
  test('carries state, path, section names, counts and invalid-field reasons', () => {
    const status = readProfileStatus({
      kind: 'loaded',
      path: PROFILE_PATH,
      exists: true,
      sections: ['Identity', 'Contact', 'People'],
      lineCount: 42,
      fieldCount: 11,
      proseLineCount: 5,
      invalidFields: [{ fieldId: 'location.timezone', reason: 'not an IANA time zone' }],
    });
    expect(status?.state).toBe('loaded');
    expect(status?.sections).toEqual(['Identity', 'Contact', 'People']);
    expect(status?.lineCount).toBe(42);
    expect(status?.proseLineCount).toBe(5);
    expect(status?.invalidFields[0]?.reason).toBe('not an IANA time zone');
  });

  test('the parsed status carries no value, from a body that tried to smuggle one', () => {
    // The generated status output has no `value` property anywhere; this pins that the
    // reader does not reintroduce one even if a build were to send it (§11.3).
    const status = readProfileStatus({
      kind: 'loaded',
      path: PROFILE_PATH,
      sections: ['Commerce'],
      invalidFields: [{ fieldId: 'commerce.shippingAddress', reason: 'bad', value: '200 Office Way' }],
    });
    expect(JSON.stringify(status)).not.toContain('200 Office Way');
  });

  test('an invalid field with no reason says so rather than inventing one', () => {
    const status = readProfileStatus({
      kind: 'loaded',
      path: PROFILE_PATH,
      invalidFields: [{ fieldId: 'commerce.currency' }],
    });
    expect(status?.invalidFields[0]?.reason.length).toBeGreaterThan(0);
  });

  test('unavailable keeps its reason', () => {
    const status = readProfileStatus({ kind: 'unavailable', path: PROFILE_PATH, reason: 'not valid UTF-8' });
    expect(status?.state).toBe('unavailable');
    expect(status?.reason).toBe('not valid UTF-8');
  });

  test('a body with no kind or no path is null', () => {
    expect(readProfileStatus({ path: PROFILE_PATH })).toBeNull();
    expect(readProfileStatus({ kind: 'loaded' })).toBeNull();
    expect(readProfileStatus(42)).toBeNull();
  });
});

describe('readProfileProvenanceAnswer', () => {
  test('returns the suffix plus every superseded predecessor', () => {
    const answer = readProfileProvenanceAnswer({
      fieldId: 'commerce.shippingAddress',
      present: true,
      handEdited: false,
      provenance: { surface: 'tui', date: '2026-07-27', said: 'ship it to my office instead' },
      superseded: [
        {
          lineIndex: 22,
          fieldId: 'commerce.shippingAddress',
          section: 'Commerce',
          text: 'shipping address: 401 Home St, Lansing, MI 48933, US',
          value: '401 Home St, Lansing, MI 48933, US',
          supersededOn: '2026-07-27',
          previousLine: 'shipping address: 401 Home St, Lansing, MI 48933, US',
          provenance: { surface: 'tui', date: '2026-07-20', said: 'ship to 401 Home St' },
        },
      ],
    });
    expect(answer?.present).toBe(true);
    expect(answer?.handEdited).toBe(false);
    expect(answer?.provenance?.said).toBe('ship it to my office instead');
    expect(answer?.superseded[0]?.value).toBe('401 Home St, Lansing, MI 48933, US');
    expect(answer?.superseded[0]?.supersededOn).toBe('2026-07-27');
  });

  test('a field the owner typed by hand reports handEdited with no provenance', () => {
    const answer = readProfileProvenanceAnswer({
      fieldId: 'contact.email',
      present: true,
      handEdited: true,
      superseded: [],
    });
    expect(answer?.handEdited).toBe(true);
    expect(answer?.provenance).toBeUndefined();
  });

  test('a field that is not there is reported as not present', () => {
    const answer = readProfileProvenanceAnswer({
      fieldId: 'contact.phone',
      present: false,
      handEdited: false,
      superseded: [],
    });
    expect(answer?.present).toBe(false);
  });

  test('a body carrying no fieldId or no present flag is null', () => {
    expect(readProfileProvenanceAnswer({ present: true })).toBeNull();
    expect(readProfileProvenanceAnswer({ fieldId: 'contact.email' })).toBeNull();
    expect(readProfileProvenanceAnswer(null)).toBeNull();
  });
});

describe('readProfileWriteOutcome', () => {
  test('a successful write carries its changes and its one-line disclosure', () => {
    const outcome = readProfileWriteOutcome({
      ok: true,
      reason: null,
      changes: [{ kind: 'set', fieldId: 'contact.phone', section: 'Contact', label: 'phone', superseded: true }],
      disclosure: 'Noted: saved your phone number to your profile.',
    });
    expect(outcome?.ok).toBe(true);
    expect(outcome?.reason).toBeUndefined();
    expect(outcome?.changes[0]?.label).toBe('phone');
    expect(outcome?.changes[0]?.superseded).toBe(true);
    expect(outcome?.disclosure).toBe('Noted: saved your phone number to your profile.');
  });

  test('a refusal carries the daemon\'s own reason', () => {
    const outcome = readProfileWriteOutcome({
      ok: false,
      reason: 'Your profile has no phone recorded, so there was nothing to forget.',
      changes: [],
      disclosure: '',
    });
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toBe('Your profile has no phone recorded, so there was nothing to forget.');
  });

  test('a change naming a section rather than a field keeps a null fieldId', () => {
    const outcome = readProfileWriteOutcome({
      ok: true,
      changes: [{ kind: 'forget', fieldId: null, section: 'People', label: 'note', superseded: false }],
      disclosure: '',
    });
    expect(outcome?.changes[0]?.fieldId).toBeNull();
  });

  test('a body that never said ok is null, never a success', () => {
    expect(readProfileWriteOutcome({})).toBeNull();
    expect(readProfileWriteOutcome({ changes: [], disclosure: '' })).toBeNull();
    expect(readProfileWriteOutcome(null)).toBeNull();
    expect(readProfileWriteOutcome('ok')).toBeNull();
  });
});

describe('writeReportLine', () => {
  test('a success prefers the daemon\'s own disclosure', () => {
    const line = writeReportLine(
      { ok: true, changes: [], disclosure: 'Noted: saved your office address to your profile.' },
      'fallback',
      'malformed',
    );
    expect(line).toEqual({ tone: 'ok', text: 'Noted: saved your office address to your profile.' });
  });

  test('a success with no disclosure falls back to the caller\'s sentence', () => {
    expect(writeReportLine({ ok: true, changes: [], disclosure: '' }, 'Saved phone.', 'malformed')).toEqual({
      tone: 'ok',
      text: 'Saved phone.',
    });
  });

  test('a refusal is relayed in the daemon\'s words, and is not toned as a success', () => {
    const line = writeReportLine(
      { ok: false, reason: 'Your profile has no phone recorded, so there was nothing to forget.', changes: [], disclosure: '' },
      'Saved phone.',
      'malformed',
    );
    expect(line.tone).toBe('info');
    expect(line.text).toBe('Your profile has no phone recorded, so there was nothing to forget.');
  });

  test('a refusal with no reason says so rather than inventing one', () => {
    const line = writeReportLine({ ok: false, changes: [], disclosure: '' }, 'Saved.', 'malformed');
    expect(line.tone).toBe('info');
    expect(line.text.length).toBeGreaterThan(0);
    expect(line.text).not.toBe('Saved.');
  });

  test('a malformed answer is a warning, never a success', () => {
    expect(writeReportLine(null, 'Saved.', 'The daemon did not say.')).toEqual({
      tone: 'warning',
      text: 'The daemon did not say.',
    });
  });
});

describe('deletedWhat', () => {
  test('names what went from the daemon\'s own change list', () => {
    expect(deletedWhat(
      {
        ok: true,
        changes: [{ kind: 'forget', fieldId: 'contact.phone', section: 'Contact', label: 'phone', superseded: false }],
        disclosure: '',
      },
      'that line',
    )).toBe('phone');
  });

  test('falls back to the caller\'s label when the daemon named nothing', () => {
    expect(deletedWhat({ ok: true, changes: [], disclosure: '' }, 'that line')).toBe('that line');
  });
});

describe('targets', () => {
  test('a field target sends a fieldId', () => {
    expect(forgetTargetInput({ kind: 'field', fieldId: 'commerce.currency' })).toEqual({ fieldId: 'commerce.currency' });
    expect(profileTargetId({ kind: 'field', fieldId: 'commerce.currency' })).toBe('field:commerce.currency');
  });

  test('a prose line target sends its section and exact text: never a position', () => {
    const target = { kind: 'line', section: 'People', text: 'Sarah, sister, sarah@example.com' } as const;
    expect(forgetTargetInput(target)).toEqual({ section: 'People', text: 'Sarah, sister, sarah@example.com' });
    expect(profileTargetId(target)).toBe('line:People:Sarah, sister, sarah@example.com');
  });

  test('no target input carries a lineIndex; the verb refuses one outright', () => {
    const inputs = [
      forgetTargetInput({ kind: 'field', fieldId: 'contact.phone' }),
      forgetTargetInput({ kind: 'line', section: 'Notes', text: 'Allergic to shellfish' }),
    ];
    for (const input of inputs) {
      expect('lineIndex' in input).toBe(false);
    }
  });
});

describe('forgetReportLine', () => {
  test('a deletion names what actually went and says nothing about staleness', () => {
    const line = forgetReportLine(
      {
        ok: true,
        changes: [{ kind: 'forget', fieldId: 'contact.phone', section: 'Contact', label: 'phone', superseded: false }],
        disclosure: '',
      },
      'phone',
    );
    expect(line.tone).toBe('ok');
    expect(line.text).toContain('phone');
    expect(line.text).not.toContain(STALE_VIEW_NOTE);
  });

  test('a note that is no longer there relays the reason AND flags the view as stale', () => {
    const line = forgetReportLine(
      {
        ok: false,
        reason: 'That line is not in People any more, so nothing was removed.',
        changes: [],
        disclosure: '',
      },
      'Sarah, sister',
    );
    expect(line.tone).toBe('warning');
    expect(line.text).toContain('That line is not in People any more, so nothing was removed.');
    expect(line.text).toContain(STALE_VIEW_NOTE);
  });

  test('two identical notes the daemon will not guess between also flags staleness', () => {
    const line = forgetReportLine(
      { ok: false, reason: '2 lines in Notes read exactly that, so it is not clear which one you mean.', changes: [], disclosure: '' },
      'a note',
    );
    expect(line.text).toContain('2 lines in Notes read exactly that, so it is not clear which one you mean.');
    expect(line.text).toContain(STALE_VIEW_NOTE);
  });

  test('an absent field flags staleness too: the row was rendered from a stale read', () => {
    const line = forgetReportLine(
      { ok: false, reason: 'Your profile has no phone recorded, so there was nothing to forget.', changes: [], disclosure: '' },
      'phone',
    );
    expect(line.text).toContain('Your profile has no phone recorded, so there was nothing to forget.');
    expect(line.text).toContain(STALE_VIEW_NOTE);
  });

  test('a body that never said ok is unsaid, never a deletion and never a staleness claim', () => {
    const line = forgetReportLine(null, 'phone');
    expect(line.tone).toBe('warning');
    expect(line.text).toContain('phone');
    expect(line.text).not.toContain(STALE_VIEW_NOTE);
  });
});

describe('third-party personal data', () => {
  function section(heading: string): ProfileSection {
    return { heading, tier: 'closed', fields: [], prose: [] };
  }

  test('the People section is recognised, case-insensitively and whitespace-collapsed', () => {
    expect(sectionHoldsThirdPartyData(section('People'))).toBe(true);
    expect(sectionHoldsThirdPartyData(section('  people  '))).toBe(true);
    expect(sectionHoldsThirdPartyData(section('PEOPLE'))).toBe(true);
  });

  test('other sections are not', () => {
    expect(sectionHoldsThirdPartyData(section('Places'))).toBe(false);
    expect(sectionHoldsThirdPartyData(section('Notes'))).toBe(false);
  });
});

describe('display helpers', () => {
  test('the unavailable line states the reason and the path', () => {
    const line = profileUnavailableLine('permission denied', PROFILE_PATH);
    expect(line).toContain('permission denied');
    expect(line).toContain(PROFILE_PATH);
  });

  test('a missing reason still carries the path', () => {
    expect(profileUnavailableLine(undefined, PROFILE_PATH)).toContain(PROFILE_PATH);
  });

  test('state tones are distinct per state', () => {
    expect(profileStateBadgeClass('loaded')).toBe('ok');
    expect(profileStateBadgeClass('disabled')).toBe('neutral');
    expect(profileStateBadgeClass('unavailable')).toBe('bad');
  });

  test('a provenance summary carries surface, date and his words', () => {
    const summary = provenanceSummary({ surface: 'tui', date: '2026-07-27', said: 'ship it to my office instead' });
    expect(summary).toContain('tui');
    expect(summary).toContain('2026-07-27');
    expect(summary).toContain('ship it to my office instead');
  });
});
