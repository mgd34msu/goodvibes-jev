/**
 * typecheck-coverage, proves every TypeScript file in this repo is actually
 * inside a typechecked project.
 *
 * WHY THIS EXISTS: for most of this repo's life `bun run typecheck` was a single
 * `tsc --noEmit` over a tsconfig whose `include` was `["src", "vite.config.ts"]`.
 * Everything under scripts/ and e2e/, 56 files, including 5 test files and the
 * 120KB mock daemon the entire Playwright suite is built on, compiled nowhere.
 * CI ran `bun run typecheck`, `bun run typecheck` reported success, and a genuine
 * type error in any of those files was invisible. That is the failure this guard
 * closes, and it closes it by MEASUREMENT, not by reasoning about include globs:
 * the covered set comes from `tsc --listFilesOnly`, i.e. the compiler's own answer
 * to "which files did you actually load into the program?".
 *
 * A new directory of TypeScript that nobody added to a project fails here, loudly,
 * naming each file.
 */
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every tsconfig `bun run typecheck` compiles. Adding a project here means adding
 * it to package.json's "typecheck" script too, or this gate claims coverage that
 * nothing actually checks.
 */
export const TYPECHECK_PROJECTS = ['tsconfig.json', 'scripts/tsconfig.json', 'e2e/tsconfig.json'] as const;

/** Extensions this gate considers "TypeScript that must be checked". */
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * Paths that are TypeScript but deliberately outside every project. Empty on
 * purpose: there is currently no such file, and an entry here is a documented,
 * reviewable exemption rather than a silent gap. Compared against repo-relative
 * paths with forward slashes.
 */
export const COVERAGE_EXEMPT_PATHS: readonly string[] = [];

export function isTypeScriptPath(path: string): boolean {
  // `.d.ts` is TypeScript too, but a declaration file is only meaningful inside a
  // program that references it; the gate tracks authored source.
  if (path.endsWith('.d.ts')) return false;
  return TS_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * The gate's decision, as a pure function of two file sets, so a test can hand it
 * a covered set that is genuinely missing a file and prove the gate says NO.
 */
export function findUncoveredFiles(allFiles: readonly string[], coveredFiles: Iterable<string>): string[] {
  const covered = new Set(coveredFiles);
  const exempt = new Set(COVERAGE_EXEMPT_PATHS);
  return allFiles.filter((file) => !covered.has(file) && !exempt.has(file)).sort();
}

/**
 * Repo-relative, forward-slashed TypeScript source files.
 *
 * `--cached --others --exclude-standard` = tracked files PLUS untracked ones that
 * .gitignore does not exclude. The untracked half matters: a file added in the
 * working tree but not yet committed is exactly when you want to hear that no
 * project covers it, and a tracked-only listing stays silent until after the
 * commit. `--exclude-standard` is what keeps node_modules, dist and .test-tmp out.
 * `--deduplicate` because a path can appear in both sets.
 */
export function listRepoTypeScriptFiles(root: string = ROOT, environment: NodeJS.ProcessEnv = process.env): string[] {
  // Git hooks export repository selectors. In a worktree, inherited GIT_DIR
  // makes ls-files report the monorepo index from its root even with cwd set to
  // this product. Discover the repository from this product's own directory.
  const env = { ...environment };
  for (const name of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
  ]) delete env[name];
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', '*.ts', '*.tsx', '*.mts', '*.cts'],
    { cwd: root, encoding: 'utf8', env },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split('\0')
    .filter((path) => path.length > 0)
    .filter(isTypeScriptPath)
    .sort();
}

/**
 * The files `tsc` itself loaded for one project, repo-relative, excluding
 * node_modules (dependency .d.ts files are not this repo's source).
 */
export function listProjectFiles(project: string, root: string = ROOT): string[] {
  const result = spawnSync('bunx', ['tsc', '-p', project, '--noEmit', '--listFilesOnly'], {
    cwd: root,
    encoding: 'utf8',
  });
  // --listFilesOnly does not typecheck, so a nonzero status here means the project
  // could not be loaded at all (missing/!malformed tsconfig), never a type error.
  if (result.status !== 0 && result.stdout.trim().length === 0) {
    throw new Error(`tsc -p ${project} --listFilesOnly failed: ${result.stderr || result.stdout}`);
  }
  const files: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const absolute = line.trim();
    if (absolute.length === 0) continue;
    if (absolute.includes('/node_modules/')) continue;
    const rel = relative(root, absolute);
    if (rel.startsWith('..')) continue;
    files.push(rel.split('\\').join('/'));
  }
  return files;
}

function main(): void {
  const allFiles = listRepoTypeScriptFiles();
  const covered = new Set<string>();
  for (const project of TYPECHECK_PROJECTS) {
    for (const file of listProjectFiles(project)) covered.add(file);
  }

  const uncovered = findUncoveredFiles(allFiles, covered);
  if (uncovered.length > 0) {
    console.error(
      `typecheck coverage FAILED: ${String(uncovered.length)} TypeScript file(s) are not in any typechecked project:`,
    );
    for (const file of uncovered) console.error(`  ${file}`);
    console.error('');
    console.error(`Projects checked: ${TYPECHECK_PROJECTS.join(', ')}`);
    console.error('Add the file to one of those projects\' `include`, or add a new project and');
    console.error('register it in BOTH TYPECHECK_PROJECTS and package.json\'s "typecheck" script.');
    process.exit(1);
  }

  console.log(
    `typecheck coverage OK: ${String(allFiles.length)} TypeScript file(s) across ` +
      `${String(TYPECHECK_PROJECTS.length)} project(s).`,
  );
}

if (import.meta.main) main();
