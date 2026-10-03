import { describe, expect, test } from 'bun:test';
import { buildSetupWizardDurableReceiptsFromReadModel } from '../../agent/setup-wizard-artifact-receipts.ts';
import { buildAgentSetupWizard, emptyAgentSetupSmokeHistory, setupStepHasSatisfyingReceipt, type AgentSetupWizardCheckpoint, type AgentSetupWizardDurableReceipt, type AgentSetupWizardSmokeHistory, type AgentSetupWizardSourceItem } from '../../agent/setup-wizard.ts';

const baseItems: readonly AgentSetupWizardSourceItem[] = [
  {
    id: 'runtime',
    label: 'Connected host',
    status: 'ready',
    detail: 'Host route is configured.',
    userRoute: 'Start -> Connected host',
    modelRoute: 'agent_harness mode:"connected_host_status"',
  },
  {
    id: 'provider-model',
    label: 'Provider and model',
    status: 'recommended',
    detail: 'Choose a model.',
    userRoute: 'Start -> Provider and model',
    modelRoute: 'models action:"status"',
  },
  {
    id: 'install-smoke',
    label: 'Install smoke',
    status: 'recommended',
    detail: 'Run setup smoke.',
    userRoute: 'Start -> Install smoke',
    modelRoute: 'agent_harness mode:"run_setup_smoke"',
  },
];

const browserPwaItem: AgentSetupWizardSourceItem = {
  id: 'browser-pwa',
  label: 'Browser/PWA',
  status: 'recommended',
  detail: 'Browser cockpit is openable, but the connected-host browser/PWA first-run receipt is not published.',
  userRoute: 'Voice & Media -> Browser/PWA readiness',
  modelRoute: 'computer action:"browser" includeParameters:true',
};

function checkpoint(stepId = 'install-smoke'): AgentSetupWizardCheckpoint {
  return {
    status: 'available',
    currentStepId: stepId,
    currentStepLabel: stepId === 'install-smoke' ? 'Install smoke' : 'Provider and model',
    savedAt: '2026-06-06T12:00:00.000Z',
    source: 'harness',
    resumed: false,
    summary: 'Saved setup checkpoint.',
    path: '/tmp/wizard-checkpoint.json',
    markCurrentRoute: 'agent_harness mode:"mark_setup_checkpoint"',
    clearRoute: 'agent_harness mode:"clear_setup_checkpoint"',
    inspectRoute: 'agent_harness mode:"setup_checkpoint"',
  };
}

function readySmokeHistory(): AgentSetupWizardSmokeHistory {
  return {
    status: 'available',
    total: 1,
    trend: 'first-run',
    latestResult: 'ready-for-user-run',
    previousResult: null,
    latestEvidenceId: 'artifact-1',
    latestEvidenceAt: '2026-06-06T12:30:00.000Z',
    resultCounts: { 'ready-for-user-run': 1 },
    blockedCheckFrequency: [],
    inspectLatestRoute: 'agent_artifacts show artifactId:"artifact-1" includeContent:false',
    rerunRoute: 'agent_harness mode:"run_setup_smoke"',
    saveRoute: 'agent_harness mode:"run_setup_smoke" fields:{...}',
  };
}

