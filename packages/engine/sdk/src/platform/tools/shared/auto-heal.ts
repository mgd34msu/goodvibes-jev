/**
 * AutoHealer, three-stage pipeline to fix write/edit validation failures.
 *
 * Pipeline (opt-in via tools.autoHeal config):
 *   1. Formatter: prettier --write or biome format
 *   2. Linter fix: eslint --fix
 *   3. ToolLLM: LLM-assisted fix with error context
 *
 * Design constraints:
 *   - Returns {healed: false, content: originalContent} with warnings whenever
 *     repair cannot safely produce validated replacement content
 *   - Each stage's change is accepted only when `engine.tools.heal-acceptance`
 *     reads that it fixes the listed errors (and, for the model's whole-file
 *     rewrite, that it changes nothing else); otherwise the next stage runs
 *   - A JudgmentError (or a missing judgment port) propagates to the caller;
 *     every other failure is caught and reported as a warning
 *   - Uses Bun.which() to detect available tools at runtime
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureJudgmentPort, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { unifiedDiff } from '../../state/file-cache.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import { hasCapturedToolInvocation } from './captured-input-tools.js';
import { healAcceptance, MAX_JUDGED_CHANGE_CHARS } from '../batteries/heal-acceptance.js';

const HEAL_ACCEPTANCE_SITE = 'tools.auto-heal.acceptance';

/** Internal execution boundary supplied by the captured repair owner. */
export interface AutoHealExecution {
  readonly signal?: AbortSignal | undefined;
  readonly check: () => Promise<void>;
  readonly checkSynchronous: () => void;
  readonly transform: (stage: 'formatter' | 'linter', file: string, content: string, warnings: string[]) => Promise<string>;
}

/** Result of an auto-heal attempt. */
export interface HealResult {
  healed: boolean;
  content: string;
  method?: 'formatter' | 'linter' | 'llm' | undefined;
  warnings?: string[] | undefined;
}

/** Jev could not answer, or no judgment port is installed: the heal cannot decide and the caller is told. */
function isJudgmentFailure(error: unknown): boolean {
  return error instanceof JudgmentError || error instanceof JudgmentPortMissingError;
}

function addWarning(warnings: string[], message: string, error?: unknown): void {
  const warning = error === undefined ? message : `${message}: ${summarizeError(error)}`;
  warnings.push(warning);
}

/**
 * AutoHealer, attempts to fix content with validation errors via a staged pipeline.
 *
 * Usage:
 *   const healer = new AutoHealer();
 *   const result = await healer.heal(filePath, content, errors);
 *   if (result.healed) { // use result.content }
 */
export class AutoHealer {
  constructor(
    private readonly configManager: Pick<ConfigManager, 'get'>,
    private readonly toolLLM: Pick<ToolLLM, 'chat'>,
    private readonly execution?: AutoHealExecution,
    private readonly assertInvocation?: () => void,
    private readonly invocationSignal?: AbortSignal,
    private readonly reading?: JudgmentPortCapture,
  ) {}

  private async check(): Promise<void> {
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
    if (this.execution) await this.execution.check();
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
  }
  private readonly checkSynchronous = (): void => {
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
    this.execution?.checkSynchronous();
    this.reading?.assertCurrent();
    this.invocationSignal?.throwIfAborted();
    this.assertInvocation?.();
  };

