import { describe, expect, test } from 'bun:test';
import {
  buildNpmPackageVersionSpec,
  getPublishedNpmVersion,
  type NpmViewRunnerOptions,
} from '../../../scripts/npm-publish-state.ts';

describe('npm publish state helpers', () => {
  test('builds scoped package version specs', () => {
    expect(buildNpmPackageVersionSpec('@pellux/goodvibes-agent', '0.1.84')).toBe(
      '@pellux/goodvibes-agent@0.1.84',
    );
  });

  test('returns the published version from npm view', () => {
    const calls: NpmViewRunnerOptions[] = [];
    const version = getPublishedNpmVersion({
      name: '@pellux/goodvibes-agent',
      version: '0.1.84',
      registry: 'https://registry.npmjs.org',
      cwd: '/repo',
      env: { PATH: '/usr/bin' },
      runner: (options) => {
        calls.push(options);
        return '0.1.84\n';
      },
    });

    expect(version).toBe('0.1.84');
    expect(calls).toEqual([
      {
        command: 'npm',
        args: [
          'view',
          '@pellux/goodvibes-agent@0.1.84',
          'version',
          '--registry',
          'https://registry.npmjs.org',
        ],
        cwd: '/repo',
        env: { PATH: '/usr/bin' },
      },
    ]);
  });

  test('returns null when npm view cannot find the version', () => {
    const version = getPublishedNpmVersion({
      name: '@pellux/goodvibes-agent',
      version: '0.1.85',
      registry: 'https://registry.npmjs.org',
      cwd: '/repo',
      env: {},
      runner: () => {
        throw new Error('not found');
      },
    });

    expect(version).toBeNull();
  });
});
