import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readCredentialHeader } from '@goodvibes-jev/engine/sdk/platform/tools';
import { resolveGithubToken } from '../../export/gist-uploader.ts';

const previous = installJudgmentPort(undefined);
afterEach(() => installJudgmentPort(previous));

describe('Gist name-only canonical credential reading', () => {
  test('first acting yes wins, preserving exact configured value and excluding values from requests', async () => {
    const fake = fakePort((_name, _question, state) => noulAnswer((state as { header: string }).header === 'Private-Key' ? 0.99 : 0.01));
    installJudgmentPort(fake.port);
    expect(await resolveGithubToken({ 'X-Max-Tokens': '4096', 'Private-Key': 'literal credential', 'X-API-Key': 'later credential' })).toBe('literal credential');
    expect(fake.requests.map(r => r.state)).toEqual([{ header: 'X-Max-Tokens' }, { header: 'Private-Key' }]);
    expect(JSON.stringify(fake.requests)).not.toContain('literal credential');
    expect(JSON.stringify(fake.requests)).not.toContain('later credential');
  });

  test('held reading is not selected and standard authorization bypasses judgment', async () => {
    const fake = fakePort(() => noulAnswer(0.5));
    installJudgmentPort(fake.port);
    expect(await readCredentialHeader('X-Token')).toBeNull();
    expect(await resolveGithubToken({ Authorization: 'Bearer explicit', 'X-Token': 'other' })).toBe('explicit');
    expect(fake.requests).toHaveLength(1);
  });

  test('operational failure is propagated rather than selecting a heuristic credential', async () => {
    const fake = fakePort(() => { throw new Error('reader unavailable'); });
    installJudgmentPort(fake.port);
    await expect(resolveGithubToken({ 'X-Token': 'must not escape' })).rejects.toThrow('reader unavailable');
  });

  test('canceled readings do not classify or dispatch', async () => {
    const fake = fakePort(() => noulAnswer(0.99));
    installJudgmentPort(fake.port);
    const controller = new AbortController();
    controller.abort();
    await expect(readCredentialHeader('X-API-Key', { signal: controller.signal })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});

test('all nonstandard names are screened before selecting the first header', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(resolveGithubToken({ 'X-API-Key': 'local', '{"password":"synthetic"}': 'never read' })).rejects.toThrow('Refused before judgment');
  expect(fake.requests).toHaveLength(0);
});

test('auth-header accessors never execute and mutable input is captured before awaiting', async () => {
  let invoked = 0;
  await expect(resolveGithubToken({ get 'X-API-Key'() { invoked++; return 'no'; } })).rejects.toThrow('Invalid GitHub auth header');
  expect(invoked).toBe(0);
  const headers = { 'X-API-Key': 'original' };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort({ ...fake.port, async ask(request) { requested(); await gate; return fake.port.ask(request); } });
  const pending = resolveGithubToken(headers); await started; headers['X-API-Key'] = 'new'; release();
  expect(await pending).toBe('original');
});
