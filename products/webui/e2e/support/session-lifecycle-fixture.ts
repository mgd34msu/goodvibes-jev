/** Synthetic session lifecycle responses. Never contacts a daemon or deletes user data. */
import type { Page, Route } from '@playwright/test';
import { installMockDaemon } from './mock-daemon';
import { FOLLOWUP_SESSION, STEERABLE_SESSION, contractMessage, sessionRecord } from './seed';

export const LIFECYCLE_SESSION = { ...STEERABLE_SESSION, title: 'Lifecycle original session' };
export const REPLACEMENT_SESSION = { ...FOLLOWUP_SESSION, title: 'Lifecycle replacement session' };
export const LIFECYCLE_TOKEN = 'e2e-operator-token';
export type LifecycleStage = 'close' | 'reopen' | 'delete' | 'list';
type Response = 'success' | 'disconnected' | 'server-error';

interface LifecycleRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

/**
 * A held reply represents a write that may already have reached the server.
 * Its state changes on receipt, before the reply is released. List replies are
 * captured at receipt too, so a late response is a genuinely stale snapshot.
 */
export async function installSessionLifecycleDaemon(page: Page, options: {
  hold?: LifecycleStage;
  /** Interrupt the first reply at this stage, after applying its synthetic write. */
  fail?: { stage: 'close' | 'reopen' | 'delete'; response: Exclude<Response, 'success'> };
} = {}) {
  const daemon = await installMockDaemon(page);
  const sessions = structuredClone([LIFECYCLE_SESSION, REPLACEMENT_SESSION]);
  const requests: LifecycleRequest[] = [];
  const writes: LifecycleRequest[] = [];
  const pending: { stage: LifecycleStage; answer: () => Promise<void> }[] = [];
  let held = options.hold;
  let deleted = false;
  let failed = false;

  async function answer(route: Route, stage: LifecycleStage, body: unknown): Promise<void> {
    const respond = async () => {
      const failure = !failed && options.fail?.stage === stage ? options.fail.response : undefined;
      if (failure) failed = true;
      if (failure === 'disconnected') {
        await route.abort('connectionreset');
      } else if (failure === 'server-error') {
        await route.fulfill({ status: 503, json: { error: 'Synthetic session response interrupted.' } });
      } else {
        await route.fulfill({ json: body });
      }
    };
    if (held === stage && (stage !== 'list' || deleted)) pending.push({ stage, answer: respond });
    else await respond();
  }

  await page.route('**/api/sessions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const record = { method, path, authorization: request.headers().authorization };
    if (path === '/api/sessions' && method === 'GET') {
      requests.push(record);
      return answer(route, 'list', {
        totals: {
          sessions: sessions.length,
          active: sessions.filter(session => session.status === 'active').length,
          closed: sessions.filter(session => session.status === 'closed').length,
        },
        sessions: sessions.map(sessionRecord),
      });
    }
    const read = /^\/api\/sessions\/([^/]+)(?:\/messages)?$/.exec(path);
    if (read && method === 'GET') {
      requests.push(record);
      const id = decodeURIComponent(read[1]);
      const session = sessions.find(item => item.id === id);
      return session
        ? route.fulfill({ json: { session: sessionRecord(session), messages: session.messages.map(message => contractMessage(id, message)) } })
        : route.fulfill({ status: 404, json: { error: 'Unknown shared session' } });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(close|reopen))?$/.exec(path);
    if (!match || (method !== 'POST' && method !== 'DELETE')) return route.fallback();
    requests.push(record);
    writes.push(record);
    const id = decodeURIComponent(match[1]);
    const session = sessions.find(item => item.id === id);
    const stage = method === 'DELETE' ? 'delete' : match[2];
    if (!session || (stage !== 'delete' && stage !== 'close' && stage !== 'reopen')) {
      return route.fulfill({ status: 404, json: { code: 'SESSION_NOT_FOUND', error: 'Unknown synthetic session.' } });
    }
    if (stage === 'delete') {
      sessions.splice(sessions.indexOf(session), 1);
      deleted = true;
      return answer(route, stage, { sessionId: id, deleted: true });
    }
    session.status = stage === 'close' ? 'closed' : 'active';
    return answer(route, stage, { session: sessionRecord(session) });
  });

  return {
    ...daemon,
    lifecycleRequests: requests,
    writes,
    sessions,
    get pendingStages() { return pending.map(item => item.stage); },
    async release() {
      held = undefined;
      await Promise.all(pending.splice(0).map(item => item.answer()));
    },
  };
}

/** Simulate the browser's cross-tab token storage notification, including ABA. */
export async function replaceSessionIdentity(page: Page, restoreOriginal: boolean): Promise<void> {
  await page.evaluate(({ original, restore }) => {
    const key = 'goodvibes.webui.token';
    for (const value of restore ? ['e2e-replacement-token', original] : ['e2e-replacement-token']) {
      const oldValue = localStorage.getItem(key);
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: value, storageArea: localStorage }));
    }
  }, { original: LIFECYCLE_TOKEN, restore: restoreOriginal });
}
