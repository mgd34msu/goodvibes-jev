import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../lib/toast';
import { CONFIG_SCHEMA_ENTRIES } from '../../../lib/generated/config-schema';

type ConfigOutcome = 'ok' | 'admin-required' | 'network-error';
let outcome: ConfigOutcome = 'ok';
const configSetCalls: [string, unknown][] = [];
// Controls what sdk.operator.config.set does, independent of `outcome` above (which only
// governs config.get). 'reject' simulates the real requestJson behavior on a non-2xx or
// network failure, a rejected promise, never a resolved { success: false }.
type SetOutcome = 'ok' | 'reject';
let setOutcome: SetOutcome = 'ok';

// Enough of a live config to exercise: a typed string field
// (provider.systemPromptFile), the engine-declared display.theme field,
// a typed number field (display.collapseThreshold), a secret owned by a feature
// unit (surfaces.slack.botToken → slack-surface), and a flag override read.
const CONFIG_FIXTURE = {
  display: { theme: 'nord', collapseThreshold: 30 },
  provider: { systemPromptFile: 'prompts/system.md' },
  surfaces: {
    slack: { botToken: 'xoxb-super-secret-value-1234' },
    // secret-store-only-config-keys.ts: the daemon's mail connector never reads
    // this value from config (surface-config.ts resolves the password only
    // from the secret store), used below to prove the field refuses to write
    // it rather than offering a Replace flow that cannot work.
    email: { password: 'nine-nine-nine-plaintext' },
  },
  behavior: { hitlMode: 'balanced' },
};

// Card material never appears in this fixture and never can: the daemon exposes
// no method that returns it, so cards.list answers with metadata only. The card
// panel under Payments calls list() on mount, which is why it is stubbed here.
const cardsListCalls: string[] = [];

mock.module('../../../lib/goodvibes', () => ({
  sdk: {
    operator: {
      payments: {
        cards: {
          list: () => {
            cardsListCalls.push('list');
            return Promise.resolve({ cards: [] });
          },
          create: () => Promise.resolve({ card: null }),
          delete: () => Promise.resolve({ id: '', deleted: true, secretsCleared: 0 }),
        },
      },
      config: {
        get: () => {
          if (outcome === 'admin-required') {
            const err = new Error('Admin role required') as Error & { status?: number };
            err.status = 403;
            return Promise.reject(err);
          }
          if (outcome === 'network-error') {
            return Promise.reject(new Error('Failed to fetch'));
          }
          return Promise.resolve(CONFIG_FIXTURE);
        },
        set: (key: string, value: unknown) => {
          configSetCalls.push([key, value]);
          if (setOutcome === 'reject') {
            return Promise.reject(
              Object.assign(new Error('POST /config failed: 409 Conflict'), { status: 409 }),
            );
          }
          // daemonOwned surfaces.* keys report a daemon-tier persistedTo; everything
          // else reports the ordinary client settings path, mirrors system-routes.ts.
          const daemonOwned = key.startsWith('surfaces.');
          return Promise.resolve({
            success: true,
            key,
            value,
            persistedTo: daemonOwned ? '/home/user/.goodvibes/daemon/settings.json' : '/home/user/.goodvibes/webui/settings.json',
            tier: daemonOwned ? 'daemon' : 'default',
            daemonOwned,
          });
        },
      },
    },
  },
}));

const { ConfigSettingsProvider, ConfigGroupList, RawConfigEditor, useConfigSettings } = await import('./ConfigSettings');
const { groupsForSection, sectionForNamespace } = await import('./sections');

/**
 * Test harness: the real provider and group renderer, with a small category
 * nav standing in for the dialog's section nav. Picking a category renders the
 * settings-dialog SECTION that owns that namespace (sections.ts), exactly the
 * groups the dialog would show there, so the namespace-to-section mapping is
 * exercised too.
 */
function Harness() {
  const { groups } = useConfigSettings();
  const [picked, setPicked] = React.useState('');
  const current = groups.find((g) => g.label === picked) ?? groups[0];
  const shown = current ? groupsForSection(sectionForNamespace(current.id), groups) : [];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'nav',
      null,
      groups.map((g) => React.createElement('button', {
        key: g.id,
        type: 'button',
        className: 'settings-category',
        onClick: () => setPicked(g.label),
      }, g.label)),
    ),
    React.createElement(ConfigGroupList, { groups: shown }),
    React.createElement(RawConfigEditor),
  );
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(ConfigSettingsProvider, null, React.createElement(Harness)),
        ),
      ),
    );
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

