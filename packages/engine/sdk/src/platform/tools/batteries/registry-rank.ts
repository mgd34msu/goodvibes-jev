/**
 * `engine.tools.registry-rank`: orders the skills, agents and tools the
 * registry tool knows against a search query (mode search) or a task
 * description (mode recommend). Read by Jev in place of the Fuse.js fuzzy
 * match registry-tool/index.ts used (field weights name 3, path 2,
 * description 1, threshold 0.4, with a lowercase substring test when fuse.js
 * was missing) and the word-overlap count of its recommend mode.
 *
 * The re-ranking cookbook: the registry's scan of skill and agent folders and
 * the tool registry's list are the shortlist (code), then one yes/no per
 * query-candidate pair, each in its own request, orders it by probability.
 * Search leaves out candidates read as not matching; recommend lists them
 * after the matching ones.
 *
 * Band: low stakes. The reading only decides what a model is shown first when
 * it looks for a capability; nothing runs on the strength of it.
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** Most characters of a candidate's description or preview the reading carries. */
export const MAX_JUDGED_REGISTRY_CHARS = 600;

const clip = (text: string): string => (text.length <= MAX_JUDGED_REGISTRY_CHARS ? text : `${text.slice(0, MAX_JUDGED_REGISTRY_CHARS)}...`);

/** What the rerank sees of a skill, agent or tool: its kind, name, description and, when it has one, a preview of its body. */
export function registryCandidateView(item: {
  readonly type: 'skill' | 'agent' | 'tool';
  readonly name: string;
  readonly description: string;
  readonly preview?: string | undefined;
}): { [field: string]: string } {
  return {
    type: item.type,
    name: item.name,
    description: clip(item.description),
    ...(item.preview ? { preview: clip(item.preview) } : {}),
  };
}

const candidate = (type: 'skill' | 'agent' | 'tool', name: string, description: string) => ({
  id: `${type}:${name}`,
  content: registryCandidateView({ type, name, description }),
});

const READ = candidate('tool', 'read', 'Read the contents of a file in the workspace, with optional line ranges.');
const EDIT = candidate('tool', 'edit', 'Replace text in one or more files: exact, fuzzy, regex or AST matching, with dry runs and atomic transactions.');
const EXEC = candidate('tool', 'exec', 'Run a shell command in the project directory and return its output. Use for builds, tests and git.');
const FETCH = candidate('tool', 'fetch', 'Fetch a URL over HTTP and return the response body as text or markdown.');
const WEB_SEARCH = candidate('tool', 'web_search', 'Search the public web and return result titles, links and snippets.');
const FIND = candidate('tool', 'find', 'Search the project: files by glob, content by regular expression, symbols and references.');
const DB_MIGRATIONS = candidate('skill', 'db-migrations', 'Write and review database schema migrations: reversible steps, backfills, and locking concerns on large tables.');
const RELEASE_NOTES = candidate('skill', 'release-notes', 'Draft release notes from merged pull requests since the last tag.');
const REACT_PERF = candidate('skill', 'react-performance', 'Find and fix slow React renders: memoization, list virtualization and profiling.');
const TESTER = candidate('agent', 'tester', 'Writes and runs tests that verify real behavior after an implementation change.');
const REVIEWER = candidate('agent', 'reviewer', 'Reviews a diff for correctness defects and reports them by severity.');
const DOC_WRITER = candidate('agent', 'doc-writer', 'Writes and updates user-facing documentation pages.');

export const registryRank = defineRerank({
  name: 'engine.tools.registry-rank',
  version: 1,
  description: 'Orders skills, agents and tools by whether each one provides what a registry search query or task description is looking for.',
  accuracyFloor: 0.85,
  instructions: 'Someone is looking for a skill, agent or tool, described by `query`: either a few search words or a description of a task they need to do. `candidate` is one available skill, agent or tool with its `type`, `name` and `description`. Is this candidate one they are looking for: something that provides, or directly helps with, what the query names?',
  criteria: {
    true: 'The candidate\'s purpose covers what the query asks for: searching for it by these words or picking it for this task would make sense.',
    false: 'The candidate does something else, or only shares a word with the query without serving its purpose.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'a keyword finds a tool', query: 'shell', candidates: [READ, FETCH, EXEC], expect: { top: 'tool:exec' } },
    { name: 'a keyword finds a skill', query: 'migration', candidates: [RELEASE_NOTES, DB_MIGRATIONS, REACT_PERF], expect: { top: 'skill:db-migrations' } },
    { name: 'a task picks a tool', query: 'look up the latest version of a library on the internet', candidates: [FIND, WEB_SEARCH, READ], expect: { top: 'tool:web_search' } },
    { name: 'a task picks a skill', query: 'the product list page stutters when scrolling through thousands of rows', candidates: [DB_MIGRATIONS, RELEASE_NOTES, REACT_PERF], expect: { top: 'skill:react-performance' } },
    { name: 'a task picks an agent', query: 'add coverage for the new checkout discount logic', candidates: [DOC_WRITER, REVIEWER, TESTER], expect: { top: 'agent:tester' } },
    { name: 'a keyword over wording rather than purpose', query: 'replace text in files', candidates: [FIND, READ, EDIT], expect: { top: 'tool:edit' } },
    { name: 'nothing sends email', query: 'send an email to the customer', candidates: [RELEASE_NOTES, DOC_WRITER, FETCH], expect: { top: 'none' } },
    { name: 'nothing for kubernetes', query: 'kubernetes', candidates: [EXEC, DB_MIGRATIONS, REVIEWER], expect: { top: 'none' } },
  ],
});