  /**
   * Attempt to auto-heal content with validation errors.
   *
   * @param filePath     Original file path (used to determine extension/context).
   * @param content      File content that failed validation.
   * @param errors       Validation error messages from the failed write/edit.
   * @returns            Heal result, healed=true means content was fixed.
   */
  async heal(filePath: string, content: string, errors: string[]): Promise<HealResult> {
    const warnings: string[] = [];
    if (hasCapturedToolInvocation() && !this.execution) throw new Error('Captured repair requires its construction-owned backend');
    await this.check();
    try {
      // Config gate: only run when tools.autoHeal is enabled
      if (!this.configManager.get('tools.autoHeal')) {
        return { healed: false, content };
      }

      if (!errors.length) {
        return { healed: false, content };
      }

      const ext = extname(filePath) || '.txt';
      const tmpFile = this.execution ? '' : join(tmpdir(), `auto-heal-${randomBytes(6).toString('hex')}${ext}`);

      let result: HealResult = { healed: false, content };
      try {
        // Stage 1: Formatter
        const formatterResult = await this._tryFormatter(filePath, tmpFile, content, errors, warnings);
        if (formatterResult.healed) {
          result = formatterResult;
        } else {
          // Stage 2: Linter fix
          const linterResult = await this._tryLinter(filePath, tmpFile, formatterResult.content, errors, warnings);
          if (linterResult.healed) {
            result = linterResult;
          } else {
            // Stage 3: ToolLLM
            result = await this._tryLLM(filePath, linterResult.content, errors, warnings);
          }
        }
      } finally {
        // Clean up temp file
        try {
          if (tmpFile && existsSync(tmpFile)) {
            unlinkSync(tmpFile);
          }
        } catch (cleanupErr) {
          addWarning(warnings, `Auto-heal cleanup failed for temporary file '${tmpFile}'`, cleanupErr);
        }
      }

      await this.check();
      return warnings.length > 0 ? { ...result, warnings } : result;
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer.heal: unexpected error', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal failed unexpectedly', err);
      return { healed: false, content, warnings };
    }
  }

  /**
   * Stage 1: Try formatting with prettier or biome.
   */
  private async _tryFormatter(
    filePath: string,
    tmpFile: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      await this.check();
      if (this.execution) return await this._tryContained('formatter', filePath, content, errors, warnings);
      const prettier = Bun.which('prettier');
      const biome = Bun.which('biome');

      if (!prettier && !biome) {
        logger.debug('AutoHealer: no formatter found (prettier/biome), skipping stage 1');
        return { healed: false, content };
      }

      // Write content to temp file
      this.checkSynchronous();
      writeFileSync(tmpFile, content, 'utf-8');

      let proc: { exitCode: number | null };

      if (prettier) {
        this.checkSynchronous();
        proc = Bun.spawnSync([prettier, '--write', '--log-level', 'silent', tmpFile]);
      } else {
        // biome format --write
        this.checkSynchronous();
        proc = Bun.spawnSync([biome!, 'format', '--write', tmpFile], {
          stderr: 'pipe',
        });
      }

      if (proc.exitCode !== 0) {
        logger.debug('AutoHealer: formatter exited non-zero, skipping stage 1');
        addWarning(warnings, 'Auto-heal formatter exited non-zero; continuing to later repair stages');
        return { healed: false, content };
      }

      const formatted = readFileSync(tmpFile, 'utf-8');

      if (formatted === content) {
        // Formatter made no changes, errors not formatter-related
        return { healed: false, content };
      }

      if (await this._accepted(filePath, content, formatted, errors, 'formatter', warnings)) {
        logger.debug('AutoHealer: errors resolved by formatter');
        return { healed: true, content: formatted, method: 'formatter' };
      }

      // Formatter ran but errors remain, pass updated content to next stage
      return { healed: false, content: formatted };
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer: formatter stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal formatter stage failed; continuing to later repair stages', err);
      return { healed: false, content };
    }
  }

  /**
   * Stage 2: Try linter fix with eslint.
   */
  private async _tryLinter(
    filePath: string,
    tmpFile: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      await this.check();
      if (this.execution) return await this._tryContained('linter', filePath, content, errors, warnings);
      const eslint = Bun.which('eslint');

      if (!eslint) {
        logger.debug('AutoHealer: eslint not found, skipping stage 2');
        return { healed: false, content };
      }

      // Write (possibly formatter-updated) content to temp file
      this.checkSynchronous();
      writeFileSync(tmpFile, content, 'utf-8');

      this.checkSynchronous();
      const proc = Bun.spawnSync([eslint, '--fix', tmpFile], {
        stderr: 'pipe',
        stdout: 'pipe',
      });

      // eslint --fix exits 1 on remaining errors, 0 on clean, both are acceptable
      const fixed = readFileSync(tmpFile, 'utf-8');

      if (fixed === content) {
        return { healed: false, content };
      }

      if (await this._accepted(filePath, content, fixed, errors, 'linter', warnings)) {
        logger.debug('AutoHealer: errors resolved by linter');
        return { healed: true, content: fixed, method: 'linter' };
      }

      return { healed: false, content: fixed };
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer: linter stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal linter stage failed; continuing to LLM repair', err);
      return { healed: false, content };
    }
  }

  private async _tryContained(stage: 'formatter' | 'linter', filePath: string, content: string, errors: string[], warnings: string[]): Promise<HealResult> {
    await this.check();
    const candidate = await executePolicyCheck(() => this.execution!.transform(stage, filePath, content, warnings), this.execution!.signal);
    await this.check();
    if (candidate === content) return { healed: false, content };
    const accepted = await this._accepted(filePath, content, candidate, errors, stage, warnings);
    return { healed: accepted, content: candidate, ...(accepted ? { method: stage } : {}) };
  }

  /**
   * Stage 3: Try ToolLLM with error context.
   */
  private async _tryLLM(
    filePath: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
      const prompt = [
        `You are a code repair assistant. The following file has validation errors that need to be fixed.`,
        ``,
        `File: ${filePath}`,
        ``,
        `Errors:`,
        errorList,
        ``,
        `Current content:`,
        `\`\`\``,
        content,
        `\`\`\``,
        ``,
        `Return ONLY the corrected file content, no explanation, no markdown fences.`,
      ].join('\n');

      await this.check();
      const signal = this.execution?.signal ?? this.invocationSignal;
      const response = await executePolicyCheck(() => { this.checkSynchronous(); return this.toolLLM.chat(prompt, {
        maxTokens: 4096,
        systemPrompt: 'You are a code repair tool. Output only the corrected file content with no additional text or markdown.',
        ...(signal ? { signal } : {}),
        beforeAttempt: () => this.check(),
      }); }, this.execution?.signal ?? this.invocationSignal);
      await this.check();

      if (!response || response.trim() === '') {
        logger.debug('AutoHealer: LLM returned empty response');
        addWarning(warnings, 'Auto-heal LLM returned an empty response');
        return { healed: false, content };
      }

      if (!(await this._accepted(filePath, content, response, errors, 'llm', warnings))) {
        logger.debug('AutoHealer: LLM response was not accepted as the repair');
        addWarning(warnings, 'Auto-heal LLM response was not accepted: it does not fix the validation errors, or it changes more than the fix');
        return { healed: false, content };
      }

      logger.debug('AutoHealer: errors resolved by LLM');
      return { healed: true, content: response, method: 'llm' };
    } catch (err) {
      if (isJudgmentFailure(err)) throw err;
      await this.check();
      logger.warn('AutoHealer: LLM stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal LLM stage failed', err);
      return { healed: false, content };
    }
  }

  /**
   * Whether a stage's output is accepted as the repair. A JavaScript or
   * TypeScript result that Bun's parser rejects is not a repaired file (the
   * grammar settles it). Otherwise the change from the stage's input is read
   * by `engine.tools.heal-acceptance`: `fixes_errors` for every stage, and
   * `only_the_fix` for the model's whole-file rewrite. It is accepted only
   * when every reading is a yes that acts. A change too large to read whole
   * is not accepted.
   */
  private async _accepted(
    filePath: string,
    before: string,
    after: string,
    errors: string[],
    stage: NonNullable<HealResult['method']>,
    warnings: string[],
  ): Promise<boolean> {
    const ext = extname(filePath).toLowerCase();
    if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      const loader = (ext === '.mjs' || ext === '.cjs') ? 'js' : ext.slice(1) as 'ts' | 'tsx' | 'js' | 'jsx';
      try {
        new Bun.Transpiler({ loader }).transformSync(after);
      } catch {
        return false;
      }
    }
    const change = unifiedDiff(before, after, filePath);
    if (change.length > MAX_JUDGED_CHANGE_CHARS) {
      addWarning(warnings, `Auto-heal ${stage} change to '${filePath}' is ${change.length} characters, too large to check whole; not applied`);
      return false;
    }
    const asked = stage === 'llm' ? (['fixes_errors', 'only_the_fix'] as const) : (['fixes_errors'] as const);
    await this.check();
    const capture = this.reading ?? captureJudgmentPort(HEAL_ACCEPTANCE_SITE, { assertCurrent: this.checkSynchronous, signal: this.execution?.signal ?? this.invocationSignal });
    const run = await executePolicyCheck(() => healAcceptance.run(capture.port, { file: filePath, errors, change }, {
      site: HEAL_ACCEPTANCE_SITE, only: [...asked], beforeAttempt: capture.assertCurrent,
      beforeAsyncAttempt: async () => { await this.check(); capture.assertCurrent(); }, signal: capture.signal,
    }), capture.signal);
    await this.check();
    const accepted = asked.every((question) => {
      const reading = run.readings[question];
      return reading?.verdict === 'yes' && reading.outcome === 'act';
    });
    capture.assertCurrent();
    run.recordAction(`${stage} ${accepted ? 'accepted' : 'not accepted'}`);
    return accepted;
  }
}
