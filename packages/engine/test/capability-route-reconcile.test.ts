/** Exercises advertised capabilities against the real daemon dispatch chain. */

import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { GATEWAY_REST_ROUTES } from '../daemon-sdk/src/gateway-rest-routes.ts';
import {
  createDaemonSdkRouteProbe,
  findUnreconciledAdvertisements,
  reconcileCatalogRoutes,
  reconcileHttpDescriptor,
} from '../sdk/src/platform/control-plane/method-catalog-route-reconcile.ts';

function liveCatalogDescriptors() {
  return new GatewayMethodCatalog().list();
}

describe('capability-advertisement honesty: route reconcile', () => {
  test('email.inbox.list: the dogfood finding is fixed, and the path it always advertised is the one now served', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const emailInboxList = descriptors.find((d) => d.id === 'email.inbox.list');
    expect(emailInboxList).toBeDefined();
    // The advertised path is UNCHANGED from when it was unreachable. That is
    // the point: the ad was always honest about where this lives, and the fix
    // was to serve it rather than to quietly move the goalposts to a path that
    // happened to already have a route.
    expect(emailInboxList!.http).toEqual({ method: 'GET', path: '/api/email/inbox' });

    const result = await reconcileHttpDescriptor(emailInboxList!, probe);
    expect(result.status).toBe('live');

    // And the ad no longer says "don't call this".
    expect(emailInboxList!.invokable).not.toBe(false);
  });

  test('every email.* method that advertises a route resolves to one, and none is marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'email');
    const advertised = descriptors.filter((d) => d.http);
    // The four mail verbs promise /api/email/* paths. The expectation verbs
    // advertise none: their callers are inside the daemon, reaching them over
    // the control plane, and a descriptor promising a path no route serves is
    // precisely what this gate exists to redden.
    //
    // Counted as two groups rather than one total, deliberately. A single
    // `toHaveLength(descriptors.length)` would keep passing if someone gave a
    // mail verb an http binding and no route, so long as they also added a
    // REST-less verb, the check would move with the thing it is checking.
    expect(advertised).toHaveLength(4);

    for (const descriptor of advertised) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} advertises ${descriptor.http?.method ?? '?'} ${descriptor.http?.path ?? '?'} but no route resolves it`).toBe('live');
      expect(descriptor.invokable).not.toBe(false);
    }

    for (const descriptor of descriptors.filter((d) => !d.http)) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} has no http binding, so there is nothing to reconcile`).toBe('unchecked');
      expect(descriptor.invokable).not.toBe(false);
    }
  });

  test('all five calendar.* methods resolve to a route and none is marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'calendar');
    expect(descriptors).toHaveLength(5);

    for (const descriptor of descriptors) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} advertises ${descriptor.http?.method ?? '?'} ${descriptor.http?.path ?? '?'} but no route resolves it`).toBe('live');
      expect(descriptor.invokable).not.toBe(false);
    }
  });

  test('every browser.* method resolves to a route and none is marked unavailable', async () => {
    // The browser engine was hoisted into the SDK and the daemon could link
    // it, but no verb and no path existed, so nothing the daemon did on its
    // own could open a page. Serving the WHOLE surface is the point: a count
    // check here fails if a later change quietly drops one back out of the
    // route table while leaving its advertisement standing.
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'browser');
    expect(descriptors).toHaveLength(24);

    for (const descriptor of descriptors) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} advertises ${descriptor.http?.method ?? '?'} ${descriptor.http?.path ?? '?'} but no route resolves it`).toBe('live');
      expect(descriptor.invokable).not.toBe(false);
    }
  });

  test('the browser surface covers every action the agent browser tool exposes', () => {
    // The daemon must not be a smaller browser than a surface is. Each entry
    // is one action of the agent's `browser` tool mapped to the verb that
    // serves it; a daemon missing one is a daemon an operator has to open a
    // surface for.
    const perToolAction: Readonly<Record<string, string>> = {
      status: 'browser.status',
      provision: 'browser.provision',
      launch: 'browser.sessions.launch',
      attach: 'browser.sessions.attach',
      release: 'browser.sessions.release',
      close: 'browser.sessions.close',
      navigate: 'browser.navigate',
      snapshot: 'browser.snapshot',
      click: 'browser.click',
      type: 'browser.type',
      select: 'browser.select',
      press: 'browser.press',
      scroll: 'browser.scroll',
      wait_for: 'browser.waitFor',
      read_text: 'browser.readText',
      screenshot: 'browser.screenshot',
      tabs: 'browser.tabs.list',
      new_tab: 'browser.tabs.create',
      switch_tab: 'browser.tabs.switch',
      close_tab: 'browser.tabs.close',
      back: 'browser.history.back',
      forward: 'browser.history.forward',
      extract: 'browser.extract',
    };
    const served = new Set(liveCatalogDescriptors().map((d) => d.id));
    for (const [action, methodId] of Object.entries(perToolAction)) {
      expect(served.has(methodId), `browser tool action "${action}" has no daemon verb (${methodId})`).toBe(true);
    }
  });

  test('every advertised unavailable route is marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const results = await reconcileCatalogRoutes(descriptors, probe);

    const violations = findUnreconciledAdvertisements(descriptors, results).sort();
    // Any advertised route without a live handler must disclose its unavailability.
    expect(violations).toEqual([]);
  });

  test('a genuinely-served method still reconciles as live (no false-unavailable)', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const controlAuthCurrent = descriptors.find((d) => d.id === 'control.auth.current');
    expect(controlAuthCurrent).toBeDefined();
    expect(controlAuthCurrent!.http).toEqual({ method: 'GET', path: '/api/control-plane/auth' });

    const result = await reconcileHttpDescriptor(controlAuthCurrent!, probe);
    expect(result.status).toBe('live');
  });

  test('a method with no http binding is left unchecked, not flagged', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    // fleet.snapshot is handler-registered with no http binding at
    // catalog-construction time (registered later, at RuntimeServices
    // construction), reconcile must not treat "no binding yet" as a
    // violation.
    const noHttpDescriptor = descriptors.find((d) => !d.http);
    expect(noHttpDescriptor).toBeDefined();
    const result = await reconcileHttpDescriptor(noHttpDescriptor!, probe);
    expect(result.status).toBe('unchecked');
  });

  test('a path served by a specialized sub-router is left unchecked, not falsely marked unavailable', async () => {
    const probe = createDaemonSdkRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const mcpDescriptor = descriptors.find((d) => d.http?.path.startsWith('/api/mcp'));
    expect(mcpDescriptor).toBeDefined();
    const result = await reconcileHttpDescriptor(mcpDescriptor!, probe);
    expect(result.status).toBe('unchecked');
  });
});

