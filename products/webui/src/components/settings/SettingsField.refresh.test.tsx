import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ConfigFieldModel } from '../../lib/settings-model';
import { SettingsField } from './SettingsField';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function render(field: ConfigFieldModel, onCommit: (key: string, value: unknown) => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const rerender = (next: ConfigFieldModel) => flushSync(() => root.render(
    <SettingsField field={next} onCommit={onCommit} />,
  ));
  rerender(field);
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  return {
    container, rerender,
    input: () => container.querySelector('input')!,
    button: (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === label)!,
  };
}

function field(type: 'string' | 'number', value: unknown, money = false): ConfigFieldModel {
  return {
    key: money ? 'payments.budget.dailyItem' : type === 'string' ? 'provider.systemPromptFile' : 'display.collapseThreshold',
    type, default: value, liveValue: value, present: true, description: '',
    isSecret: false, daemonOwned: false, secretStoreOnly: false,
    ...(money ? { unit: 'money' as const } : {}),
  };
}

function type(input: HTMLInputElement, value: string): void {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function blur(input: HTMLInputElement): void {
  flushSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}
function click(button: HTMLButtonElement): void {
  flushSync(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
function escape(input: HTMLInputElement): void {
  flushSync(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
}
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

for (const fixture of [
  { name: 'string', field: field('string', 'original'), latest: 'remote', edit: 'mine', value: 'mine' },
  { name: 'number', field: field('number', 30), latest: 50, edit: '42', value: 42 },
  { name: 'money', field: field('number', 100, true), latest: 200, edit: '$150', value: 150 },
]) {
  describe(`${fixture.name} config draft ownership`, () => {
    test('an untouched mounted input follows refresh and blur never writes the old value', () => {
      const writes: unknown[] = [];
      const view = render(fixture.field, async (_key, value) => { writes.push(value); });
      view.rerender({ ...fixture.field, liveValue: fixture.latest });
      expect(view.input().value).toBe(String(fixture.latest));
      blur(view.input());
      blur(view.input());
      expect(writes).toEqual([]);
    });

    test('a field follows deletion back to its default without writing', () => {
      const writes: unknown[] = [];
      const view = render({ ...fixture.field, liveValue: fixture.latest }, async (_key, value) => { writes.push(value); });
      view.rerender({ ...fixture.field, present: false, liveValue: undefined });
      expect(view.input().value).toBe(String(fixture.field.default));
      blur(view.input());
      expect(writes).toEqual([]);
    });

    test('a dirty refresh retains the edit but requires explicit overwrite', async () => {
      const writes: unknown[] = [];
      const view = render(fixture.field, async (_key, value) => { writes.push(value); });
      type(view.input(), fixture.edit);
      view.rerender({ ...fixture.field, liveValue: fixture.latest });
      expect(view.input().value).toBe(fixture.edit);
      expect(view.container.textContent).toContain('This setting changed elsewhere');
      blur(view.input());
      expect(writes).toEqual([]);
      click(view.button('Save my edit'));
      await settle();
      expect(writes).toEqual([fixture.value]);
      expect(view.input().value).toBe(String(fixture.value));
      blur(view.input());
      expect(writes).toHaveLength(1);
    });

    test('Use latest and Escape cancel a dirty draft without a blur write', () => {
      const writes: unknown[] = [];
      const view = render(fixture.field, async (_key, value) => { writes.push(value); });
      type(view.input(), fixture.edit);
      view.rerender({ ...fixture.field, liveValue: fixture.latest });
      click(view.button('Use latest'));
      expect(view.input().value).toBe(String(fixture.latest));
      type(view.input(), fixture.edit);
      escape(view.input());
      blur(view.input());
      expect(writes).toEqual([]);
      expect(view.input().value).toBe(String(fixture.latest));
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    });

    test('repeated blur during and after a save sends only one write', async () => {
      const pending = Promise.withResolvers<undefined>();
      const writes: unknown[] = [];
      const view = render(fixture.field, (_key, value) => { writes.push(value); return pending.promise; });
      type(view.input(), fixture.edit);
      blur(view.input());
      blur(view.input());
      expect(view.input().disabled).toBe(true);
      expect(writes).toEqual([fixture.value]);
      pending.resolve(undefined);
      await settle();
      expect(view.input().disabled).toBe(false);
      blur(view.input());
      expect(writes).toHaveLength(1);
      expect(view.input().value).toBe(String(fixture.value));
    });

    test('a successful save without a prop echo becomes the next edit baseline', async () => {
      const writes: unknown[] = [];
      const view = render(fixture.field, async (_key, value) => { writes.push(value); });
      type(view.input(), fixture.edit);
      blur(view.input());
      await settle();
      type(view.input(), String(fixture.field.liveValue));
      blur(view.input());
      await settle();
      expect(writes).toEqual([fixture.value, fixture.field.liveValue]);
      expect(view.input().value).toBe(String(fixture.field.liveValue));
    });

    test('a delayed echo of the previous save does not conflict with the next edit', async () => {
      const writes: unknown[] = [];
      const next = typeof fixture.value === 'number' ? fixture.value + 1 : `${fixture.value}-again`;
      const view = render(fixture.field, async (_key, value) => { writes.push(value); });
      type(view.input(), fixture.edit);
      blur(view.input());
      await settle();
      type(view.input(), String(next));
      view.rerender({ ...fixture.field, liveValue: fixture.value });
      expect(view.input().value).toBe(String(next));
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      blur(view.input());
      await settle();
      expect(writes).toEqual([fixture.value, next]);
    });

    test('a delayed echo of the previous save cannot retire a newer pending save', async () => {
      const pending = Promise.withResolvers<undefined>();
      const writes: unknown[] = [];
      const next = typeof fixture.value === 'number' ? fixture.value + 1 : `${fixture.value}-again`;
      const view = render(fixture.field, async (_key, value) => {
        writes.push(value);
        if (writes.length === 2) await pending.promise;
      });
      type(view.input(), fixture.edit);
      blur(view.input());
      await settle();
      type(view.input(), String(next));
      blur(view.input());
      view.rerender({ ...fixture.field, liveValue: fixture.value });
      pending.resolve(undefined);
      await settle();
      expect(view.input().value).toBe(String(next));
      expect(writes).toEqual([fixture.value, next]);
      blur(view.input());
      expect(writes).toHaveLength(2);
    });

    test('Escape consumes a dirty edit but leaves clean-field dialog dismissal alone', () => {
      const view = render(fixture.field, async () => {});
      function pressEscape(): KeyboardEvent {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        flushSync(() => view.input().dispatchEvent(event));
        return event;
      }
      expect(pressEscape().defaultPrevented).toBe(false);
      type(view.input(), fixture.edit);
      expect(pressEscape().defaultPrevented).toBe(true);
      expect(view.input().value).toBe(String(fixture.field.liveValue));
      expect(pressEscape().defaultPrevented).toBe(false);
    });

    test('a newer refresh wins over late successful save completion', async () => {
      const pending = Promise.withResolvers<undefined>();
      const writes: unknown[] = [];
      const view = render(fixture.field, (_key, value) => { writes.push(value); return pending.promise; });
      type(view.input(), fixture.edit);
      blur(view.input());
      view.rerender({ ...fixture.field, liveValue: fixture.value });
      view.rerender({ ...fixture.field, liveValue: fixture.latest });
      pending.resolve(undefined);
      await settle();
      expect(view.input().value).toBe(String(fixture.latest));
      blur(view.input());
      expect(writes).toEqual([fixture.value]);
    });

    test('refresh away and back during a save is still newer than the submitted draft', async () => {
      const pending = Promise.withResolvers<undefined>();
      const view = render(fixture.field, () => pending.promise);
      type(view.input(), fixture.edit);
      blur(view.input());
      view.rerender({ ...fixture.field, liveValue: fixture.latest });
      view.rerender(fixture.field);
      pending.resolve(undefined);
      await settle();
      expect(view.input().value).toBe(String(fixture.field.liveValue));
    });

    test('a failed save retains the edit and can be retried', async () => {
      const writes: unknown[] = [];
      const view = render(fixture.field, async (_key, value) => {
        writes.push(value);
        if (writes.length === 1) throw new Error('Config write rejected');
      });
      type(view.input(), fixture.edit);
      blur(view.input());
      await settle();
      expect(view.input().value).toBe(fixture.edit);
      expect(view.container.textContent).toContain('Config write rejected');
      blur(view.input());
      await settle();
      expect(writes).toEqual([fixture.value, fixture.value]);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    });

    test('refresh during a failed save preserves the edit as a conflict, never a silent retry', async () => {
      const pending = Promise.withResolvers<undefined>();
      const writes: unknown[] = [];
      const view = render(fixture.field, (_key, value) => { writes.push(value); return pending.promise; });
      type(view.input(), fixture.edit);
      blur(view.input());
      view.rerender({ ...fixture.field, liveValue: fixture.latest });
      pending.reject(new Error('Config write rejected'));
      await settle();
      expect(view.input().value).toBe(fixture.edit);
      expect(view.container.textContent).toContain('This setting changed elsewhere');
      blur(view.input());
      expect(writes).toHaveLength(1);
    });
  });
}

test('a secret replacement stays write-only across refresh and Cancel clears its edit and error', async () => {
  const secret = { ...field('string', 'stored-secret'), isSecret: true, key: 'surfaces.slack.botToken' };
  const view = render(secret, async () => { throw new Error('Replacement rejected'); });
  expect(view.container.querySelector('input')).toBeNull();
  click(view.button('Replace'));
  expect(view.input().value).toBe('');
  type(view.input(), 'new-secret');
  view.rerender({ ...secret, liveValue: 'newer-stored-secret' });
  expect(view.input().value).toBe('new-secret');
  click(view.button('Save'));
  await settle();
  expect(view.container.textContent).toContain('Replacement rejected');
  click(view.button('Cancel'));
  expect(view.container.querySelector('input')).toBeNull();
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  click(view.button('Replace'));
  expect(view.input().value).toBe('');
});
