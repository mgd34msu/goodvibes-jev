/**
 * RecordList: one row per record (title, id, status word), rows are buttons
 * only when a selection handler exists, the selected row is marked for
 * assistive tech, and an empty list reads as a sentence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RecordList } from './RecordList';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(element));
  return container;
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const rows = (el: HTMLElement) => [...el.querySelectorAll('li')];

describe('RecordList', () => {
  test('an empty list renders no rows', () => {
    const el = render(<RecordList items={[]} />);
    expect(rows(el)).toHaveLength(0);
  });

  test('a custom empty sentence is rendered', () => {
    const el = render(<RecordList items={[]} empty="Nothing here" />);
    expect(el.textContent).toContain('Nothing here');
  });

  test('every record is one row carrying its title, id and status word', () => {
    const el = render(<RecordList items={[
      { id: 'r1', name: 'First', status: 'healthy' },
      { id: 'r2', name: 'Second', status: 'failed' },
      { id: 'r3', name: 'Third' },
    ]} />);
    const texts = rows(el).map((li) => li.textContent ?? '');
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('First');
    expect(texts[0]).toContain('r1');
    expect(texts[0]).toContain('healthy');
    expect(texts[1]).toContain('failed');
    expect(texts[2]).toContain('Third');
  });

  test('a record with no id field shows its index as the id', () => {
    const el = render(<RecordList items={[{ name: 'No ID Item' }]} />);
    const row = rows(el)[0];
    expect(row.textContent).toContain('No ID Item');
    // The id line shows the index, as its own text node.
    expect([...row.querySelectorAll('span')].some((span) => span.textContent === '0')).toBe(true);
  });

  test('without onSelect the rows are static, with it each row is a button that reports its id', () => {
    const plain = render(<RecordList items={[{ id: 'x', name: 'Item' }]} />);
    expect(plain.querySelector('button')).toBeNull();
    flushSync(() => root.unmount());
    container.remove();

    const picked: string[] = [];
    const el = render(<RecordList items={[{ id: 'sel-1', name: 'Alpha' }, { id: 'sel-2', name: 'Beta' }]} onSelect={(id) => picked.push(id)} />);
    const buttons = [...el.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    flushSync(() => buttons[1].click());
    flushSync(() => buttons[0].click());
    expect(picked).toEqual(['sel-2', 'sel-1']);
  });

  test('only the selected row is marked current', () => {
    const el = render(<RecordList items={[{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]} selectedId="b" onSelect={() => {}} />);
    const current = [...el.querySelectorAll('[aria-current]')];
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('B');
  });
});
