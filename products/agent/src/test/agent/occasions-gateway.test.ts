/**
 * occasions-gateway.ts, isolated from the tool and the nudge surface that call it.
 *
 * Both of those callers are tested against a directly-injected
 * `OccasionsGatewayInvoke`, which never exercises `createOccasionsGatewayInvoke`
 * itself. That function is the one place deciding which of the two routes a call
 * takes (in-process catalog vs. connected-host operator gateway), and it is also
 * the one place that could quietly drop a field on the way past.
 *
 * `authority` is what makes that matter. It is REQUIRED on the three verbs that
 * write to the owner's own profile file, and on `occasions.remove` it is the WHOLE
 * gate on a deletion, there is no derivation check and no verbatim quote to fall
 * back on, because a removal has neither a value to compare nor an utterance to
 * quote. This module forwards `body` verbatim on both routes, with no
 * verb-specific branching, and this suite exists so a future edit that introduced
 * such branching fails here rather than 400ing against a real daemon.
 */

import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { GatewayMethodInvocation } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import {
  createOccasionsGatewayInvoke,
  occasionsRouteLabel,
} from '../../agent/occasions-gateway.ts';
import { OCCASIONS_METHOD_IDS, type OccasionsMethodId } from '../../tools/agent-occasions-types.ts';
import type { AgentConnectedHostConfigReader } from '../../agent/routine-schedule-promotion.ts';

/** Never resolved in these tests: every case here takes the in-process route. */
const configManager: AgentConnectedHostConfigReader = { get: () => undefined };

const ALL_VERBS: readonly OccasionsMethodId[] = Object.values(OCCASIONS_METHOD_IDS);

/** The three that append to or delete from the owner's own profile file. */
const PROFILE_WRITE_VERBS: readonly OccasionsMethodId[] = [
  OCCASIONS_METHOD_IDS.confirm,
  OCCASIONS_METHOD_IDS.plansConfirm,
  OCCASIONS_METHOD_IDS.remove,
];

function stubCatalog(
  ids: readonly OccasionsMethodId[],
  handler?: (invocation: GatewayMethodInvocation) => unknown,
): { readonly catalog: GatewayMethodCatalog; readonly seen: Map<string, GatewayMethodInvocation> } {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  const seen = new Map<string, GatewayMethodInvocation>();
  for (const id of ids) {
    catalog.register(
      {
        id,
        title: id,
        description: 'test stub',
        category: 'test',
        source: 'plugin',
        access: 'authenticated',
        transport: ['internal'],
        scopes: [],
      },
      (invocation: GatewayMethodInvocation) => {
        seen.set(id, invocation);
        return handler ? handler(invocation) : { relayed: true };
      },
    );
  }
  return { catalog, seen };
}

describe('occasions gateway route decision', () => {
  test('a catalog carrying the handler answers in-process', async () => {
    const { catalog } = stubCatalog([OCCASIONS_METHOD_IDS.pending]);
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });
    const result = await invoke(OCCASIONS_METHOD_IDS.pending, {});
    expect(result.ok).toBe(true);
    expect(result.route).toBe('in-process');
    expect(result.data).toEqual({ relayed: true });
  });

  test('a descriptor with no handler is not treated as an in-process answer', async () => {
    // `hasHandler`, not `get`: a descriptor without a handler answers "not
    // invokable", and degrading to that silently would look like an owner with no
    // dates recorded. With no reachable connected host this must FAIL, honestly.
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
    // `register` takes the handler as an OPTIONAL second argument, so omitting it
    // produces exactly the state this guards against: the descriptor is listed and
    // nothing will answer it. This is the 501 "Gateway method is not invokable"
    // shape the daemon-side parity tests exist for, reached from the client side.
    catalog.register({
      id: OCCASIONS_METHOD_IDS.pending,
      title: 'descriptor only',
      description: 'registered with no handler',
      category: 'test',
      source: 'plugin',
      access: 'authenticated',
      transport: ['internal'],
      scopes: [],
    });
    // The descriptor really is there, otherwise this test would pass for the
    // wrong reason, by exercising the no-descriptor case instead.
    expect(catalog.get(OCCASIONS_METHOD_IDS.pending)).toBeTruthy();
    expect(catalog.hasHandler(OCCASIONS_METHOD_IDS.pending)).toBe(false);

    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });
    const result = await invoke(OCCASIONS_METHOD_IDS.pending, {});
    expect(result.ok).toBe(false);
    expect(result.route).toBe('connected-host');
  });

  test('an in-process throw becomes an honest failure, never a phantom success', async () => {
    const { catalog } = stubCatalog([OCCASIONS_METHOD_IDS.sweep], () => {
      throw new Error('the store could not be written');
    });
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });
    const result = await invoke(OCCASIONS_METHOD_IDS.sweep, {});
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toContain('the store could not be written');
    expect(result.route).toBe('in-process');
  });

  test('every verb carries a route label, so a connected-host failure can name one', () => {
    for (const id of ALL_VERBS) {
      const label = occasionsRouteLabel(id);
      expect(label, id).toBeTruthy();
      expect(/^(GET|POST) \/api\/occasions/.test(label), `${id} -> ${label}`).toBe(true);
    }
  });
});

