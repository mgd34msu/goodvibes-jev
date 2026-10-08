import type { CapturedWriteRevision } from '../shared/captured-write-revision.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/tools.js';
import { logger } from '../../utils/logger.js';
import type { SessionChangeTracker } from '../../sessions/change-tracker.js';
import { FileUndoManager } from '../../state/file-undo.js';
import { FileStateCache, unifiedDiff } from '../../state/file-cache.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { assertCapturedToolWriteRevision, captureCapturedToolWriteRevision, assertCapturedToolMutationCurrent, assertCapturedToolReadAccess, hasCapturedToolInvocation } from '../shared/captured-input-tools.js';
import { editSchema } from './schema.js';
import { healToolFile, type CapturedAutoHealBackend } from '../shared/captured-auto-heal.js';
import {
  collectPostEditDiagnostics,
  formatDiagnosticsBlock,
  type DiagnosticsProvider,
} from '../shared/post-edit-diagnostics.js';
import { ImportGraph } from '../../intelligence/index.js';
import {
  buildFailedEditResult,
  classifyEditFailure,
  computeAstEdit,
  computeAstPatternEdit,
  computeSingleEdit,
} from './match.js';
import type { EditInput, EditItem, EditResult, EditResultStatus, ValidatorName } from './types.js';
import { executeNotebookEdit } from './notebook.js';
import { summarizeError } from '../../utils/error-display.js';
import { toRecord } from '../../utils/record-coerce.js';
import {
  runValidators as runSharedValidators,
  formatValidatorFailure,
  type ValidatorResult,
  type ValidatorRunner,
} from '../shared/validators.js';

const DIFF_TRUNCATE_THRESHOLD = 5000;
const DIFF_PREVIEW_LENGTH = 500;

async function runValidators(validators: ValidatorName[], cwd: string, runner?: ValidatorRunner): Promise<ValidatorResult | null> {
  const failures = await runSharedValidators(validators, cwd, runner);
  return failures[0] ?? null;
}

interface EditExecutionContext {
  capturedRevisions: Map<string, CapturedWriteRevision>;
  capturedWritten: Set<string>;
  fileCache: FileStateCache;
  cwd: string;
  fileUndoManager?: FileUndoManager | undefined;
  configManager?: Pick<ConfigManager, 'get' | 'getWorkingDirectory'> | undefined;
  toolLLM?: Pick<ToolLLM, 'chat'> | undefined;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'> | undefined;
  diagnosticsProvider?: DiagnosticsProvider | undefined;
  validatorRunner?: ValidatorRunner | undefined;
  capturedAutoHeal?: CapturedAutoHealBackend | undefined;
}

interface ResolvedTextEditInput {
  resolvedPaths: Map<string, string>;
  fileContents: Map<string, string>;
  fileReadErrors: Map<string, string>;
  workingContents: Map<string, string>;
}

interface PostValidationRepairResult {
  healed: boolean;
  healedPaths: Set<string>;
  warnings: string[];
}

async function prepareTextEditInput(
  input: EditInput,
  env: EditExecutionContext,
  transactionMode: 'atomic' | 'partial' | 'none',
): Promise<ResolvedTextEditInput | { error: string }> {
  const resolvedPaths: Map<string, string> = new Map();
  for (const item of input.edits!) {
    if (resolvedPaths.has(item.path)) continue;
    try {
      resolvedPaths.set(item.path, resolveAndValidatePath(item.path, env.cwd));
    } catch (err) {
      const msg = summarizeError(err);
      if (transactionMode === 'atomic') {
        return { error: `Path error for '${item.path}': ${msg}` };
      }
    }
  }

  const uniquePaths = new Set((input.edits ?? []).map((e) => resolvedPaths.get(e.path) ?? e.path));
  const fileContents: Map<string, string> = new Map();
  const fileReadErrors: Map<string, string> = new Map();

  for (const resolvedPath of uniquePaths) {
    await assertCapturedToolReadAccess(resolvedPath);
    const cacheResult = env.fileCache.lookup(resolvedPath);
    if (cacheResult.status === 'modified') {
      const msg = `OCC conflict: '${resolvedPath}' was modified externally since last read`;
      if (transactionMode === 'atomic') {
        return { error: msg };
      }
      fileReadErrors.set(resolvedPath, msg);
      continue;
    }

    try {
      await assertCapturedToolReadAccess(resolvedPath);
      const content = readFileSync(resolvedPath, 'utf-8');
      fileContents.set(resolvedPath, content);
      if (hasCapturedToolInvocation() && !input.dry_run) env.capturedRevisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, Buffer.from(content)));
    } catch {
      const msg = `File not found or unreadable: '${resolvedPath}'`;
      if (transactionMode === 'atomic') {
        return { error: msg };
      }
      fileReadErrors.set(resolvedPath, msg);
    }
  }

  return {
    resolvedPaths,
    fileContents,
    fileReadErrors,
    workingContents: new Map(fileContents),
  };
}

