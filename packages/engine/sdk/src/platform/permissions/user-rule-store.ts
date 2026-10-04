/**
 * Durable user-origin permission rules, approval decisions that persist.
 *
 * A "remember" decision with a generalizing tier (exact command / command
 * class / path scope / whole tool) writes a PolicyRule with origin 'user'
 * here. PermissionManager consults these rules live before ever prompting
 * (without copying them into its session-only map), and evaluateRuntimePolicy
 * folds them into the layered evaluator when the policy engine flag is on,
 * user rules are evaluated ahead of managed rules there.
 *
 * Storage: one JSON file per project (control-plane config dir), atomic
 * writes via PersistentStore; ':memory:' for tests. Rules are project-scoped
 * by where the file lives.
 */

import type { PolicyRule } from '../runtime/permissions/types.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { RememberTier } from './approval-rules.js';

/** A stored rule plus its provenance. */
export interface StoredUserPermissionRule {
  readonly rule: PolicyRule;
  readonly createdAt: number;
  /** The remember tier that produced this rule. */
  readonly tier: Exclude<RememberTier, 'session'>;
  /** The tool whose ask produced the rule (display context). */
  readonly tool: string;
}

interface UserRuleFile extends Record<string, unknown> {
  version: 1;
  rules: StoredUserPermissionRule[];
}

/** Preserve the bare-token behavior of stored, explicitly class-scoped rules. */
function ruleForEvaluation(record: StoredUserPermissionRule): PolicyRule {
  const { rule, tier } = record;
  if (tier !== 'command-class' || rule.type !== 'prefix' || rule.exactCommandMatch !== undefined) return rule;
  const classes = rule.exactCommands;
  const prefixes = rule.commandPrefixes;
  // The old class builder emitted exactly this shape. A missing/invalid tier,
  // arbitrary exact payload, or unknown match option does not gain breadth.
  if (!Array.isArray(classes) || classes.length === 0 || !Array.isArray(prefixes)
    || prefixes.length !== classes.length || new Set(classes).size !== classes.length
    || new Set(prefixes).size !== prefixes.length || !classes.every((command) =>
      typeof command === 'string' && command.length > 0 && !/\s/.test(command)
      && command === command.toLowerCase() && prefixes.includes(`${command} `))) return rule;
  return { ...rule, exactCommandMatch: 'command-class' };
}

export class UserPermissionRuleStore {
  private readonly store: PersistentStore<UserRuleFile>;
  private records: StoredUserPermissionRule[] = [];
  private loaded = false;
  /** Whole mutations run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(filePath: string) {
    this.store = new PersistentStore<UserRuleFile>(filePath);
  }

  /** Load persisted rules. Safe to call more than once. */
  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await this.store.load();
      if (data && Array.isArray(data.rules)) {
        this.records = data.rules.filter(
          (record): record is StoredUserPermissionRule =>
            !!record && typeof record === 'object' && !!(record as StoredUserPermissionRule).rule,
        );
      }
    } catch (error) {
      // A corrupt store must not silently grant or deny anything, start
      // empty (every ask prompts again) and say so.
      logger.warn('user permission rule store unreadable; starting with no durable rules', {
        error: summarizeError(error),
      });
      this.records = [];
    }
    this.loaded = true;
  }

  /** All stored rules, newest first. */
  list(): readonly StoredUserPermissionRule[] {
    return [...this.records].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Just the PolicyRules, for evaluation (insertion order, first match wins). */
  rules(): readonly PolicyRule[] {
    return this.records.map(ruleForEvaluation);
  }

  /** Publish a rule only after persistence succeeds; reject without changing state on failure. */
  async add(record: StoredUserPermissionRule): Promise<void> {
    await this.writes.run(async () => {
      const next = [...this.records, record];
      await this.persist(next);
      this.records = next;
    });
  }

  /**
   * Delete by rule id. Returns whether a committed rule was removed.
   * A failed write rejects and leaves the rule present, so revocation can be retried.
   */
  async delete(ruleId: string): Promise<boolean> {
    let removed = false;
    await this.writes.run(async () => {
      const next = this.records.filter((record) => record.rule.id !== ruleId);
      if (next.length === this.records.length) return;
      await this.persist(next);
      this.records = next;
      removed = true;
    });
    return removed;
  }

  /**
   * Persist a candidate snapshot inside the mutation queue, before publishing
   * it to live readers. A failed write must never install an uncommitted grant
   * or remove a denial, and the manager must not call either change persisted.
   *
   * Queue the whole read-modify-persist-publish transaction, not just the file
   * write. Each successor then starts from the last successful commit, even
   * after a failure. Capturing before the queue would lose overlapping adds or
   * carry a failed grant into a later successful write; rollback after a failed
   * write could instead erase a concurrent change. Ordered transactions also
   * ensure an add's rename cannot overtake the revocation queued after it.
   */
  private async persist(records: StoredUserPermissionRule[]): Promise<void> {
    await this.store.persist({ version: 1, rules: records });
  }
}