function clickCategory(el: HTMLElement, label: string): void {
  const tab = [...el.querySelectorAll('.settings-category')].find((b) => b.textContent === label);
  flushSync(() => {
    tab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

/** A plain client-owned string key in the engine schema. */
const STRING_KEY = 'provider.systemPromptFile';

async function openStringField(el: HTMLElement): Promise<void> {
  await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Provider')));
  clickCategory(el, 'Provider');
  await waitFor(() => Boolean(el.querySelector(`[data-config-key="${STRING_KEY}"] input`)));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  flushSync(() => {
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/** Open a kit Select and return its option labels (the listbox is portaled to body). */
function openSelect(trigger: HTMLButtonElement): string[] {
  flushSync(() => { trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  return [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent ?? '');
}

function pickOption(label: string): void {
  const option = [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].find((o) => o.textContent === label);
  flushSync(() => { option?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

// React 19 delegates onBlur to the bubbling `focusout` event at the root.
function commitByBlur(input: HTMLInputElement): void {
  flushSync(() => input.dispatchEvent(new window.Event('focusout', { bubbles: true })));
}

afterEach(() => {
  outcome = 'ok';
  setOutcome = 'ok';
  configSetCalls.length = 0;
});

describe('settings config groups: schema-driven structure', () => {

  test('a schema string key renders as a typed input carrying its live value', async () => {
    const { el, unmount } = render();
    await openStringField(el);
    const input = el.querySelector(`[data-config-key="${STRING_KEY}"] input`) as HTMLInputElement;
    expect(input.value).toBe('prompts/system.md');
    unmount();
  });

  test('editing a schema key commits the typed value through config.set', async () => {
    const { el, unmount } = render();
    await openStringField(el);
    const input = el.querySelector(`[data-config-key="${STRING_KEY}"] input`) as HTMLInputElement;
    setInputValue(input, 'prompts/other.md');
    commitByBlur(input);
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([[STRING_KEY, 'prompts/other.md']]);
    unmount();
  });

  test('display.theme uses the generated enum choices and commits a canonical selection', async () => {
    const { el, unmount } = render();
    const selector = '[data-config-key="display.theme"] .gv-select__trigger';
    await waitFor(() => Boolean(el.querySelector(selector)));
    const control = el.querySelector(selector) as HTMLButtonElement;
    expect(control.textContent).toContain('nord');
    const schema = CONFIG_SCHEMA_ENTRIES.find((entry) => entry.key === 'display.theme')!;
    expect(schema.type).toBe('enum');
    expect(schema.default).toBe('goodvibes');
    expect(openSelect(control)).toEqual([...schema.enumValues ?? []]);
    pickOption('goodvibes');
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([['display.theme', 'goodvibes']]);
    unmount();
  });

  test('a number key commits a parsed finite number, not a string', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-config-key="display.collapseThreshold"] input')));
    const input = el.querySelector('[data-config-key="display.collapseThreshold"] input') as HTMLInputElement;
    setInputValue(input, '42');
    commitByBlur(input);
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([['display.collapseThreshold', 42]]);
    unmount();
  });
});

describe('settings config groups: feature units', () => {
  test('a secret key owned by a feature unit is masked, never raw, showing only its last four', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Surfaces')));
    clickCategory(el, 'Surfaces');
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="slack-surface"]')));
    const tokenField = el.querySelector('[data-config-key="surfaces.slack.botToken"]') as HTMLElement;
    expect(tokenField).toBeTruthy();
    expect(tokenField.textContent).not.toContain('xoxb-super-secret-value-1234');
    expect(tokenField.textContent).toContain('1234'); // last 4 only
    unmount();
  });

  test('toggling a boolean feature writes true/false to its domain settings key', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Permissions')));
    clickCategory(el, 'Permissions');
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="permissions-simulation"] .feature-unit-toggle')));
    const toggle = el.querySelector('[data-feature-id="permissions-simulation"] .feature-unit-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true'); // ruled default: on
    flushSync(() => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([['permissions.simulation', false]]);
    unmount();
  });

  test('a restart-gated feature shows the pending-restart marker after its enablement changes', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Permissions')));
    clickCategory(el, 'Permissions');
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="permissions-simulation"] .feature-unit-toggle')));
    const unit = el.querySelector('[data-feature-id="permissions-simulation"]') as HTMLElement;
    // permissions-simulation is restart-gated; no marker before any change.
    expect(unit.querySelector('[data-pending-restart]')).toBeNull();
    const toggle = unit.querySelector('.feature-unit-toggle') as HTMLButtonElement;
    flushSync(() => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => Boolean(el.querySelector('[data-pending-restart="permissions-simulation"]')));
    unmount();
  });

  test('changing an enum feature mode writes the mode value to its domain settings key', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Behavior')));
    clickCategory(el, 'Behavior');
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="hitl-ux-modes"] .gv-select__trigger')));
    const trigger = el.querySelector('[data-feature-id="hitl-ux-modes"] .gv-select__trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('balanced'); // live fixture value
    // The full schema mode set is offered, inactive "off" included.
    expect(openSelect(trigger)).toEqual(['off', 'quiet', 'balanced', 'operator']);
    pickOption('quiet');
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([['behavior.hitlMode', 'quiet']]);
    unmount();
  });

  test('a runtime-toggleable feature never shows a pending-restart marker after a change', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Behavior')));
    clickCategory(el, 'Behavior');
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="hitl-ux-modes"] .gv-select__trigger')));
    const trigger = el.querySelector('[data-feature-id="hitl-ux-modes"] .gv-select__trigger') as HTMLButtonElement;
    openSelect(trigger);
    pickOption('operator');
    await waitFor(() => configSetCalls.length > 0);
    expect(el.querySelector('[data-pending-restart]')).toBeNull();
    unmount();
  });

});

describe('settings config groups: secret-store-only credentials refuse a config.set write', () => {
  test('surfaces.email.password is masked and offers no password input', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Surfaces')));
    clickCategory(el, 'Surfaces');
    await waitFor(() => Boolean(el.querySelector('[data-config-key="surfaces.email.password"]')));
    const field = el.querySelector('[data-config-key="surfaces.email.password"]') as HTMLElement;
    // Never the raw value.
    expect(field.textContent).not.toContain('nine-nine-nine-plaintext');
    // No write path at all for this key, no Replace button, no password input.
    expect(field.querySelector('input[type="password"]')).toBeNull();
    unmount();
  });

  test('the Advanced escape hatch refuses a secret-store-only key too, and never calls config.set', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('.settings-advanced input')));
    const keyInput = el.querySelector('.settings-advanced input') as HTMLInputElement;
    const valueTextarea = el.querySelector('.settings-advanced textarea') as HTMLTextAreaElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(keyInput, 'surfaces.calendar.caldavPassword');
      keyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      taSetter?.call(valueTextarea, '"a-plaintext-caldav-password"');
      valueTextarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = el.querySelector('.settings-advanced form') as HTMLFormElement;
    flushSync(() => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => Boolean(el.querySelector('.settings-advanced .banner.warning')));
    expect(configSetCalls).toEqual([]);
    unmount();
  });
});

