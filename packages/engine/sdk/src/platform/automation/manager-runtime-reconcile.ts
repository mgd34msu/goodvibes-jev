import { AgentManager } from '../tools/agent/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { AutomationJob } from './jobs.js';
import type { AutomationRun } from './runs.js';
import { buildRunTelemetryFromAgent, getTerminalAgentState } from './manager-runtime-helpers.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import {
  scheduleAutomationFailureFollowUp,
  settleAutomationRunFailure,
  type AutomationFailureFollowUpContext,
} from './manager-runtime-delivery.js';

interface AutomationReconcileContext {
  readonly configManager: ConfigManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly agentStatusProvider: Pick<AgentManager, 'getStatus'>;
  readonly jobs: Map<string, AutomationJob>;
  readonly runs: Map<string, AutomationRun>;
  readonly saveJobs: () => Promise<void>;
  readonly saveRuns: () => Promise<void>;
  readonly syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => Promise<void>;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  readonly emitRunCompleted: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => void;
  /** Delivers failure notices, emits run-failed and applies the job's retry or cooldown policy. */
  readonly followUp: AutomationFailureFollowUpContext;
  readonly emitJobAutoDisabled: (job: AutomationJob, reason: string) => void;
  readonly maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => void;
  readonly applyFailureToJob: (job: AutomationJob, timestamp: number, countRun?: boolean) => AutomationJob;
  readonly pruneRunHistory: () => void;
  readonly cancelTimer: (jobId: string) => void;
}

function reportAsyncFailure(label: string, error: unknown, metadata: Record<string, unknown> = {}): void {
  logger.warn(`AutomationManager: ${label} failed`, {
    ...metadata,
    error: summarizeError(error),
  });
}

/**
 * A run whose agent vanished before reporting a terminal state was lost to a
 * restart, not failed by its work, so another attempt could succeed. Known
 * from structure; nothing to read.
 */
const AGENT_STATE_LOST = {
  failureClass: 'retryable',
  basis: 'explicit',
  detail: 'the agent state was lost before the run completed',
} as const;

