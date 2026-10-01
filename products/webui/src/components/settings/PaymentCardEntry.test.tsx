/**
 * PaymentCardEntry, the conditions that live in the markup.
 *
 * Conditions 4 and 5 of the owner's card-entry ruling are properties of the
 * rendered elements themselves, so they are asserted against the real rendered
 * DOM rather than by reading the component source:
 *
 *   4. every card field carries autocomplete="off";
 *   5. the fields must not present as ones a password manager offers to save.
 *
 * Condition 5 has no single attribute, because autocomplete="off" alone is
 * widely ignored by managers. What actually suppresses a save prompt is the
 * combination asserted below: no <form> element to submit, no `name` attribute
 * to match on, no type="password", and the vendor opt-outs the major managers
 * honor. Each is checked separately so a regression names which one broke.
 *
 * The value-containment half of the ruling (conditions 1, 2, 3, 6) is asserted
 * in PaymentCardEntry.containment.test.tsx against real payloads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { PaymentCardEntry } from './PaymentCardEntry';

/** The four inputs that hold card material, the ones every condition is about. */
const CARD_INPUT_IDS = ['gv-card-number', 'gv-card-expiry', 'gv-card-cvv', 'gv-card-holder'] as const;

const originalFetch = globalThis.fetch;

function render(): { container: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ToastProvider, null, React.createElement(PaymentCardEntry, null)),
      ),
    );
  });
  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function cardInputs(container: HTMLElement): HTMLInputElement[] {
  return CARD_INPUT_IDS.map((id) => {
    const input = container.querySelector(`#${id}`) as HTMLInputElement;
    expect(input).not.toBeNull();
    return input;
  });
}

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ cards: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('condition 4: autocomplete="off" on every card field', () => {
  test('all four card inputs carry it', () => {
    const { container, unmount } = render();
    for (const input of cardInputs(container)) {
      expect(input.getAttribute('autocomplete')).toBe('off');
    }
    unmount();
  });

  test('no card input carries an autofill token that would invite the browser to fill it', () => {
    const { container, unmount } = render();
    for (const input of cardInputs(container)) {
      const value = input.getAttribute('autocomplete') ?? '';
      expect(value).not.toContain('cc-');
      expect(value).not.toContain('name');
    }
    unmount();
  });

  test('EVERY input in the panel carries it, not only the four card ones', () => {
    // The label and issuer-cap fields are not card material, but a browser that
    // fills them is still filling a payment form, which is the behaviour the
    // condition is aimed at.
    const { container, unmount } = render();
    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs.length).toBeGreaterThanOrEqual(CARD_INPUT_IDS.length);
    for (const input of inputs) {
      expect(input.getAttribute('autocomplete')).toBe('off');
    }
    unmount();
  });
});

describe('condition 5: not a field a password manager offers to save', () => {
  test('there is no <form> element. A save prompt is overwhelmingly triggered by a form submit', () => {
    const { container, unmount } = render();
    expect(container.querySelector('form')).toBeNull();
    unmount();
  });

  test('the submit control is a plain button, not type="submit"', () => {
    const { container, unmount } = render();
    const button = container.querySelector('[data-testid="payment-card-submit"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('type')).toBe('button');
    unmount();
  });

  test('no card input has a name attribute, the other half of what managers match on', () => {
    const { container, unmount } = render();
    for (const input of cardInputs(container)) {
      expect(input.hasAttribute('name')).toBe(false);
    }
    unmount();
  });

  test('no card input is type="password", the single strongest signal a manager looks for', () => {
    const { container, unmount } = render();
    for (const input of cardInputs(container)) {
      expect(input.getAttribute('type')).not.toBe('password');
    }
    unmount();
  });

  test('the vendor opt-outs the major managers honor are set on every card input', () => {
    const { container, unmount } = render();
    for (const input of cardInputs(container)) {
      expect(input.hasAttribute('data-1p-ignore')).toBe(true);
      expect(input.getAttribute('data-lpignore')).toBe('true');
      expect(input.getAttribute('data-bwignore')).toBe('true');
      expect(input.getAttribute('data-form-type')).toBe('other');
    }
    unmount();
  });

  test('the number and security code are concealed without password semantics', () => {
    const { container, unmount } = render();
    const number = container.querySelector('#gv-card-number') as HTMLInputElement;
    const cvv = container.querySelector('#gv-card-cvv') as HTMLInputElement;
    for (const input of [number, cvv]) {
      expect(input.className).toContain('settings-card-concealed');
      expect(input.getAttribute('type')).toBe('text');
    }
    unmount();
  });

  test('spellcheck and autocorrect are off, so a card number never reaches a dictionary', () => {
    const { container, unmount } = render();
    for (const input of cardInputs(container)) {
      expect(input.getAttribute('spellcheck')).toBe('false');
      expect(input.getAttribute('autocorrect')).toBe('off');
    }
    unmount();
  });
});

describe('the panel is usable and honest', () => {
  test('every card field has an associated label', () => {
    const { container, unmount } = render();
    for (const id of CARD_INPUT_IDS) {
      expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
    unmount();
  });

  test('the kind selector defaults to virtual and says why', () => {
    const { container, unmount } = render();
    // A kit Select: the trigger shows the chosen option's label.
    const select = container.querySelector('#gv-card-kind') as HTMLButtonElement;
    expect(select.getAttribute('aria-haspopup')).toBe('listbox');
    expect(select.textContent).toContain('virtual');
    expect(select.textContent).toContain('recommended');
    unmount();
  });

  test('it states that the values cannot be read back, rather than implying they are viewable', () => {
    const { container, unmount } = render();
    expect(container.textContent).toContain('never shown again');
    expect(container.textContent).toContain('no way to read them back');
    unmount();
  });

  test('the issuer cap is described as declared and unenforceable by us', () => {
    const { container, unmount } = render();
    expect(container.textContent).toContain('cannot verify it and never enforce it');
    unmount();
  });

  test('a validation refusal is shown and names nothing typed', () => {
    const { container, unmount } = render();
    const button = container.querySelector('[data-testid="payment-card-submit"]') as HTMLButtonElement;
    flushSync(() => button.click());
    const error = container.querySelector('[data-testid="payment-card-error"]');
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain('label');
    unmount();
  });
});