describe('settings config groups: Advanced unschema\'d escape hatch', () => {
  test('saving a key/value calls config.set with the parsed value', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('.settings-advanced input')));
    const keyInput = el.querySelector('.settings-advanced input') as HTMLInputElement;
    const valueTextarea = el.querySelector('.settings-advanced textarea') as HTMLTextAreaElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(keyInput, 'display.theme');
      keyInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      taSetter?.call(valueTextarea, '"dracula"');
      valueTextarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = el.querySelector('.settings-advanced form') as HTMLFormElement;
    flushSync(() => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([['display.theme', 'dracula']]);
    unmount();
  });
});

describe('settings config groups: object-typed pricing editor', () => {
  test('pricing.modelPrices renders the structured per-model editor, not a JSON textarea', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Pricing')));
    clickCategory(el, 'Pricing');
    await waitFor(() => Boolean(el.querySelector('[data-config-key="pricing.modelPrices"]')));
    const field = el.querySelector('[data-config-key="pricing.modelPrices"]') as HTMLElement;
    // Full description renders, the structured editor mounts, and no blob textarea exists.
    expect(field.querySelector('[data-testid="model-prices-editor"]')).not.toBeNull();
    expect(field.querySelector('textarea')).toBeNull();
    unmount();
  });
});

describe('settings config groups: daemon-owned labeling', () => {

  test('after a successful save, the row shows what the daemon reported in persistedTo', async () => {
    const { el, unmount } = render();
    await openStringField(el);
    const input = el.querySelector(`[data-config-key="${STRING_KEY}"] input`) as HTMLInputElement;
    setInputValue(input, 'prompts/other.md');
    commitByBlur(input);
    await waitFor(() => Boolean(el.querySelector(`[data-config-key="${STRING_KEY}"] .settings-field-persisted`)));
    const note = el.querySelector(`[data-config-key="${STRING_KEY}"] .settings-field-persisted`);
    expect(note?.textContent).toContain('/home/user/.goodvibes/webui/settings.json');
    unmount();
  });
});