// ---------------------------------------------------------------------------
// The blind spot: a route that resolves to no registered handler
// ---------------------------------------------------------------------------

/**
 * The gate used to match the route TABLE and stop there. A gateway-REST path
 * dispatches through `invokeGatewayRestVerb` into `catalog.invoke(methodId)`,
 * so "a route matches" and "a handler exists" are two separate facts, and
 * checking only the first reports `live` for a method whose every call fails.
 *
 * That is how `calendar.*` and `email.*` reconciled `live` while a product's
 * own handlers were the ones answering: the table matched and nobody asked
 * whose handler it reached. A gate reporting green while checking something
 * other than the property it claims is worse than no gate, the same failure
 * class as an api:check that passed on a contract no published subpath could
 * satisfy.
 *
 * These tests mutate the catalog deliberately: unregister a handler and the
 * gate must turn red.
 */
describe('route reconcile sees handlers, not just routes', () => {
  const SERVED_BY_GATEWAY_REST = 'email.inbox.list';

  function catalogWithHandlers(): GatewayMethodCatalog {
    const catalog = new GatewayMethodCatalog();
    // Attach an inert handler to every gateway-REST method, which is the state
    // a real composition produces.
    for (const descriptor of catalog.list()) {
      if (descriptor.http) catalog.register(descriptor, async () => ({}), { replace: true });
    }
    return catalog;
  }

  test('a served route WITH a handler still reconciles live: the gate does not cry wolf', async () => {
    const catalog = catalogWithHandlers();
    const descriptor = catalog.get(SERVED_BY_GATEWAY_REST);
    expect(descriptor).toBeDefined();

    const result = await reconcileHttpDescriptor(
      descriptor!,
      createDaemonSdkRouteProbe(),
      (id) => catalog.hasHandler(id),
    );
    expect(result.status).toBe('live');
  });

  test('MUTATION: unregister the handler and the same route turns red', async () => {
    const catalog = catalogWithHandlers();
    const descriptor = catalog.get(SERVED_BY_GATEWAY_REST);
    expect(catalog.hasHandler(SERVED_BY_GATEWAY_REST)).toBe(true);

    // Re-register with NO handler: the descriptor and its route are untouched,
    // only the handler is gone. This is exactly the state that used to read
    // `live`.
    catalog.register(descriptor!, undefined, { replace: true });
    expect(catalog.hasHandler(SERVED_BY_GATEWAY_REST)).toBe(false);

    const result = await reconcileHttpDescriptor(
      descriptor!,
      createDaemonSdkRouteProbe(),
      (id) => catalog.hasHandler(id),
    );
    expect(result.status).toBe('unhandled');
    expect(result.reason).toContain('no handler is registered');
  });

  test('MUTATION: an unhandled method is a violation even though it is marked callable', async () => {
    const catalog = catalogWithHandlers();
    const descriptor = catalog.get(SERVED_BY_GATEWAY_REST)!;
    catalog.register(descriptor, undefined, { replace: true });

    const descriptors = catalog.list();
    const results = await reconcileCatalogRoutes(
      descriptors,
      createDaemonSdkRouteProbe(),
      (id) => catalog.hasHandler(id),
    );
    // `invokable: false` says "cataloged, not callable". This method says it IS
    // callable and reaches nothing, which is the case the gate exists for.
    expect(descriptor.invokable).not.toBe(false);
    expect(findUnreconciledAdvertisements(descriptors, results)).toContain(SERVED_BY_GATEWAY_REST);
  });

  test('a method served by its own route module is not required to have a catalog handler', async () => {
    // Narrowness matters: demanding a catalog handler everywhere would redden
    // routes that genuinely work through a dedicated route module.
    const catalog = new GatewayMethodCatalog();
    const notGatewayRest = catalog.list().find(
      (d) => d.http && !GATEWAY_REST_ROUTES.some((r) => r.methodId === d.id),
    );
    expect(notGatewayRest, 'expected at least one http method outside the gateway REST table').toBeDefined();

    const result = await reconcileHttpDescriptor(
      notGatewayRest!,
      createDaemonSdkRouteProbe(),
      () => false, // no catalog handler anywhere
    );
    expect(result.status).not.toBe('unhandled');
  });

  test('omitting the handler probe keeps the old behaviour, so existing callers are unaffected', async () => {
    const catalog = new GatewayMethodCatalog();
    const descriptor = catalog.get(SERVED_BY_GATEWAY_REST)!;
    const result = await reconcileHttpDescriptor(descriptor, createDaemonSdkRouteProbe());
    expect(result.status).toBe('live');
  });
});