export function reconcileAutomationActiveRuns(context: AutomationReconcileContext): void {
  let jobsChanged = false;
  let runsChanged = false;
  for (const run of context.runs.values()) {
    if (run.status !== 'running' || !run.agentId) continue;
    const agent = context.agentStatusProvider.getStatus(run.agentId);
    if (!agent) {
      const missingAgeMs = Date.now() - (run.startedAt ?? run.queuedAt);
      if (missingAgeMs < Math.max(300_000, Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000)) {
        continue;
      }
    }
    if (!agent) {
      const endedAt = Date.now();
      const updatedRun: AutomationRun = {
        ...run,
        status: 'failed',
        endedAt,
        durationMs: Math.max(0, endedAt - (run.startedAt ?? run.queuedAt)),
        updatedAt: endedAt,
        error: 'Agent state lost before completion',
      };
      context.runs.set(run.id, updatedRun);
      context.syncRunToRuntime(updatedRun, 'automation.reconcile');
      const job = context.jobs.get(run.jobId);
      if (job) {
        const updatedJob = context.applyFailureToJob(job, endedAt, false);
        context.jobs.set(job.id, updatedJob);
        void context.syncExecutionRoute(updatedJob, updatedRun).catch((error: unknown) => {
          reportAsyncFailure('execution route sync', error, { jobId: updatedJob.id, runId: updatedRun.id });
        });
        if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
          void context.sessionBroker.appendSystemMessage(updatedRun.sessionId, updatedRun.error ?? 'Agent state lost before completion', {
            status: 'failed',
            automationJobId: updatedJob.id,
            automationRunId: updatedRun.id,
          }).catch((error: unknown) => {
            reportAsyncFailure('session system message append', error, {
              sessionId: updatedRun.sessionId,
              jobId: updatedJob.id,
              runId: updatedRun.id,
            });
          });
        }
        context.syncJobToRuntime(updatedJob, 'automation.reconcile');
        settleAutomationRunFailure(context.followUp, updatedJob, updatedRun, updatedRun.error ?? 'Agent state lost', { known: AGENT_STATE_LOST });
        jobsChanged = true;
      }
      runsChanged = true;
      continue;
    }
    const terminalStatus = getTerminalAgentState(agent);
    if (!terminalStatus) continue;

    const endedAt = agent.completedAt ?? Date.now();
    const durationMs = run.startedAt !== undefined ? Math.max(0, endedAt - run.startedAt) : 0;
    const updatedRun: AutomationRun = {
      ...run,
      status: terminalStatus,
      endedAt,
      durationMs,
      updatedAt: endedAt,
      telemetry: buildRunTelemetryFromAgent(agent, run),
      ...(terminalStatus === 'completed'
        ? { result: agent.fullOutput ?? agent.streamingContent ?? agent.progress ?? null }
        : terminalStatus === 'failed'
          ? { error: agent.error ?? 'Agent failed' }
          : { cancelledReason: agent.error ?? 'Agent cancelled' }),
    };
    context.runs.set(run.id, updatedRun);
    context.syncRunToRuntime(updatedRun, 'automation.reconcile');
    runsChanged = true;

    const job = context.jobs.get(run.jobId);
    if (!job) continue;
    const wasEnabled = job.enabled;
    const updatedJob: AutomationJob = terminalStatus === 'completed'
      ? {
          ...job,
          successCount: job.successCount + 1,
          failureCount: 0,
          updatedAt: endedAt,
        }
      : context.applyFailureToJob(job, endedAt, false);
    context.jobs.set(job.id, updatedJob);
    void context.syncExecutionRoute(updatedJob, updatedRun).catch((error: unknown) => {
      reportAsyncFailure('execution route sync', error, { jobId: updatedJob.id, runId: updatedRun.id });
    });
    if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
      const sessionBody = terminalStatus === 'completed'
        ? String(updatedRun.result ?? '')
        : terminalStatus === 'failed'
          ? updatedRun.error ?? 'Agent failed'
          : updatedRun.cancelledReason ?? 'Agent cancelled';
      if (sessionBody.trim().length > 0) {
        void context.sessionBroker.completeAgent(updatedRun.sessionId, updatedRun.agentId ?? updatedRun.id, sessionBody, {
          status: terminalStatus,
          automationJobId: updatedJob.id,
          automationRunId: updatedRun.id,
          routeId: updatedRun.routeId,
        }).catch((error: unknown) => {
          reportAsyncFailure('session agent completion', error, {
            sessionId: updatedRun.sessionId,
            jobId: updatedJob.id,
            runId: updatedRun.id,
          });
        });
      }
    }
    context.syncJobToRuntime(updatedJob, 'automation.reconcile');
    if (terminalStatus === 'completed') {
      context.emitRunCompleted(updatedJob, updatedRun, 'success');
    } else if (terminalStatus === 'cancelled') {
      context.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
    }
    context.maybeDeliverRun(updatedJob, updatedRun);
    if (terminalStatus === 'completed' && updatedJob.deleteAfterRun) {
      context.cancelTimer(updatedJob.id);
      context.jobs.delete(updatedJob.id);
    } else if (terminalStatus === 'failed') {
      settleAutomationRunFailure(context.followUp, updatedJob, updatedRun, updatedRun.error ?? 'Agent failed', { error: agent.error ?? '' });
    } else if (terminalStatus === 'cancelled') {
      // A cancellation has no failure to read; the job's policy applies as configured.
      scheduleAutomationFailureFollowUp(context.followUp, updatedJob, updatedRun, true);
    }
    if (!updatedJob.enabled && wasEnabled && terminalStatus !== 'completed') {
      context.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
    }
    jobsChanged = true;
  }
  if (jobsChanged) {
    void context.saveJobs().catch((error: unknown) => {
      reportAsyncFailure('job persistence', error);
    });
  }
  if (runsChanged) {
    context.pruneRunHistory();
    void context.saveRuns().catch((error: unknown) => {
      reportAsyncFailure('run persistence', error);
    });
  }
}
