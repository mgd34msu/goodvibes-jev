/**
 * The registry tool's search and recommend modes: candidates are ordered and
 * cut by the `engine.tools.registry-rank` rerank (a fake port here); without
 * a query or task nothing is judged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createRegistryTool } from '../sdk/src/platform/tools/registry-tool/index.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { Tool } from '../sdk/src/platform/types/tools.js';

let workingDirectory: string;
let homeDirectory: string;

function skill(root: string, name: string, description: string): void {
  const dir = join(root, '.goodvibes', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function agent(root: string, name: string, description: string): void {
  const dir = join(root, '.goodvibes', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

const fakeTool = (name: string, description: string): Tool => ({
  definition: { name, description, parameters: { type: 'object', properties: {} } },
  execute: async () => ({ success: true }),
});

beforeAll(() => {
  workingDirectory = mkdtempSync(join(tmpdir(), 'registry-rank-work-'));
  homeDirectory = mkdtempSync(join(tmpdir(), 'registry-rank-home-'));
  skill(workingDirectory, 'db-migrations', 'Write reversible database schema migrations.');
  skill(workingDirectory, 'release-notes', 'Draft release notes from merged pull requests.');
  skill(homeDirectory, 'db-migrations', 'A global copy the project-local skill overrides.');
  skill(homeDirectory, 'accessibility', 'Audit pages for accessibility problems.');
  agent(workingDirectory, 'tester', 'Writes and runs tests.');
});

afterAll(() => {
  rmSync(workingDirectory, { recursive: true, force: true });
  rmSync(homeDirectory, { recursive: true, force: true });
});

/** Probability per `type:name`; unlisted candidates read as a strong no. */
let relevance: Map<string, number>;
let requests: ReadonlyArray<{ readonly state: unknown }>;
let previous: ReturnType<typeof installJudgmentPort>;

beforeEach(() => {
  relevance = new Map();
  const fake = fakePort((_name, _question, state) => {
    const { type, name } = (state as { candidate: { type: string; name: string } }).candidate;
    return noulAnswer(relevance.get(`${type}:${name}`) ?? 0.03);
  });
  requests = fake.requests;
  previous = installJudgmentPort(fake.port);
});

afterEach(() => {
  installJudgmentPort(previous);
});

async function run(args: Record<string, unknown>): Promise<{ count: number; results: Array<{ type: string; name: string; description: string }> }> {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(fakeTool('exec', 'Run a shell command.'));
  toolRegistry.register(fakeTool('fetch', 'Fetch a URL over HTTP.'));
  const res = await createRegistryTool(toolRegistry, { workingDirectory, homeDirectory }).execute(args);
  expect(res.success).toBe(true);
  return JSON.parse(res.output as string);
}

const ids = (results: ReadonlyArray<{ type: string; name: string }>) => results.map((r) => `${r.type}:${r.name}`);

describe('registry search ranked by engine.tools.registry-rank', () => {
  test('results follow the probabilities, and candidates read as no are left out', async () => {
    relevance.set('tool:exec', 0.7);
    relevance.set('skill:db-migrations', 0.95);
    relevance.set('agent:tester', 0.6);
    const out = await run({ mode: 'search', query: 'migrate the database' });
    expect(ids(out.results)).toEqual(['skill:db-migrations', 'tool:exec', 'agent:tester']);
    expect(out.count).toBe(3);
  });

  test('a query nothing fits returns no results', async () => {
    const out = await run({ mode: 'search', query: 'kubernetes' });
    expect(out.results).toEqual([]);
    expect(out.count).toBe(0);
  });

  test('the query and each candidate\'s kind, name and description are what is judged; a project-local skill is judged once, over its global copy', async () => {
    await run({ mode: 'search', query: 'migrations', type: 'skills' });
    const states = requests.map((request) => request.state as { query: string; candidate: { type: string; name: string; description: string } });
    expect(states.every((state) => state.query === 'migrations')).toBe(true);
    expect(states.map((state) => state.candidate.name).sort()).toEqual(['accessibility', 'db-migrations', 'release-notes']);
    expect(states.find((state) => state.candidate.name === 'db-migrations')!.candidate).toMatchObject({
      type: 'skill',
      description: 'Write reversible database schema migrations.',
    });
  });

  test('an empty query lists everything without judging', async () => {
    const out = await run({ mode: 'search' });
    expect(out.count).toBe(6);
    expect(requests).toHaveLength(0);
  });
});

describe('registry recommend ranked by engine.tools.registry-rank', () => {
  test('with a task: fitting candidates best first, then the rest alphabetically', async () => {
    relevance.set('skill:release-notes', 0.8);
    relevance.set('skill:accessibility', 0.9);
    const out = await run({ mode: 'recommend', task: 'prepare the 2.0 release', scope: 'skills' });
    expect(ids(out.results)).toEqual(['skill:accessibility', 'skill:release-notes', 'skill:db-migrations']);
  });

  test('with a task nothing fits: every candidate alphabetically', async () => {
    const out = await run({ mode: 'recommend', task: 'send an email', scope: 'tools' });
    expect(ids(out.results)).toEqual(['tool:exec', 'tool:fetch']);
    expect(requests).toHaveLength(2);
  });

  test('without a task: alphabetical, nothing judged', async () => {
    const out = await run({ mode: 'recommend', scope: 'skills' });
    expect(ids(out.results)).toEqual(['skill:accessibility', 'skill:db-migrations', 'skill:release-notes']);
    expect(requests).toHaveLength(0);
  });
});
