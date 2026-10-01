import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Menu, MenuCheckboxItem, MenuItem, MenuRadioGroup, MenuSeparator } from './Menu';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const picked: string[] = [];
let theme: 'light' | 'dark' | 'auto' = 'dark';
let neon = false;

function key(target: Element, k: string): void {
  flushSync(() => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

function renderMenu(): void {
  flushSync(() => {
    root.render(
      <Menu label="Account" trigger={(props) => <button {...props} type="button">Account</button>}>
        <MenuItem onSelect={() => picked.push('settings')}>Settings</MenuItem>
        <MenuItem onSelect={() => picked.push('usage')}>Usage</MenuItem>
        <MenuSeparator />
        <MenuRadioGroup
          label="Theme"
          value={theme}
          options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Auto' }]}
          onChange={(v) => { theme = v; picked.push(`theme:${v}`); }}
        />
        <MenuCheckboxItem checked={neon} onChange={(on) => { neon = on; picked.push(`neon:${String(on)}`); }}>GoodVibes Neon</MenuCheckboxItem>
        <MenuItem onSelect={() => picked.push('signout')}>Sign out</MenuItem>
      </Menu>,
    );
  });
}

function trigger(): HTMLButtonElement {
  return container.querySelector('button') as HTMLButtonElement;
}
function menu(): HTMLElement | null {
  return document.querySelector('[role="menu"]');
}

beforeEach(() => {
  picked.length = 0;
  theme = 'dark';
  neon = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renderMenu();
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('Menu: WAI-ARIA menu pattern', () => {
  test('the trigger advertises the menu and opens it with focus on the first item', () => {
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    flushSync(() => trigger().click());
    expect(menu()?.getAttribute('aria-label')).toBe('Account');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Settings');
  });

  test('arrows move, End jumps, a letter jumps to the matching item', () => {
    flushSync(() => trigger().click());
    const m = menu()!;
    key(m, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Usage');
    key(m, 'End');
    expect(document.activeElement?.textContent).toBe('Sign out');
    key(m, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Settings');
    key(m, 'g');
    expect(document.activeElement?.textContent).toContain('GoodVibes Neon');
  });

  test('Escape closes the menu and returns focus to the trigger', () => {
    flushSync(() => trigger().click());
    key(menu()!, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  test('picking an item runs it and closes the menu', () => {
    flushSync(() => trigger().click());
    const usage = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'Usage') as HTMLElement;
    flushSync(() => usage.click());
    expect(picked).toEqual(['usage']);
    expect(menu()).toBeNull();
  });

  test('the theme radios and the Neon switch act without closing the menu', () => {
    flushSync(() => trigger().click());
    const radios = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    flushSync(() => radios[0].click());
    renderMenu();
    expect(picked).toEqual(['theme:light']);
    const neonItem = document.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
    expect(neonItem.getAttribute('aria-checked')).toBe('false');
    flushSync(() => neonItem.click());
    renderMenu();
    expect(picked).toEqual(['theme:light', 'neon:true']);
    expect(menu()).not.toBeNull();
    expect((document.querySelector('[role="menuitemcheckbox"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
  });

  test('Left and Right move within the radio group', () => {
    flushSync(() => trigger().click());
    const radios = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
    radios[1].focus();
    key(menu()!, 'ArrowRight');
    expect(document.activeElement).toBe(radios[2]);
    key(menu()!, 'ArrowRight');
    expect(document.activeElement).toBe(radios[0]);
  });
});
