/**
 * owner-profile-gateway.ts, isolated from the tool and the CLI that call it.
 *
 * Both of those callers are tested against a directly-injected
 * `ProfileGatewayInvoke`, which never exercises `createProfileGatewayInvoke`
 * itself. That function is the one place deciding which of the two routes a
 * call takes (in-process catalog vs. connected-host operator gateway), and
 * under the new contract `authority` is REQUIRED on every write verb, an
 * absent one is a 400 INVALID_ARGUMENT. `forget` and `undo` matter most: they
 * are the delete path, and §7's authority check is the WHOLE gate on a
 * removal (no derivation check, no verbatim quote, a deletion has neither a
 * value to compare nor an utterance to quote).
 *
 * This module forwards `body` verbatim on both routes, there is no
 * verb-specific branching in `createProfileGatewayInvoke`, so a regression
 * that dropped `authority` for one verb but not another could only happen one
 * layer up, in the tool. This suite exists so a future edit to THIS file that
 * introduced such branching (e.g. stripping a field before forwarding) would
 * fail here rather than 400 at runtime against a real daemon.
 */

import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { GatewayMethodInvocation } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createProfileGatewayInvoke } from '../../agent/owner-profile-gateway.ts';
import { PROFILE_METHOD_IDS, type ProfileMethodId } from '../../tools/agent-profile-types.ts';
import type { AgentConnectedHostConfigReader } from '../../agent/routine-schedule-promotion.ts';

/** Never resolved in these tests: every case here takes the in-process route. */
const configManager: AgentConnectedHostConfigReader = { get: () => undefined };

const WRITE_VERBS: readonly ProfileMethodId[] = [
  PROFILE_METHOD_IDS.set,
  PROFILE_METHOD_IDS.append,
  PROFILE_METHOD_IDS.forget,
  PROFILE_METHOD_IDS.undo,
];

function catalogRecordingBodies(): { readonly catalog: GatewayMethodCatalog; readonly bodies: Map<string, unknown> } {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  const bodies = new Map<string, unknown>();
  for (const id of WRITE_VERBS) {
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
        bodies.set(id, invocation.body);
        return { ok: true, reason: null, changes: [], disclosure: 'recorded' };
      },
    );
  }
  return { catalog, bodies };
}

describe('owner-profile-gateway: authority reaches the daemon on every write verb', () => {
  test('profile.set forwards authority unchanged', async () => {
    const { catalog, bodies } = catalogRecordingBodies();
    const invoke = createProfileGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/home/owner' });
    const result = await invoke(PROFILE_METHOD_IDS.set, {
      fieldId: 'commerce.shippingAddress',
      value: '200 Office Way',
      surface: 'agent',
      said: 'ship it to my office instead',
      authority: 'owner-direct',
    });
    expect(result.ok).toBe(true);
    expect(result.route).toBe('in-process');
    expect((bodies.get(PROFILE_METHOD_IDS.set) as Record<string, unknown>).authority).toBe('owner-direct');
  });

  test('profile.append forwards authority unchanged', async () => {
    const { catalog, bodies } = catalogRecordingBodies();
    const invoke = createProfileGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/home/owner' });
    const result = await invoke(PROFILE_METHOD_IDS.append, {
      section: 'Notes',
      text: 'Allergic to shellfish',
      surface: 'agent',
      said: 'I am allergic to shellfish',
      authority: 'owner-direct',
    });
    expect(result.ok).toBe(true);
    expect((bodies.get(PROFILE_METHOD_IDS.append) as Record<string, unknown>).authority).toBe('owner-direct');
  });

  // forget and undo matter most: under the new contract they 400 without
  // authority, and they are the delete path, §7's authority check is the
  // WHOLE gate on a removal, with no derivation or verbatim-quote layer
  // behind it to catch a caller that slipped through with none.
  test('profile.forget forwards authority unchanged', async () => {
    const { catalog, bodies } = catalogRecordingBodies();
    const invoke = createProfileGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/home/owner' });
    const result = await invoke(PROFILE_METHOD_IDS.forget, {
      fieldId: 'commerce.shippingAddress',
      authority: 'owner-direct',
    });
    expect(result.ok).toBe(true);
    expect((bodies.get(PROFILE_METHOD_IDS.forget) as Record<string, unknown>).authority).toBe('owner-direct');
  });

  test('profile.undo forwards authority unchanged', async () => {
    const { catalog, bodies } = catalogRecordingBodies();
    const invoke = createProfileGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/home/owner' });
    const result = await invoke(PROFILE_METHOD_IDS.undo, {
      fieldId: 'commerce.shippingAddress',
      authority: 'owner-direct',
    });
    expect(result.ok).toBe(true);
    expect((bodies.get(PROFILE_METHOD_IDS.undo) as Record<string, unknown>).authority).toBe('owner-direct');
  });

  test('all four write verbs land the exact authority value sent, not a fixed one', async () => {
    for (const authority of ['owner-direct', 'web-page', 'email', 'channel-message', 'document']) {
      const { catalog, bodies } = catalogRecordingBodies();
      const invoke = createProfileGatewayInvoke({ gatewayMethods: catalog, configManager, homeDirectory: '/home/owner' });
      await invoke(PROFILE_METHOD_IDS.set, { fieldId: 'contact.email', value: 'x', surface: 'agent', said: 'x', authority });
      await invoke(PROFILE_METHOD_IDS.append, { section: 'Notes', text: 'x', surface: 'agent', said: 'x', authority });
      await invoke(PROFILE_METHOD_IDS.forget, { fieldId: 'contact.email', authority });
      await invoke(PROFILE_METHOD_IDS.undo, { fieldId: 'contact.email', authority });
      for (const id of WRITE_VERBS) {
        expect((bodies.get(id) as Record<string, unknown>).authority, `${id} with authority ${authority}`).toBe(authority);
      }
    }
  });
});
