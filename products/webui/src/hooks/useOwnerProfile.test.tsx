/**
 * useOwnerProfile, what the write hooks actually SEND on the wire.
 *
 * This file exists because the panel's own tests mock these hooks, so they assert what the
 * UI does with an answer and can say nothing about the request. A contract change that
 * made `authority` required on every profile write went unnoticed for exactly that reason:
 * a mock that accepts anything accepts a body the daemon would 400. So every assertion
 * here is on the request payload, not on the response.
 *
 * The generated input types cannot catch this either, `authority` is optional in
 * OperatorMethodInput<'profile.set'> and friends (the schemas' `required` arrays do not
 * list it) while routes/owner-profile.ts's readAuthority refuses an absent value at
 * runtime. The handler is stricter than the declared schema, which leaves this test as the
 * only thing standing between a missing authority and a 400 against a real daemon.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OPERATOR_CONTRACT } from '@goodvibes-jev/engine/contracts/generated/operator-contract';

interface WireCall {
  readonly verb: string;
  readonly input: unknown;
}

let calls: WireCall[] = [];

const WRITE_ANSWER = { ok: true, reason: null, changes: [], disclosure: '' };

function record(verb: string, input: unknown): Promise<unknown> {
  calls.push({ verb, input });
  return Promise.resolve(WRITE_ANSWER);
}

// queries.ts imports getCurrentAuth/invokeMethod/sdk from this module, so all three must
// be present or the module fails to link.
mock.module('../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      profile: {
        read: () => Promise.resolve({ state: { kind: 'loaded', path: '/p' }, sections: [] }),
        status: () => Promise.resolve({ kind: 'loaded', path: '/p' }),
        get: (fieldId: string) => record('get', { fieldId }),
        person: (name: string) => record('person', { name }),
        provenance: (fieldId: string) => record('provenance', { fieldId }),
        set: (input: unknown) => record('set', input),
        append: (input: unknown) => record('append', input),
        forget: (input: unknown) => record('forget', input),
        undo: (input: unknown) => record('undo', input),
      },
    },
  },
}));

const {
  useAppendOwnerProfileLine,
  useForgetOwnerProfile,
  useSetOwnerProfileField,
  useUndoOwnerProfile,
} = await import('./useOwnerProfile');

interface Harness {
  setField: (fieldId: string, value: string) => void;
  appendLine: (section: string, text: string) => void;
  forgetField: (fieldId: string) => void;
  forgetLine: (section: string, text: string) => void;
  undoField: (fieldId: string) => void;
}

let harness: Harness | null = null;
let cleanup: (() => void) | null = null;

function render(): void {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  function Probe() {
    const setField = useSetOwnerProfileField();
    const appendLine = useAppendOwnerProfileLine();
    const forget = useForgetOwnerProfile();
    const undo = useUndoOwnerProfile();
    harness = {
      setField: (fieldId, value) => { setField.mutate({ fieldId, value }); },
      appendLine: (section, text) => { appendLine.mutate({ section, text }); },
      forgetField: (fieldId) => { forget.mutate({ kind: 'field', fieldId }); },
      forgetLine: (section, text) => { forget.mutate({ kind: 'line', section, text }); },
      undoField: (fieldId) => { undo.mutate(fieldId); },
    };
    return null;
  }

  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });

  cleanup = () => {
    flushSync(() => { root.unmount(); });
    if (container.parentNode) container.parentNode.removeChild(container);
    client.clear();
  };
}

/** react-query runs mutationFn asynchronously; wait for the call to land. */
async function nextCall(): Promise<WireCall> {
  for (let i = 0; i < 20; i += 1) {
    if (calls.length > 0) return calls[0] as WireCall;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error('no wire call was made');
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
  harness = null;
  calls = [];
});

/** The claim this surface makes about where a fact came from (§7 layer 1). */
const AUTHORITY = 'owner-direct';

