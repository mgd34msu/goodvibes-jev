/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { CallOptions } from '@goodvibes-jev/judgment/decisions';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { readWalkDirectories, type WalkDirectoryCandidate } from './directory-reading.js';
import { logger } from './logger.js';
import { summarizeError } from './error-display.js';

/** @deprecated Historical compatibility data only; traversal uses canonical directory readings. */
export const WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
]);

/** A memory limit, independent of the directory-meaning reading (1 MiB). */
export const WALK_MAX_FILE_SIZE = 1024 * 1024;

/**
 * beforeAttempt fences every filesystem checkpoint. beforeAsyncAttempt fences
 * traversal entry/exit and actual directory readings/retries, not local stat calls.
 */
export interface WalkDirOptions extends CallOptions {
  readonly includeHidden?: boolean;
  readonly followSymlinks?: boolean;
  readonly maxFileSize?: number;
  /** Explicit caller selection, evaluated before opening a file. */
  readonly selectFile?: (path: string) => boolean;
  /** Conservative explicit caller scope, evaluated before judging/descent. */
  readonly selectDirectory?: (path: string) => boolean;
  /** A bounded caller can stop without publishing files discovered after its deadline. */
  readonly shouldContinue?: () => boolean;
  /** Checked outside filesystem-error catches, before opening each path. */
  readonly assertPath?: (path: string) => void;
}

class WalkStopped extends Error {}

/**
 * A root-owned reading cache. Share only within one invocation (for example its
 * ignore-file discovery and glob scan), never between roots or requests.
 */
export class DirectoryWalk {
  readonly root: string;
  private readonly skipped = new Map<string, boolean>();
  private realRoot: string | undefined;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async readDirectories(candidates: readonly WalkDirectoryCandidate[], options: CallOptions): Promise<void> {
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    // Screen complete current identities before consulting any cached outcome.
    snapshotJudgmentInput(candidates);
    const unread = candidates.filter(candidate => !this.skipped.has(candidate.relativePath));
    if (unread.length === 0) return;
    await options.beforeAsyncAttempt?.();
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    const readings = await readWalkDirectories(unread, options);
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    await options.beforeAsyncAttempt?.();
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    if (readings.length !== unread.length || readings.some(reading => typeof reading !== 'boolean')) {
      throw new Error('Directory reading withheld');
    }
    unread.forEach((candidate, index) => this.skipped.set(candidate.relativePath, readings[index] as boolean));
  }

  /** Automatic index maintenance uses the same root-relative ancestor verdicts. */
  async excludesFile(filePath: string, options: CallOptions = {}): Promise<boolean> {
    const path = relative(this.root, resolve(filePath));
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('File is outside the directory walk root');
    options.signal?.throwIfAborted(); options.beforeAttempt?.();
    const initialRoot = await realpath(this.root);
    options.signal?.throwIfAborted(); options.beforeAttempt?.();
    this.realRoot ??= initialRoot;
    if (this.realRoot !== initialRoot) throw new Error('Directory walk path changed during reading');
    const parts = path.split(sep);
    if (parts.some(part => part.startsWith('.'))) return true;
    const ancestors = parts.slice(0, -1).map((name, index) => ({ name, relativePath: parts.slice(0, index + 1).join('/') }));
    await this.readDirectories(ancestors, { ...options, site: options.site ?? 'utils.walk-directory' });
    if (ancestors.some(candidate => this.skipped.get(candidate.relativePath) === true)) return true;
    // Automatic maintenance follows the full walk's no-symlink boundary, even
    // when a file-writing hook names an alias or an ancestor changed mid-read.
    for (let index = 0; index <= parts.length; index++) {
      const local = join(this.root, ...parts.slice(0, index));
      let info: Awaited<ReturnType<typeof lstat>>;
      let actual: string;
      try { info = await lstat(local); actual = await realpath(local); } catch {
        options.signal?.throwIfAborted(); options.beforeAttempt?.();
        return true;
      }
      options.signal?.throwIfAborted(); options.beforeAttempt?.();
      if ((index > 0 && info.isSymbolicLink()) || (index > 0 && index < parts.length && !info.isDirectory())) return true;
      if (actual !== join(this.realRoot, ...parts.slice(0, index))) throw new Error('Directory walk path changed during reading');
      if (index === parts.length && !info.isFile()) return true;
    }
    return false;
  }

