/**
 * The whole-catalog partition: every verb this daemon advertises is reachable
 * by SOME path, or says plainly that it is not.
 *
 * ── The defect class ─────────────────────────────────────────────────────
 *
 * A gateway method catalog registers DESCRIPTORS (the contract a client reads)
 * and, separately, HANDLERS (what answers an invoke). The two are independent,
 * so a verb can be fully described, schema, scopes, HTTP binding, the lot,
 * and answer 501 "Gateway method is not invokable" to everyone who calls it.
 * That shipped: fleet.*, checkpoints.* and sessions.search were cataloged and
 * handler-less on every daemon build for months, and the contract gates never
 * saw it because they validate descriptors.
 *
 * The family sweeps (gateway-verb-family-parity.test.ts and friends) pin the
 * families somebody thought to name. This file needs nobody to think of
 * anything: it walks the ENTIRE composed catalog and requires each descriptor
 * to fall into exactly one honest bucket.
 *
 *   1. HANDLER-ATTACHED, answered in this process by catalog.invoke.
 *   2. ROUTE-SERVED, no in-process handler, but the descriptor advertises an
 *      HTTP binding and this daemon's router really serves that path. The
 *      probe is an UNAUTHENTICATED request: a route that exists refuses with
 *      401, a path nothing serves answers 404. Nothing reaches a handler body,
 *      so probing a destructive verb costs nothing and changes nothing.
 *   3. DECLARED UNCALLABLE, `invokable: false`, the descriptor's own way of
 *      saying "cataloged so the contract is honest about the shape; this build
 *      does not serve it". An advertisement that already says don't call me
 *      cannot mislead anyone.
 *
 * Anything in none of the three is a verb this daemon advertises, claims is
 * callable, and serves nowhere. That is the failure, and it names the ids.
 *
 * ── Why an unauthenticated probe rather than a real call ──────────────────
 *
 * The alternative, invoke every verb, would run automation jobs, send email,
 * revoke pairing tokens and delete watchers. The auth gate sits in front of
 * every route and answers before dispatch, so 401-vs-404 reads the routing
 * table without executing anything. `server.test.ts` pins both halves of that
 * behaviour ("returns 401 without token", "unknown route returns 404").
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DaemonFixture } from '../../testing/daemon-fixture.js';
import { startGatewayFixture as startDaemonFixture } from '../helpers/gateway-route-fixture.js';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';

/**
 * Path prefixes served by a specialized sub-router that this daemon mounts
 * ahead of the generic API dispatch, and which answer 404 to an anonymous
 * request for a path they do serve (they resolve the target before they
 * authenticate). Kept as an explicit, short allowlist so growth here is a
 * decision somebody made rather than scope creep, the same treatment the SDK's
 * own route reconcile gives its sub-router list.
 *
 * Empty until a probe result proves an entry is needed; each entry must carry
 * the reason it is here.
 */
const ANONYMOUS_PROBE_BLIND_PREFIXES: readonly { readonly prefix: string; readonly reason: string }[] = [];

/**
 * Verbs this daemon catalogs, advertises as callable, and serves from nowhere,
 * the exact defect this file exists to name. They are pinned rather than
 * tolerated: the assertion is that the stranded set EQUALS this list, so a new
 * one fails the sweep and a fixed one fails it too, forcing the entry out.
 *
 * Each entry states what would have to change. None of it is a test change.
 *
 * acp.agents.list and acp.sessions.create used to be pinned here
 * (registerAcpGatewayMethods was gated on `deps.acpHost` and runtime/services.ts
 * threaded none). services.ts now constructs an AcpHostService and threads it
 * into both the fleet registry and the gateway verb group registration, so
 * both verbs are handler-attached, see gateway-verb-family-parity.test.ts's
 * `acp` family and gateway-acp-verbs.test.ts for the behavior.
 */
const KNOWN_STRANDED: readonly { readonly id: string; readonly finding: string }[] = [];

/** Replace `{param}` template segments with an opaque single-segment placeholder. */
function resolveTemplatePath(template: string): string {
  return template.replace(/\{[^/}]+\}/g, 'catalog-sweep-probe-placeholder');
}

function isBlindPrefix(path: string): boolean {
  return ANONYMOUS_PROBE_BLIND_PREFIXES.some(
    (entry) => path === entry.prefix || path.startsWith(`${entry.prefix}/`),
  );
}

interface Row {
  readonly id: string;
  readonly handled: boolean;
  readonly http: { readonly method: string; readonly path: string } | null;
  readonly invokable: boolean;
}

let fixture: DaemonFixture;
let rows: Row[] = [];
let tempRoot = '';

beforeAll(async () => {
  tempRoot = makeProjectTempDir('gv-catalog-partition');
  // A fully-provisioned daemon, because that is the one whose promises have to
  // hold. Hosted sessions are on by default in the fixture (the real entrypoint
  // states them); the mailbox is named here because the inbound-mail
  // composition returns before registering `email.expectation.*` /
  // `email.inbound.status` when no account is configured, and a sweep run
  // against the unconfigured shape would report four verbs stranded that a
  // configured daemon serves perfectly well. Nothing connects: no source starts
  // until the supervisor does.
  fixture = await startDaemonFixture({ root: tempRoot, watchedMailbox: 'sweep@example.invalid' });
  rows = fixture.services.gatewayMethods.list().map((descriptor) => ({
    id: descriptor.id,
    handled: fixture.services.gatewayMethods.hasHandler(descriptor.id),
    http: descriptor.http ? { method: descriptor.http.method, path: descriptor.http.path } : null,
    invokable: descriptor.invokable !== false,
  }));
});

