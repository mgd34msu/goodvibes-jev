import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  parseNpmPackJson,
  releaseNotesTextIssues,
  verifyPackageCliInstall,
  verifyPackageFacingText,
  verifyReleaseMetadata,
  verifyReleaseStamps,
} from '../../cli/package-verification.ts';
import {
  releaseBlockingGitStatusLines,
  releaseEvidenceHygieneIssues,
  releaseEvidenceInputPaths,
} from '../../../scripts/release.ts';

/**
 * Returns true when the release artifacts (dist/package runtime + bin) are present.
 * The install report needs the bundled runtime to pack.
 */
function releaseArtifactsPresent(): boolean {
  const root = resolve(import.meta.dir, '../../..');
  return existsSync(resolve(root, 'dist', 'package', 'main.js'))
    && existsSync(resolve(root, 'bin', 'goodvibes-agent.ts'));
}

function withFixture(run: (dir: string) => void): void {
  const dir = makeProjectTempDir('goodvibes-agent-package-verification');
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PUBLISHABLE_FILES = [
  'bin', 'dist/package', 'src', 'LICENSE', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'docs/*.md',
  'release/release-notes.md', 'release/performance-snapshot.json', 'release/release-readiness.json',
  'release/live-verification/live-verification.json', 'release/live-verification/live-verification.md',
  '!src/test', '!src/**/*.test.ts', '!src/**/__tests__', '!src/cli/package-verification.ts', '!src/verification',
];

/** A package root that passes verifyReleaseMetadata, for one field at a time to be broken. */
function writePublishablePackage(dir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'goodvibes-agent.ts'), "#!/usr/bin/env bun\nawait import('../dist/package/main.js');\n");
  chmodSync(join(dir, 'bin', 'goodvibes-agent.ts'), 0o755);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@pellux/goodvibes-agent',
    version: '2.1.0',
    private: false,
    type: 'module',
    main: 'dist/package/main.js',
    bin: { 'goodvibes-agent': 'bin/goodvibes-agent.ts' },
    publishConfig: { access: 'public' },
    files: PUBLISHABLE_FILES,
    ...overrides,
  }));
}

const STAMPED_NOTES = [
  '- Added: themes.',
  '- Fixed: indented read bodies.',
  '',
  'GoodVibes Agent 2.1.0 - 2026-09-30',
  '',
].join('\n');