describe('Agent setup wizard checkpoints', () => {
  test('resumes a saved non-ready checkpoint when no live blocker takes priority', () => {
    const wizard = buildAgentSetupWizard({
      items: baseItems,
      smokeHistory: emptyAgentSetupSmokeHistory(),
      checkpoint: checkpoint(),
    });

    expect(wizard.currentStepId).toBe('install-smoke');
    expect(wizard.currentStepLabel).toBe('Install smoke');
    expect(wizard._diagnostic.checkpoint.status).toBe('available');
    expect(wizard._diagnostic.checkpoint.resumed).toBe(true);
    expect(wizard._diagnostic.checkpoint.summary).toContain('Resuming Install smoke');
    expect(wizard.steps.find((step) => step.id === 'install-smoke')?.status).toBe('current');
  });

  test('keeps a valid saved checkpoint but focuses an earlier live blocker', () => {
    const wizard = buildAgentSetupWizard({
      items: baseItems.map((item) => item.id === 'provider-model' ? { ...item, status: 'blocked' as const } : item),
      smokeHistory: emptyAgentSetupSmokeHistory(),
      checkpoint: checkpoint(),
    });

    expect(wizard.status).toBe('blocked');
    expect(wizard.currentStepId).toBe('provider-model');
    expect(wizard._diagnostic.checkpoint.status).toBe('available');
    expect(wizard._diagnostic.checkpoint.resumed).toBe(false);
    expect(wizard._diagnostic.checkpoint.summary).toContain('live blocker Provider and model is taking priority');
    expect(wizard.steps.find((step) => step.id === 'install-smoke')?.status).toBe('pending');
  });

  test('marks a checkpoint stale after the saved step becomes ready', () => {
    const wizard = buildAgentSetupWizard({
      items: baseItems.map((item) => item.id === 'install-smoke' ? { ...item, status: 'ready' as const } : item),
      smokeHistory: emptyAgentSetupSmokeHistory(),
      checkpoint: checkpoint(),
    });

    expect(wizard.currentStepId).toBe('provider-model');
    expect(wizard._diagnostic.checkpoint.status).toBe('stale');
    expect(wizard._diagnostic.checkpoint.resumed).toBe(false);
    expect(wizard._diagnostic.checkpoint.summary).toContain('already ready');
  });

  test('builds timestamped step history and explicit durable receipt gaps', () => {
    const wizard = buildAgentSetupWizard({
      items: [...baseItems, browserPwaItem],
      smokeHistory: readySmokeHistory(),
      checkpoint: checkpoint('provider-model'),
      receiptRequiredStepIds: ['runtime', 'provider-model', 'install-smoke', 'browser-pwa'],
    });

    expect(wizard._diagnostic.stepHistory.map((entry) => entry.id)).toEqual([
      'setup-step-history:install-smoke:setup-smoke:artifact-1',
      'setup-step-history:provider-model:checkpoint:2026-06-06T12:00:00.000Z',
    ]);
    expect(wizard._diagnostic.stepHistory[0]).toMatchObject({
      stepId: 'install-smoke',
      stepLabel: 'Install smoke',
      kind: 'setup-smoke',
      receiptId: 'artifact-1',
      recordedAt: '2026-06-06T12:30:00.000Z',
      receiptStatus: 'ready-for-user-run',
      satisfiesReceipt: true,
    });
    expect(wizard._diagnostic.stepHistory[1]).toMatchObject({
      stepId: 'provider-model',
      kind: 'checkpoint',
      receiptId: 'setup-wizard-checkpoint:provider-model:2026-06-06T12:00:00.000Z',
      recordedAt: '2026-06-06T12:00:00.000Z',
      satisfiesReceipt: false,
    });
    expect(wizard._diagnostic.receiptGaps).toEqual([
      {
        stepId: 'runtime',
        stepLabel: 'Connected host',
        requiredReceipt: 'connected-host service status receipt',
        summary: 'Connected host still needs a stable connected-host service status receipt id and timestamp before release closeout can count it as durable setup evidence.',
      },
      {
        stepId: 'provider-model',
        stepLabel: 'Provider and model',
        requiredReceipt: 'durable setup receipt',
        summary: 'Provider and model still needs a stable durable setup receipt id and timestamp before release closeout can count it as durable setup evidence.',
      },
      {
        stepId: 'browser-pwa',
        stepLabel: 'Browser/PWA',
        requiredReceipt: 'connected-host browser/PWA first-run receipt',
        summary: 'Browser/PWA still needs a stable connected-host browser/PWA first-run receipt id and timestamp before release closeout can count it as durable setup evidence.',
      },
    ]);
  });

  test('auto-advances setup rows from ready durable receipts without counting blocked receipts', () => {
    const receipts: readonly AgentSetupWizardDurableReceipt[] = [
      {
        stepId: 'connected-host-readiness',
        stepLabel: 'Connected host',
        status: 'ready',
        receiptId: 'svc-ready',
        recordedAt: '2026-06-06T13:00:00.000Z',
        summary: 'services.status reported healthy.',
        inspectRoute: 'agent_artifacts show artifactId:"svc" includeContent:false',
      },
      {
        stepId: 'connected-host-auth',
        stepLabel: 'Connected-host auth',
        status: 'ready',
        receiptId: 'auth-ready',
        recordedAt: '2026-06-06T13:01:00.000Z',
        summary: 'Operator token was authenticated.',
        inspectRoute: 'agent_artifacts show artifactId:"auth" includeContent:false',
      },
      {
        stepId: 'browser-pwa',
        stepLabel: 'Browser/PWA',
        status: 'blocked',
        receiptId: 'browser-blocked',
        recordedAt: '2026-06-06T13:02:00.000Z',
        summary: 'Browser first-run receipt is missing.',
        inspectRoute: 'agent_artifacts show artifactId:"browser" includeContent:false',
      },
    ];
    const wizard = buildAgentSetupWizard({
      items: [
        { ...baseItems[0]!, status: 'check' },
        {
          id: 'connected-host-auth',
          label: 'Connected-host auth',
          status: 'blocked',
          detail: 'Token missing.',
          userRoute: 'Host -> Auth',
          modelRoute: 'setup action:"token"',
        },
        { ...baseItems[2]!, status: 'recommended' },
        browserPwaItem,
      ],
      smokeHistory: emptyAgentSetupSmokeHistory(),
      receiptRequiredStepIds: ['runtime', 'connected-host-auth', 'install-smoke', 'browser-pwa'],
      durableReceipts: receipts,
    });

    expect(setupStepHasSatisfyingReceipt(receipts, 'runtime')).toBe(true);
    expect(setupStepHasSatisfyingReceipt(receipts, 'browser-pwa')).toBe(false);
    expect(wizard.steps.find((step) => step.id === 'runtime')?.status).toBe('done');
    expect(wizard.steps.find((step) => step.id === 'connected-host-auth')?.status).toBe('done');
    expect(wizard.currentStepId).toBe('install-smoke');
    expect(wizard.steps.find((step) => step.id === 'browser-pwa')?.status).toBe('pending');
    expect(wizard._diagnostic.stepHistory.find((entry) => entry.receiptId === 'browser-blocked')).toMatchObject({
      kind: 'durable-receipt',
      receiptStatus: 'blocked',
      satisfiesReceipt: false,
    });
    expect(wizard._diagnostic.receiptGaps.map((gap) => gap.stepId)).toEqual(['install-smoke', 'browser-pwa']);
  });

  test('does not infer generic first-run setup smoke as browser/PWA receipt', () => {
    const receipts = buildSetupWizardDurableReceiptsFromReadModel({
      receipts: {
        smoke: {
          purpose: 'agent-setup-receipt',
          receiptId: 'first-run-smoke',
          receiptStatus: 'ready',
          recordedAt: '2026-06-06T13:03:00.000Z',
          summary: 'First-run setup smoke completed from package binary to first assistant turn.',
        },
        browser: {
          purpose: 'browser-pwa-first-run-receipt',
          receiptId: 'browser-ready',
          receiptStatus: 'ready',
          recordedAt: '2026-06-06T13:04:00.000Z',
          summary: 'Browser/PWA first-run completed from browser runtime.',
        },
      },
    }, 'test.setup.receipts');

    expect(receipts.map((receipt) => [receipt.receiptId, receipt.stepId])).toEqual([
      ['first-run-smoke', 'install-smoke'],
      ['browser-ready', 'browser-pwa'],
    ]);
  });

  test('accepts a ready durable install-smoke receipt for setup closeout', () => {
    const wizard = buildAgentSetupWizard({
      items: baseItems.map((item) => item.id === 'provider-model' ? { ...item, status: 'ready' as const } : item),
      smokeHistory: emptyAgentSetupSmokeHistory(),
      closeoutCriticalStepIds: ['runtime', 'provider-model'],
      setupMarkerExists: false,
      durableReceipts: [{
        stepId: 'install-smoke',
        stepLabel: 'Install smoke',
        status: 'ready',
        receiptId: 'install-smoke-ready',
        recordedAt: '2026-06-06T13:03:00.000Z',
        summary: 'Durable setup smoke receipt was published by the connected host.',
        inspectRoute: 'agent_artifacts show artifactId:"smoke" includeContent:false',
      }],
    });

    expect(wizard._diagnostic.closeout.status).toBe('ready-to-finish');
    expect(wizard._diagnostic.closeout.evidence.join('\n')).toContain('setup smoke receipt: ready');
    expect(wizard._diagnostic.closeout.evidence.join('\n')).toContain('latest setup smoke: durable receipt ready');
  });

  test('blocks closeout on critical blocked setup rows', () => {
    const wizard = buildAgentSetupWizard({
      items: baseItems.map((item) => item.id === 'provider-model' ? { ...item, status: 'blocked' as const } : item),
      smokeHistory: readySmokeHistory(),
      closeoutCriticalStepIds: ['provider-model'],
      setupMarkerExists: false,
    });

    expect(wizard._diagnostic.closeout.status).toBe('blocked');
    expect(wizard._diagnostic.closeout.primaryStepId).toBe('provider-model');
    expect(wizard._diagnostic.closeout.modelRoute).toContain('models action:"status"');
    expect(wizard._diagnostic.closeout.evidence.join('\n')).toContain('critical setup blockers: Provider and model');
  });

  test('asks for setup smoke before finish when critical setup is ready', () => {
    const wizard = buildAgentSetupWizard({
      items: baseItems.map((item) => item.id === 'provider-model' ? { ...item, status: 'ready' as const } : item),
      smokeHistory: emptyAgentSetupSmokeHistory(),
      closeoutCriticalStepIds: ['runtime', 'provider-model'],
      setupMarkerExists: false,
    });

    expect(wizard._diagnostic.closeout.status).toBe('needs-smoke-evidence');
    expect(wizard._diagnostic.closeout.primaryStepId).toBe('install-smoke');
    expect(wizard._diagnostic.closeout.requiresConfirmation).toBe(true);
    expect(wizard._diagnostic.closeout.modelRoute).toContain('setup action:"smoke"');
  });

  test('routes ready setup to finish and marks complete after the user marker exists', () => {
    const readyItems = baseItems.map((item) => item.id === 'provider-model' ? { ...item, status: 'ready' as const } : item);
    const readyToFinish = buildAgentSetupWizard({
      items: readyItems,
      smokeHistory: readySmokeHistory(),
      closeoutCriticalStepIds: ['runtime', 'provider-model'],
      setupMarkerExists: false,
    });
    expect(readyToFinish._diagnostic.closeout.status).toBe('ready-to-finish');
    expect(readyToFinish._diagnostic.closeout.modelRoute).toContain('setup action:"finish"');
    expect(readyToFinish._diagnostic.closeout.requiresConfirmation).toBe(true);

    const complete = buildAgentSetupWizard({
      items: readyItems,
      smokeHistory: readySmokeHistory(),
      closeoutCriticalStepIds: ['runtime', 'provider-model'],
      setupMarkerExists: true,
    });
    expect(complete._diagnostic.closeout.status).toBe('complete');
    expect(complete._diagnostic.closeout.requiresConfirmation).toBe(false);
    expect(complete._diagnostic.closeout.primaryStepId).toBeNull();
  });
});
