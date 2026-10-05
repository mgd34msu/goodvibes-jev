/** Real authentication and contract REST dispatch over an ephemeral loopback listener. */
import { join } from 'node:path';
import { createDaemonControlRouteHandlers } from '../../daemon-sdk/src/control-routes.js';
import { dispatchDaemonApiRoutes } from '../../daemon-sdk/src/api-router.js';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.js';
import { registerContractGatewayMethods } from '../../sdk/src/platform/control-plane/routes/contracts.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../sdk/src/platform/daemon/control-plane.js';
import { resolveAuthenticatedPrincipal } from '../../sdk/src/platform/daemon/http-policy.js';
import { UserAuthManager } from '../../sdk/src/platform/security/user-auth.js';
import { OPERATOR_SESSION_COOKIE_NAME } from '../../sdk/src/platform/security/http-auth.js';
import { createContractOperatorService } from '../../sdk/src/platform/contract/index.js';
import { makeDefaultDaemonHandlerStub } from '../_helpers/daemon-stub-handlers.js';
import type { Harness } from './runner-support.js';

export function serveContractCancellation(h: Harness) {
  const catalog = new GatewayMethodCatalog();
  registerContractGatewayMethods(catalog, createContractOperatorService({ runner: h.runner, workingDirectory: h.root }));
  const userAuth = new UserAuthManager({
    bootstrapFilePath: join(h.root, '.goodvibes', 'fixture-users.json'),
    bootstrapCredentialPath: join(h.root, '.goodvibes', 'fixture-bootstrap.txt'),
    users: [
      { username: 'cancel-writer', passwordHash: UserAuthManager.hashPassword('fixture-only-writer'), roles: ['admin'] },
      { username: 'cancel-reader', passwordHash: UserAuthManager.hashPassword('fixture-only-reader'), roles: ['operator'] },
    ],
  });
  // Only the real auth, scope and invoke methods use this context. Every unused
  // daemon subsystem stays absent, so accidental calls fail rather than succeed.
  const helper = new DaemonControlPlaneHelper({ authToken: () => null, userAuth, gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
  const control = createDaemonControlRouteHandlers({
    authToken: null, version: '0.0.0-cancellation-fixture', sessionCookieName: OPERATOR_SESSION_COOKIE_NAME,
    controlPlaneGateway: {
      getSnapshot: () => ({}), renderWebUi: () => new Response(''),
      listRecentEvents: () => [], listSurfaceMessages: () => [], listClients: () => [],
      createEventStream: () => new Response('', { status: 503 }),
    },
    extractAuthToken: req => helper.extractAuthToken(req),
    resolveAuthenticatedPrincipal: req => resolveAuthenticatedPrincipal(req, helper),
    gatewayMethods: catalog, getOperatorContract: () => ({}),
    invokeGatewayMethodCall: input => helper.invokeGatewayMethodCall(input),
    parseOptionalJsonBody: async req => {
      const text = await req.text();
      if (!text) return null;
      const body: unknown = JSON.parse(text);
      return body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown> : Response.json({ error: 'Expected an object' }, { status: 400 });
    },
    requireAdmin: req => helper.requireAdmin(req),
    requireAuthenticatedSession: req => helper.requireAuthenticatedSession(req),
  });
  const handlers = makeDefaultDaemonHandlerStub({ invokeGatewayRestVerb: control.invokeGatewayRestVerb });
  const requests: { method: string; path: string; body: string }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname, body: await req.clone().text() });
      return await dispatchDaemonApiRoutes(req, handlers) ?? Response.json({ error: 'Unknown fixture route' }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`, requests, catalog,
    writer: userAuth.createSession('cancel-writer').token,
    reader: userAuth.createSession('cancel-reader').token,
    stop() { void server.stop(true); },
  };
}