async function writeSuccessfulTextEdits(
  results: EditResult[],
  resolvedPaths: Map<string, string>,
  workingContents: Map<string, string>,
  fileContents: Map<string, string>,
  env: EditExecutionContext,
  writtenPaths: Set<string>,
): Promise<void> {
  for (const r of results) {
    if (!r.success) continue;
    const resolvedPath = resolvedPaths.get(r.path);
    if (!resolvedPath || writtenPaths.has(resolvedPath)) continue;

    const newContent = workingContents.get(resolvedPath);
    if (newContent === undefined) continue;

    try {
      await assertCapturedToolReadAccess(resolvedPath);
      assertCapturedToolMutationCurrent(resolvedPath);
      if (hasCapturedToolInvocation()) {
        const revision = env.capturedRevisions.get(resolvedPath);
        if (!revision) throw new Error('Captured edit has no initial revision');
        assertCapturedToolWriteRevision(resolvedPath, revision);
        writeFileSync(resolvedPath, newContent, 'utf-8');
        env.capturedRevisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, Buffer.from(newContent)));
        env.capturedWritten.add(resolvedPath);
      }
      else await writeFile(resolvedPath, newContent, 'utf-8');
      env.fileCache.update(resolvedPath, newContent);
      writtenPaths.add(resolvedPath);
      if (env.fileUndoManager && !hasCapturedToolInvocation()) {
        try {
          const originalContent = fileContents.get(resolvedPath) ?? null;
          env.fileUndoManager.snapshot({
            path: resolvedPath,
            beforeContent: originalContent,
            afterContent: newContent,
            tool: 'edit',
          });
        } catch {
          // Undo snapshot failure should not fail the edit.
        }
      }
      env.changeTracker?.recordChange(resolvedPath);
    } catch (err) {
      const msg = `Write failed for '${resolvedPath}': ${summarizeError(err)}`;
      for (const res of results) {
        if (res.path === r.path) {
          res.success = false;
          res.error = msg;
        }
      }
    }
  }
}

async function buildImportGraphWarning(cwd: string, writtenPaths: Set<string>): Promise<string | undefined> {
  try {
    const graph = new ImportGraph();
    graph.markDirty();
    await graph.build(cwd, async (path) => {
      try {
        await assertCapturedToolReadAccess(path);
        return true;
      } catch {
        return false;
      }
    });

    const editedAbsPaths = [...writtenPaths];
    const affectedSet = new Set<string>();
    for (const edited of editedAbsPaths) {
      for (const dep of graph.findTransitiveDependents(edited)) {
        affectedSet.add(dep);
      }
    }
    for (const edited of editedAbsPaths) {
      affectedSet.delete(edited);
    }

    if (affectedSet.size === 0) return undefined;
    if (hasCapturedToolInvocation())
      return `\nImport graph: ${affectedSet.size} transitive dependent(s) affected. Automatic dependency diagnostics are unavailable for captured edits; use the contained exec build/test workflow to verify the change.`;

    const affectedList = Array.from(affectedSet);
    const proc = Bun.spawn(['npx', 'tsc', '--noEmit', ...affectedList], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) return undefined;

    const relAffected = affectedList.map((f) => relative(cwd, f));
    const outputLines = (stderrText + '\n' + stdoutText)
      .split('\n')
      .filter((line) => relAffected.some((rel) => line.includes(rel)));
    if (outputLines.length > 0) {
      return `\n⚠ Import graph: ${affectedSet.size} transitive dependent(s) affected by this edit, type errors detected in downstream files:\n${outputLines.join('\n')}`;
    }
    return `\n⚠ Import graph: ${affectedSet.size} transitive dependent(s) affected. tsc reported errors outside the affected set, check unrelated files.`;
  } catch (err) {
    logger.warn('[import-graph] Import graph tracing failed', { error: summarizeError(err) });
    return undefined;
  }
}

