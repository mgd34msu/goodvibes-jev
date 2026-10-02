/**
 * Composition-root wiring proof (mirrors the SDK's runtime services): a
 * secrets write triggers a LIVE provider credential refresh, one credential
 * chain (env -> secrets -> subscription) with no restart needed.
 */
import { describe, expect, test } from 'bun:test';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';

describe('credential refresh-on-change wiring', () => {
  test('a secrets write triggers providerRegistry.refreshProviderCredentials', async () => {
    const services = getTestRuntimeServices();
    const registry = services.providerRegistry as { refreshProviderCredentials: () => Promise<void> };
    const original = registry.refreshProviderCredentials.bind(services.providerRegistry);
    let refreshes = 0;
    registry.refreshProviderCredentials = async () => {
      refreshes += 1;
      return original();
    };
    try {
      await services.secretsManager.set('GV_AGENT_TEST_CREDENTIAL', 'test-value');
      // The change listener fires synchronously after a successful set(); the
      // refresh itself is fire-and-forget, so only the call is asserted.
      expect(refreshes).toBeGreaterThanOrEqual(1);
      await services.secretsManager.delete('GV_AGENT_TEST_CREDENTIAL');
      expect(refreshes).toBeGreaterThanOrEqual(2);
    } finally {
      registry.refreshProviderCredentials = original;
    }
  });
});
