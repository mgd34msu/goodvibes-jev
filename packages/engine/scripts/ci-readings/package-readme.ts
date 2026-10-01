/**
 * `engine.gates.package-readme`: whether a published package's README
 * documents the package, and whether it describes the package in stale terms.
 * It replaces two checks of scripts/package-metadata-check.ts: the 200
 * character floor that stood in for "is this documentation" (a long README of
 * boilerplate passed it) and the three stale phrases ("Internal workspace
 * package backing", "umbrella package", "umbrella SDK") that any rewording
 * slipped past.
 *
 * Read by `bun run package-readmes:read` for every package directory the
 * release publishes; the readings are stored by content hash in
 * etc/package-readme-readings.json. Offline editorial reporting recognizes a
 * favorable reading only on a stored, settled yes to `documents` and, for a
 * public package, a settled no to `stale`. Findings are advisory and do not
 * block deterministic correctness CI. Both questions ride one request per README.
 *
 * State: `{ name, description, readme }`, the package name and description
 * from its package.json and the README text.
 *
 * Band: medium stakes, preserved for editorial review of published
 * documentation: a wrong yes on `stale` prompts unnecessary rewording; a
 * wrong no can leave outdated wording unnoticed.
 */
import { defineBattery, PINNED_MODEL, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type PackageReadmeState = {
  readonly name: string;
  readonly description: string;
  readonly readme: string;
};

const USEFUL_README = [
  '# @acme/widgets',
  '',
  'Widgets for building dashboards: charts, tables and filters that render in the browser and on the server.',
  '',
  '## Install',
  '',
  '```sh',
  'npm install @acme/widgets',
  '```',
  '',
  '## Use',
  '',
  '```ts',
  "import { chart } from '@acme/widgets';",
  "chart('#sales', { data });",
  '```',
  '',
  'See the API reference for every option.',
].join('\n');

export const packageReadme = defineBattery({
  name: 'engine.gates.package-readme',
  version: 1,
  description: 'Whether a published package README documents the package, and whether it describes it in stale internal or umbrella terms.',
  accuracyFloor: 0.9,
  // Pinned: the stored readings and the band were read and tuned on this model.
  model: PINNED_MODEL,
  items: {
    documents: yesNo(
      'Does the README `readme` document the package `name` (described as `description`): say what the package is and how to install it and use it?',
      STAKES_BANDS.medium.yesNo,
    ),
    stale: yesNo(
      'Does the README `readme` describe the package `name` as an internal workspace package, or as an umbrella that only gathers or re-exports other packages, rather than as the published package itself?',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'full README', state: { name: '@acme/widgets', description: 'Dashboard widgets', readme: USEFUL_README }, expect: { documents: 'yes', stale: 'no' } },
    {
      name: 'short but complete',
      state: { name: '@acme/retry', description: 'Retry helper', readme: '# @acme/retry\n\nRetries a failing async call with backoff.\n\n`npm install @acme/retry`\n\n```ts\nawait retry(() => fetchPage(), { attempts: 3 });\n```' },
      expect: { documents: 'yes', stale: 'no' },
    },
    {
      name: 'boilerplate with no usage',
      state: { name: '@acme/widgets', description: 'Dashboard widgets', readme: '# @acme/widgets\n\nThis project was bootstrapped with a template. Contributions are welcome! Please read the code of conduct and open an issue before sending a pull request. Licensed under MIT. Thanks to everyone who has helped along the way; we appreciate your support and feedback.' },
      expect: { documents: 'no' },
    },
    {
      name: 'changelog only',
      state: { name: '@acme/retry', description: 'Retry helper', readme: '# Changelog\n\n## 2.1.0\n- Faster backoff\n\n## 2.0.0\n- Dropped Node 16\n\n## 1.4.0\n- Added jitter\n\n## 1.3.0\n- Fixed a leak when the signal aborted mid-wait' },
      expect: { documents: 'no' },
    },
    {
      name: 'internal workspace wording',
      state: { name: '@acme/engine', description: 'Engine runtime', readme: '# @acme/engine\n\nInternal workspace package backing the Acme apps. Not meant to be installed directly; the apps pull it in through the monorepo.\n\n```ts\nimport { start } from \'@acme/engine\';\nstart();\n```' },
      expect: { stale: 'yes' },
    },
    {
      name: 'umbrella wording',
      state: { name: '@acme/sdk', description: 'Acme SDK', readme: '# @acme/sdk\n\nThe umbrella SDK: it re-exports @acme/core, @acme/http and @acme/realtime so you can install one thing.\n\n`npm install @acme/sdk`\n\n```ts\nimport { http } from \'@acme/sdk\';\n```' },
      expect: { stale: 'yes' },
    },
    {
      name: 'reworded internal description',
      state: { name: '@acme/engine', description: 'Engine runtime', readme: '# @acme/engine\n\nThis is a private building block of our monorepo that the apps share; it is only published so the apps can resolve it.\n\n```ts\nimport { start } from \'@acme/engine\';\n```' },
      expect: { stale: 'yes' },
    },
    {
      name: 'published package that mentions a subpath',
      state: { name: '@acme/engine', description: 'Engine runtime', readme: '# @acme/engine\n\nThe Acme engine: sessions, tools and providers in one package.\n\n`npm install @acme/engine`\n\nThe `@acme/engine/http` subpath carries the HTTP transport.\n\n```ts\nimport { createEngine } from \'@acme/engine\';\n```' },
      expect: { documents: 'yes', stale: 'no' },
    },
  ],
});