async function restoreOriginalContents(fileContents: Map<string, string>, env: EditExecutionContext): Promise<string[]> {
  const failures: string[] = [];
  for (const [resolvedPath, originalContent] of fileContents) {
    try {
      await assertCapturedToolReadAccess(resolvedPath);
      assertCapturedToolMutationCurrent(resolvedPath);
      if (hasCapturedToolInvocation()) {
        if (!env.capturedWritten.has(resolvedPath)) continue;
        const revision = env.capturedRevisions.get(resolvedPath);
        if (!revision) throw new Error('Captured rollback has no owned revision');
        assertCapturedToolWriteRevision(resolvedPath, revision);
        writeFileSync(resolvedPath, originalContent, 'utf-8');
        env.capturedWritten.delete(resolvedPath);
      }
      else await writeFile(resolvedPath, originalContent, 'utf-8');
      env.fileCache.update(resolvedPath, originalContent);
    } catch (error) {
      if (hasCapturedToolInvocation()) failures.push(`Rollback held for '${resolvedPath}': ${summarizeError(error)}`);
    }
  }
  return failures;
}

async function repairAfterValidationFailure(
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  failureMessages: string[],
  env: EditExecutionContext,
): Promise<PostValidationRepairResult> {
  let healed = false;
  const healedPaths = new Set<string>();
  const warnings: string[] = [];
  for (const [resolvedPath, originalContent] of fileContents) {
    if (hasCapturedToolInvocation() && !env.capturedWritten.has(resolvedPath)) continue;
    const newContent = workingContents.get(resolvedPath);
    if (newContent === undefined || newContent === originalContent) continue;
    const healResult =
      env.configManager && env.toolLLM
        ? await healToolFile(env.configManager, env.toolLLM, resolvedPath, newContent, failureMessages, env.capturedAutoHeal)
        : { healed: false, content: newContent, assertCurrent: async () => {}, assertCurrentSynchronous: () => {}, warnings: undefined };
    if (hasCapturedToolInvocation()) warnings.push(...(healResult.warnings ?? []));
    if (healResult.healed) {
      try {
        if (hasCapturedToolInvocation()) {
          await healResult.assertCurrent();
          healResult.assertCurrentSynchronous();
          assertCapturedToolMutationCurrent(resolvedPath);
        }
        writeFileSync(resolvedPath, healResult.content, 'utf-8');
        if (hasCapturedToolInvocation()) {
          workingContents.set(resolvedPath, healResult.content);
          env.capturedRevisions.set(resolvedPath, captureCapturedToolWriteRevision(resolvedPath, Buffer.from(healResult.content)));
        }
        env.fileCache.update(resolvedPath, healResult.content);
        healed = true;
        healedPaths.add(resolvedPath);
      } catch {
        // Leave validation failure handling to the caller if the heal write fails.
      }
    }
  }
  return { healed, healedPaths, warnings };
}