describe('package CLI install verification', () => {
  // Skipped when build artifacts (dist/package/main.js) are absent.
  // package:install-check (the CI package-gate job) covers it there.
  test.skipIf(!releaseArtifactsPresent())('package exposes a runnable Agent bin and a safe registry tarball contract', () => {
    const report = verifyPackageCliInstall(resolve(import.meta.dir, '../../..'));

    expect(report.packageName).toBe('@pellux/goodvibes-agent');
    expect(report.issues).toEqual([]);
    expect(report.bins).toEqual([
      expect.objectContaining({
        command: 'goodvibes-agent',
        exists: true,
        executable: true,
        usesBunShebang: true,
        hasSourceEntrypoint: true,
      }),
    ]);
    expect(report.tarball.requiredPathsPresent).toContain('bin/goodvibes-agent.ts');
    expect(report.tarball.requiredPathsPresent).toContain('LICENSE');
    expect(report.tarball.requiredPathsPresent).toContain('release/release-notes.md');
    expect(report.tarball.requiredPathsPresent).toContain('release/performance-snapshot.json');
    expect(report.tarball.requiredPathsPresent).toContain('release/release-readiness.json');
    expect(report.tarball.requiredPathsPresent).toContain('release/live-verification/live-verification.json');
    expect(report.tarball.requiredPathsPresent).toContain('release/live-verification/live-verification.md');
    expect(report.tarball.forbiddenPaths).toEqual([]);
  }, 30_000);

  test('a publishable package.json passes, and each publish-critical field is reported when broken', () => {
    withFixture((dir) => {
      writePublishablePackage(dir);
      expect(verifyReleaseMetadata(dir)).toEqual([]);

      writePublishablePackage(dir, { private: true, version: '2.1', files: PUBLISHABLE_FILES.filter((entry) => entry !== '!src/test') });
      expect(verifyReleaseMetadata(dir)).toEqual([
        'package.json private must be false for the public Agent package.',
        'package.json files must exclude !src/test.',
        'package.json version must be an exact semver like 1.2.3: 2.1.',
      ]);
    });
  });

  test('a bin that is not executable is reported', () => {
    withFixture((dir) => {
      writePublishablePackage(dir);
      chmodSync(join(dir, 'bin', 'goodvibes-agent.ts'), 0o644);
      expect(verifyReleaseMetadata(dir)).toEqual(['bin target is not executable: goodvibes-agent -> bin/goodvibes-agent.ts']);
    });
  });

  test('release preflight allows only declared release evidence changes before a real release', () => {
    const allowedEvidenceStatus = [
      '?? release/release-notes.md',
      ' M release/performance-snapshot.json',
      'A  release/live-verification/live-verification.json',
    ].join('\n');
    const mixedStatus = [
      allowedEvidenceStatus,
      ' M src/main.ts',
      ' M README.md',
      '?? scratch.txt',
      ' D release/release-readiness.json',
    ].join('\n');

    expect(releaseEvidenceInputPaths()).toContain('release/release-readiness.json');
    expect(releaseBlockingGitStatusLines(allowedEvidenceStatus)).toEqual([]);
    expect(releaseBlockingGitStatusLines(mixedStatus)).toEqual([
      ' M src/main.ts',
      ' M README.md',
      '?? scratch.txt',
      ' D release/release-readiness.json',
    ]);
  });

  test('release evidence hygiene checks untracked release files before commit', () => {
    const dir = makeProjectTempDir('goodvibes-agent-release-evidence');
    try {
      mkdirSync(join(dir, 'release'), { recursive: true });
      writeFileSync(join(dir, 'release', 'ok.md'), '- release note\n');
      writeFileSync(join(dir, 'release', 'bad.md'), '- release note  \nnext line');

      expect(releaseEvidenceHygieneIssues(dir, ['release/ok.md'])).toEqual([]);
      expect(releaseEvidenceHygieneIssues(dir, ['release/bad.md', 'release/missing.md'])).toEqual([
        'release/bad.md: missing final newline.',
        'release/bad.md:1: trailing whitespace.',
        'release/missing.md: required release evidence file is missing.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});

describe('version stamps agree after the bump', () => {
  function writeStamps(dir: string, versions: { pkg: string; changelog: string; versionTs: string; notes: string }): void {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'release'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: versions.pkg }));
    writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${versions.changelog} - 2026-09-30\n\n- Notes.\n`);
    writeFileSync(join(dir, 'src', 'version.ts'), `let _version = '${versions.versionTs}';\n`);
    writeFileSync(join(dir, 'release', 'release-notes.md'), `- Notes.\n\nGoodVibes Agent ${versions.notes} - 2026-09-30\n`);
  }

  test('matching stamps pass', () => {
    withFixture((dir) => {
      writeStamps(dir, { pkg: '2.2.0', changelog: '2.2.0', versionTs: '2.2.0', notes: '2.2.0' });
      expect(verifyReleaseStamps(dir)).toEqual([]);
    });
  });

  test('each stale stamp is named', () => {
    withFixture((dir) => {
      writeStamps(dir, { pkg: '2.2.0', changelog: '2.1.0', versionTs: '2.1.0', notes: '2.1.0' });
      expect(verifyReleaseStamps(dir)).toEqual([
        'CHANGELOG.md top release 2.1.0 does not match package.json 2.2.0.',
        'src/version.ts fallback 2.1.0 does not match package.json 2.2.0.',
        'release notes describe 2.1.0 but this release is 2.2.0, rewrite them for what is shipping.',
      ]);
    });
  });
});

describe('package-facing text names only this package', () => {
  test('another GoodVibes package name and a non-Bun install line are reported; the bundled-runtime wording passes', () => {
    withFixture((dir) => {
      writeFileSync(join(dir, 'README.md'), [
        '# GoodVibes Agent',
        'Install with `bun add -g @pellux/goodvibes-agent`.',
        'It ships with the bundled GoodVibes platform runtime.',
        'Built on @goodvibes-jev/engine/sdk.',
        'Or run `npm install -g @pellux/goodvibes-agent`.',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 2.1.0 - 2026-09-30\n\n- Notes.\n');
      expect(verifyPackageFacingText(dir).failures).toEqual([
        'package-facing text README.md:4 references non-Agent GoodVibes package: @goodvibes-jev/engine/sdk',
        'package-facing text README.md:5 contains non-Bun Agent install/run instruction.',
      ]);
    });
  });
});

describe('shipped release notes describe the release being shipped', () => {
  // release/release-notes.md is in package.json's `files` list, so it travels
  // inside the published package. It went seven releases without being
  // rewritten, 1.15.0's notes were still what a reader opened at 1.21.0,
  // because the only rules were "at least five bullets" and "no marketing
  // words", and stale notes pass both. release:prepare scaffolds the stamp at
  // the bump; the release cut refuses a stamp for another version.
  test('notes left over from an earlier release are rejected by version', () => {
    // The exact failure that shipped: the file is well-formed, has plenty of
    // bullets, contains no hype, and describes a release that is not this one.
    const issues = releaseNotesTextIssues(STAMPED_NOTES, '9.9.9');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('describe 2.1.0');
    expect(issues[0]).toContain('this release is 9.9.9');
  });

  test('the real stale file this rule was written for is rejected', () => {
    // The genuine 1.15.0-era notes, abbreviated. Note the last bullet DOES
    // carry a version string, the platform runtime's, which is why the rule
    // is a stamp naming the release and not "the text mentions the version".
    const stale = [
      '- A paired phone is now something Agent can use.',
      '- Nothing is taken from a phone quietly.',
      '- Added triggers: watch something, and act when it changes.',
      '- Wake-word detection has platform support.',
      '- Fixed: a conversation that had already written to you could get no reply.',
      '- Updated the bundled GoodVibes platform runtime to 1.15.0.',
      '',
    ].join('\n');
    const issues = releaseNotesTextIssues(stale, '1.22.1');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('must end with a line naming the release');
  });

  test('a stamp naming another version is rejected even when the text mentions this one', () => {
    // NO-proof that the rule reads the stamp rather than scanning for the
    // version anywhere: this body names 1.22.1 twice and still fails.
    const misstamped = [
      '- Updated the bundled GoodVibes platform runtime for 1.22.1.',
      '- A second bullet mentioning 1.22.1 again.',
      '',
      'GoodVibes Agent 1.21.0 - 2026-07-27',
      '',
    ].join('\n');
    const issues = releaseNotesTextIssues(misstamped, '1.22.1');
    expect(issues).toEqual(['release notes describe 1.21.0 but this release is 1.22.1, rewrite them for what is shipping.']);
  });

  test('an unreal date in the stamp is rejected', () => {
    const badDate = ['- One bullet.', '', 'GoodVibes Agent 1.22.1 - 2026-02-31', ''].join('\n');
    expect(releaseNotesTextIssues(badDate, '1.22.1')).toEqual([
      'release notes date must be a real YYYY-MM-DD date: 2026-02-31.',
    ]);
  });

  test('an em dash in the stamp is accepted, because it is the house style', () => {
    const emDash = ['- One bullet.', '', 'GoodVibes Agent 1.22.1 \u2014 2026-07-29', ''].join('\n');
    expect(releaseNotesTextIssues(emDash, '1.22.1')).toEqual([]);
  });
});

describe('npm pack --json output parsing', () => {
  const arrayShape = JSON.stringify([
    { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  ]);
  const objectShape = JSON.stringify({
    pkg: { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  });

  test('reads the array shape emitted by npm 10 and npm 11', () => {
    expect(parseNpmPackJson(arrayShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads the package-name-keyed object shape emitted by npm 12', () => {
    expect(parseNpmPackJson(objectShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads a bare pack-result object', () => {
    expect(parseNpmPackJson(JSON.stringify({ entryCount: 1, unpackedSize: 7, files: [{ path: 'a.txt' }] }))).toEqual({
      files: ['a.txt'],
      entryCount: 1,
      unpackedSize: 7,
    });
  });

  test('ignores npm notice lines printed around the JSON document', () => {
    const noisy = `npm notice run \`npm audit\` for details\n${objectShape}\nnpm notice done\n`;
    expect(parseNpmPackJson(noisy)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('keeps braces inside file paths from truncating the document', () => {
    const braced = JSON.stringify({ pkg: { entryCount: 1, unpackedSize: 3, files: [{ path: 'src/{weird}/file.ts' }] } });
    expect(parseNpmPackJson(`npm notice packing\n${braced}`)).toEqual({
      files: ['src/{weird}/file.ts'],
      entryCount: 1,
      unpackedSize: 3,
    });
  });

  test('reports what npm actually emitted when there is no JSON document', () => {
    expect(() => parseNpmPackJson('npm error code ENOENT\nnpm error enoent\n')).toThrow(/printed no JSON document.*npm error code ENOENT/s);
  });

  test('reports what npm actually emitted when the output is empty', () => {
    expect(() => parseNpmPackJson('   \n')).toThrow(/printed no JSON document.*no output at all/s);
  });

  test('reports what npm actually emitted when the JSON is malformed', () => {
    expect(() => parseNpmPackJson('{"pkg": {files: [1, 2]}}')).toThrow(/could not be parsed/);
  });

  test('reports an unrecognized JSON shape rather than crashing', () => {
    expect(() => parseNpmPackJson(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }))).toThrow(
      /unrecognized JSON shape.*E404/s,
    );
  });
});