describe('every profile write states its authority', () => {
  test('profile.set sends authority owner-direct, with the settings-surface provenance pair', async () => {
    render();
    harness?.setField('contact.phone', '+1 517 555 0199');
    const call = await nextCall();
    expect(call.verb).toBe('set');
    expect(call.input).toEqual({
      fieldId: 'contact.phone',
      value: '+1 517 555 0199',
      surface: 'webui',
      said: '(edited in settings)',
      authority: AUTHORITY,
    });
  });

  test('profile.append sends authority owner-direct', async () => {
    render();
    harness?.appendLine('People', 'Ken, neighbour');
    const call = await nextCall();
    expect(call.verb).toBe('append');
    expect(call.input).toEqual({
      section: 'People',
      text: 'Ken, neighbour',
      surface: 'webui',
      said: '(edited in settings)',
      authority: AUTHORITY,
    });
  });

  // The removal verbs matter most: §7 gives them an authority check and nothing else, so
  // an unstated authority here would be no gate at all rather than a weakened one.
  test('profile.forget sends authority owner-direct alongside a field target', async () => {
    render();
    harness?.forgetField('contact.phone');
    const call = await nextCall();
    expect(call.verb).toBe('forget');
    expect(call.input).toEqual({ fieldId: 'contact.phone', authority: AUTHORITY });
  });

  test('profile.forget names a note by section and exact text, with no lineIndex', async () => {
    render();
    harness?.forgetLine('People', 'Sarah, sister, sarah@example.com');
    const call = await nextCall();
    expect(call.verb).toBe('forget');
    expect(call.input).toEqual({
      section: 'People',
      text: 'Sarah, sister, sarah@example.com',
      authority: AUTHORITY,
    });
    // A position captured at render time may name a different line by click time (§9.2),
    // so the verb refuses one outright, nothing here may send it.
    expect('lineIndex' in (call.input as Record<string, unknown>)).toBe(false);
  });

  test('profile.undo sends authority owner-direct', async () => {
    render();
    harness?.undoField('commerce.shippingAddress');
    const call = await nextCall();
    expect(call.verb).toBe('undo');
    expect(call.input).toEqual({ fieldId: 'commerce.shippingAddress', authority: AUTHORITY });
  });

  test('no write omits authority, and none sends explicitUserRequest', async () => {
    // explicitUserRequest is deliberately absent: refuseNonUserRequest() refuses only an
    // explicit `false`, and this surface cannot know the answer, so it makes no claim.
    render();
    harness?.setField('contact.phone', 'x');
    await nextCall();
    harness?.appendLine('Notes', 'y');
    harness?.forgetField('contact.phone');
    harness?.undoField('contact.phone');
    for (let i = 0; i < 20 && calls.length < 4; i += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
    expect(calls.length).toBe(4);
    for (const call of calls) {
      const input = call.input as Record<string, unknown>;
      expect(input.authority, `${call.verb} omitted authority`).toBe(AUTHORITY);
      expect('explicitUserRequest' in input, `${call.verb} sent explicitUserRequest`).toBe(false);
    }
  });
});

/**
 * Every profile mutation's body conforms to the input the CONTRACT declares for its id.
 *
 * The check reads OPERATOR_CONTRACT's own `inputSchema` rather than a list written here,
 * so it re-derives itself on every pin bump: when the SDK renames, retires or requires a
 * property, this fails without anyone remembering to update an expectation. That is the
 * point, the two contract changes that broke this surface (`authority` becoming required,
 * and `forget` moving off `lineIndex`) both produced zero type errors, because the
 * generated input for an id can be a catch-all and because excess properties are only
 * rejected on fresh object literals.
 *
 * Note `additionalProperties: false` on these schemas: a property the contract does not
 * declare is a rejection, not a harmless extra.
 */
describe('the request bodies conform to the declared contract input', () => {
  interface JsonSchema {
    properties?: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean;
  }

  function inputSchemaFor(methodId: string): JsonSchema {
    const method = OPERATOR_CONTRACT.operator.methods.find((entry) => entry.id === methodId);
    if (!method) throw new Error(`${methodId} is not in the operator contract`);
    return (method.inputSchema ?? {}) as JsonSchema;
  }

  function assertConforms(methodId: string, body: unknown): void {
    const schema = inputSchemaFor(methodId);
    const declared = new Set(Object.keys(schema.properties ?? {}));
    const sent = Object.keys(body as Record<string, unknown>);
    for (const key of sent) {
      expect(declared.has(key), `${methodId} sends "${key}", which its input schema does not declare`).toBe(true);
    }
    for (const key of schema.required ?? []) {
      expect(sent.includes(key), `${methodId} omits required "${key}"`).toBe(true);
    }
  }

  test('profile.set', async () => {
    render();
    harness?.setField('contact.phone', '+1 517 555 0199');
    assertConforms('profile.set', (await nextCall()).input);
  });

  test('profile.append', async () => {
    render();
    harness?.appendLine('People', 'Ken, neighbour');
    assertConforms('profile.append', (await nextCall()).input);
  });

  test('profile.forget, addressing a mechanical field', async () => {
    render();
    harness?.forgetField('contact.phone');
    assertConforms('profile.forget', (await nextCall()).input);
  });

  test('profile.forget, addressing a note by its content', async () => {
    render();
    harness?.forgetLine('People', 'Sarah, sister, sarah@example.com');
    assertConforms('profile.forget', (await nextCall()).input);
  });

  test('profile.undo', async () => {
    render();
    harness?.undoField('commerce.shippingAddress');
    assertConforms('profile.undo', (await nextCall()).input);
  });

  test('the schemas this asserts against really are strict about unknown properties', () => {
    // If additionalProperties ever stopped being false, the assertions above would still
    // pass while the daemon quietly accepted junk, so the strictness itself is pinned.
    for (const id of ['profile.set', 'profile.append', 'profile.forget', 'profile.undo']) {
      expect(inputSchemaFor(id).additionalProperties, `${id} input schema`).toBe(false);
    }
  });
});