afterAll(async () => {
  await fixture?.stop();
});

describe('every descriptor this daemon composes is handled, routed, or declared uncallable', () => {
  test('the composed catalog is the real one, not an empty stand-in', () => {
    // A sweep over nothing passes trivially. Two independent floors: the
    // catalog is large, and the families this daemon is the owner of are in it.
    expect(rows.length).toBeGreaterThan(400);
    for (const id of ['fleet.snapshot', 'sessions.hosted.create', 'approvals.raise', 'credentials.set']) {
      expect(rows.some((row) => row.id === id), `${id} missing from the composed catalog`).toBe(true);
    }
  });

  test('the only descriptors nothing can serve are the ones already named as findings', () => {
    // The cheap half, and the one that needs no network: a verb with no handler
    // and no advertised path has nowhere left to be served from, so claiming it
    // is callable is a straight untruth to every client that reads the catalog.
    const stranded = rows
      .filter((row) => !row.handled && row.http === null && row.invokable)
      .map((row) => row.id)
      .sort();
    expect(
      stranded,
      'These verbs advertise themselves as callable, carry no in-process handler, and name no HTTP '
      + 'path. Nothing can serve them. Either wire a handler, give the descriptor its route, or mark '
      + 'it invokable: false so the contract stops promising it. If one of the pinned findings above '
      + 'has been fixed, delete its KNOWN_STRANDED entry in the same change.',
    ).toEqual([...KNOWN_STRANDED.map((entry) => entry.id)].sort());
  });

  test('every route-served descriptor resolves to a real route on the running daemon', async () => {
    // The expensive half. Only descriptors with no in-process handler are
    // probed: a handled verb is already answered by bucket 1, whatever its
    // path does.
    const probed = rows.filter((row) => !row.handled && row.http !== null && !isBlindPrefix(row.http.path));
    expect(probed.length).toBeGreaterThan(50);

    const unserved: string[] = [];
    for (const row of probed) {
      const http = row.http!;
      const response = await fixture.fetchAnonymous(resolveTemplatePath(http.path), { method: http.method });
      // 404 is the router saying it has nothing for this path at all. Every
      // other status, 401 refused, 200 public, 405 wrong verb, 400 bad body,
      // means a route matched and something answered.
      if (response.status === 404) unserved.push(`${row.id} (${http.method} ${http.path})`);
    }

    // A descriptor may honestly say "this build does not serve me". One that
    // does not say so, and is not served, is the advertise-without-substance
    // defect this sweep exists to catch.
    const violations = unserved.filter((entry) => {
      const id = entry.split(' ')[0]!;
      return rows.find((row) => row.id === id)?.invokable === true;
    });
    expect(
      violations,
      'These verbs advertise an HTTP path this daemon does not serve, and are not marked '
      + 'invokable: false. A client that trusts the advertisement gets a bare 404.',
    ).toEqual([]);
  }, 120_000);

  test('the partition is exhaustive: every descriptor lands in exactly one bucket', () => {
    const handled = rows.filter((row) => row.handled);
    const routed = rows.filter((row) => !row.handled && row.http !== null);
    const declaredUncallable = rows.filter((row) => !row.handled && row.http === null && !row.invokable);
    const stranded = rows.filter((row) => !row.handled && row.http === null && row.invokable);
    expect(handled.length + routed.length + declaredUncallable.length + stranded.length).toBe(rows.length);
    expect(stranded).toHaveLength(KNOWN_STRANDED.length);
    // Each bucket is non-trivially populated, so a future change that collapses
    // one of them into another is visible here rather than silently green.
    expect(handled.length).toBeGreaterThan(100);
    expect(routed.length).toBeGreaterThan(100);
  });

  test('the verbs a client cannot reach any other way are handler-attached', () => {
    // sessions.hosted.* is the case that motivated this file: it appeared in no
    // conformance list anywhere, and it is the only way a client with no
    // terminal of its own starts a run. approvals.raise and credentials.set /
    // credentials.delete were in the same position.
    for (const id of [
      'sessions.hosted.create', 'sessions.hosted.attach', 'sessions.hosted.detach',
      'sessions.hosted.kill', 'sessions.hosted.list',
    ]) {
      const row = rows.find((entry) => entry.id === id);
      expect(row, `${id} missing from the catalog`).toBeTruthy();
      // Registered by composeHostedSessions, which runs only when the product
      // STATES hostedSessions (cli.ts does; createRuntimeServices does not). A
      // daemon that omits it catalogs five verbs and serves none of them, and
      // nothing else in the tree noticed, which is why this is asserted here
      // and not left to the family sweep over the runtime graph alone.
      expect(row!.handled, `${id} is cataloged with no handler; composeHostedSessions did not run`).toBe(true);
    }
    for (const id of ['approvals.raise', 'credentials.set', 'credentials.delete']) {
      expect(
        fixture.services.gatewayMethods.hasHandler(id),
        `${id} has no handler on the composed daemon; a client whose prompt or settings live outside `
        + 'this process has no way to raise an ask or write a credential.',
      ).toBe(true);
    }
  });
});
