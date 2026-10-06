import { expect, test } from 'bun:test';
import { attachBrowserJudgmentError, browserJudgmentErrorMethod } from '../sdk/src/platform/daemon/http/browser-judgment-error.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import type { AuthenticatedPrincipal, BrowserJudgmentErrorSource } from '../daemon-sdk/src/index.ts';

const principal: AuthenticatedPrincipal = { principalId: 'synthetic-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
function fixture() {
  const methods = new GatewayMethodCatalog({ includeBuiltins: false });
  const descriptor = { id: 'synthetic.failure', title: 'Synthetic', description: 'Owned failure', category: 'sessions',
    access: 'authenticated', source: 'builtin', transport: ['http'], scopes: [], http: { method: 'GET', path: '/api/synthetic/{sessionId}' } } as const;
  methods.register(descriptor);
  const request = new Request('http://127.0.0.1/api/synthetic/fixture');
  const captures: BrowserJudgmentErrorSource[] = [];
  const context = { methods, method: browserJudgmentErrorMethod(request, methods), principal,
    currentPrincipal: (): AuthenticatedPrincipal | null => principal,
    service: { async execute() { return {}; }, issueErrorReference(input: BrowserJudgmentErrorSource) { captures.push(input); return '11111111-1111-4111-8111-111111111111'; } },
  };
  return { methods, descriptor, request, captures, context };
}

test('registered canonical responses attach only the trusted issuer output with bounded source fields', async () => {
  const f = fixture();
  const original = Response.json({ error: 'Synthetic original failure', errorRef: 'untrusted-ref' }, { status: 409 });
  const result = await attachBrowserJudgmentError(f.request, original, f.context);
  expect(await result.json()).toMatchObject({ error: 'Synthetic original failure', errorRef: '11111111-1111-4111-8111-111111111111' });
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(f.captures).toHaveLength(1);
  expect(f.captures[0]).toMatchObject({ methodId: 'synthetic.failure', status: 409, principal });
});

test.each(['anonymous', 'changed-id', 'changed-kind', 'registration', 'oversize', 'non-json', 'authentication', 'cancelled'] as const)('does not issue a reference for %s capture', async (kind) => {
  const f = fixture(); const abort = new AbortController();
  const request = new Request(f.request, { signal: abort.signal });
  const context = { ...f.context,
    ...(kind === 'anonymous' ? { principal: null } : {}),
    ...(kind === 'changed-id' ? { currentPrincipal: () => ({ ...principal, principalId: 'other' }) } : {}),
    ...(kind === 'changed-kind' ? { currentPrincipal: () => ({ ...principal, principalKind: 'token' as const }) } : {}),
  };
  if (kind === 'registration') f.methods.register(f.descriptor, undefined, { replace: true });
  if (kind === 'cancelled') abort.abort();
  const original = kind === 'non-json' ? new Response('Synthetic failure', { status: 409 })
    : Response.json({ error: kind === 'oversize' ? 'x'.repeat(65_537) : 'Synthetic failure' }, { status: kind === 'authentication' ? 401 : 409 });
  expect(await attachBrowserJudgmentError(request, original, context)).toBe(original);
  expect(f.captures).toEqual([]);
});

test('unknown and ambiguous paths do not acquire an issuer; generic invoke resolves exact registered IDs', () => {
  const f = fixture();
  expect(browserJudgmentErrorMethod(new Request('http://127.0.0.1/api/unknown'), f.methods)).toBeUndefined();
  expect(browserJudgmentErrorMethod(new Request('http://127.0.0.1/api/control-plane/methods/synthetic.failure/invoke', { method: 'POST' }), f.methods)?.id).toBe(f.descriptor.id);
  f.methods.register({ ...f.descriptor, id: 'synthetic.ambiguous' });
  expect(browserJudgmentErrorMethod(f.request, f.methods)).toBeUndefined();
});