describe('settings config groups: a failed config.set is surfaced, never rendered as saved', () => {
  test('a rejected config.set keeps the row showing the OLD value and shows an inline error', async () => {
    setOutcome = 'reject';
    const { el, unmount } = render();
    await openStringField(el);
    const input = el.querySelector(`[data-config-key="${STRING_KEY}"] input`) as HTMLInputElement;
    setInputValue(input, 'prompts/other.md');
    commitByBlur(input);
    await waitFor(() => configSetCalls.length > 0);
    // The write was attempted...
    expect(configSetCalls).toEqual([[STRING_KEY, 'prompts/other.md']]);
    // ...but rejected, so the row surfaces the failure inline rather than pretending success.
    await waitFor(() => Boolean(el.querySelector(`[data-config-key="${STRING_KEY}"] .settings-field-error`)));
    const errorBanner = el.querySelector(`[data-config-key="${STRING_KEY}"] .settings-field-error`);
    expect(errorBanner?.textContent?.length ?? 0).toBeGreaterThan(0);
    // No persisted-to note ever appears for a failed write.
    expect(el.querySelector(`[data-config-key="${STRING_KEY}"] .settings-field-persisted`)).toBeNull();
    unmount();
  });

  test('a rejected config.set on a boolean feature toggle reverts the visible state, not just the store', async () => {
    setOutcome = 'reject';
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Permissions')));
    clickCategory(el, 'Permissions');
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="permissions-simulation"] .feature-unit-toggle')));
    const toggle = el.querySelector('[data-feature-id="permissions-simulation"] .feature-unit-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true'); // ruled default: on
    flushSync(() => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => configSetCalls.length > 0);
    // The write was attempted and rejected; the failure surfaces on the unit, and no
    // pending-restart marker (which only follows a CONFIRMED write) ever appears.
    await waitFor(() => Boolean(el.querySelector('[data-feature-id="permissions-simulation"] .banner.warning')));
    expect(el.querySelector('[data-pending-restart="permissions-simulation"]')).toBeNull();
    // config.get was never invalidated on failure, so the toggle still reflects the
    // daemon's actual (unchanged) value, not an optimistically-applied one.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    unmount();
  });
});

/**
 * Card entry is actually reachable in the real settings surface.
 *
 * Without this, PaymentCardEntry could be a correct component nobody can get
 * to, every one of its own tests would still pass. These drive the real group
 * renderer: pick the Payments category (its settings section), and check the
 * panel is there, that it is scoped to that section, and that no card value is
 * displayed.
 */
describe('the Payments category offers card entry', () => {
  test('the card panel renders under Payments', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Payments')));
    clickCategory(el, 'Payments');
    await waitFor(() => Boolean(el.querySelector('[data-testid="payment-card-entry"]')));

    expect(el.querySelector('[data-testid="payment-card-entry"]')).not.toBeNull();
    // The panel is live, not inert markup: it asked the daemon for the cards on file.
    expect(cardsListCalls.length).toBeGreaterThan(0);
    // All four card fields are present and typeable.
    for (const id of ['gv-card-number', 'gv-card-expiry', 'gv-card-cvv', 'gv-card-holder']) {
      const input = el.querySelector(`#${id}`) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input!.disabled).toBe(false);
    }
    unmount();
  });

  test('the panel belongs to Payments only. It does not follow you to another section', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Payments')));
    clickCategory(el, 'Payments');
    await waitFor(() => Boolean(el.querySelector('[data-testid="payment-card-entry"]')));

    clickCategory(el, 'Display');
    expect(el.querySelector('[data-testid="payment-card-entry"]')).toBeNull();
    unmount();
  });

  test('the Payments category shows the card panel and the ordinary payment settings together', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Payments')));
    clickCategory(el, 'Payments');
    await waitFor(() => Boolean(el.querySelector('[data-testid="payment-card-entry"]')));

    // The card panel sits alongside the settings the previous round shipped,
    // it did not displace them.
    expect(el.querySelector('[data-testid="payment-card-entry"]')).not.toBeNull();
    expect(el.querySelector('[data-config-key="payments.cvvHandling"]')).not.toBeNull();
    unmount();
  });

  test('no card-material config key renders as a row anywhere in the section', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean([...el.querySelectorAll('.settings-category')].some((b) => b.textContent === 'Payments')));
    clickCategory(el, 'Payments');
    await waitFor(() => Boolean(el.querySelector('[data-testid="payment-card-entry"]')));

    for (const key of ['payments.cardNumber', 'payments.cardCvv', 'payments.cardExpiry', 'payments.cardholderName']) {
      expect(el.querySelector(`[data-config-key="${key}"]`)).toBeNull();
    }
    unmount();
  });
});
