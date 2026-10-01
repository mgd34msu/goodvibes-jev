/**
 * release:prepare rewrites the version, the CHANGELOG section, the release
 * notes stamp and the workflow pins at the bump, which is what lets CI stop
 * checking them on every push.
 */
import { describe, expect, test } from 'bun:test';
import {
  bumpVersion,
  parsePrepareArgs,
  peeledTagSha,
  rewriteWorkflowPins,
  scaffoldChangelogText,
  scaffoldReleaseNotesText,
  setManifestVersionText,
} from '../../../scripts/release-prepare.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  'Product-facing release notes for GoodVibes Agent.',
  '',
  '## 2.1.0 - 2026-09-30',
  '',
  '- the previous release',
  '',
  '## 2.0.21 - 2026-08-23',
  '',
].join('\n');

describe('scaffoldChangelogText', () => {
  test('a new version lands above the newest section, in the plain heading style', () => {
    const out = scaffoldChangelogText(CHANGELOG, '2.2.0', '2026-10-01');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## 2.2.0 - 2026-10-01', '## 2.1.0 - 2026-09-30', '## 2.0.21 - 2026-08-23']);
    expect(out.startsWith('# Changelog\n\nProduct-facing release notes for GoodVibes Agent.\n\n## 2.2.0 - 2026-10-01\n')).toBe(true);
    expect(out.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## 2.1.0')))).toBe(true);
  });

  test('a version that already has a section is left alone', () => {
    expect(scaffoldChangelogText(CHANGELOG, '2.1.0', '2026-10-01')).toBe(CHANGELOG);
  });

  test('a version that is a prefix of an existing one still gets its own section', () => {
    expect(scaffoldChangelogText(CHANGELOG, '2.0.2', '2026-10-01')).toContain('## 2.0.2 - 2026-10-01');
  });
});

describe('scaffoldReleaseNotesText', () => {
  const CURRENT = '- Added: themes.\n\nGoodVibes Agent 2.1.0 - 2026-09-30\n';

  test('notes stamped for another version are replaced by a scaffold stamped for this one', () => {
    expect(scaffoldReleaseNotesText(CURRENT, '2.2.0', '2026-10-01')).toBe('- \n\nGoodVibes Agent 2.2.0 - 2026-10-01\n');
  });

  test('notes already stamped for this version are kept as written', () => {
    expect(scaffoldReleaseNotesText(CURRENT, '2.1.0', '2026-10-01')).toBe(CURRENT);
  });
});

describe('versions', () => {
  test('patch, minor and major reset the lower parts', () => {
    expect(bumpVersion('2.1.3', 'patch')).toBe('2.1.4');
    expect(bumpVersion('2.1.3', 'minor')).toBe('2.2.0');
    expect(bumpVersion('2.1.3', 'major')).toBe('3.0.0');
    expect(() => bumpVersion('latest', 'patch')).toThrow('not semver');
  });

  test('only the top-level version field changes', () => {
    const pkg = '{\n  "name": "x",\n  "version": "2.1.0",\n  "dependencies": {\n    "y": "2.1.0"\n  }\n}\n';
    expect(setManifestVersionText(pkg, '2.2.0')).toBe(pkg.replace('"version": "2.1.0"', '"version": "2.2.0"'));
  });

  test('exactly one bump choice is required, and each skip flag is read', () => {
    expect(() => parsePrepareArgs([])).toThrow('Usage');
    expect(() => parsePrepareArgs(['--patch', '--minor'])).toThrow('Usage');
    expect(() => parsePrepareArgs(['--version', '2.2'])).toThrow('Usage');
    expect(parsePrepareArgs(['--version', '2.2.0', '--no-live'])).toEqual({
      bump: { exact: '2.2.0' }, changelog: true, install: true, pins: true, live: false,
    });
    expect(parsePrepareArgs(['--no-bump', '--no-changelog', '--no-install', '--no-pins'])).toEqual({
      bump: null, changelog: false, install: false, pins: false, live: true,
    });
  });
});

describe('workflow pins', () => {
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  const WORKFLOW = [
    `    uses: mgd34msu/goodvibes-sdk/.github/workflows/reusable-release-verify.yml@${OLD} # sdk 2.1.0 release`,
    '      toolchain-spec: "@goodvibes-jev/engine/toolchain@2.1.0"',
    `    uses: mgd34msu/goodvibes-sdk/.github/workflows/reusable-gh-release.yml@${OLD} # sdk 2.1.0 release`,
    '      uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1',
    `      publish-command: 'bunx @goodvibes-jev/engine/toolchain@2.1.0 goodvibes-publish-package --poll'`,
  ].join('\n');

  test('every SDK reusable-workflow ref and toolchain spec moves; other actions do not', () => {
    const out = rewriteWorkflowPins(WORKFLOW, { sdkVersion: '2.2.0', sdkSha: NEW, toolchainVersion: '2.2.1' });
    expect(out).not.toContain(OLD);
    expect(out.match(new RegExp(`@${NEW} # sdk 2\\.2\\.0 release`, 'g'))).toHaveLength(2);
    expect(out.match(/@pellux\/goodvibes-toolchain@2\.2\.1/g)).toHaveLength(2);
    expect(out).toContain('actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1');
  });

  test('without a resolved SHA only the toolchain specs move', () => {
    const out = rewriteWorkflowPins(WORKFLOW, { sdkVersion: '2.2.0', sdkSha: null, toolchainVersion: '2.2.1' });
    expect(out.match(new RegExp(`@${OLD} # sdk 2\\.1\\.0 release`, 'g'))).toHaveLength(2);
    expect(out.match(/@pellux\/goodvibes-toolchain@2\.2\.1/g)).toHaveLength(2);
  });

  test('the peeled tag line wins over the tag object line', () => {
    const output = [
      `${'c'.repeat(40)}\trefs/tags/v2.2.0`,
      `${'d'.repeat(40)}\trefs/tags/v2.2.0^{}`,
    ].join('\n');
    expect(peeledTagSha(output, 'v2.2.0')).toBe('d'.repeat(40));
    expect(peeledTagSha(`${'c'.repeat(40)}\trefs/tags/v2.2.0\n`, 'v2.2.0')).toBe('c'.repeat(40));
    expect(peeledTagSha('', 'v2.2.0')).toBeNull();
  });
});
