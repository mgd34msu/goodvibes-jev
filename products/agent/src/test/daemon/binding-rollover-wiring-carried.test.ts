/**
 * Binding-rollover wiring: carried by the SDK path this fork already uses, not
 * duplicated here.
 *
 * The SDK's daemon facade composition wires two pieces onto the graph it is
 * handed: the session register's own voice on a channel, used when it heals a
 * route binding that named an unusable session (so the person on the other end
 * is told the conversation moved instead of meeting an assistant that has
 * silently forgotten the last two days), and one ingress alarm across every
 * inbound path (so the first failed inbound owner message pings the owner
 * through a working channel rather than warning into a debug log).
 *
 * This fork composes NO daemon facade of its own, and composes no server at
 * all. What it hands the SDK's discovery path is
 * `asDaemonGradeView()`, the graph with its two client narrowings substituted
 * back, so THAT is the object these seams have to be reachable on. Re-doing
 * either here would be a second sender competing with the first for the same
 * channel.
 *
 * What is worth asserting is the HANDOFF, which is the half that can break here:
 * the facade reaches the wiring through the view's `sessionBroker`,
 * `routeBindings` and `channelPlugins`, and calls a specific method on each. A
 * composition root that stopped returning one of those members, or returned
 * something that no longer carried the method, would leave a daemon whose
 * rollovers announce nothing, and it would still compile, because the call
 * sites are inside the SDK.
 *
 * The type pin in services.ts (`_ClientRuntimeServicesPin`) proves the graph is
 * a CLIENT graph. It says nothing about what the daemon-grade view actually
 * constructed, which is what this file covers.
 */
import { describe, expect, test } from 'bun:test';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

describe('binding-rollover wiring is reachable on this fork\'s composed graph', () => {
  const services = getTestRuntimeServices();
  // What the SDK is actually handed. `services.sessionBroker` is the client
  // dispatch seam and carries none of these methods by design.
  const view = services.asDaemonGradeView();

  test('the view carries the three members the facade wires the rollover through', () => {
    expect(view.sessionBroker).toBeTruthy();
    expect(view.routeBindings).toBeTruthy();
    expect(view.channelPlugins).toBeTruthy();
  });

  test('the view\'s session register is the one automation runs on, not a second copy', () => {
    // One register, reachable under both names. A view that built its own would
    // heal bindings on sessions automation never sees.
    expect(view.sessionBroker).toBe(services.automationSessionRegister);
  });

  test('the session register accepts the notice sender the facade installs', () => {
    // `setSurfaceNoticeSender` is how a healed binding gets a voice. Absent, a
    // rollover is silent to the person it happened to.
    expect(typeof view.sessionBroker.setSurfaceNoticeSender).toBe('function');
    // The sender the facade installs resolves the binding by route id before
    // delivering, so this is part of the same one path.
    expect(typeof view.routeBindings.getBinding).toBe('function');
  });

  test('the channel plugin registry accepts the one ingress alarm', () => {
    expect(typeof view.channelPlugins.setIngressAlarm).toBe('function');
  });

  test('the reply binder the same helper installs is also reachable', () => {
    // Named here because it is the sibling seam on the same object: if a future
    // SDK bump renamed the notice sender, it would most likely rename this too,
    // and one assertion covering both narrows the search.
    expect(typeof view.sessionBroker.setSurfaceReplyBinder).toBe('function');
  });

  test('the client graph does NOT expose the register under the dispatch name', () => {
    // The whole point of the narrowing: a caller that wants "is this session
    // live" must not reach a cross-surface register through `sessionBroker`.
    expect((services.sessionBroker as unknown as Record<string, unknown>)['listSessions']).toBeUndefined();
    expect(typeof services.sessionBroker.setContinuationRunner).toBe('function');
  });
});
