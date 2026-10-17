import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HostedAttachment } from './HostedSessionDetail';
import type { UseHostedSessionRealtimeOptions } from '../../hooks/useHostedSessionRealtime';

const pending: { id: string; client: string; resolve: (result: unknown) => void }[] = [];
const detach = mock(async () => ({}));
const beacon = mock(() => {});
let realtime: UseHostedSessionRealtimeOptions;
const notify = () => {};
mock.module('../../lib/goodvibes', () => ({
  hasStoredTokenSync: () => true,
  GOODVIBES_BASE_URL: 'http://localhost', WEBUI_VERSION: 'test', runBrowserJudgment: async () => { throw new Error('No judgments in this fixture'); },
  getCurrentAuth: async () => ({}), invokeMethod: async () => ({}), hostedSessionDetachBeacon: beacon,
  sdk: { operator: { sessions: { hosted: {
    attach: (id: string, client: string) => new Promise(resolve => pending.push({ id, client, resolve })),
    detach, kill: async () => ({}),
  } } } },
}));
mock.module('../../hooks/useHostedSessionRealtime', () => ({
  useHostedSessionRealtime: (options: UseHostedSessionRealtimeOptions) => { realtime = options; return { connected: true, error: null }; },
}));
mock.module('../../lib/toast', () => ({ useToast: () => ({ toast: notify }) }));
mock.module('../../components/ui/ConfirmDialog', () => ({ useConfirm: () => ({ ask: async () => true, element: null }) }));
const { useHostedAttachment } = await import('./HostedSessionDetail');
const cleanups: (() => void)[] = [];
function mount(id: string) {
  let result!: HostedAttachment;
  const client = new QueryClient();
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  function Harness({ selected }: { selected: string }) { result = useHostedAttachment(selected, [], notify); return null; }
  const render = (selected: string) => flushSync(() => root.render(<QueryClientProvider client={client}><Harness selected={selected}/></QueryClientProvider>));
  render(id);
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  return { render, get result() { return result; } };
}
const reply = (id: string, content = 'history') => ({ session: { id, status: 'idle', updatedAt: 1, effectiveDetachPolicy: 'kill' }, history: [{ role: 'assistant', content }] });
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); };
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); pending.length = 0; detach.mockClear(); beacon.mockClear(); });

test('two live attachments never share ownership, even with legacy browser storage', async () => {
  localStorage.setItem('goodvibes.webui.hosted.clientId', 'legacy-shared');
  mount('a'); mount('a');
  expect(pending[0]!.client).not.toBe(pending[1]!.client);
  pending.forEach(request => request.resolve(reply('a'))); await settle();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(detach).not.toHaveBeenCalled(); expect(beacon).not.toHaveBeenCalled();
});

test('a late attach cannot replace the selection and retires only its own attachment', async () => {
  const h = mount('a'); const old = pending[0]!;
  h.render('b'); const current = pending[1]!;
  current.resolve(reply('b')); await settle();
  old.resolve(reply('a')); await settle();
  expect(h.result.session?.id).toBe('b');
  expect(detach).toHaveBeenCalledWith('a', old.client);
  expect(detach).not.toHaveBeenCalledWith('b', current.client);
});

test('stream recovery replaces missing history without duplicating completed live output', async () => {
  const h = mount('a'); pending[0]!.resolve(reply('a', 'first')); await settle();
  realtime.onReconcile?.();
  expect(pending[1]!.client).toBe(pending[0]!.client);
  pending[1]!.resolve(reply('a', 'recovered terminal reply')); await settle();
  expect(h.result.history.map(message => message.content)).toEqual(['recovered terminal reply']);
  expect(h.result.liveMessages).toEqual([]); expect(h.result.liveText).toBe('');
});
