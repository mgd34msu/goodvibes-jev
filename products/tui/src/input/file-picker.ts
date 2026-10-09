import { readWalkDirectories } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ShellPathService } from '@/runtime/index.ts';

/**
 * FilePickerModal - Fuzzy file finder triggered by @ in the input area.
 * Walks the project directory, fuzzy-matches against the query,
 * and lets the user select a file to insert its path.
 */
export class FilePickerModal {
  constructor(private readonly shellPaths: Pick<ShellPathService, 'workingDirectory'>) {}

  public active = false;
  public query = '';
  public searchFocused = true;
  public results: string[] = [];
  public selectedIndex = 0;
  /** Position in the prompt where @ was typed, used to replace @query with the selected path */
  public insertPos = 0;
  /** When true, selected file inserts as !@path (inject mode) instead of @path */
  public injectMode = false;

  public allFiles: string[] = [];
  private filesCached = false;
  private cachedRoot: string | undefined;
  private loading: AbortController | undefined;
  public loadError: string | undefined;
  

  private onUpdate: (() => void) | null = null;

  /** Set a callback to trigger re-render when file list loads. */
  setOnUpdate(fn: () => void): void {
    this.onUpdate = fn;
  }

  /** Activate the file picker at the given prompt position. */
  open(insertPos: number, injectMode = false): void {
    this.active = true;
    this.query = '';
    this.searchFocused = true;
    this.selectedIndex = 0;
    this.insertPos = insertPos;
    this.injectMode = injectMode;

    this.loading?.abort();
    this.loading = undefined;
    this.loadError = undefined;
    if (this.filesCached && this.cachedRoot === this.shellPaths.workingDirectory) {
      this.updateResults();
    } else {
      // Show "Loading..." immediately, never filter stale files from another root.
      this.results = [];
      this.allFiles = [];
      this.filesCached = false;
      this.cachedRoot = undefined;
      const controller = new AbortController();
      const root = this.shellPaths.workingDirectory;
      this.loading = controller;
      const current = () => this.active && this.loading === controller
        && !controller.signal.aborted && this.shellPaths.workingDirectory === root;
      const assertCurrent = () => {
        if (!current()) controller.abort();
        controller.signal.throwIfAborted();
      };
      void this.loadFiles(root, controller.signal, assertCurrent).then(files => {
        if (!current()) return;
        this.allFiles = files;
        this.filesCached = true;
        this.cachedRoot = root;
        this.updateResults();
        this.onUpdate?.();
      }).catch(() => {
        if (!current()) return;
        this.allFiles = [];
        this.results = [];
        this.filesCached = false;
        this.loadError = 'File listing unavailable. Close and reopen to retry.';
        this.onUpdate?.();
      }).finally(() => { if (this.loading === controller) this.loading = undefined; });
    }
  }

  /** Close the file picker without selecting. */
  close(): void {
    this.loading?.abort();
    this.loading = undefined;
    this.loadError = undefined;
    this.active = false;
    this.query = '';
    this.searchFocused = true;
    this.results = [];
    this.selectedIndex = 0;
    this.injectMode = false;
  }

  /** Update the search query and re-filter results. */
  setQuery(q: string): void {
    this.query = q;
    this.selectedIndex = 0;
    this.updateResults();
  }

  canFocusSearch(): boolean {
    return true;
  }

  focusSearch(): void {
    this.searchFocused = true;
  }

  blurSearch(): void {
    this.searchFocused = false;
  }

  /** Move selection up. */
  moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }

  /** Move selection down. */
  moveDown(): void {
    if (this.selectedIndex < this.results.length - 1) this.selectedIndex++;
  }

  /** Get the currently selected file path, or null if none. */
  getSelected(): string | null {
    if (this.results.length === 0) return null;
    return this.results[this.selectedIndex] ?? null;
  }

  /** Fuzzy match: does the query match the candidate? */
  private fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
    if (query.length === 0) return { match: true, score: 0 };
    const lowerQuery = query.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();

    // Substring match (highest priority)
    const subIdx = lowerCandidate.indexOf(lowerQuery);
    if (subIdx !== -1) {
      // Bonus for matching at start of filename (after last /)
      const lastSlash = lowerCandidate.lastIndexOf('/');
      const filenameStart = lastSlash + 1;
      const isFilenameMatch = subIdx >= filenameStart;
      return { match: true, score: isFilenameMatch ? 100 - subIdx : 50 - subIdx };
    }

    // Character-by-character fuzzy match
    let qi = 0;
    let score = 0;
    for (let ci = 0; ci < lowerCandidate.length && qi < lowerQuery.length; ci++) {
      if (lowerCandidate[ci] === lowerQuery[qi]) {
        qi++;
        score += 1;
      }
    }
    if (qi === lowerQuery.length) {
      return { match: true, score };
    }
    return { match: false, score: 0 };
  }

  private updateResults(): void {
    if (this.query.length === 0) {
      this.results = this.allFiles;
      return;
    }

    const scored = this.allFiles
      .map(f => ({ file: f, ...this.fuzzyMatch(this.query, f) }))
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score)
      ;

    this.results = scored.map(r => r.file);
    if (this.selectedIndex >= this.results.length) {
      this.selectedIndex = Math.max(0, this.results.length - 1);
    }
  }

  private async loadFiles(root: string, signal: AbortSignal, assertCurrent: () => void): Promise<string[]> {
    const files: string[] = [];
    await this.walkDir(root, root, files, 0, signal, assertCurrent);
    assertCurrent();
    return files.sort();
  }

  private async walkDir(root: string, dir: string, files: string[], depth: number, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (depth > 8) return; // Limit depth
    if (files.length > 5000) return; // Limit total files

    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as import('node:fs').Dirent[];
    } catch {
      return;
    }

    assertCurrent();
    // Hidden-dot filtering is literal policy. Only directory meaning goes to Jev.
    const visible = entries.filter(entry => !entry.name.startsWith('.'));
    const directories = visible.filter(entry => entry.isDirectory());
    const readings = await readWalkDirectories(directories.map(entry => ({
      name: entry.name, relativePath: relative(root, join(dir, entry.name)),
    })), { signal, beforeAttempt: assertCurrent, site: 'tui.file-picker.skip-directory' });
    assertCurrent();
    if (readings.some(reading => reading === null)) throw new Error('Directory reading withheld');
    const skipped = new Set(directories.filter((_entry, index) => readings[index] === true).map(entry => entry.name));
    for (const entry of visible) {
      assertCurrent();
      if (entry.isDirectory() && skipped.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      if (entry.isDirectory()) {
        files.push(relPath + '/');
        await this.walkDir(root, fullPath, files, depth + 1, signal, assertCurrent);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  /** Invalidate the file cache (e.g., after file operations). */
  invalidateCache(): void {
    this.loading?.abort();
    this.loading = undefined;
    this.cachedRoot = undefined;
    this.loadError = undefined;
    this.filesCached = false;
    this.allFiles = [];
    this.results = [];
    this.selectedIndex = 0;
  }
}
