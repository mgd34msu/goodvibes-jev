import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readWalkDirectories, walkDirectoryReading } from '../sdk/src/platform/utils/directory-reading.ts';
import { readCredentialHeader } from '../sdk/src/platform/tools/credential-header-reading.ts';

let previous: ReturnType<typeof installJudgmentPort>;
afterEach(() => installJudgmentPort(previous));
for (const text of ['Authorization: Bearer fixture-secret', '{"password":"fixture-secret"}', '{"cardNumber":"4111111111111111"}', '4111111111111111']) {
  test(`complete protected name is rejected without a port request (${text.startsWith('{') ? 'structured' : 'inline'})`, async () => {
    const fake = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(fake.port);
    await expect(readCredentialHeader(text)).rejects.toThrow('Refused before judgment');
    await expect(readWalkDirectories([{ name: text, relativePath: text }])).rejects.toThrow('Refused before judgment');
    expect(fake.requests).toHaveLength(0);
  });
}
test('descriptor-safe complete directory capture rejects getters and ignored-field secrets', async () => {
  let invoked = 0;
  const fake = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(fake.port);
  const candidate = { get name() { invoked++; return 'src'; }, relativePath: 'src' };
  await expect(readWalkDirectories([candidate])).rejects.toThrow('Refused before judgment');
  await expect(readWalkDirectories([{ name: 'src', relativePath: 'src', extra: { password: 'synthetic' } } as { name: string; relativePath: string }])).rejects.toThrow('Refused before judgment');
  expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0);
});
test('canonical fixtures use the same owner and act/held readings retain order', async () => {
  const fake = fakePort((key, _question, state) => {
    const candidate = (state as { directories: { id: string; relativePath: string }[] }).directories.find(value => value.id === key)!;
    return noulAnswer(['node_modules', 'target'].includes(candidate.relativePath) ? 0.99 : candidate.relativePath === 'maybe' ? 0.5 : 0.01);
  }); previous = installJudgmentPort(fake.port);
  expect(await readWalkDirectories([{ name: 'target', relativePath: 'target' }, { name: 'dist', relativePath: 'src/dist' }, { name: 'maybe', relativePath: 'maybe' }])).toEqual([true, false, null]);
  const checks = await walkDirectoryReading.checkFixtures(fake.port);
  expect(checks.every(check => check.correct)).toBe(true);
});