async function validateAfterTextEdits(
  validators: ValidatorName[],
  cwd: string,
  transactionMode: 'atomic' | 'partial' | 'none',
  fileContents: Map<string, string>,
  workingContents: Map<string, string>,
  env: EditExecutionContext,
): Promise<{ error?: string; warnings?: string[]; healedPaths?: ReadonlySet<string> }> {
  try {
    const failure = await runValidators(validators, cwd, env.validatorRunner);
    if (!failure) return {};

    const failureMessages = [formatValidatorFailure(failure)];
    const repair = await repairAfterValidationFailure(fileContents, workingContents, failureMessages, env);
    if (repair.healed) {
      const healFailure = await runValidators(validators, cwd, env.validatorRunner);
      if (!healFailure) {
        return { warnings: repair.warnings, healedPaths: repair.healedPaths };
      }
    }

    const rollbackFailures = transactionMode === 'atomic' ? await restoreOriginalContents(fileContents, env) : [];
    return {
      warnings: [...repair.warnings, ...rollbackFailures],
      healedPaths: repair.healedPaths,
      error: `Post-edit validation failed${transactionMode === 'atomic' ? (rollbackFailures.length ? ', rollback incomplete' : ', edits rolled back') : ''}. ${formatValidatorFailure(failure)}`,
    };
  } catch (error) {
    if (!hasCapturedToolInvocation() || transactionMode !== 'atomic') throw error;
    const rollbackFailures = await restoreOriginalContents(fileContents, env);
    return {
      error: `Post-edit validation or repair failed${rollbackFailures.length ? ', rollback incomplete' : ', edits rolled back'}. ${summarizeError(error)}`,
      warnings: rollbackFailures,
    };
  }
}

function formatOutput(
  results: EditResult[],
  format: 'count_only' | 'minimal' | 'with_diff' | 'verbose',
  dryRun: boolean,
): string {
  const totalApplied = results.filter((r) => r.success).length;
  const totalFailed = results.filter((r) => !r.success).length;
  const dryTag = dryRun ? ' (dry run)' : '';

  if (format === 'count_only') {
    return JSON.stringify({ applied: totalApplied, failed: totalFailed, dry_run: dryRun });
  }

  const lines: string[] = [];
  lines.push(`Edits applied: ${totalApplied}, failed: ${totalFailed}${dryTag}`);

  if (format === 'minimal') {
    for (const r of results) {
      if (r.success) {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  OK${statusTag}${id}: ${r.path} (${r.occurrencesReplaced} replacement(s))`);
        if (r.warning) {
          lines.push(`    WARN: ${r.warning}`);
        }
      } else {
        const id = r.id ? ` [${r.id}]` : '';
        const statusTag = r.status ? ` [${r.status}]` : '';
        lines.push(`  FAIL${statusTag}${id}: ${r.path}, ${r.error}`);
        if (r.hint) {
          lines.push(`    HINT: ${r.hint}`);
        }
      }
    }
    return lines.join('\n');
  }

  for (const r of results) {
    const id = r.id ? ` [${r.id}]` : '';
    if (r.success) {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} (${r.occurrencesReplaced} replacement(s))${dryTag} ---`);
      if (r.diff) {
        if (r.diff_truncated) {
          lines.push(`[diff truncated, showing first ${DIFF_PREVIEW_LENGTH} chars]`);
          lines.push(r.diff_preview ?? r.diff.slice(0, DIFF_PREVIEW_LENGTH));
        } else {
          lines.push(r.diff);
        }
      }
      if (r.warning) {
        lines.push(`  WARN: ${r.warning}`);
      }
    } else {
      const statusTag = r.status ? ` [${r.status}]` : '';
      lines.push(`\n--- ${r.path}${id}${statusTag} FAILED ---`);
      lines.push(`  Error: ${r.error}`);
      if (r.hint) {
        lines.push(`  Hint: ${r.hint}`);
      }
    }
  }
  return lines.join('\n');
}

