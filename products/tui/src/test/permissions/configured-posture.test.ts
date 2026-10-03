import { expect, test } from 'bun:test';
import { GATE_PRESETS } from '@goodvibes-jev/engine/sdk/platform/gate';
import { describePermissionMode, describeConfiguredPermissions } from '../../permissions/configured-posture.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

test('every declared preset retains its authoritative summary and boundary caveat', () => {
  for (const preset of Object.values(GATE_PRESETS)) {
    const description = describePermissionMode(preset.mode);
    expect(description.detail).toContain(preset.summary);
    expect(description.detail).toContain('boundary');
    expect(description.detail).toContain('not a per-call permission decision');
  }
});
test('unknown mode values are reported without claiming a known preset', () => {
  for (const mode of [undefined, false, 'unrecognized']) {
    expect(describePermissionMode(mode).detail).toContain('Unrecognized permission mode');
  }
});
test('only explicit automatic approval enables the broad-autonomy description', () => {
  const enabled = describeConfiguredPermissions({ get: configGetStub({ 'behavior.autoApprove': true }) });
  expect(enabled.label).toContain('Auto-approve ON');
  expect(enabled.detail).toContain('boundary');
  const disabled = describeConfiguredPermissions({ get: configGetStub({ 'behavior.autoApprove': false, 'permissions.mode': 'allow-all' }) });
  expect(disabled.label).toBe('Automatic below critical stakes');
});
