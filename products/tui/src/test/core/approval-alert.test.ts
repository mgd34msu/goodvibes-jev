import { makeTestWebhookNotifier } from '../helpers/notification-transport.ts';
/**
 * Tests for src/core/approval-alert.ts
 *
 * Covers:
 * - the wrapped handler's resolved decision passes through unchanged
 * - fires exactly once per requestPermission call when unfocused/unknown
 * - suppressed when focused and notifyOnlyWhenUnfocused is true (default)
 * - always fires when notifyOnlyWhenUnfocused is false, even when focused
 * - never fires when notifyOnApprovalPending is off
 * - message content: tool name + category only, never args
 */
import { describe, test, expect, mock } from 'bun:test';
import { wrapRequestPermissionWithAlert } from '../../core/approval-alert.ts';
import { FocusTracker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';

function makeRequest(overrides: Partial<PermissionPromptRequest> = {}): PermissionPromptRequest {
  return {
    callId: 'call-1',
    tool: 'exec',
    args: { command: 'rm -rf /SECRET_PATH_xyzzy' },
    category: 'execute' as PermissionPromptRequest['category'],
    analysis: {} as PermissionPromptRequest['analysis'],
    ...overrides,
  };
}

const makeSpyNotifier = makeTestWebhookNotifier;

function makeConfigGet(overrides: Record<string, unknown> = {}) {
  return (key: string): unknown => overrides[key];
}

describe('wrapRequestPermissionWithAlert', () => {
  test('the wrapped decision passes through unchanged', async () => {
    const original = mock(async () => ({ approved: true, remember: false }));
    const tracker = new FocusTracker();
    const wrapped = wrapRequestPermissionWithAlert(original, {
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: null,
    });
    const decision = await wrapped(makeRequest());
    expect(decision).toEqual({ approved: true, remember: false });
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('fires exactly once per call when unfocused', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
    });
    await wrapped(makeRequest());
    expect(notifier.sendNotification).toHaveBeenCalledTimes(1);
  });

  test('fires when focus was never observed (unknown)', async () => {
    const tracker = new FocusTracker();
    const notifier = makeSpyNotifier();
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
    });
    await wrapped(makeRequest());
    expect(notifier.sendNotification).toHaveBeenCalledTimes(1);
  });

  test('suppressed when focused and notifyOnlyWhenUnfocused is true (default)', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const notifier = makeSpyNotifier();
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: notifier,
    });
    await wrapped(makeRequest());
    expect(notifier.sendNotification).not.toHaveBeenCalled();
  });

  test('fires even when focused, when the master gate is off', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(true);
    const notifier = makeSpyNotifier();
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({ 'behavior.notifyOnlyWhenUnfocused': false }),
      webhookNotifier: notifier,
    });
    await wrapped(makeRequest());
    expect(notifier.sendNotification).toHaveBeenCalledTimes(1);
  });

  test('never fires when notifyOnApprovalPending is off, regardless of focus', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({ 'behavior.notifyOnApprovalPending': false }),
      webhookNotifier: notifier,
    });
    await wrapped(makeRequest());
    expect(notifier.sendNotification).not.toHaveBeenCalled();
  });

  test('with behavior.notificationsMetadataOnly on, message is tool name and category only, never raw args content', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const notifier = makeSpyNotifier();
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({ 'behavior.notificationsMetadataOnly': true }),
      webhookNotifier: notifier,
    });
    await wrapped(makeRequest({ tool: 'edit', category: 'write' as PermissionPromptRequest['category'] }));
    const sent = notifier._sent[0] ?? '';
    expect(sent).toContain('edit');
    expect(sent).toContain('write');
    expect(sent).not.toContain('SECRET_PATH_xyzzy');
  });

  test('does not throw when webhookNotifier is null', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: false, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({}),
      webhookNotifier: null,
    });
    await expect(wrapped(makeRequest())).resolves.toEqual({ approved: false, remember: false });
  });

  test('with behavior.notificationsMetadataOnly on, the in-terminal (OSC 9) approval-wait notification carries tool + category only', async () => {
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const calls: Array<{ signal: string; message: string }> = [];
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: true, remember: false }), {
      focusTracker: tracker,
      configGet: makeConfigGet({ 'behavior.notificationsMetadataOnly': true }),
      webhookNotifier: null,
      terminalNotifier: { notify: (signal, message) => { calls.push({ signal, message }); } },
    });
    await wrapped(makeRequest({ tool: 'edit', category: 'write' as PermissionPromptRequest['category'] }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBe('approval-wait');
    expect(calls[0]!.message).toContain('edit');
    expect(calls[0]!.message).toContain('write');
    expect(calls[0]!.message).not.toContain('SECRET_PATH_xyzzy');
  });
});
