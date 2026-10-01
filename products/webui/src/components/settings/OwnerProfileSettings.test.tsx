/**
 * OwnerProfileSettings, the admin owner-profile panel, against the REAL contract shapes.
 *
 * The two assertions this file exists for, both honesty rules from
 * docs/owner-profile.md:
 *   - a profile that could not be read renders its REASON, never an empty profile
 *     (§4.4: "I could not open the file" and "I know nothing about you" are different
 *     sentences);
 *   - a forget of something that was not there reports the daemon's own "there was nothing
 *     to forget" sentence, and never renders as a success (§9.2).
 *
 * Everything else here covers the states around them: loading, a daemon that does not
 * serve the verbs at all, the turned-off state, the loaded document (mechanical fields as
 * labelled values, his prose as prose), the People section's containment marking, per-tier
 * labelling, undo living inside the provenance disclosure where a superseded value is
 * actually known to exist, and the prose line that honestly has neither lookup nor undo.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type {
  ProfileDocument,
  ProfileProvenanceAnswer,
  ProfileStatus,
  ProfileTarget,
  ProfileWriteOutcome,
} from '../../lib/owner-profile';

interface QueryLike<T> {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  data?: T;
  refetch: () => void;
}

interface MutationLike<TVars, TResult> {
  isPending: boolean;
  mutate: (
    vars: TVars,
    options?: { onSuccess?: (result: TResult) => void; onError?: (error: unknown) => void },
  ) => void;
}

function idleQuery<T>(): QueryLike<T> {
  return { isPending: false, isError: false, isSuccess: false, refetch: () => { /* no-op */ } };
}

function successQuery<T>(data: T): QueryLike<T> {
  return { isPending: false, isError: false, isSuccess: true, data, refetch: () => { /* no-op */ } };
}

function errorQuery<T>(error: unknown): QueryLike<T> {
  return { isPending: false, isError: true, isSuccess: false, error, refetch: () => { /* no-op */ } };
}

type WriteResult = ProfileWriteOutcome | null;

let mockDocument: QueryLike<ProfileDocument> = idleQuery();
let mockStatus: QueryLike<ProfileStatus> = idleQuery();
let mockProvenance: QueryLike<ProfileProvenanceAnswer> = idleQuery();
let provenanceFieldIds: (string | null)[] = [];

let setCalls: { fieldId: string; value: string }[] = [];
let setResult: WriteResult = { ok: true, changes: [], disclosure: '' };
let appendCalls: { section: string; text: string }[] = [];
let forgetCalls: ProfileTarget[] = [];
let forgetResult: WriteResult = { ok: true, changes: [], disclosure: '' };
let undoCalls: string[] = [];
let undoResult: WriteResult = { ok: true, changes: [], disclosure: '' };

const setMutation: MutationLike<{ fieldId: string; value: string }, WriteResult> = {
  isPending: false,
  mutate: (vars, options) => { setCalls.push(vars); options?.onSuccess?.(setResult); },
};
const appendMutation: MutationLike<{ section: string; text: string }, WriteResult> = {
  isPending: false,
  mutate: (vars, options) => { appendCalls.push(vars); options?.onSuccess?.({ ok: true, changes: [], disclosure: '' }); },
};
const forgetMutation: MutationLike<ProfileTarget, WriteResult> = {
  isPending: false,
  mutate: (vars, options) => { forgetCalls.push(vars); options?.onSuccess?.(forgetResult); },
};
const undoMutation: MutationLike<string, WriteResult> = {
  isPending: false,
  mutate: (vars, options) => { undoCalls.push(vars); options?.onSuccess?.(undoResult); },
};

mock.module('../../hooks/useOwnerProfile', () => ({
  useOwnerProfileDocument: () => mockDocument,
  useOwnerProfileStatus: () => mockStatus,
  useOwnerProfileProvenance: (fieldId: string | null) => {
    provenanceFieldIds.push(fieldId);
    return mockProvenance;
  },
  useSetOwnerProfileField: () => setMutation,
  useAppendOwnerProfileLine: () => appendMutation,
  useForgetOwnerProfile: () => forgetMutation,
  useUndoOwnerProfile: () => undoMutation,
}));

const { OwnerProfileSettings } = await import('./OwnerProfileSettings');

function render(): { el: HTMLElement; unmount: () => void } {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(React.createElement(OwnerProfileSettings)); });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/**
 * Let the confirm sheet's promise continuation run and React render the result. The forget
 * flow is genuinely asynchronous, the sheet resolves, THEN the mutation runs, so the
 * state update lands outside any React event handler and needs both a real task tick and
 * an explicit flush before it is observable.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    flushSync(() => { /* flush whatever the continuation queued */ });
  }
}

