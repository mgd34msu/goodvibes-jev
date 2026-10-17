import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { computeSingleEdit } from '../sdk/src/platform/tools/edit/match.ts';
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => installJudgmentPort(previous));
const item = { path: 'fixture.ts', find: 'const target = row.vlue;', replace: 'const target = row.value + 1;' };
function windowFixture(fitting: readonly string[], uncertain?: string) {
  return fakePort((name, question, raw) => {
    if (name === 'same_target') return noulAnswer(1);
    const state = raw as { candidates: { id: string }[] };
    if (name === 'pick') return choiceAnswer(question, state.candidates.find(candidate => fitting.includes(candidate.id))?.id ?? 'none', 1);
    const candidate = state.candidates[Number(name.slice('fits_'.length))]!;
    return noulAnswer(candidate.id === uncertain ? 0.5 : fitting.includes(candidate.id) ? 1 : 0);
  });
}
test('every window participates, including a target past the first selector batch with zero matching lines', async () => {
  const file = [...Array.from({ length: 70 }, (_, i) => `const unrelated${i} = ${i};`), 'const target = row.value;'].join('\n');
  const fake = windowFixture(['line-71']); installJudgmentPort(fake.port);
  const result = await computeSingleEdit(file, item, 'exact', true);
  expect('newContent' in result && result.newContent.endsWith(item.replace)).toBe(true);
  const requests = fake.requests.filter(request => request.context?.battery === 'engine.tools.edit-window');
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0]!.state)).not.toContain('const target = row.value;');
  expect(JSON.stringify(requests[1]!.state)).toContain('const target = row.value;');
  expect(JSON.stringify(requests[1]!.state)).toContain('line-71');
});
test('an unsettled alternative cannot silently authorize a fuzzy edit', async () => {
  const fake = windowFixture(['line-2'], 'line-1'); installJudgmentPort(fake.port);
  await expect(computeSingleEdit('const other = 1;\nconst target = row.value;', item, 'exact', true)).rejects.toThrow('not settled');
  expect(fake.requests.some(request => request.context?.battery === 'engine.tools.edit-target')).toBe(false);
});
test('two fitting locations remain ambiguous', async () => {
  const fake = windowFixture(['line-1', 'line-2']); installJudgmentPort(fake.port);
  const result = await computeSingleEdit('const target = row.value;\nconst target = row.value;', item, 'exact', true);
  expect('error' in result).toBe(true);
});
test('a protected value late in the file blocks every semantic request', async () => {
  const fake = windowFixture(['line-1']); installJudgmentPort(fake.port);
  const protectedValue = 'sk-' + 'a'.repeat(48);
  await expect(computeSingleEdit(`const target = row.value;\nconst apiKey = "${protectedValue}";`, item, 'exact', true)).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});
