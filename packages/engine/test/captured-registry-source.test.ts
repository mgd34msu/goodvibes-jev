import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { assertContractInputReadAccess, createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { admitCapturedRegistryContext } from '../sdk/src/platform/tools/registry-tool/captured-source.js';
import { createRegistryTool, isCapturedRegistryTool } from '../sdk/src/platform/tools/registry-tool/index.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { makeRepo } from './contract/runner-support.js';

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
const put = (root: string, relative: string, content: string): string => {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};
async function fixture() {
  const root = makeRepo(); cleanup.push(root);
  const home = mkdtempSync(join(tmpdir(), 'registry-home-')); cleanup.push(home);
  const allowed = put(root, '.goodvibes/skills/allowed.md', '---\nname: allowed\ndescription: ALLOWED_DESCRIPTION\ndepends_on: [base]\n---\n# Allowed\nALLOWED_BODY\n@includes/details.txt\n@@literal\n');
  put(root, '.goodvibes/skills/includes/details.txt', 'INCLUDED_BODY');
  const denied = put(root, '.goodvibes/skills/denied.md', 'DENIED_BODY');
  const global = put(home, '.goodvibes/skills/global.md', '---\nname: global\n---\nGLOBAL_BODY');
  const deniedGlobal = put(home, '.goodvibes/agents/secret.md', 'DENIED_GLOBAL_BODY');
  const outside = put(root, '.goodvibes/unregistered.md', 'UNREGISTERED_BODY');
  put(root, '.goodvibes/agents/agent/AGENT.md', '---\nname: agent\n---\nAGENT_BODY');
  put(root, '.goodvibes/skills/.git/config.md', 'EXCLUDED_BODY');
  symlinkSync(outside, join(root, '.goodvibes/skills/alias.md'));
  const snapshot = await captureContractInput(root);
  const view = contractInputPath(snapshot);
  const git = spawnSync('git', ['-C', root, 'worktree', 'add', '--no-checkout', '--detach', view, snapshot.inputCommit]);
  expect(git.status).toBe(0);
  await materializeContractInput(snapshot, view);
  const stop = new AbortController();
  const authority = await createContractInputAuthority({ inputSnapshot: snapshot, projectRoot: root } as Contract, view, { signal: stop.signal });
  const restricted = new Set([denied, deniedGlobal]);
  const reads: string[] = [];
  let onRead: ((path: string) => void | Promise<void>) | undefined;
  const filter = async (path: string): Promise<boolean> => { reads.push(path); await onRead?.(path); return !restricted.has(path); };
  const binding = { authority, root: view, signal: stop.signal, readAccessFilter: filter };
  return { root, home, allowed, denied, global, deniedGlobal, outside, view, stop, authority, restricted, reads, filter, binding, setOnRead: (callback: typeof onRead) => { onRead = callback; } };
}

test('captured actual registry preserves all modes, configured global context and non-markdown includes', async () => {
  const f = await fixture();
  const context = await admitCapturedRegistryContext(f.binding, { homeDirectory: f.home });
  const registry = new ToolRegistry();
  const tool = createRegistryTool(registry, { workingDirectory: '/ignored-caller-root', capturedInput: context });
  registry.register(tool);
  expect(isCapturedRegistryTool(tool, f.authority)).toBe(true);
  expect(existsSync(join(f.view, '.goodvibes/skills/allowed.md'))).toBe(false);
  const requests: unknown[] = [];
  const previous = installJudgmentPort(fakePort((_name, _question, state) => { requests.push(state); return noulAnswer(0.97); }).port);
  try {
    const search = await tool.execute({ mode: 'search', query: 'use skills' });
    expect(search.success).toBe(true);
    expect(search.output).toContain('ALLOWED_DESCRIPTION');
    expect(search.output).toContain('GLOBAL_BODY');
    expect(search.output).toContain('AGENT_BODY');
    expect(search.output).not.toContain('DENIED_');
    expect(search.output).not.toContain('UNREGISTERED_BODY');
    expect(search.output).not.toContain('EXCLUDED_BODY');
    const recommend = await tool.execute({ mode: 'recommend', task: 'use skills' });
    expect(recommend.success).toBe(true);
    const dependencies = await tool.execute({ mode: 'dependencies', skillName: 'allowed' });
    expect(JSON.parse(dependencies.output!).depends_on).toEqual(['base']);
    const preview = await tool.execute({ mode: 'preview', path: '.goodvibes/skills/allowed.md' });
    expect(JSON.parse(preview.output!).sections).toEqual(['Allowed']);
    expect(preview.output).not.toContain('INCLUDED_BODY');
    const content = await tool.execute({ mode: 'content', path: f.allowed });
    expect(content.success).toBe(true);
    expect(content.output).toContain('INCLUDED_BODY');
    expect(content.output).toContain('@literal');
    expect(JSON.stringify(requests)).not.toContain('DENIED_');
    await assertContractInputReadAccess(f.authority, f.filter);
  } finally { installJudgmentPort(previous); }
});

test('paths, serialized tokens, copied prefixes and declared roots cannot manufacture registry authority', async () => {
  const f = await fixture();
  const context = await admitCapturedRegistryContext(f.binding, { homeDirectory: f.home });
  const tool = createRegistryTool(new ToolRegistry(), { workingDirectory: f.view, capturedInput: context });
  for (const path of [f.denied, f.deniedGlobal, f.outside, join(f.root, '.goodvibes/skills/alias.md'), join(f.root, '.goodvibes/skills/.git/config.md'), join(f.view, '.goodvibes/skills/allowed.md')]) {
    const result = await tool.execute({ mode: 'content', path, homeDirectory: f.home, workingDirectory: f.root });
    expect(result.success).toBe(false);
    expect(result.output).toBeUndefined();
  }
  expect(() => createRegistryTool(new ToolRegistry(), { workingDirectory: f.root, capturedInput: structuredClone(context) })).toThrow('construction-owned');
  expect(isCapturedRegistryTool(createRegistryTool(new ToolRegistry(), { workingDirectory: f.view }), f.authority)).toBe(false);
  expect(f.reads).not.toContain(f.outside);
});

for (const stale of ['permission', 'revoked', 'cancelled', 'changed', 'redirected'] as const) {
  test(`cached registry disclosure and later provider reads reject ${stale} source authority`, async () => {
    const f = await fixture();
    const context = await admitCapturedRegistryContext(f.binding);
    const tool = createRegistryTool(new ToolRegistry(), { workingDirectory: f.view, capturedInput: context });
    expect((await tool.execute({ mode: 'content', path: f.allowed })).success).toBe(true);
    if (stale === 'permission') f.restricted.add(f.allowed);
    if (stale === 'revoked') revokeContractInputAuthority(f.authority);
    if (stale === 'cancelled') f.stop.abort();
    if (stale === 'changed') writeFileSync(f.allowed, 'CHANGED_BODY');
    if (stale === 'redirected') { renameSync(f.allowed, `${f.allowed}.old`); symlinkSync(f.outside, f.allowed); }
    const result = await tool.execute({ mode: 'content', path: f.allowed });
    expect(result.success).toBe(false);
    expect(result.output).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('BODY');
    await expect(assertContractInputReadAccess(f.authority, f.filter)).rejects.toThrow();
  });
}

test('admission and invocation own caller roots, permission closure, paths and cancellation before awaits', async () => {
  const f = await fixture();
  const home = { homeDirectory: f.home };
  const pending = admitCapturedRegistryContext(f.binding, home);
  home.homeDirectory = f.root;
  const originalFilter = f.binding.readAccessFilter;
  f.binding.readAccessFilter = async () => false;
  const context = await pending;
  const roots = { workingDirectory: f.view, capturedInput: context };
  const tool = createRegistryTool(new ToolRegistry(), roots);
  roots.workingDirectory = f.home;
  const args = { mode: 'content', path: f.allowed };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const result = tool.execute(args, options);
  args.path = f.denied;
  options.signal = new AbortController().signal;
  expect((await result).output).toContain('ALLOWED_BODY');
  expect((await tool.execute({ mode: 'content', path: f.global })).output).toContain('GLOBAL_BODY');
  f.binding.readAccessFilter = originalFilter;
  f.setOnRead((path) => { if (path === f.allowed) controller.abort(); });
  const cancelled = await tool.execute({ mode: 'content', path: f.allowed }, { signal: controller.signal });
  expect(cancelled.success).toBe(false);
  expect(cancelled.output).toBeUndefined();
});

test('revocation during registry judgment withholds results and prevents later judgment disclosure', async () => {
  const f = await fixture();
  const context = await admitCapturedRegistryContext(f.binding);
  const tool = createRegistryTool(new ToolRegistry(), { workingDirectory: f.view, capturedInput: context });
  let requests = 0;
  const previous = installJudgmentPort(fakePort(() => { requests++; f.restricted.add(f.allowed); return noulAnswer(0.97); }).port);
  try {
    const result = await tool.execute({ mode: 'search', query: 'registry context' });
    expect(result.success).toBe(false);
    expect(result.output).toBeUndefined();
    expect(requests).toBeGreaterThan(0);
    const before = requests;
    await tool.execute({ mode: 'recommend', task: 'registry context' });
    expect(requests).toBe(before);
    await expect(assertContractInputReadAccess(f.authority, f.filter)).rejects.toThrow();
  } finally { installJudgmentPort(previous); }
});
