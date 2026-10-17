/**
 * Resolve a shared memory-store path and merge stores by record ID without loss.
 * Access must be sequential: sql.js rewrites the complete file on each save.
 * Folding preserves existing records and source stores, and reports what moved.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from './memory-store.js';
import type { MemoryEmbeddingProviderRegistry } from './memory-embeddings.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The single cross-surface memory database path, rooted at the user home dir. */
export function resolveCanonicalMemoryDbPath(homeDir: string): string {
  return join(homeDir, '.goodvibes', 'shared', 'memory.sqlite');
}

/** A legacy/per-surface store to fold into the canonical store. */
export interface LegacyMemorySource {
  /** Human-readable label for the report, e.g. 'agent-global' or 'tui:/repo'. */
  readonly label: string;
  /** Absolute path to the source SQLite database. */
  readonly dbPath: string;
}

export interface MemoryFoldSourceReport {
  readonly label: string;
  readonly dbPath: string;
  /** false → the source file did not exist and was skipped (not an error). */
  readonly existed: boolean;
  /** Records newly folded into the canonical store from this source. */
  readonly importedRecords: number;
  /**
   * Records already present in the canonical store (same id) and therefore left
   * untouched. NOT dropped, the existing canonical record is authoritative and
   * the source copy is a duplicate. Non-zero here on a re-run proves idempotence.
   */
  readonly skippedRecords: number;
  readonly importedLinks: number;
  /** Present only when the source could not be opened/read; the source is skipped, not fatal. */
  readonly error?: string;
}

export interface MemoryFoldReport {
  readonly canonicalPath: string;
  readonly totalImported: number;
  readonly totalSkipped: number;
  readonly totalLinks: number;
  readonly sources: readonly MemoryFoldSourceReport[];
  /** Labels of sources whose file did not exist (skipped, not an error). */
  readonly missingSources: readonly string[];
  /** Labels of sources that failed to open/parse (skipped per-source, run never aborts). */
  readonly failedSources: readonly string[];
}

export interface FoldMemoryStoresOptions {
  /** Embedding registry used to open each source store read-only (vector index disabled). */
  readonly embeddingRegistry: MemoryEmbeddingProviderRegistry;
}

/**
 * Fold every legacy/per-surface store into the canonical store via the bundle
 * seam. Id-keyed union: an id already in the canonical store is left as-is
 * (counted as skipped), a new id is imported. Never overwrites, never deletes a
 * source, never aborts on one bad source. Idempotent, re-running folds nothing
 * new (all ids already present). Returns a full report.
 *
 * This is the migration path (fold the old per-surface stores in at boot) AND
 * the reconciliation primitive for an offline/embedded surface that cannot share
 * the canonical file live (fold its bundle in when it reconnects).
 */
export async function foldMemoryStores(
  canonical: MemoryStore,
  sources: readonly LegacyMemorySource[],
  options: FoldMemoryStoresOptions,
): Promise<MemoryFoldReport> {
  await canonical.init();

  const sourceReports: MemoryFoldSourceReport[] = [];
  const missingSources: string[] = [];
  const failedSources: string[] = [];
  let totalImported = 0;
  let totalSkipped = 0;
  let totalLinks = 0;

  for (const source of sources) {
    if (!existsSync(source.dbPath)) {
      missingSources.push(source.label);
      sourceReports.push({
        label: source.label,
        dbPath: source.dbPath,
        existed: false,
        importedRecords: 0,
        skippedRecords: 0,
        importedLinks: 0,
      });
      continue;
    }

    let sourceStore: MemoryStore | null = null;
    try {
      sourceStore = new MemoryStore(source.dbPath, {
        embeddingRegistry: options.embeddingRegistry,
        enableVectorIndex: false,
      });
      await sourceStore.init();
      const bundle = sourceStore.exportBundle({});
      const result = await canonical.importBundle(bundle);
      totalImported += result.importedRecords;
      totalSkipped += result.skippedRecords;
      totalLinks += result.importedLinks;
      sourceReports.push({
        label: source.label,
        dbPath: source.dbPath,
        existed: true,
        importedRecords: result.importedRecords,
        skippedRecords: result.skippedRecords,
        importedLinks: result.importedLinks,
      });
    } catch (err) {
      const error = summarizeError(err);
      failedSources.push(source.label);
      sourceReports.push({
        label: source.label,
        dbPath: source.dbPath,
        existed: true,
        importedRecords: 0,
        skippedRecords: 0,
        importedLinks: 0,
        error,
      });
      logger.warn('foldMemoryStores: source skipped', { label: source.label, error });
    } finally {
      sourceStore?.close();
    }
  }

  const report: MemoryFoldReport = {
    canonicalPath: canonical.dbPath ?? '(unknown)',
    totalImported,
    totalSkipped,
    totalLinks,
    sources: sourceReports,
    missingSources,
    failedSources,
  };
  logger.info('foldMemoryStores: complete', {
    canonicalPath: report.canonicalPath,
    totalImported,
    totalSkipped,
    missing: missingSources.length,
    failed: failedSources.length,
  });
  return report;
}

/** Render a human-readable summary of a fold report (for surfacing at boot). */
export function formatMemoryFoldReport(report: MemoryFoldReport): string {
  const lines: string[] = [
    'Memory unification, fold into canonical store',
    `  canonical ${report.canonicalPath}`,
    `  imported ${report.totalImported}  already-present ${report.totalSkipped}  links ${report.totalLinks}`,
  ];
  for (const source of report.sources) {
    if (!source.existed) {
      lines.push(`  - ${source.label}: no store on disk (nothing to fold)`);
    } else if (source.error) {
      lines.push(`  - ${source.label}: SKIPPED, ${source.error}`);
    } else {
      lines.push(`  - ${source.label}: +${source.importedRecords} imported, ${source.skippedRecords} already present, +${source.importedLinks} links`);
    }
  }
  return lines.join('\n');
}
