import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { judgmentInputCardProblem } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { makeFixture, executeHarnessJson, CONNECTED_HOST_AUTH_ENV_KEYS, PROVIDER_AUTH_ENV_KEYS, withClearedEnv, withTcpListener, writeConnectedHostOperatorToken, createHarnessFixtureReadings } from "./agent-harness-tool-fixture.ts";


afterAll(cleanupResearchScreeningFixtures);

describe('agent_harness tool', () => {
let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
beforeEach(() => {
    resetAgentMcpCallRouteForTests();
    fixtureLog = new SqliteDecisionLog(':memory:');
    previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
  });
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); });


  test('exposes connected-host auth as a token-safe setup blocker', async () => {
    await withClearedEnv(CONNECTED_HOST_AUTH_ENV_KEYS, async () => {
      const fixture = makeFixture();
      try {
        const missing = await executeHarnessJson<{
          readonly setupItemId: string;
          readonly status: string;
          readonly blocksAutonomy: boolean;
          readonly nextAction: string;
          readonly signals?: readonly string[];
          readonly authPosture?: {
            readonly owner: string;
            readonly operatorToken: {
              readonly present: boolean;
              readonly usable: boolean;
              readonly path: string;
              readonly fingerprint?: string;
            };
            readonly routes: {
              readonly reviewCommand: string;
              readonly connectedHostStatus: string;
              readonly pairingPosture: string;
              readonly qrPairingRoute: string;
              readonly manualTokenRoute: string;
              readonly provisionTokenRoute: string;
              readonly tokenProvisioningOwner: string;
              readonly tokenProvisioningSource: string;
            };
          };
        }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-auth' });

        expect(missing.setupItemId).toBe('connected-host-auth');
        expect(missing.status).toBe('blocked');
        expect(missing.blocksAutonomy).toBe(true);
        expect(missing.nextAction).toContain('confirmed connected-host token provisioning route');
        expect(missing.signals?.join('\n')).toContain('operator token: missing');
        expect(missing.signals?.join('\n')).toContain('setup action:"token"');
        expect(missing.signals?.join('\n')).toContain('getOrCreateCompanionToken');
        expect(missing.authPosture?.owner).toBe('connected-host');
        expect(missing.authPosture?.operatorToken).toMatchObject({ present: false, usable: false });
        expect(missing.authPosture?.routes.reviewCommand).toBe('/auth review');
        expect(missing.authPosture?.routes.connectedHostStatus).toContain('host action:"status"');
        expect(missing.authPosture?.routes.pairingPosture).toContain('pairing_posture');
        expect(missing.authPosture?.routes.qrPairingRoute).toContain('qr-pairing');
        expect(missing.authPosture?.routes.manualTokenRoute).toContain('manual-token-display');
        expect(missing.authPosture?.routes.provisionTokenRoute).toContain('setup action:"token"');
        expect(missing.authPosture?.routes.tokenProvisioningOwner).toContain('canonical token store');
        expect(missing.authPosture?.routes.tokenProvisioningSource).toContain('operator-tokens.json');

        const repair = await executeHarnessJson<{
          readonly mode: string;
          readonly setupItemId: string;
          readonly decision: {
            readonly id: string;
            readonly status: string;
            readonly effect: string;
            readonly modelRoute: string;
            readonly requiresConfirmation?: boolean;
          };
          readonly policy: { readonly confirmation: string };
        }>(fixture, { mode: 'setup_repair', setupItemId: 'connected-host-auth' });
        expect(repair.mode).toBe('setup_repair');
        expect(repair.setupItemId).toBe('connected-host-auth');
        expect(repair.decision.id).toBe('provision-connected-host-token');
        expect(repair.decision.status).toBe('confirmed-repair-available');
        expect(repair.decision.effect).toBe('confirmed-effect');
        expect(repair.decision.modelRoute).toContain('setup action:"token"');
        expect(repair.decision.requiresConfirmation).toBe(true);
        expect(repair.policy.confirmation).toContain('confirm:true');

        const unconfirmedProvision = await fixture.tool.execute({
          mode: 'provision_connected_host_token',
          setupItemId: 'connected-host-auth',
        });
        expect(unconfirmedProvision.success).toBe(false);
        expect(unconfirmedProvision.error).toContain('current recorded effect admission');

        const missingProvisionConfirm = await fixture.tool.execute({
          mode: 'provision_connected_host_token',
          setupItemId: 'connected-host-auth',
          explicitUserRequest: 'Provision connected-host auth for setup.',
        });
        expect(missingProvisionConfirm.success).toBe(false);
        expect(missingProvisionConfirm.error).toContain('current recorded effect admission');

        const provisioned = await executeHarnessJson<{
          readonly status: string;
          readonly mode: string;
          readonly setupItemId: string;
          readonly token: {
            readonly path: string;
            readonly present: boolean;
            readonly usable: boolean;
            readonly fingerprint?: string | null;
            readonly rawValueReturned: boolean;
            readonly fileMode?: string | null;
          };
          readonly companionRecord?: { readonly peerId?: string; readonly surface?: string };
          readonly mutation?: {
            readonly performed?: boolean;
            readonly result?: string;
            readonly source?: string;
          };
          readonly routes: { readonly inspectStatus: string; readonly runSetupSmoke: string };
          readonly policy: { readonly secrets: string; readonly rotation: string };
        }>(fixture, {
          mode: 'provision_connected_host_token',
          setupItemId: 'connected-host-auth',
          confirm: true,
          explicitUserRequest: 'Provision connected-host auth for setup.',
        });

        expect(provisioned.status).toBe('created');
        expect(provisioned.mode).toBe('provision_connected_host_token');
        expect(provisioned.setupItemId).toBe('connected-host-auth');
        expect(provisioned.token.present).toBe(true);
        expect(provisioned.token.usable).toBe(true);
        expect(provisioned.token.rawValueReturned).toBe(false);
        expect(provisioned.token.path).toBe(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'));
        expect(provisioned.token.fileMode).toBe('0600');
        expect(provisioned.token.fingerprint).toHaveLength(12);
        expect(provisioned.companionRecord?.surface).toBe('goodvibes-agent');
        expect(provisioned.companionRecord?.peerId).toHaveLength(24);
        expect(provisioned.mutation?.performed).toBe(true);
        expect(provisioned.mutation?.source).toBe('getOrCreateCompanionToken');
        expect(provisioned.routes.inspectStatus).toContain('host action:"status"');
        expect(provisioned.routes.runSetupSmoke).toContain('setup action:"smoke"');
        expect(provisioned.policy.secrets).toContain('raw token is not returned');
        expect(provisioned.policy.rotation).toContain('preserves a valid existing token');
        const tokenRecordPath = join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json');
        expect(existsSync(tokenRecordPath)).toBe(true);
        const tokenRecord = JSON.parse(readFileSync(tokenRecordPath, 'utf-8')) as { readonly token?: string };
        expect(tokenRecord.token?.startsWith('gv_')).toBe(true);
        expect(JSON.stringify(provisioned)).not.toContain(tokenRecord.token ?? 'missing-generated-token');

        writeConnectedHostOperatorToken(fixture);
        const ready = await executeHarnessJson<{
          readonly status: string;
          readonly signals?: readonly string[];
          readonly authPosture?: {
            readonly operatorToken: {
              readonly present: boolean;
              readonly usable: boolean;
              readonly fingerprint?: string;
            };
          };
        }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-auth' });

        expect(ready.status).toBe('blocked');
        expect(ready.signals?.join('\n')).toContain('operator token: readable (not authority evidence)');
        expect(ready.authPosture?.operatorToken.present).toBe(true);
        expect(ready.authPosture?.operatorToken.usable).toBe(true);
        expect(ready.authPosture?.operatorToken.fingerprint).toHaveLength(12);
        expect(JSON.stringify(ready)).not.toContain('fixture-connected-host-token');
      } finally {
        fixture.cleanup();
      }
    });
  });


  for (const clock of [1_900_000_000_001, 1_900_000_000_000]) test(`setup ranking preserves native capture clocks: ${clock}`, async () => {
    const now = spyOn(Date, 'now').mockReturnValue(clock);
    const fixture = makeFixture();
    try {
      expect(judgmentInputCardProblem(clock)).toBe(clock === 1_900_000_000_000 ? 'card-material' : undefined);
      const posture = await executeHarnessJson<{ readonly capturedAt: string }>(fixture, {
        mode: 'setup_posture', query: 'provider-access', includeParameters: true,
      });
      expect(posture.capturedAt).toBe(new Date(clock).toISOString());
      await expect(fixture.admittedTool.execute({ mode: 'setup_posture', query: 'provider-access', suppliedClock: 1_900_000_000_000 }))
        .rejects.toBeInstanceOf(ToolInputProjectionError);
    } finally { fixture.cleanup(); now.mockRestore(); }
  });


  test('refuses unowned host sources and covers first-run provider and reachable host states', async () => {
    await withClearedEnv([...CONNECTED_HOST_AUTH_ENV_KEYS, ...PROVIDER_AUTH_ENV_KEYS], async () => {
      const missingHost = makeFixture();
      let sourceReads = 0;
      try {
        (missingHost.context.platform as unknown as {
          serviceRegistry: { getAll: () => Record<string, never>; inspect: () => Promise<null> };
        }).serviceRegistry = {
          getAll: () => {
            sourceReads += 1;
            throw new Error('connected host registry unavailable');
          },
          inspect: async () => null,
        };
        const host = await missingHost.admittedTool.execute({ mode: 'setup_item', setupItemId: 'connected-host-readiness' });
        expect(host.success).toBe(false);
        expect(sourceReads).toBe(0);
        expect(JSON.stringify(host)).not.toContain('connected host registry unavailable');
        const repair = await missingHost.admittedTool.execute({ mode: 'setup_repair', setupItemId: 'connected-host-readiness', includeParameters: true });
        expect(repair.success).toBe(false);
        expect(sourceReads).toBe(0);
      } finally {
        missingHost.cleanup();
      }

      const providerFixture = makeFixture();
      try {
        const posture = await executeHarnessJson<{
          readonly readinessPlan: readonly { readonly setupItemId: string; readonly status: string; readonly nextAction: string; readonly signals?: readonly string[] }[];
        }>(providerFixture, { mode: 'setup_posture', query: 'provider-access', includeParameters: true });
        const provider = posture.readinessPlan.find((item) => item.setupItemId === 'provider-access');
        expect(provider?.status).toBe('blocked');
        expect(provider?.nextAction).toContain('Choose a provider/model route');
        expect(provider?.signals ?? []).toEqual([]);
      } finally {
        providerFixture.cleanup();
      }

      await withTcpListener(async (port) => {
        const reachableHost = makeFixture({ controlPlaneEnabled: true, controlPlanePort: port });
        try {
          writeConnectedHostOperatorToken(reachableHost);
          const host = await executeHarnessJson<{
            readonly status: string;
            readonly serviceProbe?: { readonly status: string; readonly binding: string };
            readonly bootstrapPlan?: { readonly status: string };
            readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string; readonly modelRoute: string };
            readonly recommendedRepairCards?: readonly string[];
            readonly repairCards?: readonly { readonly id: string; readonly recommendation: string }[];
          }>(reachableHost, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });

          expect(host.status).toBe('check');
          expect(host.serviceProbe?.status).toBe('reachable');
          expect(host.serviceProbe?.binding).toBe(`127.0.0.1:${port}`);
          expect(host.bootstrapPlan?.status).toBe('optional');
          expect(host.serviceLifecycleDecision?.status).toBe('no-lifecycle-action');
          expect(host.serviceLifecycleDecision?.recommendedAction).toBe('none');
          expect(host.serviceLifecycleDecision?.modelRoute).toContain('services.status');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-status');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-install');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-start');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-restart');
          expect(host.repairCards?.find((card) => card.id === 'service-status')?.recommendation).toBe('not-needed');
          expect(host.repairCards?.find((card) => card.id === 'service-start')?.recommendation).toBe('not-needed');

          const repair = await executeHarnessJson<{
            readonly setupItemId: string;
            readonly decision: { readonly id: string; readonly status: string; readonly modelRoute: string; readonly requiresConfirmation?: boolean };
            readonly possibleConfirmedRepairs?: readonly unknown[];
          }>(reachableHost, { mode: 'setup_repair', setupItemId: 'connected-host-readiness' });
          expect(repair.setupItemId).toBe('connected-host-readiness');
          expect(repair.decision.id).toBe('connected-host-status');
          expect(repair.decision.status).toBe('ready');
          expect(repair.decision.modelRoute).toContain('host action:"status"');
          expect(repair.decision.requiresConfirmation).toBeUndefined();
          expect(repair.possibleConfirmedRepairs).toBeUndefined();

          const auth = await executeHarnessJson<{ readonly status: string }>(reachableHost, {
            mode: 'setup_item',
            setupItemId: 'connected-host-auth',
          });
          expect(auth.status).toBe('blocked');
        } finally {
          reachableHost.cleanup();
        }
      });
    });
  });
});
