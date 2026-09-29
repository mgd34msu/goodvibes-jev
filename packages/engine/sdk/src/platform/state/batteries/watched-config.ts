/**
 * `engine.state.watched-config`: whether a regular file in the project root is
 * a project configuration or environment file whose edits made outside the
 * session should refresh the caches and fire Change:file:external. Read by
 * Jev in place of file-watcher.ts DEFAULT_WATCH_PATHS (package.json,
 * tsconfig.json) and DEFAULT_ENV_GLOBS (five .env names), a fixed name list
 * that missed pyproject.toml, deno.json, .env.staging and anything else it
 * did not foresee.
 *
 * The rerank pattern with a fixed query naming the question: one yes/no per
 * root entry, each in its own request. FileWatcher.start watches each entry
 * read yes with an act outcome. Inputs are names only (a directory listing).
 *
 * Band: low stakes. A wrong yes costs one watcher; a wrong no leaves that
 * file's cache entry stale until it is next read.
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** The fixed query every root entry is read against. */
export const WATCHED_CONFIG_QUERY = 'Project configuration and environment files: files whose contents set how the project installs, builds, runs or is tested, such as package manifests, compiler, bundler, linter and test runner configs, and .env files.';

/** What the rerank sees of a root entry: its file name, nothing else. */
export function rootEntryCandidate(name: string): { readonly id: string; readonly content: { readonly name: string } } {
  return { id: name, content: { name } };
}

const one = (name: string, watched: boolean) => ({
  name: `${name} is ${watched ? '' : 'not '}configuration`,
  query: WATCHED_CONFIG_QUERY,
  candidates: [rootEntryCandidate(name)],
  expect: { top: watched ? name : 'none' },
});

export const watchedConfig = defineRerank({
  name: 'engine.state.watched-config',
  version: 1,
  description: 'Whether a file in the project root is a project configuration or environment file whose outside edits should refresh the session\'s cached view of the project.',
  accuracyFloor: 0.9,
  instructions: '`candidate` is the name of one regular file in the root directory of a software project. `query` describes the kind of file wanted. Is this file a project configuration or environment file of that kind, so that an edit to it made outside the coding session should refresh the session\'s cached view of the project?',
  criteria: {
    true: 'The name is a package manifest, a compiler, bundler, linter, formatter or test runner config, a workspace or tool settings file, or a .env file.',
    false: 'The name is documentation, a license, a changelog, a source file, a data file, or anything else that does not configure the project.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    one('package.json', true),
    one('tsconfig.json', true),
    one('pyproject.toml', true),
    one('deno.json', true),
    one('.env.staging', true),
    one('vite.config.ts', true),
    one('README.md', false),
    one('LICENSE', false),
    one('CHANGELOG.md', false),
    one('notes.txt', false),
    {
      name: 'the manifest among documents',
      query: WATCHED_CONFIG_QUERY,
      candidates: [rootEntryCandidate('CONTRIBUTING.md'), rootEntryCandidate('Cargo.toml'), rootEntryCandidate('logo.png')],
      expect: { top: 'Cargo.toml' },
    },
    {
      name: 'no configuration among documents',
      query: WATCHED_CONFIG_QUERY,
      candidates: [rootEntryCandidate('CODE_OF_CONDUCT.md'), rootEntryCandidate('screenshot.png'), rootEntryCandidate('SECURITY.md')],
      expect: { top: 'none' },
    },
  ],
});