async function executeTextEdits(
  input: EditInput,
  env: EditExecutionContext,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const matchMode = input.match?.mode ?? 'exact';
  const caseSensitive = input.match?.case_sensitive ?? true;
  const whitespaceSensitive = input.match?.whitespace_sensitive ?? true;
  const multiline = input.match?.multiline ?? false;
  const transactionMode = input.transaction?.mode ?? 'atomic';
  const outputFormat = input.output?.format ?? 'minimal';
  const diffContext = input.output?.diff_context ?? 3;
  const dryRun = input.dry_run ?? false;
  const validateBefore = input.validate?.before ?? [];
  const validateAfter = input.validate?.after ?? [];
  const cwd = env.cwd;

  if (!dryRun && validateBefore.length > 0) {
    const failure = await runValidators(validateBefore, cwd, env.validatorRunner);
    if (failure) {
      return { success: false, error: `Pre-edit validation failed. ${formatValidatorFailure(failure)}` };
    }
  }

  const prepResult = await prepareTextEditInput(input, env, transactionMode);
  if ('error' in prepResult) {
    return { success: false, error: prepResult.error };
  }

  const { resolvedPaths, fileContents, fileReadErrors, workingContents } = prepResult;
  const results: EditResult[] = [];
  let atomicFailed = false;
  let atomicFailError = '';

  for (const item of input.edits!) {
    const resolvedPath = resolvedPaths.get(item.path);

    if (!resolvedPath) {
      results.push(buildFailedEditResult(item, `Path resolution failed for '${item.path}'`, 'failed'));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = `Path resolution failed for '${item.path}'`;
        break;
      }
      continue;
    }

    if (fileReadErrors.has(resolvedPath)) {
      const readErrMsg = fileReadErrors.get(resolvedPath)!;
      results.push(buildFailedEditResult(item, readErrMsg, classifyEditFailure(readErrMsg)));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = readErrMsg;
        break;
      }
      continue;
    }

    const currentContent = workingContents.get(resolvedPath);
    if (currentContent === undefined) {
      results.push(buildFailedEditResult(item, `No content available for '${resolvedPath}'`, 'failed'));
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = `No content available for '${resolvedPath}'`;
        break;
      }
      continue;
    }

    let editResult:
      | { newContent: string; occurrencesReplaced: number; warning?: string | undefined }
      | { error: string; hint?: string | undefined };
    if (matchMode === 'ast_pattern') {
      editResult = await computeAstPatternEdit(currentContent, item, resolvedPath);
    } else if (matchMode === 'ast') {
      editResult = await computeAstEdit(currentContent, item, resolvedPath);
    } else {
      editResult = await computeSingleEdit(
        currentContent,
        item,
        matchMode,
        caseSensitive,
        whitespaceSensitive,
        multiline,
      );
    }

    if ('error' in editResult) {
      const errMsg = editResult.error;
      results.push({
        ...buildFailedEditResult(item, errMsg, classifyEditFailure(errMsg)),
        hint: 'hint' in editResult ? editResult.hint : undefined,
      });
      if (transactionMode === 'atomic') {
        atomicFailed = true;
        atomicFailError = errMsg;
        break;
      }
      continue;
    }

    const oldContent = currentContent;
    workingContents.set(resolvedPath, editResult.newContent);

    let diff: string | undefined;
    let diffTruncated: boolean | undefined;
    let diffPreview: string | undefined;
    if (outputFormat === 'with_diff' || outputFormat === 'verbose' || dryRun) {
      const rawDiff = unifiedDiff(oldContent, editResult.newContent, resolvedPath, diffContext);
      if (rawDiff.length > DIFF_TRUNCATE_THRESHOLD) {
        diffTruncated = true;
        diffPreview = rawDiff.slice(0, DIFF_PREVIEW_LENGTH);
        diff = diffPreview;
      } else {
        diff = rawDiff;
      }
    }
    results.push({
      id: item.id,
      path: item.path,
      success: true,
      status: 'applied',
      occurrencesReplaced: editResult.occurrencesReplaced,
      diff,
      diff_truncated: diffTruncated,
      diff_preview: diffPreview,
      warning: editResult.warning,
    });
  }

  if (transactionMode === 'atomic' && atomicFailed) {
    const atomicResults: EditResult[] = (input.edits ?? []).map((item, idx) => {
      const r = results[idx]!;
      if (r && !r.success) return r;
      return {
        id: item.id,
        path: item.path,
        success: false,
        status: 'failed',
        error: r?.success ? 'Rolled back due to atomic transaction failure' : (r?.error ?? atomicFailError),
      };
    });
    return {
      success: false,
      error: `Atomic transaction failed: ${atomicFailError}`,
      output: formatOutput(atomicResults, outputFormat, dryRun),
    };
  }

  const writtenPaths = new Set<string>();
  try {
    if (!dryRun) {
      await writeSuccessfulTextEdits(results, resolvedPaths, workingContents, fileContents, env, writtenPaths);
      if (hasCapturedToolInvocation() && transactionMode === 'atomic' && results.some((result) => !result.success)) {
        const rollbackFailures = await restoreOriginalContents(fileContents, env);
        return { success: false, error: `Atomic edit publication failed${rollbackFailures.length ? ', rollback incomplete' : ', edits rolled back'}. ${results.filter((result) => !result.success).map((result) => result.error).join('; ')}${rollbackFailures.length ? `\n${rollbackFailures.join('\n')}` : ''}` };
      }
    }

    const anySuccess = results.some((r) => r.success);

    let importGraphWarning: string | undefined;
    if (!dryRun && anySuccess) {
      importGraphWarning = await buildImportGraphWarning(cwd, writtenPaths);
    }

    let repairWarnings: string[] = [];
    if (!dryRun && anySuccess && validateAfter.length > 0) {
      const validationResult = await validateAfterTextEdits(
        validateAfter,
        cwd,
        transactionMode,
        fileContents,
        workingContents,
        env,
      );
      repairWarnings = validationResult.warnings ?? [];
      if (hasCapturedToolInvocation() && validationResult.healedPaths?.size) {
        for (const result of results) {
          const path = resolvedPaths.get(result.path);
          if (!result.success || !path || !writtenPaths.has(path) || !validationResult.healedPaths.has(path)) continue;
          result.warning = [result.warning, 'Auto-heal applied; diff reflects the final repaired content.'].filter(Boolean).join(' ');
          if (outputFormat === 'with_diff' || outputFormat === 'verbose') {
            const diff = unifiedDiff(fileContents.get(path) ?? '', workingContents.get(path) ?? '', path, diffContext);
            result.diff_truncated = diff.length > DIFF_TRUNCATE_THRESHOLD;
            result.diff = result.diff_truncated ? diff.slice(0, DIFF_PREVIEW_LENGTH) : diff;
            result.diff_preview = result.diff_truncated ? result.diff : undefined;
          }
        }
      }
      if (validationResult.error) {
        return { success: false, error: validationResult.error + (repairWarnings.length ? `\n${repairWarnings.join('\n')}` : '') };
      }
    }

    // Post-edit diagnostics, cheap, in-process syntax check of each file we just
    // wrote, appended as a text block (this output already carries text suffixes
    // like the import-graph warning). Off when configured off; empty block when
    // the provider finds nothing (honest absence).
    let diagnosticsBlock = '';
    if (
      !dryRun &&
      writtenPaths.size > 0 &&
      env.diagnosticsProvider &&
      (env.configManager?.get('diagnostics.postEdit') ?? 'on') === 'on'
    ) {
      const touched = [...writtenPaths]
        .map((path) => ({ path, content: workingContents.get(path) }))
        .filter((f): f is { path: string; content: string } => typeof f.content === 'string');
      diagnosticsBlock = formatDiagnosticsBlock(await collectPostEditDiagnostics(env.diagnosticsProvider, touched));
    }

    return {
      success: anySuccess,
      output: formatOutput(results, outputFormat, dryRun) + (importGraphWarning ?? '') + (repairWarnings.length ? `\n${repairWarnings.join('\n')}` : '') + diagnosticsBlock,
    };
  } finally {
    // A failed validator/repair can leave successful edits in place. Finalize
    // only revisions we still own; rollback, revocation and a newer writer must
    // never create an executable snapshot of stale or unauthorized contents.
    if (!dryRun && hasCapturedToolInvocation() && env.fileUndoManager) {
      const admitted: Array<{ path: string; content: string; revision: CapturedWriteRevision }> = [];
      for (const path of env.capturedWritten) {
        const content = workingContents.get(path);
        const revision = env.capturedRevisions.get(path);
        if (content === undefined || !revision) continue;
        try {
          await assertCapturedToolReadAccess(path);
          admitted.push({ path, content, revision });
        } catch {
          // A later denial can invalidate earlier admissions too. Preserve the
          // prior history rather than grant delayed authority to any of them.
          admitted.length = 0;
          break;
        }
      }
      // A later admission can change an earlier file. Fence every revision after
      // all policy awaits, then snapshot synchronously under the same lease.
      for (const { path, content, revision } of admitted) {
        try {
          assertCapturedToolWriteRevision(path, revision);
          env.fileUndoManager.snapshot({ path, beforeContent: fileContents.get(path) ?? null, afterContent: content, tool: 'edit' });
        } catch {
          // Bookkeeping must not hide the edit result or bypass a held revision.
        }
      }
    }
  }
}