function buttonIn(scope: Element | null, label: string): HTMLButtonElement {
  const found = Array.from(scope?.querySelectorAll('button') ?? []).find(
    (button) => (button.textContent ?? '').startsWith(label),
  );
  if (!found) throw new Error(`No "${label}" button found`);
  return found;
}

function typeInto(input: HTMLInputElement | null | undefined, value: string): void {
  if (!input) throw new Error('No input to type into');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function submitForm(input: HTMLInputElement | null | undefined): void {
  const form = input?.closest('form');
  flushSync(() => { form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mockDocument = idleQuery();
  mockStatus = idleQuery();
  mockProvenance = idleQuery();
  provenanceFieldIds = [];
  setCalls = [];
  setResult = { ok: true, changes: [], disclosure: '' };
  appendCalls = [];
  forgetCalls = [];
  forgetResult = { ok: true, changes: [], disclosure: '' };
  undoCalls = [];
  undoResult = { ok: true, changes: [], disclosure: '' };
});

const PROFILE_PATH = '/home/owner/.goodvibes/daemon/owner-profile.md';

const LOADED: ProfileDocument = {
  state: 'loaded',
  path: PROFILE_PATH,
  sections: [
    {
      heading: 'Contact',
      tier: 'closed',
      fields: [
        { fieldId: 'contact.email', label: 'email', value: 'owner@example.com', valid: true },
        { fieldId: 'contact.phone', label: 'phone', value: '+1 517 555 0134', valid: true },
      ],
      prose: [],
    },
    {
      heading: 'Preferences',
      tier: 'open',
      fields: [{ fieldId: 'preferences.units', label: 'units', value: 'imperial', valid: true }],
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

describe('OwnerProfileSettings', () => {
  test('a genuine fetch failure offers a retry that refetches the profile', () => {
    let refetches = 0;
    mockDocument = {
      ...errorQuery<ProfileDocument>(Object.assign(new Error('network down'), { status: 0, category: 'network' })),
      refetch: () => { refetches += 1; },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const retry = el.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');
    expect(retry).not.toBeNull();
    flushSync(() => { retry?.click(); });
    expect(refetches).toBe(1);
  });

  // The load-bearing honesty assertion (§4.4).
  test('an unavailable profile renders its reason, NOT an empty profile', () => {
    mockDocument = successQuery<ProfileDocument>({
      state: 'unavailable',
      reason: 'permission denied',
      path: PROFILE_PATH,
      sections: [],
    });
    mockStatus = successQuery<ProfileStatus>({
      state: 'unavailable',
      reason: 'permission denied',
      path: PROFILE_PATH,
      sections: [],
      invalidFields: [],
    });
    const { el, unmount } = render();
    cleanup = unmount;

    const banner = el.querySelector('[data-testid="profile-unavailable"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('permission denied');
    expect(banner?.textContent).toContain(PROFILE_PATH);
    // No sections are rendered in its place.
    expect(el.querySelector('[data-testid^="profile-section-"]')).toBeNull();
  });

  test('a turned-off profile is a stated state, not an empty one', () => {
    mockDocument = successQuery<ProfileDocument>({ state: 'disabled', path: PROFILE_PATH, sections: [] });
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('[data-testid="profile-disabled"]')).not.toBeNull();
    expect(el.querySelector('[data-testid^="profile-section-"]')).toBeNull();
  });

  test('a loaded profile renders each field value and prose line it was given', () => {
    mockDocument = successQuery(LOADED);
    const { el, unmount } = render();
    cleanup = unmount;

    const email = el.querySelector('[data-testid="profile-field-contact.email"]');
    expect(email?.textContent).toContain('owner@example.com');

    const people = el.querySelector('[data-testid="profile-section-People"]');
    expect(people?.textContent).toContain('Sarah, sister, sarah@example.com');
    expect(people?.textContent).toContain('Dave from work, handles the Pellux contracts');

    // The provenance the daemon recorded rides the line it belongs to (§4.2).
    const shipping = el.querySelector('[data-testid="profile-field-commerce.shippingAddress"]');
    expect(shipping?.textContent).toContain('ship it to my office instead');
  });

  test('an invalid mechanical value is shown as written, with its reason', () => {
    mockDocument = successQuery<ProfileDocument>({
      state: 'loaded',
      path: PROFILE_PATH,
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
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.textContent).toContain('Mars/Olympus');
    expect(el.textContent).toContain('not an IANA time zone');
  });

  test('editing a field calls profile.set with its fieldId and the typed value', () => {
    mockDocument = successQuery(LOADED);
    const { el, unmount } = render();
    cleanup = unmount;

    const row = el.querySelector('[data-testid="profile-field-contact.phone"]');
    flushSync(() => { buttonIn(row, 'Edit').click(); });

    const input = el.querySelector<HTMLInputElement>('[data-testid="profile-field-contact.phone"] input');
    typeInto(input, '+1 517 555 0199');
    submitForm(input);

    expect(setCalls).toEqual([{ fieldId: 'contact.phone', value: '+1 517 555 0199' }]);
  });

  test('a write the daemon reports as ok:false is relayed in its own words, not as a save', () => {
    mockDocument = successQuery(LOADED);
    setResult = {
      ok: false,
      reason: 'That value appears in a web page read this turn, so it was not recorded.',
      changes: [],
      disclosure: '',
    };
    const { el, unmount } = render();
    cleanup = unmount;

    flushSync(() => { buttonIn(el.querySelector('[data-testid="profile-field-contact.phone"]'), 'Edit').click(); });
    const input = el.querySelector<HTMLInputElement>('[data-testid="profile-field-contact.phone"] input');
    typeInto(input, '1 Attacker Way');
    submitForm(input);

    expect(el.textContent).toContain('That value appears in a web page read this turn, so it was not recorded.');
  });

  // The second load-bearing honesty assertion (§9.2).
  test('forgetting something that was not there relays the daemon\'s sentence, never a success', async () => {
    mockDocument = successQuery(LOADED);
    forgetResult = {
      ok: false,
      reason: 'Your profile has no phone recorded, so there was nothing to forget.',
      changes: [],
      disclosure: '',
    };
    const { el, unmount } = render();
    cleanup = unmount;

    const row = el.querySelector('[data-testid="profile-field-contact.phone"]');
    flushSync(() => { buttonIn(row, 'Forget').click(); });

    // Confirm first, deleting is permanent, so it is never a bare click.
    const confirmButton = window.document.querySelector<HTMLButtonElement>('.gv-confirm__confirm');
    expect(confirmButton).not.toBeNull();
    flushSync(() => { confirmButton?.click(); });
    await settle();

    expect(forgetCalls).toEqual([{ kind: 'field', fieldId: 'contact.phone' }]);
    expect(el.textContent).toContain('Your profile has no phone recorded, so there was nothing to forget.');
  });

  test('cancelling the confirm deletes nothing', async () => {
    mockDocument = successQuery(LOADED);
    const { el, unmount } = render();
    cleanup = unmount;

    flushSync(() => { buttonIn(el.querySelector('[data-testid="profile-field-contact.phone"]'), 'Forget').click(); });
    flushSync(() => { window.document.querySelector<HTMLButtonElement>('.gv-confirm__cancel')?.click(); });
    await settle();

    expect(forgetCalls.length).toBe(0);
  });

  test('forgetting a note names it by section and exact text, never by position', async () => {
    mockDocument = successQuery(LOADED);
    const { el, unmount } = render();
    cleanup = unmount;

    flushSync(() => { buttonIn(el.querySelector('[data-testid="profile-line-41"]'), 'Forget').click(); });
    flushSync(() => { window.document.querySelector<HTMLButtonElement>('.gv-confirm__confirm')?.click(); });
    await settle();

    expect(forgetCalls).toEqual([
      { kind: 'line', section: 'People', text: 'Sarah, sister, sarah@example.com' },
    ]);
  });

  // The staleness case, at the surface: a delete that found nothing means the page is
  // showing an older version of the file, and saying only "nothing was removed" would be
  // true and useless.
  test('a note that is no longer there relays the daemon\'s reason', async () => {
    mockDocument = successQuery(LOADED);
    forgetResult = {
      ok: false,
      reason: 'That line is not in People any more, so nothing was removed.',
      changes: [],
      disclosure: '',
    };
    const { el, unmount } = render();
    cleanup = unmount;

    flushSync(() => { buttonIn(el.querySelector('[data-testid="profile-line-41"]'), 'Forget').click(); });
    flushSync(() => { window.document.querySelector<HTMLButtonElement>('.gv-confirm__confirm')?.click(); });
    await settle();

    expect(forgetCalls).toEqual([
      { kind: 'line', section: 'People', text: 'Sarah, sister, sarah@example.com' },
    ]);
    expect(el.textContent).toContain('That line is not in People any more, so nothing was removed.');
  });

  test('provenance is reachable per field, and asks only for the field it was opened on', () => {
    mockDocument = successQuery(LOADED);
    mockProvenance = successQuery<ProfileProvenanceAnswer>({
      fieldId: 'commerce.shippingAddress',
      present: true,
      handEdited: false,
      provenance: { surface: 'tui', date: '2026-07-27', said: 'ship it to my office instead' },
      superseded: [
        {
          fieldId: 'commerce.shippingAddress',
          section: 'Commerce',
          value: '401 Home St, Lansing, MI 48933, US',
          supersededOn: '2026-07-27',
          provenance: { surface: 'tui', date: '2026-07-20', said: 'ship to 401 Home St' },
        },
      ],
    });
    const { el, unmount } = render();
    cleanup = unmount;

    // Nothing is fetched until it is asked for, no bulk dump on mount.
    expect(el.querySelector('[data-testid="profile-provenance-commerce.shippingAddress"]')).toBeNull();

    const shipping = el.querySelector('[data-testid="profile-field-commerce.shippingAddress"]');
    flushSync(() => { buttonIn(shipping, 'Where did you get that?').click(); });

    const detail = shipping?.querySelector('[data-testid="profile-provenance-commerce.shippingAddress"]');
    expect(detail?.textContent).toContain('401 Home St, Lansing, MI 48933, US');
    // Only the opened field was asked about.
    expect(provenanceFieldIds.filter((id) => id !== null)).toEqual(['commerce.shippingAddress']);
  });

  test('undo is offered inside the disclosure, only where a superseded value exists', () => {
    mockDocument = successQuery(LOADED);
    mockProvenance = successQuery<ProfileProvenanceAnswer>({
      fieldId: 'commerce.shippingAddress',
      present: true,
      handEdited: false,
      superseded: [
        {
          fieldId: 'commerce.shippingAddress',
          section: 'Commerce',
          value: '401 Home St, Lansing, MI 48933, US',
          supersededOn: '2026-07-27',
        },
      ],
    });
    const { el, unmount } = render();
    cleanup = unmount;

    const shipping = el.querySelector('[data-testid="profile-field-commerce.shippingAddress"]');
    // No undo affordance before the earlier value has been shown to exist.
    expect(Array.from(shipping?.querySelectorAll('button') ?? []).some((b) => (b.textContent ?? '').startsWith('Undo'))).toBe(false);

    flushSync(() => { buttonIn(shipping, 'Where did you get that?').click(); });
    flushSync(() => { buttonIn(shipping, 'Undo').click(); });
    expect(undoCalls).toEqual(['commerce.shippingAddress']);
  });

  test('a field with no earlier value opens its provenance and offers no undo', () => {
    mockDocument = successQuery(LOADED);
    mockProvenance = successQuery<ProfileProvenanceAnswer>({
      fieldId: 'contact.email',
      present: true,
      handEdited: true,
      superseded: [],
    });
    const { el, unmount } = render();
    cleanup = unmount;

    const email = el.querySelector('[data-testid="profile-field-contact.email"]');
    flushSync(() => { buttonIn(email, 'Where did you get that?').click(); });
    expect(email?.querySelector('[data-testid="profile-provenance-contact.email"]')).not.toBeNull();
    expect(Array.from(email?.querySelectorAll('button') ?? []).some((b) => (b.textContent ?? '').startsWith('Undo'))).toBe(false);
  });

  test('a note answers its own provenance without a daemon lookup', () => {
    mockDocument = successQuery(LOADED);
    const { el, unmount } = render();
    cleanup = unmount;

    const withSuffix = el.querySelector('[data-testid="profile-line-41"]');
    flushSync(() => { buttonIn(withSuffix, 'Where did you get that?').click(); });
    expect(withSuffix?.textContent).toContain('my sister Sarah, sarah@example.com');
    // The verb takes a fieldId, so no lookup is issued for a note.
    expect(provenanceFieldIds.filter((id) => id !== null)).toEqual([]);
  });

  test('the status strip carries the daemon counts and invalid fields', () => {
    mockDocument = successQuery(LOADED);
    mockStatus = successQuery<ProfileStatus>({
      state: 'loaded',
      path: PROFILE_PATH,
      sections: ['Contact', 'Preferences', 'Commerce', 'People'],
      lineCount: 42,
      fieldCount: 11,
      proseLineCount: 5,
      invalidFields: [{ fieldId: 'location.timezone', reason: 'not an IANA time zone' }],
    });
    const { el, unmount } = render();
    cleanup = unmount;
    const strip = el.querySelector('[data-testid="profile-status"]');
    expect(strip?.textContent).toContain('42');
    expect(el.textContent).toContain('location.timezone');
    expect(el.textContent).toContain('not an IANA time zone');
  });

  test('adding a line calls profile.append with the section heading as written', () => {
    mockDocument = successQuery(LOADED);
    const { el, unmount } = render();
    cleanup = unmount;

    const people = el.querySelector('[data-testid="profile-section-People"]');
    flushSync(() => { buttonIn(people, 'Add a line to').click(); });
    const input = people?.querySelector<HTMLInputElement>('input');
    typeInto(input, 'Ken, neighbour');
    submitForm(input);
    expect(appendCalls).toEqual([{ section: 'People', text: 'Ken, neighbour' }]);
  });
});
