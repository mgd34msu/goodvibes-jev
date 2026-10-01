/**
 * ListDetail mode="peek": the list keeps the full width, the detail opens as the
 * labelled right glass Drawer (portaled), its DetailPane close button and Escape
 * both close it, and with no detail open nothing floats.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DetailPane, ListDetail } from './DataView';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closes = 0;

function render(open: boolean, mode: 'split' | 'peek' = 'peek'): void {
  flushSync(() => {
    root.render(
      <ListDetail
        mode={mode}
        list={<ul><li><button type="button">Row one</button></li></ul>}
        detailOpen={open}
        onCloseDetail={() => { closes += 1; }}
        listLabel="Events"
        detailLabel="Event detail"
        detail={(
          <DetailPane title="Design review" onClose={() => { closes += 1; }} closeLabel="Close event">
            <p>Room B</p>
          </DetailPane>
        )}
      />,
    );
  });
}

beforeEach(() => {
  closes = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('ListDetail peek mode', () => {
  test('closed: the list fills the page and no drawer exists', () => {
    render(false);
    expect(container.querySelector('.dv-list')).not.toBeNull();
    expect(document.querySelector('.dv-peek')).toBeNull();
  });

  test('open: the detail is a labelled drawer outside the list, the list stays', () => {
    render(true);
    const drawer = document.querySelector('.dv-peek')!;
    expect(drawer.getAttribute('aria-label')).toBe('Event detail');
    expect(container.contains(drawer)).toBe(false);
    expect(drawer.textContent).toContain('Design review');
    expect(container.querySelector('.dv-list')?.textContent).toContain('Row one');
  });

  test('the pane close button and Escape close it', () => {
    render(true);
    flushSync(() => (document.querySelector('.dv-peek button[aria-label="Close event"]') as HTMLButtonElement).click());
    expect(closes).toBe(1);
    const inside = document.querySelector('.dv-peek p')!;
    flushSync(() => { inside.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(closes).toBe(2);
  });

  test('split mode keeps the detail inline as the second pane', () => {
    render(true, 'split');
    expect(document.querySelector('.dv-peek')).toBeNull();
    expect(container.querySelector('.dv-detail')?.textContent).toContain('Design review');
  });
});
