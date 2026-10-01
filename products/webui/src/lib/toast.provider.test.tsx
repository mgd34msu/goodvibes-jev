import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ToastProvider, useToastContext } from './toast';

let ctx: ReturnType<typeof useToastContext> | null = null;
function Capture(): null {
  ctx = useToastContext();
  return null;
}

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

afterEach(() => {
  flushSync(() => root.render(null));
  ctx = null;
});

describe('ToastProvider durations (design doc "Toast")', () => {
  test('ordinary toasts leave after 5 s; errors stay until dismissed', () => {
    flushSync(() => root.render(<ToastProvider><Capture /></ToastProvider>));
    flushSync(() => { ctx?.toast({ title: 'Model switched' }); });
    flushSync(() => { ctx?.toast({ title: 'Could not save', tone: 'danger' }); });
    flushSync(() => { ctx?.toast({ title: 'Warning', tone: 'warning' }); });
    const byTitle = new Map(ctx?.toasts.map((t) => [t.title, t.durationMs]));
    expect(byTitle.get('Model switched')).toBe(5000);
    expect(byTitle.get('Could not save')).toBe(0);
    expect(byTitle.get('Warning')).toBe(5000);
  });

  test('an explicit duration still wins for an error', () => {
    flushSync(() => root.render(<ToastProvider><Capture /></ToastProvider>));
    flushSync(() => { ctx?.toast({ title: 'Brief error', tone: 'danger', durationMs: 3000 }); });
    expect(ctx?.toasts[0]?.durationMs).toBe(3000);
  });
});
