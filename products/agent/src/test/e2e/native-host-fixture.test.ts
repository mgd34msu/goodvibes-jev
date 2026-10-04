import { expect, test } from 'bun:test';
import { createNativeConversationIntakeBinding } from '../../runtime/native-conversation-intake-host.ts';
import { readNativeConversationTurnPermit, revalidateNativeConversationTurnPermit } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { makeHome, removeHome, startStubModel } from './harness.ts';
import { startE2ENativeHost } from './native-host-fixture.ts';

test('startup fixture uses genuine paired capture/admission and revocable turn authority', async () => {
  const model = startStubModel(() => ({ text: 'unused' }));
  const home = await makeHome(model);
  let host: Awaited<ReturnType<typeof startE2ENativeHost>> | undefined;
  try {
    host = await startE2ENativeHost(home);
    const binding = createNativeConversationIntakeBinding({ baseUrl: host.daemon.baseUrl, token: host.env.GOODVIBES_CONNECTED_HOST_TOKEN, workspace: home.workspace }, host.daemon.services.projectPlanningProjectId);
    const client = binding.client;
    try {
      const input = { requestId: 'startup-fixture-request', inputId: 'startup-fixture-input', text: 'please answer the e2e marmot question', unsupportedSources: [] };
      const shared = await host.daemon.fetch('/api/work-ledger/intake/capture', { method: 'POST', body: JSON.stringify(input) });
      expect(shared.status).toBe(403);
      const captured = await client.capture(input);
      const turn = await client.admit({ inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision });
      expect(turn).toMatchObject({ kind: 'turn', text: input.text });
      const permit = client.bindTurn(turn);
      expect(readNativeConversationTurnPermit(permit).text).toBe(input.text);
      await revalidateNativeConversationTurnPermit(permit);
      expect(home.judgments.accepted).toContain('native-route');
      expect(home.judgments.accepted).toContain('native-turn');
      expect(model.requests).toHaveLength(0);
      const principal = host.daemon.services.pairingTokens.authenticateNative(host.env.GOODVIBES_CONNECTED_HOST_TOKEN)!;
      expect(host.daemon.services.pairingTokens.revoke(principal.tokenId)).toBe(true);
      await expect(revalidateNativeConversationTurnPermit(permit)).rejects.toThrow();
    } finally { binding.dispose(); }
  } finally { try { await host?.stop(); } finally { model.stop(); removeHome(home); } }
}, 30000);