describe('occasions gateway body forwarding', () => {
  test('authority reaches the profile-write verbs unaltered', async () => {
    const { catalog, seen } = stubCatalog(PROFILE_WRITE_VERBS);
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });

    await invoke(OCCASIONS_METHOD_IDS.confirm, {
      title: 'Our anniversary',
      date: '2015-09-12',
      kind: 'gift-giving',
      surface: 'agent',
      said: 'our anniversary is the twelfth of September',
      authority: 'owner-direct',
    });
    await invoke(OCCASIONS_METHOD_IDS.plansConfirm, {
      title: 'Lisbon',
      from: '2026-09-12',
      to: '2026-09-19',
      away: true,
      surface: 'agent',
      said: 'we are in Lisbon that week',
      authority: 'owner-direct',
    });
    await invoke(OCCASIONS_METHOD_IDS.remove, {
      occasionId: 'sarahs-birthday',
      confirmed: true,
      authority: 'owner-direct',
    });

    for (const id of PROFILE_WRITE_VERBS) {
      const body = seen.get(id)?.body as Record<string, unknown> | undefined;
      expect(body?.authority, `${id} lost its authority in transit`).toBe('owner-direct');
    }
  });

  test('an untrusted authority is forwarded as-is, so the daemon is the one that refuses', async () => {
    const { catalog, seen } = stubCatalog([OCCASIONS_METHOD_IDS.confirm]);
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });
    await invoke(OCCASIONS_METHOD_IDS.confirm, {
      title: 'Somebody birthday',
      date: '04-04',
      kind: 'remember-only',
      surface: 'agent',
      said: 'the page said so',
      authority: 'web-page',
    });
    // Nothing here upgrades, substitutes or retries an authority.
    expect((seen.get(OCCASIONS_METHOD_IDS.confirm)?.body as Record<string, unknown>).authority).toBe('web-page');
  });

  test('the invocation declares a user request, which is what the write verbs check', async () => {
    const { catalog, seen } = stubCatalog([OCCASIONS_METHOD_IDS.remove]);
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });
    await invoke(OCCASIONS_METHOD_IDS.remove, {
      occasionId: 'sarahs-birthday',
      confirmed: true,
      authority: 'owner-direct',
    });
    const context = seen.get(OCCASIONS_METHOD_IDS.remove)?.context as Record<string, unknown> | undefined;
    // `refuseNonUserRequest` runs first on all three writes; a caller that
    // declared the call was not a user request gets its own refusal.
    expect(context?.principalKind).toBe('user');
    expect(context?.clientKind).toBe('goodvibes-agent');
  });

  test('a read body is forwarded exactly, with no field added on the way past', async () => {
    const { catalog, seen } = stubCatalog([OCCASIONS_METHOD_IDS.gifts]);
    const invoke = createOccasionsGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/nowhere' });
    await invoke(OCCASIONS_METHOD_IDS.gifts, { occasionId: 'sarahs-birthday' });
    expect(seen.get(OCCASIONS_METHOD_IDS.gifts)?.body).toEqual({ occasionId: 'sarahs-birthday' });
  });
});