export interface EditToolOptions {
  cwd?: string | undefined;
  fileUndoManager?: FileUndoManager | undefined;
  configManager?: Pick<ConfigManager, 'get' | 'getWorkingDirectory'> | undefined;
  toolLLM?: Pick<ToolLLM, 'chat'> | undefined;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'> | undefined;
  diagnosticsProvider?: DiagnosticsProvider | undefined;
  validatorRunner?: ValidatorRunner | undefined;
  capturedAutoHeal?: CapturedAutoHealBackend | undefined;
}

function resolveEditCwd(options?: EditToolOptions): string {
  if (options?.cwd && options.cwd.trim().length > 0) {
    return options.cwd;
  }
  const workingDirectory = options?.configManager?.getWorkingDirectory();
  if (workingDirectory && workingDirectory.trim().length > 0) {
    return workingDirectory;
  }
  throw new Error('createEditTool requires an explicit cwd or configManager.getWorkingDirectory()');
}

export function createEditTool(fileCache: FileStateCache, options?: EditToolOptions): Tool {
  const cwd = resolveEditCwd(options);
  const definition: ToolDefinition = {
    name: 'edit',
    description:
      'Edit files by finding and replacing text. Supports exact, fuzzy, and regex matching. ' +
      'Handles multiple edits in one call with atomic or partial transaction semantics. ' +
      'Detects OCC conflicts when files have been modified externally. ' +
      'Also supports Jupyter notebook (.ipynb) cell operations via notebook_operations field.',
    parameters: toRecord(editSchema),
    sideEffects: ['write_fs'],
    concurrency: 'serial',
    supportsProgress: true,
  };

  async function execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const input = args as EditInput;
      if (!input.edits && !input.notebook_operations) {
        return { success: false, error: 'Either edits or notebook_operations must be provided' };
      }
      if (input.edits && input.notebook_operations) {
        return { success: false, error: 'Provide either edits or notebook_operations, not both' };
      }

      const env: EditExecutionContext = {
        capturedRevisions: new Map(),
        capturedWritten: new Set(),
        fileCache,
        cwd,
        fileUndoManager: options?.fileUndoManager,
        configManager: options?.configManager,
        toolLLM: options?.toolLLM,
        changeTracker: options?.changeTracker,
        diagnosticsProvider: options?.diagnosticsProvider,
        validatorRunner: options?.validatorRunner,
        capturedAutoHeal: options?.capturedAutoHeal,
      };

      if (input.notebook_operations) {
        return await executeNotebookEdit(input, env);
      }
      return await executeTextEdits(input, env);
    } catch (err) {
      return { success: false, error: `Unexpected error: ${summarizeError(err)}` };
    }
  }

  return { definition, execute };
}
