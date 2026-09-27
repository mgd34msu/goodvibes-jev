import { describe, expect, test } from 'bun:test';
import { validatePluginError } from '../sdk/src/events/contracts.ts';

describe('PLUGIN_ERROR validator', () => {
  test('accepts the payload the plugin manager emits', () => {
    expect(validatePluginError({ type: 'PLUGIN_ERROR', pluginId: 'p1', error: 'boom', fatal: false }).valid).toBe(true);
  });

  test('rejects a payload missing fatal or with the old pluginName shape', () => {
    expect(validatePluginError({ type: 'PLUGIN_ERROR', pluginId: 'p1', error: 'boom' }).valid).toBe(false);
    expect(validatePluginError({ type: 'PLUGIN_ERROR', pluginName: 'p1', error: 'boom', fatal: true }).valid).toBe(false);
  });
});