  /** Gate each visible level before descent; a held/failed reading aborts it. */
  async *files(options: WalkDirOptions = {}): AsyncGenerator<string> {
    const root = this.root;
    const skipped = this.skipped;
    const owner = this;
    const maxFileSize = options.maxFileSize ?? WALK_MAX_FILE_SIZE;
    const assertCurrent = (): void => {
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();
      if (options.shouldContinue?.() === false) throw new WalkStopped();
    };
    // Local metadata steps need the current invocation/token, not a replay of
    // every previously authorized file. Full readset checks fence external
    // readings (including retries) and the traversal's entry/exit instead.
    const checkCurrent = async (): Promise<void> => { assertCurrent(); };
    const checkReadAccess = async (): Promise<void> => {
      assertCurrent();
      await options.beforeAsyncAttempt?.();
      assertCurrent();
    };
    const readingOptions: CallOptions = {
      ...options, beforeAttempt: assertCurrent, beforeAsyncAttempt: checkReadAccess,
      site: options.site ?? 'utils.walk-directory',
    };

    async function stablePath(path: string): Promise<boolean> {
      if (options.followSymlinks) return true;
      let actual: string;
      try { actual = await realpath(path); } catch (err) {
        await checkCurrent();
        logger.warn('walkDir skipped unreadable path', { path, error: summarizeError(err) });
        return false;
      }
      await checkCurrent();
      owner.realRoot ??= actual;
      // lstat(path) alone follows symlinks in its ancestors. Anchor the whole
      // path to the initial real root so an awaited reading cannot escape it.
      if (actual !== resolve(owner.realRoot, relative(root, path))) {
        throw new Error('Directory walk path changed during reading');
      }
      return true;
    }

    async function* visit(dir: string, ancestors = new Set<string>()): AsyncGenerator<string> {
      await checkCurrent();
      options.assertPath?.(dir);
      let descendants = ancestors;
      if (options.followSymlinks) {
        let actual: string;
        try { actual = await realpath(dir); } catch (err) {
          await checkCurrent();
          logger.warn('walkDir skipped unreadable directory', { path: dir, error: summarizeError(err) });
          return;
        }
        await checkCurrent();
        options.assertPath?.(actual);
        if (ancestors.has(actual)) return;
        descendants = new Set([...ancestors, actual]);
      }
      let entries: Dirent[];
      try {
        // Recheck after every suspended reading: a directory may have become a
        // symlink. No-follow walks must never gain authority by that replacement.
        const info = await lstat(dir);
        if (dir !== root && !info.isDirectory() && !options.followSymlinks) return;
        // The check below is outside the filesystem-error catch.
      } catch (err) {
        await checkCurrent();
        logger.warn('walkDir skipped unreadable directory', { path: dir, error: summarizeError(err) });
        return;
      }
      // Establish the initial root only after its existence has been checked.
      if (!await stablePath(dir)) return;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        await checkCurrent();
        logger.warn('walkDir skipped unreadable directory', { path: dir, error: summarizeError(err) });
        return;
      }
      await checkCurrent();
      if (!await stablePath(dir)) return;
      // The leading-dot convention is explicit policy, not a meaning guess.
      const visible = entries.filter(entry => {
        if (!options.includeHidden && entry.name.startsWith('.')) return false;
        const fullPath = join(dir, entry.name);
        if (entry.isFile()) return options.selectFile?.(fullPath) !== false;
        if (entry.isDirectory()) return options.selectDirectory?.(fullPath) !== false;
        // A followed alias has unknown type until stat. Only skip it when
        // neither possible type is in the caller's explicit selection.
        return entry.isSymbolicLink() && options.followSymlinks
          && (options.selectFile?.(fullPath) !== false || options.selectDirectory?.(fullPath) !== false);
      });
      const directories: Dirent[] = [];
      const files: Dirent[] = [];
      for (const entry of visible) {
        if (entry.isDirectory()) directories.push(entry);
        else if (entry.isFile()) files.push(entry);
        else if (entry.isSymbolicLink() && options.followSymlinks) {
          options.assertPath?.(join(dir, entry.name));
          let info: Awaited<ReturnType<typeof stat>>;
          try {
            info = await stat(join(dir, entry.name));
          } catch (err) {
            await checkCurrent();
            logger.warn('walkDir skipped unreadable file', { path: join(dir, entry.name), error: summarizeError(err) });
            continue;
          }
          await checkCurrent();
          // Caller selection failures are not suppressible filesystem errors.
          if (info.isDirectory() && options.selectDirectory?.(join(dir, entry.name)) !== false) directories.push(entry);
          else if (info.isFile() && options.selectFile?.(join(dir, entry.name)) !== false) files.push(entry);
        }
      }
      const candidates = directories.map(entry => ({
        name: entry.name, relativePath: relative(root, join(dir, entry.name)).split(sep).join('/'),
      }));
      await owner.readDirectories(candidates, readingOptions);
      await checkCurrent();
      const fileNames = new Set(files.map(entry => entry.name));
      const directoryNames = new Set(directories.map(entry => entry.name));
      for (const entry of visible) {
        await checkCurrent();
        const fullPath = join(dir, entry.name);
        options.assertPath?.(fullPath);
        if (directoryNames.has(entry.name)) {
          const identity = relative(root, fullPath).split(sep).join('/');
          if (!skipped.get(identity)) yield* visit(fullPath, descendants);
        } else if (fileNames.has(entry.name)) {
          try {
            const info = options.followSymlinks ? await stat(fullPath) : await lstat(fullPath);
            if (!info.isFile() || info.size > maxFileSize) continue;
          } catch (err) {
            await checkCurrent();
            logger.warn('walkDir skipped unreadable file', { path: fullPath, error: summarizeError(err) });
            continue;
          }
          await checkCurrent();
          options.assertPath?.(fullPath);
          if (!await stablePath(fullPath)) continue;
          yield fullPath;
        }
      }
      // Selection may reject every entry; still fence completion of the level.
      await checkCurrent();
    }

    try {
      await checkReadAccess();
      yield* visit(root);
    } catch (error) {
      if (!(error instanceof WalkStopped)) throw error;
    } finally {
      // Async-generator return (limit/cap/break) is a publication boundary too.
      // Do not use shouldContinue here: reaching a bound is not lost authority.
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();
      await options.beforeAsyncAttempt?.();
      options.signal?.throwIfAborted();
      options.beforeAttempt?.();
    }
  }
}

/** Hidden entries, symlinks and files over 1 MiB are excluded by default. */
export async function* walkDir(dirPath: string, options: WalkDirOptions = {}): AsyncGenerator<string> {
  yield* new DirectoryWalk(dirPath).files(options);
}
