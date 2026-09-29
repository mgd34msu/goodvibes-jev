/**
 * `engine.ecosystem.catalog-search`: is this catalog entry something the
 * person searching for `query` is looking for? Read by Jev in place of the
 * substring match searchEcosystemCatalog used to make: the lowercased query
 * contained in the id, name, summary, source, trust notes, install hint and
 * tags joined into one string. That rule missed entries described in other
 * words ("github" never found a "pull request tools" entry) and kept entries
 * that only shared letters with the query ("auth" matched "author").
 *
 * One yes/no per (query, entry) pair, each pair its own request so no entry
 * becomes context for another. An empty query lists everything with no
 * reading; that guard and the name order stay code in catalog.ts.
 *
 * Band: low stakes. The result only filters a listing; installing an entry
 * still takes an explicit review and `/marketplace install`.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import type { EcosystemCatalogEntry } from '../catalog.js';

/** What the question sees of an entry: its words, never its source path, signature or version. */
export function catalogSearchEntryView(entry: EcosystemCatalogEntry): { [field: string]: string | string[] } {
  return {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    tags: [...entry.tags],
    ...(entry.installHint ? { installHint: entry.installHint } : {}),
    ...(entry.trustNotes ? { trustNotes: entry.trustNotes } : {}),
  };
}

const entry = (fields: Pick<EcosystemCatalogEntry, 'id' | 'kind' | 'name' | 'summary' | 'tags'> & { installHint?: string; trustNotes?: string }) =>
  catalogSearchEntryView({ source: 'catalog', ...fields });

const PR_TOOLS = entry({
  id: 'pr-tools',
  kind: 'plugin',
  name: 'Pull request tools',
  summary: 'Lets the agent open, comment on and merge pull requests and read CI checks on GitHub.',
  tags: ['vcs', 'code-host'],
});
const AUTHOR_STATS = entry({
  id: 'author-stats',
  kind: 'plugin',
  name: 'Author stats',
  summary: 'Counts commits and changed lines per author for a weekly contribution report.',
  tags: ['git', 'report'],
});
const OAUTH_HELPER = entry({
  id: 'oauth-helper',
  kind: 'hook-pack',
  name: 'OAuth helper',
  summary: 'Signs in to MCP servers that ask for OAuth and refreshes their tokens before they expire.',
  tags: ['mcp', 'login'],
});
const SOLARIZED_THEME = entry({
  id: 'solarized-theme',
  kind: 'plugin',
  name: 'Solarized theme',
  summary: 'Solarized light and dark color schemes for the terminal UI.',
  tags: ['theme', 'ui'],
});
const DOCS_WRITER = entry({
  id: 'docs-writer',
  kind: 'skill',
  name: 'Docs writer',
  summary: 'Writes and updates README files, API reference pages and changelogs from the code.',
  tags: ['writing'],
});
const TEST_RUNNER_HOOKS = entry({
  id: 'test-on-save',
  kind: 'hook-pack',
  name: 'Test on save',
  summary: 'Runs the unit tests that cover a file after the agent edits it.',
  tags: ['testing', 'hooks'],
});
const READONLY_SHELL = entry({
  id: 'readonly-shell',
  kind: 'policy-pack',
  name: 'Read-only shell',
  summary: 'Allows shell commands that only read files and asks before anything that writes or deletes.',
  tags: ['policy', 'shell'],
});
const DOCKER_DEPLOY = entry({
  id: 'container-deploy',
  kind: 'plugin',
  name: 'Container deploy',
  summary: 'Builds images and pushes them to a registry, then rolls out the new version to Kubernetes.',
  tags: ['deploy', 'containers'],
  installHint: 'Needs docker and kubectl on PATH.',
});
const RECIPE_SKILL = entry({
  id: 'recipe-scaling',
  kind: 'skill',
  name: 'Recipe scaling',
  summary: 'Scales cooking recipes to a different number of servings and converts units.',
  tags: ['cooking'],
});
const SECRET_SCAN = entry({
  id: 'secret-scan',
  kind: 'hook-pack',
  name: 'Secret scan',
  summary: 'Blocks a commit when a staged file contains an API key, token or private key.',
  tags: ['commit', 'credentials'],
});

export const catalogSearch = defineBattery({
  name: 'engine.ecosystem.catalog-search',
  version: 1,
  description: 'Whether an ecosystem catalog entry is something the person searching the catalog with a query is looking for.',
  accuracyFloor: 0.9,
  items: {
    wanted: yesNo(
      '`query` is what a person typed to search the ecosystem catalog. `entry` is one catalog entry. Is `entry` something the person searching for `query` is looking for?',
      STAKES_BANDS.low.yesNo,
      {
        true: "The entry's name, summary, tags or notes describe what the query asks for, in the same or other words.",
        false: 'The entry is about something else, or only shares letters or a word with the query.',
      },
    ),
  },
  fixtures: [
    { name: 'github finds pull request tools described in other words', state: { query: 'github', entry: PR_TOOLS }, expect: { wanted: 'yes' } },
    { name: 'pull requests finds pull request tools by name', state: { query: 'pull requests', entry: PR_TOOLS }, expect: { wanted: 'yes' } },
    { name: 'auth does not find author stats that only share letters', state: { query: 'auth', entry: AUTHOR_STATS }, expect: { wanted: 'no' } },
    { name: 'auth finds the OAuth sign-in hooks', state: { query: 'auth', entry: OAUTH_HELPER }, expect: { wanted: 'yes' } },
    { name: 'dark mode finds the solarized color schemes', state: { query: 'dark mode', entry: SOLARIZED_THEME }, expect: { wanted: 'yes' } },
    { name: 'dark mode does not find pull request tools', state: { query: 'dark mode', entry: PR_TOOLS }, expect: { wanted: 'no' } },
    { name: 'documentation finds the docs writer skill', state: { query: 'documentation', entry: DOCS_WRITER }, expect: { wanted: 'yes' } },
    { name: 'documentation does not find the recipe skill', state: { query: 'documentation', entry: RECIPE_SKILL }, expect: { wanted: 'no' } },
    { name: 'run tests finds the test on save hooks', state: { query: 'run tests', entry: TEST_RUNNER_HOOKS }, expect: { wanted: 'yes' } },
    { name: 'run tests does not find the read-only shell policy', state: { query: 'run tests', entry: READONLY_SHELL }, expect: { wanted: 'no' } },
    { name: 'docker finds the container deploy plugin', state: { query: 'docker', entry: DOCKER_DEPLOY }, expect: { wanted: 'yes' } },
    { name: 'docs does not find the container deploy plugin', state: { query: 'docs', entry: DOCKER_DEPLOY }, expect: { wanted: 'no' } },
    { name: 'leaked credentials finds the secret scan hooks', state: { query: 'leaked credentials', entry: SECRET_SCAN }, expect: { wanted: 'yes' } },
    { name: 'shell permissions finds the read-only shell policy', state: { query: 'shell permissions', entry: READONLY_SHELL }, expect: { wanted: 'yes' } },
    { name: 'kubernetes does not find the recipe skill', state: { query: 'kubernetes', entry: RECIPE_SKILL }, expect: { wanted: 'no' } },
    { name: 'theme does not find the secret scan hooks', state: { query: 'theme', entry: SECRET_SCAN }, expect: { wanted: 'no' } },
  ],
});
