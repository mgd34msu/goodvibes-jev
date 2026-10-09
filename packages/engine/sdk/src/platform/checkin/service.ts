/**
 * checkin/service.ts
 *
 * The proactive check-in service: it reads the check-in config, gates on
 * enabled + quiet hours, assembles the briefing, asks the judge whether to
 * contact the user, delivers through the channel deliverer when the judgment
 * says yes, and writes a receipt for EVERY run, the loop that makes the
 * platform able to reach out first, accountably.
 *
 * It rides the existing automation scheduler: syncScheduledJob keeps a single
 * `kind: 'checkin'` automation job in step with the config, and attach() wires
 * the manager's check-in evaluator to this.evaluate, so when the scheduler
 * fires the job, this loop runs (checkin-execution.ts records the run).
 */
import type { JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import type { CheckinJudgmentReceipt } from './types.js';
import type { AutomationManager } from '../automation/index.js';
import type { AutomationCheckinOutcome } from '../automation/index.js';
import { randomUUID } from 'node:crypto';
import { assembleCheckinBriefing, summarizeCheckinState } from './briefing.js';
import { isQuietHours } from './quiet-hours.js';
import type { CheckinReceiptStore } from './receipts.js';
import {
  CHECKIN_CONFIG_KEYS,
  CHECKIN_JOB_ID,
  type CheckinConfig,
  type CheckinDeliverer,
  type CheckinJudge,
  type CheckinReceipt,
  type CheckinReceiptOutcome,
  type CheckinStateReader,
} from './types.js';

const DEFAULT_CADENCE = '0 */4 * * *';

/**
 * The narrow config surface the check-in reads/writes. Intentionally string-
 * keyed rather than typed against the ConfigKey union: the checkin.* keys live
 * in the config DEFAULTS tree (schema-domain-runtime.ts) and flat settings, and
 * the daemon binds this via a small adapter over its ConfigManager, this keeps
 * the (grandfathered, shrink-only) schema-types.ts ConfigKey union untouched.
 */
export interface CheckinConfigAccess {
  get(key: string): unknown;
  set(key: string, value: string | boolean): void;
  /** Pre-mutation invalidation fences even disable/re-enable and same-value rewrites. */
  onDidInvalidate?(listener: () => void): () => void;
}

export interface CheckinServiceDeps {
  readonly config: CheckinConfigAccess;
  readonly stateReader: CheckinStateReader;
  readonly judge: CheckinJudge;
  readonly deliverer: CheckinDeliverer;
  readonly receipts: CheckinReceiptStore;
  /** The automation manager the scheduled check-in job is synced onto (optional in tests). */
  readonly automation?: Pick<AutomationManager, 'listJobs' | 'createJob' | 'updateJob' | 'setEnabled' | 'attachCheckinEvaluator'> | undefined;
  /** Injectable clock for quiet-hours tests. */
  readonly now?: (() => number) | undefined;
  readonly onRetry?: ((progress: JudgmentRetryProgress) => void) | undefined;
}

export interface SetCheckinConfigInput {
  readonly enabled?: boolean | undefined;
  readonly cadence?: string | undefined;
  readonly deliveryChannel?: string | undefined;
  readonly quietHours?: string | undefined;
}

export class CheckinService {
  private readonly activeRuns = new Set<AbortController>();
  private revision = 0;
  private disposed = false;
  constructor(private readonly deps: CheckinServiceDeps) {}

  /** The host owns cancellation; retiring the service cannot leave retrying readers behind. */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private invalidate(): void {
    this.revision++;
    for (const controller of this.activeRuns) controller.abort();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  getConfig(): CheckinConfig {
    const get = this.deps.config.get.bind(this.deps.config);
    return {
      enabled: get(CHECKIN_CONFIG_KEYS.enabled) === true,
      cadence: asString(get(CHECKIN_CONFIG_KEYS.cadence)) || DEFAULT_CADENCE,
      deliveryChannel: asString(get(CHECKIN_CONFIG_KEYS.deliveryChannel)),
      quietHours: asString(get(CHECKIN_CONFIG_KEYS.quietHours)),
    };
  }

  async setConfig(input: SetCheckinConfigInput): Promise<CheckinConfig> {
    this.invalidate();
    const set = this.deps.config.set.bind(this.deps.config);
    if (input.enabled !== undefined) set(CHECKIN_CONFIG_KEYS.enabled, input.enabled);
    if (input.cadence !== undefined) set(CHECKIN_CONFIG_KEYS.cadence, input.cadence.trim());
    if (input.deliveryChannel !== undefined) set(CHECKIN_CONFIG_KEYS.deliveryChannel, input.deliveryChannel.trim());
    if (input.quietHours !== undefined) set(CHECKIN_CONFIG_KEYS.quietHours, input.quietHours.trim());
    await this.syncScheduledJob();
    return this.getConfig();
  }

  async listReceipts(limit?: number): Promise<CheckinReceipt[]> {
    return this.deps.receipts.list(limit);
  }

  /** Wire this service as the automation manager's check-in evaluator, then sync the job. */
  async attach(): Promise<void> {
    this.deps.automation?.attachCheckinEvaluator((job) => this.evaluate('scheduled', job.id));
    await this.syncScheduledJob();
  }

  /**
   * Keep a single kind:'checkin' automation job in step with the config: create
   * it (enabled) when missing, update its cadence, and toggle enabled to match.
   * Best-effort, the automation subsystem must be enabled for a job to exist;
   * when it is off, createJob throws and we leave scheduling for when it is on.
   */
  async syncScheduledJob(): Promise<void> {
    const automation = this.deps.automation;
    if (!automation) return;
    const config = this.getConfig();
    let job: { id: string } | undefined;
    try {
      job = automation.listJobs().find((j) => j.kind === 'checkin');
    } catch {
      return;
    }
    try {
      if (!job) {
        if (!config.enabled) return;
        await automation.createJob({
          name: 'Proactive check-in',
          kind: 'checkin',
          prompt: '(proactive check-in, briefing assembled at run time)',
          schedule: { kind: 'cron', expression: config.cadence },
          target: { kind: 'isolated', createIfMissing: true },
          enabled: true,
        });
        return;
      }
      await automation.updateJob(job.id, {
        kind: 'checkin',
        schedule: { kind: 'cron', expression: config.cadence },
        enabled: config.enabled,
      });
      await automation.setEnabled(job.id, config.enabled);
    } catch {
      // Automation disabled or transient failure, the schedule syncs on the
      // next setConfig/attach once the automation subsystem is enabled.
    }
  }

  /**
   * Run one check-in evaluation and record its receipt. Returns the terminal
   * outcome the automation run records. A scheduled run binds the current job
   * revision as well as the check-in config; deletion or ownership changes cannot revive it.
   */
  async evaluate(trigger: 'scheduled' | 'manual', jobId?: string, callerSignal?: AbortSignal, assertAuthority?: () => void): Promise<AutomationCheckinOutcome> {
    const ranAt = this.now();
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    const revision = this.revision;
    let invalidated = false;
    const unsubscribe = this.deps.config.onDidInvalidate?.(() => { invalidated = true; controller.abort(); });
    this.activeRuns.add(controller);
    const config = this.getConfig();
    let jobRevision: string | undefined;
    const readJob = () => jobId === undefined ? undefined : this.deps.automation?.listJobs().find(job => job.id === jobId);
    let jobIdentity: ReturnType<typeof readJob>;
    const current = () => {
      signal.throwIfAborted();
      assertAuthority?.();
      if (this.disposed || invalidated || revision !== this.revision || JSON.stringify(this.getConfig()) !== JSON.stringify(config)) {
        invalidated = true;
        controller.abort();
        throw new Error('Check-in configuration or authority changed');
      }
      if (jobId !== undefined) {
        const job = readJob();
        if (!job || job !== jobIdentity || job.kind !== 'checkin' || !job.enabled || job.status !== 'enabled' || !job.source.enabled || JSON.stringify(job) !== jobRevision) {
          invalidated = true;
          controller.abort();
          throw new Error('Scheduled check-in job or ownership changed');
        }
      }
      if (!config.enabled || isQuietHours(this.now(), config.quietHours)) throw new Error('Check-in is no longer eligible');
    };
    let briefingSummary = 'unavailable';
    let judgment: CheckinJudgmentReceipt | undefined;
    let deliveryEntered = false;
    let confirmedDelivery: { readonly deliveryId: string | undefined } | undefined;
    try {
      if (!config.enabled) return await this.record(trigger, ranAt, 'skipped-disabled', 'check-in disabled', {});
      if (isQuietHours(ranAt, config.quietHours)) return await this.record(trigger, ranAt, 'skipped-quiet-hours', 'quiet hours', {});
      if (jobId !== undefined) { jobIdentity = readJob(); jobRevision = JSON.stringify(jobIdentity); }
      current();
      const snapshot = await this.deps.stateReader.snapshot();
      current();
      briefingSummary = summarizeCheckinState(snapshot);
      const decision = await this.deps.judge.decide(assembleCheckinBriefing(snapshot), {
        signal, beforeAttempt: current, onJudgment: (receipt) => { judgment = receipt; }, ...(this.deps.onRetry ? { onRetry: this.deps.onRetry } : {}),
      });
      judgment = decision.judgment;
      current();
      if (!decision.contact) {
        return await this.record(trigger, ranAt, 'quiet', briefingSummary, { decisionReason: decision.reason, judgment });
      }
      const message = decision.message?.trim() ?? '';
      if (!message) return await this.record(trigger, ranAt, 'quiet', briefingSummary, { decisionReason: 'No verified note to deliver', judgment });
      current();
      deliveryEntered = true;
      const deliveryId = await this.deps.deliverer.deliver(config.deliveryChannel, message, { signal, assertCurrent: current });
      confirmedDelivery = { deliveryId };
      // Once the transport accepted a send, later revocation cannot erase its delivery receipt.
      return await this.record(trigger, ranAt, 'delivered', briefingSummary, {
        decisionReason: decision.reason, judgment, deliveredMessage: message,
        deliveryChannel: config.deliveryChannel, deliveryId,
      });
    } catch (error) {
      // A persistence failure must not erase known acceptance or fabricate an unknown send.
      if (confirmedDelivery) return { outcome: 'delivered', summary: 'Check-in delivery was confirmed, but its receipt could not be persisted',
        error: 'Check-in receipt persistence failed',
        ...(confirmedDelivery.deliveryId ? { deliveryId: confirmedDelivery.deliveryId } : {}),
      };
      // An interrupted response cannot prove that an already-entered transport did not send.
      if (deliveryEntered) return await this.record(trigger, ranAt, 'error', briefingSummary, {
        error: 'Check-in delivery outcome was not confirmed; delivery may have begun', judgment,
      });
      const stale = invalidated || revision !== this.revision || JSON.stringify(this.getConfig()) !== JSON.stringify(config);
      if (stale || signal.aborted || this.disposed) {
        return await this.record(trigger, ranAt, stale ? 'skipped-stale' : 'cancelled', briefingSummary, { judgment });
      }
      if (isQuietHours(this.now(), config.quietHours)) return await this.record(trigger, ranAt, 'skipped-quiet-hours', briefingSummary, { judgment });
      // Unavailable is an error, not an invented semantic no. Transient outages remain pending in the shared port.
      const detail = error instanceof Error ? error.message : String(error);
      return await this.record(trigger, ranAt, 'error', briefingSummary, { error: detail, judgment });
    } finally {
      unsubscribe?.();
      this.activeRuns.delete(controller);
    }
  }

  private async record(
    trigger: 'scheduled' | 'manual',
    ranAt: number,
    outcome: CheckinReceiptOutcome,
    briefingSummary: string,
    extra: {
      readonly decisionReason?: string | undefined;
      readonly judgment?: CheckinJudgmentReceipt | undefined;
      readonly deliveredMessage?: string | undefined;
      readonly deliveryChannel?: string | undefined;
      readonly deliveryId?: string | undefined;
      readonly error?: string | undefined;
    },
  ): Promise<AutomationCheckinOutcome> {
    const receipt: CheckinReceipt = {
      id: `checkin-${ranAt}-${randomUUID().slice(0, 6)}`,
      ranAt,
      trigger,
      outcome,
      briefingSummary,
      ...(extra.judgment ? { judgment: extra.judgment } : {}),
      ...(extra.decisionReason ? { decisionReason: extra.decisionReason } : {}),
      ...(extra.deliveredMessage ? { deliveredMessage: extra.deliveredMessage } : {}),
      ...(extra.deliveryChannel ? { deliveryChannel: extra.deliveryChannel } : {}),
      ...(extra.deliveryId ? { deliveryId: extra.deliveryId } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
    await this.deps.receipts.append(receipt);
    return toOutcome(outcome, receipt);
  }
}

function toOutcome(outcome: CheckinReceiptOutcome, receipt: CheckinReceipt): AutomationCheckinOutcome {
  switch (outcome) {
    case 'delivered':
      return { outcome: 'delivered', summary: `delivered: ${receipt.decisionReason ?? 'contacted user'}`, ...(receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}) };
    case 'quiet':
      return { outcome: 'quiet', summary: `quiet: ${receipt.decisionReason ?? 'nothing warranted contact'}` };
    case 'error':
      return { outcome: 'error', summary: 'check-in evaluation failed', ...(receipt.error ? { error: receipt.error } : {}) };
    case 'cancelled': return { outcome: 'skipped', summary: 'check-in cancelled' };
    case 'skipped-stale': return { outcome: 'skipped', summary: 'check-in configuration or authority changed' };
    default:
      return { outcome: 'skipped', summary: outcome === 'skipped-quiet-hours' ? 'quiet hours' : 'check-in disabled' };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
