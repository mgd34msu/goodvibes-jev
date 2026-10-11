import { expect, test } from 'bun:test';
import { BROWSER_JUDGMENT_BATTERY_IDS } from '../daemon-sdk/src/browser-judgment-contract.js';
import { WEBUI_CODE_LANGUAGES } from '../daemon-sdk/src/browser-code-languages.js';
import { builtinBrowserJudgmentMethodDescriptors } from '../sdk/src/platform/control-plane/method-catalog-browser-judgment.js';
import { renderType } from '../scripts/foundation-io-render.js';

type EnvelopeSchema = Record<string, unknown> & {
  properties: Record<string, Record<string, unknown>>;
};
const descriptor = builtinBrowserJudgmentMethodDescriptors.find(method => method.id === 'judgment.battery.run')!;
const output = descriptor.outputSchema!;
const settled = (output.anyOf as { anyOf: EnvelopeSchema[] }[])
  .flatMap(group => group.anyOf)
  .filter(branch => (branch.properties.status?.enum as string[] | undefined)?.includes('settled'));

function valueSchema(battery: string): Record<string, unknown> {
  const branch = settled.find(item => (item.properties.battery?.enum as string[] | undefined)?.includes(battery));
  expect(branch, `${battery} must have a settled output branch`).toBeDefined();
  expect(branch?.properties.value, `${battery} must declare its settled value`).toBeDefined();
  return branch!.properties.value!;
}

test('every registered browser battery has a settled output value', () => {
  expect(settled.map(branch => (branch.properties.battery!.enum as string[])[0]).sort())
    .toEqual([...BROWSER_JUDGMENT_BATTERY_IDS].sort());
  for (const battery of BROWSER_JUDGMENT_BATTERY_IDS) valueSchema(battery);
});

test('browser battery input and output contracts render through the canonical foundation generator', () => {
  expect(() => renderType(descriptor.inputSchema!)).not.toThrow();
  expect(() => renderType(output)).not.toThrow();
});

test.each([
  'webui.models.catalog-provider-match',
  'webui.credentials.provider-key',
  'webui.settings.card-material-key',
  'webui.config.credential-key',
])('%s retains its boolean matches output', battery => {
  expect(renderType(valueSchema(battery))).toBe('{ matches: readonly boolean[]; }');
});

test('code-language output retains its language enum after browser battery additions', () => {
  const languages = [...WEBUI_CODE_LANGUAGES].sort().map(language => JSON.stringify(language)).join(' | ');
  expect(renderType(valueSchema('webui.code.language'))).toBe(`{ language: ${languages}; }`);
});
